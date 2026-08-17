export const ASSET_CATEGORIES = [
  "event-logo",
  "event-cover",
  "event-document",
  "catalog-photo",
  "catalog-thumbnail",
  "catalog-model",
  "catalog-source",
  "project-graphics",
  "project-document",
  "project-visualization",
  "project-floorplan",
  "project-export",
  "temporary",
] as const;

export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

export type StoredAsset = Readonly<{
  id: string;
  storageKey: string;
  originalFileName: string;
  mimeType: string;
  size: number;
  createdAt: string;
  checksum?: string;
  displayName?: string;
  category: AssetCategory;
}>;

/**
 * Generic source/manufacturing file kinds for catalog items — deliberately NOT a set of
 * hardcoded fields (sketchupAsset/dwgAsset/dxfAsset/...) on the item itself. Each uploaded
 * file becomes one SourceAssetEntry inside ComponentDefinition.sourceAssets[] (domain/
 * models.ts), so adding a new kind later never needs a schema/field change — see
 * domain/catalogReadiness.ts for which kinds are mandatory for activation (sketchup is; dwg/
 * dxf/pdf/other never are).
 */
export const SOURCE_ASSET_KINDS = ["sketchup", "dwg", "dxf", "pdf", "other"] as const;
export type SourceAssetKind = (typeof SOURCE_ASSET_KINDS)[number];

export const SOURCE_ASSET_KIND_LABELS_CS: Readonly<Record<SourceAssetKind, string>> = {
  sketchup: "SketchUp (.skp)",
  dwg: "DWG",
  dxf: "DXF",
  pdf: "PDF",
  other: "Ostatní",
};

/** Extensions accepted for each declared kind, used by the admin upload UI to pick/validate a file client-side. "other" accepts anything the catalog-source category itself allows. */
export const SOURCE_ASSET_KIND_EXTENSIONS: Readonly<Record<SourceAssetKind, readonly string[]>> = {
  sketchup: ["skp"],
  dwg: ["dwg"],
  dxf: ["dxf"],
  pdf: ["pdf"],
  other: ["skp", "dwg", "dxf", "pdf"],
};

export type SourceAssetEntry = Readonly<{
  id: string;
  kind: SourceAssetKind;
  label?: string;
  asset: StoredAsset;
}>;

export type AssetObjectMetadata = Readonly<{
  storageKey: string;
  contentType?: string;
  contentLength?: number;
  etag?: string;
  lastModified?: string;
  customMetadata?: Readonly<Record<string, string>>;
}>;

export type PresignedUpload = Readonly<{
  uploadUrl: string;
  method: "PUT";
  headers: Readonly<Record<string, string>>;
  expiresAt: string;
}>;

export interface AssetStorageProvider {
  readonly id: string;
  createUploadUrl(input: Readonly<{ storageKey: string; mimeType: string; originalFileName: string; checksum?: string; expiresInSeconds?: number }>): Promise<PresignedUpload>;
  getDownloadUrl(storageKey: string, expiresInSeconds?: number): Promise<string>;
  deleteObject(storageKey: string): Promise<void>;
  objectExists(storageKey: string): Promise<boolean>;
  getMetadata(storageKey: string): Promise<AssetObjectMetadata | undefined>;
  listObjects?(prefix: string): Promise<readonly AssetObjectMetadata[]>;
}

type CategoryRule = Readonly<{
  prefix: (ownerId: string) => string;
  maxBytes: number;
  mimeTypes: readonly string[];
}>;

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/svg+xml"] as const;
const DOCUMENT_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
] as const;
const GRAPHICS_TYPES = [...IMAGE_TYPES, "application/pdf", "application/postscript", "application/illustrator"] as const;

const CATEGORY_RULES: Readonly<Record<AssetCategory, CategoryRule>> = {
  "event-logo": { prefix: (id) => `events/${id}/logo`, maxBytes: 5_000_000, mimeTypes: IMAGE_TYPES },
  "event-cover": { prefix: (id) => `events/${id}/cover`, maxBytes: 15_000_000, mimeTypes: IMAGE_TYPES },
  "event-document": { prefix: (id) => `events/${id}/documents`, maxBytes: 40_000_000, mimeTypes: DOCUMENT_TYPES },
  // Section 2 of the catalog-item asset workflow spec: photos are restricted to
  // jpg/jpeg/png/webp only (narrower than the shared IMAGE_TYPES used by event-logo/cover,
  // which also allow gif/svg — those stay untouched, this category is catalog-item-only).
  "catalog-photo": { prefix: (id) => `catalog/furniture/${id}/photos`, maxBytes: 15_000_000, mimeTypes: ["image/jpeg", "image/png", "image/webp"] },
  "catalog-thumbnail": { prefix: (id) => `catalog/furniture/${id}/thumbnails`, maxBytes: 5_000_000, mimeTypes: IMAGE_TYPES },
  // GLB only — this category was previously unused anywhere, so narrowing it away from the
  // generic "application/octet-stream" (which also covers .skp) is safe; nothing else relies
  // on the broader list.
  "catalog-model": { prefix: (id) => `catalog/furniture/${id}/models`, maxBytes: 100_000_000, mimeTypes: ["model/gltf-binary"] },
  // Source/manufacturing files (SKP/DWG/DXF/PDF/other) — real-world browsers rarely report a
  // specific MIME type for CAD authoring formats, so this accepts the generic binary type plus
  // PDF; the actual kind (sketchup/dwg/dxf/pdf/other) is a caller-supplied label on the
  // SourceAssetEntry, never sniffed from mimeType. Size ceiling matches project-export's
  // precedent for large binary deliverables.
  "catalog-source": { prefix: (id) => `catalog/furniture/${id}/source`, maxBytes: 150_000_000, mimeTypes: ["application/octet-stream", "application/pdf"] },
  "project-graphics": { prefix: (id) => `projects/${id}/graphics`, maxBytes: 100_000_000, mimeTypes: GRAPHICS_TYPES },
  "project-document": { prefix: (id) => `projects/${id}/documents`, maxBytes: 40_000_000, mimeTypes: DOCUMENT_TYPES },
  "project-visualization": { prefix: (id) => `projects/${id}/visualizations`, maxBytes: 25_000_000, mimeTypes: IMAGE_TYPES },
  "project-floorplan": { prefix: (id) => `projects/${id}/floorplans`, maxBytes: 25_000_000, mimeTypes: IMAGE_TYPES },
  "project-export": { prefix: (id) => `projects/${id}/exports`, maxBytes: 150_000_000, mimeTypes: ["application/pdf", "application/zip", ...IMAGE_TYPES] },
  temporary: { prefix: () => "temporary", maxBytes: 5_000_000, mimeTypes: ["text/plain", ...IMAGE_TYPES] },
};

const MIME_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  "image/jpeg": ["jpg", "jpeg"], "image/png": ["png"], "image/webp": ["webp"], "image/gif": ["gif"], "image/svg+xml": ["svg"],
  "application/pdf": ["pdf"], "application/msword": ["doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
  "application/vnd.ms-excel": ["xls"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
  "text/plain": ["txt"], "application/postscript": ["ai", "eps", "ps"], "application/illustrator": ["ai"],
  "model/gltf-binary": ["glb"], "application/octet-stream": ["glb", "skp", "dwg", "dxf"], "application/zip": ["zip"],
};

export class AssetValidationError extends Error {
  readonly code: "invalid-category" | "invalid-owner" | "invalid-file" | "invalid-mime" | "oversized" | "invalid-key";

  constructor(message: string, code: "invalid-category" | "invalid-owner" | "invalid-file" | "invalid-mime" | "oversized" | "invalid-key") {
    super(message);
    this.name = "AssetValidationError";
    this.code = code;
  }
}

export function sanitizeStorageSegment(value: string): string {
  const normalized = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const sanitized = normalized.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  if (!sanitized || sanitized === "." || sanitized === "..") throw new AssetValidationError("Neplatný identifikátor cílové entity.", "invalid-owner");
  return sanitized;
}

export function safeFileExtension(fileName: string, mimeType: string): string {
  const extension = fileName.trim().toLowerCase().match(/\.([a-z0-9]{1,10})$/)?.[1];
  const allowed = MIME_EXTENSIONS[mimeType] ?? [];
  if (!extension || !allowed.includes(extension)) throw new AssetValidationError("Přípona souboru neodpovídá povolenému MIME typu.", "invalid-file");
  return extension;
}

export function validateUploadInput(input: Readonly<{ category: string; ownerId: string; originalFileName: string; mimeType: string; size: number }>): asserts input is Readonly<{ category: AssetCategory; ownerId: string; originalFileName: string; mimeType: string; size: number }> {
  if (!ASSET_CATEGORIES.includes(input.category as AssetCategory)) throw new AssetValidationError("Neznámá kategorie assetu.", "invalid-category");
  const rule = CATEGORY_RULES[input.category as AssetCategory];
  sanitizeStorageSegment(input.ownerId);
  if (!input.originalFileName.trim() || input.originalFileName.length > 255) throw new AssetValidationError("Neplatný název souboru.", "invalid-file");
  if (!rule.mimeTypes.includes(input.mimeType)) throw new AssetValidationError("Tento typ souboru není pro zvolenou kategorii povolen.", "invalid-mime");
  if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > rule.maxBytes) throw new AssetValidationError(`Soubor překračuje limit ${Math.round(rule.maxBytes / 1_000_000)} MB nebo má neplatnou velikost.`, "oversized");
  safeFileExtension(input.originalFileName, input.mimeType);
}

export function createStorageKey(input: Readonly<{ category: AssetCategory; ownerId: string; originalFileName: string; mimeType: string }>, uniqueId = crypto.randomUUID()): string {
  const rule = CATEGORY_RULES[input.category];
  const owner = sanitizeStorageSegment(input.ownerId);
  const extension = safeFileExtension(input.originalFileName, input.mimeType);
  const id = sanitizeStorageSegment(uniqueId);
  return `${rule.prefix(owner)}/${id}.${extension}`;
}

export function isValidStorageKey(value: string): boolean {
  return value.length <= 512 && /^(events|catalog|projects|temporary)\/[A-Za-z0-9_./-]+$/u.test(value) && !value.includes("..") && !value.includes("//");
}

export function assertValidStorageKey(value: string): void {
  if (!isValidStorageKey(value)) throw new AssetValidationError("Neplatný storageKey.", "invalid-key");
}

export function preferredAsset(asset: StoredAsset | undefined, legacyUrl: string | undefined): Readonly<{ storageKey?: string; legacyUrl?: string }> {
  return asset?.storageKey ? { storageKey: asset.storageKey, legacyUrl } : { legacyUrl };
}
