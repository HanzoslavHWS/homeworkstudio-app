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
import { classifyStandScope } from "./technicalRasterHallScope.ts";
import { resolveTechnicalServicePresentation } from "./technicalRasterServicePresentation.ts";
import type { TechnicalLegendPlacement } from "./technicalRasterLegendPlacement.ts";
import type { TechnicalReconciliationMention } from "./technicalRasterReconciliation.ts";
import type { ParsedCatalogImport } from "./technicalRasterCatalogImport.ts";
import { extractTechnicalMentionsFromCatalogStand } from "./technicalRasterCatalogImport.ts";

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
  /**
   * "Krytí bílé" (spec batch 6, UI section 17-23) — how opaque the work-mode stand-fill whitening
   * is, 0 (fully transparent fill, original stroke/edges still fully visible) to 1 (today's
   * original fully-opaque white). Optional so a project saved BEFORE this field existed never
   * crashes reading it back — see effectiveWhiteFillOpacity below, always applied at read time,
   * no data migration needed (spec section 22/23). "original" viewMode ignores this entirely
   * (spec section 31) — it's only ever consulted when actually rendering work mode.
   */
  whiteFillOpacity?: number;
  /**
   * "TECHNICKÉ ZNAČKY" layer visibility (spec batch 7 section 34-36) — which service CATEGORIES'
   * placed symbols are currently hidden on the canvas/export, e.g. ["internet"] hides every
   * internet symbol regardless of stand. Deliberately a SEPARATE settings field from
   * workModeHiddenLayerIds/layerVisibility above — those control the source PDF's own Optional
   * Content Groups; this controls this app's OWN drawn technical symbols and has nothing to do
   * with the PDF's layers (spec section 36: "architektonicky i UI odděleně od PDF OCG vrstev").
   * Optional so a project saved before this field existed reads back as "nothing hidden" with no
   * migration — see effectiveHiddenServiceCategories, always used instead of a raw read.
   */
  hiddenServiceCategories?: readonly string[];
  /**
   * Realization badges (corrective batch section 10) — two independent, optional toggles, both
   * OFF by default (undefined) so a project with no realization data imported yet never shows a
   * wall of misleading "OSTATNÍ" (red) badges on every stand. "Zobrazit realizačky" affects the
   * live editor canvas only; "Zahrnout realizačky do exportu" is consulted only by the export and
   * has no effect on the editor view — the two are deliberately independent, same as every other
   * view-vs-export setting pair in this file.
   */
  showRealizations?: boolean;
  includeRealizationsInExport?: boolean;
  /** Corrective batch section 7 — WHERE the export's legend is drawn (domain/technicalRasterLegendPlacement.ts's own doc has the full story). Optional/undefined resolves to today's existing "separate-page" behavior via resolveEffectiveLegendPlacement — never a raw read here. */
  legendPlacement?: TechnicalLegendPlacement;
}>;

export function effectiveShowRealizations(settings: RasterSettings): boolean {
  return settings.showRealizations ?? false;
}

export function effectiveIncludeRealizationsInExport(settings: RasterSettings): boolean {
  return settings.includeRealizationsInExport ?? false;
}

/** Applied wherever whiteFillOpacity is read — never a raw `settings.whiteFillOpacity` access elsewhere, so a project saved before this field existed reads as the SAME default new projects get (spec section 19/23). */
export const DEFAULT_WHITE_FILL_OPACITY = 0.6;

export function effectiveWhiteFillOpacity(settings: RasterSettings): number {
  return settings.whiteFillOpacity ?? DEFAULT_WHITE_FILL_OPACITY;
}

/** viewMode defaults to "work" (spec section 19: "Default pro technický workflow: Pracovní – bílé") — the technical department's own daily tool, not a general PDF viewer. whiteFillOpacity defaults to DEFAULT_WHITE_FILL_OPACITY (60%) for every NEW project going forward — existing/older projects rely on effectiveWhiteFillOpacity's own fallback instead, never a migration. */
export function createDefaultRasterSettings(): RasterSettings {
  return { layerVisibility: {}, workModeHiddenLayerIds: [], viewMode: "work", whiteFillOpacity: DEFAULT_WHITE_FILL_OPACITY, hiddenServiceCategories: [] };
}

/** Never a raw `settings.hiddenServiceCategories` read elsewhere — a project saved before this field existed reads as "nothing hidden", same discipline as effectiveWhiteFillOpacity. */
export function effectiveHiddenServiceCategories(settings: RasterSettings): ReadonlySet<string> {
  return new Set(settings.hiddenServiceCategories ?? []);
}

/** Sets the full "TECHNICKÉ ZNAČKY" hidden-category list (spec batch 7 section 34) — a plain replace, mirroring withWorkModeHiddenLayers' own shape for the unrelated PDF-layer concept. */
export function withHiddenServiceCategories(project: TechnicalRasterProject, categoryIds: readonly string[]): TechnicalRasterProject {
  return { ...project, rasterSettings: { ...project.rasterSettings, hiddenServiceCategories: categoryIds }, updatedAt: new Date().toISOString() };
}

/** Corrective batch section 10 — "Zobrazit realizačky" (editor canvas only). */
export function withShowRealizations(project: TechnicalRasterProject, show: boolean): TechnicalRasterProject {
  return { ...project, rasterSettings: { ...project.rasterSettings, showRealizations: show }, updatedAt: new Date().toISOString() };
}

/** Corrective batch section 10 — "Zahrnout realizačky do exportu" (export only, independent of the editor's own display toggle above). */
export function withIncludeRealizationsInExport(project: TechnicalRasterProject, include: boolean): TechnicalRasterProject {
  return { ...project, rasterSettings: { ...project.rasterSettings, includeRealizationsInExport: include }, updatedAt: new Date().toISOString() };
}

/** Corrective batch section 7 — sets WHERE the export's legend is drawn (domain/technicalRasterLegendPlacement.ts). A plain replace, same shape as every other rasterSettings mutator here. */
export function withLegendPlacement(project: TechnicalRasterProject, legendPlacement: TechnicalLegendPlacement): TechnicalRasterProject {
  return { ...project, rasterSettings: { ...project.rasterSettings, legendPlacement }, updatedAt: new Date().toISOString() };
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
/**
 * One physical point a technical service has been placed at (spec batch 7 section 5). Always
 * stored in the SAME normalized 0-1 PDF-page coordinate space as RasterStandLabel/StandPlacement
 * above — never CSS/canvas pixels, so a saved placement stays geometrically correct across
 * zoom/pan/viewport resize AND, for export, across page rotation (see
 * domain/technicalRasterExportPlacementGeometry.ts for the rotation-aware normalized->raw-PDF-point conversion).
 */
export type TechnicalServicePlacement = Readonly<{
  id: string;
  /** Which raster PAGE this point lives on (mirrors StandPlacement.rasterPage) — required so a multi-page raster renders/exports each placement on its own correct page, never assumed to be page 1. */
  page: number;
  xNormalized: number;
  yNormalized: number;
  createdAt: string;
}>;

/**
 * One parsed line item from a technical report (spec section 11-14). `quantity` is ALWAYS a real
 * number (never coerced to boolean — spec section 12/14), and `rawValue`/`externalLabel` are
 * ALWAYS kept verbatim regardless of whether internalProductCode could be resolved (spec section
 * 11: "původní údaj NEZAHODIT").
 *
 * `placements` (spec batch 7 section 2/3) is the ONLY new persisted data this phase adds — never
 * more than `quantity` entries (enforced by placeTechnicalService below, defensively re-checked
 * everywhere it's read too). Optional/possibly-undefined so a project saved before this field
 * existed reads back as "no placements yet" with no migration (spec section 54) — see
 * effectiveServicePlacements, always used instead of a raw `service.placements` read.
 * `placementBehavior` itself ("point"/"informational"/"none") is NEVER stored here — it's a
 * property of the SERVICE'S OWN category/externalLabel, resolved on demand via
 * domain/technicalRasterServicePresentation.ts's resolveTechnicalServicePresentation, so a future
 * config/catalog change instantly applies to already-imported services without a data migration.
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
  placements?: readonly TechnicalServicePlacement[];
}>;

/** Applied wherever a service's placements are read — never a raw `service.placements` access elsewhere (spec section 54: older projects have this field undefined entirely). */
export function effectiveServicePlacements(service: TechnicalService): readonly TechnicalServicePlacement[] {
  return service.placements ?? [];
}

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

/**
 * CORRECTIVE BATCH (multi-hall imports) — `"outside_current_raster"` is a distinct classification
 * from `"unassigned"`: an unassigned stand is a genuine open problem (needs manual pairing or is a
 * likely typo); an outside-current-raster stand is a VALID record this project's own hall simply
 * doesn't own (see domain/technicalRasterHallScope.ts's own doc for the full "combined multi-hall
 * report" scenario this exists for). Never set by anything other than `placementFromMatch`'s own
 * scope check below (falling back to it only once an exact-match attempt has already failed) — an
 * exact raster-label match, however the hall-prefix heuristic would have guessed, always wins.
 */
export type StandPlacementStatus = "unassigned" | "matched_auto" | "matched_manual" | "ambiguous" | "outside_current_raster";
export type StandMatchMethod = "exact_auto" | "manual";

export type StandPlacement = Readonly<{
  status: StandPlacementStatus;
  rasterPage?: number;
  anchorXNormalized?: number;
  anchorYNormalized?: number;
  matchedLabelId?: string;
  matchMethod?: StandMatchMethod;
  /** Set only when status === "ambiguous": how many raster labels this stand number matched (spec batch 3 UI section 9) — purely informational, never used to auto-pick a candidate. */
  candidateCount?: number;
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
  /**
   * Corrective batch section 9/10 — the RAW, verbatim "R:" (realizace/build contractor) text as
   * parsed from a supplemental catalog report (see domain/technicalRasterCatalogImport.ts), never
   * pre-grouped/normalized here (spec's own "původní údaj NEZAHODIT" discipline, same as
   * TechnicalService.externalLabel above) — grouping into GENDAI/CREATIV EXPO/MAC PRAHA/OSTATNÍ is
   * always resolved on demand via domain/technicalRasterRealization.ts's
   * resolveTechnicalRealizationGroup, exactly like TechnicalServicePresentation is resolved on
   * demand from a service's own raw category/externalLabel.
   *
   * CORRECTIVE BATCH (realization domain model fix) — this field alone is NEVER sufficient to
   * decide whether a realization indicator should be drawn at all; see `hasCatalogBuildRecord`'s
   * own doc for why. Undefined simply means "no R: value known for this stand yet" — it does NOT
   * mean "this stand isn't an ABF build."
   */
  realizationCompany?: string;
  /**
   * True ONLY when this stand's OWN number was found in the supplemental "5. Stavby - tisk vše
   * katalog" catalog (domain/technicalRasterCatalogImport.ts) — i.e. a REAL, confirmed ABF build
   * record exists for it, independent of whether it has ANY technical service at all (spec: "A
   * stand can be a valid ABF build even if it has zero technical services" — real example: stand
   * 1B06 has no entry in any primary technical-service report, but DOES have a catalog build
   * record with "R: MAC Praha, spol. s r.o."). This is the field that actually gates whether a
   * realization indicator is drawn — see `resolveRealizationDisplayState` below for the full
   * three-state logic this flag makes possible:
   *
   *   - `hasCatalogBuildRecord: true`  + a KNOWN `realizationCompany`   -> draw the known color.
   *   - `hasCatalogBuildRecord: true`  + unknown/blank `realizationCompany` -> draw OSTATNÍ (red) —
   *     this is a CONFIRMED ABF build whose contractor just isn't one of the named groups, never
   *     "we have no data".
   *   - `hasCatalogBuildRecord` falsy (including a stand mentioned only in a technical-service
   *     report, never in the catalog — e.g. built by the exhibitor themselves) -> draw NOTHING.
   *     `realizationCompany` must never be trusted alone for this decision (a stand could
   *     theoretically carry a stale value from an earlier catalog import that no longer lists it —
   *     see mergeSupplementalCatalogImport's own doc on why that value is deliberately never wiped
   *     just because a later import omits the stand, which is exactly why the boolean, not the
   *     string, is the actual gate).
   *
   * Never set true by anything OTHER than a real catalog import match (never inferred from
   * realizationCompany being present, never inferred from having technical services).
   */
  hasCatalogBuildRecord?: boolean;
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
  /**
   * Corrective batch (post real-file acceptance test) section 7-11 — the SUPPLEMENTAL/CONTROL
   * source ("5. Stavby - tisk vše katalog"), deliberately modeled SEPARATELY from `imports[]`
   * above: it is never a 6th primary technical-report category, never merged into
   * `stands[].services`, and never creates duplicate services (spec section 10/11: "ONE logical
   * service + MULTIPLE source evidences"). `catalogMentions` holds the LATEST import's own
   * technical-service mentions (domain/technicalRasterCatalogImport.ts's
   * extractTechnicalMentionsFromCatalogStand output) — a plain "latest wins" replace on each new
   * import (this source has no per-category history the way primary reports do, so there is
   * nothing to preserve from a superseded run). Both optional/undefined for a project that has
   * never imported this source, or one saved before this field existed — no migration needed.
   */
  catalogMentions?: readonly TechnicalReconciliationMention[];
  catalogImportMeta?: TechnicalRasterCatalogImportMeta;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}>;

export type TechnicalRasterCatalogImportMeta = Readonly<{
  filename: string;
  importedAt: string;
  /** Catalog records that DO carry a stand number (spec: "Nalezeno záznamů Stavby") — never includes the standless records counted separately below. */
  standCount: number;
  /**
   * CORRECTIVE BATCH (3rd) section 16 — "matched" now means matched to an actual RASTER stand
   * (i.e. ended up `matched_auto`/`matched_manual` after `mergeSupplementalCatalogImport`'s own
   * `rematchStands` pass), never merely "a project stand entry already existed for this number".
   * A catalog record with no existing report-based stand still gets a brand-new stand created for
   * it (see `mergeSupplementalCatalogImport`'s own doc) and is counted here once THAT stand is
   * genuinely placed on the raster.
   */
  matchedStandCount: number;
  /** Catalog records with NO stand number at all (spec section 3/16: "Bez čísla stánku") — captured as import records with a warning, never fabricated a number, never folded into standCount/matchedStandCount. */
  standlessRecordCount: number;
  /** CORRECTIVE BATCH (multi-hall imports) section 13 — catalog records whose OWN stand number is confidently outside the current raster's own hall (domain/technicalRasterHallScope.ts) — never created as a project stand, never counted in matchedStandCount, purely informational. */
  outsideCurrentRasterCount: number;
  warnings: readonly TechnicalRasterImportWarning[];
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

/** Removes one project from an already-loaded summary list by id — pure list projection behind the project list page's optimistic "delete succeeded" update (spec batch 4 UI section 19). Never makes a network call itself; the caller only applies this AFTER the repository's own delete() has resolved without throwing. */
export function withoutTechnicalRasterProject(projects: readonly TechnicalRasterProjectSummary[], projectId: string): readonly TechnicalRasterProjectSummary[] {
  return projects.filter((project) => project.id !== projectId);
}

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

/** Sets "Krytí bílé" (spec batch 6). `opacity` is clamped to [0,1] defensively — a slider UI shouldn't ever produce an out-of-range value, but this is the one place that guarantee is actually enforced. */
export function withWhiteFillOpacity(project: TechnicalRasterProject, opacity: number): TechnicalRasterProject {
  const clamped = Math.min(1, Math.max(0, opacity));
  return { ...project, rasterSettings: { ...project.rasterSettings, whiteFillOpacity: clamped }, updatedAt: new Date().toISOString() };
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

const OUTSIDE_CURRENT_RASTER_PLACEMENT: StandPlacement = { status: "outside_current_raster" };

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
  if (result.status === "ambiguous") return { status: "ambiguous", candidateCount: result.candidateLabels.length };
  // No exact match. CORRECTIVE BATCH (multi-hall imports) — only NOW ask whether this number is
  // confidently outside the current raster's own hall at all; an exact match above already always
  // wins over this heuristic, and "unknown" (can't tell) falls straight through to the ordinary
  // "unassigned" behavior below, exactly as before this batch.
  if (classifyStandScope(standNumber, labels) === "outsideCurrentRaster") return OUTSIDE_CURRENT_RASTER_PLACEMENT;
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

/** Sets/clears one stand's raw realization ("R:") text (corrective batch section 9/10) — a plain, structured data mutation, never a UI-only label (spec section 11: "realization assignment také drž jako strukturovaná data, ne jen UI text"). Passing `undefined` clears it back to "no supplemental catalog data for this stand" (resolves to OSTATNÍ wherever read, never a crash). Unknown standId is a safe no-op, same discipline as every other stand mutator in this file. */
export function setStandRealizationCompany(project: TechnicalRasterProject, standId: string, realizationCompany: string | undefined): TechnicalRasterProject {
  const stands = project.stands.map((stand) => (stand.id === standId ? { ...stand, realizationCompany } : stand));
  return { ...project, stands, updatedAt: new Date().toISOString() };
}

/**
 * Corrective batch (post real-file acceptance test) section 7-11 — merges a parsed supplemental
 * catalog import ("5. Stavby - tisk vše katalog") into the project: auto-assigns
 * `realizationCompany` on every stand the catalog's own standNumber matches (spec section 9: "po
 * importu katalogového PDF už realizace NESMÍ být pouze manual-entry feature" — a later manual edit
 * via setStandRealizationCompany simply overrides this, exactly like any other override), and
 * replaces `catalogMentions` wholesale with every technical-service mention the import found
 * (spec section 10: this is a CONTROL source, never a second parallel service list — nothing here
 * ever touches `stands[].services`). A catalog stand whose own standNumber matches NO project stand
 * contributes nothing (its mentions are simply never reconciled against anything — reconciliation
 * itself, not this merge step, is what would eventually flag "only_catalog" for it once a matching
 * primary-report stand exists).
 */
/**
 * CORRECTIVE BATCH (realization domain model fix) — a catalog build record is matched against
 * RASTER STANDS, never merely against `TechnicalStand` records a primary technical-service report
 * happened to create. Before this fix, a stand with zero technical services (a real, confirmed
 * case: stand 1B06 has no entry in ANY primary report, but a real ABF build record with "R: MAC
 * Praha" in the catalog) had NO `TechnicalStand` object to attach to at all, so its realization was
 * silently lost. Now: a catalog stand whose own number matches an EXISTING project stand updates
 * that stand in place; a catalog stand whose number matches NO existing project stand but IS a real
 * catalog record gets a brand-new, minimal `TechnicalStand` created for it — `services: []` (spec:
 * "Do not invent a technical service just to make a catalog stand exist" — this alone already keeps
 * it out of the placement work queue, since `groupStandsByPlacementWorkQueue` only ever buckets
 * stands that HAVE point services). `rematchStands` then runs once at the end so every
 * newly-created (or existing) stand gets placed on the raster exactly like any other stand — no
 * separate/duplicate matching logic.
 *
 * `hasCatalogBuildRecord: true` is set on every stand the catalog actually mentions by number —
 * this, never `realizationCompany`'s own presence, is what later gates whether a realization
 * indicator is drawn at all (domain/technicalRasterRealization.ts's own resolveRealizationDisplayState).
 *
 * CORRECTIVE BATCH (multi-hall imports) section 13 — a combined "Stavby" catalog export can ALSO mix
 * rows from several halls, exactly like a primary technical report can. `classifyStandScope`
 * (domain/technicalRasterHallScope.ts) is checked FIRST, before either branch above: a catalog stand
 * number confidently outside the current raster's own hall (spec: "4A01 must NOT create a
 * current-project lightweight TechnicalStand... must NOT render realization underline... must NOT
 * count them as current-raster builds") is skipped entirely — never added to `newStands`, never
 * merged into an existing project stand's `hasCatalogBuildRecord`/`realizationCompany` even if one
 * already happens to exist for that number (e.g. from a primary-report import that itself already
 * correctly classified it "outside_current_raster"). The real, accepted 1B06 case (a stand WITHIN
 * the current hall's own namespace, absent from every primary report, present only in the catalog)
 * is unaffected: its scope resolves to "currentRaster" (or "unknown" when the raster's own hall
 * prefix can't be reliably derived yet), so it still reaches the existing lightweight-stand-creation
 * path below exactly as before this batch.
 */
export function mergeSupplementalCatalogImport(
  project: TechnicalRasterProject,
  parsed: ParsedCatalogImport,
  filename: string,
  now: string = new Date().toISOString(),
): TechnicalRasterProject {
  const standIdByNormalizedNumber = new Map<string, string>();
  for (const stand of project.stands) standIdByNormalizedNumber.set(normalizeStandNumber(stand.standNumber), stand.id);

  const realizationByStandId = new Map<string, string | undefined>();
  const catalogBuildStandIds = new Set<string>();
  const newStands: TechnicalStand[] = [];
  let outsideCurrentRasterCount = 0;

  for (const catalogStand of parsed.stands) {
    if (!catalogStand.standNumber) continue; // standless catalog records never become/attach to a stand — see extractTechnicalMentionsFromCatalogStand's own doc for the matching discipline.
    if (classifyStandScope(catalogStand.standNumber, project.rasterStandLabels) === "outsideCurrentRaster") {
      outsideCurrentRasterCount += 1;
      continue;
    }
    const normalized = normalizeStandNumber(catalogStand.standNumber);
    let standId = standIdByNormalizedNumber.get(normalized);
    if (!standId) {
      standId = crypto.randomUUID();
      standIdByNormalizedNumber.set(normalized, standId);
      newStands.push({
        id: standId,
        standNumber: catalogStand.standNumber,
        companyName: catalogStand.companyName,
        services: [],
        notes: [],
        placement: UNASSIGNED_PLACEMENT,
        sourceImportIds: [],
        hasCatalogBuildRecord: true,
      });
    }
    catalogBuildStandIds.add(standId);
    if (catalogStand.realizationCompanyRaw !== undefined) realizationByStandId.set(standId, catalogStand.realizationCompanyRaw);
  }

  const mergedStands = [...project.stands, ...newStands].map((stand) => {
    if (!catalogBuildStandIds.has(stand.id)) return stand;
    return {
      ...stand,
      hasCatalogBuildRecord: true,
      realizationCompany: realizationByStandId.has(stand.id) ? realizationByStandId.get(stand.id) : stand.realizationCompany,
    };
  });

  const rematched = rematchStands({ ...project, stands: mergedStands });
  const matchedStandCount = rematched.stands.filter(
    (stand) => catalogBuildStandIds.has(stand.id) && (stand.placement.status === "matched_auto" || stand.placement.status === "matched_manual"),
  ).length;

  const catalogMentions = parsed.stands.flatMap((stand) => extractTechnicalMentionsFromCatalogStand(stand));

  return {
    ...rematched,
    catalogMentions,
    catalogImportMeta: {
      filename,
      importedAt: now,
      standCount: parsed.stands.filter((stand) => stand.standNumber).length,
      matchedStandCount,
      standlessRecordCount: parsed.stands.filter((stand) => !stand.standNumber).length,
      outsideCurrentRasterCount,
      warnings: parsed.warnings.map((warning, index) => ({ id: `catalog-warning-${index}`, ...warning })),
    },
    updatedAt: now,
  };
}

/**
 * Every technical-service mention this project's OWN primary reports carry, in the exact shape
 * `reconcileTechnicalReportAndCatalog` expects — the "report" side of the reconciliation, built
 * fresh from `stands[].services` every time (never persisted separately, since services can change
 * independently of any catalog import). Only MATCHED stands are considered (an unmatched stand has
 * no confirmed real-world position/identity yet to reconcile against).
 */
export function buildPrimaryReportMentions(project: TechnicalRasterProject): readonly TechnicalReconciliationMention[] {
  const mentions: TechnicalReconciliationMention[] = [];
  for (const stand of project.stands) {
    if (stand.placement.status !== "matched_auto" && stand.placement.status !== "matched_manual") continue;
    for (const service of stand.services) {
      mentions.push({ standNumber: stand.standNumber, category: service.category, externalLabel: service.externalLabel, quantity: service.quantity });
    }
  }
  return mentions;
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
// Service placement (spec batch 7 section 3/6/9/54) — never touches matching/spárování data.
// Every mutator here is a no-op (returns the project unchanged) on any input that doesn't
// structurally make sense (unknown stand/service id, wrong placementBehavior, quantity already
// reached, unknown placementId) — this app's established "never crash on a stale UI click"
// discipline, not a thrown error a caller must remember to catch.
// ============================================================================

/**
 * `changed` is only set when `update(service)` returns a genuinely DIFFERENT object (reference
 * inequality) — merely FINDING the matching stand/service is never enough, so a refused mutation
 * (placeTechnicalService over quota, remove/move against an unknown placementId, ...) that returns
 * its input service back unchanged is a true no-op: no new stand/services array, no updatedAt bump
 * (spec batch 7 section 70-C: "ani nezvýší updatedAt"). Every caller below relies on this — each
 * only returns a NEW service object when it actually has something different to say.
 */
function updateServiceInStand(
  project: TechnicalRasterProject,
  standId: string,
  serviceId: string,
  update: (service: TechnicalService) => TechnicalService,
): TechnicalRasterProject {
  let changed = false;
  const stands = project.stands.map((stand) => {
    if (stand.id !== standId) return stand;
    let standChanged = false;
    const services = stand.services.map((service) => {
      if (service.id !== serviceId) return service;
      const updated = update(service);
      if (updated !== service) {
        changed = true;
        standChanged = true;
      }
      return updated;
    });
    return standChanged ? { ...stand, services } : stand;
  });
  if (!changed) return project;
  return { ...project, stands, updatedAt: new Date().toISOString() };
}

/**
 * Adds ONE new placement point (spec section 6) — refuses (no-op) if the service's OWN
 * presentation isn't "point" (spec section 3: never place an informational/none service), or if
 * `quantity` placements already exist (spec section 4/70-C: "třetí placement je odmítnut").
 */
export function placeTechnicalService(
  project: TechnicalRasterProject,
  standId: string,
  serviceId: string,
  point: Readonly<{ page: number; xNormalized: number; yNormalized: number }>,
): TechnicalRasterProject {
  return updateServiceInStand(project, standId, serviceId, (service) => {
    const presentation = resolveTechnicalServicePresentation(service.category, service.externalLabel);
    if (presentation.placementBehavior !== "point") return service;
    const existing = effectiveServicePlacements(service);
    if (existing.length >= service.quantity) return service;
    const placement: TechnicalServicePlacement = { id: crypto.randomUUID(), page: point.page, xNormalized: point.xNormalized, yNormalized: point.yNormalized, createdAt: new Date().toISOString() };
    return { ...service, placements: [...existing, placement] };
  });
}

/** Moves ONE existing placement to a new point — SAME placement id, only its coordinates (and, if the user re-placed it while viewing a different page, its page) change (spec section 9/70-E: "stejné placement id"). No-op if that placement id doesn't exist on this service. */
export function moveTechnicalServicePlacement(
  project: TechnicalRasterProject,
  standId: string,
  serviceId: string,
  placementId: string,
  point: Readonly<{ page: number; xNormalized: number; yNormalized: number }>,
): TechnicalRasterProject {
  return updateServiceInStand(project, standId, serviceId, (service) => {
    const existing = effectiveServicePlacements(service);
    if (!existing.some((placement) => placement.id === placementId)) return service;
    return {
      ...service,
      placements: existing.map((placement) => (placement.id === placementId ? { ...placement, page: point.page, xNormalized: point.xNormalized, yNormalized: point.yNormalized } : placement)),
    };
  });
}

/**
 * Removes ONE placement (spec section 9: "Odstranit umístění NESMAŽE technickou službu... Umístěno
 * → Neumístěno"). The service itself, its quantity, notes, and every OTHER placement are untouched
 * — only this one point disappears; the service's aggregate state (e.g. "1/2") updates purely as a
 * side effect of `placements` now being one shorter.
 */
export function removeTechnicalServicePlacement(
  project: TechnicalRasterProject,
  standId: string,
  serviceId: string,
  placementId: string,
): TechnicalRasterProject {
  return updateServiceInStand(project, standId, serviceId, (service) => {
    const existing = effectiveServicePlacements(service);
    if (!existing.some((placement) => placement.id === placementId)) return service;
    return { ...service, placements: existing.filter((placement) => placement.id !== placementId) };
  });
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
