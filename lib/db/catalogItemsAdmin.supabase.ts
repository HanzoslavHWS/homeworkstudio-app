import type { SupabaseClient } from "@supabase/supabase-js";
import { assertCanActivate, evaluateCatalogReadiness } from "../../domain/catalogReadiness.ts";
import { ConcurrencyConflictError } from "./concurrency.ts";
import {
  applyCatalogItemEdit,
  CatalogItemAdminNotFoundError,
  type CatalogItemAdmin,
  type CatalogItemAdminDocument,
  type CatalogItemAdminEdit,
} from "../../domain/catalogItemsAdmin.ts";
import type { CatalogItemKind, CatalogItemStatus, ComponentDefinition } from "../../domain/models.ts";

const ADMIN_COLUMNS = "id, internal_code, kind, lifecycle_status, display_name, official_name, category, unit, document, created_at, updated_at";

type CatalogItemAdminDbRow = Readonly<{
  id: string;
  internal_code: string | null;
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

function rowToAdmin(row: CatalogItemAdminDbRow): CatalogItemAdmin {
  return {
    id: row.id,
    internalCode: row.internal_code,
    kind: row.kind as CatalogItemKind,
    lifecycleStatus: row.lifecycle_status as CatalogItemStatus,
    displayName: row.display_name,
    officialName: row.official_name,
    category: row.category,
    unit: row.unit,
    document: (row.document ?? {}) as CatalogItemAdminDocument,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Full admin read — catalog_items is small (81 rows as of Batch #2B), same "select in full
 * every call" pattern already used by readCatalogItems/readExistingCatalogItemsFull. Unlike
 * the customer-safe CatalogItemSummary (lib/db/catalogPricing.supabase.ts), this includes the
 * FULL document (source traceability, pricingEntries, parts, printSurfaces, ...) — it is only
 * ever served to the authenticated admin session, never to the generator/customer path.
 */
export async function readCatalogItemsAdmin(client: SupabaseClient): Promise<readonly CatalogItemAdmin[]> {
  const { data, error } = await client.from("catalog_items").select(ADMIN_COLUMNS);
  if (error) throw error;
  return ((data ?? []) as CatalogItemAdminDbRow[]).map(rowToAdmin);
}

export async function readCatalogItemAdminById(client: SupabaseClient, id: string): Promise<CatalogItemAdmin | undefined> {
  const { data, error } = await client.from("catalog_items").select(ADMIN_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? rowToAdmin(data as CatalogItemAdminDbRow) : undefined;
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

  let nextDocument = applyCatalogItemEdit(current.document, edit);

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
    assertCanActivate({ ...nextDocument, lifecycleStatus: "active" } as ComponentDefinition, current.kind);
  }

  // Section 8 (asset workflow spec): removing a photo/model reference from an ALREADY active
  // item must never leave it active+readiness=false. Scoped narrowly to explicit asset
  // removal (photoAsset/modelAsset === null) — an unrelated edit to an already-active but
  // legacy-imperfect item (like M57, missing reviewedAt) must never retroactively downgrade
  // it, matching the activation-guard scoping immediately above. Auto-downgrade rather than
  // blocking: the removal itself always succeeds, the item just safely falls back to
  // needs_review instead of silently violating the active+ready invariant.
  const removedAssetReference = edit.photoAsset === null || edit.modelAsset === null;
  const resultingStatus = (nextDocument.lifecycleStatus as CatalogItemStatus | undefined) ?? current.lifecycleStatus;
  if (removedAssetReference && resultingStatus === "active") {
    const readiness = evaluateCatalogReadiness({ ...nextDocument, lifecycleStatus: "active" } as ComponentDefinition, current.kind);
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
  };

  let query = client.from("catalog_items").update(patch).eq("id", id);
  if (expectedUpdatedAt !== null) query = query.eq("updated_at", expectedUpdatedAt);
  const { data, error } = await query.select(ADMIN_COLUMNS);
  if (error) throw error;
  if (!data || data.length === 0) {
    // Row existed a moment ago (we just read it above) but the conditional UPDATE matched
    // nothing — someone else changed updated_at in between. Never silently no-op.
    throw new ConcurrencyConflictError("catalog_item", id);
  }
  return rowToAdmin((data as CatalogItemAdminDbRow[])[0]!);
}
