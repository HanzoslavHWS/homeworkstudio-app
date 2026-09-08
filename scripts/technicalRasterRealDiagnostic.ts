/**
 * Technické rastry — real-file diagnostic harness (spec batch 2.5 section 2/3/23/24). Runs the
 * FULL raster + 4-report pipeline against real FOR DECOR 2026 fixture PDFs and prints a machine-
 * and human-readable diagnostic report: RASTR / IMPORT / MATCH sections (section 23), plus rough
 * timing for each phase (section 24, sanity-only — no benchmark framework, no premature
 * optimization, just "does anything take an absurd amount of time").
 *
 * These are real customer/exhibitor PDFs — never assumed to be present in a fresh checkout, and
 * NEVER required for the standard `npm test` suite. This script is entirely SKIP-SAFE: if the
 * fixture directory/files aren't found locally, it prints a clear message and exits 0 (not a
 * failure) so CI/a fresh clone never breaks because these real files aren't committed.
 *
 * Usage:
 *   node --no-warnings scripts/technicalRasterRealDiagnostic.ts
 *   npm run test:technical-raster-real
 *
 * Expects (if present) at the repo root, in `_IMPORT/`:
 *   Hala 1.pdf
 *   Decor 26 - elektrická energie.pdf
 *   Decor 26 - internet, WiFi.pdf
 *   Decor 26 - odpad.pdf
 *   Decor 26 - úklid.pdf
 */
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { detectRasterStandLabels } from "../lib/pdf/rasterStandLabelDetection.ts";
import { resolveWhiteModeAvailability } from "../lib/pdf/technicalRasterWhiteRender.ts";
import { computeWhiteModeArgsArray, type WhiteModeOpCodes } from "../domain/technicalRasterWhiteModeOperators.ts";
import {
  createTechnicalRasterProject,
  withRasterLayers,
  withRasterStandLabels,
  mergeTechnicalRasterImport,
  type TechnicalRasterImport,
} from "../domain/technicalRaster.ts";
import { getTechnicalReportParser } from "../domain/technicalReportParsers/index.ts";
import { resolveTechnicalServiceProduct } from "../domain/technicalServiceProductMapping.ts";
import { sortStandNumbersNatural } from "../domain/technicalStandNumber.ts";
import type { PdfTextItem } from "../domain/technicalReportTableParsing.ts";

const repoRoot = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const importDir = path.join(repoRoot, "_IMPORT");

const RASTER_FILE = "Hala 1.pdf";
const REPORT_FILES: readonly Readonly<{ category: string; file: string }>[] = [
  { category: "electricity", file: "Decor 26 - elektrická energie.pdf" },
  { category: "internet", file: "Decor 26 - internet, WiFi.pdf" },
  { category: "waste", file: "Decor 26 - odpad.pdf" },
  { category: "cleaning", file: "Decor 26 - úklid.pdf" },
];

function section(title: string): void {
  console.log("\n" + "=".repeat(78));
  console.log(title);
  console.log("=".repeat(78));
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await fn();
  const elapsedMs = performance.now() - start;
  console.log(`  [${elapsedMs.toFixed(1)}ms] ${label}`);
  if (elapsedMs > 5000) console.log(`  ⚠ "${label}" took over 5s — worth a look, though not optimized here (section 24: sanity only).`);
  return result;
}

async function loadPdf(filePath: string) {
  const bytes = await readFile(filePath);
  return pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
}

async function extractItems(doc: Awaited<ReturnType<typeof loadPdf>>): Promise<PdfTextItem[]> {
  const items: PdfTextItem[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
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
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    sizes.set(pageNumber, { widthPt: viewport.width, heightPt: viewport.height, transform: viewport.transform as unknown as readonly [number, number, number, number, number, number] });
  }
  return sizes;
}

async function getLayers(doc: Awaited<ReturnType<typeof loadPdf>>) {
  const config = await doc.getOptionalContentConfig();
  const order = config.getOrder();
  const layers: { id: string; name: string; defaultVisible: boolean }[] = [];
  if (order) {
    for (const id of order) {
      const group = config.getGroup(id);
      if (group) layers.push({ id, name: group.name ?? id, defaultVisible: config.isVisible(id) });
    }
  }
  return layers;
}

async function getWhiteModeOpCodesForScript(): Promise<WhiteModeOpCodes> {
  const OPS = (pdfjsLib as unknown as { OPS: Record<string, number> }).OPS;
  return {
    beginMarkedContentProps: OPS.beginMarkedContentProps!,
    beginMarkedContent: OPS.beginMarkedContent!,
    endMarkedContent: OPS.endMarkedContent!,
    constructPath: OPS.constructPath!,
    rawFillPath: OPS.rawFillPath,
    fillPaintTypes: new Set([OPS.fill!, OPS.eoFill!, OPS.fillStroke!, OPS.eoFillStroke!, OPS.closeFillStroke!, OPS.closeEOFillStroke!]),
    fillColorSetters: new Set([OPS.setFillRGBColor!, OPS.setFillGray!, OPS.setFillCMYKColor!, OPS.setFillColor!]),
    unsupportedFillOps: new Set([OPS.setFillColorN!, OPS.shadingFill!, OPS.paintImageXObject!, OPS.paintImageMaskXObject!, OPS.paintInlineImageXObject!, OPS.paintImageXObjectRepeat!, OPS.paintImageMaskXObjectRepeat!, OPS.paintSolidColorImageMask!]),
  };
}

async function main(): Promise<void> {
  const rasterPath = path.join(importDir, RASTER_FILE);
  const missing = [RASTER_FILE, ...REPORT_FILES.map((r) => r.file)].filter((file) => !existsSync(path.join(importDir, file)));
  if (missing.length > 0) {
    console.log(`Real-file fixtures not found in ${importDir} — skipping (this is expected on a fresh checkout; these are real customer PDFs, never assumed to be committed).`);
    console.log("Missing:", missing.join(", "));
    process.exitCode = 0;
    return;
  }

  section("RASTR: " + RASTER_FILE);
  const rasterDoc = await timed("load + parse Hala 1.pdf", () => loadPdf(rasterPath));
  console.log("  pageCount:", rasterDoc.numPages);

  const rasterItems = await timed("extract text items", () => extractItems(rasterDoc));
  console.log("  text item count:", rasterItems.length);

  const pageSizes = await timed("compute page sizes/transforms", () => getPageSizes(rasterDoc));
  const layers = await timed("read OCG layers", () => getLayers(rasterDoc));
  console.log("  OCG layer count:", layers.length);
  console.log("  OCG layer names:", layers.map((l) => l.name).join(" | "));

  const rasterLabels = detectRasterStandLabels(rasterItems, pageSizes);
  const uniqueNumbers = new Set(rasterLabels.map((l) => l.normalizedStandNumber));
  const byNumber = new Map<string, number>();
  for (const label of rasterLabels) byNumber.set(label.normalizedStandNumber, (byNumber.get(label.normalizedStandNumber) ?? 0) + 1);
  const duplicates = [...byNumber.entries()].filter(([, count]) => count > 1);
  console.log("  detected stand labels count:", rasterLabels.length);
  console.log("  unique stand numbers:", uniqueNumbers.size);
  console.log("  duplicate stand numbers:", duplicates.map(([number, count]) => `${number}(${count}x)`).join(", ") || "(none)");

  const availability = resolveWhiteModeAvailability(layers);
  console.log("  detected stand-layer candidate:", availability.status === "available" ? availability.standLayerId : "(none/ambiguous)");
  console.log("  white-mode availability:", JSON.stringify(availability));

  if (availability.status === "available") {
    const page1 = await rasterDoc.getPage(1);
    const operatorList = await timed("getOperatorList() for white-mode analysis", () => page1.getOperatorList({ intent: "display" }));
    const opCodes = await getWhiteModeOpCodesForScript();
    const patchResult = computeWhiteModeArgsArray(operatorList, availability.standLayerId, opCodes);
    if (patchResult.status === "patched") {
      console.log("  fill operations changed by white mode:", patchResult.patchedIndices.length);
    } else {
      console.log("  white mode NOT applicable:", patchResult.reason);
    }
    const strokeOpCount = operatorList.fnArray.filter((fn) => fn === opCodes.constructPath).length;
    console.log("  total constructPath (paint) operations on page 1 (all left geometrically untouched):", strokeOpCount);
    console.log("  unsupported fill operators found on page 1:", operatorList.fnArray.filter((fn) => opCodes.unsupportedFillOps.has(fn)).length);
  }

  // ==========================================================================
  // IMPORT: the 4 real technical-report PDFs
  // ==========================================================================
  let project = createTechnicalRasterProject({ name: "real-file diagnostic (dev only, never persisted)", hall: "Hala 1" }, "diagnostic", new Date().toISOString());
  project = withRasterLayers(project, layers);
  project = withRasterStandLabels(project, rasterLabels);

  const emptyCatalog: readonly { id: string; internalCode: string }[] = [];
  const resolveProduct = (category: string, externalLabel: string) => resolveTechnicalServiceProduct(category, externalLabel, emptyCatalog);
  let importCounter = 0;

  for (const { category, file } of REPORT_FILES) {
    section(`IMPORT: ${category.toUpperCase()} — ${file}`);
    importCounter += 1;
    const doc = await timed(`load + parse ${file}`, () => loadPdf(path.join(importDir, file)));
    const items = await extractItems(doc);
    const parser = getTechnicalReportParser(category);
    if (!parser) { console.log("  no parser registered for category:", category); continue; }
    const report = parser.parse(items);
    const standsFound = new Set(report.rows.map((r) => r.standNumber)).size;
    const servicesFound = report.rows.reduce((sum, r) => sum + r.services.length, 0);
    const unresolvedCount = report.rows.reduce((sum, r) => sum + r.services.filter((s) => resolveProduct(category, s.externalLabel).status === "unresolved_product").length, 0);
    console.log("  category:", category);
    console.log("  stands:", standsFound);
    console.log("  services:", servicesFound);
    console.log("  warnings:", report.warnings.length);
    for (const warning of report.warnings) console.log("    WARNING:", warning.message);
    console.log("  unresolvedProducts:", unresolvedCount, "(expected: all of them, until a real product mapping is configured)");

    const importRecord: TechnicalRasterImport = {
      id: `diag-import-${importCounter}`,
      category,
      filename: file,
      asset: { id: `diag-asset-${importCounter}`, storageKey: `diagnostic/${importCounter}.pdf`, originalFileName: file, mimeType: "application/pdf", size: 0, createdAt: new Date().toISOString(), category: "technical-raster-import" },
      importedAt: new Date().toISOString(),
      parserVersion: "v1",
      parseStatus: report.warnings.length > 0 ? "ok_with_warnings" : "ok",
      standsFound,
      servicesFound,
      warnings: report.warnings.map((w, i) => ({ id: `diag-w-${importCounter}-${i}`, ...w })),
    };
    project = mergeTechnicalRasterImport(project, importRecord, report, resolveProduct);
  }

  // ==========================================================================
  // MATCH
  // ==========================================================================
  section("MATCH");
  const counts = { matched_auto: 0, unassigned: 0, ambiguous: 0, matched_manual: 0 };
  for (const stand of project.stands) counts[stand.placement.status] += 1;
  console.log("  auto:", counts.matched_auto);
  console.log("  manual:", counts.matched_manual);
  console.log("  ambiguous:", counts.ambiguous);
  console.log("  unassigned:", counts.unassigned);
  console.log("  ambiguous stand numbers:", sortStandNumbersNatural(project.stands.filter((s) => s.placement.status === "ambiguous"), (s) => s.standNumber).map((s) => s.standNumber).join(", ") || "(none)");

  section("KEY REAL-DATA CHECKS (historical expected values — investigate, never hardcode-fix, on divergence)");
  console.log("  Total merged stands:", project.stands.length, "(historical: 20)");
  const stand1B04 = project.stands.find((s) => s.standNumber === "1B04");
  console.log("  1B04 service count:", stand1B04?.services.length ?? "(not found)", "(historical: 5)");
  console.log("  1B04 note count:", stand1B04?.notes.length ?? "(not found)", "(historical: 1)");
  const stand1C01 = project.stands.find((s) => s.standNumber === "1C01");
  const cleaningService = stand1C01?.services.find((s) => s.category === "cleaning");
  console.log("  1C01 Denní úklid quantity:", cleaningService?.quantity, typeof cleaningService?.quantity, "(historical: 40, number)");

  console.log("\nDONE.");
}

main().catch((error) => {
  console.error("Real-file diagnostic harness failed:", error);
  process.exitCode = 1;
});
