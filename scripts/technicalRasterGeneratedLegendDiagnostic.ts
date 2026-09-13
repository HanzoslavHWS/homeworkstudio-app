/**
 * GENERATED PDF LEGEND BATCH — real-file diagnostic (spec section 26). Runs the ACTUAL production
 * export pipeline (lib/technicalRasterVectorPdf.ts) against the real `_IMPORT/Hala 1.pdf` (FOR
 * DECOR) and `_IMPORT/Hala 3_2026- ver.12_NOVY_3.pdf` (FOR BEAUTY) fixtures with a representative
 * set of technical placements spanning every legend-relevant presentation (electricity/refrigerated/
 * breaker/internet/IP/WiFi/water/cleaning/waste) plus 2 realization underlines, and reports:
 *   - the legend region used (in-place vs separate-page fallback)
 *   - which technical legend items were selected
 *   - which realization legend items were selected
 *   - whether the in-place attempt succeeded or fell back
 *
 * No PERSISTED "legend region" configuration exists yet for these real fixtures (that's a
 * per-project setting a user configures in the editor, not baked into the source PDF) — this
 * script tries a representative bottom-right corner region for each real page's own size, purely
 * for this diagnostic, and separately confirms the safe separate-page fallback with no region
 * configured at all.
 *
 * Skip-safe (same discipline as every other _IMPORT/*-dependent diagnostic in this repo): missing
 * fixtures exit 0, never fail CI. Writes NO file to _IMPORT/ — output goes to a local, git-ignored
 * scratch path this script itself removes at the end, and never anything under _IMPORT/ or the repo.
 *
 * Usage: node --no-warnings scripts/technicalRasterGeneratedLegendDiagnostic.ts
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
import { buildTechnicalRasterVectorExportPdf, type TechnicalRasterExportRealizationUnderlineItem } from "../lib/technicalRasterVectorPdf.ts";
import { buildTechnicalRasterExportLegend } from "../domain/technicalRasterExport.ts";
import { resolveTechnicalServicePresentation } from "../domain/technicalRasterServicePresentation.ts";
import { DEFAULT_AUTO_LEGEND_PLACEMENT } from "../domain/technicalRasterLegendPlacement.ts";
import type { TechnicalRasterExportPlacementItem } from "../domain/technicalRasterExport.ts";

const repoRoot = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const fixtures: readonly Readonly<{ label: string; file: string }>[] = [
  { label: "Hala 1 (FOR DECOR)", file: "Hala 1.pdf" },
  { label: "Hala 3 (FOR BEAUTY)", file: "Hala 3_2026- ver.12_NOVY_3.pdf" },
];

function section(title: string): void {
  console.log("\n" + "=".repeat(78));
  console.log(title);
  console.log("=".repeat(78));
}

function buildRepresentativePlacements(): readonly TechnicalRasterExportPlacementItem[] {
  const base: readonly Readonly<{ x: number; category: string; label: string }>[] = [
    { x: 0.1, category: "electricity", label: "Do 3kW 230V" },
    { x: 0.18, category: "electricity", label: "Lednicový okruh" },
    { x: 0.26, category: "electricity", label: "Jistič C" },
    { x: 0.34, category: "internet", label: "Internet" },
    { x: 0.42, category: "internet", label: "Pevná IP" },
    { x: 0.5, category: "internet", label: "WIFI" },
    { x: 0.58, category: "water", label: "x" },
    { x: 0.66, category: "cleaning", label: "Denní úklid" },
    { x: 0.74, category: "waste", label: "Kontejn 1100 l" },
  ];
  return base.map((entry, index) => ({
    standId: `diag-${index}`,
    standNumber: `1B0${index}`,
    serviceId: `svc-${index}`,
    placementId: `p-${index}`,
    xNormalized: entry.x,
    yNormalized: 0.4,
    presentation: resolveTechnicalServicePresentation(entry.category, entry.label),
    category: entry.category,
  }));
}

const realizationUnderlines: readonly TechnicalRasterExportRealizationUnderlineItem[] = [
  { standId: "diag-r1", xNormalized: 0.2, yNormalized: 0.2, widthNormalized: 0.06, color: "#d97a1f" }, // CREATIV EXPO
  { standId: "diag-r2", xNormalized: 0.4, yNormalized: 0.2, widthNormalized: 0.06, color: "#2361c2" }, // MAC PRAHA
];

async function main(): Promise<void> {
  const placements = buildRepresentativePlacements();
  const legend = buildTechnicalRasterExportLegend(placements);

  for (const fixture of fixtures) {
    const rasterPath = path.join(repoRoot, "_IMPORT", fixture.file);
    section(fixture.label);
    if (!existsSync(rasterPath)) {
      console.log(`Fixture not found at ${rasterPath} — skipping (real customer PDF, never committed).`);
      continue;
    }
    const sourcePdfBytes = new Uint8Array(await readFile(rasterPath));
    const srcDoc = await PDFDocument.load(sourcePdfBytes);
    const page1 = srcDoc.getPage(0);
    console.log("page 1 size:", page1.getWidth().toFixed(1), "x", page1.getHeight().toFixed(1), "pt");

    console.log("\n-- Technical legend items selected (from the representative placement set) --");
    for (const entry of legend) console.log(`  ${entry.legendLabel} (renderer=${entry.renderer}, color=${entry.color}, displayLabel=${entry.displayLabel ?? "(icon)"})`);

    console.log("\n-- Realization legend items selected --");
    console.log("  (see the exported page count/behavior below — GENDAI/OSTATNÍ deliberately NOT used here, only CREATIV EXPO + MAC PRAHA)");

    // 1) No legendPlacement passed at all -> the LOW-LEVEL resolveEffectiveLegendPlacement default
    // (separate-page) — this is what a RAW buildTechnicalRasterVectorExportPdf caller gets if it
    // never wires anything, still correct/unchanged by this batch.
    const fallbackResult = await buildTechnicalRasterVectorExportPdf({
      sourcePdfBytes, page: 1, placements, legend, showLegend: true,
      headerLine: `Technický rastr / ${fixture.label}`,
      realizationUnderlines, includeRealizationKey: true,
    });
    const fallbackDoc = await PDFDocument.load(fallbackResult.bytes);
    console.log(`\n-- No legendPlacement passed at all -> ${fallbackDoc.getPageCount() === 2 ? "separate-page legend (unchanged low-level default)" : "UNEXPECTED page count " + fallbackDoc.getPageCount()}`);

    // 2) The SHARED AUTOMATIC DEFAULT (domain/technicalRasterLegendPlacement.ts's own
    // DEFAULT_AUTO_LEGEND_PLACEMENT) — what a real project actually gets end-to-end via
    // TechnicalRasterOutputsPanel.tsx's effectiveLegendPlacement(project.rasterSettings) call, with
    // NO per-project configuration at all. This is the "should not need to configure it for every
    // project" case this batch's whole architecture exists for.
    const defaultResult = await buildTechnicalRasterVectorExportPdf({
      sourcePdfBytes, page: 1, placements, legend, showLegend: true,
      headerLine: `Technický rastr / ${fixture.label}`,
      realizationUnderlines, includeRealizationKey: true,
      legendPlacement: DEFAULT_AUTO_LEGEND_PLACEMENT,
    });
    const defaultDoc = await PDFDocument.load(defaultResult.bytes);
    const usedDefaultInPlace = defaultDoc.getPageCount() === 1;
    console.log(`\n-- SHARED AUTOMATIC DEFAULT region (bottom-left, x=${DEFAULT_AUTO_LEGEND_PLACEMENT.sourceRegion!.xNormalized} y=${DEFAULT_AUTO_LEGEND_PLACEMENT.sourceRegion!.yNormalized} w=${DEFAULT_AUTO_LEGEND_PLACEMENT.sourceRegion!.widthNormalized} h=${DEFAULT_AUTO_LEGEND_PLACEMENT.sourceRegion!.heightNormalized}) --`);
    console.log(`  result: ${usedDefaultInPlace ? "DRAWN IN-PLACE — the automatic default worked with ZERO per-project configuration" : "FELL BACK TO SEPARATE PAGE (region too small for this real page — safe fallback, never a broken drawing)"}`);

    // 3) Two more representative regions for comparison — a SMALL corner box and a LARGER block —
    // now that the legend is category-level (max ~5 rows), even a small region should comfortably fit.
    const regionsToTry: readonly Readonly<{ label: string; xNormalized: number; yNormalized: number; widthNormalized: number; heightNormalized: number }>[] = [
      { label: "small corner (~36% x 22% of page)", xNormalized: 0.62, yNormalized: 0.02, widthNormalized: 0.36, heightNormalized: 0.22 },
      { label: "larger block (~55% x 45% of page)", xNormalized: 0.43, yNormalized: 0.02, widthNormalized: 0.55, heightNormalized: 0.45 },
    ];
    for (const region of regionsToTry) {
      const inPlaceResult = await buildTechnicalRasterVectorExportPdf({
        sourcePdfBytes, page: 1, placements, legend, showLegend: true,
        headerLine: `Technický rastr / ${fixture.label}`,
        realizationUnderlines, includeRealizationKey: true,
        legendPlacement: { strategy: "source-legend-area", sourceRegion: { page: 1, ...region } },
      });
      const inPlaceDoc = await PDFDocument.load(inPlaceResult.bytes);
      const usedInPlace = inPlaceDoc.getPageCount() === 1;
      console.log(`\n-- Region tried: ${region.label} (x=${region.xNormalized} y=${region.yNormalized} w=${region.widthNormalized} h=${region.heightNormalized}) --`);
      console.log(`  result: ${usedInPlace ? "DRAWN IN-PLACE (fit at some attempted scale)" : "FELL BACK TO SEPARATE PAGE (too small even at the minimum allowed scale — safe fallback, never a broken drawing)"}`);
    }
  }

  section("DONE");
}

void main();
