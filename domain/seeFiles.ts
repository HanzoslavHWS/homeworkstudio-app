/**
 * HWS SEE upload rules. Pure. Only GLB models, PDF/JPG/PNG documents and JPG/PNG/WebP pictures (for
 * annotations and the information panel) are accepted — the type is
 * checked three times: declared MIME + extension at presign, real size via HEAD and the leading
 * magic bytes of the stored object at "complete" (lib/see/service.server.ts).
 */
import { SeeValidationError, type SeeFileKind } from "./seeProject.ts";

export type SeeUploadLimits = Readonly<{
  maxModelBytes: number;
  maxDocumentBytes: number;
  /** pictures in annotations / information panel */
  maxImageBytes: number;
  /** all live files of one project together (abuse / cost protection instead of a scene count) */
  maxProjectBytes: number;
}>;

export const DEFAULT_SEE_UPLOAD_LIMITS: SeeUploadLimits = { maxModelBytes: 200_000_000, maxDocumentBytes: 50_000_000, maxImageBytes: 5_000_000, maxProjectBytes: 3_000_000_000 };

/** SEE_MAX_MODEL_MB / SEE_MAX_DOCUMENT_MB / SEE_MAX_IMAGE_MB / SEE_MAX_PROJECT_MB (optional, bounded so a typo cannot open the gate wide). */
export function readSeeUploadLimits(environment: Readonly<Record<string, string | undefined>>): SeeUploadLimits {
  const megabytes = (value: string | undefined, fallback: number, ceiling: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, ceiling) * 1_000_000 : fallback;
  };
  return {
    maxModelBytes: megabytes(environment.SEE_MAX_MODEL_MB, DEFAULT_SEE_UPLOAD_LIMITS.maxModelBytes, 1000),
    maxDocumentBytes: megabytes(environment.SEE_MAX_DOCUMENT_MB, DEFAULT_SEE_UPLOAD_LIMITS.maxDocumentBytes, 500),
    maxImageBytes: megabytes(environment.SEE_MAX_IMAGE_MB, DEFAULT_SEE_UPLOAD_LIMITS.maxImageBytes, 20),
    maxProjectBytes: megabytes(environment.SEE_MAX_PROJECT_MB, DEFAULT_SEE_UPLOAD_LIMITS.maxProjectBytes, 50_000),
  };
}

const KIND_TYPES: Readonly<Record<SeeFileKind, Readonly<Record<string, readonly string[]>>>> = {
  model: { "model/gltf-binary": ["glb"] },
  document: { "application/pdf": ["pdf"], "image/jpeg": ["jpg", "jpeg"], "image/png": ["png"] },
  image: { "image/jpeg": ["jpg", "jpeg"], "image/png": ["png"], "image/webp": ["webp"] },
};

export const SEE_ACCEPT_ATTRIBUTE: Readonly<Record<SeeFileKind, string>> = {
  model: ".glb,model/gltf-binary",
  document: ".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png",
  image: ".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp",
};

/** Browsers often report "" or application/octet-stream for .glb; the extension decides then. */
export function seeMimeTypeFor(fileName: string, reportedType: string | undefined): string {
  const extension = fileName.toLowerCase().split(".").pop() ?? "";
  const byExtension = ({ glb: "model/gltf-binary", pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" } as Record<string, string>)[extension];
  if (reportedType && reportedType !== "application/octet-stream" && reportedType !== "") return reportedType === "image/jpg" ? "image/jpeg" : reportedType;
  return byExtension ?? reportedType ?? "application/octet-stream";
}

export type SeeUploadRequest = Readonly<{ kind: SeeFileKind; fileName: string; mimeType: string; sizeBytes: number }>;

export function validateSeeUpload(input: Readonly<{ kind?: unknown; fileName?: unknown; mimeType?: unknown; sizeBytes?: unknown }>, limits: SeeUploadLimits): SeeUploadRequest & Readonly<{ extension: string }> {
  if (input.kind !== "model" && input.kind !== "document" && input.kind !== "image") throw new SeeValidationError("Neznámý druh souboru.");
  const kind = input.kind;
  const fileName = typeof input.fileName === "string" ? input.fileName.trim() : "";
  if (!fileName || fileName.length > 255 || /[\\/]/u.test(fileName)) throw new SeeValidationError("Neplatný název souboru.");
  const mimeType = typeof input.mimeType === "string" ? input.mimeType : "";
  const allowedExtensions = KIND_TYPES[kind][mimeType];
  if (!allowedExtensions) {
    throw new SeeValidationError(kind === "model" ? "3D model musí být soubor .glb." : kind === "image" ? "Obrázek může být jen JPG, PNG nebo WebP." : "Dokumentace může být jen PDF, JPG nebo PNG.");
  }
  const extension = fileName.toLowerCase().match(/\.([a-z0-9]{1,5})$/u)?.[1] ?? "";
  if (!allowedExtensions.includes(extension)) throw new SeeValidationError("Přípona souboru neodpovídá jeho typu.");
  const sizeBytes = input.sizeBytes;
  const maxBytes = kind === "model" ? limits.maxModelBytes : kind === "image" ? limits.maxImageBytes : limits.maxDocumentBytes;
  if (typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) throw new SeeValidationError("Soubor je prázdný nebo má neplatnou velikost.");
  if (sizeBytes > maxBytes) throw new SeeValidationError(`Soubor překračuje limit ${Math.round(maxBytes / 1_000_000)} MB.`, 413);
  return { kind, fileName, mimeType, sizeBytes, extension: extension === "jpeg" ? "jpg" : extension };
}

/**
 * Opaque object key: `<prefix>/o/<uuid>.<ext>`. It deliberately carries no project id or file name,
 * because a short-lived signed GET URL necessarily shows its key to the visitor.
 */
export function createSeeStorageKey(prefix: string, extension: string, uniqueId: string = crypto.randomUUID()): string {
  const cleanPrefix = normalizeSeePrefix(prefix);
  if (!/^[0-9a-f-]{36}$/u.test(uniqueId)) throw new SeeValidationError("Neplatný identifikátor objektu.");
  if (!/^[a-z0-9]{1,5}$/u.test(extension)) throw new SeeValidationError("Neplatná přípona.");
  return `${cleanPrefix}/o/${uniqueId}.${extension}`;
}

export function normalizeSeePrefix(prefix: string | undefined): string {
  const value = (prefix ?? "").trim().replace(/^\/+|\/+$/gu, "") || "hws-see";
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/u.test(value)) throw new SeeValidationError("SEE_R2_PREFIX smí obsahovat jen malá písmena, číslice a pomlčky.");
  return value;
}

export function isSeeStorageKey(value: unknown, prefix: string): value is string {
  return typeof value === "string" && new RegExp(`^${normalizeSeePrefix(prefix)}/o/[0-9a-f-]{36}\\.(glb|pdf|jpg|png|webp)$`, "u").test(value);
}

/** Leading bytes really match the declared type (GLB v2 header, %PDF-, PNG signature, JPEG SOI). */
export function magicBytesMatch(mimeType: string, head: Uint8Array): boolean {
  const startsWith = (bytes: readonly number[]) => head.length >= bytes.length && bytes.every((byte, index) => head[index] === byte);
  switch (mimeType) {
    case "model/gltf-binary":
      // "glTF" + uint32 LE version 2
      return startsWith([0x67, 0x6c, 0x54, 0x46]) && head.length >= 8 && head[4] === 2 && head[5] === 0 && head[6] === 0 && head[7] === 0;
    case "application/pdf":
      return startsWith([0x25, 0x50, 0x44, 0x46, 0x2d]);
    case "image/png":
      return startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith([0xff, 0xd8, 0xff]);
    case "image/webp":
      // "RIFF" <size> "WEBP"
      return startsWith([0x52, 0x49, 0x46, 0x46]) && head.length >= 12 && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50;
    default:
      return false;
  }
}

// ───────────────────────────── GLB inspection ─────────────────────────────

/** glTF extensions the HWS SEE viewer (three.js GLTFLoader + Draco + Meshopt + KTX2) can render. */
export const SEE_SUPPORTED_GLTF_EXTENSIONS: ReadonlySet<string> = new Set([
  "KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_meshopt_compression", "KHR_mesh_quantization",
  "KHR_texture_basisu", "KHR_texture_transform", "EXT_texture_webp", "EXT_texture_avif",
  "KHR_lights_punctual", "EXT_mesh_gpu_instancing", "EXT_materials_bump",
  "KHR_materials_unlit", "KHR_materials_emissive_strength", "KHR_materials_clearcoat", "KHR_materials_dispersion",
  "KHR_materials_ior", "KHR_materials_sheen", "KHR_materials_specular", "KHR_materials_transmission",
  "KHR_materials_iridescence", "KHR_materials_anisotropy", "KHR_materials_volume",
]);

/** Largest JSON chunk the server reads for inspection (geometry/textures live in the BIN chunk). */
export const SEE_GLB_JSON_INSPECT_LIMIT = 16_000_000;

export type SeeModelInfo = Readonly<{
  generator?: string;
  meshes: number;
  primitives: number;
  materials: number;
  textures: number;
  images: number;
  /** image MIME types used (image/ktx2, image/png, image/jpeg, image/webp …) */
  imageTypes: readonly string[];
  triangles: number;
  draco: boolean;
  meshopt: boolean;
  ktx2: boolean;
  extensionsUsed: readonly string[];
  extensionsRequired: readonly string[];
  unsupportedRequired: readonly string[];
}>;

/** Bytes needed to read the GLB header and the whole JSON chunk (0 = not a GLB v2 header). */
export function glbJsonChunkEnd(head: Uint8Array): number {
  if (head.length < 20 || !magicBytesMatch("model/gltf-binary", head)) return 0;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const jsonLength = view.getUint32(12, true);
  const chunkType = view.getUint32(16, true);
  return chunkType === 0x4e4f534a ? 20 + jsonLength : 0;
}

type GltfJson = {
  asset?: { version?: unknown; generator?: unknown };
  extensionsUsed?: unknown;
  extensionsRequired?: unknown;
  meshes?: { primitives?: { mode?: number; indices?: number; attributes?: { POSITION?: number }; extensions?: Record<string, unknown> }[] }[];
  materials?: unknown[];
  textures?: unknown[];
  images?: { mimeType?: unknown; uri?: unknown }[];
  accessors?: { count?: unknown }[];
};

/**
 * Reads the GLB JSON chunk (no geometry decoding): validates glTF 2.0, collects extensions and
 * scene statistics, and lists REQUIRED extensions the viewer cannot render (upload is refused).
 */
export function inspectGlb(bytes: Uint8Array): SeeModelInfo {
  const end = glbJsonChunkEnd(bytes);
  if (!end) throw new SeeValidationError("Soubor není platný GLB (glTF 2.0 binary).", 422);
  if (end > bytes.length) throw new SeeValidationError("Hlavička GLB je poškozená (neúplný JSON blok).", 422);
  let json: GltfJson;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, end)).replace(/[\u0000\s]+$/u, "")) as GltfJson;
  } catch {
    throw new SeeValidationError("GLB obsahuje poškozená metadata (JSON).", 422);
  }
  const version = typeof json.asset?.version === "string" ? json.asset.version : "";
  if (!/^2\./u.test(version)) throw new SeeValidationError("Podporován je jen glTF 2.0.", 422);
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").slice(0, 100) : []);
  const extensionsUsed = strings(json.extensionsUsed);
  const extensionsRequired = strings(json.extensionsRequired);
  const accessorCount = (index: unknown) => {
    const count = typeof index === "number" ? Number(json.accessors?.[index]?.count) : NaN;
    return Number.isFinite(count) && count > 0 ? count : 0;
  };
  let primitives = 0;
  let triangles = 0;
  for (const mesh of Array.isArray(json.meshes) ? json.meshes : []) {
    for (const primitive of Array.isArray(mesh?.primitives) ? mesh.primitives : []) {
      primitives += 1;
      const mode = primitive?.mode ?? 4;
      if (mode !== 4 && mode !== 5 && mode !== 6) continue;
      const vertices = primitive.indices !== undefined ? accessorCount(primitive.indices) : accessorCount(primitive.attributes?.POSITION);
      triangles += mode === 4 ? Math.floor(vertices / 3) : Math.max(0, vertices - 2);
    }
  }
  const images = Array.isArray(json.images) ? json.images : [];
  const imageTypes = [...new Set(images.map((image) => (typeof image?.mimeType === "string" ? image.mimeType : typeof image?.uri === "string" ? "uri" : "unknown")))].sort();
  const generator = typeof json.asset?.generator === "string" ? json.asset.generator.slice(0, 120) : undefined;
  return {
    ...(generator ? { generator } : {}),
    meshes: Array.isArray(json.meshes) ? json.meshes.length : 0,
    primitives,
    materials: Array.isArray(json.materials) ? json.materials.length : 0,
    textures: Array.isArray(json.textures) ? json.textures.length : 0,
    images: images.length,
    imageTypes,
    triangles,
    draco: extensionsUsed.includes("KHR_draco_mesh_compression"),
    meshopt: extensionsUsed.includes("EXT_meshopt_compression") || extensionsUsed.includes("KHR_meshopt_compression"),
    ktx2: extensionsUsed.includes("KHR_texture_basisu") || imageTypes.includes("image/ktx2"),
    extensionsUsed,
    extensionsRequired,
    unsupportedRequired: extensionsRequired.filter((name) => !SEE_SUPPORTED_GLTF_EXTENSIONS.has(name)),
  };
}

/** Practical optimization hints shown in the editor (Czech). Never blocks the upload. */
export function modelOptimizationHints(info: SeeModelInfo, sizeBytes: number): readonly string[] {
  const hints: string[] = [];
  if (!info.draco && !info.meshopt && (sizeBytes > 20_000_000 || info.triangles > 500_000)) {
    hints.push("Geometrie není komprimovaná — export s Draco nebo Meshopt kompresí výrazně zmenší soubor a zrychlí načítání na mobilu.");
  }
  if (info.images > 0 && !info.ktx2 && sizeBytes > 15_000_000) {
    hints.push("Textury jsou PNG/JPEG — převod na KTX2 (Basis Universal) sníží paměť GPU a zrychlí mobilní zařízení při zachování PBR kvality.");
  }
  if (info.triangles > 2_000_000) hints.push(`Model má cca ${Math.round(info.triangles / 100_000) / 10} mil. trojúhelníků — na slabších telefonech může být pomalý; zvažte zjednodušení.`);
  if (info.primitives > 1500) hints.push(`Model má ${info.primitives} samostatných částí — sloučení materiálů/meshí sníží počet vykreslovacích volání.`);
  if (info.imageTypes.includes("uri")) hints.push("Model odkazuje na externí textury (URI) — v GLB se nenačtou; exportujte s vestavěnými texturami.");
  return hints;
}
