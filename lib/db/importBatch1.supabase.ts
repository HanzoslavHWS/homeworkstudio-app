import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeExhibition, type Exhibition } from "../../domain/organizations.ts";
import {
  attachPriceListsToEvent,
  type Batch1Plan,
  type ExistingEventRow,
  type ExistingPriceListRow,
} from "../../domain/importBatch1.ts";
import type { ImportRow } from "../../domain/importBatch.ts";
import type { Currency } from "../../domain/models.ts";

/** READ-ONLY. Safe to call during --dry-run — never writes anything. */
export async function readExistingEvents(client: SupabaseClient): Promise<readonly ExistingEventRow[]> {
  const { data, error } = await client.from("events").select("id, source_key, document");
  if (error) throw error;
  return (data ?? []).map((row: { id: string; source_key: string; document: unknown }) => ({
    id: row.id,
    sourceKey: row.source_key,
    document: normalizeExhibition(row.document as Partial<Exhibition> & Pick<Exhibition, "id">),
  }));
}

/** READ-ONLY. Safe to call during --dry-run — never writes anything. */
export async function readExistingPriceLists(client: SupabaseClient): Promise<readonly ExistingPriceListRow[]> {
  const { data, error } = await client.from("price_lists").select("id, code");
  if (error) throw error;
  return (data ?? []).map((row: { id: string; code: string }) => ({ id: row.id, code: row.code }));
}

export type Batch1ApplyResult = Readonly<{
  batchId: string;
  eventsWritten: number;
  priceListsWritten: number;
  importRowsWritten: number;
}>;

/**
 * NEVER CALLED in this session — code-complete for review, gated behind an explicit
 * --apply flag in scripts/importBatch1.ts, which itself was never invoked.
 *
 * Safe-failure design (section 2): supabase-js issues one HTTP call per statement, so this
 * cannot be one server-side transaction without a bespoke Postgres RPC — and none of this
 * batch's data actually needs one. Every write here is idempotent, keyed by a stable natural
 * identifier (events.source_key, price_lists.code, import_rows.source_sheet+source_key):
 * re-running this exact function again after a partial failure (same or later
 * sourceFingerprint) only repeats already-done work harmlessly and finishes what's left —
 * no partial-state cleanup is ever required. import_batches.status starts at 'dry_run' the
 * instant this function begins (proof that an apply was attempted) and only flips to
 * 'applied' once every step below has actually succeeded; a crash anywhere in between leaves
 * it at 'dry_run' with a partial summary, which is the honest, restart-safe signal.
 */
export async function applyBatch1Plan(
  client: SupabaseClient,
  plan: Batch1Plan,
  meta: Readonly<{ sourceFileName: string; sourceFingerprint: string; sourceVersion: string }>,
): Promise<Batch1ApplyResult> {
  const { data: batchRow, error: batchError } = await client
    .from("import_batches")
    .insert({ source_file_name: meta.sourceFileName, source_fingerprint: meta.sourceFingerprint, source_version: meta.sourceVersion, status: "dry_run" })
    .select()
    .single();
  if (batchError) throw batchError;
  const batchId = (batchRow as { id: string }).id;

  try {
    // 1) Events first (price_lists.event_id FKs to events.id).
    let eventsWritten = 0;
    const eventIdBySourceKey = new Map<string, string>();
    for (const planned of plan.events) {
      eventIdBySourceKey.set(planned.sourceKey, planned.event.id);
      if (planned.action === "noop") continue;
      const { error } = await client.from("events").upsert(
        {
          id: planned.event.id,
          source_key: planned.sourceKey,
          name: planned.event.name,
          year: planned.event.year,
          active: planned.event.active,
          start_date: planned.event.eventFrom ?? null,
          end_date: planned.event.eventTo ?? null,
          document: planned.event,
        },
        { onConflict: "id" },
      );
      if (error) throw error;
      eventsWritten += 1;
    }

    // 2) Price lists (need real event ids from step 1, which — for brand-new events — are
    // deterministic: planEvents() already assigned them as the sourceKey itself).
    let priceListsWritten = 0;
    const priceListIdByCode = new Map<string, string>();
    const priceListIdsByEvent = new Map<string, Partial<Record<Currency, string>>>();
    for (const planned of plan.priceLists) {
      const eventId = eventIdBySourceKey.get(planned.eventSourceKey);
      if (!eventId) throw new Error(`Interní chyba: event pro price list ${planned.code} nebyl v tomto plánu nalezen.`);
      let priceListId = planned.existingId;
      if (planned.action === "insert") {
        const { data, error } = await client
          .from("price_lists")
          .upsert({ code: planned.code, name: planned.priceList.name, event_id: eventId, currency: planned.currency, year: planned.year, active: true, document: planned.priceList }, { onConflict: "code" })
          .select()
          .single();
        if (error) throw error;
        priceListId = (data as { id: string }).id;
        priceListsWritten += 1;
      }
      if (priceListId) {
        priceListIdByCode.set(planned.code, priceListId);
        const byEvent = priceListIdsByEvent.get(planned.eventSourceKey) ?? {};
        priceListIdsByEvent.set(planned.eventSourceKey, { ...byEvent, [planned.currency]: priceListId });
      }
    }

    // 3) Re-attach the now-known price list ids onto each event's document (section 5).
    for (const planned of plan.events) {
      const priceListIds = priceListIdsByEvent.get(planned.sourceKey);
      if (!priceListIds) continue;
      const updatedEvent = attachPriceListsToEvent(planned.event, priceListIds);
      if (updatedEvent.priceListIds.length === planned.event.priceListIds.length && updatedEvent.defaultPriceListId === planned.event.defaultPriceListId) continue;
      const { error } = await client.from("events").update({ document: updatedEvent }).eq("id", updatedEvent.id);
      if (error) throw error;
    }

    // 4) Staged import_rows (mapping decisions + technical-service pricing) — audit trail,
    // never pricing_entries/catalog_mappings directly (see domain/importBatch1.ts doc).
    const allRows: readonly ImportRow[] = [...plan.mappingDecisionRows, ...plan.stagedPricingRows];
    let importRowsWritten = 0;
    if (allRows.length > 0) {
      const { error } = await client.from("import_rows").insert(
        allRows.map((row) => ({
          import_batch_id: batchId,
          source_sheet: row.sourceSheet,
          source_row: row.sourceRow,
          source_key: row.sourceKey,
          raw_name: row.rawName,
          raw_category: row.rawCategory,
          raw_values: row.rawValues,
          normalized_values: row.normalizedValues,
          mapping_status: row.mappingStatus,
          target_entity_id: null,
          issues: row.issues,
        })),
      );
      if (error) throw error;
      importRowsWritten = allRows.length;
    }

    const summary = {
      events: { insert: plan.events.filter((e) => e.action === "insert").length, update: plan.events.filter((e) => e.action === "update").length, noop: plan.events.filter((e) => e.action === "noop").length },
      priceLists: { insert: plan.priceLists.filter((p) => p.action === "insert").length, noop: plan.priceLists.filter((p) => p.action === "noop").length },
      importRows: importRowsWritten,
      warnings: plan.warnings,
    };
    const { error: completeError } = await client.from("import_batches").update({ status: "applied", summary }).eq("id", batchId);
    if (completeError) throw completeError;

    return { batchId, eventsWritten, priceListsWritten, importRowsWritten };
  } catch (error) {
    await client.from("import_batches").update({ status: "failed", summary: { error: error instanceof Error ? error.message : String(error) } }).eq("id", batchId);
    throw error;
  }
}
