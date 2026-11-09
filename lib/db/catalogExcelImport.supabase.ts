import type { SupabaseClient } from "@supabase/supabase-js";
import { assertScriptDatabaseClient } from "./scriptSupabase.server.ts";
import { createCatalogItemAdmin, saveCatalogItemAdmin } from "./catalogItemsAdmin.supabase.ts";
import { parseCatalogItemAdminCreateInput, parseCatalogItemAdminEdit } from "../../domain/catalogItemsAdmin.ts";
import type { CatalogImportPlan, CatalogRowPlan } from "../../domain/catalogExcelImport.ts";

type RowRef = Readonly<{ sheet: string; rowNumber: number; label: string }>;
export type CatalogExcelImportWrite = RowRef & Readonly<{ action: "create" | "update"; itemId: string; lifecycleStatus: string }>;
export type CatalogExcelImportApplyResult = Readonly<{
  written: readonly CatalogExcelImportWrite[];
  /** The first row that failed — nothing after it was attempted. */
  failed?: RowRef & Readonly<{ message: string }>;
  /** Rows of the plan with a change that were NOT written (the failed one and everything after it). */
  notWritten: readonly RowRef[];
}>;

/** Per-row progress (the admin UI stores it after every row, so a run can be re-read after a lost connection). */
export type CatalogImportRowOutcome = RowRef & Readonly<{ action: "create" | "update"; status: "written" | "failed" | "not_attempted"; itemId?: string; message?: string }>;

/**
 * Catalog Excel import writer (domain/catalogExcelImport.ts plan, sheets Produkty + Sluzby) — the
 * ONE write path of the CLI and of the admin UI. Refuses a plan with any conflict or workbook error.
 * Every row goes through the same admin paths as the rest of the app:
 *   - create = ONE insert (createCatalogItemAdmin) — dimensions, attributes, swatch book, agreement,
 *     power and publication are all part of it, so a failure never leaves a half-created card;
 *     always "K doplnění";
 *   - update = saveCatalogItemAdmin with the updated_at read for the plan — a card changed since
 *     then is a ConcurrencyConflictError, never overwritten.
 * Atomic per card, not per batch: stops at the first failure and reports what was and was not
 * written. Files, prices, price lists and attachments are never touched.
 */
export async function writeCatalogImportPlan(client: SupabaseClient, plan: CatalogImportPlan, onProgress?: (outcomes: readonly CatalogImportRowOutcome[]) => Promise<void>): Promise<CatalogExcelImportApplyResult> {
  if (plan.summary.conflict > 0 || plan.issues.some((issue) => issue.severity === "error")) {
    throw new Error("Plán obsahuje konflikty nebo chyby sešitu — nic se nezapisuje.");
  }
  const changeRows = plan.rows.filter((row): row is CatalogRowPlan & { action: "create" | "update" } => row.action === "create" || row.action === "update");
  const outcomes: CatalogImportRowOutcome[] = changeRows.map((row) => ({ sheet: row.sheet, rowNumber: row.rowNumber, label: row.label, action: row.action, status: "not_attempted" }));
  const written: CatalogExcelImportWrite[] = [];
  for (const [index, row] of changeRows.entries()) {
    const ref = { sheet: row.sheet, rowNumber: row.rowNumber, label: row.label };
    try {
      if (row.action === "create") {
        const created = await createCatalogItemAdmin(client, parseCatalogItemAdminCreateInput(row.createInput));
        written.push({ ...ref, action: "create", itemId: created.id, lifecycleStatus: created.lifecycleStatus });
        outcomes[index] = { ...outcomes[index]!, status: "written", itemId: created.id };
      } else {
        if (!row.itemId || !row.edit || !row.expectedUpdatedAt) throw new Error("Aktualizace bez karty, úpravy nebo updated_at — plán je neúplný.");
        const saved = await saveCatalogItemAdmin(client, row.itemId, parseCatalogItemAdminEdit(row.edit), row.expectedUpdatedAt);
        written.push({ ...ref, action: "update", itemId: saved.id, lifecycleStatus: saved.lifecycleStatus });
        outcomes[index] = { ...outcomes[index]!, status: "written", itemId: saved.id };
      }
      if (onProgress) await onProgress(outcomes);
    } catch (error) {
      const message = error instanceof Error ? (error.name === "ConcurrencyConflictError" ? "Karta byla mezitím změněna jinde (updated_at) — nic se nepřepsalo." : `${error.name}: ${error.message}`) : String(error);
      outcomes[index] = { ...outcomes[index]!, status: "failed", message };
      if (onProgress) await onProgress(outcomes).catch(() => undefined);
      const notWritten = changeRows.slice(index).map((entry) => ({ sheet: entry.sheet, rowNumber: entry.rowNumber, label: entry.label }));
      return { written, failed: { ...ref, message }, notWritten };
    }
  }
  return { written, notWritten: [] };
}

/** CLI writer (scripts/catalogExcelImport.ts): only with the DEV-checked script client. */
export async function applyCatalogExcelImportPlan(client: SupabaseClient, plan: CatalogImportPlan): Promise<CatalogExcelImportApplyResult> {
  assertScriptDatabaseClient(client);
  return writeCatalogImportPlan(client, plan);
}
