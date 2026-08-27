/**
 * Visualization v2 — pure domain logic for customer renders: capture resolution/format/
 * background contracts, filename building, "latest render per view" selection, and the
 * lightweight content-fingerprint staleness signal. No THREE.js, no React, no I/O — everything
 * here is plain data in, plain data out, so it's testable without a live WebGL context. The
 * actual capture mechanics live in components/configurator/BoothCadViewer.tsx (the one shared
 * 3D engine); this module only describes the CONTRACT that capture must honor.
 */
import type { ArtworkPlacement, GraphicFileReference, PrintSurfaceAssignment, ProjectRecord, VisualizationItem } from "./project.ts";
import type { PlacedComponent } from "./models.ts";
import { deduplicateFileNames, sanitizeFileNameSegment } from "./graphicsFileNaming.ts";

// ============================================================================
// Resolution / format / background contract
// ============================================================================

export type CustomerCaptureResolutionPreset = "standard" | "fullhd" | "print";

/** Exact numbers from the report — fixed aspect ratios, never derived from the live viewport. */
export const CUSTOMER_CAPTURE_RESOLUTIONS: Readonly<Record<CustomerCaptureResolutionPreset, Readonly<{ widthPx: number; heightPx: number; label: string }>>> = {
  standard: { widthPx: 1600, heightPx: 1200, label: "Standard" },
  fullhd: { widthPx: 1920, heightPx: 1080, label: "Full HD" },
  print: { widthPx: 2400, heightPx: 1800, label: "Print" },
};

export type CustomerRenderFormat = "png" | "jpeg";
export type CustomerRenderBackgroundMode = "white" | "light-neutral" | "transparent";

/** Transparent background only ever makes sense for PNG — JPEG has no alpha channel. */
export function isBackgroundModeAllowed(format: CustomerRenderFormat, backgroundMode: CustomerRenderBackgroundMode): boolean {
  return !(format === "jpeg" && backgroundMode === "transparent");
}

// ============================================================================
// Filename
// ============================================================================

/** Report section 11: "FOR_<EVENT>_<PROJECT>_<ViewName>.<ext>", same sanitizer/convention as buildGraphicsProductionPackageName (domain/graphicsProduction.ts) — never a second naming scheme. */
export function buildVisualizationRenderFileName(input: Readonly<{
  eventName: string;
  projectName: string;
  viewName: string;
  extension: "png" | "jpg";
}>): string {
  const event = sanitizeFileNameSegment(input.eventName).toUpperCase();
  const project = sanitizeFileNameSegment(input.projectName);
  const view = sanitizeFileNameSegment(input.viewName);
  const base = [event, project, view].filter(Boolean).join("_");
  return `FOR_${base}.${input.extension}`;
}

/** Report section 22: "FOR_<EVENT>_<PROJECT>_VIZUALIZACE" ZIP root folder name — same convention as buildGraphicsProductionPackageName (domain/graphicsProduction.ts). */
export function buildVisualizationPackageName(input: Readonly<{ eventName: string; projectName: string }>): string {
  const event = sanitizeFileNameSegment(input.eventName).toUpperCase();
  const project = sanitizeFileNameSegment(input.projectName);
  return `FOR_${[event, project, "VIZUALIZACE"].filter(Boolean).join("_")}`;
}

export type NamedRenderFile = Readonly<{ viewId: string; fileName: string }>;

/** Batch naming: build one raw name per view, then dedup with the SAME -2/-3 scheme graphicsExport.ts already uses (never a second copy) — for two saved views that share a name after independent renames. */
export function deduplicateRenderFileNames(files: readonly NamedRenderFile[]): readonly NamedRenderFile[] {
  return deduplicateFileNames(files, (file) => file.fileName, (file, fileName) => ({ ...file, fileName }));
}

// ============================================================================
// Latest render per view — pure derived selectors, never a redundant stored pointer
// ============================================================================

/**
 * Visualization v3: shared implementation behind every "latest render for a view" selector,
 * parameterized by which VisualizationItem.type(s) count — so admitting "ai" renders (v3) never
 * meant duplicating this logic a second time. `latestCustomerRenderForView`/
 * `latestCustomerRendersByView` below become thin, still fully backward-compatible wrappers
 * (types: ["customer"]) — every existing call site keeps its exact signature and behavior.
 */
function latestRenderForViewOfTypes(
  renders: readonly VisualizationItem[],
  viewId: string,
  types: readonly VisualizationItem["type"][],
): VisualizationItem | undefined {
  return renders
    .filter((item) => (types as readonly string[]).includes(item.type) && item.viewId === viewId)
    .reduce<VisualizationItem | undefined>(
      (latest, item) => (!latest || item.createdAt > latest.createdAt ? item : latest),
      undefined,
    );
}

function latestRendersByViewOfTypes(
  renders: readonly VisualizationItem[],
  types: readonly VisualizationItem["type"][],
): ReadonlyMap<string, VisualizationItem> {
  const latest = new Map<string, VisualizationItem>();
  for (const item of renders) {
    if (!(types as readonly string[]).includes(item.type) || !item.viewId) continue;
    const existing = latest.get(item.viewId);
    if (!existing || item.createdAt > existing.createdAt) latest.set(item.viewId, item);
  }
  return latest;
}

export function latestCustomerRenderForView(
  renders: readonly VisualizationItem[],
  viewId: string,
): VisualizationItem | undefined {
  return latestRenderForViewOfTypes(renders, viewId, ["customer"]);
}

/** One-pass version of latestCustomerRenderForView for a whole view-card list — avoids re-filtering the renders array once per card. */
export function latestCustomerRendersByView(
  renders: readonly VisualizationItem[],
): ReadonlyMap<string, VisualizationItem> {
  return latestRendersByViewOfTypes(renders, ["customer"]);
}

/** Visualization v3: the AI-render equivalents, same shared implementation. */
export function latestAiRenderForView(
  renders: readonly VisualizationItem[],
  viewId: string,
): VisualizationItem | undefined {
  return latestRenderForViewOfTypes(renders, viewId, ["ai"]);
}

export function latestAiRendersByView(
  renders: readonly VisualizationItem[],
): ReadonlyMap<string, VisualizationItem> {
  return latestRendersByViewOfTypes(renders, ["ai"]);
}

/** Visualization v3: PresentationExportPanel needs "either customer or ai, whichever is latest" per view — the combined-type variant, still the same shared implementation. */
export function latestPresentableRendersByView(
  renders: readonly VisualizationItem[],
): ReadonlyMap<string, VisualizationItem> {
  return latestRendersByViewOfTypes(renders, ["customer", "ai"]);
}

// ============================================================================
// Staleness — content fingerprint, never a timestamp comparison
// (project.modifiedAt is only bumped at whole-project Save time, not per-mutation, so it cannot
// reliably distinguish "edited before" from "edited after" a given render's capture moment)
// and never a full scene/GLB hash (explicitly out of scope — "no complex scene hashing system").
// ============================================================================

export type VisualizationRenderFingerprint = Readonly<{
  boothId: string;
  variantId: string;
  carpetFinishId: string;
  constructionFinishId: string;
  constructionVisibility: Readonly<Record<string, boolean>>;
  sceneObjects: readonly Readonly<{
    id: string;
    definitionId: string;
    xMm: number;
    yMm: number;
    rotationDeg: number;
    widthMm: number;
    depthMm: number;
    heightMm?: number;
    visible: boolean;
    showIn3D: boolean;
  }>[];
  printSurfaceAssignments: readonly Readonly<{
    printSurfaceId: string;
    artworkFileId?: string;
    artworkPlacement?: ArtworkPlacement;
    selectedForPrint: boolean;
  }>[];
  /**
   * ONLY the graphicsFiles entries an assignment actually references (by artworkFileId) — an
   * unrelated/unused graphicsFiles[] entry changing (e.g. a new upload never assigned anywhere)
   * must never flip a render's staleness.
   */
  referencedGraphicsFiles: readonly Readonly<{ id: string; storageKey?: string }>[];
}>;

/**
 * Report sections 14/26: the exhaustive list of project fields that actually feed the live 3D
 * scene a customer render captures — booth/variant identity, furniture placement, artwork
 * assignment/placement, construction visibility, finishes. Deliberately excludes fields that
 * never affect the rendered pixels (internalNote/customerNote/userLocked/displayOrder2D, etc.)
 * so an unrelated bookkeeping edit never falsely flags a render stale. Every array is sorted by
 * its own id so two fingerprints built from the same logical state always compare equal
 * regardless of array insertion order.
 */
export function buildVisualizationRenderFingerprint(
  project: Pick<ProjectRecord, "boothId" | "variantId" | "carpetFinishId" | "constructionFinishId" | "constructionVisibility" | "sceneObjects" | "printSurfaceAssignments" | "graphicsFiles">,
): VisualizationRenderFingerprint {
  const referencedFileIds = [...new Set(
    project.printSurfaceAssignments.map((assignment) => assignment.artworkFileId).filter((id): id is string => Boolean(id)),
  )].sort();
  return {
    boothId: project.boothId,
    variantId: project.variantId,
    carpetFinishId: project.carpetFinishId,
    constructionFinishId: project.constructionFinishId,
    constructionVisibility: project.constructionVisibility,
    sceneObjects: [...project.sceneObjects]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((item: PlacedComponent) => ({
        id: item.id,
        definitionId: item.definitionId,
        xMm: item.xMm,
        yMm: item.yMm,
        rotationDeg: item.rotationDeg,
        widthMm: item.widthMm,
        depthMm: item.depthMm,
        heightMm: item.heightMm,
        visible: item.visible,
        showIn3D: item.showIn3D ?? true,
      })),
    printSurfaceAssignments: [...project.printSurfaceAssignments]
      .sort((left, right) => left.printSurfaceId.localeCompare(right.printSurfaceId))
      .map((assignment: PrintSurfaceAssignment) => ({
        printSurfaceId: assignment.printSurfaceId,
        artworkFileId: assignment.artworkFileId,
        artworkPlacement: assignment.artworkPlacement,
        selectedForPrint: assignment.selectedForPrint,
      })),
    referencedGraphicsFiles: referencedFileIds.map((id) => {
      const file = project.graphicsFiles.find((candidate: GraphicFileReference) => candidate.id === id);
      return { id, storageKey: file?.asset?.storageKey ?? file?.storageKey };
    }),
  };
}

/** Both fingerprints are always built by buildVisualizationRenderFingerprint (fixed field order, pre-sorted arrays), so a canonical-JSON comparison is exact — never a hand-maintained field-by-field diff that could drift out of sync with the type above. */
export function fingerprintsEqual(a: VisualizationRenderFingerprint, b: VisualizationRenderFingerprint): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export type RenderStalenessResult = "current" | "possibly-outdated" | "unknown";

/**
 * Report section 14/34: never report "possibly-outdated" when we can't reliably tell — a
 * technical render (no fingerprint concept at all) or a customer/ai render captured before this
 * fingerprint mechanism existed (contentFingerprint undefined) is always "unknown", and the UI
 * treats "unknown" identically to "current" (no warning badge). Only an ACTUAL fingerprint
 * mismatch against the live project ever produces "possibly-outdated". Visualization v3: "ai"
 * admitted alongside "customer" — an AI render's contentFingerprint is copied verbatim from its
 * source customer render at generation time (domain/visualizationAi.ts's
 * createAiVisualizationRender), so comparing it against the CURRENT live fingerprint here
 * transitively answers "is the render's source now stale" with no separate algorithm needed.
 */
export function evaluateRenderStaleness(
  render: Pick<VisualizationItem, "type" | "contentFingerprint">,
  currentFingerprint: VisualizationRenderFingerprint,
): RenderStalenessResult {
  if (render.type !== "customer" && render.type !== "ai") return "unknown";
  if (!render.contentFingerprint) return "unknown";
  return fingerprintsEqual(render.contentFingerprint, currentFingerprint) ? "current" : "possibly-outdated";
}
