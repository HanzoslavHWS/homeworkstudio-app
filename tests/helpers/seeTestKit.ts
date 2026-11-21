import assert from "node:assert/strict";
import { NextRequest } from "next/server.js";
import { handleSeeProjectCreate } from "../../app/api/see/projects/route.ts";
import { handleSeeProjectGet } from "../../app/api/see/projects/[id]/route.ts";
import { handleSeeUploadPrepare } from "../../app/api/see/projects/[id]/uploads/route.ts";
import { handleSeeUploadComplete } from "../../app/api/see/projects/[id]/uploads/complete/route.ts";
import { handleSeePublication } from "../../app/api/see/projects/[id]/publication/route.ts";
import { handleSeePublicManifest } from "../../app/api/see/public/[slug]/route.ts";
import { handleSeePublicUnlock } from "../../app/api/see/public/[slug]/unlock/route.ts";
import { handleSeePublicFile } from "../../app/api/see/public/[slug]/files/[fileId]/route.ts";
import { createSessionToken } from "../../lib/auth/session.ts";
import { DEFAULT_SEE_UPLOAD_LIMITS } from "../../domain/seeFiles.ts";
import type { SeeEditorView, SeePublicManifest } from "../../domain/seeViews.ts";
import type { SeeDeps } from "../../lib/see/backend.server.ts";
import { MemorySeeRepository } from "../../lib/see/repository.memory.ts";
import { SeeStorageUnavailableError, type SeeObjectStorage } from "../../lib/see/storage.server.ts";
import type { SeeRepository } from "../../lib/see/repository.ts";

/**
 * Shared kit for the HWS SEE route-handler tests: in-memory repository, an R2 stand-in whose signed
 * URLs really stop working when the object is gone, real GLB bytes, and request helpers.
 * Never touches a live database or bucket.
 */

export const SEE_TEST_SECRET = "hws-see-module-test-session-secret-32+";
(process.env as Record<string, string | undefined>).APP_SESSION_SECRET = SEE_TEST_SECRET;

/** A real (minimal) GLB 2.0: 12-byte header + JSON chunk (+ optional BIN chunk). */
export function makeGlb(json: Record<string, unknown> = { asset: { version: "2.0", generator: "hws-see test" }, scene: 0, scenes: [{ nodes: [] }] }, bin?: Uint8Array): Uint8Array {
  const encoder = new TextEncoder();
  let jsonBytes = encoder.encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  jsonBytes = Uint8Array.from([...jsonBytes, ...new Array<number>(jsonPad).fill(0x20)]);
  const binBytes = bin ? Uint8Array.from([...bin, ...new Array<number>((4 - (bin.length % 4)) % 4).fill(0)]) : undefined;
  const total = 12 + 8 + jsonBytes.length + (binBytes ? 8 + binBytes.length : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set([0x67, 0x6c, 0x54, 0x46], 0);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  if (binBytes) {
    const offset = 20 + jsonBytes.length;
    view.setUint32(offset, binBytes.length, true);
    view.setUint32(offset + 4, 0x004e4942, true);
    out.set(binBytes, offset + 8);
  }
  return out;
}

export const GLB = makeGlb();
export const PDF = new TextEncoder().encode("%PDF-1.7\nfake test document body");
export const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]);

/** In-memory stand-in for R2: presigned URLs are opaque strings, objects are byte arrays. */
export class FakeStorage implements SeeObjectStorage {
  readonly id = "cloudflare-r2" as const;
  readonly prefix = "hws-see";
  supportsSignedDownload = true;
  readonly objects = new Map<string, Uint8Array>();
  readonly signedGets: string[] = [];
  failCopy = false;
  /** Operations currently "down" (R2 / network outage after the SDK retries). */
  readonly outage = new Set<"createUploadUrl" | "head" | "readHead" | "openRead" | "deleteObject" | "copyObject">();
  /** Keys whose delete fails (e.g. the old object after re-keying). */
  readonly failDeleteKeys = new Set<string>();
  /** Copies arrive truncated (to prove the copy is verified before it is used). */
  corruptCopies = false;

  private down(operation: "createUploadUrl" | "head" | "readHead" | "openRead" | "deleteObject" | "copyObject") {
    if (this.outage.has(operation)) throw new SeeStorageUnavailableError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
  }

  async createUploadUrl(input: Readonly<{ storageKey: string; mimeType: string }>) {
    this.down("createUploadUrl");
    return { uploadUrl: `https://r2.test/put/${input.storageKey}`, method: "PUT" as const, headers: { "Content-Type": input.mimeType }, expiresAt: "2026-11-21T12:15:00.000Z" };
  }

  async createDownloadUrl(input: Readonly<{ storageKey: string; expiresInSeconds: number; fileName: string; attachment: boolean }>) {
    this.signedGets.push(input.storageKey);
    return `https://r2.test/get/${input.storageKey}?ttl=${input.expiresInSeconds}&name=${encodeURIComponent(input.fileName)}&attachment=${input.attachment}`;
  }

  /** What R2 would answer for an issued signed GET URL (signature validity is not simulated). */
  fetchSigned(url: string): Readonly<{ status: number; bytes?: Uint8Array }> {
    const key = decodeURIComponent(url.replace("https://r2.test/get/", "").split("?")[0]);
    const bytes = this.objects.get(key);
    return bytes ? { status: 200, bytes } : { status: 404 };
  }

  put(uploadUrl: string, body: Uint8Array) {
    this.objects.set(uploadUrl.replace("https://r2.test/put/", ""), body);
  }

  async head(key: string) {
    this.down("head");
    const body = this.objects.get(key);
    return body ? { contentLength: body.byteLength } : undefined;
  }

  async readHead(key: string, bytes: number) {
    this.down("readHead");
    return this.objects.get(key)?.slice(0, bytes);
  }

  /** Streams in 16 KB chunks like a real object store (lets tests revoke access mid-download). */
  async openRead(key: string) {
    this.down("openRead");
    const body = this.objects.get(key);
    if (!body) return undefined;
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= body.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(body.slice(offset, offset + 16_384));
        offset += 16_384;
      },
    }, { highWaterMark: 0 });
    return { body: stream, contentLength: body.byteLength };
  }

  async deleteObject(key: string) {
    this.down("deleteObject");
    if (this.failDeleteKeys.has(key)) throw new SeeStorageUnavailableError(new Error("delete failed"));
    this.objects.delete(key);
  }

  async copyObject(fromKey: string, toKey: string) {
    this.down("copyObject");
    if (this.failCopy) throw new Error("copy failed");
    const body = this.objects.get(fromKey);
    if (!body) throw new Error("NoSuchKey");
    this.objects.set(toKey, this.corruptCopies ? body.slice(0, Math.max(1, body.length - 1)) : body);
  }
}

/**
 * Wraps a repository so that one method fails on its N-th call. `committed: true` simulates a write
 * that reached the database but whose response was lost (timeout after commit).
 */
export function failingRepository(inner: SeeRepository, failure: Readonly<{ method: keyof SeeRepository; onCall: number; committed?: boolean }>): SeeRepository {
  let calls = 0;
  return new Proxy(inner, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== failure.method || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
      return async (...args: unknown[]) => {
        calls += 1;
        if (calls !== failure.onCall) return value.apply(target, args);
        if (failure.committed) await value.apply(target, args);
        throw Object.assign(new Error("database connection lost"), { code: "ECONNRESET" });
      };
    },
  });
}

/** Invariant: every usable file record points at an object that really exists. */
export async function danglingFiles(w: World, projectId: string): Promise<readonly string[]> {
  const aggregate = await w.repository.getAggregate(projectId);
  return (aggregate?.files ?? []).filter((file) => file.status === "ready" && !w.storage.objects.has(file.storageKey)).map((file) => file.id);
}

export type World = { deps: SeeDeps; storage: FakeStorage; repository: MemorySeeRepository; clock: { now: Date } };

export function world(overrides: Partial<SeeDeps> = {}): World {
  const clock = { now: new Date("2026-11-21T12:00:00.000Z") };
  const repository = new MemorySeeRepository({ now: () => clock.now });
  const storage = new FakeStorage();
  const deps: SeeDeps = {
    repository, storage, secret: SEE_TEST_SECRET, now: () => clock.now, limits: DEFAULT_SEE_UPLOAD_LIMITS,
    backend: "supabase", delivery: "signed-url", fileUrlTtlSeconds: 60, uploadUrlTtlSeconds: 900,
    rekeyOnRevoke: true, streamRecheckMs: 3000,
    grantTtlMinutes: 120, pinIterations: 100_000, failedPinDelayMs: 0, secureCookies: true, ...overrides,
  };
  return { deps, storage, repository, clock };
}

let sessionCookie = "";
export async function session() {
  sessionCookie ||= `homeworkstudio_session=${await createSessionToken(SEE_TEST_SECRET)}`;
  return sessionCookie;
}

export type RequestInitLite = Readonly<{ method?: string; body?: unknown; auth?: boolean; headers?: Record<string, string>; rawBody?: string }>;

export async function req(path: string, init: RequestInitLite = {}) {
  const headers: Record<string, string> = { "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/130", "x-forwarded-for": "203.0.113.7" };
  if (init.auth !== false) headers.Cookie = await session();
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  Object.assign(headers, init.headers);
  const body = init.rawBody ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined);
  return new NextRequest(`http://localhost${path}`, { method: init.method ?? "GET", headers, body });
}

export async function json<T = Record<string, unknown>>(response: Response): Promise<T> {
  return await response.json() as T;
}

export async function uploadFile(w: World, projectId: string, input: Readonly<{ kind: "model" | "document"; fileName: string; mimeType: string; bytes: Uint8Array; sceneId?: string; appliesToAll?: boolean; sceneIds?: string[] }>) {
  const prepared = await handleSeeUploadPrepare(await req(`/api/see/projects/${projectId}/uploads`, { method: "POST", body: { kind: input.kind, fileName: input.fileName, mimeType: input.mimeType, sizeBytes: input.bytes.byteLength, appliesToAll: input.appliesToAll, sceneIds: input.sceneIds } }), { id: projectId }, () => w.deps);
  assert.equal(prepared.status, 201, JSON.stringify(await prepared.clone().json()));
  const { file, upload } = await json<{ file: { id: string; storageKey?: string }; upload: { uploadUrl: string } }>(prepared);
  assert.equal(file.storageKey, undefined, "storage key never reaches the browser");
  w.storage.put(upload.uploadUrl, input.bytes);
  const completed = await handleSeeUploadComplete(await req(`/api/see/projects/${projectId}/uploads/complete`, { method: "POST", body: { fileId: file.id, sceneId: input.sceneId } }), { id: projectId }, () => w.deps);
  return { response: completed, fileId: file.id };
}

/** The acceptance scenario of SPEC.md section 10, steps 2–4, through the real route handlers. */
export async function createZarges(w: World, name = "ZARGES 40863") {
  const created = await handleSeeProjectCreate(await req("/api/see/projects", { method: "POST", body: { name, description: "Přepravní bedna", scenes: [{ name: "Zavřená bedna" }, { name: "Otevřená bedna" }, { name: "Pohled dovnitř" }] } }), () => w.deps);
  assert.equal(created.status, 201);
  const project = (await json<{ project: SeeEditorView }>(created)).project;
  const [closed, open, inside] = project.scenes;
  const models: string[] = [];
  for (const [scene, fileName] of [[closed, "closed.glb"], [open, "open.glb"], [inside, "inside.glb"]] as const) {
    const result = await uploadFile(w, project.project.id, { kind: "model", fileName, mimeType: "model/gltf-binary", bytes: GLB, sceneId: scene.id });
    assert.equal(result.response.status, 200, JSON.stringify(await result.response.clone().json()));
    models.push(result.fileId);
  }
  const manual = await uploadFile(w, project.project.id, { kind: "document", fileName: "navod.pdf", mimeType: "application/pdf", bytes: PDF });
  const detail = await uploadFile(w, project.project.id, { kind: "document", fileName: "vnitrni-detail.jpg", mimeType: "image/jpeg", bytes: JPG, appliesToAll: false, sceneIds: [inside.id] });
  assert.equal(manual.response.status, 200);
  assert.equal(detail.response.status, 200);
  const view = (await json<{ project: SeeEditorView }>(await handleSeeProjectGet(await req(`/api/see/projects/${project.project.id}`), { id: project.project.id }, () => w.deps))).project;
  return { view, projectId: project.project.id, closed, open, inside, models, manualId: manual.fileId, detailId: detail.fileId };
}

export function editorBody(view: SeeEditorView, changes: Partial<{ scenes: unknown[]; annotations: unknown[]; files: unknown[] }> = {}) {
  return {
    project: { name: view.project.name, description: view.project.description },
    scenes: changes.scenes ?? view.scenes,
    annotations: changes.annotations ?? view.annotations,
    files: changes.files ?? view.files.map((file) => ({ id: file.id, displayName: file.displayName, appliesToAll: file.appliesToAll, sceneIds: file.sceneIds, sortOrder: file.sortOrder })),
  };
}

export async function publish(w: World, projectId: string, body: Record<string, unknown>) {
  const response = await handleSeePublication(await req(`/api/see/projects/${projectId}/publication`, { method: "POST", body }), { id: projectId }, () => w.deps);
  return { status: response.status, body: await json<{ project: SeeEditorView; pin?: string; error?: string; warning?: string }>(response) };
}

export async function manifest(w: World, slug: string, headers: Record<string, string> = {}) {
  const response = await handleSeePublicManifest(await req(`/api/see/public/${slug}`, { auth: false, headers }), { slug }, () => w.deps);
  return { status: response.status, body: await json<SeePublicManifest & { title?: string }>(response), response };
}

export async function publicFile(w: World, slug: string, fileId: string, headers: Record<string, string> = {}, download = false) {
  const response = await handleSeePublicFile(await req(`/api/see/public/${slug}/files/${fileId}${download ? "?download=1" : ""}`, { auth: false, headers }), { slug, fileId }, () => w.deps);
  return { status: response.status, body: await json<{ url?: string }>(response) };
}

export async function unlock(w: World, slug: string, pin: string, ip = "198.51.100.20") {
  const response = await handleSeePublicUnlock(await req(`/api/see/public/${slug}/unlock`, { method: "POST", auth: false, body: { pin }, headers: { "x-forwarded-for": ip } }), { slug }, () => w.deps);
  return { status: response.status, body: await json<{ grant?: string; error?: string }>(response), response };
}
