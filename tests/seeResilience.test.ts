import assert from "node:assert/strict";
import test from "node:test";
import { handleSeeProjectGet, handleSeeProjectSave } from "../app/api/see/projects/[id]/route.ts";
import { handleSeeUploadPrepare } from "../app/api/see/projects/[id]/uploads/route.ts";
import { handleSeeUploadComplete } from "../app/api/see/projects/[id]/uploads/complete/route.ts";
import { handleSeeProjectStatus } from "../app/api/see/projects/[id]/status/route.ts";
import { handleSeePublication } from "../app/api/see/projects/[id]/publication/route.ts";
import { handleSeeContent } from "../app/api/see/content/route.ts";
import { isRetryableStatus, SeeTransientError, withRetry } from "../domain/seeRetry.ts";
import type { SeeEditorView } from "../domain/seeViews.ts";
import type { SeeDeps } from "../lib/see/backend.server.ts";
import { isAbandonedUpload, rekeyOneFile } from "../lib/see/service.server.ts";
import { isTransientStorageError, R2SeeObjectStorage, SeeStorageUnavailableError } from "../lib/see/storage.server.ts";
import {
  createZarges, danglingFiles, editorBody, failingRepository, GLB, json, manifest, PDF, publicFile, publish, req, uploadFile, world, type World,
} from "./helpers/seeTestKit.ts";

/**
 * HWS SEE resilience: Cloudflare R2 / network outages and partial failures must never corrupt a
 * project (no record pointing at a missing object, no half-verified file) and must stay retryable.
 * Fake R2 + in-memory repository only.
 */

async function prepare(w: World, projectId: string, body: Record<string, unknown>, deps: SeeDeps = w.deps) {
  const response = await handleSeeUploadPrepare(await req(`/api/see/projects/${projectId}/uploads`, { method: "POST", body }), { id: projectId }, () => deps);
  return { response, body: await json<{ file?: { id: string }; upload?: { uploadUrl: string }; error?: string; code?: string }>(response) };
}

async function complete(w: World, projectId: string, body: Record<string, unknown>) {
  const response = await handleSeeUploadComplete(await req(`/api/see/projects/${projectId}/uploads/complete`, { method: "POST", body }), { id: projectId }, () => w.deps);
  return { response, body: await json<{ project?: SeeEditorView; error?: string; code?: string }>(response) };
}

// ───────────────────────── Uploads during outages ─────────────────────────

test("resilience: preparing an upload while R2 is down → 503 + Retry-After, nothing is recorded", async () => {
  const w = world();
  const zarges = await createZarges(w);
  const before = (await w.repository.getAggregate(zarges.projectId))!.files.length;
  w.storage.outage.add("createUploadUrl");
  const result = await prepare(w, zarges.projectId, { kind: "document", fileName: "a.pdf", mimeType: "application/pdf", sizeBytes: 10 });
  assert.equal(result.response.status, 503);
  assert.equal(result.response.headers.get("retry-after"), "30");
  assert.equal(result.body.code, "storage-unavailable");
  assert.match(result.body.error!, /dočasně nedostupné/u);
  assert.equal((await w.repository.getAggregate(zarges.projectId))!.files.length, before);
});

test("resilience: verification during an outage keeps the file pending; repeating 'complete' after recovery succeeds once", async () => {
  const w = world();
  const zarges = await createZarges(w);
  const prepared = await prepare(w, zarges.projectId, { kind: "model", fileName: "novy.glb", mimeType: "model/gltf-binary", sizeBytes: GLB.byteLength });
  w.storage.put(prepared.body.upload!.uploadUrl, GLB);
  for (const operation of ["head", "readHead"] as const) {
    w.storage.outage.add(operation);
    const failed = await complete(w, zarges.projectId, { fileId: prepared.body.file!.id, sceneId: zarges.open.id });
    assert.equal(failed.response.status, 503, operation);
    const file = await w.repository.getFile(prepared.body.file!.id);
    assert.equal(file?.status, "pending", "never marked rejected because of an outage");
    assert.ok(w.storage.objects.has(file!.storageKey), "uploaded bytes are not deleted during an outage");
    w.storage.outage.delete(operation);
  }
  const ok = await complete(w, zarges.projectId, { fileId: prepared.body.file!.id, sceneId: zarges.open.id });
  assert.equal(ok.response.status, 200);
  const again = await complete(w, zarges.projectId, { fileId: prepared.body.file!.id, sceneId: zarges.open.id });
  assert.equal(again.response.status, 200, "complete is idempotent (client retries are safe)");
  const view = again.body.project!;
  assert.equal(view.scenes.find((scene) => scene.id === zarges.open.id)?.modelFileId, prepared.body.file!.id);
  assert.equal(view.files.filter((file) => file.id === prepared.body.file!.id).length, 1);
});

test("resilience: an interrupted browser upload never becomes usable and is not published", async () => {
  const w = world();
  const zarges = await createZarges(w);
  const prepared = await prepare(w, zarges.projectId, { kind: "document", fileName: "prerusene.pdf", mimeType: "application/pdf", sizeBytes: PDF.byteLength });
  const missing = await complete(w, zarges.projectId, { fileId: prepared.body.file!.id });
  assert.equal(missing.response.status, 409);
  assert.match(missing.body.error!, /upload se nedokončil/u);
  w.storage.put(prepared.body.upload!.uploadUrl, PDF.slice(0, 10)); // truncated PUT
  const truncated = await complete(w, zarges.projectId, { fileId: prepared.body.file!.id });
  assert.equal(truncated.response.status, 422);
  const slug = (await publish(w, zarges.projectId, { action: "publish", mode: "public" })).body.project.publication!.shareSlug;
  const body = (await manifest(w, slug)).body;
  assert.equal(body.state === "ok" && body.documents.some((document) => document.id === prepared.body.file!.id), false);
  assert.equal((await publicFile(w, slug, prepared.body.file!.id)).status, 404);
});

test("resilience: abandoned uploads do not block new ones and disappear from the editor (records are kept)", async () => {
  const w = world();
  const zarges = await createZarges(w);
  for (let index = 0; index < 9; index += 1) {
    assert.equal((await prepare(w, zarges.projectId, { kind: "model", fileName: `v${index}.glb`, mimeType: "model/gltf-binary", sizeBytes: 100 })).response.status, 201);
  }
  assert.equal((await prepare(w, zarges.projectId, { kind: "model", fileName: "x.glb", mimeType: "model/gltf-binary", sizeBytes: 100 })).response.status, 400, "12 live model versions = limit");
  w.clock.now = new Date(w.clock.now.getTime() + 2 * 3600_000);
  assert.equal((await prepare(w, zarges.projectId, { kind: "model", fileName: "x.glb", mimeType: "model/gltf-binary", sizeBytes: 100 })).response.status, 201);
  const view = (await json<{ project: SeeEditorView }>(await handleSeeProjectGet(await req(`/api/see/projects/${zarges.projectId}`), { id: zarges.projectId }, () => w.deps))).project;
  assert.equal(view.files.filter((file) => file.status === "pending").length, 1, "only the fresh pending upload is shown");
  assert.equal((await w.repository.getAggregate(zarges.projectId))!.files.filter((file) => file.status === "pending").length, 10, "nothing deleted");
  assert.equal(isAbandonedUpload({ status: "ready", createdAt: "2000-01-01T00:00:00.000Z" }, w.deps), false);
});

// ───────────────────────── Re-keying under failures ─────────────────────────

test("resilience: R2 copy outage during unpublish → access blocked, warning, project untouched, no orphan copies", async () => {
  const w = world();
  const zarges = await createZarges(w);
  const slug = (await publish(w, zarges.projectId, { action: "publish", mode: "public" })).body.project.publication!.shareSlug;
  const keysBefore = (await w.repository.getAggregate(zarges.projectId))!.files.map((file) => file.storageKey).sort();
  const objectsBefore = w.storage.objects.size;
  w.storage.outage.add("copyObject");
  const result = await publish(w, zarges.projectId, { action: "unpublish" });
  assert.equal(result.status, 200, "revoking access never depends on R2");
  assert.match(result.body.warning!, /nepodařilo překlíčovat/u);
  assert.deepEqual((await manifest(w, slug)).body, { state: "unavailable", reason: "unpublished" });
  assert.deepEqual((await w.repository.getAggregate(zarges.projectId))!.files.map((file) => file.storageKey).sort(), keysBefore);
  assert.equal(w.storage.objects.size, objectsBefore);
  assert.deepEqual(await danglingFiles(w, zarges.projectId), []);
});

test("resilience: a copy that does not verify (size mismatch) is discarded and never used", async () => {
  const w = world();
  const zarges = await createZarges(w);
  const file = (await w.repository.getFile(zarges.manualId))!;
  w.storage.corruptCopies = true;
  assert.equal(await rekeyOneFile(w.deps, file), "copy-failed");
  assert.equal((await w.repository.getFile(zarges.manualId))!.storageKey, file.storageKey);
  assert.equal([...w.storage.objects.keys()].length, 5, "truncated copy removed");
});

test("resilience: database failure while switching the key — copy removed only when provably unused", async () => {
  // a) the write never reached the database
  const w = world();
  const zarges = await createZarges(w);
  const file = (await w.repository.getFile(zarges.models[0]))!;
  const lost = { ...w.deps, repository: failingRepository(w.repository, { method: "updateFileStorageKey", onCall: 1 }) };
  assert.equal(await rekeyOneFile(lost, file), "db-failed");
  assert.equal((await w.repository.getFile(file.id))!.storageKey, file.storageKey);
  assert.equal(w.storage.objects.size, 5, "our copy was removed");
  assert.deepEqual(await danglingFiles(w, zarges.projectId), []);

  // b) the write was committed but the answer got lost
  const committed = { ...w.deps, repository: failingRepository(w.repository, { method: "updateFileStorageKey", onCall: 1, committed: true }) };
  assert.equal(await rekeyOneFile(committed, file), "db-failed");
  const current = (await w.repository.getFile(file.id))!;
  assert.notEqual(current.storageKey, file.storageKey, "record already points at the new key");
  assert.ok(w.storage.objects.has(current.storageKey), "…and that object was NOT deleted");
  assert.deepEqual(await danglingFiles(w, zarges.projectId), []);
});

test("resilience: concurrent tightening actions never leave a dangling key (compare-and-set)", async () => {
  const w = world();
  const zarges = await createZarges(w);
  await publish(w, zarges.projectId, { action: "publish", mode: "pin" });
  const results = await Promise.all([
    publish(w, zarges.projectId, { action: "new-pin" }),
    publish(w, zarges.projectId, { action: "rotate-link" }),
    handleSeeProjectStatus(await req(`/api/see/projects/${zarges.projectId}/status`, { method: "POST", body: { action: "pause" } }), { id: zarges.projectId }, () => w.deps),
  ]);
  assert.ok(results.every((result) => result.status === 200));
  assert.deepEqual(await danglingFiles(w, zarges.projectId), []);
  const file = (await w.repository.getFile(zarges.models[0]))!;
  assert.equal(await rekeyOneFile(w.deps, { ...file, storageKey: file.storageKey }), "ok");
  // a stale snapshot of the record (someone re-keyed in between) is detected as a conflict
  assert.equal(await rekeyOneFile(w.deps, file), "copy-failed", "old key already gone → copy fails safely");
  assert.deepEqual(await danglingFiles(w, zarges.projectId), []);
});

test("resilience: randomized failure injection — the project never points at a missing object", async () => {
  let seed = 7;
  const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
  for (let round = 0; round < 25; round += 1) {
    const w = world();
    const zarges = await createZarges(w);
    await publish(w, zarges.projectId, { action: "publish", mode: "public" });
    const operations = ["copyObject", "head", "deleteObject"] as const;
    for (const operation of operations) if (random() < 0.35) w.storage.outage.add(operation);
    if (random() < 0.3) w.storage.corruptCopies = true;
    const deps = random() < 0.4
      ? { ...w.deps, repository: failingRepository(w.repository, { method: "updateFileStorageKey", onCall: 1 + Math.floor(random() * 5), committed: random() < 0.5 }) }
      : w.deps;
    const response = await handleSeePublication(await req(`/api/see/projects/${zarges.projectId}/publication`, { method: "POST", body: { action: "unpublish" } }), { id: zarges.projectId }, () => deps);
    assert.equal(response.status, 200, `round ${round}`);
    w.storage.outage.clear();
    assert.deepEqual(await danglingFiles(w, zarges.projectId), [], `round ${round}`);
    const publication = (await w.repository.getPublicationByProject(zarges.projectId))!;
    assert.equal(publication.status, "draft", `round ${round}: access revoked regardless of storage`);
  }
});

test("resilience: deleting the old object fails → key switched, warning, old copy only lingers", async () => {
  const w = world();
  const zarges = await createZarges(w);
  const slug = (await publish(w, zarges.projectId, { action: "publish", mode: "public" })).body.project.publication!.shareSlug;
  const oldKey = (await w.repository.getFile(zarges.manualId))!.storageKey;
  w.storage.failDeleteKeys.add(oldKey);
  const result = await publish(w, zarges.projectId, { action: "unpublish" });
  assert.match(result.body.warning!, /1 soubor se nepodařilo překlíčovat/u);
  assert.notEqual((await w.repository.getFile(zarges.manualId))!.storageKey, oldKey);
  assert.deepEqual(await danglingFiles(w, zarges.projectId), []);
  assert.equal((await manifest(w, slug)).status, 403);
});

// ───────────────────────── Delivery and DB failures ─────────────────────────

test("resilience: streamed delivery during an R2 outage → 503 (public pages keep working from the database)", async () => {
  const w = world({ delivery: "stream" });
  const zarges = await createZarges(w);
  const slug = (await publish(w, zarges.projectId, { action: "publish", mode: "public" })).body.project.publication!.shareSlug;
  const url = (await publicFile(w, slug, zarges.models[0])).body.url!;
  w.storage.outage.add("openRead");
  const response = await handleSeeContent(await req(url, { auth: false }), () => w.deps);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "30");
  assert.equal((await manifest(w, slug)).body.state, "ok");
  w.storage.outage.clear();
  assert.equal((await handleSeeContent(await req(url, { auth: false }), () => w.deps)).status, 200);
});

test("resilience: a database failure in the middle of 'Uložit' is fully repaired by saving again", async () => {
  const w = world();
  const zarges = await createZarges(w);
  const annotation = { id: crypto.randomUUID(), sceneId: zarges.inside.id, title: "Vložka", body: "", position: [0, 0.2, 0], visible: true };
  const scenes = zarges.view.scenes.filter((scene) => scene.id !== zarges.closed.id).map((scene) => ({ ...scene, name: `${scene.name} *` }));
  const body = editorBody(zarges.view, { scenes, annotations: [annotation] });
  const broken = { ...w.deps, repository: failingRepository(w.repository, { method: "insertAnnotation", onCall: 1 }) };
  const first = await handleSeeProjectSave(await req(`/api/see/projects/${zarges.projectId}`, { method: "PUT", body }), { id: zarges.projectId }, () => broken);
  assert.equal(first.status, 502);
  const second = await handleSeeProjectSave(await req(`/api/see/projects/${zarges.projectId}`, { method: "PUT", body }), { id: zarges.projectId }, () => w.deps);
  assert.equal(second.status, 200);
  const view = (await json<{ project: SeeEditorView }>(second)).project;
  assert.deepEqual(view.scenes.map((scene) => scene.name), ["Otevřená bedna *", "Pohled dovnitř *"]);
  assert.deepEqual(view.annotations.map((entry) => entry.title), ["Vložka"]);
  assert.deepEqual(await danglingFiles(w, zarges.projectId), []);
});

test("resilience: status change is safe even when the publication update fails afterwards", async () => {
  const w = world();
  const zarges = await createZarges(w);
  const slug = (await publish(w, zarges.projectId, { action: "publish", mode: "public" })).body.project.publication!.shareSlug;
  const broken = { ...w.deps, repository: failingRepository(w.repository, { method: "updatePublication", onCall: 1 }) };
  const response = await handleSeeProjectStatus(await req(`/api/see/projects/${zarges.projectId}/status`, { method: "POST", body: { action: "pause" } }), { id: zarges.projectId }, () => broken);
  assert.equal(response.status, 502);
  assert.deepEqual((await manifest(w, slug)).body, { state: "unavailable", reason: "paused" }, "the project status alone already blocks the link");
});

// ───────────────────────── R2 error classification & retry policy ─────────────────────────

test("resilience: R2 errors — outages become SeeStorageUnavailableError, real refusals stay errors", async () => {
  const key = "hws-see/o/3f0a8c4e-1b2d-4c5e-8f9a-0b1c2d3e4f5a.glb";
  const storageWith = (failure: unknown) => new R2SeeObjectStorage({}, { bucket: "hws-see-test", client: { send: async () => { throw failure; } } });
  for (const failure of [
    Object.assign(new Error("timeout"), { name: "TimeoutError" }),
    Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
    Object.assign(new Error("server"), { $metadata: { httpStatusCode: 503 } }),
    Object.assign(new Error("slow"), { name: "SlowDown", $metadata: { httpStatusCode: 429 } }),
    Object.assign(new Error("wrapped"), { cause: Object.assign(new Error("dns"), { code: "ENOTFOUND" }) }),
  ]) {
    await assert.rejects(storageWith(failure).head(key), SeeStorageUnavailableError, String((failure as Error).message));
    await assert.rejects(storageWith(failure).copyObject(key, key), SeeStorageUnavailableError);
  }
  assert.equal(await storageWith(Object.assign(new Error("nf"), { name: "NotFound", $metadata: { httpStatusCode: 404 } })).head(key), undefined);
  const denied = Object.assign(new Error("denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
  await assert.rejects(storageWith(denied).deleteObject(key), (error: unknown) => error === denied, "misconfiguration is not hidden as an outage");
  assert.equal(isTransientStorageError(undefined), false);
  await assert.rejects(storageWith(denied).head("../../etc/passwd"), /Invalid HWS SEE storage key/u);
});

test("resilience: client retry policy retries only transient failures, with backoff", async () => {
  const waits: number[] = [];
  let calls = 0;
  const value = await withRetry(async () => {
    calls += 1;
    if (calls < 3) throw new SeeTransientError("offline");
    return "ok";
  }, { attempts: 3, baseDelayMs: 100, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(value, "ok");
  assert.deepEqual(waits, [100, 200]);
  let permanent = 0;
  await assert.rejects(withRetry(async () => { permanent += 1; throw new Error("validation"); }, { attempts: 3, baseDelayMs: 1, sleep: async () => {} }), /validation/u);
  assert.equal(permanent, 1);
  await assert.rejects(withRetry(async () => { throw new SeeTransientError("down"); }, { attempts: 2, baseDelayMs: 1, sleep: async () => {} }), /down/u);
  assert.deepEqual([0, 408, 429, 500, 503, 400, 403, 404, 413].map(isRetryableStatus), [true, true, true, true, true, false, false, false, false]);
});
