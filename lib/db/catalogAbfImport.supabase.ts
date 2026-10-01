import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildAbfImportInsert,
  buildAbfImportUpdatePatch,
  planAbfImport,
  type AbfImportExistingItem,
  type AbfImportPlan,
  type KodyRow,
} from "../../domain/catalogAbfImport.ts";
import { abfCodeOf, itemTypeOf } from "../../domain/catalogItemsAdmin.ts";
import { CatalogSchemaNotMigratedError, readCatalogItemsAdmin } from "./catalogItemsAdmin.supabase.ts";

export type AbfImportApplyResult = Readonly<{
  plan: AbfImportPlan;
  batchId: string | null;
  created: number;
  updated: number;
  /** Rows whose card changed between preview and apply (optimistic check on updated_at) — skipped, never overwritten. */
  staleSkipped: readonly Readonly<{ sourceRow: number; abfCode: string }>[];
  failed: readonly Readonly<{ sourceRow: number; abfCode: string; message: string }>[];
}>;

/** True once the 20261001120000 migration is applied (abf_code + item_type exist). */
export async function catalogAbfSchemaAvailable(client: SupabaseClient): Promise<boolean> {
  const { error } = await client.from("catalog_items").select("id, abf_code, item_type").limit(1);
  if (!error) return true;
  const code = (error as { code?: string }).code;
  if (code === "42703" || code === "PGRST204") return false;
  throw error;
}

export async function readAbfImportExistingItems(client: SupabaseClient): Promise<readonly AbfImportExistingItem[]> {
  const items = await readCatalogItemsAdmin(client);
  return items.map((item) => ({
    id: item.id,
    internalCode: item.internalCode,
    abfCode: abfCodeOf(item),
    displayName: item.displayName,
    officialName: item.officialName,
    unit: item.unit,
    kind: item.kind,
    itemType: itemTypeOf(item),
    lifecycleStatus: item.lifecycleStatus,
    document: item.document,
    updatedAt: item.updatedAt,
  }));
}

/** Preview — read-only, never writes anything. */
export async function previewAbfImport(
  client: SupabaseClient,
  rows: readonly KodyRow[],
  sourceFile: string,
  linkConfirmations: Readonly<Record<string, string>> = {},
): Promise<Readonly<{ plan: AbfImportPlan; schemaReady: boolean }>> {
  const [existing, schemaReady] = await Promise.all([readAbfImportExistingItems(client), catalogAbfSchemaAvailable(client)]);
  return { plan: planAbfImport(rows, existing, sourceFile, linkConfirmations), schemaReady };
}

/**
 * Apply — re-plans against the CURRENT catalog (never trusts a client-sent plan), then writes
 * creates/updates row by row. Each update is guarded by the card's updated_at from this read,
 * so a card edited in the admin between read and write is skipped, not overwritten. Conflicts
 * and rows without an ABF code are never written. Nothing is ever archived or deleted.
 */
export async function applyAbfImport(
  client: SupabaseClient,
  rows: readonly KodyRow[],
  sourceFile: string,
  fingerprint: string,
  linkConfirmations: Readonly<Record<string, string>> = {},
  now: () => string = () => new Date().toISOString(),
): Promise<AbfImportApplyResult> {
  if (!(await catalogAbfSchemaAvailable(client))) throw new CatalogSchemaNotMigratedError();
  const existing = await readAbfImportExistingItems(client);
  const plan = planAbfImport(rows, existing, sourceFile, linkConfirmations);
  const importedAt = now();
  const byId = new Map(existing.map((item) => [item.id, item]));

  const { data: batch, error: batchError } = await client
    .from("import_batches")
    .insert({ source_file_name: sourceFile, source_fingerprint: fingerprint, source_version: "kody-abf", status: "dry_run", summary: plan.summary })
    .select("id")
    .single();
  if (batchError) throw batchError;
  const batchId = (batch as { id: string } | null)?.id ?? null;

  let created = 0;
  let updated = 0;
  const staleSkipped: { sourceRow: number; abfCode: string }[] = [];
  const failed: { sourceRow: number; abfCode: string; message: string }[] = [];

  for (const planRow of plan.rows) {
    if (planRow.action === "create") {
      const { error } = await client.from("catalog_items").insert(buildAbfImportInsert(planRow, sourceFile, importedAt));
      if (error) failed.push({ sourceRow: planRow.row.sourceRow, abfCode: planRow.abfCode, message: (error as { message?: string }).message ?? "Vložení selhalo." });
      else created++;
    } else if (planRow.action === "update") {
      const current = byId.get(planRow.itemId)!;
      const patch = buildAbfImportUpdatePatch(planRow, current.document, sourceFile, importedAt);
      const { data, error } = await client.from("catalog_items").update(patch).eq("id", current.id).eq("updated_at", current.updatedAt).select("id");
      if (error) failed.push({ sourceRow: planRow.row.sourceRow, abfCode: planRow.abfCode, message: (error as { message?: string }).message ?? "Aktualizace selhala." });
      else if (!data || (data as unknown[]).length === 0) staleSkipped.push({ sourceRow: planRow.row.sourceRow, abfCode: planRow.abfCode });
      else updated++;
    }
  }

  const summary = { ...plan.summary, applied: { created, updated, staleSkipped: staleSkipped.length, failed: failed.length } };
  if (batchId) {
    await client.from("import_batches").update({ status: failed.length > 0 ? "failed" : "applied", summary }).eq("id", batchId);
  }
  return { plan, batchId, created, updated, staleSkipped, failed };
}
