/**
 * Import Batch #2B — catalog identity import (56 new EXACT_SAFE non-technical PRICELIST
 * identities + canonical P86). No pricing_entries writes, ever — see domain/importBatch2b.ts.
 *
 *   node scripts/importBatch2b.ts              -> dry-run (DEFAULT, zero writes)
 *   node scripts/importBatch2b.ts --dry-run     -> same, explicit
 *   node scripts/importBatch2b.ts --apply       -> real writes (requires Supabase env) — NOT
 *                                                   invoked this session.
 *
 * Source of truth: private-imports/code-matching-report.json (identity/status per PRICELIST
 * row) + private-imports/import-preview-v6.6.json (base sale/purchase pricing per sourceRow,
 * attached into the new catalog_item's own document.pricingEntries — never a new event-level
 * pricing_entries row). Reuses Batch #2A's identity/read/error primitives
 * (lib/db/importBatch2a.supabase.ts, domain/importBatch2a.ts) rather than reimplementing them.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { boothTypes } from "../data/booths.ts";
import { fingerprintBytes } from "../domain/importBatch.ts";
import { createSupabaseServerClient } from "../lib/db/supabase.server.ts";
import { readExistingCatalogMappings } from "../lib/db/importBatch2a.supabase.ts";
import { applyBatch2bPlan, readExistingCatalogItemsSafely, TransientReadError } from "../lib/db/importBatch2b.supabase.ts";
import {
  attachBasePricing,
  categoryGroupFor,
  isBatch2bEligibleRow,
  planBatch2bMappings,
  planP86Canonical,
  planPricelistItems,
  previewBatch2bApply,
  runBatch2bPreflight,
  simulatePostApplyExistingItems,
  summarizeByCategoryGroup,
  type Batch2bPlanItem,
  type Batch2bSourceRow,
  type SourceBasePricing,
} from "../domain/importBatch2b.ts";

const REPORT_PATH = path.resolve(process.cwd(), "private-imports", "code-matching-report.json");
const BASE_PRICING_PATH = path.resolve(process.cwd(), "private-imports", "import-preview-v6.6.json");
const PLAN_OUTPUT_PATH = path.resolve(process.cwd(), "private-imports", "import-batch2b-plan.json");

type CodeMatchingReport = Readonly<{
  counts: Readonly<{ pricelist: Readonly<{ total: number; EXACT_SAFE: number; REVIEW: number; NO_MATCH: number }> }>;
  pricelist: readonly Readonly<{
    sourceRow: number;
    category: string;
    nameCz: string;
    nameEn?: string;
    currentInternalCode: string | null;
    unit: string | null;
    assessment: Readonly<{
      status: "EXACT_SAFE" | "REVIEW" | "NO_MATCH";
      proposedCode: string | null;
      proposedName: string | null;
      proposedForeignName: string | null;
      proposedUnit: string | null;
    }>;
  }>[];
}>;

function loadReport(): CodeMatchingReport {
  return JSON.parse(readFileSync(REPORT_PATH, "utf8")) as CodeMatchingReport;
}

function loadBasePricingByRow(): ReadonlyMap<number, SourceBasePricing> {
  const raw = JSON.parse(readFileSync(BASE_PRICING_PATH, "utf8")) as { catalog: { rows: readonly Readonly<{ sourceRow: number; saleCzk: number | null; saleEur: number | null; purchaseCzk: number | null }>[] } };
  const map = new Map<number, SourceBasePricing>();
  for (const row of raw.catalog.rows) map.set(row.sourceRow, row);
  return map;
}

function toBatch2bSourceRow(row: CodeMatchingReport["pricelist"][number]): Batch2bSourceRow {
  return {
    sourceRow: row.sourceRow,
    category: row.category,
    nameCz: row.nameCz,
    nameEn: row.nameEn,
    currentInternalCode: row.currentInternalCode,
    unit: row.unit,
    status: row.assessment.status,
    proposedCode: row.assessment.proposedCode,
    proposedName: row.assessment.proposedName,
    proposedForeignName: row.assessment.proposedForeignName,
    proposedUnit: row.assessment.proposedUnit,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  console.log(`=== BATCH #2B — ${apply ? "APPLY" : "DRY-RUN"} (source: code-matching-report.json + import-preview-v6.6.json) ===\n`);

  const report = loadReport();
  const basePricingByRow = loadBasePricingByRow();
  const reportBytes = readFileSync(REPORT_PATH);
  const fingerprint = fingerprintBytes(new Uint8Array(reportBytes));

  const client = createSupabaseServerClient();

  // Section 13: transient-read guard — two reads, compare, STOP (never plan/write) on mismatch.
  let existingCatalogItems;
  try {
    existingCatalogItems = await readExistingCatalogItemsSafely(client);
  } catch (error) {
    if (error instanceof TransientReadError) {
      console.error(`STOP: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  const existingMappings = await readExistingCatalogMappings(client);

  console.log(`Remote DB (read-only, double-read verified): ${existingCatalogItems.length} existující catalog_items, ${existingMappings.length} existující catalog_mappings.`);

  const allRows = report.pricelist.map(toBatch2bSourceRow);
  const eligibleRows = allRows.filter(isBatch2bEligibleRow);
  const technicalServiceRows = allRows.filter((row) => !isBatch2bEligibleRow(row));

  console.log(`\n=== SOURCE SET (section 2) ===`);
  console.log(`PRICELIST total (report): ${report.counts.pricelist.total}`);
  console.log(`EXACT_SAFE total (report): ${report.counts.pricelist.EXACT_SAFE}`);
  console.log(`REVIEW total (report): ${report.counts.pricelist.REVIEW}`);
  console.log(`NO_MATCH total (report): ${report.counts.pricelist.NO_MATCH}`);
  console.log(`Již pokryto Batch #2A (category="T. služby"): ${technicalServiceRows.length}`);
  console.log(`Eligible pro Batch #2B (non-technical-service): ${eligibleRows.length}`);

  const pricelistPlanRaw = planPricelistItems(eligibleRows, existingCatalogItems);
  const pricelistPlan = attachBasePricing(pricelistPlanRaw, basePricingByRow);
  const koje2x2 = boothTypes.find((booth) => booth.internalCode === "P86");
  if (!koje2x2) throw new Error("P86 (koje-2x2) seed nenalezen v data/booths.ts — Batch #2B na něm závisí pro canonical případ.");
  const p86Plan = planP86Canonical(koje2x2, existingCatalogItems);
  const allPlanItems: readonly Batch2bPlanItem[] = [...pricelistPlan, p86Plan];

  // -----------------------------------------------------------------------------------------
  // PREFLIGHT (section 12) — STOP before any write on the first violation.
  // -----------------------------------------------------------------------------------------
  const preflight = runBatch2bPreflight(allPlanItems, existingCatalogItems);
  console.log(`\n=== PREFLIGHT ===`);
  console.log(preflight.ok ? "OK — no blocking issues found." : `BLOCKED — ${preflight.issues.length} issue(s):`);
  for (const issue of preflight.issues) console.log(`  - [${issue.code}] ${issue.message}`);

  console.log(`\n=== CATEGORY REPORT (section 18) ===`);
  for (const summary of summarizeByCategoryGroup(allPlanItems)) {
    console.log(`- ${summary.group}: source=${summary.sourceCount} exactSafe=${summary.exactSafeCount} plannedInserts=${summary.plannedInserts} existingNoop=${summary.existingNoop} needsReview=${summary.needsReview} generatorEligible=${summary.generatorEligible} missingDimensions=${summary.missingDimensions} missingAssets=${summary.missingAssets}`);
  }

  console.log(`\n=== TYPOVÉ STÁNKY Txx ===`);
  for (const item of allPlanItems.filter((entry) => categoryGroupFor(entry) === "Booths / Txx")) {
    console.log(`- ${item.internalCode}: "${item.sourceName}" dims=${item.dimensions ? `${item.dimensions.widthMm}x${item.dimensions.depthMm}mm` : "?"} lifecycle=${item.lifecycleStatus} generatorEligible=${item.generatorEligible} action=${item.action}`);
  }

  console.log(`\n=== P86 ===`);
  console.log(`internalCode=${p86Plan.internalCode} action=${p86Plan.action} lifecycle=${p86Plan.lifecycleStatus} generatorEligible=${p86Plan.generatorEligible} assetStatus=${p86Plan.assetStatus}`);

  // -----------------------------------------------------------------------------------------
  // LIVE DRY-RUN PREVIEW — real remote DB state, same resolveCatalogItemForApply the writer uses.
  // -----------------------------------------------------------------------------------------
  const preview = previewBatch2bApply(allPlanItems, existingCatalogItems, existingMappings);
  console.log(`\n=== LIVE APPLY PREVIEW (section 17, real remote DB state) ===`);
  console.log(`catalog_items:    insert=${preview.catalogItems.insert}  noop=${preview.catalogItems.noop}  conflicts=${preview.catalogItems.conflicts}`);
  console.log(`catalog_mappings: insert=${preview.catalogMappings.insert}  noop=${preview.catalogMappings.noop}`);
  console.log(`pricing_entries:  insert=0  update=0  untouched=495 (this writer never touches pricing_entries)`);
  console.log(`R2: 0 writes`);
  if (preview.conflictDetails.length > 0) {
    console.log("CONFLICTS:");
    for (const conflict of preview.conflictDetails) console.log(`  - ${conflict.internalCode}: ${conflict.reason}`);
  }

  // -----------------------------------------------------------------------------------------
  // IDEMPOTENCY SIMULATION (section 15) — simulate a first apply's resulting DB state, then
  // preview a SECOND apply against that simulated state. No real write happens for this.
  // -----------------------------------------------------------------------------------------
  const simulatedPostFirstApply = simulatePostApplyExistingItems(allPlanItems, existingCatalogItems);
  const secondPreview = previewBatch2bApply(allPlanItems, simulatedPostFirstApply, existingMappings);
  console.log(`\n=== IDEMPOTENCY SIMULATION (section 15/16) ===`);
  console.log(`FIRST apply (preview):  insert=${preview.catalogItems.insert} noop=${preview.catalogItems.noop} conflicts=${preview.catalogItems.conflicts}`);
  console.log(`SECOND apply (simulated, no real write): insert=${secondPreview.catalogItems.insert} noop=${secondPreview.catalogItems.noop} conflicts=${secondPreview.catalogItems.conflicts}`);
  if (secondPreview.catalogItems.insert !== 0) {
    console.log("WARNING: druhý simulovaný apply navrhuje insert > 0 — idempotence není zaručena, zastavte se před skutečným apply.");
  }

  // -----------------------------------------------------------------------------------------
  // BASE PRICING COVERAGE (section 9 — informational; catalog document only, never pricing_entries)
  // -----------------------------------------------------------------------------------------
  const insertOrExisting = allPlanItems.filter((item) => item.status === "exact_safe" || item.status === "skip_existing");
  const withBasePricing = insertOrExisting.filter((item) => item.basePricing).length;
  const withoutBasePricing = insertOrExisting.length - withBasePricing;
  console.log(`\n=== BASE PRICING (section 9 — do catalog_item.document.pricingEntries, NIKDY nové pricing_entries řádky) ===`);
  console.log(`Položek s dostupnou base cenou (bude v document.pricingEntries): ${withBasePricing}`);
  console.log(`Položek bez base ceny ve zdroji: ${withoutBasePricing}`);
  console.log(`Event-level pricing_entries: 0 nových — 264 CZK + 231 EUR = 495 zůstává nedotčeno (Batch #2A, technické služby jsou jediná položka s per-event cenami v tomto workbooku).`);

  const plannedMappings = planBatch2bMappings(allPlanItems);
  console.log(`\nPlanned catalog_mappings (confirmed): ${plannedMappings.length} (M57 už mapován Batch #2A — noop; P86 bez PRICELIST source row — žádný nový mapping).`);

  writeFileSync(PLAN_OUTPUT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), source: "private-imports/code-matching-report.json", items: allPlanItems, plannedMappings, preflight, preview }, null, 2), "utf8");
  console.log(`\nPlan written to: ${PLAN_OUTPUT_PATH}`);

  if (!apply) {
    console.log("\n=== DATABASE WRITES: 0 (dry-run, read-only) ===");
    console.log("=== R2 WRITES: 0 ===");
    console.log("=== BATCH #2B APPLY: NE ===");
    console.log("\nRe-run with --apply to write for real (requires SUPABASE_URL/SUPABASE_SECRET_KEY, and a clean preflight).");
    return;
  }

  if (!preflight.ok) {
    console.error("\nSTOP: preflight selhal, --apply se nespustí.");
    process.exitCode = 1;
    return;
  }

  console.log("\n=== APPLYING ===");
  const result = await applyBatch2bPlan(client, allPlanItems, koje2x2, { sourceFileName: "code-matching-report.json", sourceFingerprint: fingerprint, sourceVersion: "V6.6" });
  console.log("import_batches id:", result.batchId);
  console.log("catalog_items:", JSON.stringify(result.catalogItems));
  console.log("catalog_mappings:", JSON.stringify(result.catalogMappings));
  console.log("pricing_entries writes:", result.pricingEntriesWrites);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
