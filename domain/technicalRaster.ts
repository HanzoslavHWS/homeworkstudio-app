/**
 * Technické rastry — a NEW, standalone module for ABF's technical department: matching a hall's
 * measurement raster (a real, vector PDF floor plan with stand numbers) against several separate
 * technical-service PDF exports (electricity, internet, water, waste, cleaning, ...) keyed by
 * stand number, into one shared per-stand buffer. Deliberately NOT the booth generator and NOT
 * print surfaces — no shared state with either (spec: "Nerozbíjej ani zásadně nerefactoruj
 * existující části generátoru").
 *
 * Two separate data layers (spec section 1):
 *  - The RASTER (sourceRasterAsset + rasterStandLabels[]) is a pure visual/geometric reference —
 *    its own source PDF is NEVER modified (see rasterSettings' own doc for the safe, non-
 *    destructive "work mode" this module offers instead of content-stream rewriting).
 *  - TECHNICAL SERVICES (imports[] -> stands[].services[]) come from separate PDF exports, merged
 *    purely by normalizedStandNumber (domain/technicalStandNumber.ts) — company name is NEVER the
 *    matching key (spec section 27), only ever informational.
 *
 * V1 has no AI/OCR/fuzzy matching anywhere (spec section 29) — see domain/technicalRasterMatching.ts
 * for the exact-match engine, and this module's own manual-assignment functions below for the
 * deterministic fallback.
 */
import type { StoredAsset } from "./assets.ts";
import { normalizeStandNumber, sortStandNumbersNatural } from "./technicalStandNumber.ts";
import { matchStandNumberToRasterLabels } from "./technicalRasterMatching.ts";

// ============================================================================
// Raster layer (one detected stand-number text occurrence in the source PDF)
// ============================================================================

/**
 * One occurrence of a possible stand-number text in the raster's PDF text layer (spec section 7).
 * Positions are NORMALIZED (0–1) relative to the PDF PAGE's own point dimensions, never CSS/canvas
 * pixels — this is what keeps a saved anchor/highlight correct across zoom/pan/viewport resize
 * (spec section 35), the exact same discipline domain/printSurfaceProject.ts's
 * xNormalized/yNormalized already established for a completely different module.
 */
export type RasterStandLabel = Readonly<{
  id: string;
  rawText: string;
  normalizedStandNumber: string;
  page: number;
  xNormalized: number;
  yNormalized: number;
  widthNormalized: number;
  heightNormalized: number;
}>;

// ============================================================================
// Raster PDF layers (Optional Content Groups) + work-mode visibility
// ============================================================================

/** One PDF Optional Content Group actually found in the source raster — id/name come straight from the PDF, never hardcoded (spec section 5: "NESMÍ být natvrdo závislé pouze na tomto jednom PDF"). */
export type RasterLayer = Readonly<{
  id: string;
  name: string;
  defaultVisible: boolean;
}>;

/**
 * Per-project layer-visibility preferences (spec section 5/6/35: "Vrstvy rastru jsou pracovní
 * preference daného projektu"). `workModeHiddenLayerIds` is the GENERAL "hide this whole OCG while
 * I work" preference — plain `setVisibility(id, false)`, safe and geometrically exact for ANY
 * layer, but (as real-PDF testing proved for the stand layer itself — every stand in "Hala 1.pdf"
 * draws its fill AND its outline in ONE combined paint operator) hiding a whole layer removes
 * edges along with fills, so it is never used for the stand layer's own colored fill.
 *
 * That specific job — turning ONLY a stand's colored fill white while its outline/geometry/dash
 * stay exactly as in the source PDF — is a SEPARATE mechanism: lib/pdf/technicalRasterWhiteRender.ts
 * whitens just the fill-color operators feeding the stand layer's paint calls (found via
 * domain/technicalRasterWhiteModeOperators.ts, the pure algorithm), never touching the PDF file
 * itself (spec section 12) nor any other layer's drawing. `viewMode === "work"` turns this on for
 * whichever stand layer domain/technicalRasterWhiteModeOperators.ts's alias-based detection finds
 * (see resolveWhiteModeAvailability) — if none or more than one candidate layer is found, it is
 * simply not offered (spec section 16: never guess which layer to repaint).
 */
export type RasterSettings = Readonly<{
  /** layer id -> currently visible, for "original" view mode. */
  layerVisibility: Readonly<Record<string, boolean>>;
  /** Layer ids forced OFF whenever viewMode === "work" — user-configured per project, never a hardcoded layer name. Independent of the stand-fill whitening above (spec section 28: "White mode je jiná funkce než layer visibility"). */
  workModeHiddenLayerIds: readonly string[];
  viewMode: "original" | "work";
}>;

/** viewMode defaults to "work" (spec section 19: "Default pro technický workflow: Pracovní – bílé") — the technical department's own daily tool, not a general PDF viewer. */
export function createDefaultRasterSettings(): RasterSettings {
  return { layerVisibility: {}, workModeHiddenLayerIds: [], viewMode: "work" };
}

// ============================================================================
// Technical service imports (one row per uploaded PDF)
// ============================================================================

export type TechnicalRasterImportParseStatus = "ok" | "ok_with_warnings" | "failed";

/** A problem the parser found — NEVER a silently-dropped row (spec section 25: "Fail loudly, not silently"). */
export type TechnicalRasterImportWarning = Readonly<{
  id: string;
  message: string;
  page?: number;
  rawText?: string;
}>;

export type TechnicalRasterImport = Readonly<{
  id: string;
  category: string;
  filename: string;
  asset: StoredAsset;
  importedAt: string;
  parserVersion: string;
  parseStatus: TechnicalRasterImportParseStatus;
  standsFound: number;
  servicesFound: number;
  warnings: readonly TechnicalRasterImportWarning[];
  /** Set when a LATER import of the same category replaced this one (spec section 24) — this row is kept forever for history/audit, never deleted, even though its services/notes are removed from stands[] once superseded. */
  supersededByImportId?: string;
}>;

// ============================================================================
// Technical services / notes (one row per parsed report line item)
// ============================================================================

export type TechnicalServiceStatus = "resolved" | "unresolved_product";

/**
 * One parsed line item from a technical report (spec section 11-14). `quantity` is ALWAYS a real
 * number (never coerced to boolean — spec section 12/14), and `rawValue`/`externalLabel` are
 * ALWAYS kept verbatim regardless of whether internalProductCode could be resolved (spec section
 * 11: "původní údaj NEZAHODIT").
 */
export type TechnicalService = Readonly<{
  id: string;
  category: string;
  externalLabel: string;
  internalProductId?: string;
  internalProductCode?: string;
  quantity: number;
  rawValue: string;
  sourceImportId: string;
  sourcePage: number;
  rawRow?: string;
  status: TechnicalServiceStatus;
}>;

/** A free-text note attached to a stand from a report (spec section 13: e.g. a "doobjednáno telefonicky..." line under a waste-report row) — never discarded. */
export type TechnicalNote = Readonly<{
  id: string;
  text: string;
  sourceImportId: string;
  sourcePage: number;
  rawRow?: string;
}>;

// ============================================================================
// Stand placement (raster assignment) + the stand itself
// ============================================================================

export type StandPlacementStatus = "unassigned" | "matched_auto" | "matched_manual" | "ambiguous";
export type StandMatchMethod = "exact_auto" | "manual";

export type StandPlacement = Readonly<{
  status: StandPlacementStatus;
  rasterPage?: number;
  anchorXNormalized?: number;
  anchorYNormalized?: number;
  matchedLabelId?: string;
  matchMethod?: StandMatchMethod;
}>;

export const UNASSIGNED_PLACEMENT: StandPlacement = { status: "unassigned" };

export type TechnicalStand = Readonly<{
  id: string;
  /** The primary key within a project (spec section 27) — normalized, never the company name. */
  standNumber: string;
  companyName?: string;
  services: readonly TechnicalService[];
  notes: readonly TechnicalNote[];
  placement: StandPlacement;
  sourceImportIds: readonly string[];
}>;

// ============================================================================
// Project
// ============================================================================

export type TechnicalRasterProject = Readonly<{
  id: string;
  eventId?: string;
  hall?: string;
  name: string;
  sourceRasterAsset?: StoredAsset;
  rasterLayers: readonly RasterLayer[];
  rasterSettings: RasterSettings;
  rasterStandLabels: readonly RasterStandLabel[];
  imports: readonly TechnicalRasterImport[];
  stands: readonly TechnicalStand[];
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}>;

export type TechnicalRasterProjectCreateInput = Readonly<{
  name: string;
  eventId?: string;
  hall?: string;
  createdBy?: string;
}>;

export function createTechnicalRasterProject(
  input: TechnicalRasterProjectCreateInput,
  id: string = crypto.randomUUID(),
  now: string = new Date().toISOString(),
): TechnicalRasterProject {
  return {
    id,
    name: input.name,
    eventId: input.eventId,
    hall: input.hall,
    rasterLayers: [],
    rasterSettings: createDefaultRasterSettings(),
    rasterStandLabels: [],
    imports: [],
    stands: [],
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
}

/** Lightweight projection for the project list — mirrors PrintSurfaceProjectSummary's own discipline of never shipping the full stand/service arrays to a list screen. */
export type TechnicalRasterProjectSummary = Readonly<{
  id: string;
  name: string;
  eventId?: string;
  hall?: string;
  hasRaster: boolean;
  standCount: number;
  unassignedCount: number;
  ambiguousCount: number;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}>;

export function summarizeTechnicalRasterProject(project: TechnicalRasterProject): TechnicalRasterProjectSummary {
  return {
    id: project.id,
    name: project.name,
    eventId: project.eventId,
    hall: project.hall,
    hasRaster: Boolean(project.sourceRasterAsset),
    standCount: project.stands.length,
    unassignedCount: project.stands.filter((stand) => stand.placement.status === "unassigned").length,
    ambiguousCount: project.stands.filter((stand) => stand.placement.status === "ambiguous").length,
    createdBy: project.createdBy,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

// ============================================================================
// Raster mutators — geometry/text of the source PDF is NEVER touched by any of these; they only
// attach references/settings to the project.
// ============================================================================

export function withSourceRasterAsset(project: TechnicalRasterProject, asset: StoredAsset): TechnicalRasterProject {
  return { ...project, sourceRasterAsset: asset, updatedAt: new Date().toISOString() };
}

/** Replaces the detected layer list (from a fresh PDF read) — seeds layerVisibility for any layer that doesn't already have an explicit preference, never clobbering ones the user already set. */
export function withRasterLayers(project: TechnicalRasterProject, layers: readonly RasterLayer[]): TechnicalRasterProject {
  const layerVisibility = { ...project.rasterSettings.layerVisibility };
  for (const layer of layers) {
    if (!(layer.id in layerVisibility)) layerVisibility[layer.id] = layer.defaultVisible;
  }
  return {
    ...project,
    rasterLayers: layers,
    rasterSettings: { ...project.rasterSettings, layerVisibility },
    updatedAt: new Date().toISOString(),
  };
}

export function withLayerVisibility(project: TechnicalRasterProject, layerId: string, visible: boolean): TechnicalRasterProject {
  return {
    ...project,
    rasterSettings: { ...project.rasterSettings, layerVisibility: { ...project.rasterSettings.layerVisibility, [layerId]: visible } },
    updatedAt: new Date().toISOString(),
  };
}

export function withWorkModeHiddenLayers(project: TechnicalRasterProject, layerIds: readonly string[]): TechnicalRasterProject {
  return { ...project, rasterSettings: { ...project.rasterSettings, workModeHiddenLayerIds: layerIds }, updatedAt: new Date().toISOString() };
}

export function withRasterViewMode(project: TechnicalRasterProject, viewMode: RasterSettings["viewMode"]): TechnicalRasterProject {
  return { ...project, rasterSettings: { ...project.rasterSettings, viewMode }, updatedAt: new Date().toISOString() };
}

/** The layer ids actually hidden right now, given the current viewMode — the single place any raster-rendering UI should ask "what should I skip drawing". */
export function effectiveHiddenLayerIds(project: TechnicalRasterProject): ReadonlySet<string> {
  const hidden = new Set<string>();
  for (const [layerId, visible] of Object.entries(project.rasterSettings.layerVisibility)) {
    if (!visible) hidden.add(layerId);
  }
  if (project.rasterSettings.viewMode === "work") {
    for (const layerId of project.rasterSettings.workModeHiddenLayerIds) hidden.add(layerId);
  }
  return hidden;
}

/**
 * Replaces the detected stand-number label set (from a fresh PDF text-layer read) and re-runs
 * exact matching for every stand whose placement isn't manual (spec section 19) — a manual
 * placement (matchMethod "manual") is NEVER overwritten by this, only exact_auto/unassigned/
 * ambiguous ones are recomputed.
 */
export function withRasterStandLabels(project: TechnicalRasterProject, labels: readonly RasterStandLabel[]): TechnicalRasterProject {
  return rematchStands({ ...project, rasterStandLabels: labels, updatedAt: new Date().toISOString() });
}

// ============================================================================
// Matching (spec section 19) — never overwrites a manual placement.
// ============================================================================

function placementFromMatch(standNumber: string, labels: readonly RasterStandLabel[]): StandPlacement {
  const result = matchStandNumberToRasterLabels(standNumber, labels);
  if (result.status === "matched_auto") {
    return {
      status: "matched_auto",
      rasterPage: result.label.page,
      anchorXNormalized: result.label.xNormalized + result.label.widthNormalized / 2,
      anchorYNormalized: result.label.yNormalized + result.label.heightNormalized / 2,
      matchedLabelId: result.label.id,
      matchMethod: "exact_auto",
    };
  }
  if (result.status === "ambiguous") return { status: "ambiguous" };
  return UNASSIGNED_PLACEMENT;
}

/** Re-runs exact matching for every stand NOT currently manually placed. Safe to call after any raster or buffer change. */
export function rematchStands(project: TechnicalRasterProject): TechnicalRasterProject {
  const stands = project.stands.map((stand) =>
    stand.placement.matchMethod === "manual"
      ? stand
      : { ...stand, placement: placementFromMatch(stand.standNumber, project.rasterStandLabels) },
  );
  return { ...project, stands };
}

// ============================================================================
// Manual assignment (spec section 20/21/22) — the key, fast fallback workflow.
// ============================================================================

export type ManualAssignmentInput = Readonly<{
  page: number;
  anchorXNormalized: number;
  anchorYNormalized: number;
  matchedLabelId?: string;
}>;

export function assignStandManually(project: TechnicalRasterProject, standId: string, input: ManualAssignmentInput): TechnicalRasterProject {
  const stands = project.stands.map((stand) =>
    stand.id === standId
      ? {
        ...stand,
        placement: {
          status: "matched_manual" as const,
          rasterPage: input.page,
          anchorXNormalized: input.anchorXNormalized,
          anchorYNormalized: input.anchorYNormalized,
          matchedLabelId: input.matchedLabelId,
          matchMethod: "manual" as const,
        },
      }
      : stand,
  );
  return { ...project, stands, updatedAt: new Date().toISOString() };
}

/** Returns a stand to "unassigned" (spec section 22: "vrátit stánek do Nepřiřazených") — never destructive, the stand and its services/notes are untouched, only its placement resets. Re-runs exact matching afterward, since the stand may legitimately still have an unambiguous raster match. */
export function clearStandAssignment(project: TechnicalRasterProject, standId: string): TechnicalRasterProject {
  const stands = project.stands.map((stand) => (stand.id === standId ? { ...stand, placement: UNASSIGNED_PLACEMENT } : stand));
  return rematchStands({ ...project, stands, updatedAt: new Date().toISOString() });
}

/** The next unassigned/ambiguous stand after `afterStandId` in natural stand-number order — powers the "klik klik klik" auto-advance workflow (spec section 20), never a hard-coded "next in array" order. */
export function nextUnassignedStand(project: TechnicalRasterProject, afterStandId?: string): TechnicalStand | undefined {
  const pending = sortStandNumbersNatural(
    project.stands.filter((stand) => stand.placement.status === "unassigned" || stand.placement.status === "ambiguous"),
    (stand) => stand.standNumber,
  );
  if (pending.length === 0) return undefined;
  if (!afterStandId) return pending[0];
  const afterIndex = pending.findIndex((stand) => stand.id === afterStandId);
  if (afterIndex === -1) return pending[0];
  return pending[(afterIndex + 1) % pending.length] ?? pending[0];
}

// ============================================================================
// Import merge (spec section 8/15/24) — the "shared stand buffer" builder.
// ============================================================================

export type ParsedTechnicalServiceRow = Readonly<{
  standNumber: string;
  companyName?: string;
  services: readonly Omit<TechnicalService, "id" | "sourceImportId" | "status" | "internalProductId" | "internalProductCode">[];
  notes: readonly Omit<TechnicalNote, "id" | "sourceImportId">[];
}>;

/** The standardized output every TechnicalReportParser implementation returns (spec section 40) — category-agnostic, so the merge logic below never special-cases a report type. */
export type ParsedTechnicalReport = Readonly<{
  category: string;
  rows: readonly ParsedTechnicalServiceRow[];
  warnings: readonly Omit<TechnicalRasterImportWarning, "id">[];
}>;

function findStandIndex(stands: readonly TechnicalStand[], standNumber: string): number {
  return stands.findIndex((stand) => stand.standNumber === standNumber);
}

/**
 * Merges one parsed report into the project's shared stand buffer (spec section 15): stands are
 * matched/created purely by normalizedStandNumber. If `replaceImportId` is given, that OLDER
 * import of the same category is marked superseded and its services/notes are removed from every
 * stand FIRST (spec section 24) — the import record itself is kept forever for history, never
 * deleted. `resolveProduct` is injected (not called from here) so this stays pure/pure-testable —
 * see domain/technicalServiceProductMapping.ts for the real implementation used at the call site.
 */
export function mergeTechnicalRasterImport(
  project: TechnicalRasterProject,
  importRecord: TechnicalRasterImport,
  report: ParsedTechnicalReport,
  resolveProduct: (category: string, externalLabel: string) => { internalProductId?: string; internalProductCode?: string; status: TechnicalServiceStatus },
  replaceImportId?: string,
): TechnicalRasterProject {
  let stands = project.stands;
  let imports = project.imports;

  if (replaceImportId) {
    imports = imports.map((existing) => (existing.id === replaceImportId ? { ...existing, supersededByImportId: importRecord.id } : existing));
    stands = stands.map((stand) => ({
      ...stand,
      services: stand.services.filter((service) => service.sourceImportId !== replaceImportId),
      notes: stand.notes.filter((note) => note.sourceImportId !== replaceImportId),
      sourceImportIds: stand.sourceImportIds.filter((id) => id !== replaceImportId),
    }));
  }

  let nextStands = [...stands];
  for (const row of report.rows) {
    const standNumber = normalizeStandNumber(row.standNumber);
    const services: TechnicalService[] = row.services.map((service) => {
      const resolution = resolveProduct(service.category, service.externalLabel);
      return {
        ...service,
        id: crypto.randomUUID(),
        sourceImportId: importRecord.id,
        internalProductId: resolution.internalProductId,
        internalProductCode: resolution.internalProductCode,
        status: resolution.status,
      };
    });
    const notes: TechnicalNote[] = row.notes.map((note) => ({ ...note, id: crypto.randomUUID(), sourceImportId: importRecord.id }));

    const existingIndex = findStandIndex(nextStands, standNumber);
    if (existingIndex === -1) {
      nextStands.push({
        id: crypto.randomUUID(),
        standNumber,
        companyName: row.companyName,
        services,
        notes,
        placement: UNASSIGNED_PLACEMENT,
        sourceImportIds: [importRecord.id],
      });
    } else {
      const existing = nextStands[existingIndex]!;
      nextStands[existingIndex] = {
        ...existing,
        companyName: existing.companyName ?? row.companyName,
        services: [...existing.services, ...services],
        notes: [...existing.notes, ...notes],
        sourceImportIds: existing.sourceImportIds.includes(importRecord.id) ? existing.sourceImportIds : [...existing.sourceImportIds, importRecord.id],
      };
    }
  }

  const project2: TechnicalRasterProject = {
    ...project,
    imports: [...imports, importRecord],
    stands: nextStands,
    updatedAt: new Date().toISOString(),
  };
  return rematchStands(project2);
}

// ============================================================================
// Persistence — same convention as PrintSurfaceProjectRepository (domain/printSurfaceProject.ts):
// list/get/create/save/delete, `save` persists the whole project (caller applies whichever pure
// with*/assign*/merge* helper above first).
// ============================================================================

export interface TechnicalRasterProjectRepository {
  list(): Promise<readonly TechnicalRasterProjectSummary[]>;
  get(id: string): Promise<TechnicalRasterProject | undefined>;
  create(input: TechnicalRasterProjectCreateInput): Promise<TechnicalRasterProject>;
  save(project: TechnicalRasterProject): Promise<TechnicalRasterProject>;
  delete(id: string): Promise<void>;
}
