import type { SupabaseClient } from "@supabase/supabase-js";
import type { ComponentDefinition } from "../../domain/models.ts";
import { computeGeneratorEligible, type CatalogItemSummary, type PricingEntrySummary } from "../../domain/catalogPricing.ts";

type CatalogItemDbRow = Readonly<{
  id: string;
  internal_code: string | null;
  kind: string;
  lifecycle_status: string;
  display_name: string;
  category: string | null;
  unit: string | null;
  document: unknown;
}>;

/** READ-ONLY. catalog_items is small (Batch #2A: 24 rows total) — safe to select in full every call, same pattern as events/price_lists. */
export async function readCatalogItems(client: SupabaseClient): Promise<readonly CatalogItemSummary[]> {
  const { data, error } = await client.from("catalog_items").select("id, internal_code, kind, lifecycle_status, display_name, category, unit, document");
  if (error) throw error;
  return ((data ?? []) as CatalogItemDbRow[]).map((row) => {
    const kind = row.kind as CatalogItemSummary["kind"];
    const lifecycleStatus = row.lifecycle_status as CatalogItemSummary["lifecycleStatus"];
    const document = row.document as ComponentDefinition;
    return {
      id: row.id,
      internalCode: row.internal_code,
      kind,
      lifecycleStatus,
      displayName: row.display_name,
      category: row.category,
      unit: row.unit,
      generatorEligible: computeGeneratorEligible(document, lifecycleStatus, kind),
    } satisfies CatalogItemSummary;
  });
}

type PricingEntryDbRow = Readonly<{
  id: string;
  catalog_item_id: string;
  price_list_id: string;
  event_id: string;
  currency: string;
  sale_price: number | null;
  price_mode: string;
}>;

/** READ-ONLY. Scoped to ONE price list (a single event+currency) — "pricing entries pro zvolený PriceList", never the whole table at once. */
export async function readPricingEntriesForPriceList(client: SupabaseClient, priceListId: string): Promise<readonly PricingEntrySummary[]> {
  const { data, error } = await client.from("pricing_entries").select("id, catalog_item_id, price_list_id, event_id, currency, sale_price, price_mode").eq("price_list_id", priceListId);
  if (error) throw error;
  return ((data ?? []) as PricingEntryDbRow[]).map((row) => ({
    id: row.id,
    catalogItemId: row.catalog_item_id,
    priceListId: row.price_list_id,
    eventId: row.event_id,
    currency: row.currency as PricingEntrySummary["currency"],
    salePrice: row.sale_price,
    priceMode: row.price_mode as PricingEntrySummary["priceMode"],
  }));
}
