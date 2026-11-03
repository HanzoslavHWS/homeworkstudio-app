import { assetCategoryMaxBytes, type AssetCategory, type SourceAssetKind, type StoredAsset } from "./assets.ts";

/**
 * Catalog card → "Nahrát více souborů". Pure planning: suggests where each selected file goes by
 * its extension (only a suggestion — the server still validates type and size of every upload),
 * keeps at most ONE main photo and ONE active GLB in a batch, and builds the single card edit that
 * appends the uploaded files. Existing files are never removed; the main photo and the active GLB
 * are replaced only by an explicit choice.
 */

export const BATCH_TARGETS = ["photo_main", "photo_gallery", "model_active", "source_sketchup", "source_dwg", "source_dxf", "source_pdf", "source_other", "skip"] as const;
export type BatchTarget = (typeof BATCH_TARGETS)[number];

export const BATCH_TARGET_LABELS_CS: Readonly<Record<BatchTarget, string>> = {
  photo_main: "Hlavní fotografie",
  photo_gallery: "Fotografie – galerie",
  model_active: "Aktivní 3D model generátoru (GLB)",
  source_sketchup: "Zdrojový model SketchUp (SKP)",
  source_dwg: "CAD podklad (DWG)",
  source_dxf: "CAD podklad (DXF)",
  source_pdf: "Dokument / technický list (PDF)",
  source_other: "Ostatní podklad",
  skip: "Nenahrávat",
};

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];

export function fileExtension(fileName: string): string {
  return fileName.trim().toLowerCase().match(/\.([a-z0-9]{1,10})$/u)?.[1] ?? "";
}

/**
 * What the card uses in its current mode (domain of "Použití v generátoru" 2D/3D + kind):
 * modelAllowed = the active-GLB section is shown (3D on); cadAllowed = SKP/DWG/DXF uploads are
 * shown; documentsAllowed = the "Technický list / dokumentace" (PDF) section is shown.
 */
export type BatchCardState = Readonly<{ hasMainPhoto: boolean; hasModel: boolean; modelAllowed: boolean; cadAllowed: boolean; documentsAllowed: boolean }>;

const CAD_EXTENSIONS = ["skp", "dwg", "dxf"];

/** Targets a file may be put into — limited by the data model, the card's current mode and what the upload categories accept. */
export function batchTargetOptions(fileName: string, card: Omit<BatchCardState, "hasMainPhoto" | "hasModel">): readonly BatchTarget[] {
  const extension = fileExtension(fileName);
  if (IMAGE_EXTENSIONS.includes(extension)) return ["photo_main", "photo_gallery", "skip"];
  if (extension === "glb") return card.modelAllowed ? ["model_active", "skip"] : ["skip"];
  if (CAD_EXTENSIONS.includes(extension) && !card.cadAllowed) return ["skip"];
  if (extension === "skp") return ["source_sketchup", "skip"];
  if (extension === "dwg") return ["source_dwg", "source_other", "skip"];
  if (extension === "dxf") return ["source_dxf", "source_other", "skip"];
  if (extension === "pdf") return card.documentsAllowed ? (card.cadAllowed ? ["source_pdf", "source_other", "skip"] : ["source_pdf", "skip"]) : [];
  return [];
}

export function batchTargetCategory(target: BatchTarget): AssetCategory | undefined {
  if (target === "photo_main" || target === "photo_gallery") return "catalog-photo";
  if (target === "model_active") return "catalog-model";
  if (target.startsWith("source_")) return "catalog-source";
  return undefined;
}

/** MIME type sent for the upload. Source CAD files go as generic binary (browsers report DWG/DXF inconsistently); everything else uses the browser's own type. */
export function batchUploadMimeType(target: BatchTarget, fileName: string): string | undefined {
  if (!target.startsWith("source_")) return undefined;
  return fileExtension(fileName) === "pdf" ? "application/pdf" : "application/octet-stream";
}

const SOURCE_KIND_OF_TARGET: Partial<Record<BatchTarget, SourceAssetKind>> = {
  source_sketchup: "sketchup",
  source_dwg: "dwg",
  source_dxf: "dxf",
  source_pdf: "pdf",
  source_other: "other",
};

export type BatchPlanRow = Readonly<{
  fileName: string;
  size: number;
  target: BatchTarget;
  options: readonly BatchTarget[];
  /** Why the file cannot be uploaded at all (unsupported, empty, too large). */
  error?: string;
  /** Why the suggestion is what it is (e.g. an active GLB is kept). */
  note?: string;
}>;

function sizeError(size: number, target: BatchTarget): string | undefined {
  if (size <= 0) return "Soubor je prázdný.";
  const category = batchTargetCategory(target);
  if (!category) return undefined;
  const max = assetCategoryMaxBytes(category);
  return size > max ? `Soubor překračuje limit ${Math.round(max / 1_000_000)} MB.` : undefined;
}

/** First suggestion for every selected file. */
export function planBatchUpload(files: readonly Readonly<{ name: string; size: number }>[], card: BatchCardState): readonly BatchPlanRow[] {
  const glbCount = files.filter((file) => fileExtension(file.name) === "glb").length;
  let mainTaken = card.hasMainPhoto;
  const rows = files.map((file): BatchPlanRow => {
    const options = batchTargetOptions(file.name, card);
    const extension = fileExtension(file.name);
    if (options.length === 0) {
      const unsupported = extension === "pdf"
        ? "Tato karta dokumenty nepoužívá (dokumenty mají jednotlivé varianty)."
        : `Nepodporovaný typ souboru${extension ? ` (.${extension})` : ""}. Podporováno: JPG, PNG, WebP, GLB, SKP, DWG, DXF, PDF.`;
      return { fileName: file.name, size: file.size, target: "skip", options: [], error: unsupported };
    }
    if (options.length === 1 && options[0] === "skip") {
      // The card does not use this file in its current mode — say so, never file it silently.
      const note = extension === "glb"
        ? "Karta má vypnuté 3D — GLB se nenahraje. Pro 3D model nejdřív zapněte 3D v sekci „Použití v generátoru“."
        : "Karta v aktuálním režimu nepoužívá CAD podklady (služba / bod bez 3D) — soubor se nenahraje.";
      return { fileName: file.name, size: file.size, target: "skip", options, note };
    }
    let target = options[0]!;
    let note: string | undefined;
    if (target === "photo_main") {
      if (mainTaken) target = "photo_gallery";
      else note = "Karta zatím nemá hlavní fotografii.";
      mainTaken = true;
    } else if (target === "model_active") {
      if (card.hasModel) {
        target = "skip";
        note = "Karta už má aktivní 3D model — zůstává. Pro nahrazení zvolte „Aktivní 3D model generátoru“.";
      } else if (glbCount > 1) {
        target = "skip";
        note = "Vybráno více GLB — zvolte, který bude aktivní.";
      }
    }
    const error = sizeError(file.size, target === "skip" ? options[0]! : target);
    return { fileName: file.name, size: file.size, target: error ? "skip" : target, options: error ? [] : options, ...(error ? { error } : {}), ...(note && !error ? { note } : {}) };
  });
  return rows;
}

/**
 * The user changes one row. Keeps the batch consistent: one main photo (a previous choice becomes a
 * gallery photo) and one active GLB (a previous choice becomes "Nenahrávat") — never the last file
 * silently winning over an earlier one.
 */
export function changeBatchTarget(rows: readonly BatchPlanRow[], index: number, target: BatchTarget): readonly BatchPlanRow[] {
  const row = rows[index];
  if (!row || !row.options.includes(target)) return rows;
  return rows.map((candidate, candidateIndex) => {
    if (candidateIndex === index) {
      const { note: _note, ...rest } = candidate;
      return { ...rest, target };
    }
    if (target === "photo_main" && candidate.target === "photo_main") return { ...candidate, target: "photo_gallery" };
    if (target === "model_active" && candidate.target === "model_active") return { ...candidate, target: "skip" };
    return candidate;
  });
}

export type BatchUploaded = Readonly<{ target: BatchTarget; asset: StoredAsset }>;

export type BatchCardEdit = Readonly<{
  photoAsset?: StoredAsset;
  modelAsset?: StoredAsset;
  addGalleryPhotoAssets?: readonly StoredAsset[];
  addSourceAssets?: readonly Readonly<{ kind: SourceAssetKind; asset: StoredAsset }>[];
}>;

/**
 * One card edit for everything that uploaded successfully. A new main photo moves the current one
 * into the gallery (nothing is lost); a new active GLB replaces the reference only because the user
 * chose it explicitly. Files that failed are simply not part of it.
 */
export function buildBatchCardEdit(uploaded: readonly BatchUploaded[], currentMainPhoto: StoredAsset | undefined): BatchCardEdit {
  const main = uploaded.find((entry) => entry.target === "photo_main")?.asset;
  const model = uploaded.find((entry) => entry.target === "model_active")?.asset;
  const gallery = [
    ...(main && currentMainPhoto ? [currentMainPhoto] : []),
    ...uploaded.filter((entry) => entry.target === "photo_gallery").map((entry) => entry.asset),
  ];
  const sources = uploaded.flatMap((entry) => {
    const kind = SOURCE_KIND_OF_TARGET[entry.target];
    return kind ? [{ kind, asset: entry.asset }] : [];
  });
  return {
    ...(main ? { photoAsset: main } : {}),
    ...(model ? { modelAsset: model } : {}),
    ...(gallery.length ? { addGalleryPhotoAssets: gallery } : {}),
    ...(sources.length ? { addSourceAssets: sources } : {}),
  };
}
