import type { SupabaseClient } from "@supabase/supabase-js";
import type { RealizationCompany, RealizationCompanyRepository } from "../../domain/realizationCompany.ts";

type RealizationCompanyRow = Readonly<{ id: string; name: string; is_active: boolean; note: string | null }>;

function rowToCompany(row: RealizationCompanyRow): RealizationCompany {
  return { id: row.id, name: row.name, isActive: row.is_active, note: row.note ?? undefined };
}

export class SupabaseRealizationCompanyRepository implements RealizationCompanyRepository {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async list(): Promise<readonly RealizationCompany[]> {
    const { data, error } = await this.client.from("print_surface_realization_companies").select("*").order("name", { ascending: true });
    if (error) throw error;
    return ((data ?? []) as RealizationCompanyRow[]).map(rowToCompany);
  }

  /** Full atomic replace — how a fresh Excel import applies its result. Delete-then-insert (not a single transaction) is an accepted tradeoff for this low-frequency admin operation. */
  async replaceAll(companies: readonly RealizationCompany[]): Promise<void> {
    const { error: deleteError } = await this.client.from("print_surface_realization_companies").delete().not("id", "is", null);
    if (deleteError) throw deleteError;
    if (companies.length === 0) return;
    const { error: insertError } = await this.client.from("print_surface_realization_companies").insert(
      companies.map((company) => ({ id: company.id, name: company.name, is_active: company.isActive, note: company.note ?? null })),
    );
    if (insertError) throw insertError;
  }
}
