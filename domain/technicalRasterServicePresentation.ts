/**
 * Technické rastry — Phase 2: technická značka + umístění. Centralized, config-driven mapping from
 * an imported service's OWN real data (category + externalLabel, exactly what the parser produced
 * — never a guessed/invented key, spec batch 7 section 12/15/59) to how it should be drawn as a
 * technical symbol: what color, what renderer, what short label, whether it needs a physical POINT
 * on the raster at all, and what its legend entry reads.
 *
 * This is the ONE place that decision is made — never scattered if/else across UI components (spec
 * section 13). It is deliberately NOT wired to the real component catalog yet (that doesn't have a
 * "technicalRaster" settings section — spec section 59: "nedoplňuj tam napůl náhodné datové pole").
 * `resolveTechnicalServicePresentation`'s own signature (plain category/externalLabel strings in,
 * a plain presentation value out) is intentionally the ONLY contract the rest of this feature
 * depends on — swapping this function's internals for a real
 * `CatalogComponent.technicalRasterPresentation` lookup later requires touching nothing else (spec
 * section 11: "architekturu navrhni tak, aby později mohla dostávat tuto konfiguraci z katalogu").
 *
 * V1 real-data coverage (spec batch 7 section 14-21, verified against the actual parsed Hala 1.pdf
 * report set — see scripts/technicalRasterRealDiagnostic.ts's own output, never invented labels):
 *   electricity externalLabel ∈ {"Do 2kW 230V", "Do 3kW 230V", "Do 5kW 230V", "Do 6kW 230V",
 *     "Do 9kW 400V", "Lednicový okruh"} (+ "Non stop" is a documented alias for the same
 *     refrigerated-circuit symbol, spec section 16, even though it didn't appear in this specific
 *     real fixture set)
 *   internet externalLabel ∈ {"Internet", "Pevná IP", "WIFI"}
 *   waste externalLabel ∈ {"Kontejn 1100 l"} (+ spec section 21 lists "vana 3 m3"/"vana 9 m3"/
 *     "Odvoz odpadu" as OTHER possible real labels this app has seen — none configured as point
 *     placements for V1, see WASTE's own doc below for why)
 *   cleaning externalLabel ∈ {"Denní úklid"}
 *   water: no real externalLabel sample was available in this batch's fixture set — configured at
 *     the CATEGORY level only (spec section 18 doesn't need per-label variants the way electricity
 *     does).
 */

export type TechnicalServicePlacementBehavior = "point" | "informational" | "none";

/** How the symbol is actually drawn — both the editor (real SVG) and the export (jsPDF vector primitives) pick their own concrete drawing code from this tag; this file only decides WHICH one, never how pixels/points get drawn (spec section 22: editor vs. export size are separate concerns, and so is editor-vs-export drawing code). */
export type TechnicalServiceSymbolRenderer = "powerLabel" | "refrigeratedStar" | "textLabel" | "wifiIcon" | "waterDrop" | "fallback";

export type TechnicalServicePresentation = Readonly<{
  placementBehavior: TechnicalServicePlacementBehavior;
  renderer: TechnicalServiceSymbolRenderer;
  /** The short text actually drawn for text-based renderers ("3 kW", "IP", "INT") — undefined for icon-only renderers (refrigeratedStar/wifiIcon/waterDrop), which carry their own fixed shape instead. */
  displayLabel?: string;
  /** Hex color — always sourced from TECHNICAL_RASTER_COLORS below, never a one-off literal here. */
  color: string;
  /** What this presentation reads as in the export legend — omitted from the legend entirely for "none"/"informational" behaviors (nothing is ever drawn for them, so a legend entry would be misleading — see the export legend builder). */
  legendLabel: string;
  /**
   * True ONLY when this presentation was reached through the deterministic last-resort fallback
   * (spec section 19) — never a confidently-resolved config. The UI/export both treat this as "flag
   * it, never hide it": a small unresolved indicator in the service panel, and a console.warn so a
   * missing config is discoverable during development, not silently swallowed.
   */
  isFallback: boolean;
}>;

// ============================================================================
// Centralized colors (spec section 56) — never a hex literal inline in a component/renderer.
// ============================================================================

export const TECHNICAL_RASTER_COLORS = {
  /** Same ABF red already used for the selected-stand marker elsewhere in this feature — reused deliberately, not a coincidence, for one consistent "technical red" across the whole module. */
  electricity: "#b3261e",
  internet: "#b8860b",
  water: "#1a7a4c",
  /** Neutral technical gray (spec section 19: "barva: neutrální technická barva") — same tone this app's own "unassigned" badges already use elsewhere. */
  fallback: "#6b6f72",
} as const;

// ============================================================================
// Legend labels (spec section 42) — only ever shown for presentations actually used in an export.
// ============================================================================

const LEGEND_ELECTRICITY_POWER = "PŘÍVOD EL. ENERGIE";
const LEGEND_REFRIGERATED = "LEDNICOVÝ / NONSTOP OKRUH";
const LEGEND_FIXED_IP = "INTERNET — PEVNÁ IP";
const LEGEND_INTERNET_GENERAL = "INTERNET";
const LEGEND_WATER = "VODA — PŘÍVOD / ODPAD VODY";

// ============================================================================
// electricity (spec section 14-16)
// ============================================================================

const KW_PATTERN = /(\d+(?:[.,]\d+)?)\s*kw/iu;
const REFRIGERATED_PATTERN = /lednic|non\s*-?\s*stop/iu;

/**
 * "Do 3kW 230V" -> "3 kW" (spec section 15: "technical display label", explicitly NOT a pricing/
 * product mapping). Returns undefined when the report's own label doesn't safely contain a
 * recognizable kW figure — spec section 15: "Pokud bezpečně neumíš z report key získat výkon:
 * fallback EL... Nehádej hodnotu." — the caller falls back to a plain "EL" label in that case,
 * never a guess.
 */
export function extractElectricityKwLabel(externalLabel: string): string | undefined {
  const match = externalLabel.match(KW_PATTERN);
  if (!match) return undefined;
  const numeric = Number(match[1]!.replace(",", "."));
  if (!Number.isFinite(numeric)) return undefined;
  return `${numeric} kW`;
}

/** Thin, exported wrapper around the same REFRIGERATED_PATTERN this module's own resolver uses — reused by domain/technicalRasterReconciliation.ts (corrective batch section 8) so canonical-variant identity never diverges from presentation resolution's own classification of the exact same real label text. */
export function isRefrigeratedElectricityLabel(externalLabel: string): boolean {
  return REFRIGERATED_PATTERN.test(externalLabel);
}

function resolveElectricityPresentation(externalLabel: string): TechnicalServicePresentation {
  if (REFRIGERATED_PATTERN.test(externalLabel)) {
    return { placementBehavior: "point", renderer: "refrigeratedStar", color: TECHNICAL_RASTER_COLORS.electricity, legendLabel: LEGEND_REFRIGERATED, isFallback: false };
  }
  const kwLabel = extractElectricityKwLabel(externalLabel);
  if (kwLabel) {
    return { placementBehavior: "point", renderer: "powerLabel", displayLabel: kwLabel, color: TECHNICAL_RASTER_COLORS.electricity, legendLabel: LEGEND_ELECTRICITY_POWER, isFallback: false };
  }
  // A real electricity row this app can't safely turn into a kW figure (spec section 15: never
  // guess) — still a real, point-placeable connection, just with an honest "EL" label instead of
  // an invented number.
  return { placementBehavior: "point", renderer: "powerLabel", displayLabel: "EL", color: TECHNICAL_RASTER_COLORS.electricity, legendLabel: LEGEND_ELECTRICITY_POWER, isFallback: false };
}

// ============================================================================
// internet (spec section 17) — real labels: "Internet", "Pevná IP", "WIFI".
//
// DECISION (spec section 69, "rozhodni konzervativně"): only "Pevná IP" and the plain "Internet"
// row are placementBehavior "point" — both represent an actual cabled drop that needs one physical
// spot. "WIFI" is placementBehavior "informational": unlike a fixed IP cable end, a WiFi order
// generally describes wireless COVERAGE/licensing for the stand (its own quantity — e.g. 1C01's
// WiFi qty=2 — plausibly means "2 device licenses", not "2 distinct physical drop points"), not one
// specific spot a technician needs to run a cable to. Still fully tracked in the service panel
// (never silently dropped), just never a canvas point in V1.
// ============================================================================

const FIXED_IP_PATTERN = /pevn[aá]\s*ip/iu;
const WIFI_PATTERN = /wi[\s-]?fi/iu;

/** Thin, exported wrappers around this module's own internet-classification patterns — reused by domain/technicalRasterReconciliation.ts (corrective batch section 8), same discipline as isRefrigeratedElectricityLabel above. */
export function isFixedIpLabel(externalLabel: string): boolean {
  return FIXED_IP_PATTERN.test(externalLabel);
}
export function isWifiLabel(externalLabel: string): boolean {
  return WIFI_PATTERN.test(externalLabel);
}

function resolveInternetPresentation(externalLabel: string): TechnicalServicePresentation {
  if (FIXED_IP_PATTERN.test(externalLabel)) {
    return { placementBehavior: "point", renderer: "textLabel", displayLabel: "IP", color: TECHNICAL_RASTER_COLORS.internet, legendLabel: LEGEND_FIXED_IP, isFallback: false };
  }
  if (WIFI_PATTERN.test(externalLabel)) {
    return { placementBehavior: "informational", renderer: "wifiIcon", color: TECHNICAL_RASTER_COLORS.internet, legendLabel: LEGEND_INTERNET_GENERAL, isFallback: false };
  }
  // The plain "Internet" row — a general cabled connection, still a real physical drop point.
  return { placementBehavior: "point", renderer: "textLabel", displayLabel: "INT", color: TECHNICAL_RASTER_COLORS.internet, legendLabel: LEGEND_INTERNET_GENERAL, isFallback: false };
}

// ============================================================================
// water (spec section 18) — category-level only, no real per-label variant known yet.
// ============================================================================

function resolveWaterPresentation(): TechnicalServicePresentation {
  return { placementBehavior: "point", renderer: "waterDrop", color: TECHNICAL_RASTER_COLORS.water, legendLabel: LEGEND_WATER, isFallback: false };
}

// ============================================================================
// waste (spec section 21) — DECISION, returned in this batch's report as requested: "Kontejn
// 1100 l" (the one real label seen) is a genuine physical object, but WHERE it stands is typically
// outside the exhibitor's own booth footprint (a shared collection point/aisle, not a spot inside
// the stand this app's raster labels describe) and this app has no data distinguishing that from a
// stand-internal placement. Per spec section 21's own explicit fallback ("pokud nemáme rozhodnuté,
// označ jako informational"), waste is "informational" for V1, never "point" — tracked in the
// service panel, never silently dropped, but no canvas point invented. The other real labels named
// in spec section 21 ("vana 3 m3", "vana 9 m3", "Odvoz odpadu") get the exact same treatment —
// they're all still just "waste" category, no per-label split needed since none of them are
// configured as point placements.
// ============================================================================

function resolveWastePresentation(): TechnicalServicePresentation {
  return { placementBehavior: "informational", renderer: "fallback", color: TECHNICAL_RASTER_COLORS.fallback, legendLabel: "ODPAD", isFallback: false };
}

// ============================================================================
// cleaning (spec section 20) — never a canvas point, never even "informational" (spec section 3's
// own NONE examples literally name "denní úklid, generální úklid" — a cleaning frequency has zero
// spatial meaning at all, unlike waste's "a real object somewhere, just not confidently placeable
// yet").
// ============================================================================

function resolveCleaningPresentation(): TechnicalServicePresentation {
  return { placementBehavior: "none", renderer: "fallback", color: TECHNICAL_RASTER_COLORS.fallback, legendLabel: "ÚKLID", isFallback: false };
}

// ============================================================================
// Fallback (spec section 19) — ANY category/label this config doesn't recognize. Never invented,
// never silently treated as configured — isFallback:true is the one signal every caller (service
// panel badge, dev console) keys off of.
// ============================================================================

function resolveFallbackPresentation(category: string, externalLabel: string): TechnicalServicePresentation {
  if (typeof console !== "undefined") {
    // eslint-disable-next-line no-console
    console.warn(`[technicalRasterServicePresentation] no presentation configured for category "${category}" / label "${externalLabel}" — falling back to a neutral, non-placed "?" presentation.`);
  }
  return { placementBehavior: "informational", renderer: "fallback", displayLabel: "?", color: TECHNICAL_RASTER_COLORS.fallback, legendLabel: externalLabel || category, isFallback: true };
}

/**
 * The ONE entry point every UI/export caller uses (spec section 13). `category` matches
 * domain/technicalServiceCatalog.ts's known ids ("electricity"/"internet"/"water"/"waste"/
 * "cleaning"/"other"); `externalLabel` is the service's own real, verbatim parsed label — this
 * function never receives or needs an internalProductCode (spec section 12: presentation is
 * completely independent of product/catalog resolution).
 */
export function resolveTechnicalServicePresentation(category: string, externalLabel: string): TechnicalServicePresentation {
  switch (category) {
    case "electricity": return resolveElectricityPresentation(externalLabel);
    case "internet": return resolveInternetPresentation(externalLabel);
    case "water": return resolveWaterPresentation();
    case "waste": return resolveWastePresentation();
    case "cleaning": return resolveCleaningPresentation();
    default: return resolveFallbackPresentation(category, externalLabel);
  }
}

/**
 * Whether ANY real externalLabel in this category can ever resolve to a "point" placementBehavior
 * — i.e. whether this category could ever draw a vector export symbol at all (manual acceptance
 * batch, section 43: "pokud kategorie nemá žádný exportovatelný point symbol, nemusí být ve
 * filtru"). `resolveWastePresentation`/`resolveCleaningPresentation` above never return "point"
 * for ANY label (waste is always "informational", cleaning is always "none") — electricity/
 * internet/water always CAN (even "WIFI" internet's own category still has other point-placeable
 * labels like "Pevná IP"). Used ONLY to decide whether a category belongs in the EXPORT symbol
 * filter (TechnicalRasterOutputsPanel.tsx) — never changes what's tracked/shown in the stand
 * detail panel or the editor's own "TECHNICKÉ ZNAČKY" view filters, which still list every
 * category (spec section 43 is explicitly export-only: "NEMĚŇ service semantics").
 */
export function categoryCanHaveExportableSymbol(categoryId: string): boolean {
  return categoryId === "electricity" || categoryId === "internet" || categoryId === "water";
}
