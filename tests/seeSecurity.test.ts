import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server.js";
import { launcherApps } from "../data/launcherApps.ts";
import { createSeeStorageKey, isSeeStorageKey, magicBytesMatch, readSeeUploadLimits, validateSeeUpload } from "../domain/seeFiles.ts";
import { buildSnapshot, documentsForScene, nextProjectStatus, normalizeSceneSettings, SEE_PUBLICATION_MODES } from "../domain/seeProject.ts";
import { embedSnippet, invitationTexts } from "../domain/seeViews.ts";
import { createSessionToken } from "../lib/auth/session.ts";
import { isLocalSeeBackend } from "../lib/see/backend.server.ts";
import { embedFrameAncestors, seePublicRouteKind, seeResponseHeaders } from "../lib/see/proxyRules.ts";
import { generatePin, generateShareSlug, hashPin, isValidPinFormat, signTicket, verifyPin, verifyTicket } from "../lib/see/security.server.ts";
import { proxy } from "../proxy.ts";

const SECRET = "hws-see-security-test-session-secret-32";
(process.env as Record<string, string | undefined>).APP_SESSION_SECRET = SECRET;

test("HWS SEE: exactly two publication modes exist — public and pin", () => {
  assert.deepEqual([...SEE_PUBLICATION_MODES], ["public", "pin"]);
  const migration = readFileSync(new URL("../supabase/migrations/20261121120000_hws_see.sql", import.meta.url), "utf8").replace(/--.*$/gmu, "");
  assert.match(migration, /check \(mode in \('public', 'pin'\)\)/u);
  assert.doesNotMatch(migration, /password/iu);
  assert.match(migration, /see_publications_pin_requires_hash/u);
});

test("HWS SEE migration is additive: only new see_* objects, RLS on every table", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261121120000_hws_see.sql", import.meta.url), "utf8").replace(/--.*$/gmu, "");
  const created = [...sql.matchAll(/create table (\w+)/gu)].map((match) => match[1]);
  assert.deepEqual(created, ["see_projects", "see_files", "see_scenes", "see_annotations", "see_file_scene_links", "see_publications", "see_access_grants", "see_pin_attempts", "see_events"]);
  for (const table of created) assert.match(sql, new RegExp(`alter table ${table} enable row level security`, "u"));
  assert.doesNotMatch(sql, /\b(drop|truncate|delete from|alter table (?!see_))/iu);
});

test("HWS SEE PIN: 8-digit CSPRNG PINs, PBKDF2 hash with salt, constant-format verification", async () => {
  const pin = generatePin();
  assert.match(pin, /^\d{8}$/u);
  assert.equal(isValidPinFormat("1234567"), false);
  assert.equal(isValidPinFormat("1234567890123"), false);
  assert.equal(isValidPinFormat("12a45678"), false);
  const first = await hashPin("12345678", 100_000);
  const second = await hashPin("12345678", 100_000);
  assert.notEqual(first, second, "per-PIN random salt");
  assert.doesNotMatch(first, /12345678/u);
  assert.equal(await verifyPin("12345678", first), true);
  assert.equal(await verifyPin("12345679", first), false);
  assert.equal(await verifyPin("12345678", undefined), false);
  assert.equal(await verifyPin("12345678", "pbkdf2_sha256$10$abc$def"), false, "weak iteration counts are never accepted");
  assert.match(await hashPin("12345678"), /^pbkdf2_sha256\$600000\$/u);
});

test("HWS SEE share slug: 32 random base62 characters, no sequential ids", () => {
  const slugs = new Set(Array.from({ length: 200 }, generateShareSlug));
  assert.equal(slugs.size, 200);
  for (const slug of slugs) assert.match(slug, /^[A-Za-z0-9]{32}$/u);
});

test("HWS SEE tickets: signed, expiring, tamper-proof", () => {
  const exp = Date.now() + 60_000;
  const ticket = signTicket({ op: "get", key: "hws-see/o/x.glb", fileId: "f", mime: "model/gltf-binary", exp }, SECRET);
  assert.equal(verifyTicket(ticket, SECRET)?.fileId, "f");
  assert.equal(verifyTicket(ticket, `${SECRET}-other`), undefined);
  assert.equal(verifyTicket(ticket, SECRET, exp + 1), undefined);
  const [body, signature] = ticket.split(".");
  const forged = Buffer.from(JSON.stringify({ op: "get", key: "hws-see/o/y.glb", fileId: "g", mime: "model/gltf-binary", exp })).toString("base64url");
  assert.equal(verifyTicket(`${forged}.${signature}`, SECRET), undefined);
  assert.equal(verifyTicket(`${body}.${signature}.x`, SECRET), undefined);
});

test("HWS SEE uploads: only GLB / PDF / JPG / PNG, magic bytes, opaque keys", () => {
  const limits = readSeeUploadLimits({ SEE_MAX_MODEL_MB: "10", SEE_MAX_DOCUMENT_MB: "abc" });
  assert.equal(limits.maxModelBytes, 10_000_000);
  assert.equal(limits.maxDocumentBytes, 50_000_000);
  assert.equal(validateSeeUpload({ kind: "model", fileName: "a.GLB", mimeType: "model/gltf-binary", sizeBytes: 5 }, limits).extension, "glb");
  assert.throws(() => validateSeeUpload({ kind: "model", fileName: "a.gltf", mimeType: "model/gltf+json", sizeBytes: 5 }, limits));
  assert.throws(() => validateSeeUpload({ kind: "document", fileName: "../x.pdf", mimeType: "application/pdf", sizeBytes: 5 }, limits));
  assert.throws(() => validateSeeUpload({ kind: "document", fileName: "x.svg", mimeType: "image/svg+xml", sizeBytes: 5 }, limits));
  assert.equal(magicBytesMatch("model/gltf-binary", new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0])), true);
  assert.equal(magicBytesMatch("model/gltf-binary", new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 0, 0, 0])), false, "glTF 1.0 binary is not supported");
  assert.equal(magicBytesMatch("image/png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), true);
  assert.equal(magicBytesMatch("application/pdf", new TextEncoder().encode("<html>")), false);
  const key = createSeeStorageKey("hws-see", "glb", "3f0a8c4e-1b2d-4c5e-8f9a-0b1c2d3e4f5a");
  assert.equal(key, "hws-see/o/3f0a8c4e-1b2d-4c5e-8f9a-0b1c2d3e4f5a.glb");
  assert.equal(isSeeStorageKey(key, "hws-see"), true);
  assert.equal(isSeeStorageKey("projects/x/documents/a.pdf", "hws-see"), false);
  assert.equal(isSeeStorageKey("hws-see/o/../../a.glb", "hws-see"), false);
});

test("HWS SEE domain: status transitions, settings normalization, per-scene documents, snapshot", () => {
  assert.equal(nextProjectStatus("active", "pause"), "paused");
  assert.equal(nextProjectStatus("paused", "resume"), "active");
  assert.equal(nextProjectStatus("archived", "pause"), undefined);
  assert.equal(nextProjectStatus("deleted", "restore"), undefined);
  const settings = normalizeSceneSettings({ camera: { position: [1, 2, 3], target: [0, 0, 0], fov: 500 }, background: "neon", exposure: 99, extra: "<script>" });
  assert.deepEqual(settings, { camera: { position: [1, 2, 3], target: [0, 0, 0], fov: 45 }, background: "studio", backgroundColor: "#e9ebee", lighting: "studio", exposure: 3, showAnnotations: true });
  const docs = [{ id: "all", appliesToAll: true, sceneIds: [] }, { id: "inside", appliesToAll: false, sceneIds: ["s3"] }];
  assert.deepEqual(documentsForScene(docs, "s1").map((doc) => doc.id), ["all"]);
  assert.deepEqual(documentsForScene(docs, "s3").map((doc) => doc.id), ["all", "inside"]);
  const at = "2026-11-21T00:00:00.000Z";
  const base = { createdAt: at, updatedAt: at };
  const snapshot = buildSnapshot({
    project: { id: "p", name: "P", description: "", status: "active", ...base },
    scenes: [{ id: "s1", projectId: "p", name: "A", description: "", sortOrder: 0, modelFileId: "m1", settings, ...base }, { id: "s2", projectId: "p", name: "Bez modelu", description: "", sortOrder: 1, settings, ...base }],
    annotations: [{ id: "a1", sceneId: "s1", title: "T", body: "", position: [0, 0, 0], visible: true, sortOrder: 0, ...base }, { id: "a2", sceneId: "s1", title: "Skrytý", body: "", position: [0, 0, 0], visible: false, sortOrder: 1, ...base }],
    files: [
      { id: "m1", projectId: "p", kind: "model", displayName: "m", originalFileName: "m.glb", mimeType: "model/gltf-binary", sizeBytes: 1, storageKey: "k1", status: "ready", appliesToAll: true, sceneIds: [], sortOrder: 0, ...base },
      { id: "d1", projectId: "p", kind: "document", displayName: "d", originalFileName: "d.pdf", mimeType: "application/pdf", sizeBytes: 1, storageKey: "k2", status: "pending", appliesToAll: true, sceneIds: [], sortOrder: 1, ...base },
    ],
  }, 1, at);
  assert.deepEqual(snapshot.scenes.map((scene) => scene.id), ["s1"], "scenes without a model are not published");
  assert.deepEqual(snapshot.scenes[0].annotations.map((annotation) => annotation.id), ["a1"], "inactive annotations are not published");
  assert.equal(snapshot.documents.length, 0, "unverified uploads are not published");
  assert.equal(JSON.stringify(snapshot).includes("k1"), false, "snapshot never contains storage keys");
});

test("HWS SEE copy texts: link and PIN are separate; embed snippet is sanitized", () => {
  const texts = invitationTexts({ projectName: "ZARGES", url: "https://app.example/see/p/abc", mode: "pin", pin: "12345678" });
  assert.equal(texts.link.includes("12345678"), false);
  assert.match(texts.pin!, /12345678/u);
  const snippet = embedSnippet({ url: "https://app.example/see/embed/abc", width: "100%", height: "650\"><script>", title: "A<b>" });
  assert.match(snippet, /height:650px/u);
  assert.doesNotMatch(snippet, /<script>|<b>/u);
  assert.match(embedSnippet({ url: "u", width: "800", height: "60vh", title: "t" }), /width:800px;height:60vh/u);
});

test("HWS SEE proxy rules: only share-link routes are public, admin is never framed", () => {
  const slug = "Ab3".repeat(11).slice(0, 32);
  assert.equal(seePublicRouteKind(`/see/p/${slug}`), "page");
  assert.equal(seePublicRouteKind(`/see/embed/${slug}`), "embed");
  assert.equal(seePublicRouteKind(`/api/see/public/${slug}`), "api");
  assert.equal(seePublicRouteKind(`/api/see/public/${slug}/unlock`), "api");
  assert.equal(seePublicRouteKind(`/api/see/public/${slug}/files/3f0a8c4e-1b2d-4c5e-8f9a-0b1c2d3e4f5a`), "api");
  assert.equal(seePublicRouteKind("/api/see/content"), "content");
  assert.equal(seePublicRouteKind("/see/draco/draco_decoder.wasm"), "asset");
  for (const privatePath of ["/see", "/see/new", "/see/projects", "/see/projects/abc", "/api/see/projects", `/api/see/public/${slug}/admin`, "/see/p/short", `/see/p/${slug}/../../projects`, "/api/see/dev-storage", "/abf", "/api/projects/list"]) {
    assert.equal(seePublicRouteKind(privatePath), undefined, privatePath);
  }
  assert.equal(seeResponseHeaders("/abf", {}), undefined, "ABF responses are untouched");
  assert.equal(seeResponseHeaders("/see/projects", {})?.["X-Frame-Options"], "DENY");
  assert.equal(seeResponseHeaders(`/see/embed/${slug}`, {})?.["Content-Security-Policy"], "frame-ancestors 'self' https:");
  assert.equal(seeResponseHeaders(`/see/p/${slug}`, {})?.["X-Robots-Tag"]?.includes("noindex"), true);
  assert.equal(embedFrameAncestors("https://www.homeworkstudio.cz https://*.zakaznik.cz javascript:alert(1) *"), "https://www.homeworkstudio.cz https://*.zakaznik.cz");
});

test("HWS SEE proxy: public routes pass without login, editor routes still require the portal session", async () => {
  const slug = "Zx9".repeat(11).slice(0, 32);
  const anonymous = (path: string) => proxy(new NextRequest(`http://localhost${path}`));
  const publicPage = await anonymous(`/see/p/${slug}`);
  assert.equal(publicPage.headers.get("x-middleware-next"), "1");
  assert.match(publicPage.headers.get("x-robots-tag") ?? "", /noindex/u);
  assert.equal((await anonymous(`/api/see/public/${slug}/unlock`)).headers.get("x-middleware-next"), "1");
  const editor = await anonymous("/see/projects");
  assert.equal(editor.status, 307);
  assert.match(editor.headers.get("location") ?? "", /\/login\?next=%2Fsee%2Fprojects/u);
  assert.equal((await anonymous("/api/see/projects")).status, 401);
  assert.equal((await anonymous("/abf")).status, 307, "ABF keeps its login gate");
  const token = await createSessionToken(SECRET);
  const loggedIn = await proxy(new NextRequest("http://localhost/see/projects", { headers: { Cookie: `homeworkstudio_session=${token}` } }));
  assert.equal(loggedIn.headers.get("x-middleware-next"), "1");
  assert.equal(loggedIn.headers.get("x-frame-options"), "DENY");
});

test("HWS SEE local dev backend is never active in production", () => {
  assert.equal(isLocalSeeBackend({ SEE_BACKEND: "local", NODE_ENV: "development" }), true);
  assert.equal(isLocalSeeBackend({ SEE_BACKEND: "local", NODE_ENV: "production" }), false);
  assert.equal(isLocalSeeBackend({ NODE_ENV: "development" }), false);
});

test("launcher: HWS SEE card sits next to HWS Easy, opens /see and carries the hws_see entitlement", () => {
  const ids = launcherApps.map((app) => app.id);
  assert.equal(ids.indexOf("hws-see"), ids.indexOf("hws-easy") + 1);
  const see = launcherApps.find((app) => app.id === "hws-see");
  assert.equal(see?.title, "HWS SEE");
  assert.equal(see?.route, "/see");
  assert.equal(see?.status, "ready");
  assert.equal(see?.enabled, true);
  assert.equal(see?.entitlement, "hws_see");
});
