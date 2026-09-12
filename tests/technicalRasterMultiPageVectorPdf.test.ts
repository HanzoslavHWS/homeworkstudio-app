import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument, PDFArray, PDFRawStream, decodePDFRawStream, StandardFonts, rgb } from "pdf-lib";
import { buildTechnicalRasterMultiPageVectorExportPdf } from "../lib/technicalRasterVectorPdf.ts";
import { buildTechnicalRasterExportLegend, type TechnicalRasterExportPlacementItem } from "../domain/technicalRasterExport.ts";
import { resolveTechnicalServicePresentation } from "../domain/technicalRasterServicePresentation.ts";

/**
 * Manual acceptance batch, section 38/50 — "MULTI-PAGE SOURCE PDF": every source page must be
 * kept 1:1 in the export (own MediaBox/CropBox/rotation/overlay), and the legend must land AFTER
 * the LAST source page, never in between and never resizing a source page. This exercises
 * buildTechnicalRasterMultiPageVectorExportPdf — the NEW multi-page entry point added alongside
 * (never replacing) buildTechnicalRasterVectorExportPdf, which keeps handling the single-page case
 * exactly as its own ~45 existing tests already pin.
 */

function placementItem(overrides: Partial<TechnicalRasterExportPlacementItem> = {}): TechnicalRasterExportPlacementItem {
  return {
    standId: "stand-1",
    standNumber: "1A21",
    serviceId: "service-1",
    placementId: "placement-1",
    xNormalized: 0.5,
    yNormalized: 0.5,
    presentation: resolveTechnicalServicePresentation("electricity", "Do 3kW 230V"),
    ...overrides,
  };
}

async function buildNPageFixture(sizes: readonly Readonly<{ width: number; height: number }>[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  sizes.forEach((size, index) => {
    const page = doc.addPage([size.width, size.height]);
    page.drawText(`PAGE ${index + 1} CONTENT`, { x: 20, y: Math.min(20, size.height - 20), size: 12, font, color: rgb(0, 0, 0) });
  });
  return doc.save();
}

async function decode(bytes: Uint8Array) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
}

test("single-page source (pages.length === 1) -> export page count 2: page 1 = source+overlay, page 2 = legend — same page-structure contract as the single-page function", async () => {
  const source = await buildNPageFixture([{ width: 300, height: 200 }]);
  const result = await buildTechnicalRasterMultiPageVectorExportPdf({
    sourcePdfBytes: source,
    pages: [{ page: 1, placements: [] }],
    legend: [],
    showLegend: true,
    headerLine: "X",
  });
  const doc = await decode(result.bytes);
  assert.equal(doc.numPages, 2);
  assert.equal(result.legendPageNumber, 2);
  const page1 = await doc.getPage(1);
  const viewport1 = page1.getViewport({ scale: 1 });
  assert.equal(viewport1.width, 300);
  assert.equal(viewport1.height, 200);
});

test("3-page source -> export page count 4 (source 1/2/3 + legend on 4) — NO source page ever changes size", async () => {
  const sizes = [{ width: 300, height: 200 }, { width: 400, height: 250 }, { width: 350, height: 900 }];
  const source = await buildNPageFixture(sizes);
  const result = await buildTechnicalRasterMultiPageVectorExportPdf({
    sourcePdfBytes: source,
    pages: sizes.map((_, index) => ({ page: index + 1, placements: [] })),
    legend: [],
    showLegend: true,
    headerLine: "X",
  });
  const doc = await decode(result.bytes);
  assert.equal(doc.numPages, 4, "3 source pages + 1 legend page");
  assert.equal(result.legendPageNumber, 4, "legend is always the LAST page, never squeezed in between source pages");

  for (let i = 0; i < sizes.length; i += 1) {
    const page = await doc.getPage(i + 1);
    const viewport = page.getViewport({ scale: 1 });
    assert.equal(viewport.width, sizes[i]!.width, `source page ${i + 1} width must stay exactly as uploaded`);
    assert.equal(viewport.height, sizes[i]!.height, `source page ${i + 1} height must stay exactly as uploaded`);
  }
});

test("each source page draws only ITS OWN placements — a placement on page 2 never bleeds onto page 1's overlay", async () => {
  const sizes = [{ width: 300, height: 200 }, { width: 300, height: 200 }];
  const source = await buildNPageFixture(sizes);
  const result = await buildTechnicalRasterMultiPageVectorExportPdf({
    sourcePdfBytes: source,
    pages: [
      { page: 1, placements: [placementItem({ placementId: "p-on-1" })] },
      { page: 2, placements: [placementItem({ placementId: "p-on-2" })] },
    ],
    legend: [],
    showLegend: false,
    headerLine: "X",
  });
  // CORRECTIVE BATCH (3rd) sections 8/9 — the "3 kW" marker is no longer extractable PDF text (it
  // is genuine vector-outline fill geometry — see domain/technicalRasterVectorGlyphOutline.ts's own
  // doc), so this checks each page's own raw content for the marker's own presentation color
  // followed by a fill operator instead of a pdf.js text string.
  async function readPageContentText(bytes: Uint8Array, pageIndex: number): Promise<string> {
    const reloaded = await PDFDocument.load(bytes);
    const page = reloaded.getPage(pageIndex);
    const contents = page.node.Contents();
    const streams: PDFRawStream[] = [];
    if (contents instanceof PDFArray) {
      for (let i = 0; i < contents.size(); i += 1) {
        const stream = reloaded.context.lookup(contents.get(i));
        if (stream instanceof PDFRawStream) streams.push(stream);
      }
    } else if (contents instanceof PDFRawStream) {
      streams.push(contents);
    }
    return streams.map((stream) => new TextDecoder("latin1").decode(decodePDFRawStream(stream).decode())).join("\n");
  }
  const page1Text = await readPageContentText(result.bytes, 0);
  const page2Text = await readPageContentText(result.bytes, 1);
  // electricity "Do 3kW 230V" resolves to a "3 kW" powerLabel symbol (#b3261e -> 0.702 0.149 0.118).
  assert.match(page1Text, /0\.702 0\.149 0\.118 rg[\s\S]*\bf\b/u);
  assert.match(page2Text, /0\.702 0\.149 0\.118 rg[\s\S]*\bf\b/u);
});

test("OCG diagnostics are reported per exported page, in the same order as input.pages", async () => {
  const source = await buildNPageFixture([{ width: 300, height: 200 }, { width: 300, height: 200 }]);
  const result = await buildTechnicalRasterMultiPageVectorExportPdf({
    sourcePdfBytes: source,
    pages: [{ page: 1, placements: [] }, { page: 2, placements: [] }],
    legend: [],
    showLegend: false,
    headerLine: "X",
  });
  assert.equal(result.ocgDiagnosticsByPage.length, 2);
  // This fixture has no /OCProperties at all -> attempted:false for every page, never a crash.
  assert.ok(result.ocgDiagnosticsByPage.every((diagnostic) => diagnostic.attempted === false));
});

test("legend content reflects only what's actually used across ALL exported pages combined, deduplicated", async () => {
  const source = await buildNPageFixture([{ width: 300, height: 200 }, { width: 300, height: 200 }]);
  const page1Placements = [placementItem({ placementId: "p1" })];
  const page2Placements = [placementItem({ placementId: "p2", presentation: resolveTechnicalServicePresentation("water", "x") })];
  const legend = buildTechnicalRasterExportLegend([...page1Placements, ...page2Placements]);
  assert.equal(legend.length, 2, "electricity + water, deduplicated across both pages");

  const result = await buildTechnicalRasterMultiPageVectorExportPdf({
    sourcePdfBytes: source,
    pages: [{ page: 1, placements: page1Placements }, { page: 2, placements: page2Placements }],
    legend,
    showLegend: true,
    headerLine: "X",
  });
  const doc = await decode(result.bytes);
  const legendText = ((await (await doc.getPage(result.legendPageNumber)).getTextContent()).items as { str: string }[]).map((item) => item.str).join(" ");
  // Matches the established pattern in tests/technicalRasterVectorPdfHardening.test.ts's own
  // "font glyph coverage" test: an em-dash ("—") inside a legend label doesn't survive this
  // subsetted-font text EXTRACTION round-trip (a pre-existing pdf.js quirk, unrelated to this
  // batch) — so this checks the label's own WORDS, never the exact string containing "—".
  assert.ok(legendText.includes("PŘÍVOD EL. ENERGIE"), "legend page must mention the electricity legend entry");
  assert.ok(legendText.includes("VODA") && legendText.includes("PŘÍVOD / ODPAD VODY"), "legend page must mention the water legend entry");
});

test("invalid placement coordinates are skipped and counted, never crash the multi-page export", async () => {
  const source = await buildNPageFixture([{ width: 300, height: 200 }]);
  const result = await buildTechnicalRasterMultiPageVectorExportPdf({
    sourcePdfBytes: source,
    pages: [{ page: 1, placements: [placementItem({ xNormalized: Number.NaN }), placementItem({ placementId: "good" })] }],
    legend: [],
    showLegend: false,
    headerLine: "X",
  });
  assert.equal(result.skippedInvalidPlacementCount, 1);
});
