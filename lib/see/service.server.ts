import { linkProblem, normalizeInfoPanelContent, SEE_DEFAULT_LINK_LABEL, SEE_LINK_LABEL_MAX, SEE_PANEL_MAX_LINKS, type SeeInfoPanelContent, type SeeProjectInfoPanel } from "../../domain/seeContent.ts";
import { isSeeEmbedPolicy, parseEmbedOrigins } from "../../domain/seeEmbed.ts";
import { createSeeStorageKey, glbJsonChunkEnd, inspectGlb, magicBytesMatch, SEE_GLB_JSON_INSPECT_LIMIT, validateSeeUpload, type SeeModelInfo } from "../../domain/seeFiles.ts";
import {
  buildSnapshot,
  cleanText,
  fileDownloadName,
  isSeeUuid,
  isValidShareSlug,
  nextProjectStatus,
  normalizeSceneSettings,
  parseVec3,
  publicGate,
  requireName,
  SEE_MAX_ANNOTATIONS_PER_SCENE,
  SEE_MAX_DOCUMENTS,
  SEE_MAX_SCENES,
  SEE_STATUS_ACTIONS,
  SeeValidationError,
  snapshotReferencesFile,
  type SeeAnnotation,
  type SeeFile,
  type SeeProject,
  type SeeProjectAggregate,
  type SeeProjectListQuery,
  type SeePublication,
  type SeePublicationMode,
  type SeeScene,
  type SeeStatusAction,
} from "../../domain/seeProject.ts";
import { editorFileView, toEditorView, type SeeEditorView, type SeePublicManifest } from "../../domain/seeViews.ts";
import type { SeeActor } from "./auth.server.ts";
import type { SeeDeps } from "./backend.server.ts";
import {
  generateGrantToken,
  generatePin,
  generateShareSlug,
  hashGrantToken,
  hashPin,
  isPlausibleGrantToken,
  isValidPinFormat,
  looksLikeBot,
  pinClientHash,
  signTicket,
  verifyPin,
  verifyTicket,
  visitorHash,
  type SeeTicketPayload,
} from "./security.server.ts";

/** Wrong-PIN limits: per hashed client and per publication (defends against distributed guessing). */
export const SEE_PIN_WINDOW_MINUTES = 15;
export const SEE_PIN_CLIENT_MAX_FAILURES = 5;
export const SEE_PIN_PUBLICATION_MAX_FAILURES = 50;
const VIEW_DEDUPE_SECONDS = 30 * 60;
const SEE_MAX_IMAGES = 300;

const nowIso = (deps: SeeDeps) => deps.now().toISOString();

function notFound(): never {
  throw new SeeValidationError("Projekt nebyl nalezen.", 404);
}

async function loadAggregate(deps: SeeDeps, projectId: string): Promise<SeeProjectAggregate> {
  if (!isSeeUuid(projectId)) notFound();
  const aggregate = await deps.repository.getAggregate(projectId);
  if (!aggregate || aggregate.project.status === "deleted") notFound();
  return aggregate;
}

async function editorView(deps: SeeDeps, projectId: string): Promise<SeeEditorView> {
  const aggregate = await loadAggregate(deps, projectId);
  const publication = aggregate.publication;
  let pinSecurity: SeeEditorView["pinSecurity"];
  if (publication?.mode === "pin") {
    const recentFailures = await deps.repository.countPinFailures(publication.id, pinFailureWindowStart(publication, deps.now()));
    pinSecurity = { recentFailures, locked: recentFailures >= SEE_PIN_PUBLICATION_MAX_FAILURES };
  }
  const visible = { ...aggregate, files: aggregate.files.filter((file) => !isAbandonedUpload(file, deps)) };
  return toEditorView(visible, deps.limits, deps.backend, { pinSecurity, delivery: deps.delivery });
}

function touch(project: SeeProject, actor: SeeActor, deps: SeeDeps, changes: Partial<SeeProject> = {}): SeeProject {
  return { ...project, ...changes, updatedAt: nowIso(deps), updatedBy: { id: actor.id, label: actor.label } };
}

// ───────────────────────────── Projekty ─────────────────────────────

export function parseListQuery(params: URLSearchParams): SeeProjectListQuery {
  const status = params.get("status");
  const publication = params.get("publication");
  const page = Math.max(1, Math.min(10_000, Number(params.get("page")) || 1));
  const limit = Math.max(5, Math.min(100, Number(params.get("limit")) || 20));
  return {
    search: cleanText(params.get("q"), 100) || undefined,
    status: (["active", "paused", "archived", "deleted", "all"] as const).find((entry) => entry === status),
    publication: (["draft", "published", "all"] as const).find((entry) => entry === publication),
    offset: (page - 1) * limit,
    limit,
  };
}

export async function listProjects(deps: SeeDeps, query: SeeProjectListQuery) {
  return deps.repository.listProjects(query);
}

export async function createProject(deps: SeeDeps, actor: SeeActor, body: unknown): Promise<SeeEditorView> {
  const input = (body && typeof body === "object" ? body : {}) as { name?: unknown; description?: unknown; scenes?: unknown };
  const name = requireName(input.name, "Název projektu", 200);
  const description = cleanText(input.description, 4000);
  const sceneInputs = Array.isArray(input.scenes) ? input.scenes : [];
  if (sceneInputs.length > SEE_MAX_SCENES) throw new SeeValidationError(`Projekt může mít nejvýše ${SEE_MAX_SCENES} modelů.`);
  const at = nowIso(deps);
  const stampValue = { id: actor.id, label: actor.label };
  const project: SeeProject = { id: crypto.randomUUID(), name, description, status: "active", createdAt: at, createdBy: stampValue, updatedAt: at, updatedBy: stampValue };
  await deps.repository.insertProject(project);
  for (const [index, entry] of sceneInputs.entries()) {
    const scene = (entry && typeof entry === "object" ? entry : {}) as { name?: unknown; description?: unknown };
    await deps.repository.insertScene({
      id: crypto.randomUUID(),
      projectId: project.id,
      name: cleanText(scene.name, 120) || `Model ${index + 1}`,
      description: cleanText(scene.description, 2000),
      sortOrder: index,
      settings: normalizeSceneSettings({}),
      createdAt: at,
      updatedAt: at,
    });
  }
  return editorView(deps, project.id);
}

export async function getEditorProject(deps: SeeDeps, projectId: string) {
  return editorView(deps, projectId);
}

type IncomingScene = { id?: unknown; name?: unknown; description?: unknown; sortOrder?: unknown; modelFileId?: unknown; settings?: unknown };
type IncomingAnnotation = { id?: unknown; sceneId?: unknown; title?: unknown; body?: unknown; position?: unknown; normal?: unknown; visible?: unknown; sortOrder?: unknown; imageFileId?: unknown; linkUrl?: unknown; linkLabel?: unknown };
type IncomingFile = { id?: unknown; displayName?: unknown; appliesToAll?: unknown; sceneIds?: unknown; sortOrder?: unknown; deleted?: unknown };

/**
 * Saves the whole editor state (project texts, scenes + their settings, annotations, document
 * metadata/links) in one request. Ids are client-generated UUIDs: an id that already belongs to
 * this project is updated, an unknown id is inserted (the database refuses ids of other projects),
 * and rows missing from the request are deleted. Published content is NOT touched — it changes only
 * with an explicit "Publikovat".
 */
export async function saveEditorState(deps: SeeDeps, actor: SeeActor, projectId: string, body: unknown): Promise<SeeEditorView> {
  const aggregate = await loadAggregate(deps, projectId);
  const input = (body && typeof body === "object" ? body : {}) as { project?: { name?: unknown; description?: unknown; infoPanel?: unknown }; scenes?: unknown; annotations?: unknown; files?: unknown };
  if (!Array.isArray(input.scenes) || !Array.isArray(input.annotations) || !Array.isArray(input.files)) {
    throw new SeeValidationError("Chybí kompletní stav editoru.");
  }
  if (input.scenes.length > SEE_MAX_SCENES) throw new SeeValidationError(`Projekt může mít nejvýše ${SEE_MAX_SCENES} modelů.`);
  const urlOptions = { allowLocalHttp: deps.allowLocalHttpLinks === true };
  const at = nowIso(deps);

  const existingScenes = new Map(aggregate.scenes.map((scene) => [scene.id, scene]));
  const filesById = new Map(aggregate.files.map((file) => [file.id, file]));
  const fileUpdates = new Map<string, SeeFile>();
  for (const raw of input.files as IncomingFile[]) {
    const file = isSeeUuid(raw?.id) ? filesById.get(raw.id) : undefined;
    if (!file) throw new SeeValidationError("Soubor nepatří k tomuto projektu.");
    fileUpdates.set(file.id, {
      ...file,
      displayName: cleanText(raw.displayName, 200) || file.displayName,
      appliesToAll: file.kind === "document" ? raw.appliesToAll !== false : true,
      sceneIds: Array.isArray(raw.sceneIds) ? raw.sceneIds.filter(isSeeUuid) : [],
      sortOrder: Number.isSafeInteger(raw.sortOrder) ? raw.sortOrder as number : file.sortOrder,
      deletedAt: raw.deleted === true ? file.deletedAt ?? at : file.deletedAt,
    });
  }
  const usableModel = (fileId: string) => {
    const file = fileUpdates.get(fileId) ?? filesById.get(fileId);
    return Boolean(file && file.kind === "model" && file.status === "ready" && !file.deletedAt);
  };
  const usableImage = (fileId: unknown): fileId is string => {
    const file = isSeeUuid(fileId) ? fileUpdates.get(fileId) ?? filesById.get(fileId) : undefined;
    return Boolean(file && file.kind === "image" && file.status === "ready" && !file.deletedAt);
  };
  /** Strict validation of editor input (links, picture), then the same normalization as stored data. */
  const checkedPanel = (value: unknown, where: string): SeeInfoPanelContent | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "object") throw new SeeValidationError(`${where}: neplatný obsah panelu.`);
    const raw = value as { imageFileId?: unknown; links?: unknown };
    if (raw.imageFileId !== undefined && raw.imageFileId !== null && raw.imageFileId !== "" && !usableImage(raw.imageFileId)) {
      throw new SeeValidationError(`${where}: obrázek není nahraný nebo byl odstraněn.`);
    }
    const links = Array.isArray(raw.links) ? raw.links : [];
    if (links.length > SEE_PANEL_MAX_LINKS) throw new SeeValidationError(`${where}: nejvýše ${SEE_PANEL_MAX_LINKS} odkazů.`);
    for (const link of links) {
      const problem = linkProblem((link as { url?: unknown } | null)?.url, urlOptions);
      if (problem) throw new SeeValidationError(`${where}: ${problem}`);
    }
    return normalizeInfoPanelContent(value, urlOptions);
  };

  const scenes: SeeScene[] = [];
  const seenScenes = new Set<string>();
  for (const [index, raw] of (input.scenes as IncomingScene[]).entries()) {
    if (!isSeeUuid(raw?.id) || seenScenes.has(raw.id)) throw new SeeValidationError("Neplatný identifikátor modelu.");
    seenScenes.add(raw.id);
    const modelFileId = raw.modelFileId === undefined || raw.modelFileId === null ? undefined : isSeeUuid(raw.modelFileId) ? raw.modelFileId : null;
    if (modelFileId === null || (modelFileId !== undefined && !usableModel(modelFileId))) {
      throw new SeeValidationError("Model odkazuje na soubor, který není nahraný nebo byl odstraněn.");
    }
    const existing = existingScenes.get(raw.id);
    const name = requireName(raw.name, "Název modelu", 120);
    const { infoPanel: _unchecked, ...baseSettings } = normalizeSceneSettings(raw.settings);
    const sceneInfoPanel = checkedPanel((raw.settings as { infoPanel?: unknown } | undefined)?.infoPanel, `Panel modelu „${name}“`);
    scenes.push({
      id: raw.id,
      projectId,
      name,
      description: cleanText(raw.description, 2000),
      sortOrder: index,
      modelFileId,
      settings: sceneInfoPanel ? { ...baseSettings, infoPanel: sceneInfoPanel } : baseSettings,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    });
  }

  const existingAnnotations = new Map(aggregate.annotations.map((annotation) => [annotation.id, annotation]));
  const annotations: SeeAnnotation[] = [];
  const perScene = new Map<string, number>();
  const seenAnnotations = new Set<string>();
  for (const raw of input.annotations as IncomingAnnotation[]) {
    if (!isSeeUuid(raw?.id) || seenAnnotations.has(raw.id)) throw new SeeValidationError("Neplatný identifikátor popisku.");
    seenAnnotations.add(raw.id);
    if (!isSeeUuid(raw.sceneId) || !seenScenes.has(raw.sceneId)) throw new SeeValidationError("Popisek patří k neexistujícímu modelu.");
    const position = parseVec3(raw.position);
    if (!position) throw new SeeValidationError("Popisek nemá platnou 3D pozici.");
    const count = (perScene.get(raw.sceneId) ?? 0) + 1;
    if (count > SEE_MAX_ANNOTATIONS_PER_SCENE) throw new SeeValidationError(`Model může mít nejvýše ${SEE_MAX_ANNOTATIONS_PER_SCENE} popisků.`);
    perScene.set(raw.sceneId, count);
    const existing = existingAnnotations.get(raw.id);
    if (existing && existing.sceneId !== raw.sceneId) throw new SeeValidationError("Popisek nelze přesunout k jinému modelu.");
    const title = requireName(raw.title, "Název popisku", 160);
    const hasImage = raw.imageFileId !== undefined && raw.imageFileId !== null && raw.imageFileId !== "";
    if (hasImage && !usableImage(raw.imageFileId)) throw new SeeValidationError(`Popisek „${title}“: obrázek není nahraný nebo byl odstraněn.`);
    const linkUrl = typeof raw.linkUrl === "string" && raw.linkUrl.trim() ? raw.linkUrl.trim() : undefined;
    if (linkUrl) {
      const problem = linkProblem(linkUrl, urlOptions);
      if (problem) throw new SeeValidationError(`Popisek „${title}“: ${problem}`);
    }
    annotations.push({
      id: raw.id,
      sceneId: raw.sceneId,
      title,
      body: cleanText(raw.body, 4000),
      position,
      normal: parseVec3(raw.normal),
      ...(hasImage ? { imageFileId: raw.imageFileId as string } : {}),
      ...(linkUrl ? { linkUrl: new URL(linkUrl).href, linkLabel: cleanText(raw.linkLabel, SEE_LINK_LABEL_MAX) || SEE_DEFAULT_LINK_LABEL } : {}),
      visible: raw.visible !== false,
      sortOrder: count - 1,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    });
  }

  const projectInput = input.project ?? {};
  let infoPanel: SeeProjectInfoPanel | undefined = aggregate.project.infoPanel;
  if (projectInput.infoPanel !== undefined) {
    const content = checkedPanel(projectInput.infoPanel, "Informační panel projektu") ?? { title: "", body: "", links: [] };
    infoPanel = { ...content, enabled: (projectInput.infoPanel as { enabled?: unknown } | null)?.enabled === true };
  }
  await deps.repository.updateProject(touch(aggregate.project, actor, deps, {
    name: requireName(projectInput.name ?? aggregate.project.name, "Název projektu", 200),
    description: projectInput.description === undefined ? aggregate.project.description : cleanText(projectInput.description, 4000),
    ...(infoPanel ? { infoPanel } : {}),
  }));
  for (const annotation of aggregate.annotations) {
    if (!seenAnnotations.has(annotation.id) || !seenScenes.has(annotation.sceneId)) await deps.repository.deleteAnnotation(annotation.id);
  }
  for (const scene of aggregate.scenes) {
    if (!seenScenes.has(scene.id)) await deps.repository.deleteScene(scene.id);
  }
  for (const scene of scenes) {
    if (existingScenes.has(scene.id)) await deps.repository.updateScene(scene);
    else await deps.repository.insertScene(scene);
  }
  for (const annotation of annotations) {
    if (existingAnnotations.has(annotation.id)) await deps.repository.updateAnnotation(annotation);
    else await deps.repository.insertAnnotation(annotation);
  }
  for (const file of fileUpdates.values()) {
    const sceneIds = file.appliesToAll ? [] : file.sceneIds.filter((id) => seenScenes.has(id));
    await deps.repository.updateFile({ ...file, sceneIds });
  }
  // A document/model removed in the editor must stop being downloadable right now, even through a
  // signed URL issued a moment ago.
  const removed = [...fileUpdates.values()].filter((file) => file.deletedAt && !filesById.get(file.id)?.deletedAt);
  if (removed.length) await rekeyFiles(deps, removed);
  return editorView(deps, projectId);
}

// ───────────────────────────── Upload ─────────────────────────────

export async function prepareUpload(deps: SeeDeps, actor: SeeActor, projectId: string, body: unknown) {
  const aggregate = await loadAggregate(deps, projectId);
  const input = (body && typeof body === "object" ? body : {}) as { kind?: unknown; fileName?: unknown; mimeType?: unknown; sizeBytes?: unknown; displayName?: unknown; appliesToAll?: unknown; sceneIds?: unknown };
  const upload = validateSeeUpload(input, deps.limits);
  const live = aggregate.files.filter((file) => !file.deletedAt && file.status !== "rejected" && !isAbandonedUpload(file, deps));
  if (upload.kind === "document" && live.filter((file) => file.kind === "document").length >= SEE_MAX_DOCUMENTS) {
    throw new SeeValidationError(`Projekt může mít nejvýše ${SEE_MAX_DOCUMENTS} dokumentů.`);
  }
  // No fixed number of scenes: model versions scale with the scenes, plus a total size quota.
  if (upload.kind === "model" && live.filter((file) => file.kind === "model").length >= Math.max(12, aggregate.scenes.length * 3)) {
    throw new SeeValidationError("Příliš mnoho nahraných verzí modelů — odstraňte nepoužité.");
  }
  if (upload.kind === "image" && live.filter((file) => file.kind === "image").length >= SEE_MAX_IMAGES) {
    throw new SeeValidationError(`Projekt může mít nejvýše ${SEE_MAX_IMAGES} obrázků.`);
  }
  const usedBytes = live.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (usedBytes + upload.sizeBytes > deps.limits.maxProjectBytes) {
    throw new SeeValidationError(`Projekt by překročil celkový limit ${Math.round(deps.limits.maxProjectBytes / 1_000_000)} MB. Odstraňte nepoužívané soubory.`, 413);
  }
  const sceneIds = new Set(aggregate.scenes.map((scene) => scene.id));
  const at = nowIso(deps);
  const file: SeeFile = {
    id: crypto.randomUUID(),
    projectId,
    kind: upload.kind,
    displayName: cleanText(input.displayName, 200) || upload.fileName.replace(/\.[^.]+$/u, ""),
    originalFileName: upload.fileName,
    mimeType: upload.mimeType,
    sizeBytes: upload.sizeBytes,
    storageKey: createSeeStorageKey(deps.storage.prefix, upload.extension),
    status: "pending",
    appliesToAll: upload.kind === "document" ? input.appliesToAll !== false : true,
    sceneIds: upload.kind === "document" && input.appliesToAll === false && Array.isArray(input.sceneIds) ? input.sceneIds.filter((id): id is string => isSeeUuid(id) && sceneIds.has(id)) : [],
    sortOrder: live.length,
    createdBy: actor.id,
    createdAt: at,
    updatedAt: at,
  };
  const presigned = await deps.storage.createUploadUrl({ storageKey: file.storageKey, mimeType: file.mimeType, fileId: file.id, expiresInSeconds: deps.uploadUrlTtlSeconds });
  await deps.repository.insertFile(file);
  return { file: editorFileView(file), upload: presigned };
}

/**
 * A pending upload whose presigned PUT expired long ago (browser closed, network lost, R2 outage).
 * It can never become ready, so it neither counts against limits nor clutters the editor. Nothing
 * is deleted: the record stays for audit and a late "complete" is still verified normally.
 */
export function isAbandonedUpload(file: Pick<SeeFile, "status" | "createdAt">, deps: Pick<SeeDeps, "now" | "uploadUrlTtlSeconds">): boolean {
  return file.status === "pending" && Date.parse(file.createdAt) < deps.now().getTime() - (deps.uploadUrlTtlSeconds + 3600) * 1000;
}

/** Verifies the uploaded object (exists, exact size, real magic bytes) before it may be used. */
export async function completeUpload(deps: SeeDeps, actor: SeeActor, projectId: string, body: unknown): Promise<SeeEditorView> {
  const aggregate = await loadAggregate(deps, projectId);
  const input = (body && typeof body === "object" ? body : {}) as { fileId?: unknown; sceneId?: unknown };
  const file = isSeeUuid(input.fileId) ? aggregate.files.find((entry) => entry.id === input.fileId) : undefined;
  if (!file || file.deletedAt) throw new SeeValidationError("Soubor nebyl nalezen.", 404);
  if (file.status === "pending") {
    const info = await deps.storage.head(file.storageKey);
    if (!info) throw new SeeValidationError("Soubor v úložišti zatím není — upload se nedokončil.", 409);
    const head = await deps.storage.readHead(file.storageKey, 20);
    let problem = info.contentLength !== file.sizeBytes
      ? "Velikost nahraného souboru neodpovídá ohlášené velikosti."
      : !head || !magicBytesMatch(file.mimeType, head)
        ? (file.kind === "model" ? "Soubor není platný GLB (glTF 2.0 binary)." : "Obsah souboru neodpovídá typu PDF/JPG/PNG.")
        : undefined;
    let modelInfo: SeeModelInfo | undefined;
    if (!problem && file.kind === "model") {
      const inspected = await inspectUploadedGlb(deps, file.storageKey, head!);
      problem = inspected.problem;
      modelInfo = inspected.info;
    }
    if (problem) {
      await deps.repository.updateFile({ ...file, status: "rejected" });
      await deps.storage.deleteObject(file.storageKey).catch(() => undefined);
      throw new SeeValidationError(problem, 422);
    }
    await deps.repository.updateFile({ ...file, status: "ready", ...(modelInfo ? { modelInfo } : {}) });
  } else if (file.status === "rejected") {
    throw new SeeValidationError("Soubor byl při kontrole odmítnut.", 422);
  }
  if (input.sceneId !== undefined && file.kind === "model") {
    const scene = aggregate.scenes.find((entry) => entry.id === input.sceneId);
    if (!scene) throw new SeeValidationError("Model (scéna) nebyl nalezen.", 404);
    await deps.repository.updateScene({ ...scene, modelFileId: file.id, updatedAt: nowIso(deps) });
  }
  await deps.repository.updateProject(touch(aggregate.project, actor, deps));
  return editorView(deps, projectId);
}

/**
 * Reads only the GLB JSON chunk (never the geometry) and refuses models whose REQUIRED glTF
 * extensions the viewer cannot render. Unusually large JSON chunks are accepted without statistics.
 */
async function inspectUploadedGlb(deps: SeeDeps, storageKey: string, head: Uint8Array): Promise<Readonly<{ info?: SeeModelInfo; problem?: string }>> {
  const end = glbJsonChunkEnd(head);
  if (!end) return { problem: "Soubor není platný GLB (glTF 2.0 binary)." };
  if (end > SEE_GLB_JSON_INSPECT_LIMIT) return {};
  const bytes = await deps.storage.readHead(storageKey, end);
  if (!bytes) return { problem: "Soubor v úložišti nelze přečíst." };
  try {
    const info = inspectGlb(bytes);
    if (info.unsupportedRequired.length) {
      return { problem: `Model vyžaduje nepodporovaná rozšíření glTF: ${info.unsupportedRequired.join(", ")}. Exportujte jej bez nich.` };
    }
    return { info };
  } catch (error) {
    if (error instanceof SeeValidationError) return { problem: error.message };
    throw error;
  }
}

function streamsFile(deps: SeeDeps, file: SeeFile): boolean {
  if (!deps.storage.supportsSignedDownload) return true;
  return deps.delivery === "stream" || (deps.delivery === "hybrid" && file.kind === "document");
}

async function deliveryUrl(deps: SeeDeps, file: SeeFile, attachment: boolean, publication?: SeePublication): Promise<string> {
  const fileName = fileDownloadName(file);
  if (!streamsFile(deps, file)) {
    return deps.storage.createDownloadUrl({ storageKey: file.storageKey, mimeType: file.mimeType, expiresInSeconds: deps.fileUrlTtlSeconds, fileName, attachment });
  }
  const payload: SeeTicketPayload = {
    op: "get",
    key: file.storageKey,
    fileId: file.id,
    mime: file.mimeType,
    name: fileName,
    attachment,
    exp: deps.now().getTime() + deps.fileUrlTtlSeconds * 1000,
    ...(publication ? { publicationId: publication.id, epoch: publication.accessEpoch } : {}),
  };
  return `/api/see/content?t=${encodeURIComponent(signTicket(payload, deps.secret))}`;
}

/** Working preview: logged-in editors may open any ready file of a non-deleted project. */
export async function editorFileUrl(deps: SeeDeps, projectId: string, fileId: string, attachment: boolean) {
  const aggregate = await loadAggregate(deps, projectId);
  const file = aggregate.files.find((entry) => entry.id === fileId);
  if (!file || file.deletedAt || file.status !== "ready") throw new SeeValidationError("Soubor není dostupný.", 404);
  return { url: await deliveryUrl(deps, file, attachment), expiresInSeconds: deps.fileUrlTtlSeconds };
}

// ───────────────────────────── Stavy projektu ─────────────────────────────

/** Any security-relevant change: bump the epoch (kills every grant and ticket now) and revoke grants. */
function rotateAccess(publication: SeePublication, deps: SeeDeps, changes: Partial<SeePublication> = {}): SeePublication {
  return { ...publication, ...changes, accessEpoch: publication.accessEpoch + 1, updatedAt: nowIso(deps) };
}

/**
 * IMMEDIATE invalidation of already issued signed URLs (a presigned R2 URL itself cannot be revoked).
 * Every ready object is copied server-side to a new opaque key, the database is pointed at it and
 * only then the old object is deleted — a URL handed out before unpublish / new PIN / pause stops
 * working at once (404) while the content stays preserved under the new key. Transfers that already
 * started cannot be interrupted by any object storage. Returns a Czech warning when something could
 * not be re-keyed (those URLs then expire after fileUrlTtlSeconds).
 */
async function rekeyFiles(deps: SeeDeps, files: readonly SeeFile[]): Promise<string | undefined> {
  if (!deps.rekeyOnRevoke || !deps.storage.supportsSignedDownload || deps.delivery === "stream") return undefined;
  let failed = 0;
  for (const file of files) {
    if (file.status !== "ready") continue;
    const outcome = await rekeyOneFile(deps, file);
    if (outcome !== "ok") failed += 1;
  }
  if (!failed) return undefined;
  console.error("HWS SEE re-key incomplete:", { failed });
  return `Přístup je zablokovaný, ale ${failed} ${failed === 1 ? "soubor se nepodařilo" : "souborů se nepodařilo"} překlíčovat — již vydané odkazy na ně vyprší nejpozději za ${deps.fileUrlTtlSeconds} s.`;
}

/**
 * One re-key, ordered so that NO failure point leaves the file pointing at a missing object:
 *   1. copy old → new (server-side) and verify the copy (exists, same size);
 *   2. compare-and-set the database to the new key (only if it still has the old one);
 *   3. delete the old object.
 * Failure in 1 → nothing changed (new copy removed if present). Conflict in 2 → someone else
 * re-keyed first: our copy is removed, the record stays valid. Unknown DB outcome in 2 → the file
 * is re-read; our copy is removed only if the record provably does not reference it, otherwise it
 * is kept (an orphan is harmless, a dangling key is not). Failure in 3 → the old object lingers
 * until the signed-URL TTL is over (reported as a warning); the project is consistent.
 */
export async function rekeyOneFile(deps: SeeDeps, file: SeeFile): Promise<"ok" | "copy-failed" | "db-failed" | "conflict" | "old-not-deleted"> {
  const extension = file.storageKey.split(".").pop() ?? "bin";
  const newKey = createSeeStorageKey(deps.storage.prefix, extension);
  const discardCopy = () => deps.storage.deleteObject(newKey).catch(() => undefined);
  try {
    await deps.storage.copyObject(file.storageKey, newKey);
    const copied = await deps.storage.head(newKey);
    if (!copied || (copied.contentLength !== undefined && copied.contentLength !== file.sizeBytes)) {
      await discardCopy();
      return "copy-failed";
    }
  } catch {
    await discardCopy();
    return "copy-failed";
  }
  let swapped: boolean;
  try {
    swapped = await deps.repository.updateFileStorageKey(file.id, newKey, file.storageKey);
  } catch {
    const current = await deps.repository.getFile(file.id).catch(() => undefined);
    if (current && current.storageKey !== newKey) await discardCopy();
    return "db-failed";
  }
  if (!swapped) {
    await discardCopy();
    return "conflict";
  }
  try {
    await deps.storage.deleteObject(file.storageKey);
  } catch {
    return "old-not-deleted";
  }
  return "ok";
}

async function rekeyProject(deps: SeeDeps, projectId: string): Promise<string | undefined> {
  const aggregate = await deps.repository.getAggregate(projectId);
  return rekeyFiles(deps, aggregate?.files.filter((file) => !file.deletedAt) ?? []);
}

export async function changeProjectStatus(deps: SeeDeps, actor: SeeActor, projectId: string, body: unknown): Promise<Readonly<{ status: SeeProject["status"]; warning?: string }>> {
  const aggregate = await loadAggregate(deps, projectId);
  const action = (body as { action?: unknown } | null)?.action;
  if (!(SEE_STATUS_ACTIONS as readonly unknown[]).includes(action)) throw new SeeValidationError("Neznámá akce.");
  const status = nextProjectStatus(aggregate.project.status, action as SeeStatusAction);
  if (!status) throw new SeeValidationError("Tuto změnu stavu nelze v aktuálním stavu projektu provést.", 409);
  const at = nowIso(deps);
  await deps.repository.updateProject(touch(aggregate.project, actor, deps, { status, ...(status === "deleted" ? { deletedAt: at } : {}) }));
  const publication = aggregate.publication;
  if (publication && status !== "active") {
    await deps.repository.updatePublication(rotateAccess(publication, deps, status === "deleted" ? { status: "draft", unpublishedAt: at } : {}));
    await deps.repository.revokeGrants(publication.id, at);
  }
  const warning = status !== "active" ? await rekeyProject(deps, projectId) : undefined;
  return warning ? { status, warning } : { status };
}

// ───────────────────────────── Publikace ─────────────────────────────

export type SeePublicationResult = Readonly<{ view: SeeEditorView; pin?: string; warning?: string }>;

async function newPinHash(deps: SeeDeps, requested: unknown): Promise<Readonly<{ pin: string; hash: string }>> {
  if (requested !== undefined && requested !== null && requested !== "" && !isValidPinFormat(requested)) {
    throw new SeeValidationError("PIN musí mít 8 až 12 číslic.");
  }
  const pin = isValidPinFormat(requested) ? requested : generatePin();
  return { pin, hash: await hashPin(pin, deps.pinIterations) };
}

export async function publicationAction(deps: SeeDeps, actor: SeeActor, projectId: string, body: unknown): Promise<SeePublicationResult> {
  const aggregate = await loadAggregate(deps, projectId);
  const input = (body && typeof body === "object" ? body : {}) as { action?: unknown; mode?: unknown; pin?: unknown; embedPolicy?: unknown; embedOrigins?: unknown };
  const at = nowIso(deps);
  let publication = aggregate.publication;
  let pin: string | undefined;
  /** Access became stricter → already issued signed URLs must stop working now (re-key). */
  let tightened = false;
  const mode = input.mode === "public" || input.mode === "pin" ? input.mode as SeePublicationMode : undefined;
  if (input.mode !== undefined && !mode) throw new SeeValidationError("Režim sdílení může být jen „public“ nebo „pin“.");

  switch (input.action) {
    case "publish": {
      if (aggregate.project.status !== "active") throw new SeeValidationError("Pozastavený nebo archivovaný projekt nelze publikovat. Nejdřív jej obnovte.", 409);
      const targetMode = mode ?? publication?.mode ?? "public";
      const revision = (publication?.snapshotRevision ?? 0) + 1;
      const snapshot = buildSnapshot(aggregate, revision, at);
      let pinHash = publication?.pinHash;
      let pinSetAt = publication?.pinSetAt;
      if (targetMode === "pin" && (!pinHash || (input.pin !== undefined && input.pin !== ""))) {
        const created = await newPinHash(deps, input.pin);
        pin = created.pin;
        pinHash = created.hash;
        pinSetAt = at;
      }
      if (!publication) {
        publication = {
          id: crypto.randomUUID(), projectId, shareSlug: generateShareSlug(), mode: targetMode, status: "published",
          pinHash, pinSetAt, accessEpoch: 1, snapshot, snapshotRevision: revision, viewCount: 0,
          embedPolicy: "default", embedOrigins: [],
          publishedAt: at, publishedBy: actor.id, createdAt: at, updatedAt: at,
        };
        await deps.repository.insertPublication(publication);
      } else {
        const securityChange = publication.mode !== targetMode || pin !== undefined || publication.status !== "published";
        const next: SeePublication = { ...publication, mode: targetMode, status: "published", pinHash, pinSetAt, snapshot, snapshotRevision: revision, publishedAt: at, publishedBy: actor.id, updatedAt: at };
        await deps.repository.updatePublication(securityChange ? rotateAccess(next, deps) : next);
        if (securityChange) await deps.repository.revokeGrants(publication.id, at);
        tightened = publication.status === "published" && targetMode === "pin" && (publication.mode !== "pin" || pin !== undefined);
      }
      break;
    }
    case "unpublish": {
      if (!publication || publication.status !== "published") throw new SeeValidationError("Projekt není publikovaný.", 409);
      await deps.repository.updatePublication(rotateAccess(publication, deps, { status: "draft", unpublishedAt: at }));
      await deps.repository.revokeGrants(publication.id, at);
      tightened = true;
      break;
    }
    case "set-mode": {
      if (!publication) throw new SeeValidationError("Projekt ještě nebyl publikován.", 409);
      if (!mode) throw new SeeValidationError("Zvolte režim sdílení.");
      let changes: Partial<SeePublication> = { mode };
      if (mode === "pin" && (!publication.pinHash || (input.pin !== undefined && input.pin !== ""))) {
        const created = await newPinHash(deps, input.pin);
        pin = created.pin;
        changes = { ...changes, pinHash: created.hash, pinSetAt: at };
      }
      await deps.repository.updatePublication(rotateAccess(publication, deps, changes));
      await deps.repository.revokeGrants(publication.id, at);
      tightened = mode === "pin" && publication.status === "published";
      break;
    }
    case "new-pin": {
      if (!publication || publication.mode !== "pin") throw new SeeValidationError("Nový PIN lze nastavit jen u chráněné prezentace.", 409);
      const created = await newPinHash(deps, input.pin);
      pin = created.pin;
      await deps.repository.updatePublication(rotateAccess(publication, deps, { pinHash: created.hash, pinSetAt: at }));
      await deps.repository.revokeGrants(publication.id, at);
      tightened = publication.status === "published";
      break;
    }
    case "rotate-link": {
      if (!publication) throw new SeeValidationError("Projekt ještě nebyl publikován.", 409);
      await deps.repository.updatePublication(rotateAccess(publication, deps, { shareSlug: generateShareSlug() }));
      await deps.repository.revokeGrants(publication.id, at);
      tightened = publication.status === "published";
      break;
    }
    case "set-embed": {
      if (!publication) throw new SeeValidationError("Projekt ještě nebyl publikován.", 409);
      if (!isSeeEmbedPolicy(input.embedPolicy)) throw new SeeValidationError("Neznámé nastavení vkládání.");
      const embedOrigins = input.embedPolicy === "allowlist" ? parseEmbedOrigins(input.embedOrigins) : [];
      if (input.embedPolicy === "allowlist" && embedOrigins.length === 0) throw new SeeValidationError("Zadejte alespoň jeden web, na kterém smí být prezentace vložena.");
      // Framing policy only (no grant/epoch change); proxy.ts reads it on every embed page request.
      await deps.repository.updatePublication({ ...publication, embedPolicy: input.embedPolicy, embedOrigins, updatedAt: at });
      break;
    }
    default:
      throw new SeeValidationError("Neznámá akce publikace.");
  }
  await deps.repository.updateProject(touch(aggregate.project, actor, deps));
  const warning = tightened ? await rekeyProject(deps, projectId) : undefined;
  return { view: await editorView(deps, projectId), pin, ...(warning ? { warning } : {}) };
}

// ───────────────────────────── Veřejný přístup ─────────────────────────────

type PublicContext = Readonly<{ publication: SeePublication; project: SeeProject }>;

type PublicResolution =
  | Readonly<{ ok: true; context: PublicContext }>
  | Readonly<{ ok: false; manifest: SeePublicManifest; status: number }>;

async function grantIsValid(deps: SeeDeps, publication: SeePublication, token: string | undefined): Promise<boolean> {
  if (!isPlausibleGrantToken(token)) return false;
  const grant = await deps.repository.getGrantByTokenHash(hashGrantToken(token));
  return Boolean(
    grant
    && grant.publicationId === publication.id
    && !grant.revokedAt
    && grant.accessEpoch === publication.accessEpoch
    && Date.parse(grant.expiresAt) > deps.now().getTime(),
  );
}

/** The single gate every public request goes through: publication + project state, then PIN grant. */
async function resolvePublic(deps: SeeDeps, slug: string, grantTokens: readonly (string | undefined)[], requireAccess: boolean): Promise<PublicResolution> {
  if (!isValidShareSlug(slug)) return { ok: false, manifest: { state: "not-found" }, status: 404 };
  const publication = await deps.repository.getPublicationBySlug(slug);
  const project = publication ? await deps.repository.getProject(publication.projectId) : undefined;
  const gate = publicGate(publication, project);
  if (gate.state === "not-found") return { ok: false, manifest: { state: "not-found" }, status: 404 };
  if (gate.state === "unavailable") return { ok: false, manifest: { state: "unavailable", reason: gate.reason }, status: 403 };
  if (gate.mode === "pin" && requireAccess) {
    let valid = false;
    for (const token of grantTokens) {
      if (token && await grantIsValid(deps, publication!, token)) { valid = true; break; }
    }
    if (!valid) {
      const presented = grantTokens.some((token) => token);
      return { ok: false, manifest: presented ? { state: "pin-required", reason: "expired" } : { state: "pin-required" }, status: 401 };
    }
  }
  return { ok: true, context: { publication: publication!, project: project! } };
}

export async function publicManifest(deps: SeeDeps, slug: string, grantTokens: readonly (string | undefined)[]): Promise<Readonly<{ manifest: SeePublicManifest; status: number }>> {
  const resolution = await resolvePublic(deps, slug, grantTokens, true);
  if (resolution.ok === false) return { manifest: resolution.manifest, status: resolution.status };
  const { publication } = resolution.context;
  const snapshot = publication.snapshot!;
  // Files soft-deleted after publishing disappear immediately (deletion is never delayed until the
  // next "Publikovat").
  const liveIds = new Set<string>();
  const imageIds = [
    snapshot.infoPanel?.imageFileId,
    ...snapshot.scenes.flatMap((scene) => [scene.settings.infoPanel?.imageFileId, ...scene.annotations.map((annotation) => annotation.imageFileId)]),
  ].filter((id): id is string => Boolean(id));
  for (const id of new Set([...snapshot.scenes.map((scene) => scene.modelFileId), ...snapshot.documents.map((document) => document.id), ...imageIds])) {
    const file = await deps.repository.getFile(id);
    if (file && file.projectId === publication.projectId && file.status === "ready" && !file.deletedAt) liveIds.add(id);
  }
  // Pictures deleted after publishing disappear from the published content immediately as well.
  const liveImage = <T extends { imageFileId?: string }>(value: T): T => {
    if (!value.imageFileId || liveIds.has(value.imageFileId)) return value;
    const { imageFileId: _dropped, ...rest } = value;
    return rest as T;
  };
  return {
    status: 200,
    manifest: {
      state: "ok",
      mode: publication.mode,
      title: snapshot.projectName,
      description: snapshot.projectDescription,
      revision: snapshot.revision,
      scenes: snapshot.scenes
        .filter((scene) => liveIds.has(scene.modelFileId))
        .map((scene) => ({
          ...scene,
          settings: scene.settings.infoPanel ? { ...scene.settings, infoPanel: liveImage(scene.settings.infoPanel) } : scene.settings,
          annotations: scene.annotations.map(liveImage),
        })),
      documents: snapshot.documents.filter((document) => liveIds.has(document.id)),
      ...(snapshot.infoPanel?.enabled ? { infoPanel: liveImage(snapshot.infoPanel) } : {}),
    },
  };
}

export type SeeUnlockResult =
  | Readonly<{ ok: true; token: string; expiresAt: string; publicationId: string }>
  | Readonly<{ ok: false; status: number; error: string; retryAfterSeconds?: number; manifest?: SeePublicManifest }>;

/**
 * Server-side PIN check with rate limiting (per hashed client IP and per publication). The PIN is
 * compared with the stored PBKDF2 hash only; it is never logged or echoed.
 */
export async function unlockPublication(deps: SeeDeps, slug: string, body: unknown, ip: string): Promise<SeeUnlockResult> {
  const resolution = await resolvePublic(deps, slug, [], false);
  if (resolution.ok === false) return { ok: false, status: resolution.status, error: "Prezentace není dostupná.", manifest: resolution.manifest };
  const { publication } = resolution.context;
  if (publication.mode !== "pin") return { ok: false, status: 409, error: "Tato prezentace PIN nevyžaduje." };
  const now = deps.now();
  const since = pinFailureWindowStart(publication, now);
  const clientHash = pinClientHash(ip, deps.secret);
  const [clientFailures, publicationFailures] = await Promise.all([
    deps.repository.countPinFailures(publication.id, since, clientHash),
    deps.repository.countPinFailures(publication.id, since),
  ]);
  if (clientFailures >= SEE_PIN_CLIENT_MAX_FAILURES || publicationFailures >= SEE_PIN_PUBLICATION_MAX_FAILURES) {
    return { ok: false, status: 429, error: `Příliš mnoho chybných pokusů. Zkuste to znovu za ${SEE_PIN_WINDOW_MINUTES} minut.`, retryAfterSeconds: SEE_PIN_WINDOW_MINUTES * 60 };
  }
  const pin = (body as { pin?: unknown } | null)?.pin;
  const pinText = typeof pin === "string" ? pin.replace(/\s+/gu, "") : "";
  if (!(await verifyPin(pinText, publication.pinHash))) {
    await deps.repository.insertPinFailure(publication.id, clientHash, now.toISOString());
    if (deps.failedPinDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, deps.failedPinDelayMs));
    const remaining = Math.max(0, SEE_PIN_CLIENT_MAX_FAILURES - clientFailures - 1);
    return {
      ok: false,
      status: 401,
      error: remaining > 0 ? `Nesprávný PIN. Zbývající pokusy: ${remaining}.` : `Nesprávný PIN. Další pokus bude možný za ${SEE_PIN_WINDOW_MINUTES} minut.`,
    };
  }
  const token = generateGrantToken();
  const expiresAt = new Date(now.getTime() + deps.grantTtlMinutes * 60_000).toISOString();
  await deps.repository.insertGrant({ id: crypto.randomUUID(), publicationId: publication.id, tokenHash: hashGrantToken(token), accessEpoch: publication.accessEpoch, expiresAt, createdAt: now.toISOString() });
  return { ok: true, token, expiresAt, publicationId: publication.id };
}

/**
 * Failures count from the later of "15 minutes ago" and the moment the current PIN was set, so an
 * administrator can end a deliberate lockout of the whole presentation (denial of service through
 * wrong PINs) by setting a new PIN.
 */
export function pinFailureWindowStart(publication: Pick<SeePublication, "pinSetAt">, now: Date): string {
  const window = new Date(now.getTime() - SEE_PIN_WINDOW_MINUTES * 60_000).toISOString();
  return publication.pinSetAt && publication.pinSetAt > window ? publication.pinSetAt : window;
}

/** Short-lived URL for one model/document — only files the published snapshot exposes. */
export async function publicFileUrl(deps: SeeDeps, slug: string, fileId: string, grantTokens: readonly (string | undefined)[], attachment: boolean) {
  const resolution = await resolvePublic(deps, slug, grantTokens, true);
  if (resolution.ok === false) return { ok: false as const, status: resolution.status, manifest: resolution.manifest };
  const { publication } = resolution.context;
  const kind = isSeeUuid(fileId) ? snapshotReferencesFile(publication.snapshot!, fileId) : undefined;
  const file = kind ? await deps.repository.getFile(fileId) : undefined;
  if (!file || file.projectId !== publication.projectId || file.status !== "ready" || file.deletedAt) {
    return { ok: false as const, status: 404, manifest: { state: "not-found" } as SeePublicManifest };
  }
  return { ok: true as const, url: await deliveryUrl(deps, file, attachment && kind === "document", publication), expiresInSeconds: deps.fileUrlTtlSeconds };
}

export async function recordPublicView(deps: SeeDeps, slug: string, grantTokens: readonly (string | undefined)[], headers: Headers, ip: string, embed: boolean) {
  const resolution = await resolvePublic(deps, slug, grantTokens, true);
  if (resolution.ok === false) return { counted: false, status: resolution.status };
  const userAgent = headers.get("user-agent");
  if (looksLikeBot(userAgent) || headers.get("purpose") === "prefetch" || headers.get("sec-purpose")?.includes("prefetch")) return { counted: false, status: 200 };
  const day = deps.now().toISOString().slice(0, 10);
  const counted = await deps.repository.recordView({
    publicationId: resolution.context.publication.id,
    projectId: resolution.context.project.id,
    visitorHash: visitorHash(ip, userAgent ?? "", day, deps.secret),
    embed,
    dedupeSeconds: VIEW_DEDUPE_SECONDS,
  });
  return { counted, status: 200 };
}

/**
 * /api/see/content — streamed delivery (local dev, or SEE_FILE_DELIVERY=stream). The ticket is a
 * short-lived HMAC capability; public tickets additionally re-check, at request time, that the
 * publication is still published, the project active and the access epoch unchanged, so unpublish,
 * pause or a new PIN cut off even an already issued URL immediately.
 */
export async function openContent(deps: SeeDeps, ticket: unknown) {
  const payload = verifyTicket(ticket, deps.secret, deps.now().getTime());
  if (!payload || payload.op !== "get") return undefined;
  const file = await contentAuthorized(deps, payload);
  if (!file) return undefined;
  const object = await deps.storage.openRead(file.storageKey);
  if (!object) return undefined;
  // Re-authorize while the bytes flow: unpublish / new PIN / pause also stops a running download.
  const body = guardStream(object.body, () => contentAuthorized(deps, payload).then(Boolean), deps.streamRecheckMs);
  return { ...object, body, payload };
}

/** The ticket is still backed by live state (file, key, publication epoch, project status). */
async function contentAuthorized(deps: SeeDeps, payload: SeeTicketPayload): Promise<SeeFile | undefined> {
  const file = await deps.repository.getFile(payload.fileId);
  if (!file || file.storageKey !== payload.key || file.status !== "ready" || file.deletedAt) return undefined;
  if (payload.publicationId) {
    const project = await deps.repository.getProject(file.projectId);
    const publication = project ? await deps.repository.getPublicationByProject(project.id) : undefined;
    const gate = publicGate(publication, project);
    if (gate.state !== "open" || publication!.id !== payload.publicationId || publication!.accessEpoch !== payload.epoch) return undefined;
    if (!snapshotReferencesFile(publication!.snapshot!, file.id)) return undefined;
  } else {
    const project = await deps.repository.getProject(file.projectId);
    if (!project || project.status === "deleted") return undefined;
  }
  return file;
}

/**
 * Pass-through stream that calls stillAllowed at most every intervalMs while data is pulled and
 * aborts the response as soon as access is gone.
 */
export function guardStream(source: ReadableStream<Uint8Array>, stillAllowed: () => Promise<boolean>, intervalMs: number, clock: () => number = Date.now): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let lastCheck = clock();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (clock() - lastCheck >= intervalMs) {
        lastCheck = clock();
        let allowed = false;
        try {
          allowed = await stillAllowed();
        } catch {
          allowed = false;
        }
        if (!allowed) {
          await reader.cancel().catch(() => undefined);
          controller.error(new Error("HWS SEE access revoked"));
          return;
        }
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

