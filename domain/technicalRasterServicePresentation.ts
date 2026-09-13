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
 *     "Odvoz odpadu" as OTHER possible real labels this app has seen)
 *   cleaning externalLabel ∈ {"Denní úklid"}
 *   water: no real externalLabel sample was available in this batch's fixture set — configured at
 *     the CATEGORY level only (spec section 18 doesn't need per-label variants the way electricity
 *     does).
 *
 * CORRECTIVE BATCH (real production — "every imported operational service must be placeable"):
 * every category above (electricity/internet incl. WiFi/water/waste/cleaning) — and any future
 * category this app doesn't have a name for yet, via resolveFallbackPresentation — now resolves to
 * `placementBehavior: "point"`. The remaining, genuinely load-bearing decision per category/variant
 * is `placementCardinality` ("onePerRecord" vs "perQuantity" — see that type's own doc), never
 * whether it can be placed at all.
 */

export type TechnicalServicePlacementBehavior = "point" | "informational" | "none";

/**
 * CORRECTIVE BATCH (real production — "every imported operational service must be placeable")
 * — separates the imported record's own `quantity` (how many kW/days/licenses/etc. the SOURCE
 * report says) from how many physical marker CLICKS the raster actually needs:
 *
 *   - "perQuantity"  — quantity genuinely means "this many distinct physical points" (e.g. 2
 *     electricity connections, 2 WiFi access points, 2 water drops) — the existing, previously
 *     implicit default every "point" service already had.
 *   - "onePerRecord" — quantity means something else entirely (area/frequency/period/capacity —
 *     e.g. "Denní úklid" qty=40 means 40 CLEANING DAYS, not 40 physical spots) — exactly ONE marker
 *     is required regardless of the raw number.
 *
 * Meaningless (never read) when `placementBehavior !== "point"`. Centralized here, per-variant,
 * so matching/work-queue/export code never re-decides this itself — see
 * domain/technicalRaster.ts's `requiredPlacementCount()`, the ONE place this is actually consumed.
 */
export type TechnicalServicePlacementCardinality = "onePerRecord" | "perQuantity";

/** How the symbol is actually drawn — both the editor (real SVG) and the export (jsPDF vector primitives) pick their own concrete drawing code from this tag; this file only decides WHICH one, never how pixels/points get drawn (spec section 22: editor vs. export size are separate concerns, and so is editor-vs-export drawing code). */
export type TechnicalServiceSymbolRenderer = "powerLabel" | "refrigeratedStar" | "textLabel" | "wifiIcon" | "waterDrop" | "fallback";

export type TechnicalServicePresentation = Readonly<{
  placementBehavior: TechnicalServicePlacementBehavior;
  /** Only meaningful when placementBehavior === "point" — see TechnicalServicePlacementCardinality's own doc. Always "perQuantity" for a non-"point" presentation (never read, kept only so every presentation object has the same shape). */
  placementCardinality: TechnicalServicePlacementCardinality;
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
  /** CORRECTIVE BATCH (every imported operational service must be placeable) — waste/cleaning previously never needed their own color (both were "informational"/"none", drawn nowhere), reusing neutral `fallback` gray was harmless. Now that both are real canvas points, each needs its own distinct, print-safe color so a stand's markers stay visually distinguishable. */
  waste: "#7a5230",
  cleaning: "#6a4c93",
  /** Neutral technical gray (spec section 19: "barva: neutrální technická barva") — same tone this app's own "unassigned" badges already use elsewhere. */
  fallback: "#6b6f72",
} as const;

// ============================================================================
// Legend labels (spec section 42) — only ever shown for presentations actually used in an export.
// ============================================================================

const LEGEND_ELECTRICITY_POWER = "PŘÍVOD EL. ENERGIE";
/** GENERATED LEGEND BATCH — shortened to the exact requested legend wording ("LEDNICOVÝ OKRUH", was "LEDNICOVÝ / NONSTOP OKRUH"); "Non stop" stays a recognized ALIAS for the same presentation (REFRIGERATED_PATTERN below), it just no longer needs mentioning in the legend's own description text. */
const LEGEND_REFRIGERATED = "LEDNICOVÝ OKRUH";
const LEGEND_FIXED_IP = "PEVNÁ IP";
const LEGEND_INTERNET_GENERAL = "INTERNET";
const LEGEND_WIFI = "WIFI";
const LEGEND_WATER = "PŘÍVOD / ODPAD VODY";
const LEGEND_WASTE = "ODPAD";
const LEGEND_CLEANING = "ÚKLID";

/**
 * GENERATED LEGEND BATCH — breaker legend text is now per-CHARACTERISTIC-LETTER ("JISTIČ
 * CHARAKTERISTIKY C" vs "...D"), replacing the previous single shared "JISTIČ (CHARAKTERISTIKA)"
 * text every letter used to collapse into. This is what keeps the architecture extensible (spec:
 * "if additional normalized breaker characteristics are supported in the future, keep this
 * extensible") — a future "Jistič K"/"Jistič Z" row automatically gets its OWN distinct legend
 * entry, deduplicated by this exact string, never merged with C/D. Never invents a letter — always
 * derived from extractBreakerCharacteristicLabel's own real, already-extracted value.
 */
function legendBreakerLabel(characteristicLetters: string): string {
  return `JISTIČ CHARAKTERISTIKY ${characteristicLetters}`;
}

// ============================================================================
// electricity (spec section 14-16)
// ============================================================================

const KW_PATTERN = /(\d+(?:[.,]\d+)?)\s*kw/iu;
const REFRIGERATED_PATTERN = /lednic|non\s*-?\s*stop/iu;

/**
 * CORRECTIVE BATCH — real electricity reports can also carry a breaker-characteristic column
 * ("Jistič C/D", per domain/technicalReportParsers/electricityReportParser.ts's own doc comment
 * and detectionHints) that this resolver previously had no dedicated branch for — it silently fell
 * through to the generic "EL" fallback below, which is what the user reported ("breaker C currently
 * renders as EL"). `č` is matched without requiring the diacritic (`jisti[cč]`) since some real PDF
 * text extraction strips it.
 */
const BREAKER_PATTERN = /jisti[cč]/iu;

/** Thin, exported wrapper — same reasoning as isRefrigeratedElectricityLabel/isFixedIpLabel/isWifiLabel above. */
export function isBreakerCharacteristicLabel(externalLabel: string): boolean {
  return BREAKER_PATTERN.test(externalLabel);
}

/**
 * "Jistič C" -> "C", "Jistič C16" / "Jistič C 16A" -> "C16" (spec: "pokud existuje konkrétní hodnota
 * v datech/katalogu, zobraz ji — nikdy si ji nevymýšlej"). Returns undefined when the breaker word
 * itself is present but no recognizable characteristic letter follows it — the caller falls back to
 * an honest, still-distinct "JIS" label in that case, never a guessed letter.
 */
export function extractBreakerCharacteristicLabel(externalLabel: string): string | undefined {
  const match = externalLabel.match(/jisti[cč]\w*[^a-z0-9]*([a-z])\s*(\d{1,3})?/iu);
  if (!match) return undefined;
  const letter = match[1]!.toUpperCase();
  const amps = match[2];
  return amps ? `${letter}${amps}` : letter;
}

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
    return { placementBehavior: "point", placementCardinality: "perQuantity", renderer: "refrigeratedStar", color: TECHNICAL_RASTER_COLORS.electricity, legendLabel: LEGEND_REFRIGERATED, isFallback: false };
  }
  if (BREAKER_PATTERN.test(externalLabel)) {
    const breakerLabel = extractBreakerCharacteristicLabel(externalLabel) ?? "JIS";
    const characteristicLetters = breakerLabel.match(/^[A-Z]+/u)?.[0] ?? breakerLabel;
    return { placementBehavior: "point", placementCardinality: "perQuantity", renderer: "textLabel", displayLabel: breakerLabel, color: TECHNICAL_RASTER_COLORS.electricity, legendLabel: legendBreakerLabel(characteristicLetters), isFallback: false };
  }
  const kwLabel = extractElectricityKwLabel(externalLabel);
  if (kwLabel) {
    return { placementBehavior: "point", placementCardinality: "perQuantity", renderer: "powerLabel", displayLabel: kwLabel, color: TECHNICAL_RASTER_COLORS.electricity, legendLabel: LEGEND_ELECTRICITY_POWER, isFallback: false };
  }
  // A real electricity row this app can't safely turn into a kW figure (spec section 15: never
  // guess) — still a real, point-placeable connection, just with an honest "EL" label instead of
  // an invented number.
  return { placementBehavior: "point", placementCardinality: "perQuantity", renderer: "powerLabel", displayLabel: "EL", color: TECHNICAL_RASTER_COLORS.electricity, legendLabel: LEGEND_ELECTRICITY_POWER, isFallback: false };
}

// ============================================================================
// internet (spec section 17) — real labels: "Internet", "Pevná IP", "WIFI".
//
// CORRECTIVE BATCH (real production — "every imported operational service must be placeable"):
// WiFi is now placementBehavior "point" too — the business requirement is now explicit that WiFi
// must be placeable exactly like Internet/IP (previous "informational" decision, made when this
// was still a V1 guess, is superseded). `placementCardinality: "perQuantity"` — a WiFi order's own
// quantity (e.g. 1C01's qty=2) is treated as "2 distinct physical access-point locations", the same
// semantics the plain "Internet"/fixed-IP rows already had — consistent with how this app already
// treats every other internet-category row, and the safer reading of "WiFi quantity 2 may
// legitimately represent 2 physical WiFi points" (never "40 cleaning days"-style non-spatial
// quantity, which is exactly what `placementCardinality: "onePerRecord"` exists for instead).
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
    return { placementBehavior: "point", placementCardinality: "perQuantity", renderer: "textLabel", displayLabel: "IP", color: TECHNICAL_RASTER_COLORS.internet, legendLabel: LEGEND_FIXED_IP, isFallback: false };
  }
  if (WIFI_PATTERN.test(externalLabel)) {
    // CORRECTIVE BATCH (2nd) — the icon-only wifiIcon glyph (no displayLabel) was found, on real
    // manual acceptance, to be visually indistinguishable at a glance from the plain "Internet"
    // marker, and was reported as "WiFi renders as INT". The user's own corrected mapping table
    // wants literal readable "WiFi" text, matching every other internet/electricity variant's own
    // plain textLabel presentation (IP/INT/EL/C) rather than an icon-only glyph. `renderer:
    // "wifiIcon"` stays a valid TechnicalServiceSymbolRenderer (still selectable via a component's
    // own TechnicalRasterComponentConfig override, and still drawn correctly by both the editor and
    // lib/technicalRasterVectorPdf.ts's drawWifiSymbol) — only the CENTRAL default for a real WIFI
    // report label changes here.
    return { placementBehavior: "point", placementCardinality: "perQuantity", renderer: "textLabel", displayLabel: "WiFi", color: TECHNICAL_RASTER_COLORS.internet, legendLabel: LEGEND_WIFI, isFallback: false };
  }
  // The plain "Internet" row — a general cabled connection, still a real physical drop point.
  return { placementBehavior: "point", placementCardinality: "perQuantity", renderer: "textLabel", displayLabel: "INT", color: TECHNICAL_RASTER_COLORS.internet, legendLabel: LEGEND_INTERNET_GENERAL, isFallback: false };
}

// ============================================================================
// water (spec section 18) — category-level only, no real per-label variant known yet.
// ============================================================================

function resolveWaterPresentation(): TechnicalServicePresentation {
  return { placementBehavior: "point", placementCardinality: "perQuantity", renderer: "waterDrop", color: TECHNICAL_RASTER_COLORS.water, legendLabel: LEGEND_WATER, isFallback: false };
}

// ============================================================================
// waste (spec section 21; superseded by the CORRECTIVE BATCH below) — "Kontejn 1100 l" (the one
// real label seen) IS a genuine physical object the technician places somewhere for the stand.
//
// CORRECTIVE BATCH (real production — "every imported operational service must be placeable"):
// waste is now placementBehavior "point" too (the earlier "informational" decision predates this
// explicit business requirement). `placementCardinality: "onePerRecord"` — a waste row's own
// quantity is not documented anywhere as "N distinct container spots" (every real label seen so far
// — "Kontejn 1100 l", "vana 3 m3", "vana 9 m3", "Odvoz odpadu" — describes ONE container/service per
// row), so this defaults to the conservative "one marker regardless of quantity" policy rather than
// risk demanding many clicks for a number that doesn't mean "physical points". Centrally
// configurable here alone if real data later proves otherwise.
// ============================================================================

function resolveWastePresentation(): TechnicalServicePresentation {
  return { placementBehavior: "point", placementCardinality: "onePerRecord", renderer: "textLabel", displayLabel: "ODP", color: TECHNICAL_RASTER_COLORS.waste, legendLabel: LEGEND_WASTE, isFallback: false };
}

// ============================================================================
// cleaning (spec section 20; superseded by the CORRECTIVE BATCH below).
//
// CORRECTIVE BATCH (real production — "every imported operational service must be placeable"):
// cleaning is now placementBehavior "point" too — the business requirement is explicit that a
// cleaning record must be placeable on the raster like any other service. `placementCardinality:
// "onePerRecord"` is the load-bearing part of this change: the real example "1C01 daily cleaning
// qty=40" means 40 CLEANING DAYS, never 40 physical spots — this stand still needs exactly ONE
// marker. See domain/technicalRaster.ts's `requiredPlacementCount()` for where this is enforced.
// ============================================================================

function resolveCleaningPresentation(): TechnicalServicePresentation {
  return { placementBehavior: "point", placementCardinality: "onePerRecord", renderer: "textLabel", displayLabel: "ÚKL", color: TECHNICAL_RASTER_COLORS.cleaning, legendLabel: LEGEND_CLEANING, isFallback: false };
}

// ============================================================================
// Fallback (spec section 19) — ANY category/label this config doesn't recognize. Never invented,
// never silently treated as configured — isFallback:true is the one signal every caller (service
// panel badge, dev console) keys off of.
//
// CORRECTIVE BATCH (real production, section 10/13 — "do not make it impossible to place merely
// because its custom icon is missing"): a genuinely UNKNOWN category/label is still a real imported
// operational service the user must be able to place — "point"/"onePerRecord" (the safe, conservative
// default when this app has no data telling it the quantity means physical points) with a compact
// fallback label built from the service's own real externalLabel/category text, never an invented
// name. `isFallback: true` still flags it for the dev console/service-panel badge exactly as before
// — this batch only changes whether it can be PLACED, never whether it's flagged as unrecognized.
// ============================================================================

function fallbackDisplayLabel(category: string, externalLabel: string): string {
  const source = (externalLabel || category).trim();
  if (!source) return "?";
  // A short, compact technical-marker-sized label (spec: "compact fallback based on catalog
  // shortText") — never the whole raw sentence, which would blow past the marker's own bounding box.
  return source.slice(0, 4).toUpperCase();
}

function resolveFallbackPresentation(category: string, externalLabel: string): TechnicalServicePresentation {
  if (typeof console !== "undefined") {
    // eslint-disable-next-line no-console
    console.warn(`[technicalRasterServicePresentation] no dedicated presentation configured for category "${category}" / label "${externalLabel}" — falling back to a compact, still-placeable generic marker.`);
  }
  return {
    placementBehavior: "point",
    placementCardinality: "onePerRecord",
    renderer: "fallback",
    displayLabel: fallbackDisplayLabel(category, externalLabel),
    color: TECHNICAL_RASTER_COLORS.fallback,
    legendLabel: externalLabel || category,
    isFallback: true,
  };
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
 * filtru"). Used ONLY to decide whether a category belongs in the EXPORT symbol filter
 * (TechnicalRasterOutputsPanel.tsx) — never changes what's tracked/shown in the stand detail panel
 * or the editor's own "TECHNICKÉ ZNAČKY" view filters, which still list every category.
 *
 * CORRECTIVE BATCH (real production — "every imported operational service must be placeable"):
 * waste/cleaning are now "point" too (see their own resolvers above), so both must belong in the
 * export filter same as every other category — and any FUTURE category this app doesn't have a
 * name for yet still resolves through `resolveFallbackPresentation`, which is ALSO now "point" —
 * so this simply returns `true` unconditionally. Kept as a named function (never inlined away)
 * so the export filter's own call site stays self-documenting and this decision has one place to
 * change again if a genuinely non-placeable category is ever introduced.
 */
export function categoryCanHaveExportableSymbol(categoryId: string): boolean {
  void categoryId;
  return true;
}
