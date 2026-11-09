import type { SupabaseClient } from "@supabase/supabase-js";
import { assertCanActivate, assertUniqueInternalCode, DuplicateInternalCodeError, evaluateCatalogReadiness, withColumnInternalCode } from "../../domain/catalogReadiness.ts";
import { documentReferencesCode, internalCodeChangeIssue } from "../../domain/catalogCodeChange.ts";
import { boothComponentUsageChangeIssue } from "../../domain/internalComponentUsage.ts";
import { classificationIssue, derivedPriceCategory, findCategory } from "../../domain/catalogClassification.ts";
import { readCatalogCategoryRegister } from "./catalogCategories.supabase.ts";
import { ConcurrencyConflictError } from "./concurrency.ts";
import {
  applyCatalogItemEdit,
  documentServiceTechnical,
  buildCatalogItemCreateDocument,
  buildCatalogItemDuplicateDocument,
  CatalogItemAdminNotFoundError,
  duplicateDisplayName,
  InvalidCatalogItemAdminEditError,
  itemTypeOf,
  InvalidCatalogItemAdminCreateInputError,
  planBulkLifecycle,
  resolveRestoreStatus,
  resolveTypeAndKindEdit,
  withArchiveBookkeeping,
  withoutArchiveBookkeeping,
  type BulkLifecycleOutcome,
  type BulkLifecycleRequest,
  type CatalogItemAdmin,
  type CatalogItemAdminCreateInput,
  type CatalogItemAdminDocument,
  type CatalogItemAdminEdit,
} from "../../domain/catalogItemsAdmin.ts";
import { assertNoCrossCodeCollision, defaultItemTypeForKind, DuplicateAbfCodeError } from "../../domain/catalogItemTypes.ts";
import {
  InvalidCatalogAliasesError,
  planCatalogItemAliasChanges,
  validateCatalogItemAliases,
  type CatalogItemAlias,
  type CatalogItemAliasInput,
  type CatalogItemAliasKind,
  type CatalogItemAliasSource,
  type CatalogItemAliasStatus,
} from "../../domain/catalogItemAliases.ts";
import {
  assignKitLineKeys,
  buildKitLinesRpcPayload,
  InvalidCatalogPackageError,
  isLegacyCompatibleKit,
  kitTypeChangeIssue,
  KIT_SUBSTITUTE_RULES,
  packageItemToInput,
  slugifyLineKey,
  sortPackageItems,
  validateKitLines,
  type CatalogPackageItem,
  type CatalogPackageItemInput,
  type KitLineSubstitute,
  type KitSubstituteRule,
} from "../../domain/catalogPackages.ts";
import { parseKitPrintAllowances } from "../../domain/catalogKitPrintAllowance.ts";
import {
  InvalidCatalogVariantSetError,
  isVariantAssetShape,
  parseVariantImageSource,
  validateCatalogVariantSet,
  VARIANT_SET_KINDS,
  VARIANT_SURCHARGE_RULES,
  type CatalogVariant,
  type CatalogVariantSet,
  type CatalogVariantSetInput,
  type VariantSetKind,
  type VariantSurchargeRule,
} from "../../domain/catalogVariants.ts";
import type { CatalogItemKind, CatalogItemStatus, CatalogItemType, ComponentDefinition } from "../../domain/models.ts";

const LEGACY_ADMIN_COLUMNS = "id, internal_code, kind, lifecycle_status, display_name, official_name, category, unit, document, created_at, updated_at";
/** 20261001120000 (abf_code, item_type). */
const ADMIN_COLUMNS_V2 = `${LEGACY_ADMIN_COLUMNS}, abf_code, item_type`;
/** 20261021120000 (V1-DATA-03: official_name_en, unit_code). Reads fall back V3 -> V2 -> legacy. */
const ADMIN_COLUMNS = `${ADMIN_COLUMNS_V2}, official_name_en, unit_code`;
/** 20261022120000 (V1-DATA-05: price_category). Reads fall back V4 -> V3 -> V2 -> legacy. */
const ADMIN_COLUMNS_V4 = `${ADMIN_COLUMNS}, price_category`;
const ALIAS_COLUMNS = "id, catalog_item_id, realization_company_id, alias_kind, alias_text, normalized_text, unit_code, source, status, note, is_active";
const LEGACY_PACKAGE_COLUMNS = "id, package_item_id, child_item_id, quantity, included_in_package, sort_order, note";
/** 20261021130000 (V1-DATA-04: kit lines). Reads fall back to the legacy column set. */
const PACKAGE_COLUMNS = `${LEGACY_PACKAGE_COLUMNS}, line_key, line_kind, label, label_en, unit_code, variant_set_id, default_variant_id, print_allowance`;
const SUBSTITUTE_COLUMNS = "id, kit_line_id, substitute_item_id, substitute_variant_id, surcharge_rule, surcharge_unit_code, quantity_factor, is_active, sort_order, note";
const VARIANT_SET_COLUMNS = "id, code, name, kind, is_active, note";
const VARIANT_COLUMNS = "id, variant_set_id, code, name, name_en, swatch_color, price_item_id, surcharge_rule, surcharge_unit_code, legacy_finish_id, is_active, sort_order, note";
/** 20261103120000 (V1-CARPET-02): product line + image metadata. Reads fall back to VARIANT_COLUMNS. */
const VARIANT_COLUMNS_V2 = `${VARIANT_COLUMNS}, series, photo_asset, texture_asset, image_source`;

type CatalogItemAdminDbRow = Readonly<{
  id: string;
  internal_code: string | null;
  abf_code?: string | null;
  item_type?: string | null;
  kind: string;
  lifecycle_status: string;
  display_name: string;
  official_name: string | null;
  official_name_en?: string | null;
  category: string | null;
  unit: string | null;
  unit_code?: string | null;
  price_category?: string | null;
  document: unknown;
  created_at: string;
  updated_at: string;
}>;

type CatalogPackageItemDbRow = Readonly<{
  id: string;
  package_item_id: string;
  child_item_id: string | null;
  quantity: number | string;
  included_in_package: boolean;
  sort_order: number;
  note: string | null;
  line_key?: string | null;
  line_kind?: string | null;
  label?: string | null;
  label_en?: string | null;
  unit_code?: string | null;
  variant_set_id?: string | null;
  default_variant_id?: string | null;
  print_allowance?: unknown;
}>;

type KitLineSubstituteDbRow = Readonly<{
  id: string;
  kit_line_id: string;
  substitute_item_id: string;
  substitute_variant_id: string | null;
  surcharge_rule: string;
  surcharge_unit_code: string | null;
  quantity_factor: number | string;
  is_active: boolean;
  sort_order: number;
  note: string | null;
}>;

type CatalogVariantSetDbRow = Readonly<{ id: string; code: string; name: string; kind: string; is_active: boolean; note: string | null }>;

type CatalogVariantDbRow = Readonly<{
  id: string;
  variant_set_id: string;
  code: string;
  series?: string | null;
  photo_asset?: unknown;
  texture_asset?: unknown;
  image_source?: unknown;
  name: string;
  name_en: string | null;
  swatch_color: string | null;
  price_item_id: string | null;
  surcharge_rule: string;
  surcharge_unit_code: string | null;
  legacy_finish_id: string | null;
  is_active: boolean;
  sort_order: number;
  note: string | null;
}>;

/**
 * Raised when a write needs the 20261001120000 migration (abf_code / item_type /
 * catalog_item_package_items) but the database hasn't had it applied yet. Reads never raise
 * this — they fall back to the legacy column set so the generator keeps working.
 */
export class CatalogSchemaNotMigratedError extends Error {
  constructor() {
    super("Databáze ještě nemá všechny migrace katalogu. Aplikujte supabase/migrations/20261001120000_catalog_item_types_abf_codes_packages.sql, 20261021120000_catalog_identity.sql a 20261021130000_catalog_kits_variants.sql.");
    this.name = "CatalogSchemaNotMigratedError";
  }
}

/** PostgREST/Postgres codes for "column/table does not exist (yet)". */
function isMissingSchemaError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "42703" || code === "42P01" || code === "PGRST204" || code === "PGRST205";
}

/** "function does not exist" — the RPC of a migration not applied yet. */
function isMissingFunctionError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "42883" || code === "PGRST202";
}

function rowToAdmin(row: CatalogItemAdminDbRow, packageItems?: readonly CatalogPackageItem[]): CatalogItemAdmin {
  const kind = row.kind as CatalogItemKind;
  const item: CatalogItemAdmin = {
    id: row.id,
    internalCode: row.internal_code,
    abfCode: row.abf_code ?? null,
    itemType: (row.item_type as CatalogItemType | null | undefined) ?? defaultItemTypeForKind(kind),
    kind,
    lifecycleStatus: row.lifecycle_status as CatalogItemStatus,
    displayName: row.display_name,
    officialName: row.official_name,
    officialNameEn: row.official_name_en ?? null,
    category: row.category,
    unit: row.unit,
    unitCode: row.unit_code ?? null,
    ...(row.price_category === "electricity" || row.price_category === "standard" ? { priceCategory: row.price_category } : {}),
    document: (row.document ?? {}) as CatalogItemAdminDocument,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return packageItems ? { ...item, packageItems } : item;
}

function rowToPackageItem(row: CatalogPackageItemDbRow, substitutes: readonly KitLineSubstitute[] = []): CatalogPackageItem {
  const printAllowance = parseKitPrintAllowances(row.print_allowance);
  return {
    id: row.id,
    packageItemId: row.package_item_id,
    // A row read before the V1-DATA-04 migration has no key yet: derive a stable one from its id.
    lineKey: row.line_key ?? `polozka-${slugifyLineKey(row.id).slice(0, 8)}`,
    lineKind: row.line_kind === "text" ? "text" : "item",
    childItemId: row.child_item_id,
    ...(row.label ? { label: row.label } : {}),
    ...(row.label_en ? { labelEn: row.label_en } : {}),
    quantity: Number(row.quantity),
    ...(row.unit_code ? { unitCode: row.unit_code } : {}),
    includedInPackage: row.included_in_package,
    sortOrder: row.sort_order ?? 0,
    note: row.note,
    ...(row.variant_set_id ? { variantSetId: row.variant_set_id } : {}),
    ...(row.default_variant_id ? { defaultVariantId: row.default_variant_id } : {}),
    ...(printAllowance.length ? { printAllowance } : {}),
    ...(substitutes.length ? { substitutes } : {}),
  };
}

function rowToSubstitute(row: KitLineSubstituteDbRow): KitLineSubstitute {
  return {
    id: row.id,
    substituteItemId: row.substitute_item_id,
    ...(row.substitute_variant_id ? { substituteVariantId: row.substitute_variant_id } : {}),
    surchargeRule: ((KIT_SUBSTITUTE_RULES as readonly string[]).includes(row.surcharge_rule) ? row.surcharge_rule : "price_difference") as KitSubstituteRule,
    ...(row.surcharge_unit_code ? { surchargeUnitCode: row.surcharge_unit_code } : {}),
    quantityFactor: Number(row.quantity_factor),
    isActive: row.is_active,
    ...(row.note ? { note: row.note } : {}),
  };
}

async function selectCatalogRows(client: SupabaseClient, id?: string): Promise<CatalogItemAdminDbRow[]> {
  const run = async (columns: string) => {
    const base = client.from("catalog_items").select(columns);
    return id ? base.eq("id", id) : base;
  };
  let { data, error } = await run(ADMIN_COLUMNS_V4);
  if (error && isMissingSchemaError(error)) ({ data, error } = await run(ADMIN_COLUMNS));
  if (error && isMissingSchemaError(error)) ({ data, error } = await run(ADMIN_COLUMNS_V2));
  if (error && isMissingSchemaError(error)) ({ data, error } = await run(LEGACY_ADMIN_COLUMNS));
  if (error) throw error;
  return (data ?? []) as unknown as CatalogItemAdminDbRow[];
}

/** Every package link in the catalog (small table). Empty when the migration hasn't been applied yet. */
export async function readCatalogPackageItems(client: SupabaseClient): Promise<readonly CatalogPackageItem[]> {
  let { data, error } = await client.from("catalog_item_package_items").select(PACKAGE_COLUMNS);
  if (error && isMissingSchemaError(error)) ({ data, error } = await client.from("catalog_item_package_items").select(LEGACY_PACKAGE_COLUMNS));
  if (error) {
    if (isMissingSchemaError(error)) return [];
    throw error;
  }
  const substitutesByLine = new Map<string, KitLineSubstitute[]>();
  for (const row of await readKitLineSubstituteRows(client)) {
    substitutesByLine.set(row.kit_line_id, [...(substitutesByLine.get(row.kit_line_id) ?? []), rowToSubstitute(row)]);
  }
  return sortPackageItems(((data ?? []) as CatalogPackageItemDbRow[]).map((row) => rowToPackageItem(row, substitutesByLine.get(row.id) ?? [])));
}

/** Empty on a database without the V1-DATA-04 migration. Ordered by sort_order. */
async function readKitLineSubstituteRows(client: SupabaseClient): Promise<readonly KitLineSubstituteDbRow[]> {
  const { data, error } = await client.from("catalog_kit_line_substitutes").select(SUBSTITUTE_COLUMNS);
  if (error) {
    if (isMissingSchemaError(error)) return [];
    throw error;
  }
  return ((data ?? []) as KitLineSubstituteDbRow[]).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id.localeCompare(b.id));
}

function attachPackages(rows: readonly CatalogItemAdminDbRow[], links: readonly CatalogPackageItem[]): readonly CatalogItemAdmin[] {
  const byPackage = new Map<string, CatalogPackageItem[]>();
  for (const link of links) byPackage.set(link.packageItemId, [...(byPackage.get(link.packageItemId) ?? []), link]);
  return rows.map((row) => rowToAdmin(row, byPackage.get(row.id) ?? []));
}

/**
 * Full admin read — catalog_items is small (85 rows as of 2026-10), same "select in full
 * every call" pattern already used by readCatalogItems/readExistingCatalogItemsFull. Unlike
 * the customer-safe CatalogItemSummary (lib/db/catalogPricing.supabase.ts), this includes the
 * FULL document (source traceability, pricingEntries, parts, printSurfaces, ...) and the BOOTH
 * package contents — it is only ever served to the authenticated admin session.
 */
export async function readCatalogItemsAdmin(client: SupabaseClient): Promise<readonly CatalogItemAdmin[]> {
  const [rows, links] = await Promise.all([selectCatalogRows(client), readCatalogPackageItems(client)]);
  return attachPackages(rows, links);
}

export async function readCatalogItemAdminById(client: SupabaseClient, id: string): Promise<CatalogItemAdmin | undefined> {
  const [row] = await selectCatalogRows(client, id);
  if (!row) return undefined;
  const links = await readCatalogPackageItems(client);
  return attachPackages([row], links)[0];
}

async function assertAbfCodeFree(client: SupabaseClient, abfCode: string, exceptId?: string): Promise<void> {
  const { data, error } = await client.from("catalog_items").select("id").eq("abf_code", abfCode);
  if (error) {
    if (isMissingSchemaError(error)) throw new CatalogSchemaNotMigratedError();
    throw error;
  }
  if (((data ?? []) as { id: string }[]).some((row) => row.id !== exceptId)) throw new DuplicateAbfCodeError(abfCode);
}

function mapInsertError(error: unknown, input: Pick<CatalogItemAdminCreateInput, "internalCode" | "abfCode">): never {
  if (isMissingSchemaError(error)) throw new CatalogSchemaNotMigratedError();
  if ((error as { code?: string }).code === "23505") {
    const message = String((error as { message?: string }).message ?? "");
    if (message.includes("abf_code") && input.abfCode) throw new DuplicateAbfCodeError(input.abfCode);
    throw new DuplicateInternalCodeError(input.internalCode ?? "");
  }
  throw error;
}

/**
 * Creates a brand-new catalog_items row (the "Nová komponenta stánku" workflow). Always inserts
 * lifecycle_status="needs_review" (input has no such field at all — create can never activate by
 * construction, not just by convention). `id` is never set — Postgres's gen_random_uuid() column
 * default handles it.
 */
export async function createCatalogItemAdmin(client: SupabaseClient, input: CatalogItemAdminCreateInput): Promise<CatalogItemAdmin> {
  const existing = await readCatalogItemsAdmin(client);
  // assertUniqueInternalCode expects Pick<ComponentDefinition,"internalCode"> (string | undefined);
  // CatalogItemAdmin.internalCode is string | null, so null must be mapped to undefined first.
  assertUniqueInternalCode(
    existing.map((item) => ({ internalCode: item.internalCode ?? undefined })),
    input.internalCode,
  );
  if (input.abfCode) await assertAbfCodeFree(client, input.abfCode);
  assertNoCrossCodeCollision(existing, { internalCode: input.internalCode, abfCode: input.abfCode });
  if (input.variantOptions) {
    const { data: setRows, error: setError } = await client.from("catalog_variant_sets").select("id").eq("id", input.variantOptions.variantSetId);
    if (setError) throw setError;
    if (!((setRows ?? []) as { id: string }[]).length) throw new InvalidCatalogItemAdminCreateInputError("variantOptions", "Zvolený vzorník barev neexistuje.");
  }

  // Druh komponenty → Kategorie: a new card must have a valid, active combination.
  const itemType = input.itemType ?? defaultItemTypeForKind(input.kind);
  const { categories } = await readCatalogCategoryRegister(client);
  const classification = classificationIssue(categories, { itemType, kind: input.kind, category: input.category }, { requireActive: true });
  if (classification) throw new InvalidCatalogItemAdminCreateInputError("category", classification);
  const category = findCategory(categories, input.category);

  let document = buildCatalogItemCreateDocument(input);
  if (category?.serviceCategory) document = { ...document, serviceTechnical: { ...(documentServiceTechnical(document) ?? {}), serviceCategory: category.serviceCategory } };
  const row: Record<string, unknown> = {
    internal_code: input.internalCode?.trim() || null,
    kind: input.kind,
    lifecycle_status: "needs_review",
    display_name: input.displayName,
    official_name: input.officialName ?? null,
    category: input.category,
    unit: input.unit ?? null,
    document,
    item_type: itemType,
  };
  if (category && derivedPriceCategory(category) === "electricity") row.price_category = "electricity";
  if (input.abfCode) row.abf_code = input.abfCode;
  if (input.officialNameEn) row.official_name_en = input.officialNameEn;
  if (input.unitCode) row.unit_code = input.unitCode;
  let { data, error } = await client.from("catalog_items").insert(row).select(ADMIN_COLUMNS).single();

  // DB without the V1-DATA-03 migration: a card that uses none of its columns can still be created.
  if (error && isMissingSchemaError(error)) {
    if (input.officialNameEn || input.unitCode) throw new CatalogSchemaNotMigratedError();
    ({ data, error } = await client.from("catalog_items").insert(row).select(ADMIN_COLUMNS_V2).single());
  }

  // Pre-migration DB: item_type doesn't exist yet. A card without an ABF code can still be
  // created there (item_type is re-derived from kind on read); one WITH an ABF code cannot.
  if (error && isMissingSchemaError(error) && !input.abfCode) {
    const { item_type: _itemType, ...legacyRow } = row;
    ({ data, error } = await client.from("catalog_items").insert(legacyRow).select(LEGACY_ADMIN_COLUMNS).single());
  }

  // Backstop for the read->insert race against the DB's own partial unique indexes
  // (catalog_items_internal_code_key / catalog_items_abf_code_key).
  if (error) mapInsertError(error, input);
  return rowToAdmin(data as CatalogItemAdminDbRow, []);
}

/**
 * "Duplikovat" — a NEW needs_review card copying the source's catalog content (never its
 * internal/ABF code, review stamp, import provenance or base prices — see
 * buildCatalogItemDuplicateDocument). A BOOTH's package contents are copied as well, so a new
 * E/K variant can start from an existing package.
 */
export async function duplicateCatalogItemAdmin(client: SupabaseClient, sourceId: string): Promise<CatalogItemAdmin> {
  const source = await readCatalogItemAdminById(client, sourceId);
  if (!source) throw new CatalogItemAdminNotFoundError(sourceId);
  const displayName = duplicateDisplayName(source.displayName);
  const document = buildCatalogItemDuplicateDocument(source, displayName);
  const { data, error } = await client
    .from("catalog_items")
    .insert({
      internal_code: null,
      kind: source.kind,
      item_type: itemTypeOf(source),
      lifecycle_status: "needs_review",
      display_name: displayName,
      official_name: null,
      category: source.category,
      unit: source.unit,
      document,
    })
    .select(ADMIN_COLUMNS)
    .single();
  if (error) mapInsertError(error, {});
  const created = rowToAdmin(data as CatalogItemAdminDbRow, []);
  const sourceLines = source.packageItems ?? [];
  if (sourceLines.length === 0) return created;
  const { packageItems } = await saveCatalogPackageItems(client, created.id, sourceLines.map((line) => packageItemToInput(line)));
  return { ...created, packageItems };
}

/**
 * Optimistic concurrency WITHOUT a schema change: catalog_items has no revision column, but
 * `updated_at` is auto-touched by the catalog_items_set_updated_at trigger on every UPDATE
 * (init migration) — used here as an opaque compare-and-swap token, passed straight through
 * from a prior read into `.eq("updated_at", expectedUpdatedAt)` and never parsed/reformatted
 * (round-tripping through Date() risks losing precision and false-conflicting). A null
 * expectedUpdatedAt means the caller doesn't hold a known prior read and skips the check —
 * the admin UI always sends a real value it just fetched, so this only matters for callers
 * that intentionally opt out.
 */
export async function saveCatalogItemAdmin(
  client: SupabaseClient,
  id: string,
  edit: CatalogItemAdminEdit,
  expectedUpdatedAt: string | null,
): Promise<CatalogItemAdmin> {
  const current = await readCatalogItemAdminById(client, id);
  if (!current) throw new CatalogItemAdminNotFoundError(id);
  if (expectedUpdatedAt !== null && current.updatedAt !== expectedUpdatedAt) {
    throw new ConcurrencyConflictError("catalog_item", id);
  }

  // Type/kind (resolved + validated first — throws before anything is written), then the
  // column-level identity edits.
  const typeAndKind = edit.itemType !== undefined || edit.kind !== undefined ? resolveTypeAndKindEdit(current, edit) : undefined;
  const kindForEdit = typeAndKind?.kind ?? current.kind;
  let nextDocument = applyCatalogItemEdit(current.document, typeAndKind && typeAndKind.kind !== current.kind ? { ...edit, kind: typeAndKind.kind } : edit);

  if (typeAndKind && typeAndKind.itemType !== itemTypeOf(current)) {
    const issue = kitTypeChangeIssue(id, typeAndKind.itemType, await readCatalogPackageItems(client));
    if (issue) throw new InvalidCatalogItemAdminEditError("itemType", issue);
  }
  // Použití komponenty (booth_component -> construction/other): the card leaves the generator's
  // component picker, so a project that already placed it would point at a component the
  // generator no longer offers. Refused while any project references the card (by id or code).
  if (typeAndKind && current.kind === "booth_component" && typeAndKind.kind !== "booth_component") {
    const { data: projectRows, error: projectError } = await client.from("projects").select("id, document");
    if (projectError) throw projectError;
    const referencingProjects = ((projectRows ?? []) as { id: string; document: { name?: string } | null }[])
      .filter((row) => documentReferencesCode(row.document, id) || (current.internalCode ? documentReferencesCode(row.document, current.internalCode) : false))
      .map((row) => row.document?.name || row.id);
    const issue = boothComponentUsageChangeIssue(referencingProjects);
    if (issue) throw new InvalidCatalogItemAdminEditError("kind", issue);
  }
  const resultingItemType = typeAndKind?.itemType ?? itemTypeOf(current);

  const columnPatch: Record<string, unknown> = {};
  if (typeAndKind) {
    if (typeAndKind.itemType !== itemTypeOf(current)) columnPatch.item_type = typeAndKind.itemType;
    if (typeAndKind.kind !== current.kind) columnPatch.kind = typeAndKind.kind;
  } else if (edit.confirmItemType === true && current.itemType === undefined) {
    columnPatch.item_type = itemTypeOf(current);
  }
  if (edit.abfCode !== undefined && edit.abfCode !== (current.abfCode ?? null)) {
    if (edit.abfCode) await assertAbfCodeFree(client, edit.abfCode, id);
    columnPatch.abf_code = edit.abfCode;
  }
  const changedInternalCode = edit.changeInternalCode && edit.changeInternalCode.to !== current.internalCode ? edit.changeInternalCode : undefined;
  if (changedInternalCode) {
    const { data: projectRows, error: projectError } = await client.from("projects").select("id, document");
    if (projectError) throw projectError;
    const referencingProjects = ((projectRows ?? []) as { id: string; document: { name?: string } | null }[])
      .filter((row) => documentReferencesCode(row.document, changedInternalCode.from))
      .map((row) => row.document?.name || row.id);
    const issue = internalCodeChangeIssue({ currentCode: current.internalCode, from: changedInternalCode.from, to: changedInternalCode.to, referencingProjects });
    if (issue) throw new InvalidCatalogItemAdminEditError("changeInternalCode", issue);
    const { data: codeRows, error: codeError } = await client.from("catalog_items").select("id, internal_code");
    if (codeError) throw codeError;
    assertUniqueInternalCode(
      ((codeRows ?? []) as { id: string; internal_code: string | null }[]).filter((row) => row.id !== id).map((row) => ({ internalCode: row.internal_code ?? undefined })),
      changedInternalCode.to,
    );
    columnPatch.internal_code = changedInternalCode.to;
  }
  if (typeof columnPatch.abf_code === "string" || edit.fillInternalCode !== undefined || changedInternalCode) {
    const others = (await selectCatalogRows(client)).map((row) => ({ id: row.id, internalCode: row.internal_code, abfCode: row.abf_code ?? null, displayName: row.display_name }));
    assertNoCrossCodeCollision(others, { internalCode: changedInternalCode?.to ?? edit.fillInternalCode ?? current.internalCode, abfCode: (columnPatch.abf_code as string | undefined) ?? current.abfCode }, id);
  }
  if (edit.officialName !== undefined && edit.officialName !== current.officialName) columnPatch.official_name = edit.officialName;
  if (edit.officialNameEn !== undefined && edit.officialNameEn !== (current.officialNameEn ?? null)) columnPatch.official_name_en = edit.officialNameEn;
  if (edit.unitCode !== undefined && edit.unitCode !== (current.unitCode ?? null)) {
    columnPatch.unit_code = edit.unitCode;
    if (edit.unitCode === null) columnPatch.unit = null;
  }
  if (edit.fillInternalCode !== undefined && edit.fillInternalCode !== current.internalCode) {
    if (current.internalCode) {
      throw new InvalidCatalogItemAdminEditError("fillInternalCode", "Existující interní kód nelze měnit — je to stabilní identita položky. Lze jen doplnit chybějící kód.");
    }
    const { data: codeRows, error: codeError } = await client.from("catalog_items").select("id, internal_code");
    if (codeError) throw codeError;
    assertUniqueInternalCode(
      ((codeRows ?? []) as { id: string; internal_code: string | null }[]).filter((row) => row.id !== id).map((row) => ({ internalCode: row.internal_code ?? undefined })),
      edit.fillInternalCode,
    );
    columnPatch.internal_code = edit.fillInternalCode;
  }
  // The generator code readiness must see: the column (just filled, or already stored) — never only the JSON document.
  const resultingInternalCode = (columnPatch.internal_code as string | undefined) ?? current.internalCode;

  // Archive / restore bookkeeping. Archiving remembers the status it came from; "Obnovit"
  // (restoreFromArchive) returns to it via resolveRestoreStatus — a previously-active item only
  // comes back active if it still passes readiness. Never touches anything else in the document.
  if (edit.restoreFromArchive === true && current.lifecycleStatus === "archived") {
    nextDocument = { ...withoutArchiveBookkeeping(nextDocument), lifecycleStatus: resolveRestoreStatus({ ...current, kind: kindForEdit, itemType: resultingItemType }) };
  } else {
    const requestedStatus = nextDocument.lifecycleStatus as CatalogItemStatus | undefined;
    if (edit.lifecycleStatus === "archived" && current.lifecycleStatus !== "archived") {
      nextDocument = withArchiveBookkeeping(nextDocument, current.lifecycleStatus, new Date().toISOString());
    } else if (current.lifecycleStatus === "archived" && edit.lifecycleStatus !== undefined && requestedStatus !== "archived") {
      nextDocument = withoutArchiveBookkeeping(nextDocument);
    }
  }

  // Section 9 (asset workflow spec): reviewedAt is ONLY ever set by this explicit flag —
  // never as a side effect of an asset upload (edit.photoAsset/modelAsset are handled purely
  // by applyCatalogItemEdit above and never touch reviewedAt). The server stamps the actual
  // timestamp; a client-supplied date is never trusted.
  if (edit.markReviewed === true) {
    nextDocument = { ...nextDocument, reviewedAt: new Date().toISOString() };
  }

  // Section 11 (component admin spec): needs_review/draft/inactive/archived -> active must
  // satisfy the SAME evaluateCatalogReadiness() rules the UI displays — never a parallel/
  // looser server check, and never bypassable by calling this API directly. Re-saving an item
  // that is ALREADY active (e.g. fixing a typo on M57's displayName) never re-triggers this
  // guard — only a genuine transition into "active" does, so routine edits to M57/L02/P86 are
  // unaffected.
  if (edit.lifecycleStatus === "active" && current.lifecycleStatus !== "active") {
    assertCanActivate({ ...withColumnInternalCode(nextDocument as Partial<ComponentDefinition>, resultingInternalCode), lifecycleStatus: "active" } as ComponentDefinition, kindForEdit, { itemType: resultingItemType });
  }

  // Section 8/9 (asset + capability workflow spec): removing a photo/model reference, OR
  // changing showIn2D/showIn3D, on an ALREADY active item must never leave it
  // active+readiness=false — capability edits can just as easily BREAK readiness as asset
  // removal can (e.g. flipping showIn3D on with no model yet introduces a fresh
  // missing_3d_asset that wasn't previously checked). Scoped narrowly to these specific edit
  // kinds — an unrelated edit to an already-active but legacy-imperfect item (like M57,
  // missing reviewedAt) must never retroactively downgrade it, matching the activation-guard
  // scoping immediately above. Auto-downgrade rather than blocking: the edit itself always
  // succeeds, the item just safely falls back to needs_review instead of silently violating
  // the active+ready invariant.
  //
  // removeSourceAssetId is included here too: removing the ONLY sketchup-kind entry from an
  // active booth/booth_component would otherwise leave it active with missing_sketchup_source
  // — same reasoning as photoAsset/modelAsset removal, checked unconditionally (cheap, and
  // correctness must not depend on guessing which removed entry was the sketchup one).
  //
  // setVariantModelAsset/setVariantPhotoAsset (any variantId, set OR clear) are included
  // unconditionally too: for a multi-variant booth line (T04..T25), evaluateCatalogReadiness's
  // booth rule requires EVERY declared variant to have its own GLB AND SketchUp source —
  // clearing one variant's model/source on an already-active line must downgrade it the same way
  // removing the parent's sole modelAsset does; recomputing on a SET is harmless (it can only
  // confirm readiness, never falsely break it). addVariantSourceAsset/removeVariantSourceAssetId
  // follow the exact same reasoning, scoped per variant instead of per item.
  const mightAffectReadiness =
    edit.photoAsset === null ||
    edit.modelAsset === null ||
    edit.showIn2D !== undefined ||
    edit.showIn3D !== undefined ||
    edit.removeSourceAssetId !== undefined ||
    edit.setVariantModelAsset !== undefined ||
    edit.setVariantPhotoAsset !== undefined ||
    edit.addVariantSourceAsset !== undefined ||
    edit.removeVariantSourceAssetId !== undefined;
  // Druh komponenty → Kategorie (domain/catalogClassification.ts). Only a save that changes the
  // classification is validated (opening / editing other fields of a historical card never is), and
  // the category is then the single source of the derived data: price_category and the technical
  // service category. Never a silent fallback — an invalid combination is refused.
  if (edit.category !== undefined || typeAndKind) {
    const resultingCategory = (nextDocument.category as string | undefined) ?? current.category;
    const { categories } = await readCatalogCategoryRegister(client);
    const issue = classificationIssue(categories, { itemType: typeAndKind?.itemType ?? itemTypeOf(current), kind: kindForEdit, category: resultingCategory }, { requireActive: resultingCategory !== current.category });
    if (issue) throw new InvalidCatalogItemAdminEditError("category", issue);
    const category = findCategory(categories, resultingCategory);
    if (category) {
      const price = derivedPriceCategory(category);
      if (price && price !== current.priceCategory) columnPatch.price_category = price;
      if (category.serviceCategory && documentServiceTechnical(nextDocument)?.serviceCategory !== category.serviceCategory) {
        nextDocument = { ...nextDocument, serviceTechnical: { ...(documentServiceTechnical(nextDocument) ?? {}), serviceCategory: category.serviceCategory } };
      }
    }
  }
  const resultingStatus = (nextDocument.lifecycleStatus as CatalogItemStatus | undefined) ?? current.lifecycleStatus;
  if (mightAffectReadiness && resultingStatus === "active") {
    const readiness = evaluateCatalogReadiness({ ...withColumnInternalCode(nextDocument as Partial<ComponentDefinition>, resultingInternalCode), lifecycleStatus: "active" } as ComponentDefinition, kindForEdit, { itemType: resultingItemType });
    if (!readiness.ready) {
      nextDocument = { ...nextDocument, lifecycleStatus: "needs_review" };
    }
  }

  const patch = {
    display_name: (nextDocument.displayName as string | undefined) ?? (nextDocument.name as string | undefined) ?? current.displayName,
    category: (nextDocument.category as string | undefined) ?? current.category,
    unit: (nextDocument.unit as string | undefined) ?? current.unit,
    lifecycle_status: (nextDocument.lifecycleStatus as CatalogItemStatus | undefined) ?? current.lifecycleStatus,
    document: nextDocument,
    ...columnPatch,
  };

  // Only select the new columns when the DB is known to have them (or this edit writes them) —
  // a routine save against a not-yet-migrated DB must keep working.
  const touchesV2Columns = "item_type" in columnPatch || "abf_code" in columnPatch;
  const touchesV3Columns = "official_name_en" in columnPatch || "unit_code" in columnPatch;
  const touchesV4Columns = "price_category" in columnPatch;
  const runUpdate = async (columns: string) => {
    let query = client.from("catalog_items").update(patch).eq("id", id);
    if (expectedUpdatedAt !== null) query = query.eq("updated_at", expectedUpdatedAt);
    return query.select(columns);
  };
  let { data, error } = await runUpdate(ADMIN_COLUMNS_V4);
  if (error && isMissingSchemaError(error)) {
    if (touchesV4Columns) throw new CatalogSchemaNotMigratedError();
    ({ data, error } = await runUpdate(ADMIN_COLUMNS));
  }
  if (error && isMissingSchemaError(error)) {
    if (touchesV3Columns) throw new CatalogSchemaNotMigratedError();
    ({ data, error } = await runUpdate(ADMIN_COLUMNS_V2));
  }
  if (error && isMissingSchemaError(error)) {
    if (touchesV2Columns) throw new CatalogSchemaNotMigratedError();
    ({ data, error } = await runUpdate(LEGACY_ADMIN_COLUMNS));
  }
  if (error) {
    if ((error as { code?: string }).code === "23505" && typeof columnPatch.abf_code === "string") throw new DuplicateAbfCodeError(columnPatch.abf_code);
    if ((error as { code?: string }).code === "23505" && typeof columnPatch.internal_code === "string") throw new DuplicateInternalCodeError(columnPatch.internal_code);
    throw error;
  }
  if (!data || data.length === 0) {
    // Row existed a moment ago (we just read it above) but the conditional UPDATE matched
    // nothing — someone else changed updated_at in between. Never silently no-op.
    throw new ConcurrencyConflictError("catalog_item", id);
  }
  return rowToAdmin((data as unknown as CatalogItemAdminDbRow[])[0]!, current.packageItems ?? []);
}

/**
 * Hromadná archivace / obnova. Every item goes through the SAME saveCatalogItemAdmin path as a
 * single-item action (archive bookkeeping, restore readiness re-check) — never a raw bulk
 * UPDATE. planBulkLifecycle skips active items for archive unless includeActive.
 */
export async function bulkLifecycleCatalogItemsAdmin(
  client: SupabaseClient,
  request: BulkLifecycleRequest,
): Promise<Readonly<{ outcomes: readonly BulkLifecycleOutcome[]; items: readonly CatalogItemAdmin[] }>> {
  const outcomes: BulkLifecycleOutcome[] = [];
  const items: CatalogItemAdmin[] = [];
  for (const id of request.ids) {
    const current = await readCatalogItemAdminById(client, id);
    if (!current) {
      outcomes.push({ id, result: "skipped", detail: "Položka nebyla nalezena." });
      continue;
    }
    const plan = planBulkLifecycle(current, request);
    if (plan.skip) {
      outcomes.push({ id, result: "skipped", detail: plan.detail });
      continue;
    }
    const edit: CatalogItemAdminEdit = request.action === "archive" ? { lifecycleStatus: "archived" } : { restoreFromArchive: true };
    const saved = await saveCatalogItemAdmin(client, id, edit, current.updatedAt);
    items.push(saved);
    outcomes.push({ id, result: request.action === "archive" ? "archived" : "restored", detail: saved.lifecycleStatus });
  }
  return { outcomes, items };
}

/**
 * Replaces one BOOTH/KIT's content with exactly `inputs` (display order = sort order). New lines
 * get a key, everything is validated in the domain, then replace_catalog_kit_lines() writes the
 * whole kit in one transaction. On a database without the V1-DATA-04 migration a kit that uses
 * nothing new is still saved the old way; anything new needs the migration.
 */
export async function saveCatalogPackageItems(
  client: SupabaseClient,
  packageItemId: string,
  inputs: readonly CatalogPackageItemInput[],
): Promise<Readonly<{ packageItems: readonly CatalogPackageItem[]; warnings: readonly string[] }>> {
  const [allItems, variantSets] = await Promise.all([readCatalogItemsAdmin(client), readCatalogVariantSets(client)]);
  const owner = allItems.find((item) => item.id === packageItemId);
  if (!owner) throw new CatalogItemAdminNotFoundError(packageItemId);
  const itemsById = new Map(allItems.map((item) => [item.id, { id: item.id, itemType: itemTypeOf(item), displayName: item.displayName, abfCode: item.abfCode ?? null, internalCode: item.internalCode }] as const));
  const lines = assignKitLineKeys(inputs, itemsById);
  const warnings = validateKitLines(packageItemId, lines, { itemsById, variantSets });

  const { error: rpcError } = await client.rpc("replace_catalog_kit_lines", { p_package_item_id: packageItemId, p_lines: buildKitLinesRpcPayload(lines) });
  if (rpcError) {
    if (!isMissingFunctionError(rpcError)) {
      // Trigger / constraint messages (A14, text line rules) are Czech and meant for the admin.
      if ((rpcError as { code?: string }).code === "P0001") throw new InvalidCatalogPackageError((rpcError as { message?: string }).message ?? "Obsah kompletu se nepodařilo uložit.");
      throw rpcError;
    }
    if (!isLegacyCompatibleKit(lines)) throw new CatalogSchemaNotMigratedError();
    await saveLegacyPackageItems(client, owner.packageItems ?? [], packageItemId, lines);
  }
  const refreshed = await readCatalogPackageItems(client);
  return { packageItems: refreshed.filter((link) => link.packageItemId === packageItemId), warnings };
}

/**
 * Pre-V1-DATA-04 write path: upsert by (package_item_id, child_item_id), then delete links no
 * longer present — upsert first, so a failure mid-way can never leave the package emptier than
 * either the old or the new set.
 */
async function saveLegacyPackageItems(
  client: SupabaseClient,
  storedLines: readonly CatalogPackageItem[],
  packageItemId: string,
  lines: readonly CatalogPackageItemInput[],
): Promise<void> {
  if (lines.length > 0) {
    const { error: upsertError } = await client.from("catalog_item_package_items").upsert(
      lines.map((line, index) => ({
        package_item_id: packageItemId,
        child_item_id: line.childItemId,
        quantity: line.quantity,
        included_in_package: line.includedInPackage,
        sort_order: index,
        note: line.note ?? null,
      })),
      { onConflict: "package_item_id,child_item_id" },
    );
    if (upsertError) {
      if (isMissingSchemaError(upsertError)) throw new CatalogSchemaNotMigratedError();
      throw upsertError;
    }
  }
  const keep = new Set(lines.map((line) => line.childItemId));
  const stale = storedLines.filter((link) => !keep.has(link.childItemId ?? undefined));
  for (const link of stale) {
    const { error: deleteError } = await client.from("catalog_item_package_items").delete().eq("id", link.id);
    if (deleteError) throw deleteError;
  }
}

// ============================================================================
// SWATCH BOOKS (catalog_variant_sets / catalog_variants, V1-DATA-04). Saved one set at a time:
// variants are inserted or updated, never deleted (deactivate instead).
// ============================================================================

function rowToVariant(row: CatalogVariantDbRow): CatalogVariant {
  return {
    id: row.id,
    variantSetId: row.variant_set_id,
    code: row.code,
    name: row.name,
    ...(row.name_en ? { nameEn: row.name_en } : {}),
    ...(row.series ? { series: row.series } : {}),
    ...(row.swatch_color ? { swatchColor: row.swatch_color } : {}),
    ...(isVariantAssetShape(row.photo_asset) ? { photoAsset: row.photo_asset } : {}),
    ...(isVariantAssetShape(row.texture_asset) ? { textureAsset: row.texture_asset } : {}),
    ...(parseVariantImageSource(row.image_source) ? { imageSource: parseVariantImageSource(row.image_source)! } : {}),
    ...(row.price_item_id ? { priceItemId: row.price_item_id } : {}),
    surchargeRule: ((VARIANT_SURCHARGE_RULES as readonly string[]).includes(row.surcharge_rule) ? row.surcharge_rule : "none") as VariantSurchargeRule,
    ...(row.surcharge_unit_code ? { surchargeUnitCode: row.surcharge_unit_code } : {}),
    ...(row.legacy_finish_id ? { legacyFinishId: row.legacy_finish_id } : {}),
    isActive: row.is_active,
    sortOrder: row.sort_order ?? 0,
    ...(row.note ? { note: row.note } : {}),
  };
}

/** Every swatch book with all its variants (active and inactive). Empty without the V1-DATA-04 migration. */
export async function readCatalogVariantSets(client: SupabaseClient): Promise<readonly CatalogVariantSet[]> {
  let [sets, variants] = await Promise.all([
    client.from("catalog_variant_sets").select(VARIANT_SET_COLUMNS),
    client.from("catalog_variants").select(VARIANT_COLUMNS_V2),
  ]);
  // Before 20261103120000 the product-line / image columns do not exist yet.
  if (variants.error && isMissingSchemaError(variants.error) && !sets.error) variants = await client.from("catalog_variants").select(VARIANT_COLUMNS);
  for (const result of [sets, variants]) {
    if (result.error) {
      if (isMissingSchemaError(result.error)) return [];
      throw result.error;
    }
  }
  const variantsBySet = new Map<string, CatalogVariant[]>();
  for (const row of (variants.data ?? []) as CatalogVariantDbRow[]) {
    variantsBySet.set(row.variant_set_id, [...(variantsBySet.get(row.variant_set_id) ?? []), rowToVariant(row)]);
  }
  return ((sets.data ?? []) as CatalogVariantSetDbRow[])
    .map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      kind: ((VARIANT_SET_KINDS as readonly string[]).includes(row.kind) ? row.kind : "other") as VariantSetKind,
      isActive: row.is_active,
      ...(row.note ? { note: row.note } : {}),
      variants: (variantsBySet.get(row.id) ?? []).sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code)),
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

export async function saveCatalogVariantSet(client: SupabaseClient, input: CatalogVariantSetInput): Promise<CatalogVariantSet> {
  const [sets, items] = await Promise.all([readCatalogVariantSetsStrict(client), selectCatalogRows(client)]);
  const issues = validateCatalogVariantSet(input, { sets, knownItemIds: new Set(items.map((item) => item.id)) });
  if (issues.length > 0) throw new InvalidCatalogVariantSetError(issues);

  const setRow = { code: input.code, name: input.name, kind: input.kind, is_active: input.isActive, note: input.note ?? null };
  let setId = input.id;
  if (setId) {
    const { error } = await client.from("catalog_variant_sets").update(setRow).eq("id", setId);
    if (error) throw mapVariantWriteError(error);
  } else {
    const { data, error } = await client.from("catalog_variant_sets").insert(setRow).select("id").single();
    if (error) throw mapVariantWriteError(error);
    setId = (data as { id: string }).id;
  }
  for (const [index, variant] of input.variants.entries()) {
    const row = {
      variant_set_id: setId,
      code: variant.code,
      name: variant.name,
      name_en: variant.nameEn ?? null,
      swatch_color: variant.swatchColor ?? null,
      price_item_id: variant.priceItemId ?? null,
      surcharge_rule: variant.surchargeRule,
      surcharge_unit_code: variant.surchargeRule === "per_unit" ? variant.surchargeUnitCode ?? null : null,
      legacy_finish_id: variant.legacyFinishId ?? null,
      is_active: variant.isActive,
      sort_order: index,
      note: variant.note ?? null,
      // V1-CARPET-02 columns are written only when the input carries them, so an editor that does
      // not know them (or a DB before 20261103120000) never clears a stored line, photo or texture.
      ...(variant.series !== undefined ? { series: variant.series } : {}),
      ...(variant.photoAsset !== undefined ? { photo_asset: variant.photoAsset } : {}),
      ...(variant.textureAsset !== undefined ? { texture_asset: variant.textureAsset } : {}),
      ...(variant.imageSource !== undefined ? { image_source: variant.imageSource } : {}),
    };
    const { error } = variant.id
      ? await client.from("catalog_variants").update(row).eq("id", variant.id)
      : await client.from("catalog_variants").insert(row);
    if (error) throw mapVariantWriteError(error);
  }
  const saved = (await readCatalogVariantSetsStrict(client)).find((set) => set.id === setId);
  if (!saved) throw new InvalidCatalogVariantSetError(["Vzorník se nepodařilo znovu načíst."]);
  return saved;
}

async function readCatalogVariantSetsStrict(client: SupabaseClient): Promise<readonly CatalogVariantSet[]> {
  const { error } = await client.from("catalog_variant_sets").select("id").limit(1);
  if (error) {
    if (isMissingSchemaError(error)) throw new CatalogSchemaNotMigratedError();
    throw error;
  }
  return readCatalogVariantSets(client);
}

function mapVariantWriteError(error: unknown): unknown {
  if (isMissingSchemaError(error)) return new CatalogSchemaNotMigratedError();
  if ((error as { code?: string }).code === "23505") return new InvalidCatalogVariantSetError(["Kód vzorníku nebo barvy už existuje."]);
  return error;
}

// ============================================================================
// ALIASES (catalog_item_aliases, V1-DATA-03) — general and per realization company. Saved as a
// full list per item: new/edited aliases are inserted, removed ones deactivated, nothing deleted.
// ============================================================================

type CatalogItemAliasDbRow = Readonly<{
  id: string;
  catalog_item_id: string;
  realization_company_id: string | null;
  alias_kind: string;
  alias_text: string;
  normalized_text: string;
  unit_code: string | null;
  source: string;
  status: string;
  note: string | null;
  is_active: boolean;
}>;

function rowToAlias(row: CatalogItemAliasDbRow): CatalogItemAlias {
  return {
    id: row.id,
    catalogItemId: row.catalog_item_id,
    realizationCompanyId: row.realization_company_id ?? undefined,
    aliasKind: row.alias_kind as CatalogItemAliasKind,
    aliasText: row.alias_text,
    normalizedText: row.normalized_text,
    unitCode: row.unit_code ?? undefined,
    source: row.source as CatalogItemAliasSource,
    status: row.status as CatalogItemAliasStatus,
    note: row.note ?? undefined,
    isActive: row.is_active,
  };
}

/** Every alias, active and inactive. Empty on a database without the V1-DATA-03 migration. */
export async function readCatalogItemAliases(client: SupabaseClient): Promise<readonly CatalogItemAlias[]> {
  const { data, error } = await client.from("catalog_item_aliases").select(ALIAS_COLUMNS).order("alias_text", { ascending: true });
  if (error) {
    if (isMissingSchemaError(error)) return [];
    throw error;
  }
  return ((data ?? []) as CatalogItemAliasDbRow[]).map(rowToAlias);
}

export async function saveCatalogItemAliases(client: SupabaseClient, catalogItemId: string, inputs: readonly CatalogItemAliasInput[]): Promise<readonly CatalogItemAlias[]> {
  const [items, aliases, companies] = await Promise.all([
    selectCatalogRows(client),
    readCatalogItemAliasesStrict(client),
    client.from("print_surface_realization_companies").select("id"),
  ]);
  if (companies.error) throw companies.error;
  if (!items.some((item) => item.id === catalogItemId)) throw new CatalogItemAdminNotFoundError(catalogItemId);
  const issues = validateCatalogItemAliases(catalogItemId, inputs, {
    aliases,
    companyIds: new Set(((companies.data ?? []) as { id: string }[]).map((company) => company.id)),
    itemNameById: new Map(items.map((item) => [item.id, item.display_name] as const)),
  });
  if (issues.length > 0) throw new InvalidCatalogAliasesError(issues);

  const changes = planCatalogItemAliasChanges(catalogItemId, inputs, aliases);
  // Deactivations first, so an edited alias can be re-inserted under the unique active-alias index.
  for (const id of changes.deactivateIds) {
    const { error } = await client.from("catalog_item_aliases").update({ is_active: false }).eq("id", id);
    if (error) throw error;
  }
  if (changes.insert.length > 0) {
    const { error } = await client.from("catalog_item_aliases").insert(changes.insert.map((alias) => ({
      catalog_item_id: alias.catalogItemId,
      realization_company_id: alias.realizationCompanyId ?? null,
      alias_kind: alias.aliasKind,
      alias_text: alias.aliasText,
      normalized_text: alias.normalizedText,
      unit_code: alias.unitCode ?? null,
      source: alias.source,
      status: alias.status,
      note: alias.note ?? null,
      is_active: true,
    })));
    if (error) {
      if ((error as { code?: string }).code === "23505") throw new InvalidCatalogAliasesError([{ index: -1, code: "TAKEN", message: "Stejný alias mezitím uložil někdo jiný u jiné položky." }]);
      throw error;
    }
  }
  return (await readCatalogItemAliasesStrict(client)).filter((alias) => alias.catalogItemId === catalogItemId);
}

async function readCatalogItemAliasesStrict(client: SupabaseClient): Promise<readonly CatalogItemAlias[]> {
  const { data, error } = await client.from("catalog_item_aliases").select(ALIAS_COLUMNS);
  if (error) {
    if (isMissingSchemaError(error)) throw new CatalogSchemaNotMigratedError();
    throw error;
  }
  return ((data ?? []) as CatalogItemAliasDbRow[]).map(rowToAlias);
}
