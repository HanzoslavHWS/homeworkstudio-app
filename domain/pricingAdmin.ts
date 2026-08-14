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

export type PricingEntrySource = "import" | "manual";

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
  /** 'import' = last written by an Excel import batch; 'manual' = last written via Pricing Administration — see resolveImportPriceUpdate() below for why this distinction exists. */
  source: PricingEntrySource;
  /** Last price seen from an Excel import — NULL when never imported (manually created) or when priceMode carries no numeric price. Never touched by a manual edit. */
  sourcePrice: number | undefined;
  validFrom?: string;
  validTo?: string;
  createdAt?: string;
  updatedAt?: string;
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
  /**
   * ONLY meaningful for Duplicate PriceList's copy step (see planDuplicatedPricingEntries) —
   * carries the source entry's own sourcePrice forward so the duplicate keeps a lineage to
   * the last real import price. Every OTHER caller of this type (regular Pricing
   * Administration saves via buildManualSaveRow) ignores this field entirely: a manual save
   * always decides source_price server-side (preserve-on-update / null-on-insert), never from
   * client input — a browser can never set an arbitrary sourcePrice through a normal edit.
   */
  sourcePrice?: number;
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

/**
 * Section 4/5/9: the row a MANUAL Pricing Administration save writes. Always source='manual'
 * — a browser-initiated save is by definition a human action, never an import. source_price
 * is deliberately ABSENT from the update case (the caller must not include that key in the
 * DB update payload at all, so the column keeps whatever it already held — first entry into
 * 'manual', second manual edit, price_mode change from fixed→individual/included, all the
 * same: source_price is preserved, never recomputed from the new sale_price). Only a
 * brand-new row (a cell that was genuinely "missing" before) gets an explicit source_price of
 * null — there is no import reference for a price that never came from an import.
 */
export type ManualSaveRow = Readonly<{
  salePrice: number | undefined;
  priceMode: PricingEntryMode;
  source: "manual";
  sourcePrice?: null;
}>;

export function buildManualSaveRow(edit: PricingEntryEdit, isNewRow: boolean): ManualSaveRow {
  const salePrice = resolvedSalePriceForEdit(edit);
  return isNewRow
    ? { salePrice, priceMode: edit.priceMode, source: "manual", sourcePrice: null }
    : { salePrice, priceMode: edit.priceMode, source: "manual" };
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

/**
 * The row Duplicate PriceList writes for a copied entry. Section 10's decision, reasoned
 * through explicitly (see the final report): a duplicated price list is created by an
 * administrative action, never by an Excel import, so every copy is source='manual' — this
 * is the crucial rule that stops a future re-import of the SOURCE price list's Excel sheet
 * from silently reaching into the newly duplicated (e.g. next year's) price list and
 * overwriting it, since resolveImportPriceUpdate() below only ever auto-updates
 * source='import' rows. sourcePrice carries the source entry's OWN sourcePrice forward
 * (never its salePrice) — preserving "what the last real import actually said" as a
 * reference, without claiming the copy itself came from an import.
 */
export type DuplicatedPricingEntryWrite = Readonly<{
  catalogItemId: string;
  priceListId: string;
  eventId: string;
  currency: Currency;
  priceMode: PricingEntryMode;
  salePrice: number | undefined;
  source: "manual";
  sourcePrice: number | undefined;
}>;

export type DuplicatedPricingPlan = Readonly<{
  /** Entries safe to copy as-is: same currency as source, or a currency-independent mode (individual/included). */
  copied: readonly DuplicatedPricingEntryWrite[];
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
  const copied: DuplicatedPricingEntryWrite[] = [];
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
      source: "manual",
      sourcePrice: entry.sourcePrice,
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

/**
 * Section 11: pure resolution rules a FUTURE Excel importer must apply for every
 * pricing_entries row it touches — never implemented as a running importer in this session,
 * just the safe reusable decision logic + its tests. Four cases:
 *
 * A) DB source=import, incoming price unchanged  → noop (nothing to do).
 * B) DB source=import, incoming price changed     → update: sale_price AND source_price both
 *    become the new import price, source stays 'import' (no manual edit exists to protect).
 * C) DB source=manual, incoming price === sourcePrice → noop: the source file hasn't actually
 *    changed since the manual override was made, so the manual sale_price is left exactly as
 *    it is — this is NOT a "match, so overwrite" case, it is "nothing new happened".
 * D) DB source=manual, incoming price !== sourcePrice → conflict: the source file changed
 *    since the manual override, so sale_price is NEVER auto-touched — a human must review.
 *
 * A missing `current` row (brand new to the DB) is its own fifth, simpler case: always safe
 * to create from the import, since there is nothing to protect yet.
 */
export type ImportPriceAction = "noop" | "update" | "conflict";

export type ImportPriceResolution = Readonly<{
  action: ImportPriceAction;
  reason: string;
  sourcePrice: number | undefined;
  manualPrice: number | undefined;
  incomingImportPrice: number;
  nextSalePrice?: number;
  nextSourcePrice?: number;
}>;

export function resolveImportPriceUpdate(
  current: Readonly<{ source: PricingEntrySource; sourcePrice: number | undefined; salePrice: number | undefined }> | undefined,
  incomingImportPrice: number,
): ImportPriceResolution {
  if (!current) {
    return {
      action: "update",
      reason: "Položka v DB zatím neexistuje — import ji založí jako novou.",
      sourcePrice: undefined,
      manualPrice: undefined,
      incomingImportPrice,
      nextSalePrice: incomingImportPrice,
      nextSourcePrice: incomingImportPrice,
    };
  }
  if (current.source === "import") {
    if (current.sourcePrice === incomingImportPrice) {
      return { action: "noop", reason: "Import cena beze změny.", sourcePrice: current.sourcePrice, manualPrice: undefined, incomingImportPrice };
    }
    return {
      action: "update",
      reason: "Import cena se změnila — žádná ruční úprava k ochraně, aktualizace povolena.",
      sourcePrice: current.sourcePrice,
      manualPrice: undefined,
      incomingImportPrice,
      nextSalePrice: incomingImportPrice,
      nextSourcePrice: incomingImportPrice,
    };
  }
  // current.source === "manual"
  if (current.sourcePrice === incomingImportPrice) {
    return {
      action: "noop",
      reason: "Import cena odpovídá poslední známé importované ceně — ruční cena zůstává zachována beze změny.",
      sourcePrice: current.sourcePrice,
      manualPrice: current.salePrice,
      incomingImportPrice,
    };
  }
  return {
    action: "conflict",
    reason: "Ruční cena se liší od nové importní ceny — vyžaduje ruční review, automaticky nepřepsáno.",
    sourcePrice: current.sourcePrice,
    manualPrice: current.salePrice,
    incomingImportPrice,
  };
}
