/**
 * Import Batch #2A: canonical M57/L02 catalog_items + 23 technical-service candidates +
 * 495 fixed pricing_entries.
 *
 *   node scripts/importBatch2a.ts [path-to-xlsm]              -> dry-run (DEFAULT, zero writes)
 *   node scripts/importBatch2a.ts [path-to-xlsm] --dry-run     -> same, explicit
 *   node scripts/importBatch2a.ts [path-to-xlsm] --apply       -> real writes (requires Supabase env)
 *
 * Without --apply this NEVER calls applyBatch2aPlan — only reads (workbook + read-only
 * remote DB) and prints/writes a plan + an apply PREVIEW (computed with the exact same pure
 * resolution functions the real writer uses, so the preview can't drift from real behavior).
 * See domain/importBatch2a.ts for the pure planning/resolution logic and
 * lib/db/importBatch2a.supabase.ts for the writer.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { componentCatalogItems } from "../data/components.ts";
import { buildImportPreview, fingerprintBytes } from "../domain/importBatch.ts";
import type { MappingDecision } from "../domain/importBatch1.ts";
import {
  buildBatch2aPlan,
  previewBatch2aApply,
  runBatch2aPreflight,
  type AbfTechnicalServiceMatch,
  type ExistingCatalogItemRow,
  type ExistingCatalogMappingRow,
  type ExistingEventRow2A,
  type ExistingPriceListRow2A,
  type ExistingPricingEntryRow,
} from "../domain/importBatch2a.ts";
import { extractSheetGrid, readWorkbookSheets } from "../lib/import/xlsxReader.server.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../lib/db/supabase.server.ts";
import {
  applyBatch2aPlan,
  readExistingCatalogItemsFull,
  readExistingCatalogMappings,
  readExistingPricingEntriesForCatalogItems,
} from "../lib/db/importBatch2a.supabase.ts";

/** Identical to Batch #1's human-confirmed decisions (scripts/importBatch1.ts) — same source session, same facts about V6.6, not re-derived. */
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

const ABF_MATCHING_REPORT_PATH = path.resolve(process.cwd(), "private-imports", "code-matching-report.json");

/**
 * Source of truth for technical-service internalCode: private-imports/code-matching-report.json
 * (produced by scripts/matchAbfCodes.ts). Only EXACT_SAFE rows ever yield a code — REVIEW and
 * NO_MATCH are read too (for reporting) but never used as a real internalCode.
 */
function loadAbfTechnicalServiceMatches(): ReadonlyMap<string, AbfTechnicalServiceMatch> {
  const raw = JSON.parse(readFileSync(ABF_MATCHING_REPORT_PATH, "utf8")) as {
    technicalServices: readonly { nameCz: string; assessment: { status: "EXACT_SAFE" | "REVIEW" | "NO_MATCH"; proposedCode: string | null; proposedName: string | null } }[];
  };
  const map = new Map<string, AbfTechnicalServiceMatch>();
  for (const row of raw.technicalServices) {
    map.set(row.nameCz, { nameCz: row.nameCz, status: row.assessment.status, proposedCode: row.assessment.proposedCode, proposedName: row.assessment.proposedName });
  }
  return map;
}

async function readExistingEvents(client: ReturnType<typeof createSupabaseServerClient>): Promise<readonly ExistingEventRow2A[]> {
  const { data, error } = await client.from("events").select("id, source_key, year");
  if (error) throw error;
  return (data ?? []).map((row: { id: string; source_key: string; year: number }) => ({ id: row.id, sourceKey: row.source_key, year: row.year }));
}

async function readExistingPriceLists(client: ReturnType<typeof createSupabaseServerClient>): Promise<readonly ExistingPriceListRow2A[]> {
  const { data, error } = await client.from("price_lists").select("id, code, currency, event_id");
  if (error) throw error;
  return (data ?? []).map((row: { id: string; code: string; currency: "CZK" | "EUR"; event_id: string | null }) => ({ id: row.id, code: row.code, currency: row.currency, eventId: row.event_id }));
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const filePath = args.find((arg) => !arg.startsWith("--")) ?? path.resolve(process.cwd(), "private-imports", "Ultimátní kalkulace V6.6.xlsm");

  const bytes = readFileSync(filePath);
  const fingerprint = fingerprintBytes(new Uint8Array(bytes));
  const fileName = filePath.split(/[\\/]/u).pop() ?? filePath;

  const workbook = await readWorkbookSheets(filePath);
  const sheets = {
    pricelist: extractSheetGrid(workbook, "PRICELIST"),
    dataSheet: extractSheetGrid(workbook, "data sheet"),
    czk: extractSheetGrid(workbook, "CZK"),
    eur: extractSheetGrid(workbook, "EUR"),
    naklad: extractSheetGrid(workbook, "náklad"),
  };
  const preview = buildImportPreview(sheets, componentCatalogItems);

  console.log("=== IMPORT BATCH #2A —", apply ? "APPLY MODE" : "DRY-RUN (default, zero writes)", "===");
  console.log("sourceFileName:", fileName);
  console.log("sourceFingerprint:", fingerprint);
  console.log();

  let existingCatalogItems: readonly ExistingCatalogItemRow[] = [];
  let existingEvents: readonly ExistingEventRow2A[] = [];
  let existingPriceLists: readonly ExistingPriceListRow2A[] = [];
  let existingCatalogMappings: readonly ExistingCatalogMappingRow[] = [];
  let dbStateSource = "unavailable (Supabase not reachable/configured) — treating as empty, all rows classified as insert";
  try {
    const client = createSupabaseServerClient();
    [existingCatalogItems, existingEvents, existingPriceLists, existingCatalogMappings] = await Promise.all([
      readExistingCatalogItemsFull(client),
      readExistingEvents(client),
      readExistingPriceLists(client),
      readExistingCatalogMappings(client),
    ]);
    dbStateSource = `read live from Supabase (read-only SELECT): ${existingCatalogItems.length} catalog_items, ${existingEvents.length} events, ${existingPriceLists.length} price_lists, ${existingCatalogMappings.length} catalog_mappings`;
  } catch (error) {
    if (!(error instanceof SupabaseConfigurationError)) console.error("Warning: could not read existing DB state:", error instanceof Error ? error.message : error);
  }
  console.log("existing DB state:", dbStateSource);
  console.log();

  const abfMatches = loadAbfTechnicalServiceMatches();
  console.log("ABF matching report:", ABF_MATCHING_REPORT_PATH, `(${abfMatches.size} technical-service rows loaded)`);
  console.log();

  // Deterministic per script run (not per plan build) — planCanonicalCatalogItems() itself
  // stays pure and takes this as a plain argument, never generates it internally.
  const manualReviewTimestamp = new Date().toISOString();
  const plan = buildBatch2aPlan(preview, componentCatalogItems, existingCatalogItems, existingEvents, existingPriceLists, BATCH1_MAPPING_DECISIONS, manualReviewTimestamp, abfMatches);

  console.log("=== CANONICAL CATALOG ITEMS (M57 / L02) ===");
  for (const item of plan.canonicalCatalogItems) {
    console.log(`- ${item.internalCode.padEnd(6)} ${item.action.padEnd(6)} kind=${item.kind.padEnd(10)} ready=${item.readiness.ready} generatorEligible=${item.generatorEligible}${item.readiness.issues.length ? "  issues=" + item.readiness.issues.join(",") : ""}`);
    if (item.internalCode === "M57") console.log(`    reviewedAt=${item.document.reviewedAt}`);
  }
  console.log();

  console.log("=== TECHNICAL SERVICES (%d source identities) ===", plan.technicalServices.length);
  for (const service of plan.technicalServices) {
    console.log(`- ${service.sourceKey}`);
    console.log(`    CZ: "${service.nameCz}"  canonical: "${service.canonicalName}"`);
    console.log(`    kind=${service.kind} internalCode=${service.internalCode ?? "NULL"} abfMatchStatus=${service.abfMatchStatus} identityBasis=${service.identityBasis} action=${service.action} lifecycleStatus=${service.lifecycleStatus ?? "NULL (mapped, not a new item)"}`);
    console.log(`    isNewCatalogItem=${service.isNewCatalogItem} generatorEligible=${service.generatorEligible} unitConfidence=${service.unitConfidence}`);
    console.log(`    readiness.ready=${service.readiness.ready} issues=${service.readiness.issues.join(",") || "none"}`);
  }
  console.log();

  console.log("=== CATALOG ITEMS SUMMARY ===");
  console.log(`canonical: ${plan.catalogItemsSummary.canonical}  technicalServiceCandidates: ${plan.catalogItemsSummary.technicalServiceCandidates} (withAbfCode=${plan.catalogItemsSummary.technicalServiceCandidatesWithAbfCode}, withoutAbfCode=${plan.catalogItemsSummary.technicalServiceCandidatesWithoutAbfCode})  TOTAL: ${plan.catalogItemsSummary.total}`);
  console.log();

  console.log("=== REIMPORT IDENTITY ===");
  console.log(`identity by internalCode: ${plan.reimport.identityByInternalCode}`);
  console.log(`identity by sourceKey only: ${plan.reimport.identityBySourceKeyOnly}`);
  console.log(`duplicate internalCodes: ${plan.reimport.duplicateInternalCodes.length ? plan.reimport.duplicateInternalCodes.join(", ") : "none"}`);
  console.log(`duplicate sourceKeys: ${plan.reimport.duplicateSourceKeys.length ? plan.reimport.duplicateSourceKeys.join(", ") : "none"}`);
  console.log();

  console.log("=== PRICING PLAN ===");
  console.log(`CZK fixed: ${plan.pricing.counts.czkFixed}  EUR fixed: ${plan.pricing.counts.eurFixed}  TOTAL fixed: ${plan.pricing.counts.totalFixed}`);
  console.log(`CZK missing (skipped): ${plan.pricing.counts.czkMissing}  EUR missing (skipped): ${plan.pricing.counts.eurMissing}  TOTAL missing: ${plan.pricing.counts.totalMissing}`);
  console.log(`catalog target missing: ${plan.pricing.validation.catalogTargetMissing.length}`);
  console.log(`currency mismatches: ${plan.pricing.validation.currencyMismatches.length}`);
  console.log(`orphan pricing candidates: ${plan.pricing.validation.orphanPricingSourceKeys.length}`);
  console.log();

  console.log("=== MAPPINGS ===");
  for (const mapping of plan.mappings.confirmed) console.log(`- confirmed: "${mapping.rawName}" -> ${mapping.canonicalInternalCode}  sourceKey=${mapping.sourceKey}`);
  for (const rejection of plan.mappings.rejected) console.log(`- rejected: "${rejection.rawName}" X ${rejection.rejectedInternalCode} (${rejection.recordedIn})`);
  console.log();

  console.log("=== WARNINGS ===");
  for (const warning of plan.warnings) console.log("- " + warning);
  console.log();

  // Section 11: preflight — everything checkable before the first write. Runs in BOTH modes;
  // in --apply mode applyBatch2aPlan() re-runs this itself (fresh read) right before writing.
  const preflight = runBatch2aPreflight(plan, existingCatalogItems);
  console.log("=== PREFLIGHT ===");
  console.log(preflight.ok ? "OK — no blocking issues found." : `BLOCKED — ${preflight.issues.length} issue(s):`);
  for (const issue of preflight.issues) console.log("  - " + issue);
  console.log();

  // Section 12: apply PREVIEW — read-only, uses the exact same resolution functions the real
  // writer uses, against whatever the DB actually looks like right now.
  const catalogItemIdsForPricingPreview = existingCatalogItems.map((row) => row.id);
  const existingPricingEntries: readonly ExistingPricingEntryRow[] = await (async () => {
    try {
      const client = createSupabaseServerClient();
      return await readExistingPricingEntriesForCatalogItems(client, catalogItemIdsForPricingPreview);
    } catch {
      return [];
    }
  })();
  const applyPreview = previewBatch2aApply(plan, existingCatalogItems, existingCatalogMappings, existingPricingEntries);
  console.log("=== APPLY PREVIEW (what a real --apply would do right now) ===");
  console.log(`catalog_items:     insert=${applyPreview.catalogItems.insert}  noop=${applyPreview.catalogItems.noop}  conflicts=${applyPreview.catalogItems.conflicts}`);
  console.log(`catalog_mappings:  insert=${applyPreview.catalogMappings.insert}  noop=${applyPreview.catalogMappings.noop}`);
  console.log(`pricing_entries:   insert=${applyPreview.pricingEntries.insert}  update=${applyPreview.pricingEntries.update}  noop=${applyPreview.pricingEntries.noop}  conflicts=${applyPreview.pricingEntries.conflicts}`);
  if (applyPreview.pricingConflicts.length > 0) {
    console.log("\n=== PRICING CONFLICTS (manual price differs from new import price — NEVER auto-written, review needed) ===");
    for (const conflict of applyPreview.pricingConflicts) {
      console.log(`- ${conflict.catalogItemRef} @ priceList=${conflict.priceListId} (${conflict.currency}): sourcePrice=${conflict.sourcePrice} manualPrice=${conflict.manualPrice} incomingImportPrice=${conflict.incomingImportPrice} — ${conflict.reason}`);
    }
  }
  console.log();

  const outputPath = path.resolve(process.cwd(), "private-imports", "import-batch2a-plan.json");
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        sourceFileName: fileName,
        sourceFingerprint: fingerprint,
        mode: apply ? "apply" : "dry-run",
        dbStateSource,
        preflight,
        applyPreview,
        plan,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log("Plan written to:", outputPath);

  if (!apply) {
    console.log();
    console.log("=== DATABASE WRITES ===");
    console.log("0 (dry-run — nothing was written)");
    console.log();
    console.log("Dry-run complete. Re-run with --apply to write for real (requires SUPABASE_URL/SUPABASE_SECRET_KEY).");
    return;
  }

  console.log();
  console.log("=== APPLYING ===");
  const client = createSupabaseServerClient();
  const result = await applyBatch2aPlan(client, plan, { sourceFileName: fileName, sourceFingerprint: fingerprint, sourceVersion: "V6.6" });
  console.log("import_batches id:", result.batchId);
  console.log("catalog_items:", JSON.stringify(result.catalogItems));
  console.log("catalog_mappings:", JSON.stringify(result.catalogMappings));
  console.log("pricing_entries:", JSON.stringify(result.pricingEntries));
  if (result.pricingConflicts.length > 0) {
    console.log("\n=== PRICING CONFLICTS (skipped, never written — needs manual review) ===");
    for (const conflict of result.pricingConflicts) {
      console.log(`- ${conflict.catalogItemRef} @ priceList=${conflict.priceListId} (${conflict.currency}): sourcePrice=${conflict.sourcePrice} manualPrice=${conflict.manualPrice} incomingImportPrice=${conflict.incomingImportPrice} — ${conflict.reason}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
