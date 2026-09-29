/**
 * Technické rastry — real FOR BEAUTY production diagnostic: the full supplemental catalog
 * ("5. Stavby - tisk vše katalog"), all four primary reports (elektrická energie, internet/WiFi,
 * voda/odpad, úklid) and both hall rasters (H3, H4), run through EXACTLY the same domain functions
 * the editor uses (parser -> mergeTechnicalRasterImport -> mergeSupplementalCatalogImport ->
 * buildPrimaryReportMentions + catalogMentions -> reconcileTechnicalReportAndCatalog).
 *
 * The files are real customer documents and are never copied into the repo. Point the script at the
 * folder holding them; without it the script SKIPS (exit 0), same discipline as the other
 * real-file diagnostics.
 *
 * Usage:
 *   TECHNICAL_RASTER_BEAUTY_DIR="C:/path/to/FOR_BEAUTY/rastry" node --no-warnings scripts/technicalRasterBeautyProductionDiagnostic.ts
 *   (add --json to print one machine-readable summary line at the end)
 */
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseSupplementalCatalogPdf, extractTechnicalMentionsFromCatalogStand } from "../domain/technicalRasterCatalogImport.ts";
import { getTechnicalReportParser } from "../domain/technicalReportParsers/index.ts";
import { reconcileTechnicalReportAndCatalog, resolveCanonicalServiceVariant, type TechnicalReconciliationOutcome } from "../domain/technicalRasterReconciliation.ts";
import { resolveTechnicalRealizationGroup } from "../domain/technicalRasterRealization.ts";
import {
  buildPrimaryReportMentions,
  createTechnicalRasterProject,
  mergeSupplementalCatalogImport,
  mergeTechnicalRasterImport,
  withRasterStandLabels,
  type TechnicalRasterProject,
} from "../domain/technicalRaster.ts";
import { detectRasterStandLabels } from "../lib/pdf/rasterStandLabelDetection.ts";
import { groupTextItemsIntoRows, type PdfTextItem } from "../domain/technicalReportTableParsing.ts";

const dir = process.env.TECHNICAL_RASTER_BEAUTY_DIR;
const wantJson = process.argv.includes("--json");

/** Stands whose company/R row the production import reported as a broken "item" (page-boundary bug). */
const KNOWN_PAGE_BOUNDARY_STANDS = ["4B15", "4C08", "4C02", "3A34", "4B24", "3A20", "3C32", "4B11"];

function section(title: string): void {
  console.log("\n" + "=".repeat(78));
  console.log(title);
  console.log("=".repeat(78));
}

function findFile(pattern: RegExp): string | undefined {
  if (!dir) return undefined;
  const match = readdirSync(dir).filter((name) => pattern.test(name)).sort().at(-1);
  return match ? path.join(dir, match) : undefined;
}

async function loadPdf(filePath: string) {
  return pdfjsLib.getDocument({ data: new Uint8Array(await readFile(filePath)) }).promise;
}

async function extractItems(doc: Awaited<ReturnType<typeof loadPdf>>): Promise<PdfTextItem[]> {
  const items: PdfTextItem[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const content = await (await doc.getPage(pageNumber)).getTextContent();
    for (const it of content.items as { str: string; width: number; height: number; transform: number[] }[]) {
      if (!it.str.trim()) continue;
      items.push({ str: it.str, page: pageNumber, x: it.transform[4]!, y: it.transform[5]!, width: it.width, height: it.height || Math.abs(it.transform[3]!) });
    }
  }
  return items;
}

async function getPageSizes(doc: Awaited<ReturnType<typeof loadPdf>>) {
  const sizes = new Map<number, { widthPt: number; heightPt: number; transform: readonly [number, number, number, number, number, number] }>();
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const viewport = (await doc.getPage(pageNumber)).getViewport({ scale: 1 });
    sizes.set(pageNumber, { widthPt: viewport.width, heightPt: viewport.height, transform: viewport.transform as unknown as readonly [number, number, number, number, number, number] });
  }
  return sizes;
}

function importRecord(category: string, filename: string) {
  return {
    id: `imp-${category}`,
    category,
    filename,
    asset: { id: `asset-${category}`, storageKey: `local/${category}.pdf`, originalFileName: filename, mimeType: "application/pdf", size: 1, createdAt: "2026-09-29T00:00:00.000Z", category: "technical-raster-import" as const },
    importedAt: "2026-09-29T00:00:00.000Z",
    parserVersion: "v1",
    parseStatus: "ok" as const,
    standsFound: 0,
    servicesFound: 0,
    warnings: [],
  };
}

function countOutcomes(outcomes: readonly TechnicalReconciliationOutcome[]) {
  const counts = { shoda: 0, quantity_mismatch: 0, conflict: 0, only_report: 0, only_catalog: 0 };
  for (const outcome of outcomes) counts[outcome.status] += 1;
  return counts;
}

function describeOutcome(outcome: TechnicalReconciliationOutcome): string {
  switch (outcome.status) {
    case "quantity_mismatch": return `${outcome.standNumber} (${outcome.category}): report=${outcome.reportQuantity}x vs katalog=${outcome.catalogQuantity}x (${outcome.variant})`;
    case "conflict": return `${outcome.standNumber} (${outcome.category}): ${outcome.reason} report=[${outcome.reportVariants.join(", ")}] katalog=[${outcome.catalogVariants.join(", ")}]`;
    default: return `${outcome.standNumber} (${outcome.category}): ${outcome.status} ${outcome.variant} ${outcome.quantity}x`;
  }
}

async function main(): Promise<void> {
  const files = {
    catalog: findFile(/^5\. Stavby - tisk vše katalog.*\.pdf$/iu),
    electricity: findFile(/^Přehled - elektrická energie.*\.pdf$/iu),
    internet: findFile(/^Přehled - internet, WiFi.*\.pdf$/iu),
    water: findFile(/^Přehled - voda, odpad.*\.pdf$/iu),
    cleaning: findFile(/^Přehled - úklid.*\.pdf$/iu),
    h3: findFile(/^h3\.pdf$/iu),
    h4: findFile(/^h4\.pdf$/iu),
  };
  if (!dir || !existsSync(dir) || Object.values(files).some((file) => !file)) {
    console.log("TECHNICAL_RASTER_BEAUTY_DIR not set or incomplete — skipping (real customer documents, never committed).");
    if (dir) console.log("Resolved:", files);
    return;
  }
  for (const [key, file] of Object.entries(files)) console.log(`${key.padEnd(12)} ${path.basename(file!)}`);

  // ---------------------------------------------------------------- catalog
  section("CATALOG — parse");
  const catalogItems = await extractItems(await loadPdf(files.catalog!));
  const catalog = parseSupplementalCatalogPdf(catalogItems);
  const numbered = catalog.stands.filter((stand) => stand.standNumber);
  const realizationGroups = new Map<string, number>();
  for (const stand of numbered) {
    const group = resolveTechnicalRealizationGroup(stand.realizationCompanyRaw);
    realizationGroups.set(group, (realizationGroups.get(group) ?? 0) + 1);
  }
  console.log(`records: ${catalog.stands.length} (with stand number: ${numbered.length}, standless: ${catalog.stands.length - numbered.length})`);
  console.log(`structural warnings: ${catalog.warnings.length}`);
  for (const warning of catalog.warnings) console.log(`  - [p${warning.page ?? "?"}] ${warning.message}`);
  console.log(`records with R: ${numbered.filter((stand) => stand.realizationCompanyRaw).length}`);
  console.log("realization groups:", Object.fromEntries(realizationGroups));

  section("CATALOG — known page-boundary stands");
  for (const standNumber of KNOWN_PAGE_BOUNDARY_STANDS) {
    const stand = catalog.stands.find((candidate) => candidate.standNumber === standNumber);
    if (!stand) { console.log(`${standNumber}: NOT FOUND`); continue; }
    const suspicious = stand.items.filter((item) => /^r\s*:/iu.test(item.rawQuantityText) || item.label === stand.companyName);
    console.log(`${standNumber}: page ${stand.page} company="${stand.companyName ?? ""}" R="${stand.realizationCompanyRaw ?? ""}" -> ${resolveTechnicalRealizationGroup(stand.realizationCompanyRaw)}; items=${stand.items.length}; company/R-as-item=${suspicious.length}`);
  }

  // Row dump around each known stand's header (page N end / page N+1 start) — evidence for the root cause.
  if (process.argv.includes("--rows")) {
    const rows = groupTextItemsIntoRows(catalogItems);
    for (const standNumber of KNOWN_PAGE_BOUNDARY_STANDS) {
      const index = rows.findIndex((row) => row.items.map((item) => item.str).join("").replace(/\s+/gu, "").startsWith(standNumber));
      if (index < 0) continue;
      console.log(`\n--- rows around ${standNumber}`);
      for (const row of rows.slice(Math.max(0, index - 1), index + 8)) console.log(`  p${row.page} ${row.items.map((item) => `${item.str.trim()}@${Math.round(item.x)}`).join(" | ")}`);
    }
  }

  // ---------------------------------------------------------------- reports
  section("PRIMARY REPORTS — parse");
  const reports = new Map<string, ReturnType<NonNullable<ReturnType<typeof getTechnicalReportParser>>["parse"]>>();
  for (const category of ["electricity", "internet", "water", "cleaning"] as const) {
    const parser = getTechnicalReportParser(category)!;
    const report = parser.parse(await extractItems(await loadPdf(files[category]!)));
    reports.set(category, report);
    console.log(`${category.padEnd(12)} rows=${report.rows.length} warnings=${report.warnings.length}`);
  }

  // ---------------------------------------------------------------- 3A45 internet trace
  section("3A45 — internet, both sides (canonical variant per source row)");
  for (const row of reports.get("internet")!.rows.filter((candidate) => candidate.standNumber === "3A45")) {
    for (const service of row.services) console.log(`  report : "${service.externalLabel}" qty=${service.quantity} -> ${resolveCanonicalServiceVariant("internet", service.externalLabel)}`);
  }
  const catalog3A45 = catalog.stands.find((stand) => stand.standNumber === "3A45");
  for (const item of catalog3A45?.items ?? []) {
    const mention = extractTechnicalMentionsFromCatalogStand({ ...catalog3A45!, items: [item] })[0];
    console.log(`  catalog: "${item.label}" qty=${item.quantity} -> ${mention ? `${mention.category} / ${resolveCanonicalServiceVariant(mention.category, mention.externalLabel)}` : "(not a technical mention)"}`);
  }

  // ---------------------------------------------------------------- per hall
  const summary: Record<string, unknown> = {
    catalogRecords: catalog.stands.length,
    catalogWarnings: catalog.warnings.length,
    catalogRecordsWithR: numbered.filter((stand) => stand.realizationCompanyRaw).length,
    realizationGroups: Object.fromEntries(realizationGroups),
  };
  for (const hall of ["h3", "h4"] as const) {
    section(`HALL ${hall.toUpperCase()} — project merge + reconciliation`);
    const rasterDoc = await loadPdf(files[hall]!);
    const labels = detectRasterStandLabels(await extractItems(rasterDoc), await getPageSizes(rasterDoc));
    let project: TechnicalRasterProject = withRasterStandLabels(createTechnicalRasterProject({ name: `Beauty ${hall}` }, `beauty-${hall}`), labels);
    for (const [category, report] of reports) {
      project = mergeTechnicalRasterImport(project, importRecord(category, path.basename(files[category as keyof typeof files]!)), report, () => ({ status: "unresolved_product" as const }));
    }
    project = mergeSupplementalCatalogImport(project, catalog, path.basename(files.catalog!));
    const meta = project.catalogImportMeta!;
    const currentRaster = meta.standCount - meta.outsideCurrentRasterCount;
    const outcomes = reconcileTechnicalReportAndCatalog(buildPrimaryReportMentions(project), project.catalogMentions ?? []);
    const counts = countOutcomes(outcomes);
    console.log(`raster labels: ${labels.length}`);
    console.log(`catalog records: ${meta.standCount}  current-raster: ${currentRaster}  outside-current-raster: ${meta.outsideCurrentRasterCount}  matched: ${meta.matchedStandCount}`);
    console.log("reconciliation:", counts);
    for (const outcome of outcomes.filter((candidate) => candidate.status === "quantity_mismatch" || candidate.status === "conflict")) console.log(`  ${outcome.status.padEnd(17)} ${describeOutcome(outcome)}`);
    const internet3A45 = outcomes.filter((outcome) => outcome.standNumber === "3A45" && outcome.category === "internet");
    if (internet3A45.length > 0) console.log("3A45 internet:", internet3A45.map(describeOutcome).join(" | "));
    summary[hall] = { labels: labels.length, catalogRecords: meta.standCount, currentRaster, outsideCurrentRaster: meta.outsideCurrentRasterCount, matched: meta.matchedStandCount, reconciliation: counts, internet3A45: internet3A45.map(describeOutcome) };
  }

  if (wantJson) console.log("\nJSON " + JSON.stringify(summary));
}

await main();
