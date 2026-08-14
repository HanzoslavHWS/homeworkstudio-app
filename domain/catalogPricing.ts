/**
 * DB catalog_items + pricing_entries -> app pricing. Pure, no I/O.
 *
 * The whole point of this module is to reuse domain/catalog.ts's ALREADY-tested,
 * currency-safe primitives (selectPricingEntry / derivePricingAvailability) instead of
 * inventing a parallel resolution algorithm: DB rows are mapped into the exact same
 * ComponentDefinition/PricingEntry shapes the rest of the app already understands
 * (domain/technicalServices.ts's priceCleaning/priceGraphics, domain/calculationExport.ts),
 * so "event + project currency + catalog item -> PriceList -> PricingEntry" is answered by
 * composing resolveEventPriceListForCurrency() (domain/organizations.ts) with
 * selectPricingEntry() (domain/catalog.ts) — no new resolution logic, no new risk of
 * diverging from the currency-isolation rules already proven there.
 */
import type { CatalogItemKind, CatalogItemStatus, ComponentDefinition, Currency, PricingEntry, PricingEntryMode } from "./models.ts";
import { isGeneratorEligible } from "./catalogReadiness.ts";

// ============================================================================
// Browser-safe summary shapes — deliberately NOT the raw DB row/document. Never carries
// import/debug metadata (sourceSystem, sourceKey, raw Excel traceability) to the browser.
// ============================================================================

export type CatalogItemSummary = Readonly<{
  id: string;
  internalCode: string | null;
  kind: CatalogItemKind;
  lifecycleStatus: CatalogItemStatus;
  displayName: string;
  category: string | null;
  unit: string | null;
  generatorEligible: boolean;
}>;

export type PricingEntrySummary = Readonly<{
  id: string;
  catalogItemId: string;
  priceListId: string;
  eventId: string;
  currency: Currency;
  salePrice: number | null;
  priceMode: PricingEntryMode;
}>;

/**
 * Section 4: DB existence never implies generator eligibility on its own — this only ever
 * reports what isGeneratorEligible() (domain/catalogReadiness.ts) already computed from the
 * item's real lifecycle_status + readiness. needs_review items always come back false here;
 * callers must never merge CatalogItemSummary rows into the generic ComponentLibrary based on
 * anything else.
 */
export function computeGeneratorEligible(document: ComponentDefinition, lifecycleStatus: CatalogItemStatus, kind: CatalogItemKind): boolean {
  return isGeneratorEligible({ ...document, lifecycleStatus }, kind);
}

/**
 * Builds the minimal ComponentDefinition shape domain/technicalServices.ts's pricing
 * functions (priceCleaning/priceElectricity/priceGraphics) and
 * domain/calculationExport.ts already know how to price — never placed in a scene, never fed
 * to ComponentLibrary. pricingEntries only ever contains entries for THIS catalog item (never
 * cross-item leakage), each carrying its own priceListId/exhibitionId/currency exactly as
 * stored, so selectPricingEntry() enforces currency isolation the same way it already does
 * for every other catalog item in the app.
 */
export function toTechnicalServiceComponentDefinition(item: CatalogItemSummary, entries: readonly PricingEntrySummary[]): ComponentDefinition {
  const pricingEntries: readonly PricingEntry[] = entries
    .filter((entry) => entry.catalogItemId === item.id)
    .map((entry) => ({
      id: entry.id,
      itemId: item.id,
      exhibitionId: entry.eventId,
      priceListId: entry.priceListId,
      currency: entry.currency,
      salePrice: entry.salePrice ?? undefined,
      priceMode: entry.priceMode,
    }));
  return {
    id: item.id,
    internalCode: item.internalCode ?? undefined,
    displayName: item.displayName,
    type: "service",
    name: item.displayName,
    category: item.category ?? "",
    widthMm: 0,
    depthMm: 0,
    resizable: false,
    productionProfiles: {},
    rotation: { defaultMode: "free", snapStep: 45, quickAngles: [0], allowFreeRotation: true, locked: false },
    systemLocked: false,
    userLocked: false,
    visible: true,
    sceneLabel: item.displayName,
    unit: item.unit ?? undefined,
    active: item.lifecycleStatus !== "archived" && item.lifecycleStatus !== "inactive",
    catalogItemType: "service",
    pricingEntries,
    lifecycleStatus: item.lifecycleStatus,
    catalogItemKind: item.kind,
  } as ComponentDefinition;
}

/**
 * Section 3: catalog hydration for TECHNICAL-SERVICE PRICING ONLY — never merged into the
 * generic furniture/booth catalog (data/components.ts stays the source of truth for
 * ComponentLibrary/scene placement, untouched here).
 */
export function buildTechnicalCatalogItems(items: readonly CatalogItemSummary[], entries: readonly PricingEntrySummary[]): readonly ComponentDefinition[] {
  return items.map((item) => toTechnicalServiceComponentDefinition(item, entries));
}

/** Looks a DB catalog item up by its confirmed internalCode — never by display name (see Batch #1/#2A's false-positive lessons). Returns undefined for NULL/unmapped codes rather than guessing. */
export function findCatalogItemByInternalCode(items: readonly CatalogItemSummary[], internalCode: string | undefined): CatalogItemSummary | undefined {
  if (!internalCode) return undefined;
  return items.find((item) => item.internalCode === internalCode);
}
