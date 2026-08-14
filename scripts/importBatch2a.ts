/**
 * Import Batch #2A: canonical M57/L02 catalog_items + 23 technical-service candidates +
 * 495 fixed pricing_entries — DRY-RUN ONLY.
 *
 *   node scripts/importBatch2a.ts [path-to-xlsm]
 *
 * There is NO --apply mode in this script by design — Batch #2A is dry-run-only per
 * instruction. Reads (workbook + read-only remote DB) only, never writes anywhere: no
 * catalog_items, no pricing_entries, no catalog_mappings, no R2, no P86, no other PRICELIST
 * rows, no booths. See domain/importBatch2a.ts for the pure planning logic.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { componentCatalogItems } from "../data/components.ts";
import { buildImportPreview, fingerprintBytes } from "../domain/importBatch.ts";
import type { MappingDecision } from "../domain/importBatch1.ts";
import {
  buildBatch2aPlan,
  type AbfTechnicalServiceMatch,
  type ExistingCatalogItemRow,
  type ExistingEventRow2A,
  type ExistingPriceListRow2A,
} from "../domain/importBatch2a.ts";
import { extractSheetGrid, readWorkbookSheets } from "../lib/import/xlsxReader.server.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../lib/db/supabase.server.ts";

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

async function readExistingCatalogItems(client: ReturnType<typeof createSupabaseServerClient>): Promise<readonly ExistingCatalogItemRow[]> {
  const { data, error } = await client.from("catalog_items").select("id, internal_code");
  if (error) throw error;
  return (data ?? []).map((row: { id: string; internal_code: string | null }) => ({ id: row.id, internalCode: row.internal_code ?? undefined }));
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
  if (args.includes("--apply")) {
    console.error("Batch #2A je DRY-RUN ONLY. Tento skript nemá --apply režim vůbec implementovaný — nic se nezapíše.");
    process.exit(1);
  }
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

  console.log("=== IMPORT BATCH #2A — DRY-RUN ONLY (no --apply mode exists) ===");
  console.log("sourceFileName:", fileName);
  console.log("sourceFingerprint:", fingerprint);
  console.log();

  let existingCatalogItems: readonly ExistingCatalogItemRow[] = [];
  let existingEvents: readonly ExistingEventRow2A[] = [];
  let existingPriceLists: readonly ExistingPriceListRow2A[] = [];
  let dbStateSource = "unavailable (Supabase not reachable/configured) — treating as empty";
  try {
    const client = createSupabaseServerClient();
    [existingCatalogItems, existingEvents, existingPriceLists] = await Promise.all([
      readExistingCatalogItems(client),
      readExistingEvents(client),
      readExistingPriceLists(client),
    ]);
    dbStateSource = `read live from Supabase (read-only SELECT): ${existingCatalogItems.length} catalog_items, ${existingEvents.length} events, ${existingPriceLists.length} price_lists`;
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
  for (const mapping of plan.mappings.confirmed) console.log(`- confirmed: "${mapping.rawName}" -> ${mapping.canonicalInternalCode}`);
  for (const rejection of plan.mappings.rejected) console.log(`- rejected: "${rejection.rawName}" X ${rejection.rejectedInternalCode} (${rejection.recordedIn})`);
  console.log();

  console.log("=== WARNINGS ===");
  for (const warning of plan.warnings) console.log("- " + warning);
  console.log();

  console.log("=== DATABASE WRITES ===");
  console.log("0 (dry-run only — this script has no apply path, nothing was written)");
  console.log();

  const outputPath = path.resolve(process.cwd(), "private-imports", "import-batch2a-plan.json");
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        sourceFileName: fileName,
        sourceFingerprint: fingerprint,
        mode: "dry-run-only",
        dbStateSource,
        plan,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log("Plan written to:", outputPath);
  console.log();
  console.log("=== ZERO WRITES ASSERTION ===");
  console.log("Supabase inserts: 0 | Supabase updates: 0 | Supabase deletes: 0 | R2 writes: 0 | P86 changes: 0 | full PRICELIST catalog import: 0");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
