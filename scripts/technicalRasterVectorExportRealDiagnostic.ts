/**
 * Technické rastry — TRUE VECTOR PDF export real-file diagnostic (spec batch 9 section 28/31/32).
 * Runs the ACTUAL production pipeline (lib/technicalRasterVectorPdf.ts) against the real
 * `_IMPORT/Hala 1.pdf` fixture with a representative set of 1B04 placements (6 kW, lednicový
 * okruh, internet — the exact example the spec itself gives), then verifies — never just "opens
 * visually" — that the exported PDF is genuinely vector: real text/vector operators, zero
 * full-page image XObjects, source text still present/selectable, and reports the OCG/layers
 * facts honestly (spec section 32: never claim layers survived without checking).
 *
 * Skip-safe, same discipline as scripts/technicalRasterRealDiagnostic.ts: a fresh checkout without
 * the real `_IMPORT/Hala 1.pdf` customer file exits 0 with a clear message, never fails CI.
 *
 * Usage:
 *   node --no-warnings scripts/technicalRasterVectorExportRealDiagnostic.ts
 *   npm run test:technical-raster-vector-export-real
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFName, PDFDict } from "pdf-lib";
import { buildTechnicalRasterVectorExportPdf } from "../lib/technicalRasterVectorPdf.ts";
import { buildTechnicalRasterExportLegend } from "../domain/technicalRasterExport.ts";
import { resolveTechnicalServicePresentation } from "../domain/technicalRasterServicePresentation.ts";
import type { TechnicalRasterExportPlacementItem } from "../domain/technicalRasterExport.ts";

const repoRoot = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const rasterPath = path.join(repoRoot, "_IMPORT", "Hala 1.pdf");
const outPath = path.join(repoRoot, "_IMPORT", "_technicalRasterVectorExportDiagnostic.pdf");

function section(title: string): void {
  console.log("\n" + "=".repeat(78));
  console.log(title);
  console.log("=".repeat(78));
}

async function main(): Promise<void> {
  if (!existsSync(rasterPath)) {
    console.log(`Real-file fixture not found at ${rasterPath} — skipping (real customer PDF, never committed).`);
    process.exitCode = 0;
    return;
  }

  const sourcePdfBytes = new Uint8Array(await readFile(rasterPath));

  const placements: TechnicalRasterExportPlacementItem[] = [
    { standId: "diag-1B04", standNumber: "1B04", serviceId: "svc-1", placementId: "p-1", xNormalized: 0.3, yNormalized: 0.35, presentation: resolveTechnicalServicePresentation("electricity", "Do 6kW 230V") },
    { standId: "diag-1B04", standNumber: "1B04", serviceId: "svc-2", placementId: "p-2", xNormalized: 0.32, yNormalized: 0.35, presentation: resolveTechnicalServicePresentation("electricity", "Lednicový okruh") },
    { standId: "diag-1B04", standNumber: "1B04", serviceId: "svc-3", placementId: "p-3", xNormalized: 0.34, yNormalized: 0.35, presentation: resolveTechnicalServicePresentation("internet", "Internet") },
  ];
  const legend = buildTechnicalRasterExportLegend(placements);

  section("BUILDING VECTOR EXPORT — 1B04: 6 kW, lednicový okruh, internet");
  const { bytes, ocgDiagnostic } = await buildTechnicalRasterVectorExportPdf({
    sourcePdfBytes,
    page: 1,
    placements,
    legend,
    showLegend: true,
    headerLine: "Technický rastr / FOR DECOR 2026 / Hala 1",
  });
  console.log("exported bytes:", bytes.length);
  await writeFile(outPath, bytes);
  console.log("wrote", outPath, "(gitignored _IMPORT/, open manually to visually verify)");

  section("VECTORNESS CHECKS");
  const reloadedLib = await PDFDocument.load(bytes);
  console.log("page count:", reloadedLib.getPageCount());
  const page1 = reloadedLib.getPage(0);
  console.log("page1 size:", page1.getWidth(), "x", page1.getHeight(), "pt");
  console.log("page1 rotation:", page1.getRotation().angle);
  const resources = page1.node.lookup(PDFName.of("Resources"));
  const xobjects = resources instanceof PDFDict ? resources.lookup(PDFName.of("XObject")) : undefined;
  const xobjectCount = xobjects instanceof PDFDict ? xobjects.keys().length : 0;
  console.log("page1 image XObject count:", xobjectCount, xobjectCount === 0 ? "(confirmed: NOT a rasterized replacement)" : "(!!! unexpected raster content)");

  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loaded = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
  const page = await loaded.getPage(1);
  const opList = await page.getOperatorList();
  console.log("page1 operator count:", opList.fnArray.length);
  const textContent = await page.getTextContent();
  console.log("page1 text item count:", textContent.items.length);
  const joined = (textContent.items as { str: string }[]).map((item) => item.str).join(" ");
  for (const needle of ["HALA 1", "FOR DECOR"]) {
    console.log(`  text contains "${needle}":`, joined.includes(needle));
  }
  console.log("  sample overlay-adjacent text (kW/IP/INT labels expected among source text):", joined.includes("6 kW") ? "found '6 kW' overlay label" : "NOT FOUND — check overlay drawing");

  section("OCG / LAYERS DIAGNOSTIC");
  console.log("source OCG count:", ocgDiagnostic.sourceOcgCount);
  console.log("reconstructed OCG count:", ocgDiagnostic.reconstructedOcgCount);
  console.log("reconstructed OCG names:", ocgDiagnostic.reconstructedOcgNames);
  console.log("unmatched OCG names:", ocgDiagnostic.unmatchedOcgNames);
  const ocConfig = await loaded.getOptionalContentConfig();
  const order = ocConfig.getOrder();
  console.log("pdf.js-visible OCG count on the EXPORTED file:", order ? order.length : 0);

  section("DONE — open the written PDF manually to visually confirm symbols/legend/text selectability.");
}

void main();
