/**
 * Tiskové plochy — OPTIONAL pricing calculation (spec section 9). Reuses the app's EXISTING
 * Event → PriceList → PricingEntry chain end to end — never a parallel pricing system:
 *   - domain/catalog.ts's selectPricingEntry/PricingContext (currency-safe, specificity-ranked
 *     entry selection) — the exact same primitive domain/technicalServices.ts's
 *     resolveGraphicsSurfacePricing already uses for the main 3D booth generator.
 *   - The SAME catalog identifiers that already exist for print graphics pricing:
 *     GRAPHICS-FASCIA ("Grafika – límec", priced per bm) and GRAPHICS-FULL-WRAP ("Grafika –
 *     celopolep", priced per m²) — see domain/technicalServices.ts's GRAPHICS_INTERNAL_CODES.
 *     No new catalog item / internal_code is invented here.
 *   - domain/catalogPricing.ts's buildTechnicalCatalogItems, which maps raw DB
 *     CatalogItemSummary/PricingEntrySummary rows into the ComponentDefinition shape
 *     selectPricingEntry already understands.
 *
 * Price belongs to PrintSurfaceItem (the physical surface), never to a MarkerPlacement — a
 * surface pinned on two views still prices/counts exactly once (see
 * domain/printSurfaceProject.ts's item/placement split and sumPrintSurfacePrices below).
 */

import { GRAPHICS_INTERNAL_CODES, TECHNICAL_SERVICE_IDS } from "./technicalServices.ts";
import { findCatalogItemByIdentity, selectPricingEntry, type PricingContext } from "./catalog.ts";
import { buildTechnicalCatalogItems, type CatalogItemSummary, type PricingEntrySummary } from "./catalogPricing.ts";
import type { Currency } from "./models.ts";
import type { PrintSurfaceItem, PrintSurfaceItemDimensionResolution } from "./printSurfaceProject.ts";
import type { PrintSurfaceTypeId } from "./printSurfaceTypeCatalog.ts";

export type PrintSurfacePricingMode = "area_m2" | "running_metre";

/**
 * Límec (fascia) is priced per running metre (bm) — its known height (300mm) never enters the
 * calculation (spec section 9.2: "Límec se pro cenotvorbu NEPOČÍTÁ podle m², i když známe jeho
 * výšku 300 mm"). Every other type — including "Jiná plocha" once included in the calculation
 * (spec section 9.5) — is priced per m². Never re-derive this mapping elsewhere.
 */
export function pricingModeForTypeId(typeId: PrintSurfaceTypeId): PrintSurfacePricingMode {
  return typeId === "fascia" ? "running_metre" : "area_m2";
}

export type PrintSurfacePriceResolution =
  | Readonly<{ status: "excluded" }>
  | Readonly<{ status: "dimension_unavailable" }>
  | Readonly<{ status: "dimension_not_defined" }>
  | Readonly<{ status: "price_not_defined"; mode: PrintSurfacePricingMode; unitLabel: "m²" | "bm"; quantityUnit: number; count: number }>
  | Readonly<{
      status: "priced";
      mode: PrintSurfacePricingMode;
      unitLabel: "m²" | "bm";
      quantityUnit: number;
      count: number;
      unitPrice: number;
      currency: Currency;
      totalPrice: number;
    }>;

function roundTo3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The single source of truth for "what does THIS item cost". Never guesses a rate:
 *   - excluded: includeInCalculation is false (spec 9.1) — a surface never silently affects the
 *     total just by existing.
 *   - dimension_unavailable / dimension_not_defined: passed straight through from
 *     resolvePrintSurfaceItemDimension — a missing/unavailable dimension is never hidden behind a
 *     generic pricing error, and never guessed (spec 9.4).
 *   - price_not_defined: the dimension IS known, but no matching PricingEntry exists yet for this
 *     event/realizačka/price list/currency (spec 9.3) — still reports quantityUnit/count so the UI
 *     can show "Jednotka: 2.223 m²" even though the rate itself is missing.
 *   - priced: a real PricingEntry was resolved via selectPricingEntry — quantityUnit is the
 *     PER-PIECE area (m²) or length (bm), NEVER pre-multiplied by count (spec 9.6/9.7's own
 *     example keeps "1 plocha: 2.223 m²" and "Počet: 3" as separate displayed values); totalPrice
 *     is quantityUnit × unitPrice × count.
 */
export function resolvePrintSurfacePrice(
  item: Pick<PrintSurfaceItem, "typeId" | "quantity" | "includeInCalculation">,
  dimensionResolution: PrintSurfaceItemDimensionResolution,
  catalogItems: readonly CatalogItemSummary[],
  pricingEntries: readonly PricingEntrySummary[],
  context: PricingContext,
): PrintSurfacePriceResolution {
  if (!item.includeInCalculation) return { status: "excluded" };
  if (dimensionResolution.status === "unavailable") return { status: "dimension_unavailable" };
  if (dimensionResolution.status === "not_defined") return { status: "dimension_not_defined" };

  const mode = pricingModeForTypeId(item.typeId);
  const unitLabel: "m²" | "bm" = mode === "running_metre" ? "bm" : "m²";
  const quantityUnit = roundTo3(
    mode === "running_metre"
      ? dimensionResolution.widthMm / 1000
      : (dimensionResolution.widthMm * dimensionResolution.heightMm) / 1_000_000,
  );
  const count = item.quantity ?? 1;

  const internalCode = mode === "running_metre" ? GRAPHICS_INTERNAL_CODES.fascia : GRAPHICS_INTERNAL_CODES.fullWrap;
  const fallbackId = mode === "running_metre" ? TECHNICAL_SERVICE_IDS.fasciaGraphics : TECHNICAL_SERVICE_IDS.fullWrapGraphics;
  const technicalCatalogItems = buildTechnicalCatalogItems(catalogItems, pricingEntries);
  const definition = findCatalogItemByIdentity(technicalCatalogItems, { internalCode, fallbackId });
  const entry = definition ? selectPricingEntry(definition.pricingEntries ?? [], context) : undefined;

  if (!entry || entry.salePrice === undefined) {
    return { status: "price_not_defined", mode, unitLabel, quantityUnit, count };
  }

  return {
    status: "priced",
    mode,
    unitLabel,
    quantityUnit,
    count,
    unitPrice: entry.salePrice,
    currency: entry.currency,
    totalPrice: roundMoney(quantityUnit * entry.salePrice * count),
  };
}

/**
 * The project's total (spec section 9.8) — sum of every "priced" resolution. Each PrintSurfaceItem
 * is counted at most once by construction (one resolution per item — see domain/
 * printSurfaceProject.ts's item/placement split, which is exactly what guarantees a surface pinned
 * on two views is never double-counted here), never per MarkerPlacement.
 */
export function sumPrintSurfacePrices(resolutions: readonly PrintSurfacePriceResolution[]): number {
  return roundMoney(resolutions.reduce((total, resolution) => (resolution.status === "priced" ? total + resolution.totalPrice : total), 0));
}

/** The single place a price resolution becomes Czech display text — Inspector, list and export must all go through this, never re-implement it. */
export function formatPrintSurfacePriceStatus(resolution: PrintSurfacePriceResolution): string {
  if (resolution.status === "excluded") return "";
  if (resolution.status === "dimension_unavailable") return "Není v nabídce";
  if (resolution.status === "dimension_not_defined") return "Rozměr není definován";
  if (resolution.status === "price_not_defined") return "Cena není v ceníku definována";
  return `${resolution.totalPrice.toLocaleString("cs-CZ")} ${resolution.currency}`;
}
