/**
 * Technické rastry — PDF export VIEW MODEL (spec batch 7 section 40-51). Pure, framework/IO-free:
 * computes exactly what a "Vytvořit PDF" click needs to draw (which placements, which legend
 * entries, which pre-export warnings, the filename) from the project's own already-known state —
 * mirrors domain/printSurfaceExport.ts's own "this module never touches jsPDF/pdf.js, it only
 * resolves DATA" discipline, so lib/technicalRasterPdf.ts stays pure layout code and this stays
 * directly unit-testable without a browser.
 *
 * Scoped to ONE raster page per export (spec's own "Rastr: Pracovní – bílé" single-raster export
 * dialog never mentions a page picker) — the caller passes which page (the currently active one),
 * exactly like TechnicalRasterCanvas.tsx's own markers.filter(marker => marker.page === activePage)
 * already does for on-screen rendering. A stand/placement on a DIFFERENT page is simply not
 * included in this export's placements/legend, but IS still counted in the whole-project status
 * summary/warnings below (spec never asked for a "page 2 has unplaced services" warning — those
 * numbers are project-wide, matching how "Spárování: 20/20" already reads across the whole raster).
 */
import { sortStandNumbersNatural } from "./technicalStandNumber.ts";
import { sanitizeFileNameSegment } from "./graphicsFileNaming.ts";
import {
  effectiveServicePlacements,
  requiredPlacementCount,
  type TechnicalRasterProject,
  type TechnicalStand,
} from "./technicalRaster.ts";
import {
  resolveServicePresentation,
  TECHNICAL_CATEGORY_LEGEND_LABELS,
  TECHNICAL_RASTER_COLORS,
  type TechnicalServicePresentation,
} from "./technicalRasterServicePresentation.ts";

// ============================================================================
// What to actually draw on the export page
// ============================================================================

export type TechnicalRasterExportPlacementItem = Readonly<{
  standId: string;
  standNumber: string;
  serviceId: string;
  placementId: string;
  xNormalized: number;
  yNormalized: number;
  presentation: TechnicalServicePresentation;
  /**
   * SIMPLIFIED LEGEND BATCH — the service's own real, imported category ("electricity"/"internet"/
   * "water"/"waste"/"cleaning"/etc, domain/technicalServiceCatalog.ts's own ids), threaded through
   * ONLY so buildTechnicalRasterExportLegend below can group the generated PDF legend at the
   * CATEGORY level (never a second/independent classification) — never read by the actual symbol
   * drawing code (lib/technicalRasterVectorPdf.ts's drawPlacementSymbol draws from `presentation`
   * alone, exactly as before this batch).
   */
  category: string;
}>;

/**
 * Every drawable (placementBehavior "point") placement on `page`, for services whose category is
 * NOT in `hiddenCategories` (spec section 37: "export musí respektovat viditelnost technických
 * vrstev"). A stand that isn't raster-matched at all still has its OWN placements skipped here too
 * (a placement with no matched stand position has no meaningful page/page-relative coordinate to
 * begin with — matching this app's existing "nothing draws without a real position" discipline).
 */
export function buildTechnicalRasterExportPlacements(
  project: TechnicalRasterProject,
  page: number,
  hiddenCategories: ReadonlySet<string>,
): readonly TechnicalRasterExportPlacementItem[] {
  const items: TechnicalRasterExportPlacementItem[] = [];
  for (const stand of project.stands) {
    if (stand.placement.status !== "matched_auto" && stand.placement.status !== "matched_manual") continue;
    for (const service of stand.services) {
      if (hiddenCategories.has(service.category)) continue;
      const presentation = resolveServicePresentation(service);
      if (presentation.placementBehavior !== "point") continue;
      for (const placement of effectiveServicePlacements(service)) {
        if (placement.page !== page) continue;
        items.push({
          standId: stand.id,
          standNumber: stand.standNumber,
          serviceId: service.id,
          placementId: placement.id,
          xNormalized: placement.xNormalized,
          yNormalized: placement.yNormalized,
          presentation,
          category: service.category,
        });
      }
    }
  }
  return items;
}

export type TechnicalRasterExportLegendEntry = Readonly<{
  /** "ELEKTŘINA", "INTERNET / WiFi", … — or an unknown category's own raw label. */
  legendLabel: string;
  /** The category color the swatch shows. */
  color: string;
  /** Stable key of the row ("category:electricity", "label:<raw>", "neutral"). */
  key: string;
}>;

// ============================================================================
// HOTFIX-02 (phase 7) — the legend explains the category COLORS only ("● ELEKTŘINA" red, "● INTERNET /
// WiFi" gold, …). It no longer shows sample symbols or explains labels — "5 kW" needs no legend row.
// A category appears only when the export actually uses it: through a placed service OR a manual
// drawing of that category (a red manual line still means electricity). Neutral black appears only
// when a neutral manual drawing is exported. Unknown imported categories keep a row with their own
// raw label in the fallback gray. Rows come in a fixed order, independent of placement order.
// ============================================================================

const CATEGORY_LEGEND_ORDER: readonly string[] = ["electricity", "internet", "water", "cleaning", "waste"];
const COLOR_BY_LEGEND_CATEGORY: Readonly<Record<string, string>> = {
  electricity: TECHNICAL_RASTER_COLORS.electricity,
  internet: TECHNICAL_RASTER_COLORS.internet,
  water: TECHNICAL_RASTER_COLORS.water,
  cleaning: TECHNICAL_RASTER_COLORS.cleaning,
  waste: TECHNICAL_RASTER_COLORS.waste,
};
export const NEUTRAL_LEGEND_LABEL = "NEUTRÁLNÍ";

export function buildTechnicalRasterExportLegend(
  placements: readonly TechnicalRasterExportPlacementItem[],
  manualDrawings: readonly Readonly<{ category?: string }>[] = [],
): readonly TechnicalRasterExportLegendEntry[] {
  const usedCategories = new Set<string>();
  const unknown = new Map<string, TechnicalRasterExportLegendEntry>();
  for (const item of placements) {
    if (COLOR_BY_LEGEND_CATEGORY[item.category]) usedCategories.add(item.category);
    else if (!unknown.has(item.presentation.legendLabel)) unknown.set(item.presentation.legendLabel, { legendLabel: item.presentation.legendLabel, color: item.presentation.color, key: `label:${item.presentation.legendLabel}` });
  }
  let usesNeutral = false;
  for (const drawing of manualDrawings) {
    if (!drawing.category) continue;
    if (drawing.category === "neutral") usesNeutral = true;
    else if (COLOR_BY_LEGEND_CATEGORY[drawing.category]) usedCategories.add(drawing.category);
  }
  return [
    ...CATEGORY_LEGEND_ORDER.filter((category) => usedCategories.has(category)).map((category) => ({ legendLabel: TECHNICAL_CATEGORY_LEGEND_LABELS[category]!, color: COLOR_BY_LEGEND_CATEGORY[category]!, key: `category:${category}` })),
    ...unknown.values(),
    ...(usesNeutral ? [{ legendLabel: NEUTRAL_LEGEND_LABEL, color: TECHNICAL_RASTER_COLORS.neutral, key: "neutral" }] : []),
  ];
}

// ============================================================================
// Status summary + pre-export warnings (spec section 33/50) — project-wide, independent of which
// page/categories a particular export run includes.
// ============================================================================

export type TechnicalRasterStatusSummary = Readonly<{
  matchedStandCount: number;
  totalStandCount: number;
  placedPointCount: number;
  totalPointCount: number;
}>;

/**
 * "Spárování: N/N" + "Technické body: N/M umístěno" (spec section 33) — matching status and
 * placement status are deliberately two separate counters here, never conflated (spec: "Nezaváděj
 * závislost technického stavu na spárování"). totalPointCount only counts services whose OWN
 * presentation is "point" (informational/none services have no points to place at all, so they
 * never appear in this denominator — e.g. cleaning qty=40 never makes this "40 missing").
 *
 * CORRECTIVE BATCH (multi-hall imports) section 8 — a stand classified `"outside_current_raster"`
 * (domain/technicalRasterHallScope.ts) is excluded from EVERY count here, on both sides: it never
 * inflates `totalStandCount`'s denominator (a combined Hala 3+4 report must read "Spárování: 50/50"
 * for the Hala 3 project, never "50/100"), and its own services never count toward
 * placed/totalPointCount — a foreign-hall stand's own placement completeness is simply not this
 * raster's concern.
 */
export function computeTechnicalRasterStatusSummary(project: TechnicalRasterProject): TechnicalRasterStatusSummary {
  let placedPointCount = 0;
  let totalPointCount = 0;
  let totalStandCount = 0;
  let matchedStandCount = 0;
  for (const stand of project.stands) {
    if (stand.placement.status === "outside_current_raster") continue;
    totalStandCount += 1;
    if (stand.placement.status === "matched_auto" || stand.placement.status === "matched_manual") matchedStandCount += 1;
    for (const service of stand.services) {
      const presentation = resolveServicePresentation(service);
      if (presentation.placementBehavior !== "point") continue;
      const required = requiredPlacementCount(service);
      totalPointCount += required;
      placedPointCount += Math.min(effectiveServicePlacements(service).length, required);
    }
  }
  return { matchedStandCount, totalStandCount, placedPointCount, totalPointCount };
}

export type TechnicalRasterExportWarnings = Readonly<{
  /** How many DISTINCT services still have at least one missing point. */
  unplacedServiceCount: number;
  /** Total missing points across every point service (quantity - placed, summed; spec's own "3 služby / 4 body nejsou umístěné" example). */
  unplacedPointCount: number;
  /** Stands that have at least one technical service but are NOT raster-matched (spec section 32: a separate warning from unplaced points). */
  unmatchedStandsWithServices: readonly Readonly<{ standId: string; standNumber: string }>[];
}>;

/**
 * CORRECTIVE BATCH (multi-hall imports) section 8/9/11 — a stand classified
 * `"outside_current_raster"` is excluded from EVERY warning here: its own unplaced point services
 * never inflate `unplacedServiceCount`/`unplacedPointCount` (spec: "must not affect
 * placement-completion counts for the current raster"), and it never appears in
 * `unmatchedStandsWithServices` (spec: "Do not show foreign-hall records as a wall of red errors" —
 * that list is reserved for GENUINELY problematic/unmatched current-raster stands, never a valid
 * record this raster simply doesn't own).
 */
export function computeTechnicalRasterExportWarnings(project: TechnicalRasterProject): TechnicalRasterExportWarnings {
  let unplacedServiceCount = 0;
  let unplacedPointCount = 0;
  for (const stand of project.stands) {
    if (stand.placement.status === "outside_current_raster") continue;
    for (const service of stand.services) {
      const presentation = resolveServicePresentation(service);
      if (presentation.placementBehavior !== "point") continue;
      const required = requiredPlacementCount(service);
      const missing = required - Math.min(effectiveServicePlacements(service).length, required);
      if (missing > 0) {
        unplacedServiceCount += 1;
        unplacedPointCount += missing;
      }
    }
  }
  const unmatchedStandsWithServices = sortStandNumbersNatural(
    project.stands.filter((stand) => stand.placement.status !== "matched_auto" && stand.placement.status !== "matched_manual" && stand.placement.status !== "outside_current_raster" && stand.services.length > 0),
    (stand) => stand.standNumber,
  ).map((stand: TechnicalStand) => ({ standId: stand.id, standNumber: stand.standNumber }));
  return { unplacedServiceCount, unplacedPointCount, unmatchedStandsWithServices };
}

// ============================================================================
// Filename (spec section 45: sanitized, mirrors buildPrintSurfaceExportFileName's pattern)
// ============================================================================

export function buildTechnicalRasterExportFileName(input: Readonly<{ eventName?: string; hall?: string; projectName?: string }>): string {
  const segments = [
    "Technicky_rastr",
    input.eventName ? sanitizeFileNameSegment(input.eventName) : undefined,
    input.hall ? sanitizeFileNameSegment(input.hall) : undefined,
    !input.eventName && !input.hall && input.projectName ? sanitizeFileNameSegment(input.projectName) : undefined,
  ].filter((segment): segment is string => Boolean(segment));
  return `${segments.join("_")}.pdf`;
}

/** Small, real-data-only export header line (spec section 45: "malý text, žádný velký report header") — e.g. "Technický rastr / FOR DECOR 2026 / Hala 1". Never invents a missing value — a part with nothing real to show is simply omitted, never a placeholder like "—". */
export function buildTechnicalRasterExportHeaderLine(input: Readonly<{ eventName?: string; hall?: string }>): string {
  const parts = ["Technický rastr", input.eventName, input.hall].filter((part): part is string => Boolean(part));
  return parts.join(" / ");
}
