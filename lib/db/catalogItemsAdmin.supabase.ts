import type { SupabaseClient } from "@supabase/supabase-js";
import { assertCanActivate, assertUniqueInternalCode, DuplicateInternalCodeError, evaluateCatalogReadiness } from "../../domain/catalogReadiness.ts";
import { ConcurrencyConflictError } from "./concurrency.ts";
import {
  applyCatalogItemEdit,
  buildCatalogItemCreateDocument,
  buildCatalogItemDuplicateDocument,
  CatalogItemAdminNotFoundError,
  duplicateDisplayName,
  InvalidCatalogItemAdminEditError,
  itemTypeOf,
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
import { defaultItemTypeForKind, DuplicateAbfCodeError } from "../../domain/catalogItemTypes.ts";
import {
  assertValidPackageContents,
  InvalidCatalogPackageError,
  sortPackageItems,
  type CatalogPackageItem,
  type CatalogPackageItemInput,
} from "../../domain/catalogPackages.ts";
import type { CatalogItemKind, CatalogItemStatus, CatalogItemType, ComponentDefinition } from "../../domain/models.ts";

const LEGACY_ADMIN_COLUMNS = "id, internal_code, kind, lifecycle_status, display_name, official_name, category, unit, document, created_at, updated_at";
const ADMIN_COLUMNS = `${LEGACY_ADMIN_COLUMNS}, abf_code, item_type`;
const PACKAGE_COLUMNS = "id, package_item_id, child_item_id, quantity, included_in_package, sort_order, note";

type CatalogItemAdminDbRow = Readonly<{
  id: string;
  internal_code: string | null;
  abf_code?: string | null;
  item_type?: string | null;
  kind: string;
  lifecycle_status: string;
  display_name: string;
  official_name: string | null;
  category: string | null;
  unit: string | null;
  document: unknown;
  created_at: string;
  updated_at: string;
}>;

type CatalogPackageItemDbRow = Readonly<{
  id: string;
  package_item_id: string;
  child_item_id: string;
  quantity: number | string;
  included_in_package: boolean;
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
    super("Databáze ještě nemá migraci katalogu (abf_code / item_type / obsah balíčků). Aplikujte supabase/migrations/20261001120000_catalog_item_types_abf_codes_packages.sql.");
    this.name = "CatalogSchemaNotMigratedError";
  }
}

/** PostgREST/Postgres codes for "column/table does not exist (yet)". */
function isMissingSchemaError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "42703" || code === "42P01" || code === "PGRST204" || code === "PGRST205";
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
    category: row.category,
    unit: row.unit,
    document: (row.document ?? {}) as CatalogItemAdminDocument,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return packageItems ? { ...item, packageItems } : item;
}

function rowToPackageItem(row: CatalogPackageItemDbRow): CatalogPackageItem {
  return {
    id: row.id,
    packageItemId: row.package_item_id,
    childItemId: row.child_item_id,
    quantity: Number(row.quantity),
    includedInPackage: row.included_in_package,
    sortOrder: row.sort_order ?? 0,
    note: row.note,
  };
}

async function selectCatalogRows(client: SupabaseClient, id?: string): Promise<CatalogItemAdminDbRow[]> {
  const run = async (columns: string) => {
    const base = client.from("catalog_items").select(columns);
    return id ? base.eq("id", id) : base;
  };
  let { data, error } = await run(ADMIN_COLUMNS);
  if (error && isMissingSchemaError(error)) ({ data, error } = await run(LEGACY_ADMIN_COLUMNS));
  if (error) throw error;
  return (data ?? []) as unknown as CatalogItemAdminDbRow[];
}

/** Every package link in the catalog (small table). Empty when the migration hasn't been applied yet. */
export async function readCatalogPackageItems(client: SupabaseClient): Promise<readonly CatalogPackageItem[]> {
  const { data, error } = await client.from("catalog_item_package_items").select(PACKAGE_COLUMNS);
  if (error) {
    if (isMissingSchemaError(error)) return [];
    throw error;
  }
  return sortPackageItems(((data ?? []) as CatalogPackageItemDbRow[]).map(rowToPackageItem));
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

  const document = buildCatalogItemCreateDocument(input);
  const row: Record<string, unknown> = {
    internal_code: input.internalCode?.trim() || null,
    kind: input.kind,
    lifecycle_status: "needs_review",
    display_name: input.displayName,
    official_name: null,
    category: input.category,
    unit: input.unit ?? null,
    document,
    item_type: input.itemType ?? defaultItemTypeForKind(input.kind),
  };
  if (input.abfCode) row.abf_code = input.abfCode;
  let { data, error } = await client.from("catalog_items").insert(row).select(ADMIN_COLUMNS).single();

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
  const links = await saveCatalogPackageItems(
    client,
    created.id,
    sourceLines.map((line) => ({ childItemId: line.childItemId, quantity: line.quantity, includedInPackage: line.includedInPackage, ...(line.note ? { note: line.note } : {}) })),
  );
  return { ...created, packageItems: links };
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

  // Archive / restore bookkeeping. Archiving remembers the status it came from; "Obnovit"
  // (restoreFromArchive) returns to it via resolveRestoreStatus — a previously-active item only
  // comes back active if it still passes readiness. Never touches anything else in the document.
  if (edit.restoreFromArchive === true && current.lifecycleStatus === "archived") {
    nextDocument = { ...withoutArchiveBookkeeping(nextDocument), lifecycleStatus: resolveRestoreStatus({ ...current, kind: kindForEdit }) };
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
    assertCanActivate({ ...nextDocument, lifecycleStatus: "active" } as ComponentDefinition, kindForEdit);
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
  const resultingStatus = (nextDocument.lifecycleStatus as CatalogItemStatus | undefined) ?? current.lifecycleStatus;
  if (mightAffectReadiness && resultingStatus === "active") {
    const readiness = evaluateCatalogReadiness({ ...nextDocument, lifecycleStatus: "active" } as ComponentDefinition, kindForEdit);
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
  const touchesNewColumns = "item_type" in columnPatch || "abf_code" in columnPatch;
  const runUpdate = async (columns: string) => {
    let query = client.from("catalog_items").update(patch).eq("id", id);
    if (expectedUpdatedAt !== null) query = query.eq("updated_at", expectedUpdatedAt);
    return query.select(columns);
  };
  let { data, error } = await runUpdate(ADMIN_COLUMNS);
  if (error && isMissingSchemaError(error)) {
    if (touchesNewColumns) throw new CatalogSchemaNotMigratedError();
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
 * Replaces one BOOTH's package contents with exactly `lines` (upsert by
 * (package_item_id, child_item_id), then delete links no longer present — upsert first, so a
 * failure mid-way can never leave the package emptier than either the old or the new set).
 */
export async function saveCatalogPackageItems(
  client: SupabaseClient,
  packageItemId: string,
  lines: readonly CatalogPackageItemInput[],
): Promise<readonly CatalogPackageItem[]> {
  const allItems = await readCatalogItemsAdmin(client);
  const owner = allItems.find((item) => item.id === packageItemId);
  if (!owner) throw new CatalogItemAdminNotFoundError(packageItemId);
  if (itemTypeOf(owner) !== "BOOTH") throw new InvalidCatalogPackageError("Obsah balíčku lze nastavit jen u karty typu Stánek.");
  const existingLinks = allItems.flatMap((item) => item.packageItems ?? []);
  assertValidPackageContents(packageItemId, lines, new Set(allItems.map((item) => item.id)), existingLinks);

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
  const stale = (owner.packageItems ?? []).filter((link) => !keep.has(link.childItemId));
  for (const link of stale) {
    const { error: deleteError } = await client.from("catalog_item_package_items").delete().eq("id", link.id);
    if (deleteError) throw deleteError;
  }
  const refreshed = await readCatalogPackageItems(client);
  return refreshed.filter((link) => link.packageItemId === packageItemId);
}
