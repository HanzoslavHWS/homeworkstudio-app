import type { CatalogItemAlias } from "../../domain/catalogItemAliases.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CatalogItemName,
  CatalogNameType,
  SettlementAbfItem,
  SettlementCatalogItem,
  SettlementCheck,
  SettlementCheckStatus,
  SettlementDecision,
  SettlementDecisionValue,
  SettlementFileStatus,
  SettlementFileSummary,
  SettlementImportFile,
  SettlementOrigin,
  SettlementRunSummary,
  SettlementStand,
  SettlementVendorItem,
  SettlementVendorMapping,
} from "../../domain/settlementCheck.ts";
import type { SettlementRule, SettlementRuleInput, SettlementRuleStatusPatch } from "../../domain/settlementRules.ts";
import type { SettlementImportPayload, SettlementMappingInput, SettlementRepository, SettlementResultRow, SettlementStandHeader } from "../../domain/settlementService.ts";

/**
 * Raised when the 20261013120000 migration has not been applied yet. The rest of the app is
 * unaffected — only this module needs the new tables.
 */
export class SettlementSchemaNotMigratedError extends Error {
  constructor() {
    super("Databáze ještě nemá tabulky modulu Kontrola vyúčtování. Aplikujte supabase/migrations/20261013120000_settlement_checks.sql.");
    this.name = "SettlementSchemaNotMigratedError";
  }
}

/** PostgREST/Postgres codes for "column/table does not exist (yet)" — same set as lib/db/catalogItemsAdmin.supabase.ts. */
function isMissingSchemaError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "42703" || code === "42P01" || code === "PGRST204" || code === "PGRST205";
}

function raise(error: unknown): never {
  if (isMissingSchemaError(error)) throw new SettlementSchemaNotMigratedError();
  throw error;
}

/** PostgREST returns at most 1000 rows per request; an import easily has several thousand. */
const PAGE_SIZE = 1000;
const INSERT_CHUNK = 500;

type Row = Record<string, unknown>;
// The fluent PostgREST builder type is not worth restating here; every call site casts its rows.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Query = any;

async function selectAll(build: () => Query): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build().range(from, from + PAGE_SIZE - 1);
    if (error) raise(error);
    const page = (data ?? []) as Row[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const str = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

function toCheck(row: Row): SettlementCheck {
  return {
    id: String(row.id),
    eventId: String(row.event_id),
    realizationCompanyId: String(row.realization_company_id),
    realizationCompanyName: String(row.realization_company_name),
    status: row.status as SettlementCheckStatus,
    note: str(row.note),
    createdBy: str(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastComparedAt: str(row.last_compared_at),
    currentRunId: str(row.current_run_id),
    summary: (row.summary as SettlementRunSummary | null) ?? null,
  };
}

function toFile(row: Row): SettlementImportFile {
  const summary = (row.summary ?? {}) as Partial<SettlementFileSummary>;
  return {
    id: String(row.id),
    checkId: String(row.check_id),
    side: row.side as SettlementImportFile["side"],
    format: row.format as SettlementImportFile["format"],
    parser: row.parser as SettlementImportFile["parser"],
    fileName: String(row.file_name),
    fileSize: Number(row.file_size ?? 0),
    fingerprint: String(row.fingerprint),
    status: row.status as SettlementFileStatus,
    summary: { standCount: summary.standCount ?? 0, unassignedCount: summary.unassignedCount ?? 0, itemCount: summary.itemCount ?? 0, templateRowCount: summary.templateRowCount ?? 0, warnings: summary.warnings ?? [] },
    createdBy: str(row.created_by),
    importedAt: String(row.imported_at),
  };
}

function toStand(row: Row): SettlementStand {
  return {
    id: String(row.id),
    checkId: String(row.check_id),
    fileId: String(row.file_id),
    side: row.side as SettlementStand["side"],
    label: String(row.label),
    standNumberRaw: str(row.stand_number_raw),
    standKey: str(row.stand_key),
    manualStandKey: str(row.manual_stand_key),
    unassignedReason: str(row.unassigned_reason),
    title: str(row.title),
    exhibitorName: str(row.exhibitor_name),
    documentNumber: str(row.document_number),
    sourceRow: num(row.source_row),
    sourcePage: num(row.source_page),
    sortOrder: Number(row.sort_order ?? 0),
  };
}

function standRow(stand: SettlementStand): Row {
  return {
    id: stand.id, check_id: stand.checkId, file_id: stand.fileId, side: stand.side, label: stand.label, stand_number_raw: stand.standNumberRaw, stand_key: stand.standKey,
    manual_stand_key: stand.manualStandKey, unassigned_reason: stand.unassignedReason, title: stand.title, exhibitor_name: stand.exhibitorName, document_number: stand.documentNumber,
    source_row: stand.sourceRow, source_page: stand.sourcePage, sort_order: stand.sortOrder,
  };
}

function toAbfItem(row: Row): SettlementAbfItem {
  return {
    id: String(row.id), checkId: String(row.check_id), fileId: String(row.file_id), standId: String(row.stand_id), sourceRow: num(row.source_row), sourcePage: num(row.source_page),
    rawName: String(row.raw_name), normalizedName: String(row.normalized_name), abfCode: str(row.abf_code), quantity: num(row.quantity), quantityRaw: String(row.quantity_raw ?? ""),
    quantityIssue: str(row.quantity_issue), unitRaw: str(row.unit_raw), unit: str(row.unit), note: str(row.note), raw: row.raw ?? null,
  };
}

function abfItemRow(item: SettlementAbfItem): Row {
  return {
    id: item.id, check_id: item.checkId, file_id: item.fileId, stand_id: item.standId, source_row: item.sourceRow, source_page: item.sourcePage, raw_name: item.rawName,
    normalized_name: item.normalizedName, abf_code: item.abfCode, quantity: item.quantity, quantity_raw: item.quantityRaw, quantity_issue: item.quantityIssue, unit_raw: item.unitRaw,
    unit: item.unit, note: item.note, raw: item.raw ?? null,
  };
}

function toVendorItem(row: Row): SettlementVendorItem {
  return {
    id: String(row.id), checkId: String(row.check_id), fileId: String(row.file_id), standId: String(row.stand_id), sourceSheet: String(row.source_sheet), sourceRow: Number(row.source_row),
    rawName: String(row.raw_name), normalizedName: String(row.normalized_name), unitPrice: num(row.unit_price), quantity: num(row.quantity), quantityRaw: String(row.quantity_raw ?? ""),
    quantityIssue: str(row.quantity_issue), lineTotal: num(row.line_total), unit: str(row.unit), unitSource: row.unit_source === "name" ? "name" : "default", note: str(row.note),
    rowKind: row.row_kind as SettlementVendorItem["rowKind"], isBilled: row.is_billed === true, raw: row.raw ?? null,
  };
}

function vendorItemRow(item: SettlementVendorItem): Row {
  return {
    id: item.id, check_id: item.checkId, file_id: item.fileId, stand_id: item.standId, source_sheet: item.sourceSheet, source_row: item.sourceRow, raw_name: item.rawName,
    normalized_name: item.normalizedName, unit_price: item.unitPrice, quantity: item.quantity, quantity_raw: item.quantityRaw, quantity_issue: item.quantityIssue, line_total: item.lineTotal,
    unit: item.unit, unit_source: item.unitSource, note: item.note, row_kind: item.rowKind, is_billed: item.isBilled, raw: item.raw ?? null,
  };
}

function toMapping(row: Row): SettlementVendorMapping {
  return {
    id: String(row.id), realizationCompanyId: String(row.realization_company_id), sourceText: String(row.source_text), normalizedText: String(row.normalized_text),
    catalogItemId: str(row.catalog_item_id), unit: str(row.unit), status: row.status as SettlementVendorMapping["status"], origin: row.origin as SettlementOrigin, note: str(row.note),
    updatedAt: String(row.updated_at),
  };
}

function mappingRow(input: SettlementMappingInput): Row {
  return {
    realization_company_id: input.realizationCompanyId, source_text: input.sourceText, normalized_text: input.normalizedText, catalog_item_id: input.catalogItemId, unit: input.unit,
    status: input.status, origin: input.origin, note: input.note,
  };
}

function toRule(row: Row): SettlementRule {
  return {
    id: String(row.id), realizationCompanyId: String(row.realization_company_id), eventId: str(row.event_id), ruleType: row.rule_type as SettlementRule["ruleType"], name: String(row.name),
    explanation: String(row.explanation), definition: (row.definition ?? {}) as Record<string, unknown>, status: row.status as SettlementRule["status"], origin: row.origin as SettlementOrigin,
    verifiedAt: str(row.verified_at), verifiedBy: str(row.verified_by), createdBy: str(row.created_by), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function toResult(row: Row): SettlementResultRow {
  return {
    standKey: String(row.stand_key), rowKey: String(row.row_key), status: row.status as SettlementResultRow["status"], label: String(row.label), catalogItemId: str(row.catalog_item_id),
    abfCode: str(row.abf_code), abfQuantity: num(row.abf_quantity), abfUnit: str(row.abf_unit), vendorQuantity: num(row.vendor_quantity), vendorUnit: str(row.vendor_unit),
    difference: num(row.difference), abfLineIds: (row.abf_line_ids ?? []) as string[], vendorLineIds: (row.vendor_line_ids ?? []) as string[],
    explanation: { abfMatch: [], vendorMappingConfirmed: false, reasons: [], ruleIds: [], candidateCatalogItemIds: [], ...((row.explanation ?? {}) as object) } as SettlementResultRow["explanation"],
  };
}

function toDecision(row: Row): SettlementDecision {
  return {
    id: String(row.id), checkId: String(row.check_id), standKey: String(row.stand_key), rowKey: String(row.row_key), decision: (row.decision as SettlementDecisionValue | null) ?? null,
    note: str(row.note), createdBy: str(row.created_by), updatedAt: String(row.updated_at),
  };
}

/** Service-role repository for the settlement module. Server-only (RLS has zero policies). */
export class SupabaseSettlementRepository implements SettlementRepository {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async listChecks(): Promise<readonly SettlementCheck[]> {
    return (await selectAll(() => this.client.from("settlement_checks").select("*").order("updated_at", { ascending: false }).order("id"))).map(toCheck);
  }

  async getCheck(id: string): Promise<SettlementCheck | undefined> {
    const { data, error } = await this.client.from("settlement_checks").select("*").eq("id", id).maybeSingle();
    if (error) {
      // A malformed uuid is simply "not found" for the caller.
      if ((error as { code?: string }).code === "22P02") return undefined;
      raise(error);
    }
    return data ? toCheck(data as Row) : undefined;
  }

  async findCheck(eventId: string, realizationCompanyId: string): Promise<SettlementCheck | undefined> {
    const { data, error } = await this.client.from("settlement_checks").select("*").eq("event_id", eventId).eq("realization_company_id", realizationCompanyId).maybeSingle();
    if (error) raise(error);
    return data ? toCheck(data as Row) : undefined;
  }

  async insertCheck(input: Parameters<SettlementRepository["insertCheck"]>[0]): Promise<SettlementCheck> {
    const { data, error } = await this.client
      .from("settlement_checks")
      .insert({ event_id: input.eventId, realization_company_id: input.realizationCompanyId, realization_company_name: input.realizationCompanyName, note: input.note, created_by: input.createdBy })
      .select("*")
      .single();
    if (error) raise(error);
    return toCheck(data as Row);
  }

  async updateCheck(id: string, patch: Readonly<{ status?: SettlementCheckStatus; note?: string | null }>): Promise<SettlementCheck> {
    const update: Row = {};
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.note !== undefined) update.note = patch.note;
    if (Object.keys(update).length === 0) return (await this.getCheck(id))!;
    const { data, error } = await this.client.from("settlement_checks").update(update).eq("id", id).select("*").single();
    if (error) raise(error);
    return toCheck(data as Row);
  }

  async deleteCheck(id: string): Promise<void> {
    const { error } = await this.client.from("settlement_checks").delete().eq("id", id);
    if (error) raise(error);
  }

  async listFiles(checkId: string): Promise<readonly SettlementImportFile[]> {
    return (await selectAll(() => this.client.from("settlement_import_files").select("*").eq("check_id", checkId).order("imported_at").order("id"))).map(toFile);
  }

  /**
   * PostgREST has no multi-statement transaction, so the file row is written first as
   * `importing` (invisible to every read below), then its stands and rows, and only then switched
   * to `imported`. Any failure deletes the file row — ON DELETE CASCADE removes whatever was
   * already written, so a failed import leaves nothing behind.
   */
  async insertImport(payload: SettlementImportPayload): Promise<SettlementImportFile> {
    const { file } = payload;
    const { error: fileError } = await this.client.from("settlement_import_files").insert({
      id: file.id, check_id: file.checkId, side: file.side, format: file.format, parser: file.parser, file_name: file.fileName, file_size: file.fileSize, fingerprint: file.fingerprint,
      status: "importing", summary: file.summary, created_by: file.createdBy,
    });
    if (fileError) raise(fileError);
    try {
      await this.insertChunked("settlement_stands", payload.stands.map(standRow));
      await this.insertChunked("settlement_abf_items", payload.abfItems.map(abfItemRow));
      await this.insertChunked("settlement_vendor_items", payload.vendorItems.map(vendorItemRow));
      const { data, error } = await this.client.from("settlement_import_files").update({ status: "imported" }).eq("id", file.id).select("*").single();
      if (error) throw error;
      return toFile(data as Row);
    } catch (error) {
      await this.client.from("settlement_import_files").delete().eq("id", file.id);
      raise(error);
    }
  }

  private async insertChunked(table: string, rows: readonly Row[]): Promise<void> {
    for (let from = 0; from < rows.length; from += INSERT_CHUNK) {
      const { error } = await this.client.from(table).insert(rows.slice(from, from + INSERT_CHUNK));
      if (error) throw error;
    }
  }

  async setFileStatus(fileId: string, status: SettlementFileStatus): Promise<void> {
    const { error } = await this.client.from("settlement_import_files").update({ status }).eq("id", fileId);
    if (error) raise(error);
  }

  async deleteFile(fileId: string): Promise<void> {
    const { error } = await this.client.from("settlement_import_files").delete().eq("id", fileId);
    if (error) raise(error);
  }

  private async importedFileIds(checkId: string): Promise<readonly string[]> {
    return (await this.listFiles(checkId)).filter((file) => file.status === "imported").map((file) => file.id);
  }

  async listStands(checkId: string): Promise<readonly SettlementStand[]> {
    const fileIds = await this.importedFileIds(checkId);
    if (fileIds.length === 0) return [];
    return (await selectAll(() => this.client.from("settlement_stands").select("*").eq("check_id", checkId).in("file_id", fileIds).order("sort_order").order("id"))).map(toStand);
  }

  async setStandManualKey(standId: string, manualStandKey: string | null): Promise<SettlementStand | undefined> {
    const { data, error } = await this.client.from("settlement_stands").update({ manual_stand_key: manualStandKey }).eq("id", standId).select("*").maybeSingle();
    if (error) raise(error);
    return data ? toStand(data as Row) : undefined;
  }

  async listAbfItems(checkId: string): Promise<readonly SettlementAbfItem[]> {
    const fileIds = await this.importedFileIds(checkId);
    if (fileIds.length === 0) return [];
    return (await selectAll(() => this.client.from("settlement_abf_items").select("*").eq("check_id", checkId).in("file_id", fileIds).order("source_page", { nullsFirst: true }).order("source_row").order("id"))).map(toAbfItem);
  }

  async listVendorItems(checkId: string, filter: Readonly<{ comparableOnly: boolean; standId?: string }>): Promise<readonly SettlementVendorItem[]> {
    const fileIds = await this.importedFileIds(checkId);
    if (fileIds.length === 0) return [];
    return (await selectAll(() => {
      let query = this.client.from("settlement_vendor_items").select("*").eq("check_id", checkId).in("file_id", fileIds);
      if (filter.standId) query = query.eq("stand_id", filter.standId);
      // Same rule as isComparableVendorRow (domain/settlementCreativExpoImport.ts).
      if (filter.comparableOnly) query = query.neq("row_kind", "total").or("is_billed.eq.true,quantity_issue.not.is.null");
      return query.order("source_sheet").order("source_row").order("id");
    })).map(toVendorItem);
  }

  /** Read-only view of catalog_items — this module never writes to it. */
  async listCatalogItems(): Promise<readonly SettlementCatalogItem[]> {
    const columns = "id, internal_code, display_name, official_name, unit, lifecycle_status";
    let rows: Row[];
    try {
      rows = await selectAll(() => this.client.from("catalog_items").select(`${columns}, abf_code`).order("id"));
    } catch (error) {
      // DB without the 20261001120000 catalog migration: no abf_code column yet.
      if (!isMissingSchemaError(error) && !(error instanceof SettlementSchemaNotMigratedError)) throw error;
      const { data, error: legacyError } = await this.client.from("catalog_items").select(columns).order("id");
      if (legacyError) throw legacyError;
      rows = (data ?? []) as Row[];
    }
    return rows.map((row) => ({
      id: String(row.id), abfCode: str(row.abf_code), internalCode: str(row.internal_code), displayName: String(row.display_name), officialName: str(row.official_name), unit: str(row.unit),
      lifecycleStatus: String(row.lifecycle_status),
    }));
  }

  async listCatalogNames(): Promise<readonly CatalogItemName[]> {
    return (await selectAll(() => this.client.from("catalog_item_names").select("*").order("name").order("id"))).map((row) => ({
      id: String(row.id), catalogItemId: String(row.catalog_item_id), nameType: row.name_type as CatalogNameType, name: String(row.name), normalizedName: String(row.normalized_name),
      createdAt: String(row.created_at),
    }));
  }

  async insertCatalogName(input: Readonly<{ catalogItemId: string; nameType: CatalogNameType; name: string; normalizedName: string }>): Promise<CatalogItemName> {
    const { data, error } = await this.client
      .from("catalog_item_names")
      .insert({ catalog_item_id: input.catalogItemId, name_type: input.nameType, name: input.name, normalized_name: input.normalizedName })
      .select("*")
      .single();
    if (error) raise(error);
    const row = data as Row;
    return { id: String(row.id), catalogItemId: String(row.catalog_item_id), nameType: row.name_type as CatalogNameType, name: String(row.name), normalizedName: String(row.normalized_name), createdAt: String(row.created_at) };
  }

  async deleteCatalogName(id: string): Promise<void> {
    const { error } = await this.client.from("catalog_item_names").delete().eq("id", id);
    if (error) raise(error);
  }

  /** Active confirmed catalog aliases (V1-DATA-03). Empty on a database without that migration. */
  async listCatalogItemAliases(): Promise<readonly CatalogItemAlias[]> {
    const { data, error } = await this.client
      .from("catalog_item_aliases")
      .select("id, catalog_item_id, realization_company_id, alias_kind, alias_text, normalized_text, unit_code, source, status, note, is_active")
      .eq("is_active", true)
      .eq("status", "confirmed");
    if (error) {
      const code = (error as { code?: string }).code;
      if (code === "42P01" || code === "PGRST205") return [];
      raise(error);
    }
    return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      catalogItemId: String(row.catalog_item_id),
      realizationCompanyId: row.realization_company_id ? String(row.realization_company_id) : undefined,
      aliasKind: row.alias_kind === "code" ? "code" : "name",
      aliasText: String(row.alias_text),
      normalizedText: String(row.normalized_text),
      unitCode: row.unit_code ? String(row.unit_code) : undefined,
      source: String(row.source) as CatalogItemAlias["source"],
      status: "confirmed",
      note: row.note ? String(row.note) : undefined,
      isActive: true,
    }));
  }

  async listMappings(realizationCompanyId: string): Promise<readonly SettlementVendorMapping[]> {
    return (await selectAll(() => this.client.from("settlement_vendor_mappings").select("*").eq("realization_company_id", realizationCompanyId).order("source_text").order("id"))).map(toMapping);
  }

  async upsertMapping(input: SettlementMappingInput): Promise<SettlementVendorMapping> {
    const { data, error } = await this.client.from("settlement_vendor_mappings").upsert(mappingRow(input), { onConflict: "realization_company_id,normalized_text" }).select("*").single();
    if (error) raise(error);
    return toMapping(data as Row);
  }

  /** ignoreDuplicates: an existing entry (whatever its status) is never overwritten by an import. */
  async insertMissingMappings(entries: readonly SettlementMappingInput[]): Promise<void> {
    for (let from = 0; from < entries.length; from += INSERT_CHUNK) {
      const { error } = await this.client
        .from("settlement_vendor_mappings")
        .upsert(entries.slice(from, from + INSERT_CHUNK).map(mappingRow), { onConflict: "realization_company_id,normalized_text", ignoreDuplicates: true });
      if (error) raise(error);
    }
  }

  async listRules(realizationCompanyId: string): Promise<readonly SettlementRule[]> {
    return (await selectAll(() => this.client.from("settlement_vendor_rules").select("*").eq("realization_company_id", realizationCompanyId).order("created_at").order("id"))).map(toRule);
  }

  async getRule(id: string): Promise<SettlementRule | undefined> {
    const { data, error } = await this.client.from("settlement_vendor_rules").select("*").eq("id", id).maybeSingle();
    if (error) {
      if ((error as { code?: string }).code === "22P02") return undefined;
      raise(error);
    }
    return data ? toRule(data as Row) : undefined;
  }

  async insertRule(input: Required<SettlementRuleInput> & Readonly<{ realizationCompanyId: string; origin: SettlementOrigin; createdBy: string | null }>): Promise<SettlementRule> {
    const { data, error } = await this.client
      .from("settlement_vendor_rules")
      .insert({
        realization_company_id: input.realizationCompanyId, event_id: input.eventId, rule_type: input.ruleType, name: input.name, explanation: input.explanation, definition: input.definition,
        status: "draft", origin: input.origin, created_by: input.createdBy,
      })
      .select("*")
      .single();
    if (error) raise(error);
    return toRule(data as Row);
  }

  async updateRule(id: string, patch: Partial<Required<SettlementRuleInput>> & Partial<SettlementRuleStatusPatch>): Promise<SettlementRule> {
    const update: Row = {};
    if (patch.name !== undefined) update.name = patch.name;
    if (patch.explanation !== undefined) update.explanation = patch.explanation;
    if (patch.definition !== undefined) update.definition = patch.definition;
    if (patch.eventId !== undefined) update.event_id = patch.eventId;
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.verifiedAt !== undefined) update.verified_at = patch.verifiedAt;
    if (patch.verifiedBy !== undefined) update.verified_by = patch.verifiedBy;
    const { data, error } = await this.client.from("settlement_vendor_rules").update(update).eq("id", id).select("*").single();
    if (error) raise(error);
    return toRule(data as Row);
  }

  /**
   * New rows first (under a fresh run_id), then the check is pointed at them, then the previous
   * run is deleted. A failure at any step leaves the previous results current and readable.
   */
  async replaceResults(checkId: string, run: Readonly<{ summary: SettlementRunSummary; standIndex: readonly SettlementStandHeader[]; rows: readonly SettlementResultRow[] }>): Promise<SettlementCheck> {
    const runId = globalThis.crypto.randomUUID();
    try {
      await this.insertChunked("settlement_results", run.rows.map((row, index) => ({
        check_id: checkId, run_id: runId, stand_key: row.standKey, row_key: row.rowKey, status: row.status, label: row.label, catalog_item_id: row.catalogItemId, abf_code: row.abfCode,
        abf_quantity: row.abfQuantity, abf_unit: row.abfUnit, vendor_quantity: row.vendorQuantity, vendor_unit: row.vendorUnit, difference: row.difference, abf_line_ids: row.abfLineIds,
        vendor_line_ids: row.vendorLineIds, explanation: row.explanation, sort_order: index,
      })));
      const { data, error } = await this.client
        .from("settlement_checks")
        .update({ current_run_id: runId, summary: run.summary, stand_index: run.standIndex, last_compared_at: new Date().toISOString() })
        .eq("id", checkId)
        .select("*")
        .single();
      if (error) throw error;
      const { error: cleanupError } = await this.client.from("settlement_results").delete().eq("check_id", checkId).neq("run_id", runId);
      if (cleanupError) console.error("settlement_results: starý běh se nepodařilo odstranit (aktuální výsledky jsou v pořádku).", cleanupError);
      return toCheck(data as Row);
    } catch (error) {
      await this.client.from("settlement_results").delete().eq("check_id", checkId).eq("run_id", runId);
      raise(error);
    }
  }

  async listResults(checkId: string): Promise<readonly SettlementResultRow[]> {
    const check = await this.getCheck(checkId);
    if (!check?.currentRunId) return [];
    return (await selectAll(() => this.client.from("settlement_results").select("*").eq("check_id", checkId).eq("run_id", check.currentRunId).order("sort_order").order("id"))).map(toResult);
  }

  async getStandIndex(checkId: string): Promise<readonly SettlementStandHeader[]> {
    const { data, error } = await this.client.from("settlement_checks").select("stand_index").eq("id", checkId).maybeSingle();
    if (error) raise(error);
    return ((data as Row | null)?.stand_index ?? []) as SettlementStandHeader[];
  }

  async listDecisions(checkId: string): Promise<readonly SettlementDecision[]> {
    return (await selectAll(() => this.client.from("settlement_decisions").select("*").eq("check_id", checkId).order("id"))).map(toDecision);
  }

  async upsertDecision(input: Parameters<SettlementRepository["upsertDecision"]>[0]): Promise<SettlementDecision> {
    const { data, error } = await this.client
      .from("settlement_decisions")
      .upsert({ check_id: input.checkId, stand_key: input.standKey, row_key: input.rowKey, decision: input.decision, note: input.note, created_by: input.createdBy }, { onConflict: "check_id,stand_key,row_key" })
      .select("*")
      .single();
    if (error) raise(error);
    return toDecision(data as Row);
  }
}
