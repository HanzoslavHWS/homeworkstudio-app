/**
 * Graphics Production Package v1 — the production handoff to the realization company / print
 * shop: which surfaces have REAL print-data ready, a manifest describing them, and (in
 * lib/graphicsProductionPackage.ts) the actual ZIP built from real R2 bytes. Pure/no I/O here —
 * status classification and manifest shaping only, everything else (dimensions, pricing,
 * naming, dedup) is reused verbatim from the already-built GraphicsExportRow[] (domain/
 * graphicsExport.ts) rather than re-derived, so there is exactly one place each of those
 * concerns lives.
 */
import type { PrintSurfaceFace } from "./models.ts";
import type { ArtworkPlacement, PrintSurfaceAssignment } from "./project.ts";
import type { StoredAsset } from "./assets.ts";
import type { GraphicsSurfacePricingResult } from "./technicalServices.ts";
import type { GraphicsExportRow } from "./graphicsExport.ts";
import { graphicsRowHumanLabel, sanitizeFileNameSegment } from "./graphicsFileNaming.ts";

export type GraphicsProductionStatus = "ready" | "preview-only" | "missing" | "source-missing";

export type GraphicsProductionReadinessRow = Readonly<{
  printSurfaceId: string;
  groupId: string;
  groupName: string;
  name: string;
  face: PrintSurfaceFace;
  displayName: string;
  status: GraphicsProductionStatus;
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
  usageRole?: "preview" | "print-data";
  sourceFileName?: string;
  displayFileName?: string;
  exportFileName?: string;
  artworkAsset?: StoredAsset;
  artworkPlacement?: ArtworkPlacement;
  /** Technical reference only — pricing availability never gates package status/inclusion (report section 19). */
  pricing: GraphicsSurfacePricingResult;
}>;

/**
 * Status precedence (first match wins), evaluated against the ALREADY-RESOLVED GraphicsExportRow
 * plus the raw assignment (needed only to tell "nothing assigned" apart from a resolved-but-
 * assetless GraphicFileReference — see the two artworkFileId checks below):
 *
 * 1. Not selected for print at all -> caller excludes the row entirely (see
 *    buildGraphicsProductionReadiness's filter) — never a 5th status.
 * 2. row.artworkFileId undefined -> MISSING. This covers BOTH "nothing ever assigned" and "the
 *    assignment pointed at a graphicsFile id that no longer exists" — buildGraphicsExportRows
 *    already collapses both into artworkFileId: graphicsFile?.id === undefined, and there is
 *    nothing more specific to tell the user in either case (no file, no bytes, no metadata).
 * 3. row.artworkFileId defined but row.artworkAsset undefined -> SOURCE MISSING. A
 *    GraphicFileReference record resolved, but carries no StoredAsset/storageKey to fetch real
 *    bytes from (report section 22).
 * 4. artworkAsset defined, usageRole === "print-data" -> READY.
 * 5. artworkAsset defined, usageRole "preview" or unset (legacy default) -> PREVIEW ONLY.
 *
 * Deliberately never reads assignment.artworkStatus ("missing"|"received"|"ready") — that is a
 * separate workflow-stage field set elsewhere and not guaranteed to be in sync with whether a
 * real print-data asset actually exists; trusting it here would reintroduce the same "trusted
 * stale snapshot" bug this app already rejected for production dimensions (report section 18).
 */
function deriveGraphicsProductionStatus(row: GraphicsExportRow): GraphicsProductionStatus {
  if (row.artworkFileId === undefined) return "missing";
  if (row.artworkAsset === undefined) return "source-missing";
  return row.artworkUsageRole === "print-data" ? "ready" : "preview-only";
}

/**
 * Candidate universe = surfaces the user actually flagged selectedForPrint — the SAME filter
 * createPrintSurfaceExportRows (domain/technicalServices.ts) already uses for "what's flagged
 * for print". A surface never selected for print is not a production candidate and is excluded
 * from the readiness list entirely (never a placeholder/5th status).
 */
export function buildGraphicsProductionReadiness(
  rows: readonly GraphicsExportRow[],
  assignments: readonly PrintSurfaceAssignment[],
): readonly GraphicsProductionReadinessRow[] {
  return rows
    .filter((row) => assignments.find((item) => item.printSurfaceId === row.printSurfaceId)?.selectedForPrint)
    .map((row): GraphicsProductionReadinessRow => ({
      printSurfaceId: row.printSurfaceId,
      groupId: row.groupId,
      groupName: row.groupName,
      name: row.name,
      face: row.face,
      displayName: graphicsRowHumanLabel(row),
      status: deriveGraphicsProductionStatus(row),
      canonicalWidthMm: row.canonicalWidthMm,
      canonicalHeightMm: row.canonicalHeightMm,
      productionWidthMm: row.productionWidthMm,
      productionHeightMm: row.productionHeightMm,
      bleedLeftMm: row.bleedLeftMm,
      bleedRightMm: row.bleedRightMm,
      bleedTopMm: row.bleedTopMm,
      bleedBottomMm: row.bleedBottomMm,
      realizationProfileId: row.realizationProfileId,
      artworkFileId: row.artworkFileId,
      usageRole: row.artworkUsageRole,
      sourceFileName: row.artworkOriginalFileName,
      displayFileName: row.artworkDisplayName,
      exportFileName: row.exportFileName,
      artworkAsset: row.artworkAsset,
      artworkPlacement: row.artworkPlacement,
      pricing: row.pricing,
    }));
}

/** Report section 6: the only rows ever eligible to become real print-data in a package. */
export function selectProductionReadyRows(
  rows: readonly GraphicsProductionReadinessRow[],
  includedPrintSurfaceIds: ReadonlySet<string>,
): readonly GraphicsProductionReadinessRow[] {
  return rows.filter((row) => row.status === "ready" && includedPrintSurfaceIds.has(row.printSurfaceId));
}

export type GraphicsProductionFolderPlan = Readonly<{ path: string; row: GraphicsProductionReadinessRow }>;

const PRINT_DATA_ROOT = "PRINT_DATA";

/**
 * Report section 7: flat PRINT_DATA/ when the ready set spans a single group, grouped
 * PRINT_DATA/<GROUP>/... when it spans more than one — purely derived from row.groupName, never
 * a P86-specific lookup table, so any future printable component groups correctly for free.
 */
export function planGraphicsProductionFolders(
  readyRows: readonly GraphicsProductionReadinessRow[],
): readonly GraphicsProductionFolderPlan[] {
  const distinctGroups = new Set(readyRows.map((row) => row.groupId));
  const grouped = distinctGroups.size > 1;
  return readyRows.map((row) => ({
    path: grouped
      ? `${PRINT_DATA_ROOT}/${sanitizeFileNameSegment(row.groupName).toUpperCase()}/${row.exportFileName}`
      : `${PRINT_DATA_ROOT}/${row.exportFileName}`,
    row,
  }));
}

/** Report section 15: same sanitizer principle as artwork filenames (sanitizeFileNameSegment) — never WorkflowSteps.tsx's separate/cruder safeName(). */
export function buildGraphicsProductionPackageName(
  input: Readonly<{ eventName: string; projectName: string; revision?: number | string }>,
): string {
  const event = sanitizeFileNameSegment(input.eventName).toUpperCase();
  const project = sanitizeFileNameSegment(input.projectName);
  const base = [event, project, "GRAFIKA"].filter(Boolean).join("_");
  const revisionSuffix = input.revision !== undefined && input.revision !== ""
    ? `_R${String(input.revision).padStart(2, "0")}`
    : "";
  return `FOR_${base}${revisionSuffix}`;
}

/**
 * Future-proofing only (report section 13) — no user/auth identity system exists in this app
 * today (single shared-session cookie, no userId). userId always stays undefined until a real
 * per-user system exists; name/email/phone are manually entered at export time. Distinct from
 * any future "projectCreatedBy" concept (which does not exist and is not invented here) — this
 * is specifically who prepared THIS document/package, not who owns the project.
 */
export type GraphicsProductionPreparedBy = Readonly<{
  userId?: string;
  name: string;
  email?: string;
  phone?: string;
}>;

export type GraphicsProductionManifestSurface = Readonly<{
  printSurfaceId: string;
  displayName: string;
  group: string;
  face: PrintSurfaceFace;
  sourceFileName: string;
  exportFileName: string;
  mimeType: string;
  canonicalWidthMm: number;
  canonicalHeightMm: number;
  productionWidthMm: number;
  productionHeightMm: number;
  bleedLeftMm: number;
  bleedRightMm: number;
  bleedTopMm: number;
  bleedBottomMm: number;
  artworkPlacement?: ArtworkPlacement;
  // Deliberately no storageKey/signed-URL/credential field anywhere in this type — storage
  // identity stays internal (report section 8/11); see tests/graphicsProduction.test.ts's
  // "manifest never contains storageKey" guard.
}>;

export type GraphicsProductionManifest = Readonly<{
  version: 1;
  project: Readonly<{ name: string; company: string }>;
  event: Readonly<{ name: string }>;
  realization: Readonly<{ profileId: string; label: string }>;
  generatedAt: string;
  revision?: number | string;
  preparedBy?: GraphicsProductionPreparedBy;
  surfaces: readonly GraphicsProductionManifestSurface[];
}>;

/**
 * Report section 11: the exact manifest.json content (JSON.stringify(manifest, null, 2) is the
 * whole file, no further shaping needed). Callers MUST pre-filter to status "ready" rows only —
 * this function trusts that and does not re-filter, keeping "which rows are eligible" a single
 * decision made once (selectProductionReadyRows), not duplicated here too. sourceFileName/
 * mimeType are asserted non-undefined because status "ready" (see deriveGraphicsProductionStatus)
 * implies artworkAsset/exportFileName/sourceFileName are all defined.
 */
export function buildGraphicsProductionManifest(
  readyRows: readonly GraphicsProductionReadinessRow[],
  context: Readonly<{
    projectName: string;
    company: string;
    eventName: string;
    realizationProfileId: string;
    realizationLabel: string;
    generatedAt: string;
    revision?: number | string;
    preparedBy?: GraphicsProductionPreparedBy;
  }>,
): GraphicsProductionManifest {
  return {
    version: 1,
    project: { name: context.projectName, company: context.company },
    event: { name: context.eventName },
    realization: { profileId: context.realizationProfileId, label: context.realizationLabel },
    generatedAt: context.generatedAt,
    revision: context.revision,
    preparedBy: context.preparedBy,
    surfaces: readyRows.map((row): GraphicsProductionManifestSurface => ({
      printSurfaceId: row.printSurfaceId,
      displayName: row.displayName,
      group: row.groupName,
      face: row.face,
      sourceFileName: row.sourceFileName ?? row.exportFileName!,
      exportFileName: row.exportFileName!,
      mimeType: row.artworkAsset!.mimeType,
      canonicalWidthMm: row.canonicalWidthMm,
      canonicalHeightMm: row.canonicalHeightMm,
      productionWidthMm: row.productionWidthMm,
      productionHeightMm: row.productionHeightMm,
      bleedLeftMm: row.bleedLeftMm,
      bleedRightMm: row.bleedRightMm,
      bleedTopMm: row.bleedTopMm,
      bleedBottomMm: row.bleedBottomMm,
      artworkPlacement: row.artworkPlacement,
    })),
  };
}
