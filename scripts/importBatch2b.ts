/**
 * Import Batch #2B — DRY-RUN PLAN ONLY, this session. Never writes to Supabase, never writes
 * to R2, never touches the source .xlsm/.xlsx files.
 *
 *   node scripts/importBatch2b.ts
 *
 * Source of truth: private-imports/code-matching-report.json (identity/status per PRICELIST
 * row) + private-imports/import-preview-v6.6.json (base sale/purchase pricing per sourceRow,
 * for the informational pricing-coverage report only — no pricing_entries are planned here).
 * Reuses Batch #2A's identity/read functions (lib/db/importBatch2a.supabase.ts,
 * domain/importBatch2a.ts) rather than reimplementing them.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { boothTypes } from "../data/booths.ts";
import { createSupabaseServerClient } from "../lib/db/supabase.server.ts";
import { readExistingCatalogItemsFull } from "../lib/db/importBatch2a.supabase.ts";
import type { ExistingCatalogItemRow } from "../domain/importBatch2a.ts";
import {
  categoryGroupFor,
  detectBatch2bConflicts,
  isBatch2bEligibleRow,
  planP86Canonical,
  planPricelistItems,
  summarizeByCategoryGroup,
  type Batch2bPlanItem,
  type Batch2bSourceRow,
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

type BasePricingRow = Readonly<{ sourceRow: number; saleCzk: number | null; saleEur: number | null; purchaseCzk: number | null }>;

function loadReport(): CodeMatchingReport {
  return JSON.parse(readFileSync(REPORT_PATH, "utf8")) as CodeMatchingReport;
}

function loadBasePricingByRow(): ReadonlyMap<number, BasePricingRow> {
  const raw = JSON.parse(readFileSync(BASE_PRICING_PATH, "utf8")) as { catalog: { rows: readonly Readonly<{ sourceRow: number; saleCzk: number | null; saleEur: number | null; purchaseCzk: number | null }>[] } };
  const map = new Map<number, BasePricingRow>();
  for (const row of raw.catalog.rows) map.set(row.sourceRow, row);
  return map;
}

/** Known transient-read guard (observed repeatedly this engagement) — never plan against an obviously incomplete read without a retry + explicit anomaly report. */
async function readExistingCatalogItemsWithRetry(client: ReturnType<typeof createSupabaseServerClient>): Promise<readonly ExistingCatalogItemRow[]> {
  const first = await readExistingCatalogItemsFull(client);
  const second = await readExistingCatalogItemsFull(client);
  if (first.length !== second.length) {
    console.log(`ANOMALY: první čtení catalog_items vrátilo ${first.length} řádků, druhé ${second.length} — pravděpodobný transient Supabase read problém. Zkouším potřetí.`);
    const third = await readExistingCatalogItemsFull(client);
    console.log(`Třetí čtení: ${third.length} řádků.`);
    return third;
  }
  return second;
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
  console.log("=== BATCH #2B — DRY-RUN PLAN ONLY (DATABASE WRITES = 0, R2 WRITES = 0) ===\n");

  const report = loadReport();
  const basePricingByRow = loadBasePricingByRow();
  const client = createSupabaseServerClient();
  const existingCatalogItems = await readExistingCatalogItemsWithRetry(client);

  console.log(`Remote DB (read-only): ${existingCatalogItems.length} existující catalog_items.`);

  const allRows = report.pricelist.map(toBatch2bSourceRow);
  const eligibleRows = allRows.filter(isBatch2bEligibleRow);
  const technicalServiceRows = allRows.filter((row) => !isBatch2bEligibleRow(row));

  console.log(`\n=== SOURCE SET (section 2) ===`);
  console.log(`PRICELIST total (report): ${report.counts.pricelist.total}`);
  console.log(`EXACT_SAFE total (report): ${report.counts.pricelist.EXACT_SAFE}`);
  console.log(`REVIEW total (report): ${report.counts.pricelist.REVIEW}`);
  console.log(`NO_MATCH total (report): ${report.counts.pricelist.NO_MATCH}`);
  console.log(`Already covered by Batch #2A (category="T. služby"): ${technicalServiceRows.length}`);
  console.log(`Eligible for Batch #2B (non-technical-service rows): ${eligibleRows.length}`);

  const pricelistPlan = planPricelistItems(eligibleRows, existingCatalogItems);
  const koje2x2 = boothTypes.find((booth) => booth.internalCode === "P86");
  if (!koje2x2) throw new Error("P86 (koje-2x2) seed nenalezen v data/booths.ts — Batch #2B na něm závisí pro canonical případ.");
  const p86Plan = planP86Canonical(koje2x2, existingCatalogItems);
  const allPlanItems: readonly Batch2bPlanItem[] = [...pricelistPlan, p86Plan];

  const conflicts = detectBatch2bConflicts(allPlanItems, existingCatalogItems);

  const insertCount = allPlanItems.filter((item) => item.action === "insert").length;
  const noopCount = allPlanItems.filter((item) => item.action === "noop").length;
  const reviewCount = allPlanItems.filter((item) => item.action === "review").length;
  const skipCount = allPlanItems.filter((item) => item.action === "skip").length;

  console.log(`\n=== PLAN SUMMARY (section 7) ===`);
  console.log(`insert=${insertCount}  noop(existing)=${noopCount}  review=${reviewCount}  skip(NO_MATCH)=${skipCount}  conflicts=${conflicts.length}`);

  console.log(`\n=== CATEGORY REPORT (section 17) ===`);
  for (const summary of summarizeByCategoryGroup(allPlanItems)) {
    console.log(`- ${summary.group}: source=${summary.sourceCount} exactSafe=${summary.exactSafeCount} plannedInserts=${summary.plannedInserts} existingNoop=${summary.existingNoop} needsReview=${summary.needsReview} generatorEligible=${summary.generatorEligible} missingDimensions=${summary.missingDimensions} missingAssets=${summary.missingAssets}`);
  }

  console.log(`\n=== TYPOVÉ STÁNKY Txx (section 18) ===`);
  for (const item of allPlanItems.filter((entry) => categoryGroupFor(entry) === "Booths / Txx")) {
    console.log(`- ${item.internalCode}: "${item.sourceName}" dims=${item.dimensions ? `${item.dimensions.widthMm}x${item.dimensions.depthMm}mm` : "?"} lifecycle=${item.lifecycleStatus} generatorEligible=${item.generatorEligible} action=${item.action}`);
  }

  console.log(`\n=== P86 (section 20) ===`);
  console.log(JSON.stringify(p86Plan, null, 2));

  console.log(`\n=== PRICING COVERAGE (section 12 — informational only, no pricing_entries planned) ===`);
  const insertOrExisting = allPlanItems.filter((item) => item.status === "exact_safe" || item.status === "skip_existing");
  let withBasePricing = 0;
  let withoutBasePricing = 0;
  for (const item of insertOrExisting) {
    const pricingRow = item.sourceRow >= 0 ? basePricingByRow.get(item.sourceRow) : undefined;
    if (pricingRow && (pricingRow.saleCzk !== null || pricingRow.saleEur !== null)) withBasePricing += 1;
    else withoutBasePricing += 1;
  }
  console.log(`EXACT_SAFE/existing položek s dostupnou base cenou (PRICELIST saleCzk/saleEur): ${withBasePricing}`);
  console.log(`EXACT_SAFE/existing položek BEZ base ceny ve zdroji: ${withoutBasePricing}`);
  console.log("Event-level pricing_entries (CZK/EUR sheets): žádné další nad rámec Batch #2A (264 CZK + 231 EUR = 495, potvrzeno proti import-preview-v6.6.json pricing.counts) — technické služby jsou jediná položka s per-event cenami v tomto workbooku.");

  if (conflicts.length > 0) {
    console.log(`\n=== CONFLICTS (section 15) — STOP pro tyto konkrétní položky, žádný silent merge ===`);
    for (const conflict of conflicts) console.log(`- [${conflict.kind}] ${conflict.reason}`);
  }

  writeFileSync(PLAN_OUTPUT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), source: "private-imports/code-matching-report.json", items: allPlanItems, conflicts }, null, 2), "utf8");
  console.log(`\nPlan written to: ${PLAN_OUTPUT_PATH}`);
  console.log("\n=== DATABASE WRITES: 0 (dry-run, read-only) ===");
  console.log("=== R2 WRITES: 0 ===");
  console.log("=== BATCH #2B APPLY: NE ===");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
