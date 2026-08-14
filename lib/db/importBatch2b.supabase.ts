import type { SupabaseClient } from "@supabase/supabase-js";
import type { BoothType, ComponentDefinition } from "../../domain/models.ts";
import { CatalogItemConflictError, resolveCatalogItemForApply, type ExistingCatalogItemRow } from "../../domain/importBatch2a.ts";
import {
  BATCH2B_SOURCE_SYSTEM,
  Batch2bPreflightError,
  buildBatch2bCatalogDocument,
  planBatch2bMappings,
  runBatch2bPreflight,
  type Batch2bPlanItem,
} from "../../domain/importBatch2b.ts";
import { readExistingCatalogItemsFull, readExistingCatalogMappings } from "./importBatch2a.supabase.ts";

/**
 * NEVER CALLED against real Supabase in this session — code-complete for review, gated behind
 * an explicit --apply flag in scripts/importBatch2b.ts (default is --dry-run, read-only).
 * Reuses Batch #2A's read/resolve/error primitives (readExistingCatalogItemsFull,
 * readExistingCatalogMappings, resolveCatalogItemForApply, CatalogItemConflictError) rather
 * than reimplementing them — see domain/importBatch2b.ts for the pure planning/preflight logic.
 *
 * Apply order (section 11): 1) preflight  2) resolve M57 (noop)  3) insert/resolve P86
 * 4) insert/resolve the 56 ordinary catalog_items  5) resolve real DB uuids
 * 6) insert/noop confirmed catalog_mappings  7) import_batches audit status
 * 8) caller-side verification (scripts/importBatch2b.ts). NO pricing_entries writes anywhere.
 *
 * Safe-failure design mirrors Batch #2A: import_batches.status starts 'dry_run' the instant
 * apply begins and only flips to 'applied' once every step below succeeds; a crash anywhere
 * in between leaves it 'failed' with a partial summary.
 */

// ---------------------------------------------------------------------------------------
// Section 13: transient-read guard. Read existing catalog_items TWICE; if the counts differ,
// the read is suspect (this project has repeatedly seen transient incomplete Supabase reads)
// — STOP rather than plan/write against possibly-wrong data. Deliberately simple: two reads,
// one comparison, no generic retry framework.
// ---------------------------------------------------------------------------------------

export class TransientReadError extends Error {
  readonly firstCount: number;
  readonly secondCount: number;

  constructor(firstCount: number, secondCount: number) {
    super(`Podezřele nekonzistentní čtení catalog_items (1. čtení=${firstCount} řádků, 2. čtení=${secondCount} řádků) — pravděpodobný transient Supabase read problém. STOP před jakýmkoli zápisem.`);
    this.name = "TransientReadError";
    this.firstCount = firstCount;
    this.secondCount = secondCount;
  }
}

export async function readExistingCatalogItemsSafely(client: SupabaseClient): Promise<readonly ExistingCatalogItemRow[]> {
  const first = await readExistingCatalogItemsFull(client);
  const second = await readExistingCatalogItemsFull(client);
  if (first.length !== second.length) throw new TransientReadError(first.length, second.length);
  return second;
}

// ---------------------------------------------------------------------------------------
// APPLY — never invoked this session.
// ---------------------------------------------------------------------------------------

export type Batch2bApplyResult = Readonly<{
  batchId: string;
  catalogItems: Readonly<{ inserted: number; noop: number }>;
  catalogMappings: Readonly<{ inserted: number; noop: number }>;
  /** Always 0 — section 9/11: this writer never touches pricing_entries. */
  pricingEntriesWrites: 0;
}>;

async function insertBatch2bCatalogItem(client: SupabaseClient, item: Batch2bPlanItem, document: ComponentDefinition | BoothType): Promise<string> {
  const documentPayload = { ...document, sourceSystem: BATCH2B_SOURCE_SYSTEM, sourceKey: item.sourceKey };
  const { data, error } = await client
    .from("catalog_items")
    .insert({
      internal_code: item.internalCode,
      kind: item.catalogKind,
      lifecycle_status: item.lifecycleStatus ?? "needs_review",
      display_name: item.sourceName,
      official_name: null,
      category: item.sourceCategory,
      unit: item.unit,
      document: documentPayload,
    })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

/**
 * `koje2x2Document` is the REAL static seed (data/booths.ts's koje-2x2 BoothType) — P86's
 * document is never re-derived, mirroring exactly how Batch #2A treated M57's canonical
 * document (domain/importBatch2a.ts's planCanonicalCatalogItems doc comment).
 */
export async function applyBatch2bPlan(
  client: SupabaseClient,
  items: readonly Batch2bPlanItem[],
  koje2x2Document: BoothType,
  meta: Readonly<{ sourceFileName: string; sourceFingerprint: string; sourceVersion?: string }>,
): Promise<Batch2bApplyResult> {
  const existingCatalogItems = await readExistingCatalogItemsSafely(client);
  const preflight = runBatch2bPreflight(items, existingCatalogItems);
  if (!preflight.ok) throw new Batch2bPreflightError(preflight.issues);

  const { data: batchRow, error: batchError } = await client
    .from("import_batches")
    .insert({ source_file_name: meta.sourceFileName, source_fingerprint: meta.sourceFingerprint, source_version: meta.sourceVersion, status: "dry_run" })
    .select()
    .single();
  if (batchError) throw batchError;
  const batchId = (batchRow as { id: string }).id;

  try {
    const mutableExisting = [...existingCatalogItems];
    const idByRef = new Map<string, string>();
    let catalogItemsInserted = 0;
    let catalogItemsNoop = 0;

    // Section 11 apply order: M57 first (must resolve existing), then P86 (canonical
    // insert/resolve), then the remaining ordinary needs_review candidates.
    const orderedItems = [
      ...items.filter((item) => item.internalCode === "M57"),
      ...items.filter((item) => item.internalCode === "P86"),
      ...items.filter((item) => item.internalCode !== "M57" && item.internalCode !== "P86" && (item.status === "exact_safe" || item.status === "skip_existing")),
    ];

    for (const item of orderedItems) {
      if (!item.internalCode || !item.catalogKind) continue; // structurally never true for exact_safe/skip_existing, defensive only
      const resolution = resolveCatalogItemForApply(
        { internalCode: item.internalCode, sourceSystem: BATCH2B_SOURCE_SYSTEM, sourceKey: item.sourceKey, kind: item.catalogKind },
        mutableExisting,
      );
      if (resolution.action === "conflict") {
        throw new CatalogItemConflictError(resolution.conflictReason!, { internalCode: item.internalCode, sourceKey: item.sourceKey, existingId: resolution.existingId! });
      }
      if (resolution.action === "noop") {
        idByRef.set(item.internalCode, resolution.existingId!);
        catalogItemsNoop += 1;
        continue;
      }
      const document = item.internalCode === "P86" ? koje2x2Document : buildBatch2bCatalogDocument(item);
      const id = await insertBatch2bCatalogItem(client, item, document);
      idByRef.set(item.internalCode, id);
      mutableExisting.push({ id, internalCode: item.internalCode, kind: item.catalogKind, sourceSystem: BATCH2B_SOURCE_SYSTEM, sourceKey: item.sourceKey });
      catalogItemsInserted += 1;
    }

    // catalog_mappings — confirmed sourceKey -> resolved catalog_item_id for the new PRICELIST
    // EXACT_SAFE inserts only (never M57 — already mapped by Batch #2A; never P86 — no
    // PRICELIST source row was ever confirmed as P86; never REVIEW/NO_MATCH).
    const plannedMappings = planBatch2bMappings(items);
    const existingMappings = await readExistingCatalogMappings(client);
    let catalogMappingsInserted = 0;
    let catalogMappingsNoop = 0;
    for (const mapping of plannedMappings) {
      const catalogItemId = idByRef.get(mapping.catalogItemRef);
      if (!catalogItemId) throw new Error(`Interní chyba: catalog_item_id pro mapping "${mapping.catalogItemRef}" nebyl resolvován — apply zastaven.`);
      const already = existingMappings.find((existingMapping) => existingMapping.sourceSystem === mapping.sourceSystem && existingMapping.sourceKey === mapping.sourceKey);
      if (already) {
        if (already.catalogItemId !== catalogItemId) {
          throw new CatalogItemConflictError(
            `catalog_mappings pro "${mapping.rawName}" (${mapping.sourceKey}) už existuje a ukazuje na jiný catalog_item_id (${already.catalogItemId}) než nově resolvovaný (${catalogItemId}) — apply zastaven.`,
            { internalCode: mapping.catalogItemRef, sourceKey: mapping.sourceKey, existingId: already.catalogItemId },
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

    const summary = {
      catalogItems: { inserted: catalogItemsInserted, noop: catalogItemsNoop },
      catalogMappings: { inserted: catalogMappingsInserted, noop: catalogMappingsNoop },
      pricingEntriesWrites: 0,
    };
    const { error: completeError } = await client.from("import_batches").update({ status: "applied", summary }).eq("id", batchId);
    if (completeError) throw completeError;

    return {
      batchId,
      catalogItems: { inserted: catalogItemsInserted, noop: catalogItemsNoop },
      catalogMappings: { inserted: catalogMappingsInserted, noop: catalogMappingsNoop },
      pricingEntriesWrites: 0,
    };
  } catch (error) {
    await client.from("import_batches").update({ status: "failed", summary: { error: error instanceof Error ? error.message : String(error) } }).eq("id", batchId);
    throw error;
  }
}
