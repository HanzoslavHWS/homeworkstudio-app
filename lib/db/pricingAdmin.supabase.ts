import type { SupabaseClient } from "@supabase/supabase-js";
import type { Currency, PricingEntryMode } from "../../domain/models.ts";
import type { PriceList } from "../../domain/organizations.ts";
import {
  planDuplicatedPricingEntries,
  resolvedSalePriceForEdit,
  summarizeSaveResults,
  validateNewPriceListCode,
  type DuplicatePriceListDraft,
  type PricingEntryAdmin,
  type PricingEntryEdit,
  type PricingEntrySaveSummary,
} from "../../domain/pricingAdmin.ts";
import { priceListToRow, rowToPriceList, type PriceListRow } from "./priceListRepository.supabase.ts";

export class DuplicatePriceListCodeError extends Error {
  constructor(code: string) {
    super(`Ceník s kódem "${code}" už existuje.`);
    this.name = "DuplicatePriceListCodeError";
  }
}

export class PriceListNotFoundError extends Error {
  constructor(id: string) {
    super(`Zdrojový ceník (${id}) nebyl nalezen.`);
    this.name = "PriceListNotFoundError";
  }
}

type PricingEntryAdminRow = Readonly<{
  id: string;
  catalog_item_id: string;
  price_list_id: string;
  event_id: string;
  realization_company_id: string | null;
  currency: Currency;
  sale_price: number | null;
  purchase_price: number | null;
  valid_from: string | null;
  valid_to: string | null;
  price_mode: string;
  created_at: string;
}>;

function rowToPricingEntryAdmin(row: PricingEntryAdminRow): PricingEntryAdmin {
  return {
    id: row.id,
    catalogItemId: row.catalog_item_id,
    priceListId: row.price_list_id,
    eventId: row.event_id,
    realizationCompanyId: row.realization_company_id,
    currency: row.currency,
    salePrice: row.sale_price ?? undefined,
    purchasePrice: row.purchase_price ?? undefined,
    priceMode: row.price_mode as PricingEntryMode,
    validFrom: row.valid_from ?? undefined,
    validTo: row.valid_to ?? undefined,
    createdAt: row.created_at,
  };
}

/**
 * Admin-only read — richer than domain/catalogPricing.ts's customer-safe PricingEntrySummary
 * (carries purchasePrice/validFrom/validTo/realizationCompanyId). Never exposed through the
 * customer-facing /api/pricing/entries route; only the /api/pricing-admin/* routes use this.
 *
 * Section 16: always scoped by at least one of catalogItemIds/priceListIds — never "load
 * everything", even though pricing_entries is small today (495 rows).
 */
export async function readPricingEntriesAdmin(
  client: SupabaseClient,
  filter: Readonly<{ catalogItemIds?: readonly string[]; priceListIds?: readonly string[] }>,
): Promise<readonly PricingEntryAdmin[]> {
  const catalogItemIds = filter.catalogItemIds ?? [];
  const priceListIds = filter.priceListIds ?? [];
  if (catalogItemIds.length === 0 && priceListIds.length === 0) {
    throw new Error("readPricingEntriesAdmin requires at least one of catalogItemIds/priceListIds.");
  }
  let query = client.from("pricing_entries").select("id, catalog_item_id, price_list_id, event_id, realization_company_id, currency, sale_price, purchase_price, valid_from, valid_to, price_mode, created_at");
  if (catalogItemIds.length > 0) query = query.in("catalog_item_id", catalogItemIds);
  if (priceListIds.length > 0) query = query.in("price_list_id", priceListIds);
  const { data, error } = await query;
  if (error) throw error;
  return ((data ?? []) as PricingEntryAdminRow[]).map(rowToPricingEntryAdmin);
}

/**
 * Section 14: idempotent, per-cell. Each (catalogItemId, priceListId) pair resolves to at most
 * one row — an existing row is UPDATEd, a genuinely new cell (previously "missing") is
 * INSERTed. Errors are caught PER EDIT so one bad row never silently swallows the rest of the
 * batch, and the caller can never mistake "12 of 15 succeeded" for "all saved".
 */
export async function saveManyPricingEntriesAdmin(
  client: SupabaseClient,
  edits: readonly PricingEntryEdit[],
): Promise<PricingEntrySaveSummary> {
  const results = [];
  for (const edit of edits) {
    try {
      const { data: existing, error: lookupError } = await client
        .from("pricing_entries")
        .select("id")
        .eq("catalog_item_id", edit.catalogItemId)
        .eq("price_list_id", edit.priceListId)
        .maybeSingle();
      if (lookupError) throw lookupError;
      const row = {
        catalog_item_id: edit.catalogItemId,
        price_list_id: edit.priceListId,
        event_id: edit.eventId,
        currency: edit.currency,
        sale_price: resolvedSalePriceForEdit(edit) ?? null,
        price_mode: edit.priceMode,
      };
      if (existing) {
        const { error } = await client.from("pricing_entries").update(row).eq("id", (existing as { id: string }).id);
        if (error) throw error;
      } else {
        const { error } = await client.from("pricing_entries").insert(row);
        if (error) throw error;
      }
      results.push({ catalogItemId: edit.catalogItemId, priceListId: edit.priceListId, status: "ok" as const });
    } catch (error) {
      results.push({
        catalogItemId: edit.catalogItemId,
        priceListId: edit.priceListId,
        status: "error" as const,
        message: error instanceof Error ? error.message : "Uložení ceny selhalo.",
      });
    }
  }
  return summarizeSaveResults(results);
}

export type DuplicatePriceListResult = Readonly<{
  priceList: PriceList;
  copiedCount: number;
  skippedCount: number;
  entriesError?: string;
}>;

/**
 * Section 10/11/12: creates a brand-new price_lists row (new DB-assigned id — never reuses the
 * source's id) plus copies its pricing_entries per planDuplicatedPricingEntries' currency-safe
 * rule. Section 11: STOPs before any write if the new code collides with an existing one —
 * never a silent overwrite. The source price list and its entries are never touched.
 */
export async function duplicatePriceListAdmin(
  client: SupabaseClient,
  sourcePriceListId: string,
  draft: DuplicatePriceListDraft,
): Promise<DuplicatePriceListResult> {
  const { data: sourceRow, error: sourceError } = await client.from("price_lists").select("*").eq("id", sourcePriceListId).maybeSingle();
  if (sourceError) throw sourceError;
  if (!sourceRow) throw new PriceListNotFoundError(sourcePriceListId);

  const { data: existingRows, error: codesError } = await client.from("price_lists").select("code");
  if (codesError) throw codesError;
  const existingCodes = ((existingRows ?? []) as readonly Readonly<{ code: string }>[]).map((row) => row.code);
  const validation = validateNewPriceListCode(existingCodes, draft.code);
  if (!validation.ok) throw new DuplicatePriceListCodeError(draft.code);

  const newPriceListShape: PriceList = {
    id: "pending-db-assignment",
    name: draft.name,
    code: draft.code,
    currency: draft.currency,
    year: draft.year,
    edition: draft.edition,
    eventId: draft.eventId ?? (sourceRow as PriceListRow).event_id ?? undefined,
    realizationCompanyId: draft.realizationCompanyId,
    validFrom: draft.validFrom,
    validTo: draft.validTo,
    active: draft.active,
  };
  const insertRow = priceListToRow(newPriceListShape);
  const { data: insertedRow, error: insertError } = await client.from("price_lists").insert(insertRow).select().single();
  if (insertError) throw insertError;
  const newPriceList = rowToPriceList(insertedRow as PriceListRow);

  const { data: sourceEntryRows, error: entriesError } = await client
    .from("pricing_entries")
    .select("id, catalog_item_id, price_list_id, event_id, realization_company_id, currency, sale_price, purchase_price, valid_from, valid_to, price_mode, created_at")
    .eq("price_list_id", sourcePriceListId);
  if (entriesError) {
    return { priceList: newPriceList, copiedCount: 0, skippedCount: 0, entriesError: "Ceník byl vytvořen, ale načtení zdrojových cen selhalo — zkontrolujte ceník ručně." };
  }
  const sourceEntries = ((sourceEntryRows ?? []) as PricingEntryAdminRow[]).map(rowToPricingEntryAdmin);
  const plan = planDuplicatedPricingEntries(sourceEntries, {
    priceListId: newPriceList.id,
    eventId: newPriceListShape.eventId ?? "",
    currency: newPriceList.currency,
  });
  if (plan.copied.length === 0) {
    return { priceList: newPriceList, copiedCount: 0, skippedCount: plan.skippedCurrencyMismatch.length };
  }
  const insertRows = plan.copied.map((edit) => ({
    catalog_item_id: edit.catalogItemId,
    price_list_id: edit.priceListId,
    event_id: edit.eventId,
    currency: edit.currency,
    sale_price: resolvedSalePriceForEdit(edit) ?? null,
    price_mode: edit.priceMode,
  }));
  const { error: copyError } = await client.from("pricing_entries").insert(insertRows);
  if (copyError) {
    return { priceList: newPriceList, copiedCount: 0, skippedCount: plan.skippedCurrencyMismatch.length, entriesError: "Ceník byl vytvořen, ale zkopírování cenových položek selhalo — zkontrolujte ceník ručně." };
  }
  return { priceList: newPriceList, copiedCount: plan.copied.length, skippedCount: plan.skippedCurrencyMismatch.length };
}
