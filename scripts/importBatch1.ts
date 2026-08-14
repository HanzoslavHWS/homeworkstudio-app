/**
 * Import Batch #1: Events + PriceLists + staged pricing/mapping decisions.
 *
 * Modes:
 *   node scripts/importBatch1.ts [path-to-xlsm]              -> dry-run (DEFAULT, zero writes)
 *   node scripts/importBatch1.ts [path-to-xlsm] --apply       -> real writes (requires Supabase env)
 *
 * Without --apply this NEVER calls applyBatch1Plan — only reads (workbook + optionally the
 * remote DB, read-only) and prints/writes a plan. Catalog items (PRICELIST candidates,
 * furniture/booths/M57/L02/P86) are OUT OF SCOPE for this batch — see domain/importBatch1.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { componentCatalogItems } from "../data/components.ts";
import { buildImportPreview, fingerprintBytes } from "../domain/importBatch.ts";
import { buildBatch1Plan, summarizeBatch1Plan, type MappingDecision } from "../domain/importBatch1.ts";
import { extractSheetGrid, readWorkbookSheets } from "../lib/import/xlsxReader.server.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../lib/db/supabase.server.ts";
import { readExistingEvents, readExistingPriceLists, applyBatch1Plan } from "../lib/db/importBatch1.supabase.ts";

function detectSourceVersion(fileName: string): string {
  const match = /V(\d+\.\d+)/iu.exec(fileName);
  return match ? `V${match[1]}` : fileName;
}

/**
 * Human-confirmed decisions for THIS import (from the prior read-only preview session).
 * Batch-specific, deliberately not baked into domain/importBatch.ts — these are facts about
 * V6.6, not generic reusable logic.
 */
const BATCH1_MAPPING_DECISIONS: readonly MappingDecision[] = [
  { identity: { sourceSheet: "PRICELIST", category: "Nábytek", rawName: "Židle čalouněná" }, decision: "confirmed", targetInternalCode: "M57" },
  { identity: { sourceSheet: "PRICELIST", category: "T. služby", rawName: "Přípojka el. energie - 2kW" }, decision: "confirmed", targetInternalCode: "L02" },
  {
    identity: { sourceSheet: "PRICELIST", category: "Kuchyňka", rawName: "Rychlovarná konvice příkon 2 kW" },
    decision: "rejected",
    targetInternalCode: "L02",
    reason: 'Shoda jen přes shared_spec_token ("2 kW") — žádná skutečná shoda, potvrzeno člověkem jako false-positive.',
  },
];

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const filePath = args.find((arg) => !arg.startsWith("--")) ?? path.resolve(process.cwd(), "private-imports", "Ultimátní kalkulace V6.6.xlsm");

  const bytes = readFileSync(filePath);
  const fingerprint = fingerprintBytes(new Uint8Array(bytes));
  const fileName = filePath.split(/[\\/]/u).pop() ?? filePath;
  const sourceVersion = detectSourceVersion(fileName);

  const workbook = await readWorkbookSheets(filePath);
  const sheets = {
    pricelist: extractSheetGrid(workbook, "PRICELIST"),
    dataSheet: extractSheetGrid(workbook, "data sheet"),
    czk: extractSheetGrid(workbook, "CZK"),
    eur: extractSheetGrid(workbook, "EUR"),
    naklad: extractSheetGrid(workbook, "náklad"),
  };
  const preview = buildImportPreview(sheets, componentCatalogItems);

  console.log("=== IMPORT BATCH #1 —", apply ? "APPLY MODE" : "DRY-RUN (default, zero writes)", "===");
  console.log("sourceFileName:", fileName);
  console.log("sourceFingerprint:", fingerprint);
  console.log("sourceVersion:", sourceVersion);
  console.log();

  // Reading current DB state is a SELECT — read-only, safe in both modes. If Supabase isn't
  // reachable/configured, fall back to "nothing exists yet" and say so explicitly rather than
  // silently guessing.
  let existingEvents: Awaited<ReturnType<typeof readExistingEvents>> = [];
  let existingPriceLists: Awaited<ReturnType<typeof readExistingPriceLists>> = [];
  let dbStateSource = "unavailable (Supabase not reachable/configured) — treating as empty, all rows classified as insert";
  try {
    const client = createSupabaseServerClient();
    [existingEvents, existingPriceLists] = await Promise.all([readExistingEvents(client), readExistingPriceLists(client)]);
    dbStateSource = `read live from Supabase (read-only SELECT): ${existingEvents.length} existing events, ${existingPriceLists.length} existing price lists`;
  } catch (error) {
    if (!(error instanceof SupabaseConfigurationError)) console.error("Warning: could not read existing DB state:", error instanceof Error ? error.message : error);
  }
  console.log("existing DB state:", dbStateSource);
  console.log();

  const batchIdPlaceholder = `pending-${fingerprint}`;
  const plan = buildBatch1Plan(batchIdPlaceholder, preview, existingEvents, existingPriceLists, BATCH1_MAPPING_DECISIONS);
  const summary = summarizeBatch1Plan(plan, apply ? "apply" : "dry-run");

  console.log("=== EVENTS ===");
  console.log(`insert: ${summary.events.insert}  update: ${summary.events.update}  noop: ${summary.events.noop}  needsReview: ${summary.events.needsReview}`);
  for (const event of plan.events) {
    console.log(`- ${event.sourceKey.padEnd(10)} ${event.action.padEnd(6)}${event.needsReview ? "  [NEEDS REVIEW] " + event.reviewReason : ""}`);
  }
  console.log();

  console.log("=== PRICE LISTS ===");
  console.log(`insert: ${summary.priceLists.insert}  noop: ${summary.priceLists.noop}`);
  for (const priceList of plan.priceLists) console.log(`- ${priceList.code.padEnd(20)} ${priceList.action}`);
  console.log();

  console.log("=== PRICING ENTRIES ===");
  console.log(`insert: ${summary.pricingEntries.insert}  update: ${summary.pricingEntries.update}  noop: ${summary.pricingEntries.noop}  missing/skipped: ${summary.pricingEntries.missingSkipped}  staged-only (import_rows, not pricing_entries): ${summary.pricingEntries.stagedOnly}`);
  console.log("BLOCKER:", plan.warnings.find((w) => w.includes("catalog_item identita")));
  console.log();

  console.log("=== MAPPINGS ===");
  console.log(`confirmed: ${summary.mappings.confirmed}  rejected: ${summary.mappings.rejected}  untouched: ${summary.mappings.untouched}`);
  for (const row of plan.mappingDecisionRows) console.log(`- "${row.rawName}" -> ${JSON.stringify(row.normalizedValues)} [${row.mappingStatus}]${row.sourceRow === -1 ? "  (WARNING: no matching PRICELIST row found)" : ""}`);
  console.log();

  console.log("=== IMPORT_ROWS TO BE STAGED ===");
  console.log("total:", plan.mappingDecisionRows.length + plan.stagedPricingRows.length, `(${plan.mappingDecisionRows.length} mapping decisions + ${plan.stagedPricingRows.length} technical-service pricing rows [23 CZK + 23 EUR])`);
  console.log();

  console.log("=== DATABASE WRITES ===");
  console.log(apply ? "APPLY MODE — see below for actual write result." : "0 (dry-run — nothing was written)");
  console.log();

  const outputPath = path.resolve(process.cwd(), "private-imports", "import-batch1-plan.json");
  writeFileSync(outputPath, JSON.stringify({ fileName, fingerprint, sourceVersion, mode: apply ? "apply" : "dry-run", dbStateSource, summary, plan }, null, 2), "utf8");
  console.log("Plan written to:", outputPath);

  if (!apply) {
    console.log();
    console.log("Dry-run complete. Re-run with --apply to write for real (requires SUPABASE_URL/SUPABASE_SECRET_KEY).");
    return;
  }

  console.log();
  console.log("=== APPLYING ===");
  const client = createSupabaseServerClient();
  const result = await applyBatch1Plan(client, plan, { sourceFileName: fileName, sourceFingerprint: fingerprint, sourceVersion });
  console.log("import_batches id:", result.batchId);
  console.log("events written:", result.eventsWritten);
  console.log("price lists written:", result.priceListsWritten);
  console.log("import_rows written:", result.importRowsWritten);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
