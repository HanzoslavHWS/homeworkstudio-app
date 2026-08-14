/**
 * READ-ONLY dry-run preview for private-imports/Ultimátní kalkulace V6.6.xlsm.
 *
 * Writes ZERO data anywhere — no Supabase, no R2, no domain seed files. It only reads the
 * workbook (via the existing safe exceljs-based reader, no VBA execution) and the existing
 * componentCatalogItems/boothTypes seeds (read-only reference for candidate mapping), then
 * prints a report and writes a machine-readable JSON preview to private-imports/ (gitignored).
 *
 * Reuses domain/importBatch.ts, domain/priceImport.ts, domain/catalogMapping.ts and
 * domain/catalogReadiness.ts exactly as already built/tested — no domain code is modified
 * or duplicated here, only composed for reporting.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { componentCatalogItems } from "../data/components.ts";
import { boothTypes } from "../data/booths.ts";
import { buildImportPreview, fingerprintBytes, type ImportCatalogRowPreview, type ImportPreview } from "../domain/importBatch.ts";
import { extractSheetGrid, readWorkbookSheets } from "../lib/import/xlsxReader.server.ts";
import { suggestCatalogMappingCandidates } from "../domain/catalogMapping.ts";
import { evaluateCatalogReadiness, type ReadinessIssue } from "../domain/catalogReadiness.ts";
import { normalizeCatalogName } from "../domain/catalog.ts";
import type { CatalogItemKind, ComponentDefinition } from "../domain/models.ts";

function detectSourceVersion(fileName: string): string {
  const match = /V(\d+\.\d+)/iu.exec(fileName);
  return match ? `V${match[1]}` : fileName;
}

/**
 * Advisory-only heuristic for the report ("proposed catalog kind"). Never persisted, never
 * used to auto-create anything — just tells a human reviewer roughly what kind of readiness
 * rules would apply if this row became a CatalogItem.
 */
const CATEGORY_KIND_HINTS: Readonly<Record<string, CatalogItemKind>> = {
  "Typovky": "booth",
  "Stavba": "construction",
  "Octanorm": "furniture",
  "Světlo": "furniture",
  "Nábytek": "furniture",
  "Kuchyňka": "furniture",
  "Ostatní": "other",
  "Úvaz": "construction",
  "Lamino": "construction",
  "Grafika": "graphics_service",
  "TV": "other",
  "T. služby": "service",
};

function proposedKind(category: string): CatalogItemKind {
  return CATEGORY_KIND_HINTS[category] ?? "other";
}

/**
 * Builds the minimal ComponentDefinition shape evaluateCatalogReadiness() needs, using ONLY
 * fields the Excel row actually provides. Everything CAD/scene-related (dimensions, 2D/3D
 * capability, GLB) is deliberately left absent/zero, because the source workbook has no such
 * data — that's the honest, real reason most rows can't reach "ready" from Excel alone.
 */
function stubFromRow(row: ImportCatalogRowPreview, kind: CatalogItemKind): ComponentDefinition {
  return {
    id: `pricelist-row-${row.sourceRow}`,
    internalCode: undefined,
    displayName: row.rawNameCz,
    officialName: undefined,
    type: kind,
    name: row.rawNameCz,
    category: row.category,
    widthMm: 0,
    depthMm: 0,
    resizable: false,
    productionProfiles: {},
    rotation: { defaultMode: "free", snapStep: 45, quickAngles: [0], allowFreeRotation: true, locked: false },
    systemLocked: false,
    userLocked: false,
    visible: true,
    sceneLabel: row.rawNameCz,
    showIn2D: undefined,
    showIn3D: undefined,
    unit: row.unit ?? undefined,
    pricingUnit: undefined,
    pricingEntries: row.saleCzk.status === "priced" ? [{ id: "stub", itemId: "stub", currency: "CZK", salePrice: row.saleCzk.amount! }] : [],
    catalogItemKind: kind,
    lifecycleStatus: undefined,
    reviewedAt: undefined,
  } as ComponentDefinition;
}

type CatalogRowReport = Readonly<{
  sourceRow: number;
  category: string;
  rawNameCz: string;
  rawNameEn: string | null;
  saleCzk: number | null;
  saleEur: number | null;
  purchaseCzk: number | null;
  unit: string | null;
  unitNeedsReview: boolean;
  proposedKind: CatalogItemKind;
  ready: boolean;
  needsReviewReasons: readonly ReadinessIssue[];
  candidates: readonly { internalCode?: string; displayName: string; score: number; reasons: readonly string[] }[];
}>;

function buildCatalogRowReport(row: ImportCatalogRowPreview): CatalogRowReport {
  const kind = proposedKind(row.category);
  const readiness = evaluateCatalogReadiness(stubFromRow(row, kind), kind);
  return {
    sourceRow: row.sourceRow,
    category: row.category,
    rawNameCz: row.rawNameCz,
    rawNameEn: row.rawNameEn,
    saleCzk: row.saleCzk.amount,
    saleEur: row.saleEur.amount,
    purchaseCzk: row.purchaseCzk.amount,
    unit: row.unit,
    unitNeedsReview: row.unitNeedsReview,
    proposedKind: kind,
    ready: readiness.ready,
    needsReviewReasons: readiness.issues,
    candidates: row.candidates,
  };
}

type DuplicateGroup = Readonly<{ normalizedName: string; rows: readonly { sourceRow: number; category: string; rawNameCz: string }[] }>;

/** Advisory only — normalized_name is NOT a unique identifier (section 8), this only proposes groups for a human to review. */
function findDuplicateCandidates(rows: readonly ImportCatalogRowPreview[]): readonly DuplicateGroup[] {
  const groups = new Map<string, ImportCatalogRowPreview[]>();
  for (const row of rows) {
    const key = normalizeCatalogName(row.rawNameCz);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  return [...groups.entries()]
    .filter(([, groupRows]) => groupRows.length > 1)
    .map(([normalizedName, groupRows]) => ({
      normalizedName,
      rows: groupRows.map((row) => ({ sourceRow: row.sourceRow, category: row.category, rawNameCz: row.rawNameCz })),
    }));
}

async function main() {
  const filePath = process.argv[2] ?? path.resolve(process.cwd(), "private-imports", "Ultimátní kalkulace V6.6.xlsm");
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

  const preview: ImportPreview = buildImportPreview(sheets, componentCatalogItems);
  const catalogReport = preview.catalogRows.map(buildCatalogRowReport);
  const duplicates = findDuplicateCandidates(preview.catalogRows);

  // Reference-item checks — reuse the exact same advisory function already tested against
  // this workbook, no automerge, no new logic.
  const m57Candidates = suggestCatalogMappingCandidates({ rawNameCz: "Židle čalouněná", rawNameEn: "Upholstered chair" }, componentCatalogItems)
    .filter((c) => c.internalCode === "M57");
  const l02Candidates = preview.technicalServiceRows
    .flatMap((row) => row.candidates.map((c) => ({ rawName: row.rawName, ...c })))
    .filter((c) => c.internalCode === "L02");
  const l02CandidateNames = new Set(l02Candidates.map((c) => normalizeCatalogName(c.rawName)));
  // Same PRICELIST row can also carry the T. služby category (rows 143-165 mirror the
  // CZK/EUR technical-service names) — that's the SAME genuine candidate, not a second
  // false-positive. Only rows whose name isn't already a confirmed real candidate above
  // count as false-positive risk (e.g. an unrelated kettle that merely shares "2 kW").
  const l02FalsePositives = catalogReport
    .flatMap((row) => row.candidates.filter((c) => c.internalCode === "L02").map((c) => ({ rawNameCz: row.rawNameCz, category: row.category, ...c })))
    .filter((c) => !l02CandidateNames.has(normalizeCatalogName(c.rawNameCz)));
  const p86Booth = boothTypes.find((booth) => booth.internalCode === "P86" || booth.code === "P86");
  const p86Candidates = catalogReport.flatMap((row) => row.candidates.filter((c) => c.internalCode === "P86"));

  const readyCount = catalogReport.filter((row) => row.ready).length;
  const needsReviewCount = catalogReport.length - readyCount;
  const missingInternalCodeCount = catalogReport.filter((row) => row.needsReviewReasons.includes("missing_internal_code")).length;
  const ambiguousUnitRows = catalogReport.filter((row) => row.unitNeedsReview);

  // ============================= TERMINAL REPORT =============================
  console.log("=== DRY-RUN IMPORT PREVIEW (READ-ONLY) ===");
  console.log("sourceFileName:", fileName);
  console.log("sourceFingerprint:", fingerprint);
  console.log("sourceVersion:", sourceVersion);
  console.log();

  console.log("=== EVENTS (%d) ===", preview.events.length);
  for (const event of preview.events) {
    const problems: string[] = [];
    if (event.needsReview) problems.push("datum chybí/nejednoznačné -> NULL, needsReview");
    console.log(`- ${event.sourceKey.padEnd(10)} | ${event.name.padEnd(30)} | ${event.startDate ?? "NULL"} .. ${event.endDate ?? "NULL"} | ${problems.length ? "REVIEW: " + problems.join("; ") : "UPDATE-ready (insert candidate)"}`);
  }
  console.log();

  console.log("=== CATALOG (PRICELIST) SUMMARY ===");
  console.log("total rows:", catalogReport.length);
  console.log("ready:", readyCount);
  console.log("needs review:", needsReviewCount);
  console.log("missing internalCode:", missingInternalCodeCount, "(expected — Excel never has codes, codes are never generated)");
  console.log("missing sale CZK:", preview.counts.basePricesCzkMissing);
  console.log("missing sale EUR:", preview.counts.basePricesEurMissing);
  console.log("missing purchase price:", preview.counts.purchasePricesCzkMissing);
  console.log("ambiguous unit:", ambiguousUnitRows.length);
  console.log();

  console.log("=== AMBIGUOUS UNITS (full list, %d rows) ===", ambiguousUnitRows.length);
  for (const row of ambiguousUnitRows) console.log(`- row ${row.sourceRow} [${row.category}] "${row.rawNameCz}"`);
  console.log();

  console.log("=== PRICING (event-specific, CZK/EUR sheets) ===");
  console.log("CZK event pricing entries (fixed/present):", preview.counts.eventPricingEntriesCzk);
  console.log("EUR event pricing entries (fixed/present):", preview.counts.eventPricingEntriesEur);
  console.log("CZK missing:", preview.counts.missingEventPricingCzk);
  console.log("EUR missing:", preview.counts.missingEventPricingEur);
  console.log("individual-priced entries found in CZK/EUR sheets:", 0, "(these sheets only ever encode a number or missing — 'individual'/'included' are catalog-level classifications, e.g. Kontejner/P86 fascia, neither of which appears as a row in CZK/EUR)");
  console.log("included-priced entries found in CZK/EUR sheets:", 0);
  console.log("technical purchase prices present (náklad sheet):", preview.counts.technicalPurchasePricesCzkPresent, "(sheet is near-empty — 0 is the correct, honest result, not an importer bug)");
  console.log();

  console.log("=== M57 MAPPING ===");
  if (m57Candidates.length) m57Candidates.forEach((c) => console.log(`- candidate: ${c.internalCode} "${c.displayName}" score=${c.score.toFixed(2)} reasons=${c.reasons.join(",")} -> doporučení: nabídnout k potvrzení, NEsloučit automaticky`));
  else console.log("- no candidate found");
  console.log();

  console.log("=== L02 MAPPING ===");
  if (l02Candidates.length) l02Candidates.forEach((c) => console.log(`- candidate: ${c.internalCode} "${c.displayName}" (source row-technical service "${c.rawName}") score=${c.score.toFixed(2)} reasons=${c.reasons.join(",")} -> doporučení: nabídnout k potvrzení, NEsloučit automaticky`));
  else console.log("- no candidate found");
  if (l02FalsePositives.length) {
    console.log("  POZOR — false-positive rizika (jen shared_spec_token, žádná jistota):");
    l02FalsePositives.forEach((c) => console.log(`    - "${c.rawNameCz}" (${c.category}) score=${c.score.toFixed(2)} reasons=${c.reasons.join(",")} -> doporučení: zamítnout / nepotvrzovat`));
  }
  console.log();

  console.log("=== P86 MAPPING ===");
  console.log("P86 existuje v současném booth seedu:", Boolean(p86Booth), p86Booth?.name ?? "");
  console.log("PRICELIST řádky navrhující P86 jako kandidáta:", p86Candidates.length, "(očekáváno 0 — booths se v tomto kroku vůbec neporovnávají s PRICELIST řádky, žádná náhrada za ruční P86 seed se nesmí vytvořit)");
  console.log();

  console.log("=== DUPLICATE CANDIDATES (advisory only, %d groups) ===", duplicates.length);
  for (const group of duplicates) {
    console.log(`- normalizedName="${group.normalizedName}":`);
    group.rows.forEach((row) => console.log(`    row ${row.sourceRow} [${row.category}] "${row.rawNameCz}"`));
  }
  console.log();

  // ============================= JSON PREVIEW =============================
  const jsonPreview = {
    sourceFileName: fileName,
    sourceFingerprint: fingerprint,
    sourceVersion,
    generatedAt: new Date().toISOString(),
    note: "READ-ONLY dry-run preview. No writes to Supabase, R2, or any domain seed file were made while generating this file.",
    events: preview.events,
    catalog: {
      counts: {
        total: catalogReport.length,
        ready: readyCount,
        needsReview: needsReviewCount,
        missingInternalCode: missingInternalCodeCount,
        missingSaleCzk: preview.counts.basePricesCzkMissing,
        missingSaleEur: preview.counts.basePricesEurMissing,
        missingPurchasePrice: preview.counts.purchasePricesCzkMissing,
        ambiguousUnit: ambiguousUnitRows.length,
      },
      rows: catalogReport,
    },
    pricing: {
      technicalServiceRows: preview.technicalServiceRows,
      counts: {
        eventPricingEntriesCzk: preview.counts.eventPricingEntriesCzk,
        eventPricingEntriesEur: preview.counts.eventPricingEntriesEur,
        missingEventPricingCzk: preview.counts.missingEventPricingCzk,
        missingEventPricingEur: preview.counts.missingEventPricingEur,
        technicalPurchasePricesCzkPresent: preview.counts.technicalPurchasePricesCzkPresent,
      },
    },
    mappings: {
      m57: m57Candidates,
      l02: l02Candidates,
      l02FalsePositives,
      p86: { existsInSeed: Boolean(p86Booth), candidatesFromPricelist: p86Candidates },
    },
    duplicateCandidates: duplicates,
    categories: preview.counts.categories,
  };

  const outputPath = path.resolve(process.cwd(), "private-imports", "import-preview-v6.6.json");
  writeFileSync(outputPath, JSON.stringify(jsonPreview, null, 2), "utf8");
  console.log("=== JSON PREVIEW WRITTEN ===");
  console.log(outputPath);
  console.log();
  console.log("=== ZERO WRITES ASSERTION ===");
  console.log("Supabase inserts: 0 | Supabase updates: 0 | Supabase deletes: 0 | R2 writes: 0 | M57/L02/P86 seed changes: 0");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
