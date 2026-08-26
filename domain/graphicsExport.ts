/**
 * Graphics Export v1 — the reusable, non-React builder behind both export modes ("Export A":
 * dimensions for every available printable surface; "Export B": an overview of surfaces that
 * already have artwork assigned). One generic row per PrintSurface, built entirely from
 * PrintSurface/PrintSurfaceAssignment/GraphicFileReference/resolveProductionPrintSurface — never
 * a P86-only code path, so a future printable component (a counter front, ...) needs zero new
 * export code as long as it has a valid PrintSurface.
 *
 * Selection (which surfaces the user checked before exporting) is a UI/export-session concern
 * only (report section 18) — this module never reads or writes it; callers pass a Set of ids in.
 */
import type { BoothType, ComponentDefinition, PrintSurface, PrintSurfaceFace } from "./models.ts";
import type { ArtworkPlacement, GraphicFileReference, PrintSurfaceAssignment } from "./project.ts";
import type { StoredAsset } from "./assets.ts";
import type { PricingContext } from "./catalog.ts";
import {
  resolveGraphicsSurfacePricing,
  resolveProductionPrintSurface,
  type GraphicsSurfacePricingResult,
} from "./technicalServices.ts";
import { buildSurfaceExportFileName, deduplicateFileNames, printSurfaceHumanLabelParts } from "./graphicsFileNaming.ts";

export type GraphicsExportRow = Readonly<{
  printSurfaceId: string;
  groupId: string;
  groupName: string;
  /** Panel/component label within the group, e.g. "Panel 1", or "Límec" when the surface has no distinct panel identity of its own. */
  name: string;
  face: PrintSurfaceFace;
  canonicalWidthMm: number;
  canonicalHeightMm: number;
  productionWidthMm: number;
  productionHeightMm: number;
  bleedLeftMm: number;
  bleedRightMm: number;
  bleedTopMm: number;
  bleedBottomMm: number;
  realizationProfileId: string;
  artworkFileId?: string;
  artworkOriginalFileName?: string;
  artworkDisplayName?: string;
  artworkUsageRole?: "preview" | "print-data";
  /** Surface-specific export name for the assigned artwork's real file (see graphicsFileNaming.ts) — undefined when no artwork is assigned. Deduplicated across the whole row set (see buildGraphicsExportRows). */
  exportFileName?: string;
  artworkPlacement?: ArtworkPlacement;
  /** For UI preview resolution via the existing useAssetUrl hook — never a pre-resolved URL (those are signed/expiring and resolved elsewhere in this app the same way). */
  artworkAsset?: StoredAsset;
  /**
   * Report sections 14-19: the SAME resolveGraphicsSurfacePricing result the main project
   * calculation's quantity math is built from — computed for EVERY row regardless of whether
   * artwork is assigned (Export A prices a selected-but-empty surface too). Never a second m²/bm
   * formula living in the export UI.
   */
  pricing: GraphicsSurfacePricingResult;
}>;

const SORT_GROUP_FALLBACK_ID = "other";

function groupSortKey(surface: Pick<PrintSurface, "group" | "order">): number {
  return (surface.group?.order ?? 0) * 1000 + (surface.order ?? 0);
}

/**
 * The single generic row builder both export modes read from. `realizationProfileId` is always
 * resolved fresh via resolveProductionPrintSurface — a persisted PrintSurfaceAssignment.
 * productionWidthMm/HeightMm snapshot is never read here as the source of truth (report section
 * 20; consistent with Graphics Production v3's existing rule).
 */
export function buildGraphicsExportRows(
  booth: Pick<BoothType, "printSurfaces" | "packageContents">,
  assignments: readonly PrintSurfaceAssignment[],
  graphicsFiles: readonly GraphicFileReference[],
  realizationProfileId: string,
  catalogItems: readonly ComponentDefinition[],
  pricingContext: PricingContext,
): readonly GraphicsExportRow[] {
  const surfaces = (booth.printSurfaces ?? [])
    .filter((surface) => surface.active)
    .slice()
    .sort((left, right) => groupSortKey(left) - groupSortKey(right));

  const rows = surfaces.map((surface): GraphicsExportRow => {
    const production = resolveProductionPrintSurface(surface, realizationProfileId);
    const assignment = assignments.find((item) => item.printSurfaceId === surface.id);
    const graphicsFile = assignment?.artworkFileId
      ? graphicsFiles.find((file) => file.id === assignment.artworkFileId)
      : undefined;
    const originalFileName = graphicsFile?.asset?.originalFileName ?? graphicsFile?.name;
    const { groupLabel, panelLabel } = printSurfaceHumanLabelParts(surface);
    return {
      printSurfaceId: surface.id,
      groupId: surface.group?.id ?? SORT_GROUP_FALLBACK_ID,
      groupName: groupLabel,
      name: panelLabel,
      face: surface.sceneBinding?.face ?? "front",
      canonicalWidthMm: production.canonicalWidthMm,
      canonicalHeightMm: production.canonicalHeightMm,
      productionWidthMm: production.productionWidthMm,
      productionHeightMm: production.productionHeightMm,
      bleedLeftMm: production.bleedLeftMm,
      bleedRightMm: production.bleedRightMm,
      bleedTopMm: production.bleedTopMm,
      bleedBottomMm: production.bleedBottomMm,
      realizationProfileId,
      artworkFileId: graphicsFile?.id,
      artworkOriginalFileName: originalFileName,
      artworkDisplayName: graphicsFile?.asset?.displayName ?? graphicsFile?.name,
      artworkUsageRole: graphicsFile ? graphicsFile.usageRole ?? "preview" : undefined,
      exportFileName: originalFileName ? buildSurfaceExportFileName(surface, originalFileName) : undefined,
      artworkPlacement: assignment?.artworkPlacement,
      artworkAsset: graphicsFile?.asset,
      pricing: resolveGraphicsSurfacePricing(surface, booth, realizationProfileId, catalogItems, pricingContext),
    };
  });

  return deduplicateExportFileNames(rows);
}

/**
 * Report section 6: two DIFFERENT surfaces producing the same generated exportFileName (never
 * expected in practice, but never assumed impossible either — e.g. a future component reusing an
 * identical group/panel/face label) get a deterministic `-2`, `-3`, ... suffix on every
 * repeat after the first, in the same stable group/order sort the rows already carry. Never a
 * random/UUID suffix. Thin wrapper over graphicsFileNaming.ts's generic deduplicateFileNames —
 * Visualization v2 reuses that same generic helper for render filenames instead of a second copy.
 */
function deduplicateExportFileNames(rows: readonly GraphicsExportRow[]): readonly GraphicsExportRow[] {
  return deduplicateFileNames(rows, (row) => row.exportFileName, (row, name) => ({ ...row, exportFileName: name }));
}

export type GraphicsExportGroup = Readonly<{ id: string; name: string; rows: readonly GraphicsExportRow[] }>;

/** Groups an already-built row list for the "select whole group" / grouped display UI — order preserved from buildGraphicsExportRows. */
export function groupGraphicsExportRows(rows: readonly GraphicsExportRow[]): readonly GraphicsExportGroup[] {
  const groups: GraphicsExportGroup[] = [];
  for (const row of rows) {
    const existing = groups.find((group) => group.id === row.groupId);
    if (existing) (existing.rows as GraphicsExportRow[]).push(row);
    else groups.push({ id: row.groupId, name: row.groupName, rows: [row] });
  }
  return groups;
}

/** Export A: dimensions for every user-selected surface, regardless of whether artwork is assigned. Selection is caller-owned UI state (report section 18) — never persisted here. */
export function buildGraphicsDimensionExportRows(
  rows: readonly GraphicsExportRow[],
  selectedPrintSurfaceIds: ReadonlySet<string>,
): readonly GraphicsExportRow[] {
  return rows.filter((row) => selectedPrintSurfaceIds.has(row.printSurfaceId));
}

/** Export B: only surfaces that already have artwork assigned, optionally further narrowed by the user's per-row enable/disable toggle before export. */
export function buildAssignedArtworkExportRows(
  rows: readonly GraphicsExportRow[],
  enabledPrintSurfaceIds?: ReadonlySet<string>,
): readonly GraphicsExportRow[] {
  return rows.filter((row) => row.artworkFileId !== undefined && (!enabledPrintSurfaceIds || enabledPrintSurfaceIds.has(row.printSurfaceId)));
}

/**
 * Report section 17: "GRAFIKA CELKEM" — the sum of ONLY the rows actually included in the
 * current export (whichever the caller passes: Export A's selection or Export B's assigned-
 * artwork rows), never the whole project's booth/furniture/other calculation. A row with a
 * missing pricing rate (totalNet undefined) contributes 0 to the subtotal, not NaN — the missing
 * configuration is surfaced per-row instead (see resolveGraphicsSurfacePricing's "needs-quote").
 */
export function graphicsExportSubtotal(rows: readonly GraphicsExportRow[]): number {
  return rows.reduce((sum, row) => sum + (row.pricing.totalNet ?? 0), 0);
}
