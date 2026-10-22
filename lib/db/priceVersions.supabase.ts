import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  EurMode,
  EurRoundingMode,
  EventPriceAssignment,
  PriceCategory,
  PriceListInput,
  PriceListKind,
  PriceListVersion,
  PriceSurcharge,
  PriceVersionHeaderInput,
  PriceVersionStatus,
  PurchaseEntryInput,
  PurchaseListCompany,
  PurchasePriceEntry,
  SaleEntryInput,
  SalePriceEntry,
  SalePriceListKind,
  SalePriceMode,
  SurchargeInput,
  VersionedPriceList,
} from "../../domain/priceVersions.ts";
import { isMissingSchemaError } from "./realizationCompanyRepository.supabase.ts";

/**
 * Server-only access to the versioned price lists (migration 20261022120000_price_list_versions.sql).
 * Sale rows (price_list_entries, price_list_surcharges) and purchase rows (purchase_price_entries)
 * are read and written by separate functions; no sale read selects a purchase column.
 */

export class PriceVersionsNotMigratedError extends Error {
  constructor() {
    super("Databáze ještě nemá verzované ceníky. Aplikujte supabase/migrations/20261022120000_price_list_versions.sql.");
    this.name = "PriceVersionsNotMigratedError";
  }
}

/**
 * Optimistic concurrency conflict (SQLSTATE P0409 from price_list_version_lock / assign): somebody
 * changed the version (or the event assignment) since the caller read it. Nothing was written.
 */
export class PriceVersionConflictError extends Error {
  readonly currentRevision?: number;
  constructor(message: string, currentRevision?: number) {
    super(message);
    this.name = "PriceVersionConflictError";
    if (currentRevision !== undefined) this.currentRevision = currentRevision;
  }
}

function check<T>(result: { data: T | null; error: unknown }): T {
  if (result.error) {
    if (isMissingSchemaError(result.error)) throw new PriceVersionsNotMigratedError();
    const error = result.error as { code?: string; message?: string; details?: string };
    if (error.code === "P0409") {
      const match = /current_revision=(\d+)/u.exec(error.details ?? "");
      throw new PriceVersionConflictError(error.message ?? "Data byla mezitím změněna jinde.", match ? Number(match[1]) : undefined);
    }
    throw result.error;
  }
  return result.data as T;
}

const num = (value: unknown): number | undefined => (value === null || value === undefined ? undefined : Number(value));
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

type Row = Record<string, unknown>;

const LIST_COLUMNS = "id, code, name, kind, is_active, note";
const VERSION_COLUMNS = "id, price_list_id, version_no, revision, label, status, valid_from, valid_to, eur_rate, eur_rounding_mode, eur_rounding_step, based_on_version_id, note, created_by, published_at, published_by, archived_at, created_at";
const SALE_ENTRY_COLUMNS = "id, version_id, catalog_item_id, variant_id, price_mode, sale_czk, eur_mode, sale_eur, sale_eur_world, unit_code, note";
const SURCHARGE_COLUMNS = "id, version_id, target_kind, variant_id, kit_item_id, line_key, substitute_item_id, substitute_variant_id, amount_czk, eur_mode, amount_eur, amount_eur_world, note";
const PURCHASE_ENTRY_COLUMNS = "id, version_id, catalog_item_id, variant_id, purchase_czk, unit_code, note";
const ASSIGNMENT_COLUMNS = "id, event_id, list_kind, price_list_version_id, assigned_at, assigned_by, note, replaced_at, replaced_by";

function rowToList(row: Row): VersionedPriceList {
  return { id: row.id as string, code: row.code as string, name: row.name as string, kind: row.kind as PriceListKind, isActive: row.is_active !== false, ...(str(row.note) ? { note: row.note as string } : {}) };
}

function rowToVersion(row: Row): PriceListVersion {
  return {
    id: row.id as string,
    priceListId: row.price_list_id as string,
    versionNo: Number(row.version_no),
    revision: Number(row.revision ?? 1),
    ...(str(row.label) ? { label: row.label as string } : {}),
    status: row.status as PriceVersionStatus,
    ...(str(row.valid_from) ? { validFrom: row.valid_from as string } : {}),
    ...(str(row.valid_to) ? { validTo: row.valid_to as string } : {}),
    eurRate: Number(row.eur_rate),
    eurRoundingMode: row.eur_rounding_mode as EurRoundingMode,
    eurRoundingStep: Number(row.eur_rounding_step),
    ...(str(row.based_on_version_id) ? { basedOnVersionId: row.based_on_version_id as string } : {}),
    ...(str(row.note) ? { note: row.note as string } : {}),
    ...(str(row.created_by) ? { createdBy: row.created_by as string } : {}),
    ...(str(row.published_at) ? { publishedAt: row.published_at as string } : {}),
    ...(str(row.published_by) ? { publishedBy: row.published_by as string } : {}),
    ...(str(row.archived_at) ? { archivedAt: row.archived_at as string } : {}),
    ...(str(row.created_at) ? { createdAt: row.created_at as string } : {}),
  };
}

function rowToSaleEntry(row: Row): SalePriceEntry {
  return {
    id: row.id as string,
    versionId: row.version_id as string,
    catalogItemId: row.catalog_item_id as string,
    ...(str(row.variant_id) ? { variantId: row.variant_id as string } : {}),
    priceMode: row.price_mode as SalePriceMode,
    ...(num(row.sale_czk) !== undefined ? { saleCzk: num(row.sale_czk) } : {}),
    eurMode: row.eur_mode as EurMode,
    ...(num(row.sale_eur) !== undefined ? { saleEur: num(row.sale_eur) } : {}),
    ...(num(row.sale_eur_world) !== undefined ? { saleEurWorld: num(row.sale_eur_world) } : {}),
    ...(str(row.unit_code) ? { unitCode: row.unit_code as string } : {}),
    ...(str(row.note) ? { note: row.note as string } : {}),
  };
}

function rowToSurcharge(row: Row): PriceSurcharge {
  return {
    id: row.id as string,
    versionId: row.version_id as string,
    targetKind: row.target_kind as PriceSurcharge["targetKind"],
    ...(str(row.variant_id) ? { variantId: row.variant_id as string } : {}),
    ...(str(row.kit_item_id) ? { kitItemId: row.kit_item_id as string } : {}),
    ...(str(row.line_key) ? { lineKey: row.line_key as string } : {}),
    ...(str(row.substitute_item_id) ? { substituteItemId: row.substitute_item_id as string } : {}),
    ...(str(row.substitute_variant_id) ? { substituteVariantId: row.substitute_variant_id as string } : {}),
    ...(num(row.amount_czk) !== undefined ? { amountCzk: num(row.amount_czk) } : {}),
    eurMode: row.eur_mode as EurMode,
    ...(num(row.amount_eur) !== undefined ? { amountEur: num(row.amount_eur) } : {}),
    ...(num(row.amount_eur_world) !== undefined ? { amountEurWorld: num(row.amount_eur_world) } : {}),
    ...(str(row.note) ? { note: row.note as string } : {}),
  };
}

function rowToPurchaseEntry(row: Row): PurchasePriceEntry {
  return {
    id: row.id as string,
    versionId: row.version_id as string,
    catalogItemId: row.catalog_item_id as string,
    ...(str(row.variant_id) ? { variantId: row.variant_id as string } : {}),
    purchaseCzk: Number(row.purchase_czk),
    ...(str(row.unit_code) ? { unitCode: row.unit_code as string } : {}),
    ...(str(row.note) ? { note: row.note as string } : {}),
  };
}

function rowToAssignment(row: Row): EventPriceAssignment {
  return {
    id: row.id as string,
    eventId: row.event_id as string,
    listKind: row.list_kind as SalePriceListKind,
    priceListVersionId: row.price_list_version_id as string,
    assignedAt: row.assigned_at as string,
    ...(str(row.assigned_by) ? { assignedBy: row.assigned_by as string } : {}),
    ...(str(row.note) ? { note: row.note as string } : {}),
    ...(str(row.replaced_at) ? { replacedAt: row.replaced_at as string } : {}),
    ...(str(row.replaced_by) ? { replacedBy: row.replaced_by as string } : {}),
  };
}

/** Catalog cards as the price pages need them — no document, no prices. */
export type PricingCatalogItem = Readonly<{
  id: string;
  displayName: string;
  abfCode?: string;
  internalCode?: string;
  itemType: string;
  unitCode?: string;
  priceCategory: PriceCategory;
  lifecycleStatus: string;
}>;

export type PricingEvent = Readonly<{ id: string; name: string; year: number; startDate?: string; endDate?: string; active: boolean }>;
export type PricingCompany = Readonly<{ id: string; name: string; isActive: boolean }>;

export type PriceVersionRepository = Readonly<{
  listPriceLists(kinds: readonly PriceListKind[]): Promise<readonly VersionedPriceList[]>;
  getPriceList(id: string): Promise<VersionedPriceList | undefined>;
  listVersions(priceListIds: readonly string[]): Promise<readonly PriceListVersion[]>;
  getVersion(id: string): Promise<PriceListVersion | undefined>;
  createPriceList(input: PriceListInput): Promise<VersionedPriceList>;
  updatePriceList(id: string, input: PriceListInput): Promise<VersionedPriceList>;
  /** Every write below states the revision it is based on and returns the new one (PriceVersionConflictError on mismatch). */
  createVersion(priceListId: string, basedOn: Readonly<{ versionId: string; revision: number }> | undefined, actor: string): Promise<string>;
  updateVersionHeader(id: string, expectedRevision: number, header: PriceVersionHeaderInput): Promise<number>;
  deleteDraftVersion(id: string, expectedRevision: number): Promise<void>;
  publishVersion(id: string, expectedRevision: number, actor: string): Promise<number>;
  archiveVersion(id: string, expectedRevision: number): Promise<number>;
  listSaleEntries(versionIds: readonly string[]): Promise<readonly SalePriceEntry[]>;
  listSurcharges(versionIds: readonly string[]): Promise<readonly PriceSurcharge[]>;
  replaceSaleRows(versionId: string, expectedRevision: number, entries: readonly SaleEntryInput[], surcharges: readonly SurchargeInput[]): Promise<number>;
  listAssignments(): Promise<readonly EventPriceAssignment[]>;
  assignEventVersion(eventId: string, listKind: SalePriceListKind, versionId: string | null, expectedCurrentVersionId: string | null, actor: string, note?: string): Promise<void>;
  listEvents(): Promise<readonly PricingEvent[]>;
  listPricingItems(): Promise<readonly PricingCatalogItem[]>;
  setPriceCategory(catalogItemId: string, category: PriceCategory): Promise<void>;
  // Purchase — used only by the purchase routes.
  listPurchaseEntries(versionIds: readonly string[]): Promise<readonly PurchasePriceEntry[]>;
  replacePurchaseRows(versionId: string, expectedRevision: number, entries: readonly PurchaseEntryInput[]): Promise<number>;
  listPurchaseCompanies(): Promise<readonly PurchaseListCompany[]>;
  linkPurchaseCompany(priceListId: string, realizationCompanyId: string, isActive: boolean): Promise<void>;
  listCompanies(): Promise<readonly PricingCompany[]>;
}>;

function listRow(input: PriceListInput) {
  return { code: input.code, name: input.name, kind: input.kind, is_active: input.isActive, note: input.note ?? null };
}

export function createSupabasePriceVersionRepository(client: SupabaseClient): PriceVersionRepository {
  return {
    async listPriceLists(kinds) {
      const rows = check(await client.from("versioned_price_lists").select(LIST_COLUMNS).in("kind", [...kinds]).order("code"));
      return (rows as Row[]).map(rowToList);
    },
    async getPriceList(id) {
      const rows = check(await client.from("versioned_price_lists").select(LIST_COLUMNS).eq("id", id).limit(1));
      return (rows as Row[]).map(rowToList)[0];
    },
    async listVersions(priceListIds) {
      if (priceListIds.length === 0) return [];
      const rows = check(await client.from("price_list_versions").select(VERSION_COLUMNS).in("price_list_id", [...priceListIds]).order("version_no", { ascending: false }));
      return (rows as Row[]).map(rowToVersion);
    },
    async getVersion(id) {
      const rows = check(await client.from("price_list_versions").select(VERSION_COLUMNS).eq("id", id).limit(1));
      return (rows as Row[]).map(rowToVersion)[0];
    },
    async createPriceList(input) {
      const row = check(await client.from("versioned_price_lists").insert(listRow(input)).select(LIST_COLUMNS).single());
      return rowToList(row as Row);
    },
    async updatePriceList(id, input) {
      const { kind: _kind, ...patch } = listRow(input);
      const row = check(await client.from("versioned_price_lists").update(patch).eq("id", id).select(LIST_COLUMNS).single());
      return rowToList(row as Row);
    },
    async createVersion(priceListId, basedOn, actor) {
      const id = check(await client.rpc("create_price_list_version", { p_price_list_id: priceListId, p_based_on: basedOn?.versionId ?? null, p_expected_source_revision: basedOn?.revision ?? null, p_actor: actor }));
      return id as string;
    },
    async updateVersionHeader(id, expectedRevision, header) {
      const revision = check(
        await client.rpc("update_price_list_version_header", {
          p_version_id: id,
          p_expected_revision: expectedRevision,
          p_header: {
            label: header.label ?? null,
            valid_from: header.validFrom ?? null,
            valid_to: header.validTo ?? null,
            eur_rate: header.eurRate,
            eur_rounding_mode: header.eurRoundingMode,
            eur_rounding_step: header.eurRoundingStep,
            note: header.note ?? null,
          },
        }),
      );
      return Number(revision);
    },
    async deleteDraftVersion(id, expectedRevision) {
      check(await client.rpc("delete_price_list_version_draft", { p_version_id: id, p_expected_revision: expectedRevision }));
    },
    async publishVersion(id, expectedRevision, actor) {
      return Number(check(await client.rpc("publish_price_list_version", { p_version_id: id, p_expected_revision: expectedRevision, p_actor: actor })));
    },
    async archiveVersion(id, expectedRevision) {
      return Number(check(await client.rpc("archive_price_list_version", { p_version_id: id, p_expected_revision: expectedRevision })));
    },
    async listSaleEntries(versionIds) {
      if (versionIds.length === 0) return [];
      const rows = check(await client.from("price_list_entries").select(SALE_ENTRY_COLUMNS).in("version_id", [...versionIds]));
      return (rows as Row[]).map(rowToSaleEntry);
    },
    async listSurcharges(versionIds) {
      if (versionIds.length === 0) return [];
      const rows = check(await client.from("price_list_surcharges").select(SURCHARGE_COLUMNS).in("version_id", [...versionIds]));
      return (rows as Row[]).map(rowToSurcharge);
    },
    async replaceSaleRows(versionId, expectedRevision, entries, surcharges) {
      const revision = check(
        await client.rpc("replace_sale_price_version_rows", {
          p_version_id: versionId,
          p_expected_revision: expectedRevision,
          p_entries: entries.map((entry) => ({
            catalog_item_id: entry.catalogItemId,
            variant_id: entry.variantId ?? null,
            price_mode: entry.priceMode,
            sale_czk: entry.saleCzk ?? null,
            eur_mode: entry.eurMode,
            sale_eur: entry.saleEur ?? null,
            sale_eur_world: entry.saleEurWorld ?? null,
            unit_code: entry.unitCode ?? null,
            note: entry.note ?? null,
          })),
          p_surcharges: surcharges.map((surcharge) => ({
            target_kind: surcharge.targetKind,
            variant_id: surcharge.variantId ?? null,
            kit_item_id: surcharge.kitItemId ?? null,
            line_key: surcharge.lineKey ?? null,
            substitute_item_id: surcharge.substituteItemId ?? null,
            substitute_variant_id: surcharge.substituteVariantId ?? null,
            amount_czk: surcharge.amountCzk ?? null,
            eur_mode: surcharge.eurMode,
            amount_eur: surcharge.amountEur ?? null,
            amount_eur_world: surcharge.amountEurWorld ?? null,
            note: surcharge.note ?? null,
          })),
        }),
      );
      return Number(revision);
    },
    async listAssignments() {
      const rows = check(await client.from("event_price_assignments").select(ASSIGNMENT_COLUMNS).order("assigned_at", { ascending: false }));
      return (rows as Row[]).map(rowToAssignment);
    },
    async assignEventVersion(eventId, listKind, versionId, expectedCurrentVersionId, actor, note) {
      check(await client.rpc("assign_event_price_version", { p_event_id: eventId, p_list_kind: listKind, p_version_id: versionId, p_expected_current_version_id: expectedCurrentVersionId, p_actor: actor, p_note: note ?? null }));
    },
    async listEvents() {
      const rows = check(await client.from("events").select("id, name, year, start_date, end_date, active").order("year", { ascending: false }).order("name"));
      return (rows as Row[]).map((row) => ({
        id: row.id as string,
        name: row.name as string,
        year: Number(row.year),
        ...(str(row.start_date) ? { startDate: row.start_date as string } : {}),
        ...(str(row.end_date) ? { endDate: row.end_date as string } : {}),
        active: row.active !== false,
      }));
    },
    async listPricingItems() {
      const rows = check(await client.from("catalog_items").select("id, display_name, abf_code, internal_code, item_type, unit_code, price_category, lifecycle_status").order("display_name"));
      return (rows as Row[]).map((row) => ({
        id: row.id as string,
        displayName: row.display_name as string,
        ...(str(row.abf_code) ? { abfCode: row.abf_code as string } : {}),
        ...(str(row.internal_code) ? { internalCode: row.internal_code as string } : {}),
        itemType: row.item_type as string,
        ...(str(row.unit_code) ? { unitCode: row.unit_code as string } : {}),
        priceCategory: row.price_category === "electricity" ? "electricity" : "standard",
        lifecycleStatus: row.lifecycle_status as string,
      }));
    },
    async setPriceCategory(catalogItemId, category) {
      check(await client.from("catalog_items").update({ price_category: category }).eq("id", catalogItemId));
    },
    async listPurchaseEntries(versionIds) {
      if (versionIds.length === 0) return [];
      const rows = check(await client.from("purchase_price_entries").select(PURCHASE_ENTRY_COLUMNS).in("version_id", [...versionIds]));
      return (rows as Row[]).map(rowToPurchaseEntry);
    },
    async replacePurchaseRows(versionId, expectedRevision, entries) {
      const revision = check(
        await client.rpc("replace_purchase_price_version_rows", {
          p_version_id: versionId,
          p_expected_revision: expectedRevision,
          p_entries: entries.map((entry) => ({
            catalog_item_id: entry.catalogItemId,
            variant_id: entry.variantId ?? null,
            purchase_czk: entry.purchaseCzk,
            unit_code: entry.unitCode ?? null,
            note: entry.note ?? null,
          })),
        }),
      );
      return Number(revision);
    },
    async listPurchaseCompanies() {
      const rows = check(await client.from("purchase_price_list_companies").select("id, price_list_id, realization_company_id, is_active, note"));
      return (rows as Row[]).map((row) => ({
        id: row.id as string,
        priceListId: row.price_list_id as string,
        realizationCompanyId: row.realization_company_id as string,
        isActive: row.is_active !== false,
        ...(str(row.note) ? { note: row.note as string } : {}),
      }));
    },
    async linkPurchaseCompany(priceListId, realizationCompanyId, isActive) {
      check(
        await client
          .from("purchase_price_list_companies")
          .upsert({ price_list_id: priceListId, realization_company_id: realizationCompanyId, is_active: isActive }, { onConflict: "price_list_id,realization_company_id" }),
      );
    },
    async listCompanies() {
      const rows = check(await client.from("print_surface_realization_companies").select("id, name, is_active").order("name"));
      return (rows as Row[]).map((row) => ({ id: row.id as string, name: row.name as string, isActive: row.is_active !== false }));
    },
  };
}
