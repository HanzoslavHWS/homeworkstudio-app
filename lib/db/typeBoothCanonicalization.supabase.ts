import type { SupabaseClient } from "@supabase/supabase-js";
import type { CanonicalPlanEntry, ExistingCatalogItemRow } from "../../domain/typeBoothCanonicalization.ts";

const COLUMNS = "id, internal_code, kind, lifecycle_status, display_name, official_name, category, unit, document, created_at, updated_at";

type Row = Readonly<{
  id: string;
  internal_code: string | null;
  kind: string;
  lifecycle_status: string;
  display_name: string;
  category: string | null;
  document: unknown;
}>;

export async function readExistingTypeBoothRows(client: SupabaseClient): Promise<readonly ExistingCatalogItemRow[]> {
  const { data, error } = await client.from("catalog_items").select(COLUMNS);
  if (error) throw error;
  return ((data ?? []) as Row[]).map((row) => ({
    id: row.id,
    internalCode: row.internal_code,
    kind: row.kind,
    lifecycleStatus: row.lifecycle_status,
    displayName: row.display_name,
    category: row.category,
    document: (row.document ?? {}) as Readonly<Record<string, unknown>>,
  }));
}

/**
 * Applies ONE plan entry. CREATE races are resolved by the DB's own partial unique index on
 * internal_code (23505) — treated as a benign idempotent no-op (someone else already created it),
 * never a thrown error. UPDATE re-reads the row immediately before writing and merges the patch
 * onto whatever document is there NOW (not the possibly-stale one the plan was built from), with
 * a conditional `updated_at` compare-and-swap so a concurrent edit is never silently overwritten.
 */
export async function applyCanonicalPlanEntry(client: SupabaseClient, entry: CanonicalPlanEntry): Promise<void> {
  if (entry.action === "noop") return;

  if (entry.action === "create") {
    if (!entry.insertRow) throw new Error(`CREATE plan entry pro ${entry.internalCode} nemá insertRow.`);
    const { error } = await client.from("catalog_items").insert(entry.insertRow);
    if (error) {
      if ((error as { code?: string }).code === "23505") return;
      throw error;
    }
    return;
  }

  if (entry.action === "update") {
    if (!entry.targetId || !entry.documentPatch) throw new Error(`UPDATE plan entry pro ${entry.internalCode} nemá targetId/documentPatch.`);
    const { data: currentRow, error: readError } = await client
      .from("catalog_items")
      .select("document, updated_at")
      .eq("id", entry.targetId)
      .maybeSingle();
    if (readError) throw readError;
    if (!currentRow) throw new Error(`catalog_items řádek ${entry.targetId} (${entry.internalCode}) zmizel mezi plánováním a aplikací.`);
    const nextDocument = { ...((currentRow as { document: Record<string, unknown> | null }).document ?? {}), ...entry.documentPatch };
    const { error: updateError, data: updated } = await client
      .from("catalog_items")
      .update({ document: nextDocument })
      .eq("id", entry.targetId)
      .eq("updated_at", (currentRow as { updated_at: string }).updated_at)
      .select("id");
    if (updateError) throw updateError;
    if (!updated || updated.length === 0) {
      throw new Error(`Concurrency conflikt při aktualizaci ${entry.internalCode} (id=${entry.targetId}) — řádek byl mezitím změněn jinde.`);
    }
    return;
  }
}
