import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePriceList, type PriceList } from "../../domain/organizations.ts";
import type { PriceListRepository } from "../../domain/priceListRepository.ts";
import type { Currency } from "../../domain/models.ts";

export type { PriceListRepository } from "../../domain/priceListRepository.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type PriceListRow = Readonly<{
  id: string;
  code: string;
  name: string;
  event_id: string | null;
  currency: Currency;
  year: number;
  edition: string | null;
  realization_company_id: string | null;
  valid_from: string | null;
  valid_to: string | null;
  active: boolean;
  document: unknown;
  created_at: string;
}>;

/**
 * The `id` column (DB primary key, `uuid default gen_random_uuid()`) is always the
 * authoritative identity — document.id is overwritten with it on every read. Batch #1's
 * importer already relies on this same rule (lib/db/importBatch1.supabase.ts): it never sets
 * `id` on insert, only `code`, and lets Postgres assign the real id.
 */
export function rowToPriceList(row: PriceListRow): PriceList {
  return normalizePriceList({ ...(row.document as Partial<PriceList>), id: row.id, eventId: row.event_id ?? undefined });
}

export function priceListToRow(priceList: PriceList): Readonly<{
  code: string;
  name: string;
  event_id: string | null;
  currency: Currency;
  year: number;
  edition: string | null;
  realization_company_id: string | null;
  valid_from: string | null;
  valid_to: string | null;
  active: boolean;
  document: PriceList;
}> {
  return {
    code: priceList.code,
    name: priceList.name,
    event_id: priceList.eventId ?? null,
    currency: priceList.currency,
    year: priceList.year,
    edition: priceList.edition ?? null,
    realization_company_id: priceList.realizationCompanyId ?? null,
    valid_from: priceList.validFrom ?? null,
    valid_to: priceList.validTo ?? null,
    active: priceList.active,
    document: priceList,
  };
}

export class SupabasePriceListRepository implements PriceListRepository {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  /** READ-ONLY. Includes inactive/archived price lists — the admin page decides what to show. */
  async list(): Promise<readonly PriceList[]> {
    const { data, error } = await this.client.from("price_lists").select("*").order("code", { ascending: true });
    if (error) throw error;
    return ((data ?? []) as PriceListRow[]).map(rowToPriceList);
  }

  /**
   * price_lists has no revision column (unlike events/projects — see the init migration), so
   * every write here is a plain upsert-by-identity, never optimistic-concurrency-checked.
   * `id` is only trusted as an existing-row lookup key when it is actually a Postgres uuid; a
   * client-generated id (e.g. "price-list-<timestamp>" from the admin "+ Přidat ceník"
   * button) always inserts a new row and lets Postgres assign the real id.
   */
  async save(priceList: PriceList): Promise<PriceList> {
    const normalized = normalizePriceList(priceList);
    const row = priceListToRow(normalized);
    if (UUID_PATTERN.test(normalized.id)) {
      const { data, error } = await this.client.from("price_lists").update(row).eq("id", normalized.id).select();
      if (error) throw error;
      if (data && data.length > 0) return rowToPriceList(data[0] as PriceListRow);
    }
    const { data, error } = await this.client.from("price_lists").insert(row).select().single();
    if (error) throw error;
    return rowToPriceList(data as PriceListRow);
  }
}
