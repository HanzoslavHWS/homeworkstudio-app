/**
 * Technické rastry — centralized mapping from an imported service's OWN real data (category +
 * externalLabel + quantity, exactly what the parser produced) to how it is drawn as a technical
 * marker: its text, color, whether it needs a POINT, how many points, and its stable variant id.
 *
 * This is the ONE place that decision is made — the editor canvas, the stand/placement panels, the
 * work queue, the PDF export and the incremental re-import all read it from here.
 *
 * HOTFIX-02 (technical markers) — the labels, colors and point-count rules are the ones APPROVED in
 * `_IMPORT/TECHNICKE_ZNACKY/Generator_ABF_Revize_technickych_znacek.xlsx` (sheet "Technické
 * značky", columns K "NOVÝ popisek v rastru" = L "NOVÝ text v PDF", N "NOVÁ barva", P "NOVÉ pravidlo
 * počtu bodů"). They live in the ordered TECHNICAL_MARKER_VARIANTS table below instead of scattered
 * regex branches. Every marker is now TEXT (no star/drop glyph by default) and the editor and the
 * PDF draw the very same `displayLabel`. `tests/technicalRasterServicePresentation.test.ts` pins
 * every approved row; `scripts/technicalMarkersExcelCheck.ts` re-checks the table against the real
 * Excel when it is present locally (it is never committed).
 *
 * Each variant also carries a stable `variantId` — the service's INTERNAL identity, deliberately
 * separate from its display label. Reconciliation (domain/technicalRasterReconciliation.ts) and the
 * incremental re-import key off it. Before HOTFIX-02 several different services shared one id
 * ("Rozvaděč 9-21kW" = "Do 21kW 400V" = "21kw", "Non stop" = "Lednicový okruh" = "refrigerated"), so
 * a re-import could move a placement from one of them to the other. Ids of services that never
 * collided are kept byte-identical ("2kw", "fixed-ip", "wifi", "internet:router", ...).
 */

export type TechnicalServicePlacementBehavior = "point" | "informational" | "none";

/**
 * Separates the imported record's own `quantity` (kW count, cleaning days, m³, licenses, ...) from
 * how many physical marker CLICKS the raster needs:
 *   - "perQuantity"  — quantity = number of distinct physical points (2× "Do 3kW" = 2 markers).
 *   - "onePerRecord" — exactly ONE marker regardless of the number ("Denní úklid" qty=40 = 1 marker,
 *     "Bazén - objem: 3" = 1 marker labelled "3 m³").
 * Consumed ONLY by domain/technicalRaster.ts's `requiredPlacementCount()`.
 */
export type TechnicalServicePlacementCardinality = "onePerRecord" | "perQuantity";

/**
 * How the marker is drawn. HOTFIX-02: the central defaults are only "powerLabel" (kW values, a
 * slightly smaller PDF size) and "textLabel"; "refrigeratedStar"/"waterDrop"/"wifiIcon" stay valid
 * renderers (a TechnicalRasterComponentConfig override may still pick them, and older code paths can
 * still draw them) but no service resolves to them by default any more.
 */
export type TechnicalServiceSymbolRenderer = "powerLabel" | "refrigeratedStar" | "textLabel" | "wifiIcon" | "waterDrop" | "fallback";

export type TechnicalServicePresentation = Readonly<{
  placementBehavior: TechnicalServicePlacementBehavior;
  placementCardinality: TechnicalServicePlacementCardinality;
  renderer: TechnicalServiceSymbolRenderer;
  /** The exact text drawn in the editor AND in the PDF ("3 kW", "El.rozvaděč", "3 m³"). */
  displayLabel?: string;
  /** Hex color — always one of TECHNICAL_RASTER_COLORS below. */
  color: string;
  /** The service's CATEGORY legend text ("ELEKTŘINA", "INTERNET / WiFi", ...) — the PDF legend explains colors only, never individual labels. Unknown categories carry their own raw ABRA label. */
  legendLabel: string;
  /** Stable internal identity of the service variant (see module doc) — never shown to the user. */
  variantId: string;
  /** True ONLY for the deterministic last-resort fallback (unknown category) — flagged in the UI and the dev console, never hidden. */
  isFallback: boolean;
}>;

// ============================================================================
// Colors — the approved category colors (Excel column N). Manual drawings reuse this SAME table
// (domain/technicalRasterDrawings.ts) instead of a second, unrelated palette.
// ============================================================================

export const TECHNICAL_RASTER_COLORS = {
  electricity: "#b3261e",
  internet: "#b8860b",
  water: "#1a7a4c",
  waste: "#7a5230",
  cleaning: "#6a4c93",
  /** Neutral technical gray for an unknown category. */
  fallback: "#6b6f72",
  /** Neutral black — manual drawings only ("Neutrální"), never an imported service. */
  neutral: "#111111",
} as const;

/**
 * Category legend texts (HOTFIX-02, phase 7: the legend explains the COLOR of a category, never what
 * "5 kW" means). Also used as the editor tooltip's category line.
 */
export const TECHNICAL_CATEGORY_LEGEND_LABELS: Readonly<Record<string, string>> = {
  electricity: "ELEKTŘINA",
  internet: "INTERNET / WiFi",
  water: "VODA",
  cleaning: "ÚKLID",
  waste: "ODPAD",
};

// ============================================================================
// Label helpers (kept exported — reconciliation and the catalog import reuse them)
// ============================================================================

const KW_PATTERN = /(\d+(?:[.,]\d+)?)\s*kw/iu;
const REFRIGERATED_PATTERN = /lednic/iu;
const NON_STOP_PATTERN = /non\s*-?\s*stop/iu;
/** `č` matched with or without the diacritic — some real PDF text extraction strips it. */
const BREAKER_PATTERN = /jisti[cč]/iu;
const FIXED_IP_PATTERN = /pevn[aá]\s*ip/iu;
const WIFI_PATTERN = /wi[\s-]?fi/iu;

function stripDiacritics(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/gu, "").toLowerCase();
}

/** Whitespace/case/diacritics-normalized copy of a raw label — the generic variant id for labels without a dedicated variant. */
export function normalizeGenericServiceVariant(externalLabel: string): string {
  return stripDiacritics(externalLabel).replace(/\s+/gu, " ").trim();
}

export function isBreakerCharacteristicLabel(externalLabel: string): boolean {
  return BREAKER_PATTERN.test(externalLabel);
}

/** "Jistič C" -> "C", "Jistič C16" / "Jistič C 16A" -> "C16"; undefined when no characteristic letter follows (the caller shows "JIS", never a guessed letter). */
export function extractBreakerCharacteristicLabel(externalLabel: string): string | undefined {
  const match = externalLabel.match(/jisti[cč]\w*[^a-z0-9]*([a-z])\s*(\d{1,3})?/iu);
  if (!match) return undefined;
  const letter = match[1]!.toUpperCase();
  const amps = match[2];
  return amps ? `${letter}${amps}` : letter;
}

/** "Do 3kW 230V" -> "3 kW"; undefined when the label holds no safe kW figure (never a guess). */
export function extractElectricityKwLabel(externalLabel: string): string | undefined {
  const match = externalLabel.match(KW_PATTERN);
  if (!match) return undefined;
  const numeric = Number(match[1]!.replace(",", "."));
  if (!Number.isFinite(numeric)) return undefined;
  return `${numeric} kW`;
}

/** "Lednicový okruh" only — HOTFIX-02 split "Non stop" into its own variant (see isNonStopElectricityLabel). */
export function isRefrigeratedElectricityLabel(externalLabel: string): boolean {
  return REFRIGERATED_PATTERN.test(externalLabel);
}

export function isNonStopElectricityLabel(externalLabel: string): boolean {
  return NON_STOP_PATTERN.test(externalLabel);
}

export function isFixedIpLabel(externalLabel: string): boolean {
  return FIXED_IP_PATTERN.test(externalLabel);
}
export function isWifiLabel(externalLabel: string): boolean {
  return WIFI_PATTERN.test(externalLabel);
}

/** Router rental is equipment, never another Internet connection (real Beauty case 3A45). */
export function isRouterRentalLabel(externalLabel: string): boolean {
  return /router|smerovac/u.test(stripDiacritics(externalLabel));
}

/** A quantity as marker text — the same plain number format the approved kW labels use ("0.5 kW", "3 m³"). */
export function formatMarkerQuantity(quantity: number | undefined): string {
  if (quantity === undefined || !Number.isFinite(quantity)) return "?";
  return String(Math.round(quantity * 1000) / 1000);
}

// ============================================================================
// The approved variant table (Excel rows 2-35), in match order per category. The FIRST matching
// row wins, so specific labels ("Rozvaděč 9-21kW") come before generic patterns (any "…kW").
// ============================================================================

type MarkerVariant = Readonly<{
  /** Stable internal id, or a function of the label for families (kW values, breakers). */
  variantId: string | ((externalLabel: string) => string);
  matches: (externalLabel: string, normalized: string) => boolean;
  /** Fixed text, or a function of label/quantity for dynamic labels ("{mnozstvi} m³", "3 kW"). */
  label: string | ((externalLabel: string, quantity: number | undefined) => string);
  cardinality: TechnicalServicePlacementCardinality;
  renderer?: TechnicalServiceSymbolRenderer;
}>;

const ELECTRICITY_VARIANTS: readonly MarkerVariant[] = [
  { variantId: "refrigerated", matches: (label) => isRefrigeratedElectricityLabel(label), label: "LED", cardinality: "perQuantity" },
  { variantId: "electricity:non-stop", matches: (label) => isNonStopElectricityLabel(label), label: "Non-stop", cardinality: "perQuantity" },
  { variantId: "electricity:distribution-board", matches: (_label, normalized) => /rozvad/u.test(normalized), label: "El.rozvaděč", cardinality: "perQuantity" },
  {
    // No characteristic letter ("Jistič 3x16A") -> the raw label is the id, so two such breakers never share one.
    variantId: (label) => {
      const characteristic = extractBreakerCharacteristicLabel(label);
      return characteristic ? `electricity:breaker:${characteristic.toLowerCase()}` : `electricity:breaker|${normalizeGenericServiceVariant(label)}`;
    },
    matches: (label) => isBreakerCharacteristicLabel(label),
    label: (label) => extractBreakerCharacteristicLabel(label) ?? "JIS",
    cardinality: "perQuantity",
  },
  { variantId: "electricity:overhead-feed", matches: (_label, normalized) => /vrchni\s*privod/u.test(normalized), label: "Vrch. Přívod", cardinality: "perQuantity" },
  { variantId: "electricity:lighting", matches: (_label, normalized) => /osvetlen/u.test(normalized), label: "OSV", cardinality: "perQuantity" },
  { variantId: "electricity:additional-kw", matches: (_label, normalized) => /^\+\s*kw$/u.test(normalized), label: "EL", cardinality: "perQuantity" },
  {
    variantId: (label) => extractElectricityKwLabel(label)!.replace(/\s+/gu, "").toLowerCase(),
    matches: (label) => extractElectricityKwLabel(label) !== undefined,
    label: (label) => extractElectricityKwLabel(label)!,
    cardinality: "perQuantity",
    renderer: "powerLabel",
  },
  // Any other real electricity row — still a placeable connection with an honest "EL" label. The
  // raw label is part of the id so two different unrecognized rows never share an identity.
  { variantId: (label) => `electricity:unrecognized|${normalizeGenericServiceVariant(label)}`, matches: () => true, label: "EL", cardinality: "perQuantity" },
];

const INTERNET_VARIANTS: readonly MarkerVariant[] = [
  { variantId: "fixed-ip", matches: (label) => isFixedIpLabel(label), label: "IP", cardinality: "perQuantity" },
  // A WiFi order's quantity means licenses/devices, never physical access points — one marker.
  { variantId: "wifi", matches: (label) => isWifiLabel(label), label: "WiFi", cardinality: "onePerRecord" },
  { variantId: "internet:router", matches: (label) => isRouterRentalLabel(label), label: "Router", cardinality: "perQuantity" },
  { variantId: "internet:plain", matches: () => true, label: "INT", cardinality: "perQuantity" },
];

const WATER_VARIANTS: readonly MarkerVariant[] = [
  // Dynamic label: "Bazén - objem" qty 3 -> ONE marker "3 m³"; a re-import with qty 5 keeps the same
  // service id and its one placement, only the text becomes "5 m³".
  { variantId: "water:pool-volume", matches: (_label, normalized) => /bazen/u.test(normalized) && /objem/u.test(normalized), label: (_label, quantity) => `${formatMarkerQuantity(quantity)} m³`, cardinality: "onePerRecord" },
  { variantId: "water:pool-connection", matches: (_label, normalized) => /bazen/u.test(normalized) && /pripoj/u.test(normalized), label: "Napuš.Bazén", cardinality: "onePerRecord" },
  { variantId: "water:connection", matches: (_label, normalized) => /voda/u.test(normalized) && /odpad/u.test(normalized), label: "Voda", cardinality: "perQuantity" },
  { variantId: (label) => normalizeGenericServiceVariant(label), matches: () => true, label: "Voda", cardinality: "perQuantity" },
];

const WASTE_VARIANTS: readonly MarkerVariant[] = [
  { variantId: (label) => normalizeGenericServiceVariant(label), matches: () => true, label: "ODP", cardinality: "onePerRecord" },
];

const CLEANING_VARIANTS: readonly MarkerVariant[] = [
  { variantId: "cleaning:daily", matches: (_label, normalized) => /denn/u.test(normalized) && /uklid/u.test(normalized), label: "ÚKL", cardinality: "onePerRecord" },
  { variantId: "cleaning:general", matches: (_label, normalized) => /uklid/u.test(normalized) && (/general/u.test(normalized) || /jednorazov/u.test(normalized)), label: "ÚKL", cardinality: "onePerRecord" },
  { variantId: (label) => normalizeGenericServiceVariant(label), matches: () => true, label: "ÚKL", cardinality: "onePerRecord" },
];

const VARIANTS_BY_CATEGORY: Readonly<Record<string, readonly MarkerVariant[]>> = {
  electricity: ELECTRICITY_VARIANTS,
  internet: INTERNET_VARIANTS,
  water: WATER_VARIANTS,
  waste: WASTE_VARIANTS,
  cleaning: CLEANING_VARIANTS,
};

const COLOR_BY_CATEGORY: Readonly<Record<string, string>> = {
  electricity: TECHNICAL_RASTER_COLORS.electricity,
  internet: TECHNICAL_RASTER_COLORS.internet,
  water: TECHNICAL_RASTER_COLORS.water,
  waste: TECHNICAL_RASTER_COLORS.waste,
  cleaning: TECHNICAL_RASTER_COLORS.cleaning,
};

function findVariant(category: string, externalLabel: string): MarkerVariant | undefined {
  const variants = VARIANTS_BY_CATEGORY[category];
  if (!variants) return undefined;
  const normalized = normalizeGenericServiceVariant(externalLabel);
  return variants.find((variant) => variant.matches(externalLabel, normalized));
}

// ============================================================================
// Fallback — an unknown category. Still placeable (one marker), flagged, never invented.
// ============================================================================

function fallbackDisplayLabel(category: string, externalLabel: string): string {
  const source = (externalLabel || category).trim();
  if (!source) return "?";
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
    variantId: normalizeGenericServiceVariant(externalLabel),
    isFallback: true,
  };
}

/**
 * The ONE entry point every UI/export caller uses. `quantity` is the service's own imported
 * quantity — needed only by dynamic labels ("{mnozstvi} m³"); every other variant ignores it.
 */
export function resolveTechnicalServicePresentation(category: string, externalLabel: string, quantity?: number): TechnicalServicePresentation {
  const variant = findVariant(category, externalLabel);
  if (!variant) return resolveFallbackPresentation(category, externalLabel);
  return {
    placementBehavior: "point",
    placementCardinality: variant.cardinality,
    renderer: variant.renderer ?? "textLabel",
    displayLabel: typeof variant.label === "string" ? variant.label : variant.label(externalLabel, quantity),
    color: COLOR_BY_CATEGORY[category]!,
    legendLabel: TECHNICAL_CATEGORY_LEGEND_LABELS[category]!,
    variantId: typeof variant.variantId === "string" ? variant.variantId : variant.variantId(externalLabel),
    isFallback: false,
  };
}

/** Same as resolveTechnicalServicePresentation, for a stored service (passes its own quantity). */
export function resolveServicePresentation(service: Readonly<{ category: string; externalLabel: string; quantity: number }>): TechnicalServicePresentation {
  return resolveTechnicalServicePresentation(service.category, service.externalLabel, service.quantity);
}

/**
 * The internal variant id alone — what reconciliation and the re-import compare. Independent of
 * quantity and of the display label by construction. Unknown categories use the normalized label
 * (without the fallback's console warning — this is called in loops).
 */
export function resolveServiceVariantId(category: string, externalLabel: string): string {
  const variant = findVariant(category, externalLabel);
  if (!variant) return normalizeGenericServiceVariant(externalLabel);
  return typeof variant.variantId === "string" ? variant.variantId : variant.variantId(externalLabel);
}

/**
 * The variant id this app used BEFORE HOTFIX-02, for compatibility checks and tests only. It is
 * deliberately never used for pairing: identities are always recomputed on both sides of a
 * re-import with the CURRENT table, so an older project needs no migration (see
 * domain/technicalRasterReconciliation.ts resolveServiceIdentityKey).
 */
export function resolveLegacyServiceIdentityKey(category: string, externalLabel: string): string {
  let variant: string;
  if (category === "electricity") {
    if (REFRIGERATED_PATTERN.test(externalLabel) || NON_STOP_PATTERN.test(externalLabel)) variant = "refrigerated";
    else {
      const kw = extractElectricityKwLabel(externalLabel);
      variant = kw ? kw.replace(/\s+/gu, "").toLowerCase() : "electricity:unrecognized";
    }
  } else if (category === "internet") {
    variant = isFixedIpLabel(externalLabel) ? "fixed-ip" : isWifiLabel(externalLabel) ? "wifi" : isRouterRentalLabel(externalLabel) ? "internet:router" : "internet:plain";
  } else if (category === "cleaning") {
    const normalized = normalizeGenericServiceVariant(externalLabel);
    variant = /denn/u.test(normalized) && /uklid/u.test(normalized) ? "cleaning:daily" : /uklid/u.test(normalized) && (/general/u.test(normalized) || /jednorazov/u.test(normalized)) ? "cleaning:general" : normalized;
  } else if (category === "water") {
    const normalized = normalizeGenericServiceVariant(externalLabel);
    variant = /voda/u.test(normalized) && /odpad/u.test(normalized) ? "water:connection" : normalized;
  } else {
    variant = normalizeGenericServiceVariant(externalLabel);
  }
  if (variant === "electricity:unrecognized") return `${category}|${variant}|${normalizeGenericServiceVariant(externalLabel)}`;
  return `${category}|${variant}`;
}

/**
 * Whether ANY label in this category can resolve to a "point" — decides membership in the EXPORT
 * symbol filter only. Every category (and the fallback) is placeable, so this is always true; kept
 * as a named function so that decision has one place to change.
 */
export function categoryCanHaveExportableSymbol(categoryId: string): boolean {
  void categoryId;
  return true;
}
