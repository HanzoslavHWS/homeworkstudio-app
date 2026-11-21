/**
 * HWS SEE — interní 3D prohlížeč projektů (tools/hws-see/SPEC.md). Pure: no I/O, no crypto.
 *
 * One project = several ALTERNATIVE 3D scenes (Zavřená bedna / Otevřená bedna / Pohled dovnitř),
 * each with its own GLB, camera, look and annotations, plus documents (PDF/JPG/PNG) that belong to
 * "Všechny modely" or to chosen scenes. A project has at most one publication, and a publication
 * has EXACTLY TWO sharing modes: `public` (anyone with the link) or `pin` (server-verified PIN).
 */
import type { SeeEmbedPolicy } from "./seeEmbed.ts";
import type { SeeModelInfo } from "./seeFiles.ts";

export const SEE_PROJECT_STATUSES = ["active", "paused", "archived", "deleted"] as const;
export type SeeProjectStatus = (typeof SEE_PROJECT_STATUSES)[number];

export const SEE_PUBLICATION_MODES = ["public", "pin"] as const;
export type SeePublicationMode = (typeof SEE_PUBLICATION_MODES)[number];

export const SEE_PUBLICATION_STATUSES = ["draft", "published"] as const;
export type SeePublicationStatus = (typeof SEE_PUBLICATION_STATUSES)[number];

export const SEE_PROJECT_STATUS_LABELS_CS: Readonly<Record<SeeProjectStatus, string>> = {
  active: "Aktivní",
  paused: "Pozastavený",
  archived: "Archivovaný",
  deleted: "Smazaný",
};

export const SEE_PUBLICATION_MODE_LABELS_CS: Readonly<Record<SeePublicationMode, string>> = {
  public: "Veřejná prezentace (kdokoli s odkazem)",
  pin: "Chráněná prezentace (PIN)",
};

/** MVP: up to three independent GLB scenes per project; the data model itself has no such limit. */
export const SEE_MAX_SCENES = 3;
export const SEE_MAX_DOCUMENTS = 50;
export const SEE_MAX_ANNOTATIONS_PER_SCENE = 200;

export type SeeVec3 = readonly [number, number, number];

export type SeeCameraView = Readonly<{ position: SeeVec3; target: SeeVec3; fov: number }>;

export const SEE_BACKGROUNDS = ["studio", "white", "dark", "custom"] as const;
export type SeeBackground = (typeof SEE_BACKGROUNDS)[number];
export const SEE_BACKGROUND_LABELS_CS: Readonly<Record<SeeBackground, string>> = {
  studio: "Světlé studio",
  white: "Bílá",
  dark: "Tmavá",
  custom: "Vlastní barva",
};

export const SEE_LIGHTINGS = ["studio", "soft", "contrast"] as const;
export type SeeLighting = (typeof SEE_LIGHTINGS)[number];
export const SEE_LIGHTING_LABELS_CS: Readonly<Record<SeeLighting, string>> = {
  studio: "Studiové světlo (HDRI místnost)",
  soft: "Měkké rovnoměrné",
  contrast: "Kontrastní",
};

export type SeeSceneSettings = Readonly<{
  camera?: SeeCameraView;
  background: SeeBackground;
  backgroundColor: string;
  lighting: SeeLighting;
  exposure: number;
  showAnnotations: boolean;
}>;

export const DEFAULT_SEE_SCENE_SETTINGS: SeeSceneSettings = {
  background: "studio",
  backgroundColor: "#e9ebee",
  lighting: "studio",
  exposure: 1,
  showAnnotations: true,
};

export type SeeActorStamp = Readonly<{ id: string; label: string }>;

export type SeeProject = Readonly<{
  id: string;
  name: string;
  description: string;
  status: SeeProjectStatus;
  createdAt: string;
  createdBy?: SeeActorStamp;
  updatedAt: string;
  updatedBy?: SeeActorStamp;
  deletedAt?: string;
}>;

export type SeeScene = Readonly<{
  id: string;
  projectId: string;
  name: string;
  description: string;
  sortOrder: number;
  modelFileId?: string;
  settings: SeeSceneSettings;
  createdAt: string;
  updatedAt: string;
}>;

export type SeeAnnotation = Readonly<{
  id: string;
  sceneId: string;
  title: string;
  body: string;
  position: SeeVec3;
  normal?: SeeVec3;
  visible: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}>;

export type SeeFileKind = "model" | "document";
export type SeeFileStatus = "pending" | "ready" | "rejected";

export type SeeFile = Readonly<{
  id: string;
  projectId: string;
  kind: SeeFileKind;
  displayName: string;
  originalFileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Server-only. Never sent to a public visitor (see toPublicSnapshot / editorFileView). */
  storageKey: string;
  status: SeeFileStatus;
  /** Documents: true = "Všechny modely"; otherwise sceneIds lists the chosen scenes. */
  appliesToAll: boolean;
  sceneIds: readonly string[];
  sortOrder: number;
  /** Models: result of the server-side GLB inspection at upload (extensions, statistics). */
  modelInfo?: SeeModelInfo;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}>;

/** Published content: an immutable copy taken at "Publikovat", never the live draft. */
export type SeeSnapshotScene = Readonly<{
  id: string;
  name: string;
  description: string;
  modelFileId: string;
  settings: SeeSceneSettings;
  annotations: readonly Readonly<{ id: string; title: string; body: string; position: SeeVec3; normal?: SeeVec3 }>[];
}>;

export type SeeSnapshotDocument = Readonly<{
  id: string;
  displayName: string;
  mimeType: string;
  sizeBytes: number;
  appliesToAll: boolean;
  sceneIds: readonly string[];
}>;

export type SeeSnapshot = Readonly<{
  revision: number;
  publishedAt: string;
  projectName: string;
  projectDescription: string;
  scenes: readonly SeeSnapshotScene[];
  documents: readonly SeeSnapshotDocument[];
}>;

export type SeePublication = Readonly<{
  id: string;
  projectId: string;
  shareSlug: string;
  mode: SeePublicationMode;
  status: SeePublicationStatus;
  /** Server-only. Never leaves the server (see editorPublicationView). */
  pinHash?: string;
  pinSetAt?: string;
  accessEpoch: number;
  snapshot?: SeeSnapshot;
  snapshotRevision: number;
  viewCount: number;
  lastViewedAt?: string;
  /** Who may frame /see/embed/<slug> (domain/seeEmbed.ts). */
  embedPolicy: SeeEmbedPolicy;
  embedOrigins: readonly string[];
  publishedAt?: string;
  publishedBy?: string;
  unpublishedAt?: string;
  createdAt: string;
  updatedAt: string;
}>;

export type SeeProjectAggregate = Readonly<{
  project: SeeProject;
  scenes: readonly SeeScene[];
  annotations: readonly SeeAnnotation[];
  files: readonly SeeFile[];
  publication?: SeePublication;
}>;

export type SeeProjectSummary = Readonly<{
  project: SeeProject;
  sceneCount: number;
  documentCount: number;
  publication?: Readonly<{
    shareSlug: string;
    mode: SeePublicationMode;
    status: SeePublicationStatus;
    publishedAt?: string;
    viewCount: number;
    lastViewedAt?: string;
  }>;
}>;

export type SeeProjectListQuery = Readonly<{
  search?: string;
  status?: SeeProjectStatus | "all";
  publication?: SeePublicationStatus | "all";
  offset: number;
  limit: number;
}>;

export class SeeValidationError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "SeeValidationError";
    this.status = status;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isSeeUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** 32 base62 characters ≈ 190 bits; never a sequential id. */
const SHARE_SLUG_PATTERN = /^[A-Za-z0-9]{24,64}$/u;

export function isValidShareSlug(value: unknown): value is string {
  return typeof value === "string" && SHARE_SLUG_PATTERN.test(value);
}

// eslint-disable-next-line no-control-regex -- strips C0 controls except tab/newline from user text
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

export function cleanText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.replace(CONTROL_CHARS, "").trim().slice(0, maxLength) : "";
}

export function requireName(value: unknown, label: string, maxLength: number): string {
  const name = cleanText(value, maxLength);
  if (!name) throw new SeeValidationError(`${label} je povinný údaj.`);
  return name;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseVec3(value: unknown): SeeVec3 | undefined {
  if (!Array.isArray(value) || value.length !== 3) return undefined;
  const numbers = value.map(finiteNumber);
  if (numbers.some((entry) => entry === undefined || Math.abs(entry) > 1e7)) return undefined;
  return [numbers[0]!, numbers[1]!, numbers[2]!];
}

const HEX_COLOR = /^#[0-9a-f]{6}$/iu;

/** Accepts untrusted JSON and returns complete, bounded settings (unknown keys dropped). */
export function normalizeSceneSettings(value: unknown): SeeSceneSettings {
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const cameraInput = (input.camera && typeof input.camera === "object" ? input.camera : undefined) as Record<string, unknown> | undefined;
  const position = parseVec3(cameraInput?.position);
  const target = parseVec3(cameraInput?.target);
  const fov = finiteNumber(cameraInput?.fov);
  const camera = position && target ? { position, target, fov: fov && fov >= 10 && fov <= 100 ? fov : 45 } : undefined;
  const exposure = finiteNumber(input.exposure);
  return {
    ...(camera ? { camera } : {}),
    background: (SEE_BACKGROUNDS as readonly string[]).includes(input.background as string) ? input.background as SeeBackground : DEFAULT_SEE_SCENE_SETTINGS.background,
    backgroundColor: typeof input.backgroundColor === "string" && HEX_COLOR.test(input.backgroundColor) ? input.backgroundColor.toLowerCase() : DEFAULT_SEE_SCENE_SETTINGS.backgroundColor,
    lighting: (SEE_LIGHTINGS as readonly string[]).includes(input.lighting as string) ? input.lighting as SeeLighting : DEFAULT_SEE_SCENE_SETTINGS.lighting,
    exposure: exposure !== undefined ? Math.min(3, Math.max(0.2, exposure)) : DEFAULT_SEE_SCENE_SETTINGS.exposure,
    showAnnotations: typeof input.showAnnotations === "boolean" ? input.showAnnotations : DEFAULT_SEE_SCENE_SETTINGS.showAnnotations,
  };
}

export function resolveBackgroundColor(settings: SeeSceneSettings): string {
  switch (settings.background) {
    case "white": return "#ffffff";
    case "dark": return "#1d2024";
    case "custom": return settings.backgroundColor;
    default: return "#e9ebee";
  }
}

/** Status transitions offered in Projekty. Anything else is refused by the server. */
export const SEE_STATUS_ACTIONS = ["pause", "resume", "archive", "restore", "delete"] as const;
export type SeeStatusAction = (typeof SEE_STATUS_ACTIONS)[number];

export function nextProjectStatus(current: SeeProjectStatus, action: SeeStatusAction): SeeProjectStatus | undefined {
  if (current === "deleted") return undefined;
  switch (action) {
    case "pause": return current === "active" ? "paused" : undefined;
    case "resume": return current === "paused" ? "active" : undefined;
    case "archive": return current === "active" || current === "paused" ? "archived" : undefined;
    case "restore": return current === "archived" ? "active" : undefined;
    case "delete": return "deleted";
  }
}

/** Only these statuses may ever serve a public link, embed or file — server-side rule. */
export function projectServesPublicly(status: SeeProjectStatus): boolean {
  return status === "active";
}

export type SeePublicGate =
  | Readonly<{ state: "not-found" }>
  | Readonly<{ state: "unavailable"; reason: "paused" | "archived" | "unpublished" }>
  | Readonly<{ state: "open"; mode: SeePublicationMode }>;

/** The publication/project part of public access; the PIN grant check comes on top for `pin`. */
export function publicGate(publication: SeePublication | undefined, project: SeeProject | undefined): SeePublicGate {
  if (!publication || !project || project.status === "deleted") return { state: "not-found" };
  if (project.status === "paused") return { state: "unavailable", reason: "paused" };
  if (project.status === "archived") return { state: "unavailable", reason: "archived" };
  if (publication.status !== "published" || !publication.snapshot) return { state: "unavailable", reason: "unpublished" };
  return { state: "open", mode: publication.mode };
}

/** Takes the publishable content of the current draft. Throws when there is nothing to show. */
export function buildSnapshot(aggregate: SeeProjectAggregate, revision: number, publishedAt: string): SeeSnapshot {
  const readyModels = new Set(aggregate.files.filter((file) => file.kind === "model" && file.status === "ready" && !file.deletedAt).map((file) => file.id));
  const scenes = [...aggregate.scenes]
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .filter((scene) => scene.modelFileId && readyModels.has(scene.modelFileId))
    .map((scene): SeeSnapshotScene => ({
      id: scene.id,
      name: scene.name,
      description: scene.description,
      modelFileId: scene.modelFileId!,
      settings: scene.settings,
      annotations: aggregate.annotations
        .filter((annotation) => annotation.sceneId === scene.id && annotation.visible)
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map((annotation) => ({ id: annotation.id, title: annotation.title, body: annotation.body, position: annotation.position, ...(annotation.normal ? { normal: annotation.normal } : {}) })),
    }));
  if (!scenes.length) throw new SeeValidationError("Publikovat lze až projekt s alespoň jedním nahraným 3D modelem.", 409);
  const sceneIds = new Set(scenes.map((scene) => scene.id));
  const documents = aggregate.files
    .filter((file) => file.kind === "document" && file.status === "ready" && !file.deletedAt)
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((file): SeeSnapshotDocument => ({
      id: file.id,
      displayName: file.displayName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      appliesToAll: file.appliesToAll,
      sceneIds: file.appliesToAll ? [] : file.sceneIds.filter((id) => sceneIds.has(id)),
    }))
    .filter((document) => document.appliesToAll || document.sceneIds.length > 0);
  return {
    revision,
    publishedAt,
    projectName: aggregate.project.name,
    projectDescription: aggregate.project.description,
    scenes,
    documents,
  };
}

/** Download menu of one scene: documents for "Všechny modely" plus the ones linked to that scene. */
export function documentsForScene<T extends Readonly<{ appliesToAll: boolean; sceneIds: readonly string[] }>>(documents: readonly T[], sceneId: string | undefined): readonly T[] {
  return documents.filter((document) => document.appliesToAll || (sceneId !== undefined && document.sceneIds.includes(sceneId)));
}

/** Is this file id something the published snapshot actually exposes? */
export function snapshotReferencesFile(snapshot: SeeSnapshot, fileId: string): "model" | "document" | undefined {
  if (snapshot.scenes.some((scene) => scene.modelFileId === fileId)) return "model";
  if (snapshot.documents.some((document) => document.id === fileId)) return "document";
  return undefined;
}

/** Is the draft different from what visitors currently see? (for the "neuložené do publikace" hint) */
export function hasUnpublishedChanges(aggregate: SeeProjectAggregate): boolean {
  const publication = aggregate.publication;
  if (!publication?.snapshot || publication.status !== "published") return false;
  try {
    const draft = buildSnapshot(aggregate, publication.snapshot.revision, publication.snapshot.publishedAt);
    return JSON.stringify(draft) !== JSON.stringify(publication.snapshot);
  } catch {
    return true;
  }
}

export function fileDownloadName(file: Readonly<{ displayName: string; mimeType: string }>): string {
  const extension = ({ "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "model/gltf-binary": "glb" } as Record<string, string>)[file.mimeType] ?? "bin";
  const base = file.displayName.replace(/\.(pdf|jpe?g|png|glb)$/iu, "").trim() || "soubor";
  return `${base}.${extension}`;
}

export function formatFileSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1).replace(".", ",")} MB`;
  return `${Math.max(1, Math.round(bytes / 1000))} kB`;
}
