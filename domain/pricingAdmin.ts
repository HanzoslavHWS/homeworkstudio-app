/**
 * Pure domain logic for the "Správa cen" admin layer (pricing administration). Deliberately
 * separate from domain/catalogPricing.ts, which stays the customer-safe path used by the live
 * project workflow (TechnicalRequirementsEditor → Summary/Export). This module's types are
 * allowed to carry admin-only fields (purchasePrice, validFrom/validTo, realizationCompanyId)
 * that must NEVER reach a customer-facing calculation — kept structurally apart so that never
 * becomes a "don't forget to strip it" runtime rule instead of a type-level guarantee.
 *
 * No I/O here — this is only shape + pure functions, mirroring the domain/catalogPricing.ts
 * pattern established earlier in the engagement.
 */
import type { Currency, PricingEntryMode } from "./models.ts";
import type { Exhibition, PriceList } from "./organizations.ts";

export type PricingEntryAdmin = Readonly<{
  id: string;
  catalogItemId: string;
  priceListId: string;
  eventId: string;
  realizationCompanyId: string | null;
  currency: Currency;
  salePrice: number | undefined;
  purchasePrice: number | undefined;
  priceMode: PricingEntryMode;
  validFrom?: string;
  validTo?: string;
  createdAt?: string;
}>;

/**
 * One cell edit: (catalogItemId, priceListId) identifies the cell — the server resolves
 * whether that already has a row (UPDATE) or not (INSERT); the browser never needs to know
 * the underlying pricing_entries.id. eventId/currency travel along so a brand-new cell (one
 * that was "missing" before) can be inserted correctly without a second round-trip.
 */
export type PricingEntryEdit = Readonly<{
  catalogItemId: string;
  priceListId: string;
  eventId: string;
  currency: Currency;
  priceMode: PricingEntryMode;
  /** Required when priceMode is "fixed"; ignored (never written) for "individual"; forced to 0 for "included" if omitted. */
  salePrice?: number;
}>;

export type PricingEntrySaveResult = Readonly<{
  catalogItemId: string;
  priceListId: string;
  status: "ok" | "error";
  message?: string;
}>;

export type PricingEntrySaveSummary = Readonly<{
  results: readonly PricingEntrySaveResult[];
  succeededCount: number;
  failedCount: number;
}>;

export function summarizeSaveResults(results: readonly PricingEntrySaveResult[]): PricingEntrySaveSummary {
  return {
    results,
    succeededCount: results.filter((result) => result.status === "ok").length,
    failedCount: results.filter((result) => result.status === "error").length,
  };
}

/** Section 3: never fabricate "missing = 0" — the resolved sale price to persist for a given edit, or undefined when the mode carries no numeric price at all. */
export function resolvedSalePriceForEdit(edit: Pick<PricingEntryEdit, "priceMode" | "salePrice">): number | undefined {
  if (edit.priceMode === "individual") return undefined;
  if (edit.priceMode === "included") return edit.salePrice ?? 0;
  return edit.salePrice;
}

export type PricingPreviewRow = Readonly<{
  catalogItemId: string;
  catalogItemLabel: string;
  priceListId: string;
  priceListLabel: string;
  currency: Currency;
  before: Readonly<{ priceMode: PricingEntryMode; salePrice: number | undefined }> | undefined;
  after: Readonly<{ priceMode: PricingEntryMode; salePrice: number | undefined }>;
}>;

/**
 * Section 8: "PŘED hromadným zápisem zobraz preview: co se změní, původní hodnota, nová
 * hodnota" — pure, so the UI (and tests) can assert exactly what a bulk/matrix save is about
 * to do before any network call happens. `before` is undefined when the cell was genuinely
 * missing (no existing PricingEntryAdmin row) — never synthesized as a zero-value row.
 */
export function buildPricingEditPreview(
  currentEntries: readonly PricingEntryAdmin[],
  edits: readonly PricingEntryEdit[],
  labels: Readonly<{ catalogItem: (id: string) => string; priceList: (id: string) => string }>,
): readonly PricingPreviewRow[] {
  return edits.map((edit) => {
    const existing = currentEntries.find((entry) => entry.catalogItemId === edit.catalogItemId && entry.priceListId === edit.priceListId);
    return {
      catalogItemId: edit.catalogItemId,
      catalogItemLabel: labels.catalogItem(edit.catalogItemId),
      priceListId: edit.priceListId,
      priceListLabel: labels.priceList(edit.priceListId),
      currency: edit.currency,
      before: existing ? { priceMode: existing.priceMode, salePrice: existing.salePrice } : undefined,
      after: { priceMode: edit.priceMode, salePrice: resolvedSalePriceForEdit(edit) },
    };
  });
}

/**
 * Section 9: bulk "Nastavit cenu" must never apply ONE typed number across mixed currencies —
 * the operator provides a value PER CURRENCY, and a cell whose currency has no provided value
 * is simply left out of the batch (never silently zeroed, never converted from the other
 * currency's figure).
 */
export type BulkPriceChange = Readonly<{
  priceMode: PricingEntryMode;
  salePriceByCurrency?: Readonly<Partial<Record<Currency, number>>>;
}>;

export function buildBulkEdits(
  catalogItemIds: readonly string[],
  priceLists: readonly Readonly<{ id: string; currency: Currency; eventId: string }>[],
  change: BulkPriceChange,
): readonly PricingEntryEdit[] {
  const edits: PricingEntryEdit[] = [];
  for (const catalogItemId of catalogItemIds) {
    for (const priceList of priceLists) {
      if (change.priceMode === "fixed") {
        const salePrice = change.salePriceByCurrency?.[priceList.currency];
        if (salePrice === undefined) continue; // no value provided for this currency — skip, never guess
        edits.push({ catalogItemId, priceListId: priceList.id, eventId: priceList.eventId, currency: priceList.currency, priceMode: "fixed", salePrice });
      } else {
        edits.push({ catalogItemId, priceListId: priceList.id, eventId: priceList.eventId, currency: priceList.currency, priceMode: change.priceMode });
      }
    }
  }
  return edits;
}

export type DuplicatePriceListDraft = Readonly<{
  name: string;
  code: string;
  year: number;
  edition?: string;
  eventId?: string;
  currency: Currency;
  realizationCompanyId?: string;
  validFrom?: string;
  validTo?: string;
  active: boolean;
}>;

export type DuplicateCodeValidation = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Section 11: new PriceList must never collide with an existing code — STOP, never silent overwrite. Case-insensitive: "BEAUTY-2027-CZK" and "beauty-2027-czk" are the same collision. */
export function validateNewPriceListCode(existingCodes: readonly string[], newCode: string): DuplicateCodeValidation {
  const trimmed = newCode.trim();
  if (!trimmed) return { ok: false, reason: "Kód ceníku nesmí být prázdný." };
  const normalized = trimmed.toLocaleUpperCase("en");
  const collision = existingCodes.some((code) => code.trim().toLocaleUpperCase("en") === normalized);
  return collision ? { ok: false, reason: `Ceník s kódem "${trimmed}" už existuje.` } : { ok: true };
}

export type DuplicatedPricingPlan = Readonly<{
  /** Entries safe to copy as-is: same currency as source, or a currency-independent mode (individual/included). */
  copied: readonly PricingEntryEdit[];
  /** Fixed-price entries skipped because the target currency differs from the source entry's currency — copying the raw number would fabricate a false price (never converted, never mislabeled). */
  skippedCurrencyMismatch: readonly PricingEntryAdmin[];
}>;

/**
 * Section 10/12: "Zkopíruje se X cenových položek." — computed BEFORE any write so the
 * confirmation dialog can show a true count. Section 9's no-conversion rule applies here too:
 * duplicating BEAUTY-2026-CZK into a new EUR price list must not carry over the CZK numbers as
 * if they were EUR — those rows are intentionally left uncreated (the new list correctly shows
 * them as "missing" rather than a fabricated price).
 */
export function planDuplicatedPricingEntries(
  sourceEntries: readonly PricingEntryAdmin[],
  target: Readonly<{ priceListId: string; eventId: string; currency: Currency }>,
): DuplicatedPricingPlan {
  const copied: PricingEntryEdit[] = [];
  const skippedCurrencyMismatch: PricingEntryAdmin[] = [];
  for (const entry of sourceEntries) {
    const currencyMatches = entry.currency === target.currency;
    if (entry.priceMode === "fixed" && !currencyMatches) {
      skippedCurrencyMismatch.push(entry);
      continue;
    }
    copied.push({
      catalogItemId: entry.catalogItemId,
      priceListId: target.priceListId,
      eventId: target.eventId,
      currency: target.currency,
      priceMode: entry.priceMode,
      salePrice: entry.priceMode === "fixed" ? entry.salePrice : entry.priceMode === "included" ? (entry.salePrice ?? 0) : undefined,
    });
  }
  return { copied, skippedCurrencyMismatch };
}

/**
 * Section 5: Component Price View / Pricing Matrix filters — combinable (year AND event AND
 * currency AND explicit price-list-selection AND price-mode all narrow the same candidate
 * set). Empty arrays/strings mean "no restriction on this dimension".
 */
export type PricingFilters = Readonly<{
  year: string;
  eventIds: readonly string[];
  currency: "" | Currency;
  priceListIds: readonly string[];
  priceMode: "" | PricingEntryMode;
}>;

/**
 * Section 16: never "load everything" by default — inactive/archived price lists are excluded
 * unless explicitly picked via the Ceník filter (an admin who explicitly selected an archived
 * list should still see it). Event matching prefers the authoritative Exhibition.priceListIds
 * link, falling back to the denormalized PriceList.eventId for lists not yet reflected there.
 */
export function filterPriceListsForAdmin(
  priceLists: readonly PriceList[],
  events: readonly Exhibition[],
  filters: PricingFilters,
): readonly PriceList[] {
  return priceLists.filter((list) => {
    if (!list.active && !filters.priceListIds.includes(list.id)) return false;
    if (filters.year && list.year !== Number(filters.year)) return false;
    if (filters.currency && list.currency !== filters.currency) return false;
    if (filters.priceListIds.length > 0 && !filters.priceListIds.includes(list.id)) return false;
    if (filters.eventIds.length > 0) {
      const belongsToSelectedEvent = filters.eventIds.some((eventId) => events.find((event) => event.id === eventId)?.priceListIds.includes(list.id) || list.eventId === eventId);
      if (!belongsToSelectedEvent) return false;
    }
    return true;
  });
}
