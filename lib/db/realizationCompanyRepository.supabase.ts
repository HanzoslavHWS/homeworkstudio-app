import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  RealizationCompany,
  RealizationCompanyAdminRepository,
  RealizationCompanyAlias,
  RealizationCompanyAliasKind,
  RealizationCompanyContact,
  RealizationLegacyId,
  RealizationLegacyIdKind,
} from "../../domain/realizationCompany.ts";

/** Card columns arrive with migration 20261019120000_realization_companies_unify.sql; `select("*")` keeps list() working on a database without them. */
type RealizationCompanyRow = Readonly<{
  id: string;
  name: string;
  is_active: boolean;
  note: string | null;
  legal_name?: string | null;
  abra_name?: string | null;
  ico?: string | null;
  dic?: string | null;
  contacts?: unknown;
  source?: string | null;
}>;

type AliasRow = Readonly<{ id: string; realization_company_id: string; alias: string; normalized_alias: string; kind: string; note: string | null; is_active: boolean }>;
type LegacyIdRow = Readonly<{ legacy_id: string; kind: string; realization_company_id: string | null; evidence: string | null; note: string | null }>;

export class RealizationCompaniesNotMigratedError extends Error {
  constructor() {
    super("Databáze ještě nemá evidenci realizačních firem. Aplikujte supabase/migrations/20261019120000_realization_companies_unify.sql.");
    this.name = "RealizationCompaniesNotMigratedError";
  }
}

/** PostgREST/Postgres codes for "column/table/function does not exist (yet)" — same set as lib/db/settlementRepository.supabase.ts, plus PGRST202 (missing RPC). */
export function isMissingSchemaError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "42703" || code === "42P01" || code === "42883" || code === "PGRST202" || code === "PGRST204" || code === "PGRST205";
}

function contactsFromJson(value: unknown): readonly RealizationCompanyContact[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.filter((entry): entry is RealizationCompanyContact => Boolean(entry) && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string");
}

function rowToCompany(row: RealizationCompanyRow): RealizationCompany {
  return {
    id: row.id,
    name: row.name,
    isActive: row.is_active,
    note: row.note ?? undefined,
    legalName: row.legal_name ?? undefined,
    abraName: row.abra_name ?? undefined,
    ico: row.ico ?? undefined,
    dic: row.dic ?? undefined,
    contacts: contactsFromJson(row.contacts),
    source: row.source === "manual" ? "manual" : row.source === "import" ? "import" : undefined,
  };
}

function companyToRow(company: RealizationCompany) {
  return {
    name: company.name,
    legal_name: company.legalName ?? null,
    abra_name: company.abraName ?? null,
    ico: company.ico ?? null,
    dic: company.dic ?? null,
    contacts: company.contacts ?? [],
    note: company.note ?? null,
    is_active: company.isActive,
  };
}

function rowToAlias(row: AliasRow): RealizationCompanyAlias {
  return {
    id: row.id,
    realizationCompanyId: row.realization_company_id,
    alias: row.alias,
    normalizedAlias: row.normalized_alias,
    kind: (row.kind === "historical" ? "historical" : "alternative") satisfies RealizationCompanyAliasKind,
    note: row.note ?? undefined,
    isActive: row.is_active,
  };
}

function rowToLegacyId(row: LegacyIdRow): RealizationLegacyId {
  return {
    legacyId: row.legacy_id,
    kind: row.kind as RealizationLegacyIdKind,
    realizationCompanyId: row.realization_company_id ?? undefined,
    evidence: row.evidence ?? undefined,
    note: row.note ?? undefined,
  };
}

export class SupabaseRealizationCompanyRepository implements RealizationCompanyAdminRepository {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async list(): Promise<readonly RealizationCompany[]> {
    const { data, error } = await this.client.from("print_surface_realization_companies").select("*").order("name", { ascending: true });
    if (error) throw error;
    return ((data ?? []) as RealizationCompanyRow[]).map(rowToCompany);
  }

  async listAliases(): Promise<readonly RealizationCompanyAlias[]> {
    const { data, error } = await this.client.from("realization_company_aliases").select("*").order("alias", { ascending: true });
    if (error) throw isMissingSchemaError(error) ? new RealizationCompaniesNotMigratedError() : error;
    return ((data ?? []) as AliasRow[]).map(rowToAlias);
  }

  async listLegacyIds(): Promise<readonly RealizationLegacyId[]> {
    const { data, error } = await this.client.from("realization_company_legacy_ids").select("*").order("legacy_id", { ascending: true });
    if (error) throw isMissingSchemaError(error) ? new RealizationCompaniesNotMigratedError() : error;
    return ((data ?? []) as LegacyIdRow[]).map(rowToLegacyId);
  }

  async create(company: RealizationCompany): Promise<RealizationCompany> {
    const { data, error } = await this.client
      .from("print_surface_realization_companies")
      .insert({ id: company.id, source: company.source ?? "manual", ...companyToRow(company) })
      .select("*")
      .single();
    if (error) throw isMissingSchemaError(error) ? new RealizationCompaniesNotMigratedError() : error;
    return rowToCompany(data as RealizationCompanyRow);
  }

  async update(company: RealizationCompany): Promise<RealizationCompany> {
    const { data, error } = await this.client
      .from("print_surface_realization_companies")
      .update(companyToRow(company))
      .eq("id", company.id)
      .select("*")
      .single();
    if (error) throw isMissingSchemaError(error) ? new RealizationCompaniesNotMigratedError() : error;
    return rowToCompany(data as RealizationCompanyRow);
  }

  /** Deactivations first, so an edited alias can be re-inserted under the unique active-alias index. */
  async saveAliases(changes: Readonly<{ insert: readonly Omit<RealizationCompanyAlias, "id">[]; deactivateIds: readonly string[] }>): Promise<void> {
    for (const id of changes.deactivateIds) {
      const { error } = await this.client.from("realization_company_aliases").update({ is_active: false }).eq("id", id);
      if (error) throw isMissingSchemaError(error) ? new RealizationCompaniesNotMigratedError() : error;
    }
    if (changes.insert.length === 0) return;
    const { error } = await this.client.from("realization_company_aliases").insert(
      changes.insert.map((alias) => ({
        realization_company_id: alias.realizationCompanyId,
        alias: alias.alias,
        normalized_alias: alias.normalizedAlias,
        kind: alias.kind,
        note: alias.note ?? null,
        is_active: alias.isActive,
      })),
    );
    if (error) throw isMissingSchemaError(error) ? new RealizationCompaniesNotMigratedError() : error;
  }
}
