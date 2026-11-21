import assert from "node:assert/strict";
import test from "node:test";
import { handleSeeProjectCreate, handleSeeProjectList } from "../app/api/see/projects/route.ts";
import { handleSeeProjectGet, handleSeeProjectSave } from "../app/api/see/projects/[id]/route.ts";
import { handleSeeUploadPrepare } from "../app/api/see/projects/[id]/uploads/route.ts";
import { handleSeeUploadComplete } from "../app/api/see/projects/[id]/uploads/complete/route.ts";
import { handleSeeEditorFile } from "../app/api/see/projects/[id]/files/[fileId]/route.ts";
import { handleSeeProjectStatus } from "../app/api/see/projects/[id]/status/route.ts";
import { handleSeePublication } from "../app/api/see/projects/[id]/publication/route.ts";
import { handleSeePublicView } from "../app/api/see/public/[slug]/view/route.ts";
import { handleSeeContent } from "../app/api/see/content/route.ts";
import { documentsForScene } from "../domain/seeProject.ts";
import type { SeeEditorView } from "../domain/seeViews.ts";
import { createZarges, editorBody, GLB, JPG, json, manifest, PDF, publicFile, publish, req, unlock, uploadFile, world } from "./helpers/seeTestKit.ts";

test("HWS SEE: editor API requires the existing portal session (no second login)", async () => {
  const w = world();
  const id = "6f1c2a1e-8a52-4b55-9a51-0c2b8b0c1d11";
  assert.equal((await handleSeeProjectList(await req("/api/see/projects", { auth: false }), () => w.deps)).status, 401);
  assert.equal((await handleSeeProjectCreate(await req("/api/see/projects", { method: "POST", auth: false, body: { name: "X" } }), () => w.deps)).status, 401);
  assert.equal((await handleSeeProjectSave(await req(`/api/see/projects/${id}`, { method: "PUT", auth: false, body: {} }), { id }, () => w.deps)).status, 401);
  assert.equal((await handleSeeUploadPrepare(await req(`/api/see/projects/${id}/uploads`, { method: "POST", auth: false, body: {} }), { id }, () => w.deps)).status, 401);
  assert.equal((await handleSeePublication(await req(`/api/see/projects/${id}/publication`, { method: "POST", auth: false, body: { action: "publish" } }), { id }, () => w.deps)).status, 401);
  assert.equal((await handleSeeProjectStatus(await req(`/api/see/projects/${id}/status`, { method: "POST", auth: false, body: { action: "pause" } }), { id }, () => w.deps)).status, 401);
  const forged = await handleSeeProjectList(await req("/api/see/projects", { auth: false, headers: { Cookie: "homeworkstudio_session=eyJ2ZXJzaW9uIjoxfQ.forged" } }), () => w.deps);
  assert.equal(forged.status, 401);
});

test("HWS SEE: new project with 3 GLB scenes + documents persists metadata and author", async () => {
  const w = world();
  const { view, closed, inside, models } = await createZarges(w);
  assert.equal(view.project.name, "ZARGES 40863");
  assert.equal(view.project.createdBy?.label, "Současný portálový účet");
  assert.deepEqual(view.scenes.map((scene) => scene.name), ["Zavřená bedna", "Otevřená bedna", "Pohled dovnitř"]);
  assert.deepEqual(view.scenes.map((scene) => scene.modelFileId), models);
  assert.equal(view.files.filter((file) => file.status === "ready").length, 5);
  const documents = view.files.filter((file) => file.kind === "document");
  assert.deepEqual(documentsForScene(documents, closed.id).map((file) => file.originalFileName), ["navod.pdf"]);
  assert.deepEqual(documentsForScene(documents, inside.id).map((file) => file.originalFileName), ["navod.pdf", "vnitrni-detail.jpg"]);
  assert.equal(JSON.stringify(view).includes("hws-see/o/"), false, "no storage keys in editor responses");
  const list = await json<{ items: { project: { name: string }; sceneCount: number; documentCount: number }[]; total: number }>(await handleSeeProjectList(await req("/api/see/projects?q=zarges"), () => w.deps));
  assert.equal(list.total, 1);
  assert.equal(list.items[0].sceneCount, 3);
  assert.equal(list.items[0].documentCount, 2);
});

test("HWS SEE: uploads are server-validated (type, extension, size, real content)", async () => {
  const w = world({ limits: { maxModelBytes: 1000, maxDocumentBytes: 1000 } });
  const created = await json<{ project: SeeEditorView }>(await handleSeeProjectCreate(await req("/api/see/projects", { method: "POST", body: { name: "Limity", scenes: [{ name: "A" }] } }), () => w.deps));
  const id = created.project.project.id;
  const prepare = (body: Record<string, unknown>) => req(`/api/see/projects/${id}/uploads`, { method: "POST", body });
  assert.equal((await handleSeeUploadPrepare(await prepare({ kind: "model", fileName: "virus.exe", mimeType: "application/octet-stream", sizeBytes: 10 }), { id }, () => w.deps)).status, 400);
  assert.equal((await handleSeeUploadPrepare(await prepare({ kind: "document", fileName: "doc.docx", mimeType: "application/msword", sizeBytes: 10 }), { id }, () => w.deps)).status, 400);
  assert.equal((await handleSeeUploadPrepare(await prepare({ kind: "model", fileName: "big.glb", mimeType: "model/gltf-binary", sizeBytes: 5000 }), { id }, () => w.deps)).status, 413);
  assert.equal((await handleSeeUploadPrepare(await prepare({ kind: "document", fileName: "fake.png", mimeType: "application/pdf", sizeBytes: 10 }), { id }, () => w.deps)).status, 400);
  // Declared GLB whose bytes are not glTF → rejected at "complete" and the object is removed.
  const bogus = await uploadFile(w, id, { kind: "model", fileName: "renamed.glb", mimeType: "model/gltf-binary", bytes: PDF });
  assert.equal(bogus.response.status, 422);
  assert.equal(w.storage.objects.size, 0);
  // Declared size must match the uploaded object.
  const prepared = await json<{ file: { id: string }; upload: { uploadUrl: string } }>(await handleSeeUploadPrepare(await prepare({ kind: "model", fileName: "a.glb", mimeType: "model/gltf-binary", sizeBytes: 999 }), { id }, () => w.deps));
  w.storage.put(prepared.upload.uploadUrl, GLB);
  const mismatch = await handleSeeUploadComplete(await req(`/api/see/projects/${id}/uploads/complete`, { method: "POST", body: { fileId: prepared.file.id } }), { id }, () => w.deps);
  assert.equal(mismatch.status, 422);
});

test("HWS SEE: camera + 3D annotation of the second model survive a reload; drafts stay out of the publication", async () => {
  const w = world();
  const { view, projectId, open } = await createZarges(w);
  const camera = { position: [1.5, 1.2, 2.5], target: [0, 0.4, 0], fov: 40 };
  const annotation = { id: crypto.randomUUID(), sceneId: open.id, title: "Zámek víka", body: "Otevírat oběma rukama.", position: [0.12, 0.55, -0.3], normal: [0, 1, 0], visible: true };
  const scenes = view.scenes.map((scene) => scene.id === open.id ? { ...scene, settings: { ...scene.settings, camera, background: "dark", lighting: "contrast", exposure: 1.3 } } : scene);
  const saved = await handleSeeProjectSave(await req(`/api/see/projects/${projectId}`, { method: "PUT", body: editorBody(view, { scenes, annotations: [annotation] }) }), { id: projectId }, () => w.deps);
  assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));
  const reloaded = (await json<{ project: SeeEditorView }>(await handleSeeProjectGet(await req(`/api/see/projects/${projectId}`), { id: projectId }, () => w.deps))).project;
  const openScene = reloaded.scenes.find((scene) => scene.id === open.id)!;
  assert.deepEqual(openScene.settings.camera, camera);
  assert.equal(openScene.settings.background, "dark");
  assert.equal(reloaded.annotations.length, 1);
  assert.deepEqual(reloaded.annotations[0].position, [0.12, 0.55, -0.3]);
  assert.equal(reloaded.annotations[0].sceneId, open.id);

  // An annotation pointing at a foreign / unknown scene is refused.
  const bad = await handleSeeProjectSave(await req(`/api/see/projects/${projectId}`, { method: "PUT", body: editorBody(reloaded, { annotations: [{ ...annotation, id: crypto.randomUUID(), sceneId: crypto.randomUUID() }] }) }), { id: projectId }, () => w.deps);
  assert.equal(bad.status, 400);

  const published = await publish(w, projectId, { action: "publish", mode: "public" });
  assert.equal(published.status, 200);
  const slug = published.body.project.publication!.shareSlug;
  const renamed = await handleSeeProjectSave(await req(`/api/see/projects/${projectId}`, { method: "PUT", body: { ...editorBody(reloaded), project: { name: "ZARGES – rozpracovaný návrh", description: "" } } }), { id: projectId }, () => w.deps);
  assert.equal((await json<{ project: SeeEditorView }>(renamed)).project.hasUnpublishedChanges, true);
  const publicView = await manifest(w, slug);
  assert.equal(publicView.body.state === "ok" && publicView.body.title, "ZARGES 40863", "visitors keep seeing the published snapshot");
});

test("HWS SEE: public link works anonymously; downloads are filtered per model; only snapshot files are served", async () => {
  const w = world();
  const { projectId, closed, inside, models, manualId, detailId } = await createZarges(w);
  const published = await publish(w, projectId, { action: "publish", mode: "public" });
  assert.equal(published.status, 200);
  assert.equal(published.body.pin, undefined);
  const slug = published.body.project.publication!.shareSlug;
  assert.match(slug, /^[A-Za-z0-9]{32}$/u);

  const result = await manifest(w, slug);
  assert.equal(result.status, 200);
  assert.equal(result.response.headers.get("x-robots-tag")?.includes("noindex"), true);
  assert.equal(result.body.state, "ok");
  if (result.body.state !== "ok") return;
  assert.equal(result.body.scenes.length, 3);
  assert.equal(JSON.stringify(result.body).includes("hws-see/o/"), false, "no internal object keys for visitors");
  assert.equal(JSON.stringify(result.body).includes(projectId), false, "no internal project id for visitors");
  assert.deepEqual(documentsForScene(result.body.documents, closed.id).map((document) => document.id), [manualId]);
  assert.deepEqual(documentsForScene(result.body.documents, inside.id).map((document) => document.id), [manualId, detailId]);

  const model = await publicFile(w, slug, models[1]);
  assert.equal(model.status, 200);
  assert.match(model.body.url!, /ttl=60/u);
  const download = await publicFile(w, slug, detailId, {}, true);
  assert.match(download.body.url!, /attachment=true/u);
  assert.match(download.body.url!, /name=vnitrni-detail\.jpg/u);
  assert.equal((await publicFile(w, slug, crypto.randomUUID())).status, 404);

  // A document uploaded after publishing is NOT reachable until the next "Publikovat".
  const late = await uploadFile(w, projectId, { kind: "document", fileName: "cenik.pdf", mimeType: "application/pdf", bytes: PDF });
  assert.equal((await publicFile(w, slug, late.fileId)).status, 404);
  assert.equal((await manifest(w, "Z".repeat(32))).status, 404);
  assert.equal((await manifest(w, "../../etc")).status, 404);
});

test("HWS SEE: PIN mode blocks manifest, models and documents until the server verifies the PIN", async () => {
  const w = world();
  const { projectId, models, manualId } = await createZarges(w);
  const slug = (await publish(w, projectId, { action: "publish", mode: "public" })).body.project.publication!.shareSlug;
  const switched = await publish(w, projectId, { action: "set-mode", mode: "pin" });
  assert.equal(switched.status, 200);
  const pin = switched.body.pin!;
  assert.match(pin, /^\d{8}$/u);
  assert.equal(switched.body.project.publication!.hasPin, true);
  assert.equal(JSON.stringify(switched.body.project).includes(pin), false, "the PIN is returned once, separately, never inside the project");

  const locked = await manifest(w, slug);
  assert.equal(locked.status, 401);
  assert.deepEqual(locked.body, { state: "pin-required" });
  assert.equal((await publicFile(w, slug, models[0])).status, 401);
  assert.equal((await publicFile(w, slug, manualId, {}, true)).status, 401);
  assert.equal(w.storage.signedGets.length, 0, "no presigned URL was ever generated without a grant");
  assert.equal((await manifest(w, slug, { "x-see-grant": "A".repeat(43) })).body.state, "pin-required");

  const wrong = await unlock(w, slug, "00000000");
  assert.equal(wrong.status, 401);
  assert.match(wrong.body.error!, /Nesprávný PIN/u);

  const granted = await unlock(w, slug, pin);
  assert.equal(granted.status, 200);
  const grant = granted.body.grant!;
  const cookie = granted.response.cookies.get("hws_see_grant");
  assert.equal(cookie?.httpOnly, true);
  assert.equal(cookie?.secure, true);
  assert.equal(cookie?.path, `/api/see/public/${slug}`);
  assert.equal((await manifest(w, slug, { "x-see-grant": grant })).body.state, "ok");
  assert.equal((await manifest(w, slug, { Cookie: `hws_see_grant=${grant}` })).body.state, "ok", "cookie path works as well as the header fallback");
  assert.equal((await publicFile(w, slug, models[0], { "x-see-grant": grant })).status, 200);

  // The grant is bound to its publication; another publication's link does not accept it.
  const other = await createZarges(w);
  const otherSlug = (await publish(w, other.projectId, { action: "publish", mode: "pin" })).body.project.publication!.shareSlug;
  assert.equal((await manifest(w, otherSlug, { "x-see-grant": grant })).status, 401);

  // New PIN: old grant and old PIN stop working immediately, the new PIN works.
  const renewed = await publish(w, projectId, { action: "new-pin" });
  const newPin = renewed.body.pin!;
  assert.notEqual(newPin, pin);
  assert.equal((await manifest(w, slug, { "x-see-grant": grant })).status, 401);
  assert.equal((await unlock(w, slug, pin, "198.51.100.99")).status, 401);
  assert.equal((await unlock(w, slug, newPin, "198.51.100.99")).status, 200);

  // Grants expire.
  const fresh = (await unlock(w, slug, newPin, "198.51.100.50")).body.grant!;
  w.clock.now = new Date(w.clock.now.getTime() + 121 * 60_000);
  const expired = await manifest(w, slug, { "x-see-grant": fresh });
  assert.deepEqual(expired.body, { state: "pin-required", reason: "expired" });
});

test("HWS SEE: wrong PINs are rate limited per client and the PIN is never stored in plain text", async () => {
  const w = world();
  const { projectId } = await createZarges(w);
  const published = await publish(w, projectId, { action: "publish", mode: "pin", pin: "12345678" });
  assert.equal(published.body.pin, "12345678");
  const slug = published.body.project.publication!.shareSlug;
  for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await unlock(w, slug, "87654321", "192.0.2.1")).status, 401);
  const blocked = await unlock(w, slug, "12345678", "192.0.2.1");
  assert.equal(blocked.status, 429, "even the right PIN is refused while the client is locked out");
  assert.equal(blocked.response.headers.get("retry-after"), "900");
  assert.equal((await unlock(w, slug, "12345678", "192.0.2.2")).status, 200, "other clients are unaffected");
  w.clock.now = new Date(w.clock.now.getTime() + 16 * 60_000);
  assert.equal((await unlock(w, slug, "12345678", "192.0.2.1")).status, 200, "lockout ends after the window");

  const publication = await w.repository.getPublicationBySlug(slug);
  assert.match(publication!.pinHash!, /^pbkdf2_sha256\$100000\$/u);
  assert.equal(JSON.stringify(publication).includes("12345678"), false);
  assert.equal((await publish(w, projectId, { action: "new-pin", pin: "1234" })).status, 400, "short PINs are refused");
  assert.equal((await publish(w, projectId, { action: "set-mode", mode: "password" })).status, 400, "there is no third sharing mode");
});

test("HWS SEE: pause, archive, unpublish, delete and link rotation block page, files and issued content tickets", async () => {
  const w = world({ delivery: "stream" });
  const { projectId, models } = await createZarges(w);
  const slug = (await publish(w, projectId, { action: "publish", mode: "public" })).body.project.publication!.shareSlug;
  const file = await publicFile(w, slug, models[0]);
  assert.match(file.body.url!, /^\/api\/see\/content\?t=/u);
  const contentRequest = () => req(file.body.url!, { auth: false });
  const streamed = await handleSeeContent(await contentRequest(), () => w.deps);
  assert.equal(streamed.status, 200);
  assert.equal(new Uint8Array(await streamed.arrayBuffer())[0], 0x67);

  const status = async (action: string) => (await handleSeeProjectStatus(await req(`/api/see/projects/${projectId}/status`, { method: "POST", body: { action } }), { id: projectId }, () => w.deps)).status;
  assert.equal(await status("pause"), 200);
  assert.deepEqual((await manifest(w, slug)).body, { state: "unavailable", reason: "paused" });
  assert.equal((await publicFile(w, slug, models[0])).status, 403);
  assert.equal((await handleSeeContent(await contentRequest(), () => w.deps)).status, 403, "an already issued URL dies with the pause");
  assert.equal((await publish(w, projectId, { action: "publish" })).status, 409, "a paused project cannot be published");
  assert.equal(await status("resume"), 200);
  assert.equal((await manifest(w, slug)).body.state, "ok");

  assert.equal(await status("archive"), 200);
  assert.deepEqual((await manifest(w, slug)).body, { state: "unavailable", reason: "archived" });
  assert.equal(await status("pause"), 409);
  assert.equal(await status("restore"), 200);

  const rotated = await publish(w, projectId, { action: "rotate-link" });
  const newSlug = rotated.body.project.publication!.shareSlug;
  assert.notEqual(newSlug, slug);
  assert.equal((await manifest(w, slug)).status, 404);
  assert.equal((await manifest(w, newSlug)).body.state, "ok");

  assert.equal((await publish(w, projectId, { action: "unpublish" })).status, 200);
  assert.deepEqual((await manifest(w, newSlug)).body, { state: "unavailable", reason: "unpublished" });

  assert.equal((await publish(w, projectId, { action: "publish" })).status, 200);
  assert.equal(await status("delete"), 200);
  assert.equal((await manifest(w, newSlug)).status, 404);
  assert.equal((await handleSeeProjectGet(await req(`/api/see/projects/${projectId}`), { id: projectId }, () => w.deps)).status, 404);
  const list = await json<{ total: number }>(await handleSeeProjectList(await req("/api/see/projects"), () => w.deps));
  assert.equal(list.total, 0, "soft-deleted projects disappear from Projekty");
});

test("HWS SEE: tampered or expired content tickets are refused; editor preview needs the session", async () => {
  const w = world({ delivery: "stream" });
  const { projectId, models } = await createZarges(w);
  const editor = await handleSeeEditorFile(await req(`/api/see/projects/${projectId}/files/${models[0]}`), { id: projectId, fileId: models[0] }, () => w.deps);
  const url = (await json<{ url: string }>(editor)).url;
  assert.equal((await handleSeeContent(await req(url, { auth: false }), () => w.deps)).status, 200);
  assert.equal((await handleSeeContent(await req(url.replace(/.$/u, (char) => (char === "A" ? "B" : "A")), { auth: false }), () => w.deps)).status, 403);
  w.clock.now = new Date(w.clock.now.getTime() + 61_000);
  assert.equal((await handleSeeContent(await req(url, { auth: false }), () => w.deps)).status, 403);
  assert.equal((await handleSeeEditorFile(await req(`/api/see/projects/${projectId}/files/${models[0]}`, { auth: false }), { id: projectId, fileId: models[0] }, () => w.deps)).status, 401);
});

test("HWS SEE: opens are counted once per visitor window, bots and locked PIN pages are not counted", async () => {
  const w = world();
  const { projectId } = await createZarges(w);
  const slug = (await publish(w, projectId, { action: "publish", mode: "public" })).body.project.publication!.shareSlug;
  const view = async (headers: Record<string, string> = {}) => json<{ counted: boolean }>(await handleSeePublicView(await req(`/api/see/public/${slug}/view`, { method: "POST", auth: false, body: { embed: false }, headers }), { slug }, () => w.deps));
  assert.equal((await view()).counted, true);
  assert.equal((await view()).counted, false, "refresh is not a new open");
  assert.equal((await view({ "user-agent": "Googlebot/2.1" })).counted, false);
  assert.equal((await view({ "x-forwarded-for": "203.0.113.99" })).counted, true);
  const list = await json<{ items: { publication: { viewCount: number } }[] }>(await handleSeeProjectList(await req("/api/see/projects"), () => w.deps));
  assert.equal(list.items[0].publication.viewCount, 2);
  await publish(w, projectId, { action: "set-mode", mode: "pin" });
  assert.equal((await handleSeePublicView(await req(`/api/see/public/${slug}/view`, { method: "POST", auth: false, body: {}, headers: { "x-forwarded-for": "203.0.113.150" } }), { slug }, () => w.deps)).status, 401);
});

test("HWS SEE: a project without uploaded models cannot be published", async () => {
  const w = world();
  const created = await json<{ project: SeeEditorView }>(await handleSeeProjectCreate(await req("/api/see/projects", { method: "POST", body: { name: "Prázdný", scenes: [{ name: "A" }] } }), () => w.deps));
  const result = await publish(w, created.project.project.id, { action: "publish", mode: "public" });
  assert.equal(result.status, 409);
  assert.equal((await handleSeeProjectCreate(await req("/api/see/projects", { method: "POST", body: { name: "  " } }), () => w.deps)).status, 400);
  assert.equal((await handleSeeProjectCreate(await req("/api/see/projects", { method: "POST", body: { name: "Moc", scenes: [{}, {}, {}, {}] } }), () => w.deps)).status, 400);
});
