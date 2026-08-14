import type { SupabaseClient } from "@supabase/supabase-js";
import type { CatalogItemKind, Currency } from "../../domain/models.ts";
import {
  BATCH2A_SOURCE_SYSTEM,
  CatalogItemConflictError,
  Batch2aPreflightError,
  resolveCatalogItemForApply,
  resolvePricingEntryForApply,
  runBatch2aPreflight,
  type Batch2aPlan,
  type ExistingCatalogItemRow,
  type ExistingCatalogMappingRow,
  type ExistingPricingEntryRow,
  type PlannedCanonicalCatalogItem,
  type PlannedTechnicalService,
} from "../../domain/importBatch2a.ts";

/**
 * NEVER CALLED against real Supabase in this session — code-complete for review, gated
 * behind an explicit --apply flag in scripts/importBatch2a.ts (default is --dry-run,
 * read-only). Mirrors lib/db/importBatch1.supabase.ts's shape: pure domain functions decide
 * every insert/update/noop/conflict, this file only ever executes what they decided.
 *
 * Apply order (section 2): 1) canonical M57/L02  2) 22 technical-service catalog_items
 * 3) resolve real DB uuids  4) confirmed catalog_mappings  5) 495 pricing_entries
 * 6) import_batches audit status  7) caller-side verification (scripts/importBatch2a.ts).
 *
 * Safe-failure design (section 10, mirrors Batch #1): import_batches.status starts at
 * 'dry_run' the instant apply begins (proof an apply was attempted) and only flips to
 * 'applied' once every step below has actually succeeded; a crash anywhere in between
 * leaves it 'failed' with a partial summary. No new status value is invented — the schema's
 * existing ('dry_run','applied','failed') already covers this.
 */

// ---------------------------------------------------------------------------------------
// READ-ONLY helpers — safe to call in --dry-run, used by both preview and apply.
// ---------------------------------------------------------------------------------------

type CatalogItemDbRow = Readonly<{
  id: string;
  internal_code: string | null;
  kind: string;
  document: Readonly<{ sourceSystem?: string; sourceKey?: string }> | null;
}>;

export async function readExistingCatalogItemsFull(client: SupabaseClient): Promise<readonly ExistingCatalogItemRow[]> {
  const { data, error } = await client.from("catalog_items").select("id, internal_code, kind, document");
  if (error) throw error;
  return ((data ?? []) as CatalogItemDbRow[]).map((row) => ({
    id: row.id,
    internalCode: row.internal_code ?? undefined,
    kind: row.kind as CatalogItemKind,
    sourceSystem: row.document?.sourceSystem,
    sourceKey: row.document?.sourceKey,
  }));
}

type CatalogMappingDbRow = Readonly<{ source_system: string; source_key: string; catalog_item_id: string }>;

export async function readExistingCatalogMappings(client: SupabaseClient): Promise<readonly ExistingCatalogMappingRow[]> {
  const { data, error } = await client.from("catalog_mappings").select("source_system, source_key, catalog_item_id");
  if (error) throw error;
  return ((data ?? []) as CatalogMappingDbRow[]).map((row) => ({ sourceSystem: row.source_system, sourceKey: row.source_key, catalogItemId: row.catalog_item_id }));
}

type PricingEntryDbRow = Readonly<{
  id: string;
  catalog_item_id: string;
  price_list_id: string;
  event_id: string;
  currency: Currency;
  sale_price: number | null;
}>;

/** Scoped to known catalog_item_ids — pricing_entries has no other cheap way to narrow this, and the batch only ever cares about its own 24 catalog items. Empty input -> empty result, no query. */
export async function readExistingPricingEntriesForCatalogItems(client: SupabaseClient, catalogItemIds: readonly string[]): Promise<readonly ExistingPricingEntryRow[]> {
  if (catalogItemIds.length === 0) return [];
  const { data, error } = await client.from("pricing_entries").select("id, catalog_item_id, price_list_id, event_id, currency, sale_price").in("catalog_item_id", catalogItemIds);
  if (error) throw error;
  return ((data ?? []) as PricingEntryDbRow[]).map((row) => ({
    id: row.id,
    catalogItemId: row.catalog_item_id,
    priceListId: row.price_list_id,
    eventId: row.event_id,
    currency: row.currency,
    salePrice: row.sale_price,
  }));
}

// ---------------------------------------------------------------------------------------
// APPLY — never invoked this session.
// ---------------------------------------------------------------------------------------

export type Batch2aApplyResult = Readonly<{
  batchId: string;
  catalogItems: Readonly<{ inserted: number; noop: number }>;
  catalogMappings: Readonly<{ inserted: number; noop: number }>;
  pricingEntries: Readonly<{ inserted: number; updated: number; noop: number }>;
}>;

async function insertCanonicalCatalogItem(client: SupabaseClient, canonical: PlannedCanonicalCatalogItem): Promise<string> {
  const { data, error } = await client
    .from("catalog_items")
    .insert({
      internal_code: canonical.internalCode,
      kind: canonical.kind,
      // Canonical items are already-approved reference components (section 4/5) — their
      // seed's lifecycleStatus is legacy-undefined ("treated as active" per domain comment),
      // and the DB column is NOT NULL, so the effective status is persisted explicitly.
      lifecycle_status: "active",
      display_name: canonical.document.displayName ?? canonical.document.name,
      official_name: canonical.document.officialName ?? null,
      category: canonical.document.category ?? null,
      unit: canonical.document.unit ?? null,
      document: canonical.document,
    })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

async function insertTechnicalServiceCatalogItem(client: SupabaseClient, service: PlannedTechnicalService): Promise<string> {
  const documentPayload = { ...service.document, sourceSystem: service.sourceSystem, sourceKey: service.sourceKey };
  const { data, error } = await client
    .from("catalog_items")
    .insert({
      internal_code: service.internalCode,
      kind: service.kind,
      lifecycle_status: "needs_review",
      display_name: service.document?.displayName ?? service.nameCz,
      official_name: null,
      category: service.document?.category ?? null,
      unit: service.document?.unit ?? null,
      document: documentPayload,
    })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

export async function applyBatch2aPlan(
  client: SupabaseClient,
  plan: Batch2aPlan,
  meta: Readonly<{ sourceFileName: string; sourceFingerprint: string; sourceVersion?: string }>,
): Promise<Batch2aApplyResult> {
  const existingCatalogItems = await readExistingCatalogItemsFull(client);
  const preflight = runBatch2aPreflight(plan, existingCatalogItems);
  if (!preflight.ok) throw new Batch2aPreflightError(preflight.issues);

  const { data: batchRow, error: batchError } = await client
    .from("import_batches")
    .insert({ source_file_name: meta.sourceFileName, source_fingerprint: meta.sourceFingerprint, source_version: meta.sourceVersion, status: "dry_run" })
    .select()
    .single();
  if (batchError) throw batchError;
  const batchId = (batchRow as { id: string }).id;

  try {
    // Steps 1-3: canonical M57/L02, then the 22 technical-service candidates. mutableExisting
    // grows as we go so later items in THIS SAME run can also be found idempotently (e.g. a
    // duplicate internal_code introduced within one plan would be caught here too).
    const mutableExisting = [...existingCatalogItems];
    const idByRef = new Map<string, string>(); // internalCode or sourceKey -> real DB uuid
    let catalogItemsInserted = 0;
    let catalogItemsNoop = 0;

    for (const canonical of plan.canonicalCatalogItems) {
      const resolution = resolveCatalogItemForApply(
        { internalCode: canonical.internalCode, sourceSystem: BATCH2A_SOURCE_SYSTEM, sourceKey: canonical.internalCode, kind: canonical.kind },
        mutableExisting,
      );
      if (resolution.action === "conflict") {
        throw new CatalogItemConflictError(resolution.conflictReason!, { internalCode: canonical.internalCode, sourceKey: canonical.internalCode, existingId: resolution.existingId! });
      }
      if (resolution.action === "noop") {
        idByRef.set(canonical.internalCode, resolution.existingId!);
        catalogItemsNoop += 1;
        continue;
      }
      const id = await insertCanonicalCatalogItem(client, canonical);
      idByRef.set(canonical.internalCode, id);
      mutableExisting.push({ id, internalCode: canonical.internalCode, kind: canonical.kind });
      catalogItemsInserted += 1;
    }

    for (const service of plan.technicalServices) {
      if (!service.isNewCatalogItem) continue; // mapped onto canonical L02 above — never a second catalog_item
      const resolution = resolveCatalogItemForApply(
        { internalCode: service.internalCode, sourceSystem: service.sourceSystem, sourceKey: service.sourceKey, kind: service.kind },
        mutableExisting,
      );
      if (resolution.action === "conflict") {
        throw new CatalogItemConflictError(resolution.conflictReason!, { internalCode: service.internalCode, sourceKey: service.sourceKey, existingId: resolution.existingId! });
      }
      if (resolution.action === "noop") {
        idByRef.set(service.sourceKey, resolution.existingId!);
        if (service.internalCode) idByRef.set(service.internalCode, resolution.existingId!);
        catalogItemsNoop += 1;
        continue;
      }
      const id = await insertTechnicalServiceCatalogItem(client, service);
      idByRef.set(service.sourceKey, id);
      if (service.internalCode) idByRef.set(service.internalCode, id);
      mutableExisting.push({ id, internalCode: service.internalCode ?? undefined, kind: service.kind, sourceSystem: service.sourceSystem, sourceKey: service.sourceKey });
      catalogItemsInserted += 1;
    }

    // Step 4: confirmed catalog_mappings (M57, L02) — never the rejected kettle/L02 decision,
    // that stays audit-trail-only in import_rows (Batch #1, already applied).
    const existingMappings = await readExistingCatalogMappings(client);
    let catalogMappingsInserted = 0;
    let catalogMappingsNoop = 0;
    for (const mapping of plan.mappings.confirmed) {
      const catalogItemId = idByRef.get(mapping.canonicalInternalCode);
      if (!catalogItemId) throw new Error(`Interní chyba: catalog_item_id pro mapping "${mapping.canonicalInternalCode}" nebyl resolvován — apply zastaven.`);
      const already = existingMappings.find((m) => m.sourceSystem === mapping.sourceSystem && m.sourceKey === mapping.sourceKey);
      if (already) {
        if (already.catalogItemId !== catalogItemId) {
          throw new CatalogItemConflictError(
            `catalog_mappings pro "${mapping.rawName}" (${mapping.sourceKey}) už existuje a ukazuje na jiný catalog_item_id (${already.catalogItemId}) než nově resolvovaný (${catalogItemId}) — apply zastaven.`,
            { internalCode: mapping.canonicalInternalCode, sourceKey: mapping.sourceKey, existingId: already.catalogItemId },
          );
        }
        catalogMappingsNoop += 1;
        continue;
      }
      const { error } = await client
        .from("catalog_mappings")
        .insert({ source_system: mapping.sourceSystem, source_key: mapping.sourceKey, normalized_name: mapping.normalizedName, catalog_item_id: catalogItemId, confirmed: true });
      if (error) throw error;
      catalogMappingsInserted += 1;
    }

    // Step 5: 495 pricing_entries — idempotent by (catalog_item_id, price_list_id, event_id,
    // currency) since the DB has no unique constraint covering that natural key.
    const involvedCatalogItemIds = [...new Set(plan.pricing.entries.map((entry) => idByRef.get(entry.catalogItemRef)).filter((id): id is string => Boolean(id)))];
    const existingPricingEntries = await readExistingPricingEntriesForCatalogItems(client, involvedCatalogItemIds);
    let pricingInserted = 0;
    let pricingUpdated = 0;
    let pricingNoop = 0;
    for (const entry of plan.pricing.entries) {
      const catalogItemId = idByRef.get(entry.catalogItemRef);
      if (!catalogItemId) throw new Error(`Interní chyba: catalog_item_id pro pricing entry (${entry.catalogItemRef}) nebyl resolvován — tento řádek se nezapíše, apply zastaven.`);
      const resolution = resolvePricingEntryForApply(
        { catalogItemId, priceListId: entry.priceListId, eventId: entry.eventId, currency: entry.currency, salePrice: entry.salePrice },
        existingPricingEntries,
      );
      if (resolution.action === "insert") {
        const { error } = await client
          .from("pricing_entries")
          .insert({ catalog_item_id: catalogItemId, price_list_id: entry.priceListId, event_id: entry.eventId, currency: entry.currency, sale_price: entry.salePrice, price_mode: "fixed" });
        if (error) throw error;
        pricingInserted += 1;
      } else if (resolution.action === "update") {
        const { error } = await client.from("pricing_entries").update({ sale_price: entry.salePrice }).eq("id", resolution.existingId);
        if (error) throw error;
        pricingUpdated += 1;
      } else {
        pricingNoop += 1;
      }
    }

    // Step 6: finalize audit status.
    const summary = {
      catalogItems: { inserted: catalogItemsInserted, noop: catalogItemsNoop },
      catalogMappings: { inserted: catalogMappingsInserted, noop: catalogMappingsNoop },
      pricingEntries: { inserted: pricingInserted, updated: pricingUpdated, noop: pricingNoop },
      warnings: plan.warnings,
    };
    const { error: completeError } = await client.from("import_batches").update({ status: "applied", summary }).eq("id", batchId);
    if (completeError) throw completeError;

    return {
      batchId,
      catalogItems: { inserted: catalogItemsInserted, noop: catalogItemsNoop },
      catalogMappings: { inserted: catalogMappingsInserted, noop: catalogMappingsNoop },
      pricingEntries: { inserted: pricingInserted, updated: pricingUpdated, noop: pricingNoop },
    };
  } catch (error) {
    await client.from("import_batches").update({ status: "failed", summary: { error: error instanceof Error ? error.message : String(error) } }).eq("id", batchId);
    throw error;
  }
}
