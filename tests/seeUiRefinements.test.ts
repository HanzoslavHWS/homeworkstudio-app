import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { handleSeeProjectCreate } from "../app/api/see/projects/route.ts";
import { handleSeeProjectGet, handleSeeProjectSave } from "../app/api/see/projects/[id]/route.ts";
import { easeInOutCubic, presetDirection, presetView, SEE_VIEW_PRESET_LABELS_CS, SEE_VIEW_PRESETS } from "../domain/seeCameraFit.ts";
import {
  EMPTY_PROJECT_INFO_PANEL, linkProblem, normalizeInfoPanelContent, normalizeProjectInfoPanel, parseRichText, renderableUrl, resolveInfoPanel, safeExternalUrl,
} from "../domain/seeContent.ts";
import { DEFAULT_SEE_UPLOAD_LIMITS, magicBytesMatch, readSeeUploadLimits, validateSeeUpload } from "../domain/seeFiles.ts";
import { buildSnapshot, documentsForScene, SEE_MAX_SCENES, snapshotReferencesFile } from "../domain/seeProject.ts";
import { seePrefetchOrder } from "../domain/seeViewerProfile.ts";
import type { SeeEditorView } from "../domain/seeViews.ts";
import {
  createZarges, editorBody, GLB, json, JPG, manifest, PDF, PNG, publicFile, publish, req, unlock, uploadFile, WEBP, world, type World,
} from "./helpers/seeTestKit.ts";

/**
 * HWS SEE UI refinements (tools/hws-see/HWS_SEE_UI_UPRAVY.md): any number of models, reorder and
 * delete with explicit document links, optional info panel (closed by default, PIN-protected),
 * annotation picture + safe link, quick camera views. Route handlers only; never a live service.
 */

const ALL_LOCAL = { allowLocalHttp: true } as const;
const PRODUCTION = { allowLocalHttp: false } as const;

async function getView(w: World, projectId: string) {
  return (await json<{ project: SeeEditorView }>(await handleSeeProjectGet(await req(`/api/see/projects/${projectId}`), { id: projectId }, () => w.deps))).project;
}

async function save(w: World, projectId: string, body: Record<string, unknown>) {
  const response = await handleSeeProjectSave(await req(`/api/see/projects/${projectId}`, { method: "PUT", body }), { id: projectId }, () => w.deps);
  return { status: response.status, body: await json<{ project: SeeEditorView; error?: string }>(response) };
}

function newScene(name: string) {
  return { id: crypto.randomUUID(), name, description: "", settings: {} };
}

async function uploadImage(w: World, projectId: string, fileName = "detail.webp", bytes: Uint8Array = WEBP, mimeType = "image/webp") {
  const result = await uploadFile(w, projectId, { kind: "image", fileName, mimeType, bytes });
  assert.equal(result.response.status, 200, JSON.stringify(await result.response.clone().json()));
  return result.fileId;
}

const sceneBody = (view: SeeEditorView, scenes = view.scenes) => scenes.map((scene) => ({ id: scene.id, name: scene.name, description: scene.description, modelFileId: scene.modelFileId ?? null, settings: scene.settings }));

// ───────────────────────── A. Any number of models ─────────────────────────

test("UI: a project starts with ONE model and grows 1 → 2 → 5 through the editor, each with its own GLB", async () => {
  const w = world();
  const created = await handleSeeProjectCreate(await req("/api/see/projects", { method: "POST", body: { name: "Výstava", scenes: [{ name: "Hlavní" }] } }), () => w.deps);
  assert.equal(created.status, 201);
  let view = (await json<{ project: SeeEditorView }>(created)).project;
  const projectId = view.project.id;
  assert.equal(view.scenes.length, 1);

  for (const target of [2, 5]) {
    const extra = Array.from({ length: target - view.scenes.length }, (_, index) => newScene(`Model ${view.scenes.length + index + 1}`));
    const saved = await save(w, projectId, editorBody(view, { scenes: [...sceneBody(view), ...extra] }));
    assert.equal(saved.status, 200, saved.body.error);
    view = saved.body.project;
    assert.equal(view.scenes.length, target);
  }
  for (const scene of view.scenes) {
    const upload = await uploadFile(w, projectId, { kind: "model", fileName: `${scene.name}.glb`, mimeType: "model/gltf-binary", bytes: GLB, sceneId: scene.id });
    assert.equal(upload.response.status, 200);
  }
  view = await getView(w, projectId);
  assert.deepEqual(view.scenes.map((scene) => scene.name), ["Hlavní", "Model 2", "Model 3", "Model 4", "Model 5"]);
  assert.ok(view.scenes.every((scene) => scene.modelFileId), "every model has its own GLB");
  assert.equal(new Set(view.scenes.map((scene) => scene.modelFileId)).size, 5);

  const slug = (await publish(w, projectId, { action: "publish", mode: "public" })).body.project.publication!.shareSlug;
  const published = await manifest(w, slug);
  assert.equal(published.body.state, "ok");
  if (published.body.state === "ok") assert.equal(published.body.scenes.length, 5);
});

test("UI: no product limit of three — a seven-model project publishes; only the technical ceiling is enforced", async () => {
  const w = world();
  const names = Array.from({ length: 7 }, (_, index) => ({ name: `Varianta ${index + 1}` }));
  const created = await handleSeeProjectCreate(await req("/api/see/projects", { method: "POST", body: { name: "Sedm variant", scenes: names } }), () => w.deps);
  assert.equal(created.status, 201);
  const view = (await json<{ project: SeeEditorView }>(created)).project;
  for (const scene of view.scenes) await uploadFile(w, view.project.id, { kind: "model", fileName: "m.glb", mimeType: "model/gltf-binary", bytes: GLB, sceneId: scene.id });
  const slug = (await publish(w, view.project.id, { action: "publish", mode: "public" })).body.project.publication!.shareSlug;
  const published = await manifest(w, slug);
  assert.equal(published.body.state === "ok" && published.body.scenes.length, 7);

  assert.ok(SEE_MAX_SCENES >= 50, "the ceiling is a technical safety limit, not a product limit");
  const tooMany = await save(w, view.project.id, editorBody(await getView(w, view.project.id), { scenes: Array.from({ length: SEE_MAX_SCENES + 1 }, (_, index) => newScene(`M${index}`)) }));
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.error ?? "", new RegExp(`nejvýše ${SEE_MAX_SCENES}`, "u"));
});

test("UI: no '3' limit is left in the module code, SQL or wizard texts", () => {
  for (const file of ["domain/seeProject.ts", "lib/see/service.server.ts", "components/see/SeeEditor.tsx", "components/see/SeeNewProject.tsx", "supabase/migrations/20261121120000_hws_see.sql"]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /(až|max\.?|nejvýše|up to|at most)\s*3\s*(×|x|modely|models|scén)/iu, file);
    assert.doesNotMatch(source, /SEE_MAX_SCENES\s*=\s*3\b/u, file);
  }
  const migration = readFileSync(new URL("../supabase/migrations/20261121120000_hws_see.sql", import.meta.url), "utf8");
  assert.doesNotMatch(migration, /sort_order\s*(<|<=|between)\s*[0-3]\b/iu, "no SQL check caps the number of scenes");
});

test("UI: reordering keeps scene identity, annotations and document links; public order follows", async () => {
  const w = world();
  const zarges = await createZarges(w);
  const annotation = { id: crypto.randomUUID(), sceneId: zarges.inside.id, title: "Zámek", body: "", position: [0, 0, 0], visible: true };
  let view = (await save(w, zarges.projectId, editorBody(zarges.view, { annotations: [annotation] }))).body.project;
  const reversed = [...view.scenes].reverse();
  const saved = await save(w, zarges.projectId, editorBody(view, { scenes: sceneBody(view, reversed) }));
  assert.equal(saved.status, 200, saved.body.error);
  view = saved.body.project;
  assert.deepEqual(view.scenes.map((scene) => scene.id), [zarges.inside.id, zarges.open.id, zarges.closed.id], "same ids, new order");
  assert.equal(view.annotations.find((entry) => entry.id === annotation.id)?.sceneId, zarges.inside.id);
  assert.deepEqual(view.files.find((file) => file.id === zarges.detailId)?.sceneIds, [zarges.inside.id]);

  const slug = (await publish(w, zarges.projectId, { action: "publish", mode: "public" })).body.project.publication!.shareSlug;
  const published = await manifest(w, slug);
  assert.equal(published.body.state, "ok");
  if (published.body.state !== "ok") return;
  assert.deepEqual(published.body.scenes.map((scene) => scene.name), ["Pohled dovnitř", "Otevřená bedna", "Zavřená bedna"]);
  assert.equal(published.body.scenes[0].annotations[0]?.title, "Zámek");
});

test("UI: deleting a model never deletes shared files; links to it are removed explicitly", async () => {
  const w = world();
  const zarges = await createZarges(w);
  const shared = await uploadFile(w, zarges.projectId, { kind: "document", fileName: "spolecny.pdf", mimeType: "application/pdf", bytes: PDF, appliesToAll: false, sceneIds: [zarges.open.id, zarges.inside.id] });
  assert.equal(shared.response.status, 200);
  const view = await getView(w, zarges.projectId);
  const remaining = view.scenes.filter((scene) => scene.id !== zarges.inside.id);
  const saved = await save(w, zarges.projectId, editorBody(view, { scenes: sceneBody(view, remaining) }));
  assert.equal(saved.status, 200, saved.body.error);
  const files = saved.body.project.files;
  assert.equal(saved.body.project.scenes.length, 2);
  assert.ok(files.some((file) => file.id === zarges.models[2]), "the GLB of the removed model is kept");
  assert.deepEqual(files.find((file) => file.id === zarges.detailId)?.sceneIds, [], "document linked only to the removed model is kept, unassigned");
  assert.deepEqual(files.find((file) => file.id === shared.fileId)?.sceneIds, [zarges.open.id], "other links stay");
  assert.equal(files.find((file) => file.id === zarges.manualId)?.appliesToAll, true);
  const aggregate = (await w.repository.getAggregate(zarges.projectId))!;
  for (const fileId of [zarges.models[2], zarges.detailId, shared.fileId]) {
    const file = aggregate.files.find((entry) => entry.id === fileId)!;
    assert.equal(file.deletedAt, undefined, fileId);
    assert.ok(w.storage.objects.has(file.storageKey), "object kept in storage");
  }
});

test("UI: documents can target ALL models or any chosen subset of five", async () => {
  const w = world();
  const created = await handleSeeProjectCreate(await req("/api/see/projects", { method: "POST", body: { name: "Pět", scenes: [1, 2, 3, 4, 5].map((n) => ({ name: `M${n}` })) } }), () => w.deps);
  const view = (await json<{ project: SeeEditorView }>(created)).project;
  const [m1, , m3, , m5] = view.scenes;
  for (const scene of view.scenes) await uploadFile(w, view.project.id, { kind: "model", fileName: "m.glb", mimeType: "model/gltf-binary", bytes: GLB, sceneId: scene.id });
  await uploadFile(w, view.project.id, { kind: "document", fileName: "vse.pdf", mimeType: "application/pdf", bytes: PDF });
  await uploadFile(w, view.project.id, { kind: "document", fileName: "liche.pdf", mimeType: "application/pdf", bytes: PDF, appliesToAll: false, sceneIds: [m1.id, m3.id, m5.id] });
  const slug = (await publish(w, view.project.id, { action: "publish", mode: "public" })).body.project.publication!.shareSlug;
  const published = await manifest(w, slug);
  assert.equal(published.body.state, "ok");
  if (published.body.state !== "ok") return;
  const { documents } = published.body;
  const names = (sceneId: string) => documentsForScene(documents, sceneId).map((document) => document.displayName).sort();
  assert.deepEqual(names(m1.id), ["liche", "vse"]);
  assert.deepEqual(names(view.scenes[1].id), ["vse"]);
  assert.deepEqual(names(m5.id), ["liche", "vse"]);
});

test("UI: existing 1–3 model projects (saved before this change) keep working unchanged", async () => {
  const w = world();
  const zarges = await createZarges(w);
  // Old editor payload: no infoPanel, annotations without picture/link fields.
  const old = editorBody(zarges.view, { annotations: [{ id: crypto.randomUUID(), sceneId: zarges.closed.id, title: "Starý popisek", body: "text", position: [1, 2, 3], visible: true }] });
  const saved = await save(w, zarges.projectId, old);
  assert.equal(saved.status, 200, saved.body.error);
  assert.deepEqual(saved.body.project.project.infoPanel ?? EMPTY_PROJECT_INFO_PANEL, EMPTY_PROJECT_INFO_PANEL);
  const slug = (await publish(w, zarges.projectId, { action: "publish", mode: "public" })).body.project.publication!.shareSlug;
  const published = await manifest(w, slug);
  assert.equal(published.body.state, "ok");
  if (published.body.state !== "ok") return;
  assert.equal(published.body.scenes.length, 3);
  assert.equal(published.body.infoPanel, undefined, "no panel unless switched on");
  const annotation = published.body.scenes[0].annotations[0];
  assert.equal(annotation.title, "Starý popisek");
  assert.equal(annotation.imageFileId, undefined);
  assert.equal(annotation.linkUrl, undefined);
});

// ───────────────────────── E. Information panel ─────────────────────────

test("UI panel: normalization, fallback rule and 'disabled hides the trigger'", () => {
  const project = normalizeProjectInfoPanel({ enabled: true, title: " Projekt ", body: "Text", links: [{ label: "", url: "https://hws.cz/a" }, { label: "zlý", url: "javascript:alert(1)" }] }, PRODUCTION);
  assert.equal(project.title, "Projekt");
  assert.deepEqual(project.links, [{ label: "Více informací", url: "https://hws.cz/a" }], "unsafe stored links are dropped");
  const override = normalizeInfoPanelContent({ title: "Model", body: "", links: [] }, PRODUCTION)!;
  assert.equal(resolveInfoPanel(project, override)?.title, "Model", "non-empty model content wins");
  assert.equal(resolveInfoPanel(project, { title: "", body: "", links: [] })?.title, "Projekt", "empty override falls back to the project");
  assert.equal(resolveInfoPanel(project, undefined)?.title, "Projekt");
  assert.equal(resolveInfoPanel({ ...project, enabled: false }, override), undefined, "disabled → no panel at all");
  assert.equal(resolveInfoPanel({ ...EMPTY_PROJECT_INFO_PANEL, enabled: true }, undefined), undefined, "enabled but empty → no trigger");
  assert.equal(normalizeProjectInfoPanel(undefined, PRODUCTION).enabled, false, "new projects: panel off");
  assert.equal(normalizeProjectInfoPanel({ title: "x" }, PRODUCTION).enabled, false);
});

test("UI panel: the public viewer starts with the panel closed and has no persisted open state", () => {
  const source = readFileSync(new URL("../components/see/SeePublicViewer.tsx", import.meta.url), "utf8");
  assert.match(source, /const \[infoOpen, setInfoOpen\] = useState\(false\)/u, "closed on every entry");
  assert.doesNotMatch(source, /localStorage|sessionStorage/u, "open state is never restored from storage");
  const controls = readFileSync(new URL("../components/see/SeeViewControls.tsx", import.meta.url), "utf8");
  assert.match(controls, /if \(isPanelContentEmpty\(content\)\) return null;/u, "no trigger without content");
  assert.match(controls, /event\.key === "Escape"/u, "Esc closes");
  assert.doesNotMatch(controls + source, /dangerouslySetInnerHTML/u, "no raw HTML");
});

test("UI panel: project + per-model content is saved, validated strictly and published only when enabled", async () => {
  const w = world();
  const zarges = await createZarges(w);
  const imageId = await uploadImage(w, zarges.projectId);
  const panel = { enabled: false, title: "O expozici", body: "Úvod\n\n- bod **tučně**", imageFileId: imageId, links: [{ label: "Web", url: "https://homeworkstudio.cz/" }] };
  let saved = await save(w, zarges.projectId, { ...editorBody(zarges.view), project: { name: zarges.view.project.name, infoPanel: panel } });
  assert.equal(saved.status, 200, saved.body.error);
  assert.equal(saved.body.project.project.infoPanel?.title, "O expozici");
  assert.equal(saved.body.project.project.infoPanel?.imageFileId, imageId);

  let slug = (await publish(w, zarges.projectId, { action: "publish", mode: "public" })).body.project.publication!.shareSlug;
  let published = await manifest(w, slug);
  assert.equal(published.body.state === "ok" && published.body.infoPanel, undefined, "disabled panel is not published");
  assert.equal((await publicFile(w, slug, imageId)).status, 404, "panel picture of a disabled panel is not reachable");

  const scenes = sceneBody(saved.body.project).map((scene) => (scene.id === zarges.inside.id ? { ...scene, settings: { ...scene.settings, infoPanel: { title: "Vnitřek", body: "Detail", links: [] } } } : scene));
  saved = await save(w, zarges.projectId, { ...editorBody(saved.body.project, { scenes }), project: { name: zarges.view.project.name, infoPanel: { ...panel, enabled: true } } });
  assert.equal(saved.status, 200, saved.body.error);
  slug = (await publish(w, zarges.projectId, { action: "publish", mode: "public" })).body.project.publication!.shareSlug;
  published = await manifest(w, slug);
  assert.equal(published.body.state, "ok");
  if (published.body.state !== "ok") return;
  assert.equal(published.body.infoPanel?.enabled, true);
  assert.equal(published.body.infoPanel?.title, "O expozici");
  const inside = published.body.scenes.find((scene) => scene.id === zarges.inside.id)!;
  assert.equal(resolveInfoPanel(published.body.infoPanel, inside.settings.infoPanel)?.title, "Vnitřek");
  const closed = published.body.scenes.find((scene) => scene.id === zarges.closed.id)!;
  assert.equal(resolveInfoPanel(published.body.infoPanel, closed.settings.infoPanel)?.title, "O expozici");
  assert.equal((await publicFile(w, slug, imageId)).status, 200, "enabled panel picture is served");

  for (const url of ["javascript:alert(1)", "data:text/html,x", "http://example.com", "https://user:pw@example.com", "ftp://x"]) {
    const bad = await save(w, zarges.projectId, { ...editorBody(saved.body.project), project: { name: "x", infoPanel: { ...panel, enabled: true, links: [{ label: "x", url }] } } });
    assert.equal(bad.status, 400, url);
  }
  const foreignImage = await save(w, zarges.projectId, { ...editorBody(saved.body.project), project: { name: "x", infoPanel: { ...panel, imageFileId: zarges.manualId } } });
  assert.equal(foreignImage.status, 400, "a document is not accepted as a panel picture");
});

test("UI panel: content and pictures stay behind the PIN and die with revocation", async () => {
  const w = world();
  const zarges = await createZarges(w);
  const imageId = await uploadImage(w, zarges.projectId);
  const secretTitle = "Tajný obsah panelu";
  const saved = await save(w, zarges.projectId, { ...editorBody(zarges.view), project: { name: zarges.view.project.name, infoPanel: { enabled: true, title: secretTitle, body: "x", imageFileId: imageId, links: [] } } });
  assert.equal(saved.status, 200, saved.body.error);
  const published = await publish(w, zarges.projectId, { action: "publish", mode: "pin" });
  const { shareSlug: slug } = published.body.project.publication!;
  const locked = await manifest(w, slug);
  assert.deepEqual(locked.body, { state: "pin-required" });
  assert.equal(JSON.stringify(locked.body).includes(secretTitle), false);
  assert.equal((await publicFile(w, slug, imageId)).status, 401, "no picture without a grant");

  const grant = (await unlock(w, slug, published.body.pin!)).body.grant!;
  const open = await manifest(w, slug, { "x-see-grant": grant });
  assert.equal(open.body.state === "ok" && open.body.infoPanel?.title, secretTitle);
  const url = (await publicFile(w, slug, imageId, { "x-see-grant": grant })).body.url!;
  assert.equal(w.storage.fetchSigned(url).status, 200);

  await publish(w, zarges.projectId, { action: "new-pin" });
  assert.equal(w.storage.fetchSigned(url).status, 404, "issued picture URL is dead after a new PIN");
  assert.equal((await publicFile(w, slug, imageId, { "x-see-grant": grant })).status, 401, "old grant no longer works");
});

// ───────────────────────── F. Annotation picture + link ─────────────────────────

test("UI annotations: picture (JPG/PNG/WebP) and safe link are saved and published", async () => {
  const w = world();
  const zarges = await createZarges(w);
  const webp = await uploadImage(w, zarges.projectId);
  const png = await uploadImage(w, zarges.projectId, "plan.png", PNG, "image/png");
  const jpg = await uploadImage(w, zarges.projectId, "foto.jpg", JPG, "image/jpeg");
  const annotations = [
    { id: crypto.randomUUID(), sceneId: zarges.closed.id, title: "S obrázkem", body: "", position: [0, 0, 0], visible: true, imageFileId: webp, linkUrl: "https://homeworkstudio.cz/produkt", linkLabel: "" },
    { id: crypto.randomUUID(), sceneId: zarges.open.id, title: "PNG", body: "", position: [0, 1, 0], visible: true, imageFileId: png, linkUrl: "", linkLabel: "" },
    { id: crypto.randomUUID(), sceneId: zarges.inside.id, title: "JPG", body: "", position: [1, 0, 0], visible: true, imageFileId: jpg, linkUrl: "https://example.com/a b", linkLabel: "Katalog" },
  ];
  const saved = await save(w, zarges.projectId, editorBody(zarges.view, { annotations }));
  assert.equal(saved.status, 200, saved.body.error);
  const stored = saved.body.project.annotations.find((entry) => entry.title === "S obrázkem")!;
  assert.equal(stored.imageFileId, webp);
  assert.equal(stored.linkUrl, "https://homeworkstudio.cz/produkt");
  assert.equal(stored.linkLabel, "Více informací", "default label");
  assert.equal(saved.body.project.annotations.find((entry) => entry.title === "JPG")?.linkUrl, "https://example.com/a%20b", "normalized URL");
  assert.equal(saved.body.project.annotations.find((entry) => entry.title === "PNG")?.linkUrl, undefined, "link is optional");

  const slug = (await publish(w, zarges.projectId, { action: "publish", mode: "public" })).body.project.publication!.shareSlug;
  const published = await manifest(w, slug);
  assert.equal(published.body.state, "ok");
  if (published.body.state !== "ok") return;
  const first = published.body.scenes.find((scene) => scene.id === zarges.closed.id)!.annotations[0];
  assert.equal(first.imageFileId, webp);
  assert.equal(first.linkUrl, "https://homeworkstudio.cz/produkt");
  for (const fileId of [webp, png, jpg]) assert.equal((await publicFile(w, slug, fileId)).status, 200, fileId);
});

test("UI annotations: unsafe links, foreign or missing pictures are rejected with 400", async () => {
  const w = world();
  const zarges = await createZarges(w);
  const base = { id: crypto.randomUUID(), sceneId: zarges.closed.id, title: "A", body: "", position: [0, 0, 0], visible: true };
  for (const linkUrl of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html;base64,PHNjcmlwdD4=", "vbscript:x", "http://example.com", "//evil.example", "https://a:b@example.com", "file:///etc/passwd"]) {
    const result = await save(w, zarges.projectId, editorBody(zarges.view, { annotations: [{ ...base, linkUrl }] }));
    assert.equal(result.status, 400, linkUrl);
  }
  for (const imageFileId of [zarges.manualId, zarges.models[0], crypto.randomUUID(), "../../x"]) {
    const result = await save(w, zarges.projectId, editorBody(zarges.view, { annotations: [{ ...base, imageFileId }] }));
    assert.equal(result.status, 400, String(imageFileId));
  }
});

test("UI annotations: http://localhost links only in local development", async () => {
  const dev = world({ allowLocalHttpLinks: true });
  const prod = world({ allowLocalHttpLinks: false });
  for (const [w, expected] of [[dev, 200], [prod, 400]] as const) {
    const zarges = await createZarges(w);
    const result = await save(w, zarges.projectId, editorBody(zarges.view, { annotations: [{ id: crypto.randomUUID(), sceneId: zarges.closed.id, title: "Lokální", body: "", position: [0, 0, 0], visible: true, linkUrl: "http://localhost:3100/x" }] }));
    assert.equal(result.status, expected);
  }
  assert.equal(linkProblem("http://localhost/x", PRODUCTION) !== undefined, true);
  assert.equal(linkProblem("http://127.0.0.1/x", ALL_LOCAL), undefined);
  assert.notEqual(linkProblem("http://192.168.1.5/x", ALL_LOCAL), undefined, "only loopback");
  assert.equal(safeExternalUrl("https://hws.cz", PRODUCTION), "https://hws.cz/");
  assert.equal(renderableUrl("javascript:alert(1)"), undefined, "client refuses to render unsafe stored links");
  const source = readFileSync(new URL("../components/see/SeeMedia.tsx", import.meta.url), "utf8");
  assert.match(source, /target="_blank"/u);
  assert.match(source, /rel="noopener noreferrer"/u);
});

test("UI images: type, size (5 MB) and signature validation; WebP magic bytes", async () => {
  assert.equal(validateSeeUpload({ kind: "image", fileName: "a.webp", mimeType: "image/webp", sizeBytes: 10 }, DEFAULT_SEE_UPLOAD_LIMITS).kind, "image");
  assert.throws(() => validateSeeUpload({ kind: "image", fileName: "a.gif", mimeType: "image/gif", sizeBytes: 10 }, DEFAULT_SEE_UPLOAD_LIMITS), /JPG, PNG nebo WebP/u);
  assert.throws(() => validateSeeUpload({ kind: "image", fileName: "a.svg", mimeType: "image/svg+xml", sizeBytes: 10 }, DEFAULT_SEE_UPLOAD_LIMITS));
  assert.throws(() => validateSeeUpload({ kind: "image", fileName: "a.png", mimeType: "image/png", sizeBytes: 5_000_001 }, DEFAULT_SEE_UPLOAD_LIMITS));
  assert.equal(DEFAULT_SEE_UPLOAD_LIMITS.maxImageBytes, 5_000_000);
  assert.equal(readSeeUploadLimits({ SEE_MAX_IMAGE_MB: "8" }).maxImageBytes, 8_000_000);
  assert.equal(readSeeUploadLimits({ SEE_MAX_IMAGE_MB: "9999" }).maxImageBytes, 20_000_000, "ceiling");
  assert.equal(magicBytesMatch("image/webp", WEBP), true);
  assert.equal(magicBytesMatch("image/webp", new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])), false, "RIFF/WAVE is not WebP");
  assert.equal(magicBytesMatch("image/png", PNG), true);

  const w = world();
  const zarges = await createZarges(w);
  const disguised = await uploadFile(w, zarges.projectId, { kind: "image", fileName: "x.webp", mimeType: "image/webp", bytes: PDF });
  assert.notEqual(disguised.response.status, 200, "a PDF renamed to .webp is refused by its signature");
});

test("UI images: a picture outside the published snapshot is 404, and after deletion it is dropped from the next snapshot", async () => {
  const w = world();
  const zarges = await createZarges(w);
  const used = await uploadImage(w, zarges.projectId);
  const unused = await uploadImage(w, zarges.projectId, "jine.png", PNG, "image/png");
  const annotation = { id: crypto.randomUUID(), sceneId: zarges.closed.id, title: "Obr", body: "", position: [0, 0, 0], visible: true, imageFileId: used };
  const saved = await save(w, zarges.projectId, editorBody(zarges.view, { annotations: [annotation] }));
  assert.equal(saved.status, 200, saved.body.error);
  const slug = (await publish(w, zarges.projectId, { action: "publish", mode: "public" })).body.project.publication!.shareSlug;
  assert.equal((await publicFile(w, slug, used)).status, 200);
  assert.equal((await publicFile(w, slug, unused)).status, 404, "uploaded but never published");

  const aggregate = (await w.repository.getAggregate(zarges.projectId))!;
  assert.equal(snapshotReferencesFile(buildSnapshot(aggregate, 9, "2026-11-21T12:00:00.000Z"), used), "image");
  const removed = aggregate.files.map((file) => (file.id === used ? { ...file, deletedAt: "2026-11-21T12:00:00.000Z" } : file));
  const snapshot = buildSnapshot({ ...aggregate, files: removed }, 10, "2026-11-21T12:00:00.000Z");
  assert.equal(snapshot.scenes[0].annotations[0].imageFileId, undefined, "deleted picture is not published; the annotation remains");
  assert.equal(snapshotReferencesFile(snapshot, used), undefined);
});

test("UI quota: total project size is limited (413) and image counts are capped", async () => {
  const w = world({ limits: { ...DEFAULT_SEE_UPLOAD_LIMITS, maxProjectBytes: GLB.byteLength * 3 + PDF.byteLength + JPG.byteLength + 20 } });
  const zarges = await createZarges(w);
  const prepared = await req(`/api/see/projects/${zarges.projectId}/uploads`, { method: "POST", body: { kind: "image", fileName: "big.png", mimeType: "image/png", sizeBytes: 1000 } });
  const { handleSeeUploadPrepare } = await import("../app/api/see/projects/[id]/uploads/route.ts");
  const response = await handleSeeUploadPrepare(prepared, { id: zarges.projectId }, () => w.deps);
  assert.equal(response.status, 413);
  assert.match((await json<{ error: string }>(response)).error, /celkový limit/u);
});

// ───────────────────────── D. Quick camera views ─────────────────────────

test("UI views: all seven presets exist with Czech names and point the camera at the model from the right side", () => {
  assert.deepEqual([...SEE_VIEW_PRESETS], ["default", "front", "back", "left", "right", "top", "bottom"]);
  for (const preset of SEE_VIEW_PRESETS) assert.ok(SEE_VIEW_PRESET_LABELS_CS[preset].length > 2, preset);
  assert.match(SEE_VIEW_PRESET_LABELS_CS.front, /Přední/u);
  const center = [120, -40, 7] as const;
  const at = (preset: (typeof SEE_VIEW_PRESETS)[number], radius = 2) => presetView(preset, { center, radius, fov: 45, aspect: 16 / 9 });
  const offset = (preset: (typeof SEE_VIEW_PRESETS)[number]) => at(preset).position.map((value, index) => value - center[index]);
  assert.ok(offset("front")[2] > 0 && Math.abs(offset("front")[0]) < 1e-9, "front looks from +Z");
  assert.ok(offset("back")[2] < 0, "back looks from −Z");
  assert.ok(offset("left")[0] < 0 && offset("right")[0] > 0);
  assert.ok(offset("top")[1] > 0 && offset("bottom")[1] < 0);
  for (const preset of SEE_VIEW_PRESETS) assert.deepEqual(at(preset).target, [...center], "always aims at the off-origin model centre");
  for (const radius of [1e-4, 0.05, 2, 5_000, 2e6]) {
    const view = at("front", radius);
    assert.ok(Number.isFinite(view.distance) && view.distance > radius, `radius ${radius}: camera outside the bounding sphere`);
    assert.ok(view.distance < radius * 10 + 10, `radius ${radius}: not absurdly far`);
  }
  assert.ok(presetView("front", { center, radius: 2, fov: 45, aspect: 0.5 }).distance > at("front").distance, "portrait (mobile) needs more distance");
  const top = presetDirection("top");
  assert.ok(Math.abs(top[2]) > 0 && Math.abs(top[2]) < 0.01, "top/bottom avoid the exact pole (no OrbitControls flip)");
});

test("UI views: easing is smooth and clamped", () => {
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(1), 1);
  assert.equal(easeInOutCubic(0.5), 0.5);
  assert.equal(easeInOutCubic(-1), 0);
  assert.equal(easeInOutCubic(2), 1);
  let previous = 0;
  for (let step = 1; step <= 20; step += 1) {
    const value = easeInOutCubic(step / 20);
    assert.ok(value >= previous, "monotonic");
    previous = value;
  }
});

// ───────────────────────── B/C. Icon and dev indicator ─────────────────────────

test("UI: annotation toggle uses the text-label icon with explicit state; no GPS pin; dev indicator hidden", () => {
  const viewer = readFileSync(new URL("../components/see/SeePublicViewer.tsx", import.meta.url), "utf8");
  assert.match(viewer, /Skrýt 3D popisky|Zobrazit 3D popisky/u);
  assert.match(viewer, /aria-pressed/u);
  assert.match(viewer, /seeToggleOn|seeToggleOff/u);
  assert.doesNotMatch(viewer, /map-pin|geolocation|navigator\.geolocation/iu);
  const config = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
  assert.match(config, /devIndicators:\s*false/u);
});

test("UI rich text: paragraphs, lists and bold without any HTML", () => {
  const blocks = parseRichText("Úvod **důležité**\ndruhý řádek\n\n- jedna\n• dvě\n\n<script>alert(1)</script>");
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].type, "paragraph");
  if (blocks[0].type === "paragraph") {
    assert.equal(blocks[0].lines.length, 2);
    assert.deepEqual(blocks[0].lines[0], [{ text: "Úvod ", bold: false }, { text: "důležité", bold: true }]);
  }
  assert.equal(blocks[1].type === "list" && blocks[1].items.length, 2);
  assert.equal(blocks[2].type === "paragraph" && blocks[2].lines[0][0].text, "<script>alert(1)</script>", "kept as plain text, rendered escaped by React");
});

test("UI: with many models the neighbours of the visible model are prefetched first", () => {
  const ids = ["a", "b", "c", "d", "e", "f", "g"];
  assert.deepEqual(seePrefetchOrder(ids, "d"), ["e", "c", "f", "b", "g", "a"]);
  assert.deepEqual(seePrefetchOrder(ids, "a"), ["b", "c", "d", "e", "f", "g"]);
  assert.deepEqual(seePrefetchOrder(["a", "", "a", "b"], undefined), ["a", "b"]);
});
