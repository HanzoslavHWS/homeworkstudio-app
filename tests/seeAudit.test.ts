import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server.js";
import { handleSeeProjectGet, handleSeeProjectSave } from "../app/api/see/projects/[id]/route.ts";
import { handleSeeEditorFile } from "../app/api/see/projects/[id]/files/[fileId]/route.ts";
import { handleSeeProjectStatus } from "../app/api/see/projects/[id]/status/route.ts";
import { handleSeePublication } from "../app/api/see/projects/[id]/publication/route.ts";
import { handleSeePublicView } from "../app/api/see/public/[slug]/view/route.ts";
import { handleSeeContent } from "../app/api/see/content/route.ts";
import { handleSeeDevStoragePut } from "../app/api/see/dev-storage/route.ts";
import { frameAncestorsFor, globalFrameAncestors, parseEmbedOrigins } from "../domain/seeEmbed.ts";
import { glbJsonChunkEnd, inspectGlb, modelOptimizationHints } from "../domain/seeFiles.ts";
import { seeRenderProfile } from "../domain/seeViewerProfile.ts";
import type { SeeEditorView } from "../domain/seeViews.ts";
import { createSeeDeps } from "../lib/see/backend.server.ts";
import { embedFrameAncestorsForSlug } from "../lib/see/embedPolicy.server.ts";
import { MemorySeeRepository } from "../lib/see/repository.memory.ts";
import { generateGrantToken, signTicket } from "../lib/see/security.server.ts";
import { guardStream, pinFailureWindowStart } from "../lib/see/service.server.ts";
import { proxy } from "../proxy.ts";
import {
  createZarges, editorBody, json, makeGlb, manifest, publicFile, publish, req, SEE_TEST_SECRET, session, unlock, uploadFile, world, type World,
} from "./helpers/seeTestKit.ts";

/**
 * HWS SEE security audit — every way a visitor could try to obtain a GLB or a document without
 * authorization, plus immediate invalidation of already issued URLs. Route handlers only, fake R2.
 */

const EVERY_FILE = (zarges: Awaited<ReturnType<typeof createZarges>>) => [...zarges.models, zarges.manualId, zarges.detailId];

async function publishedPin(w: World) {
  const zarges = await createZarges(w);
  const published = await publish(w, zarges.projectId, { action: "publish", mode: "pin" });
  assert.equal(published.status, 200);
  return { ...zarges, slug: published.body.project.publication!.shareSlug, pin: published.body.pin! };
}

// ───────────────────────── 1. No authorization → no bytes ─────────────────────────

test("audit: PIN presentation — no file URL, no manifest content, no signed URL for any visitor without a valid grant", async () => {
  const w = world();
  const zarges = await publishedPin(w);
  const locked = await manifest(w, zarges.slug);
  assert.deepEqual(locked.body, { state: "pin-required" });
  const leaked = JSON.stringify(locked.body);
  for (const secret of [zarges.projectId, ...EVERY_FILE(zarges), "ZARGES", "Zavřená"]) assert.equal(leaked.includes(secret), false, secret);

  const other = await publishedPin(w);
  const otherGrant = (await unlock(w, other.slug, other.pin, "192.0.2.50")).body.grant!;
  const attempts: Record<string, Record<string, string>> = {
    "no grant": {},
    "forged grant": { "x-see-grant": generateGrantToken() },
    "malformed grant": { "x-see-grant": "../../etc/passwd" },
    "grant of another publication": { "x-see-grant": otherGrant },
    "forged cookie": { Cookie: `hws_see_grant=${generateGrantToken()}` },
  };
  for (const [label, headers] of Object.entries(attempts)) {
    for (const fileId of EVERY_FILE(zarges)) {
      for (const download of [false, true]) {
        const result = await publicFile(w, zarges.slug, fileId, headers, download);
        assert.equal(result.status, 401, `${label} ${fileId} download=${download}`);
        assert.equal(result.body.url, undefined);
      }
    }
  }
  // Only the other (legitimately unlocked) publication ever produced signed URLs: none for this one.
  const keys = new Set((await w.repository.getAggregate(zarges.projectId))!.files.map((file) => file.storageKey));
  assert.equal(w.storage.signedGets.some((key) => keys.has(key)), false);
});

test("audit: a public presentation serves only files of its published snapshot", async () => {
  const w = world();
  const zarges = await createZarges(w);
  const slug = (await publish(w, zarges.projectId, { action: "publish", mode: "public" })).body.project.publication!.shareSlug;
  const draftOnly = await uploadFile(w, zarges.projectId, { kind: "document", fileName: "interni-cenik.pdf", mimeType: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.4 draft") });
  const foreign = await createZarges(w, "Cizí projekt");
  const pending = await (await import("../app/api/see/projects/[id]/uploads/route.ts")).handleSeeUploadPrepare(
    await req(`/api/see/projects/${zarges.projectId}/uploads`, { method: "POST", body: { kind: "document", fileName: "nedokonceno.pdf", mimeType: "application/pdf", sizeBytes: 10 } }),
    { id: zarges.projectId }, () => w.deps,
  );
  const pendingId = (await json<{ file: { id: string } }>(pending)).file.id;
  for (const fileId of [draftOnly.fileId, foreign.manualId, foreign.models[0], pendingId, "00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
    assert.equal((await publicFile(w, slug, fileId)).status, 404, fileId);
  }
  assert.equal((await publicFile(w, slug, zarges.models[0])).status, 200);
});

test("audit: editor file URLs and editor API refuse every request without the portal session", async () => {
  const w = world();
  const zarges = await createZarges(w);
  for (const fileId of EVERY_FILE(zarges)) {
    const response = await handleSeeEditorFile(await req(`/api/see/projects/${zarges.projectId}/files/${fileId}`, { auth: false }), { id: zarges.projectId, fileId }, () => w.deps);
    assert.equal(response.status, 401);
  }
  assert.equal((await handleSeeProjectGet(await req(`/api/see/projects/${zarges.projectId}`, { auth: false }), { id: zarges.projectId }, () => w.deps)).status, 401);
});

test("audit: content tickets — wrong secret, foreign key, stale epoch and public reuse are refused", async () => {
  const w = world({ delivery: "stream" });
  const zarges = await createZarges(w);
  const slug = (await publish(w, zarges.projectId, { action: "publish", mode: "public" })).body.project.publication!.shareSlug;
  const file = (await w.repository.getFile(zarges.models[0]))!;
  const publication = (await w.repository.getPublicationBySlug(slug))!;
  const exp = w.clock.now.getTime() + 60_000;
  const content = async (ticket: string) => (await handleSeeContent(await req(`/api/see/content?t=${encodeURIComponent(ticket)}`, { auth: false }), () => w.deps)).status;
  assert.equal(await content(signTicket({ op: "get", key: file.storageKey, fileId: file.id, mime: file.mimeType, exp, publicationId: publication.id, epoch: publication.accessEpoch }, SEE_TEST_SECRET)), 200);
  assert.equal(await content(signTicket({ op: "get", key: file.storageKey, fileId: file.id, mime: file.mimeType, exp }, "attacker-secret-attacker-secret-attacker")), 403);
  const otherFile = (await w.repository.getFile(zarges.manualId))!;
  assert.equal(await content(signTicket({ op: "get", key: otherFile.storageKey, fileId: file.id, mime: file.mimeType, exp }, SEE_TEST_SECRET)), 403, "key must match the file record");
  assert.equal(await content(signTicket({ op: "get", key: file.storageKey, fileId: file.id, mime: file.mimeType, exp, publicationId: publication.id, epoch: publication.accessEpoch - 1 }, SEE_TEST_SECRET)), 403);
  assert.equal(await content(signTicket({ op: "put", key: file.storageKey, fileId: file.id, mime: file.mimeType, exp }, SEE_TEST_SECRET)), 403, "an upload ticket never reads");
  const response = await handleSeeContent(await req(`/api/see/content?t=${encodeURIComponent(signTicket({ op: "get", key: file.storageKey, fileId: file.id, mime: file.mimeType, exp }, SEE_TEST_SECRET))}`, { auth: false }), () => w.deps);
  assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; sandbox; frame-ancestors 'none'");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
});

test("audit: local dev storage route does not exist in production and needs a valid upload ticket", async () => {
  const w = world();
  const put = (environment: Record<string, string>, ticket = "x") => handleSeeDevStoragePut(new NextRequest(`http://localhost/api/see/dev-storage?t=${ticket}`, { method: "PUT", body: "x", headers: { "content-type": "application/pdf" } }), () => w.deps, environment);
  assert.equal((await put({ SEE_BACKEND: "local", NODE_ENV: "production" })).status, 404);
  assert.equal((await put({ NODE_ENV: "development" })).status, 404);
  assert.equal((await put({ SEE_BACKEND: "local", NODE_ENV: "development" })).status, 401, "outside the proxy the route checks the portal session itself");
  const withSession = await handleSeeDevStoragePut(new NextRequest("http://localhost/api/see/dev-storage?t=x", { method: "PUT", body: "x", headers: { "content-type": "application/pdf", Cookie: await session() } }), () => w.deps, { SEE_BACKEND: "local", NODE_ENV: "development" });
  assert.equal(withSession.status, 404, "fake R2 is not local storage → not served");
});

// ───────────────────────── 2. Immediate invalidation ─────────────────────────

test("audit: signed URLs issued before unpublish / new PIN / link rotation / pause / mode change stop working at once (re-keying)", async () => {
  const scenarios: [string, (w: World, projectId: string) => Promise<unknown>][] = [
    ["unpublish", (w, id) => publish(w, id, { action: "unpublish" })],
    ["new-pin", (w, id) => publish(w, id, { action: "new-pin" })],
    ["rotate-link", (w, id) => publish(w, id, { action: "rotate-link" })],
    ["pause", async (w, id) => handleSeeProjectStatus(await req(`/api/see/projects/${id}/status`, { method: "POST", body: { action: "pause" } }), { id }, () => w.deps)],
    ["archive", async (w, id) => handleSeeProjectStatus(await req(`/api/see/projects/${id}/status`, { method: "POST", body: { action: "archive" } }), { id }, () => w.deps)],
    ["delete", async (w, id) => handleSeeProjectStatus(await req(`/api/see/projects/${id}/status`, { method: "POST", body: { action: "delete" } }), { id }, () => w.deps)],
  ];
  for (const [label, action] of scenarios) {
    const w = world();
    const zarges = await publishedPin(w);
    const grant = (await unlock(w, zarges.slug, zarges.pin)).body.grant!;
    const modelUrl = (await publicFile(w, zarges.slug, zarges.models[0], { "x-see-grant": grant })).body.url!;
    const docUrl = (await publicFile(w, zarges.slug, zarges.manualId, { "x-see-grant": grant }, true)).body.url!;
    assert.equal(w.storage.fetchSigned(modelUrl).status, 200, label);
    await action(w, zarges.projectId);
    assert.equal(w.storage.fetchSigned(modelUrl).status, 404, `${label}: issued model URL must be dead`);
    assert.equal(w.storage.fetchSigned(docUrl).status, 404, `${label}: issued document URL must be dead`);
    const files = (await w.repository.getAggregate(zarges.projectId))!.files.filter((file) => file.status === "ready");
    for (const file of files) assert.ok(w.storage.objects.has(file.storageKey), `${label}: content preserved under the new key`);
  }
});

test("audit: switching public → PIN kills public URLs; PIN → public does not re-key needlessly", async () => {
  const w = world();
  const zarges = await createZarges(w);
  const slug = (await publish(w, zarges.projectId, { action: "publish", mode: "public" })).body.project.publication!.shareSlug;
  const url = (await publicFile(w, slug, zarges.models[1])).body.url!;
  const toPin = await publish(w, zarges.projectId, { action: "set-mode", mode: "pin" });
  assert.equal(w.storage.fetchSigned(url).status, 404);
  const grant = (await unlock(w, slug, toPin.body.pin!)).body.grant!;
  const pinUrl = (await publicFile(w, slug, zarges.models[1], { "x-see-grant": grant })).body.url!;
  assert.equal(w.storage.fetchSigned(pinUrl).status, 200, "authorized visitors get working URLs for the new key");
  await publish(w, zarges.projectId, { action: "set-mode", mode: "public" });
  assert.equal(w.storage.fetchSigned(pinUrl).status, 200, "loosening access keeps objects where they are");
});

test("audit: removing a document in the editor kills its issued URL immediately", async () => {
  const w = world();
  const zarges = await createZarges(w);
  const slug = (await publish(w, zarges.projectId, { action: "publish", mode: "public" })).body.project.publication!.shareSlug;
  const url = (await publicFile(w, slug, zarges.manualId, {}, true)).body.url!;
  const files = zarges.view.files.map((file) => ({ id: file.id, displayName: file.displayName, appliesToAll: file.appliesToAll, sceneIds: file.sceneIds, deleted: file.id === zarges.manualId }));
  const saved = await handleSeeProjectSave(await req(`/api/see/projects/${zarges.projectId}`, { method: "PUT", body: editorBody(zarges.view, { files }) }), { id: zarges.projectId }, () => w.deps);
  assert.equal(saved.status, 200);
  assert.equal(w.storage.fetchSigned(url).status, 404);
  assert.equal((await publicFile(w, slug, zarges.manualId, {}, true)).status, 404);
  const manifestBody = (await manifest(w, slug)).body;
  assert.equal(manifestBody.state === "ok" && manifestBody.documents.some((document) => document.id === zarges.manualId), false);
});

test("audit: failed re-keying is reported to the editor while access stays blocked at the application layer", async () => {
  const w = world();
  const zarges = await publishedPin(w);
  const grant = (await unlock(w, zarges.slug, zarges.pin)).body.grant!;
  w.storage.failCopy = true;
  const result = await publish(w, zarges.projectId, { action: "unpublish" });
  assert.equal(result.status, 200);
  assert.match(result.body.warning!, /nepodařilo překlíčovat .* nejpozději za 60 s/u);
  assert.equal((await publicFile(w, zarges.slug, zarges.models[0], { "x-see-grant": grant })).status, 403);
});

test("audit: SEE_REKEY_ON_REVOKE=false keeps keys (documented 60 s window) — the switch works", async () => {
  const w = world({ rekeyOnRevoke: false });
  const zarges = await createZarges(w);
  const slug = (await publish(w, zarges.projectId, { action: "publish", mode: "public" })).body.project.publication!.shareSlug;
  const url = (await publicFile(w, slug, zarges.models[0])).body.url!;
  await publish(w, zarges.projectId, { action: "unpublish" });
  assert.equal(w.storage.fetchSigned(url).status, 200);
  assert.match(url, /ttl=60/u);
});

test("audit: stream delivery aborts a running download as soon as access is revoked", async () => {
  const w = world({ delivery: "stream", streamRecheckMs: 0 });
  const big = makeGlb({ asset: { version: "2.0" } }, new Uint8Array(256 * 1024).fill(7));
  const created = await createZarges(w);
  const extra = await uploadFile(w, created.projectId, { kind: "model", fileName: "big.glb", mimeType: "model/gltf-binary", bytes: big, sceneId: created.open.id });
  assert.equal(extra.response.status, 200);
  const slug = (await publish(w, created.projectId, { action: "publish", mode: "public" })).body.project.publication!.shareSlug;
  const url = (await publicFile(w, slug, extra.fileId)).body.url!;
  const response = await handleSeeContent(await req(url, { auth: false }), () => w.deps);
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  assert.equal((await reader.read()).done, false, "download started");
  await publish(w, created.projectId, { action: "unpublish" });
  await assert.rejects(async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
    }
  }, /revoked/u);
});

test("audit: guardStream checks at most once per interval and passes data through untouched", async () => {
  let now = 0;
  let checks = 0;
  const source = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < 5; i += 1) controller.enqueue(new Uint8Array([i])); controller.close(); } });
  const guarded = guardStream(source, async () => { checks += 1; return true; }, 1000, () => now);
  const reader = guarded.getReader();
  const seen: number[] = [];
  for (;;) {
    now += 400;
    const chunk = await reader.read();
    if (chunk.done) break;
    seen.push(chunk.value[0]);
  }
  assert.deepEqual(seen, [0, 1, 2, 3, 4]);
  assert.equal(checks, 2);
});

test("audit: hybrid delivery streams documents (instant cut-off) and signs models", async () => {
  const w = world({ delivery: "hybrid" });
  const zarges = await createZarges(w);
  const slug = (await publish(w, zarges.projectId, { action: "publish", mode: "public" })).body.project.publication!.shareSlug;
  assert.match((await publicFile(w, slug, zarges.manualId, {}, true)).body.url!, /^\/api\/see\/content\?t=/u);
  assert.match((await publicFile(w, slug, zarges.models[0])).body.url!, /^https:\/\/r2\.test\/get\//u);
});

// ───────────────────────── 3. CSRF and PIN abuse ─────────────────────────

test("audit: editor mutations reject cross-site requests (CSRF defense in depth)", async () => {
  const w = world();
  const zarges = await createZarges(w);
  const unpublishWith = async (init: Parameters<typeof req>[1]) => (await handleSeePublication(await req(`/api/see/projects/${zarges.projectId}/publication`, { method: "POST", ...init }), { id: zarges.projectId }, () => w.deps)).status;
  await publish(w, zarges.projectId, { action: "publish", mode: "public" });
  assert.equal(await unpublishWith({ rawBody: JSON.stringify({ action: "unpublish" }), headers: { "Content-Type": "text/plain" } }), 415);
  assert.equal(await unpublishWith({ body: { action: "unpublish" }, headers: { Origin: "https://evil.example" } }), 403);
  assert.equal(await unpublishWith({ body: { action: "unpublish" }, headers: { "Sec-Fetch-Site": "cross-site" } }), 403);
  const status = await handleSeeProjectStatus(await req(`/api/see/projects/${zarges.projectId}/status`, { method: "POST", rawBody: "action=delete", headers: { "Content-Type": "application/x-www-form-urlencoded" } }), { id: zarges.projectId }, () => w.deps);
  assert.equal(status.status, 415);
  assert.equal(await unpublishWith({ body: { action: "unpublish" }, headers: { Origin: "http://localhost", "Sec-Fetch-Site": "same-origin" } }), 200);
});

test("audit: a deliberate PIN lockout of the whole presentation can be ended by a new PIN", async () => {
  const w = world();
  const zarges = await publishedPin(w);
  for (let index = 0; index < 50; index += 1) await unlock(w, zarges.slug, "00000000", `198.18.${Math.floor(index / 200)}.${index % 200}`);
  assert.equal((await unlock(w, zarges.slug, zarges.pin, "203.0.113.200")).status, 429, "global cap blocks distributed guessing");
  const view = (await json<{ project: SeeEditorView }>(await handleSeeProjectGet(await req(`/api/see/projects/${zarges.projectId}`), { id: zarges.projectId }, () => w.deps))).project;
  assert.deepEqual(view.pinSecurity, { recentFailures: 50, locked: true });
  w.clock.now = new Date(w.clock.now.getTime() + 1000);
  const renewed = await publish(w, zarges.projectId, { action: "new-pin" });
  assert.equal((await unlock(w, zarges.slug, renewed.body.pin!, "203.0.113.201")).status, 200);
  assert.equal(renewed.body.project.pinSecurity?.locked, false);
  assert.equal(pinFailureWindowStart({ pinSetAt: "2026-11-21T12:00:01.000Z" }, new Date("2026-11-21T12:05:00.000Z")), "2026-11-21T12:00:01.000Z");
  assert.equal(pinFailureWindowStart({ pinSetAt: "2026-11-21T10:00:00.000Z" }, new Date("2026-11-21T12:05:00.000Z")), "2026-11-21T11:50:00.000Z");
});

test("audit: view counter needs access; a locked PIN presentation cannot be counted or probed", async () => {
  const w = world();
  const zarges = await publishedPin(w);
  const response = await handleSeePublicView(await req(`/api/see/public/${zarges.slug}/view`, { method: "POST", auth: false, body: {} }), { slug: zarges.slug }, () => w.deps);
  assert.equal(response.status, 401);
});

// ───────────────────────── 4. Embed policy per presentation ─────────────────────────

test("embed policy: validation, per-publication CSP value and editor action", async () => {
  assert.deepEqual(parseEmbedOrigins("https://www.zakaznik.cz\nhttps://*.zakaznik.cz, HTTPS://WWW.ZAKAZNIK.CZ/"), ["https://www.zakaznik.cz", "https://*.zakaznik.cz"]);
  for (const invalid of ["http://zakaznik.cz", "https://zakaznik.cz/cesta", "javascript:alert(1)", "*", "https://*", "'unsafe-inline'", "https://exa mple.cz"]) {
    assert.throws(() => parseEmbedOrigins(invalid), /není platná adresa/u, invalid);
  }
  assert.throws(() => parseEmbedOrigins(Array.from({ length: 21 }, (_, index) => `https://s${index}.example.cz`)), /Nejvýše 20/u);
  assert.equal(frameAncestorsFor({ embedPolicy: "default", embedOrigins: [] }, undefined), "'self' https:");
  assert.equal(frameAncestorsFor({ embedPolicy: "default", embedOrigins: [] }, "https://a.cz bogus"), "https://a.cz");
  assert.equal(frameAncestorsFor({ embedPolicy: "none", embedOrigins: ["https://a.cz"] }, undefined), "'none'");
  assert.equal(frameAncestorsFor({ embedPolicy: "allowlist", embedOrigins: ["https://a.cz", "https://*.b.cz"] }, "https:"), "'self' https://a.cz https://*.b.cz");
  assert.equal(frameAncestorsFor({ embedPolicy: "allowlist", embedOrigins: [] }, "https:"), "'none'", "an empty allowlist never falls back to 'anyone'");
  assert.equal(globalFrameAncestors("'self' https: http://localhost:3200"), "'self' https: http://localhost:3200");

  const w = world();
  const zarges = await createZarges(w);
  assert.equal((await publish(w, zarges.projectId, { action: "set-embed", embedPolicy: "none" })).status, 409, "needs a publication");
  await publish(w, zarges.projectId, { action: "publish", mode: "public" });
  assert.equal((await publish(w, zarges.projectId, { action: "set-embed", embedPolicy: "allowlist", embedOrigins: "" })).status, 400);
  assert.equal((await publish(w, zarges.projectId, { action: "set-embed", embedPolicy: "allowlist", embedOrigins: "https://evil.cz/path" })).status, 400);
  assert.equal((await publish(w, zarges.projectId, { action: "set-embed", embedPolicy: "everyone" })).status, 400);
  const saved = await publish(w, zarges.projectId, { action: "set-embed", embedPolicy: "allowlist", embedOrigins: "https://www.zakaznik.cz" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.project.publication!.embedPolicy, "allowlist");
  assert.deepEqual(saved.body.project.publication!.embedOrigins, ["https://www.zakaznik.cz"]);
  const before = (await w.repository.getPublicationByProject(zarges.projectId))!;
  assert.equal(before.accessEpoch, 1, "framing policy changes do not log visitors out");
});

test("embed policy: proxy.ts sends the publication's own frame-ancestors on /see/embed/<slug>", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hws-see-embed-"));
  const environment = { SEE_BACKEND: "local", NODE_ENV: "development", SEE_LOCAL_DIR: dir, APP_SESSION_SECRET: SEE_TEST_SECRET } as Record<string, string>;
  const previous = { ...process.env };
  Object.assign(process.env, environment);
  try {
    const deps = createSeeDeps(environment);
    const at = "2026-11-21T12:00:00.000Z";
    const slugs = { allow: "A".repeat(32), none: "B".repeat(32), standard: "C".repeat(32) };
    for (const [index, [policy, slug]] of (Object.entries(slugs) as [string, string][]).entries()) {
      const projectId = `0000000${index}-0000-4000-8000-000000000000`;
      await deps.repository.insertProject({ id: projectId, name: "P", description: "", status: "active", createdAt: at, updatedAt: at });
      await deps.repository.insertPublication({
        id: `1000000${index}-0000-4000-8000-000000000000`, projectId, shareSlug: slug, mode: "public", status: "published", accessEpoch: 1, snapshotRevision: 1, viewCount: 0,
        embedPolicy: policy === "allow" ? "allowlist" : policy === "none" ? "none" : "default", embedOrigins: policy === "allow" ? ["https://www.zakaznik.cz"] : [],
        createdAt: at, updatedAt: at,
      });
    }
    const csp = async (slug: string) => (await proxy(new NextRequest(`http://localhost/see/embed/${slug}`))).headers.get("content-security-policy");
    assert.equal(await csp(slugs.allow), "frame-ancestors 'self' https://www.zakaznik.cz");
    assert.equal(await csp(slugs.none), "frame-ancestors 'none'");
    assert.equal(await csp(slugs.standard), "frame-ancestors 'self' https:");
    assert.equal(await csp("D".repeat(32)), "frame-ancestors 'self' https:", "unknown slug → global policy (page shows 'neexistuje')");
    assert.equal(await embedFrameAncestorsForSlug("not valid"), "'self' https:");
    // A second repository instance (as next dev may create) sees the same data.
    const sibling = new MemorySeeRepository({ persistFile: path.join(dir, "db.json") });
    assert.equal((await sibling.getPublicationBySlug(slugs.allow))?.embedPolicy, "allowlist");
  } finally {
    for (const key of Object.keys(environment)) delete (process.env as Record<string, string | undefined>)[key];
    Object.assign(process.env, previous);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────────────────── 5. GLB inspection & KTX2 ─────────────────────────

const KTX2_GLTF = {
  asset: { version: "2.0", generator: "gltf-transform" },
  extensionsUsed: ["KHR_texture_basisu", "KHR_draco_mesh_compression", "EXT_meshopt_compression"],
  extensionsRequired: ["KHR_texture_basisu", "KHR_draco_mesh_compression"],
  accessors: [{ count: 30000 }, { count: 9000 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 1 }, indices: 0, mode: 4 }, { attributes: { POSITION: 1 }, mode: 4 }] }],
  materials: [{}, {}],
  textures: [{ extensions: { KHR_texture_basisu: { source: 0 } } }],
  images: [{ mimeType: "image/ktx2", bufferView: 0 }],
};

test("GLB inspection: KTX2 / Draco / Meshopt models are accepted and described", async () => {
  const info = inspectGlb(makeGlb(KTX2_GLTF));
  assert.equal(info.ktx2, true);
  assert.equal(info.draco, true);
  assert.equal(info.meshopt, true);
  assert.equal(info.triangles, 10000 + 3000);
  assert.deepEqual(info.imageTypes, ["image/ktx2"]);
  assert.deepEqual(info.unsupportedRequired, []);
  assert.equal(info.generator, "gltf-transform");

  const w = world();
  const zarges = await createZarges(w);
  const uploaded = await uploadFile(w, zarges.projectId, { kind: "model", fileName: "ktx2.glb", mimeType: "model/gltf-binary", bytes: makeGlb(KTX2_GLTF), sceneId: zarges.inside.id });
  assert.equal(uploaded.response.status, 200);
  const view = (await json<{ project: SeeEditorView }>(uploaded.response)).project;
  assert.equal(view.files.find((file) => file.id === uploaded.fileId)?.modelInfo?.ktx2, true);
});

test("GLB inspection: unsupported required extensions, glTF 1.0 and broken JSON are refused at upload", async () => {
  const w = world();
  const zarges = await createZarges(w);
  const cases: [string, Uint8Array, RegExp][] = [
    ["required-unknown", makeGlb({ asset: { version: "2.0" }, extensionsUsed: ["EXT_unknown_magic"], extensionsRequired: ["EXT_unknown_magic"] }), /nepodporovaná rozšíření glTF: EXT_unknown_magic/u],
    ["spec-gloss", makeGlb({ asset: { version: "2.0" }, extensionsRequired: ["KHR_materials_pbrSpecularGlossiness"] }), /KHR_materials_pbrSpecularGlossiness/u],
    ["gltf1", makeGlb({ asset: { version: "1.0" } }), /jen glTF 2\.0/u],
  ];
  const broken = makeGlb({ asset: { version: "2.0" } });
  broken[20] = 0x5b; // "[" instead of "{" → the JSON chunk no longer parses
  cases.push(["broken-json", broken, /poškozená metadata/u]);
  for (const [label, bytes, message] of cases) {
    const result = await uploadFile(w, zarges.projectId, { kind: "model", fileName: `${label}.glb`, mimeType: "model/gltf-binary", bytes });
    assert.equal(result.response.status, 422, label);
    assert.match((await json<{ error: string }>(result.response)).error, message, label);
  }
  assert.equal(glbJsonChunkEnd(new Uint8Array(10)), 0);
  // An optional (not required) unknown extension is fine — three.js simply ignores it.
  const optional = await uploadFile(w, zarges.projectId, { kind: "model", fileName: "optional.glb", mimeType: "model/gltf-binary", bytes: makeGlb({ asset: { version: "2.0" }, extensionsUsed: ["EXT_vendor_hint"] }) });
  assert.equal(optional.response.status, 200);
});

test("GLB optimization hints are practical and never block", () => {
  const plain = inspectGlb(makeGlb({ asset: { version: "2.0" }, accessors: [{ count: 9_000_000 }], meshes: [{ primitives: [{ indices: 0 }] }], images: [{ mimeType: "image/png" }, { uri: "texture.jpg" }] }));
  const hints = modelOptimizationHints(plain, 80_000_000);
  assert.equal(hints.length, 4);
  assert.match(hints.join(" "), /Draco nebo Meshopt/u);
  assert.match(hints.join(" "), /KTX2/u);
  assert.match(hints.join(" "), /3 mil\. trojúhelníků/u);
  assert.match(hints.join(" "), /externí textury/u);
  assert.deepEqual(modelOptimizationHints(inspectGlb(makeGlb(KTX2_GLTF)), 30_000_000), []);
});

test("KTX2 transcoder and Draco decoder are public static files; nothing else under /see is", async () => {
  const anonymous = async (pathname: string) => proxy(new NextRequest(`http://localhost${pathname}`));
  const content = await anonymous("/api/see/content");
  assert.equal(content.headers.get("content-security-policy"), "default-src 'none'; sandbox; frame-ancestors 'none'", "proxy keeps the sandbox policy of delivered files");
  for (const asset of ["/see/basis/basis_transcoder.js", "/see/basis/basis_transcoder.wasm", "/see/draco/draco_decoder.wasm"]) {
    assert.equal((await anonymous(asset)).headers.get("x-middleware-next"), "1", asset);
  }
  for (const privatePath of ["/see/basis/other.js", "/see/basis/../projects", "/see/draco/draco_decoder.js"]) {
    assert.equal((await anonymous(privatePath)).status, 307, privatePath);
  }
});

// ───────────────────────── 6. Viewer render profile ─────────────────────────

test("viewer profile: phones render lighter while interacting, quality settings stay intact", () => {
  const desktop = seeRenderProfile({ coarsePointer: false, devicePixelRatio: 2, maxAnisotropy: 16 });
  assert.deepEqual(desktop, { pixelRatio: 2, interactionPixelRatio: 2, antialias: true, powerPreference: "high-performance", prefetchOtherModels: true, anisotropy: 8, maxCachedModels: 3 });
  const phone = seeRenderProfile({ coarsePointer: true, devicePixelRatio: 3, maxAnisotropy: 16, deviceMemoryGb: 4 });
  assert.deepEqual(phone, { pixelRatio: 1.75, interactionPixelRatio: 1, antialias: false, powerPreference: "default", prefetchOtherModels: true, anisotropy: 4, maxCachedModels: 3 });
  const weak = seeRenderProfile({ coarsePointer: true, devicePixelRatio: 2, deviceMemoryGb: 2, saveData: true });
  assert.equal(weak.pixelRatio, 1.25);
  assert.equal(weak.prefetchOtherModels, false);
  assert.equal(weak.maxCachedModels, 1);
  assert.equal(weak.anisotropy, 1);
  assert.equal(seeRenderProfile({ coarsePointer: false, devicePixelRatio: 1, effectiveType: "2g" }).prefetchOtherModels, false);
  assert.equal(seeRenderProfile({ coarsePointer: false, devicePixelRatio: Number.NaN }).pixelRatio, 1);
});
