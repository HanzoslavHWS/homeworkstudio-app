import type { SupabaseClient } from "@supabase/supabase-js";
import {
  normalizeCustomerCatalogPresetConfig,
  type CustomerCatalogPreset,
  type CustomerCatalogPresetInput,
  type CustomerCatalogPresetRepository,
} from "../../domain/customerCatalog.ts";

type CustomerCatalogPresetRow = Readonly<{ id: string; name: string; config: unknown; created_at: string; updated_at: string }>;

const COLUMNS = "id, name, config, created_at, updated_at";

/** Raised by a write when supabase/migrations/20261005120000_customer_catalog_presets.sql hasn't been applied yet. Reads return an empty list instead, so the Katalog page itself keeps working. */
export class CustomerCatalogPresetsNotMigratedError extends Error {
  constructor() {
    super("Databáze ještě nemá tabulku pro uložené konfigurace katalogu. Aplikujte supabase/migrations/20261005120000_customer_catalog_presets.sql.");
    this.name = "CustomerCatalogPresetsNotMigratedError";
  }
}

export class CustomerCatalogPresetNotFoundError extends Error {
  constructor() {
    super("Konfigurace katalogu nebyla nalezena.");
    this.name = "CustomerCatalogPresetNotFoundError";
  }
}

function isMissingTableError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "42P01" || code === "PGRST205";
}

function rowToPreset(row: CustomerCatalogPresetRow): CustomerCatalogPreset {
  return { id: row.id, name: row.name, config: normalizeCustomerCatalogPresetConfig(row.config), createdAt: row.created_at, updatedAt: row.updated_at };
}

export class SupabaseCustomerCatalogPresetRepository implements CustomerCatalogPresetRepository {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async list(): Promise<readonly CustomerCatalogPreset[]> {
    const { data, error } = await this.client.from("customer_catalog_presets").select(COLUMNS).order("name", { ascending: true });
    if (error) {
      if (isMissingTableError(error)) return [];
      throw error;
    }
    return ((data ?? []) as CustomerCatalogPresetRow[]).map(rowToPreset);
  }

  async save(input: CustomerCatalogPresetInput): Promise<CustomerCatalogPreset> {
    const values = { name: input.name, config: input.config };
    const query = input.id
      ? this.client.from("customer_catalog_presets").update(values).eq("id", input.id).select(COLUMNS)
      : this.client.from("customer_catalog_presets").insert(values).select(COLUMNS);
    const { data, error } = await query;
    if (error) {
      if (isMissingTableError(error)) throw new CustomerCatalogPresetsNotMigratedError();
      throw error;
    }
    const row = ((data ?? []) as CustomerCatalogPresetRow[])[0];
    if (!row) throw new CustomerCatalogPresetNotFoundError();
    return rowToPreset(row);
  }

  async delete(id: string): Promise<void> {
    const { error } = await this.client.from("customer_catalog_presets").delete().eq("id", id);
    if (error) {
      if (isMissingTableError(error)) throw new CustomerCatalogPresetsNotMigratedError();
      throw error;
    }
  }
}
