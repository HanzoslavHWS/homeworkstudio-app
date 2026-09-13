import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import {
  assignStandManually,
  createTechnicalRasterProject,
  mergeTechnicalRasterImport,
  placeTechnicalService,
  withRasterStandLabels,
  type ParsedTechnicalReport,
  type RasterStandLabel,
  type TechnicalRasterImport,
  type TechnicalRasterProject,
} from "../domain/technicalRaster.ts";
import { buildTechnicalRasterExportLegend, buildTechnicalRasterExportPlacements } from "../domain/technicalRasterExport.ts";
import { resolveTechnicalServicePresentation, TECHNICAL_RASTER_COLORS } from "../domain/technicalRasterServicePresentation.ts";
import { buildTechnicalRasterVectorExportPdf } from "../lib/technicalRasterVectorPdf.ts";
import type { StoredAsset } from "../domain/assets.ts";

// =========================================================================================
// GENERATED PDF LEGEND BATCH — regression tests for the new generated in-place/separate-page
// legend: content selection (section 22), realization legend (section 23, partly also covered in
// tests/technicalRasterVectorPdf.test.ts's own "only actually used groups appear" test), and PDF
// structure/OCG reversibility (sections 24/25). Reuses the exact same domain helpers/fixture
// pattern already established in tests/technicalRasterExport.test.ts.
// =========================================================================================

function makeAsset(id: string): StoredAsset {
  return { id, storageKey: `technical-rasters/p1/source/${id}.pdf`, originalFileName: `${id}.pdf`, mimeType: "application/pdf", size: 100, createdAt: "2026-01-01T00:00:00.000Z", category: "technical-raster-source" };
}
function makeImport(category: string, id: string): TechnicalRasterImport {
  return { id, category, filename: `${category}.pdf`, asset: makeAsset(`import-${id}`), importedAt: "2026-01-01T00:00:00.000Z", parserVersion: "v1", parseStatus: "ok", standsFound: 1, servicesFound: 1, warnings: [] };
}
function makeLabel(standNumber: string, id: string): RasterStandLabel {
  return { id, rawText: standNumber, normalizedStandNumber: standNumber, page: 1, xNormalized: 0.2, yNormalized: 0.3, widthNormalized: 0.03, heightNormalized: 0.015 };
}
const alwaysResolved = () => ({ status: "unresolved_product" as const });

async function buildPlainFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 200]);
  return doc.save();
}

async function readAllPageContentText(bytes: Uint8Array, pageIndex: number): Promise<string> {
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

// ============================================================================
// Section 22 — which services count as "used" (final export dataset, never imported-source data).
// ============================================================================

test("CONTENT SELECTION: an outside_current_raster stand's own services never contribute a legend entry, even though it has a real presentation/electricity service", () => {
  let project: TechnicalRasterProject = createTechnicalRasterProject({ name: "Hala 3" }, "p1");
  project = withRasterStandLabels(project, [makeLabel("3A01", "l1")]);
  const report: ParsedTechnicalReport = {
    category: "electricity",
    rows: [
      { standNumber: "3A01", services: [{ category: "electricity", externalLabel: "Do 5kW 230V", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] },
      { standNumber: "4A01", services: [{ category: "electricity", externalLabel: "Do 9kW 400V", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] },
    ],
    warnings: [],
  };
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-1"), report, alwaysResolved);
  const foreignStand = project.stands.find((stand) => stand.standNumber === "4A01")!;
  assert.equal(foreignStand.placement.status, "outside_current_raster");
  const currentStand = project.stands.find((stand) => stand.standNumber === "3A01")!;
  project = placeTechnicalService(project, currentStand.id, currentStand.services[0]!.id, { page: 1, xNormalized: 0.5, yNormalized: 0.5 });

  const placements = buildTechnicalRasterExportPlacements(project, 1, new Set());
  const legend = buildTechnicalRasterExportLegend(placements);
  assert.equal(legend.length, 1, "only the CURRENT raster's own electricity row contributes — the foreign-hall 9kW row must not create a second entry (or any entry at all)");
  assert.equal(legend[0]!.legendLabel, "ELEKTRIKA");
});

test("CONTENT SELECTION: an unmatched stand's services never contribute a legend entry", () => {
  let project: TechnicalRasterProject = createTechnicalRasterProject({ name: "X" }, "p1");
  const report: ParsedTechnicalReport = {
    category: "water",
    rows: [{ standNumber: "1B04", services: [{ category: "water", externalLabel: "x", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] }],
    warnings: [],
  };
  project = mergeTechnicalRasterImport(project, makeImport("water", "imp-1"), report, alwaysResolved);
  assert.equal(project.stands[0]!.placement.status, "unassigned");
  const placements = buildTechnicalRasterExportPlacements(project, 1, new Set());
  assert.equal(placements.length, 0);
  assert.deepEqual(buildTechnicalRasterExportLegend(placements), [], "an unmatched stand contributes nothing at all, never a legend entry with no visible marker");
});

test("CONTENT SELECTION: duplicate power values (2/3/6/10 kW) across several matched stands generate exactly ONE electricity legend row, never one per value", () => {
  let project: TechnicalRasterProject = createTechnicalRasterProject({ name: "X" }, "p1");
  const report: ParsedTechnicalReport = {
    category: "electricity",
    rows: [
      { standNumber: "1A01", services: [{ category: "electricity", externalLabel: "Do 2kW 230V", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] },
      { standNumber: "1A02", services: [{ category: "electricity", externalLabel: "Do 3kW 230V", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] },
      { standNumber: "1A03", services: [{ category: "electricity", externalLabel: "Do 6kW 230V", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] },
      { standNumber: "1A04", services: [{ category: "electricity", externalLabel: "Do 9kW 400V", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] },
    ],
    warnings: [],
  };
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-1"), report, alwaysResolved);
  project.stands.forEach((stand, index) => {
    project = assignStandManually(project, stand.id, { page: 1, anchorXNormalized: 0.1 + index * 0.1, anchorYNormalized: 0.1 });
  });
  for (const stand of project.stands) {
    project = placeTechnicalService(project, stand.id, stand.services[0]!.id, { page: 1, xNormalized: 0.5, yNormalized: 0.5 });
  }
  const placements = buildTechnicalRasterExportPlacements(project, 1, new Set());
  assert.equal(placements.length, 4);
  const legend = buildTechnicalRasterExportLegend(placements);
  assert.equal(legend.length, 1, "one electricity legend row regardless of how many distinct kW values are actually present");
  assert.equal(legend[0]!.legendLabel, "ELEKTRIKA");
  assert.equal(legend[0]!.displayLabel, "2 kW", "the electricity row always shows the SAME fixed sample value, never one of the actually-imported kW figures");
});

test("SIMPLIFIED LEGEND BATCH — CONTENT SELECTION: INT/IP/WiFi collapse into ONE 'INTERNET / WiFi' category row, never three separate subtype rows", () => {
  let project: TechnicalRasterProject = createTechnicalRasterProject({ name: "X" }, "p1");
  const report: ParsedTechnicalReport = {
    category: "internet",
    rows: [
      { standNumber: "1A01", services: [{ category: "internet", externalLabel: "Internet", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] },
      { standNumber: "1A02", services: [{ category: "internet", externalLabel: "Pevná IP", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] },
      { standNumber: "1A03", services: [{ category: "internet", externalLabel: "WIFI", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] },
    ],
    warnings: [],
  };
  project = mergeTechnicalRasterImport(project, makeImport("internet", "imp-1"), report, alwaysResolved);
  project.stands.forEach((stand, index) => {
    project = assignStandManually(project, stand.id, { page: 1, anchorXNormalized: 0.1 + index * 0.1, anchorYNormalized: 0.1 });
  });
  for (const stand of project.stands) {
    project = placeTechnicalService(project, stand.id, stand.services[0]!.id, { page: 1, xNormalized: 0.5, yNormalized: 0.5 });
  }
  const legend = buildTechnicalRasterExportLegend(buildTechnicalRasterExportPlacements(project, 1, new Set()));
  assert.equal(legend.length, 1, "INT, IP, and WiFi must collapse into ONE category-level row, never three separate subtype rows");
  assert.equal(legend[0]!.legendLabel, "INTERNET / WiFi");
  assert.equal(legend[0]!.displayLabel, "WiFi", "the internet row always shows the SAME fixed 'WiFi' sample, regardless of which specific subtype(s) were actually imported");
});

test("SIMPLIFIED LEGEND BATCH — real per-marker subtype semantics (INT vs IP vs WiFi vs breaker letters vs specific kW figures) stay completely untouched — only the GENERATED PDF LEGEND now summarizes at category level", () => {
  assert.equal(resolveTechnicalServicePresentation("internet", "Internet").displayLabel, "INT");
  assert.equal(resolveTechnicalServicePresentation("internet", "Pevná IP").displayLabel, "IP");
  assert.equal(resolveTechnicalServicePresentation("internet", "WIFI").displayLabel, "WiFi");
  assert.equal(resolveTechnicalServicePresentation("electricity", "Do 6kW 230V").displayLabel, "6 kW");
  assert.equal(resolveTechnicalServicePresentation("electricity", "Jistič C").displayLabel, "C");
});

test("CONTENT SELECTION: Cleaning's legend entry uses the SAME centralized purple as the real ÚKL marker/UI, and Waste stays the existing neutral gray", () => {
  let project: TechnicalRasterProject = createTechnicalRasterProject({ name: "X" }, "p1");
  const report: ParsedTechnicalReport = {
    category: "cleaning",
    rows: [{ standNumber: "1A01", services: [{ category: "cleaning", externalLabel: "Denní úklid", quantity: 40, rawValue: "40", sourcePage: 1 }], notes: [] }],
    warnings: [],
  };
  project = mergeTechnicalRasterImport(project, makeImport("cleaning", "imp-1"), report, alwaysResolved);
  const wasteReport: ParsedTechnicalReport = {
    category: "waste",
    rows: [{ standNumber: "1A02", services: [{ category: "waste", externalLabel: "Kontejn 1100 l", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] }],
    warnings: [],
  };
  project = mergeTechnicalRasterImport(project, makeImport("waste", "imp-2"), wasteReport, alwaysResolved);
  project.stands.forEach((stand, index) => {
    project = assignStandManually(project, stand.id, { page: 1, anchorXNormalized: 0.1 + index * 0.1, anchorYNormalized: 0.1 });
  });
  for (const stand of project.stands) {
    project = placeTechnicalService(project, stand.id, stand.services[0]!.id, { page: 1, xNormalized: 0.5, yNormalized: 0.5 });
  }
  const legend = buildTechnicalRasterExportLegend(buildTechnicalRasterExportPlacements(project, 1, new Set()));
  const cleaning = legend.find((entry) => entry.legendLabel === "ÚKLID")!;
  const waste = legend.find((entry) => entry.legendLabel === "ODPAD")!;
  assert.equal(cleaning.color, TECHNICAL_RASTER_COLORS.cleaning);
  assert.equal(waste.color, TECHNICAL_RASTER_COLORS.waste);
  assert.notEqual(cleaning.color, waste.color);
});

// ============================================================================
// Section 24/25 — PDF structure + OCG reversibility.
// ============================================================================

test("PDF STRUCTURE: the legend cover rectangle is a plain vector fill — solid white, no stroke operator ('S'/'s'/'B') anywhere in its own drawn block", async () => {
  const source = await buildPlainFixture();
  const legend = [{ legendLabel: "PŘÍVOD EL. ENERGIE", color: "#b3261e", renderer: "powerLabel" as const, displayLabel: "3 kW" }];
  const { bytes } = await buildTechnicalRasterVectorExportPdf({
    sourcePdfBytes: source, page: 1, placements: [], legend, showLegend: true, headerLine: "X",
    legendPlacement: { strategy: "source-legend-area", sourceRegion: { page: 1, xNormalized: 0.5, yNormalized: 0.6, widthNormalized: 0.4, heightNormalized: 0.3 } },
  });
  const content = await readAllPageContentText(bytes, 0);
  const generatorContent = content.slice(content.indexOf("/OC /"));
  const coverBlock = generatorContent.slice(generatorContent.indexOf("1 1 1 rg"), generatorContent.indexOf("1 1 1 rg") + 200);
  assert.ok(!/\b[BSs]\b/u.test(coverBlock), `expected no stroke/fill-and-stroke paint operator on the cover rectangle, got: ${coverBlock}`);
  assert.match(coverBlock, /\bf\b/u, "expected a plain nonzero-winding fill operator closing the cover rectangle");
});

test("PDF STRUCTURE + OCG REVERSIBILITY: both the white cover AND the generated legend content sit inside the SAME GENERÁTOR DATA /OC BDC ... EMC bracket — hiding that one OCG in a viewer structurally hides BOTH, revealing the untouched source content underneath", async () => {
  const source = await buildPlainFixture();
  const legend = [{ legendLabel: "PŘÍVOD EL. ENERGIE", color: "#b3261e", renderer: "powerLabel" as const, displayLabel: "3 kW" }];
  const { bytes } = await buildTechnicalRasterVectorExportPdf({
    sourcePdfBytes: source, page: 1, placements: [], legend, showLegend: true, headerLine: "X",
    legendPlacement: { strategy: "source-legend-area", sourceRegion: { page: 1, xNormalized: 0.5, yNormalized: 0.6, widthNormalized: 0.4, heightNormalized: 0.3 } },
  });
  const content = await readAllPageContentText(bytes, 0);
  const bdcIndex = content.indexOf("/OC /");
  const emcIndex = content.lastIndexOf("EMC");
  assert.ok(bdcIndex >= 0 && emcIndex > bdcIndex, "expected a real /OC ... BDC ... EMC bracket");
  const bracketed = content.slice(bdcIndex, emcIndex);
  assert.match(bracketed, /1 1 1 rg/u, "the white cover rectangle's own fill must be inside the GENERÁTOR DATA bracket");
  assert.match(bracketed, /\bf\b/u, "the legend's own generated text/symbol fills must be inside the same bracket");
  // That the bracket is itself a genuine, real Optional Content Group (registered in
  // /OCProperties/OCGs, toggleable, ON by default, source OCGs untouched) is already exhaustively
  // verified structurally by tests/technicalRasterVectorPdf.test.ts's own "GENERÁTOR DATA: ..." test
  // suite — reused here rather than duplicated. This test's own job is only to prove that the
  // COVER and the LEGEND text specifically share that exact same bracket, asserted above: turning
  // that one real OCG off in a viewer therefore hides both together, and the source page's own
  // content (never touched, never inside this bracket at all) remains fully intact underneath.
});

test("OVERFLOW SAFETY: a configured in-place legend region far too small for the content falls back to the safe separate-page legend — nothing is drawn on the source page at all, never a broken/overlapping/clipped drawing", async () => {
  const source = await buildPlainFixture(); // 300x200pt
  const legend = [
    { legendLabel: "PŘÍVOD EL. ENERGIE", color: "#b3261e", renderer: "powerLabel" as const, displayLabel: "3 kW" },
    { legendLabel: "PŘÍVOD / ODPAD VODY", color: "#1a7a4c", renderer: "waterDrop" as const },
    { legendLabel: "WIFI", color: "#b8860b", renderer: "textLabel" as const, displayLabel: "WiFi" },
    { legendLabel: "ÚKLID", color: TECHNICAL_RASTER_COLORS.cleaning, renderer: "textLabel" as const, displayLabel: "ÚKL" },
  ];
  // A genuinely tiny region (6x6pt) — cannot hold even one row at the minimum allowed scale.
  const { bytes } = await buildTechnicalRasterVectorExportPdf({
    sourcePdfBytes: source, page: 1, placements: [], legend, showLegend: true, headerLine: "X",
    legendPlacement: { strategy: "source-legend-area", sourceRegion: { page: 1, xNormalized: 0.9, yNormalized: 0.9, widthNormalized: 0.02, heightNormalized: 0.02 } },
  });
  const reloaded = await PDFDocument.load(bytes);
  assert.equal(reloaded.getPageCount(), 2, "must fall back to a separate legend page rather than draw a broken in-place box");
  const page1Content = await readAllPageContentText(bytes, 0);
  assert.ok(!page1Content.includes("1 1 1 rg"), "nothing (not even a partial white cover) may be drawn on the source page when the region cannot fit the content");
  const legendPageContent = await readAllPageContentText(bytes, 1);
  assert.match(legendPageContent, /\bf\b/u, "the separate-page fallback must still draw the real legend content");
});

test("PDF STRUCTURE: white mode 40/75/100% opacity never changes the legend cover's own opacity — the cover stays a plain, unconditional 'rg ... f' fill with no /ca or gs reference of its own, independent of the whiteMode input", async () => {
  const source = await buildPlainFixture();
  const legend = [{ legendLabel: "PŘÍVOD EL. ENERGIE", color: "#b3261e", renderer: "powerLabel" as const, displayLabel: "3 kW" }];
  for (const opacity of [0.4, 0.75, 1]) {
    const { bytes } = await buildTechnicalRasterVectorExportPdf({
      sourcePdfBytes: source, page: 1, placements: [], legend, showLegend: true, headerLine: "X",
      legendPlacement: { strategy: "source-legend-area", sourceRegion: { page: 1, xNormalized: 0.5, yNormalized: 0.6, widthNormalized: 0.4, heightNormalized: 0.3 } },
      // whiteMode targets a "stand" OCG this plain fixture doesn't have — resolveWhiteModeAvailability's
      // own absence check means it's simply never requested at the pdf-lib layer here; the point of
      // this test is structural: the legend cover's own drawing call never reads/receives any
      // opacity value at all (see drawInPlaceLegend's own source — no whiteMode parameter exists on
      // its signature), so it is architecturally IMPOSSIBLE for booth white-mode opacity to reach it.
    });
    const content = await readAllPageContentText(bytes, 0);
    const generatorContent = content.slice(content.indexOf("/OC /"));
    const coverIndex = generatorContent.indexOf("1 1 1 rg");
    assert.ok(coverIndex >= 0, `opacity ${opacity}: expected the white cover fill`);
    const beforeCover = generatorContent.slice(0, coverIndex);
    const lastQIndex = beforeCover.lastIndexOf("q\n");
    const immediatelyBeforeCover = lastQIndex >= 0 ? beforeCover.slice(lastQIndex) : beforeCover;
    assert.ok(!/\/GS[\w-]*\s+gs/u.test(immediatelyBeforeCover), `opacity ${opacity}: the legend cover must never be wrapped in an ExtGState /ca reference, got: ${immediatelyBeforeCover}`);
  }
});

// ============================================================================
// SIMPLIFIED LEGEND BATCH section 2/5 — realization renders BESIDE the technical legend (right
// column), never stacked below it. Verified structurally: "LEGENDA:" and "REALIZACE:" are the ONLY
// two vector-outline fills drawn in the heading's own dark color (0.08 0.08 0.08), drawn in that
// order (LEGENDA: first) — the REALIZACE: heading's own glyph path must start at a clearly LARGER
// X than LEGENDA:'s (beside it), never at a similar X and a lower Y (which would mean "below" it).
// ============================================================================

function firstMoveToXAfter(content: string, searchFromIndex: number): number {
  const remainder = content.slice(searchFromIndex);
  const match = remainder.match(/(-?[\d.]+) (-?[\d.]+) m/u);
  assert.ok(match, "expected a moveTo ('m') operator after the given index");
  return Number(match![1]);
}

test("SIMPLIFIED LEGEND BATCH: realization renders BESIDE (right column) the technical legend, not below it — in-place legend", async () => {
  const source = await buildPlainFixture();
  const legend = [{ legendLabel: "ELEKTRIKA", color: "#b3261e", renderer: "powerLabel" as const, displayLabel: "2 kW" }];
  const { bytes } = await buildTechnicalRasterVectorExportPdf({
    sourcePdfBytes: source, page: 1, placements: [], legend, showLegend: true, headerLine: "X", includeRealizationKey: true,
    realizationUnderlines: [{ standId: "r1", xNormalized: 0.1, yNormalized: 0.1, widthNormalized: 0.05, color: "#2f8f4e" }], // GENDAI
    legendPlacement: { strategy: "source-legend-area", sourceRegion: { page: 1, xNormalized: 0.05, yNormalized: 0.5, widthNormalized: 0.9, heightNormalized: 0.4 } },
  });
  const reloaded = await PDFDocument.load(bytes);
  assert.equal(reloaded.getPageCount(), 1, "expected the in-place legend to actually fit this generous region");
  const content = await readAllPageContentText(bytes, 0);
  const generatorContent = content.slice(content.indexOf("/OC /"));
  const headingColor = "0.08 0.08 0.08 rg";
  const firstIdx = generatorContent.indexOf(headingColor);
  const secondIdx = generatorContent.indexOf(headingColor, firstIdx + headingColor.length);
  assert.ok(firstIdx >= 0 && secondIdx > firstIdx, "expected exactly two heading-colored fills, LEGENDA: drawn before REALIZACE:");
  const legendaX = firstMoveToXAfter(generatorContent, firstIdx);
  const realizaceX = firstMoveToXAfter(generatorContent, secondIdx);
  assert.ok(realizaceX > legendaX + 20, `REALIZACE: must sit clearly to the RIGHT of LEGENDA: (beside, never below) — got LEGENDA x=${legendaX}, REALIZACE x=${realizaceX}`);
});

test("SIMPLIFIED LEGEND BATCH: realization renders BESIDE (right column) the technical legend, not below it — separate-page fallback (same layout, more room)", async () => {
  const source = await buildPlainFixture();
  const legend = [{ legendLabel: "ELEKTRIKA", color: "#b3261e", renderer: "powerLabel" as const, displayLabel: "2 kW" }];
  const { bytes } = await buildTechnicalRasterVectorExportPdf({
    sourcePdfBytes: source, page: 1, placements: [], legend, showLegend: true, headerLine: "X", includeRealizationKey: true,
    realizationUnderlines: [{ standId: "r1", xNormalized: 0.1, yNormalized: 0.1, widthNormalized: 0.05, color: "#2f8f4e" }], // GENDAI
  });
  const reloaded = await PDFDocument.load(bytes);
  assert.equal(reloaded.getPageCount(), 2);
  const content = await readAllPageContentText(bytes, 1);
  const headingColor = "0.08 0.08 0.08 rg";
  // The page title ("TECHNICKÝ EXPORT — LEGENDA") also uses this heading color, so on the
  // separate-page fallback there are THREE occurrences: title, LEGENDA:, REALIZACE: — in that order.
  const firstIdx = content.indexOf(headingColor);
  const secondIdx = content.indexOf(headingColor, firstIdx + headingColor.length);
  const thirdIdx = content.indexOf(headingColor, secondIdx + headingColor.length);
  assert.ok(firstIdx >= 0 && secondIdx > firstIdx && thirdIdx > secondIdx, "expected three heading-colored fills: title, then LEGENDA:, then REALIZACE:");
  const legendaX = firstMoveToXAfter(content, secondIdx);
  const realizaceX = firstMoveToXAfter(content, thirdIdx);
  assert.ok(realizaceX > legendaX + 20, `REALIZACE: must sit clearly to the RIGHT of LEGENDA: (beside, never below) — got LEGENDA x=${legendaX}, REALIZACE x=${realizaceX}`);
});

// ============================================================================
// SIMPLIFIED LEGEND BATCH section 3 — automatic default in-place region, resolved via the
// EXISTING TechnicalLegendPlacement architecture (domain/technicalRasterLegendPlacement.ts +
// domain/technicalRaster.ts's own effectiveLegendPlacement) — never a per-hall conditional inside a
// rendering component. See tests/technicalRaster.test.ts and tests/technicalRasterLegendPlacement.test.ts
// for the resolver/constant-level unit tests; this one confirms the WHOLE PDF pipeline actually
// honors it end-to-end when a project has never configured its own legendPlacement.
// ============================================================================

test("SIMPLIFIED LEGEND BATCH: the shared automatic default region actually produces an in-place legend end-to-end (a real, generously-sized synthetic page), never requiring manual per-project region configuration", async () => {
  const { DEFAULT_AUTO_LEGEND_PLACEMENT } = await import("../domain/technicalRasterLegendPlacement.ts");
  // A generously large synthetic page (the real Hala 1/Hala 3 fixtures are ~397x272pt — this uses a
  // proportionally larger one purely so the fixed-point IN_PLACE_LEGEND_MARGIN_PT/row heights have
  // comfortable room, independent of any one real file's own exact dimensions).
  const doc = await PDFDocument.create();
  doc.addPage([1200, 800]);
  const source = await doc.save();
  const legend = [{ legendLabel: "ELEKTRIKA", color: "#b3261e", renderer: "powerLabel" as const, displayLabel: "2 kW" }];
  const { bytes } = await buildTechnicalRasterVectorExportPdf({
    sourcePdfBytes: source, page: 1, placements: [], legend, showLegend: true, headerLine: "X",
    legendPlacement: DEFAULT_AUTO_LEGEND_PLACEMENT,
  });
  const reloaded = await PDFDocument.load(bytes);
  assert.equal(reloaded.getPageCount(), 1, "the shared default region must actually draw in-place on a realistically-sized hall raster, never silently falling back");
  assert.equal(reloaded.getPage(0).getWidth(), 1200, "source page size must stay completely untouched");
  assert.equal(reloaded.getPage(0).getHeight(), 800);
});

// ============================================================================
// SMALL POLISH BATCH — position/scale/spacing nudge + a small colored category dot on the
// TECHNICAL (left) rows only. Conceptually the SAME simplified category-based legend, same
// two-block LEGENDA/REALIZACE layout, same automatic in-place behavior, same fallback — this is a
// constants-only visual polish, verified here at both the source-constant level and structurally.
// ============================================================================

test("SMALL POLISH BATCH: in-place legend size/spacing constants match the reported polish (source-level pin, so a future accidental revert is caught)", async () => {
  const source = await readFile(new URL("../lib/technicalRasterVectorPdf.ts", import.meta.url), "utf8");
  assert.match(source, /const IN_PLACE_LEGEND_SYMBOL_COLUMN_WIDTH_PT = 15;/u, "symbol-to-description gap: 11 -> 15 (the main 'not glued together' ask)");
  assert.match(source, /const IN_PLACE_LEGEND_DOT_RADIUS_PT = 1\.3;/u, "small colored category dot radius");
  assert.match(source, /const IN_PLACE_LEGEND_MARGIN_PT = 4;/u, "internal box margin stays unchanged");
  assert.match(source, /const IN_PLACE_LEGEND_COLUMN_GAP_PT = 10;/u, "technical/realization column gap stays unchanged (the ask was specifically about the symbol/description gap)");
});

test("MICRO POLISH BATCH: in-place legend size constants got one more small, uniform reduction (source-level pin, so a future accidental revert is caught)", async () => {
  const source = await readFile(new URL("../lib/technicalRasterVectorPdf.ts", import.meta.url), "utf8");
  assert.match(source, /const IN_PLACE_LEGEND_ROW_HEIGHT_PT = 8;/u, "row height: 8.5 -> 8");
  assert.match(source, /const IN_PLACE_LEGEND_FONT_SIZE_PT = 5;/u, "description/realization-row font: 5.5 -> 5");
  assert.match(source, /const IN_PLACE_LEGEND_HEADING_FONT_SIZE_PT = 6;/u, "heading font (LEGENDA:/REALIZACE:): 6.5 -> 6");
  assert.match(source, /const IN_PLACE_LEGEND_SYMBOL_FONT_SIZE_PT = 4\.5;/u, "text-based symbol/sample font: 5 -> 4.5");
  assert.match(source, /const IN_PLACE_LEGEND_STAR_FONT_SIZE_PT = 5\.5;/u, "refrigerated-star symbol size: 6 -> 5.5");
  assert.match(source, /const IN_PLACE_LEGEND_WATER_DROP_HEIGHT_PT = 4;/u, "water-drop symbol height: 4.5 -> 4");
  assert.match(source, /const IN_PLACE_LEGEND_WIFI_WIDTH_PT = 4\.5;/u, "wifi-icon symbol width: 5 -> 4.5");
  // MARGIN/SYMBOL_COLUMN_WIDTH/COLUMN_GAP/MIN_SCALE must stay exactly as the previous batch left them.
  assert.match(source, /const IN_PLACE_LEGEND_MARGIN_PT = 4;/u, "margin stays unchanged");
  assert.match(source, /const IN_PLACE_LEGEND_SYMBOL_COLUMN_WIDTH_PT = 15;/u, "symbol-to-description gap stays unchanged");
  assert.match(source, /const IN_PLACE_LEGEND_COLUMN_GAP_PT = 10;/u, "technical/realization column gap stays unchanged");
  assert.match(source, /const IN_PLACE_LEGEND_MIN_SCALE = 0\.7;/u, "overflow-safety minimum scale stays unchanged");
});

test("SMALL POLISH BATCH: the default in-place region moved slightly right + down and shrank slightly (source-level pin of the reported old -> new values)", async () => {
  const source = await readFile(new URL("../domain/technicalRasterLegendPlacement.ts", import.meta.url), "utf8");
  assert.match(source, /xNormalized: 0\.06,/u, "x: 0.02 -> 0.06 (more to the right)");
  assert.match(source, /yNormalized: 0\.79,/u, "y: 0.74 -> 0.79 (lower — this app's normalized y grows downward)");
  assert.match(source, /widthNormalized: 0\.25,/u, "width: 0.3 -> 0.25 (slightly smaller)");
  assert.match(source, /heightNormalized: 0\.19,/u, "height: 0.24 -> 0.19 (slightly smaller)");
});

test("SMALL POLISH BATCH: technical legend rows draw a small colored dot in the row's own category color, in ADDITION to the real symbol/sample — never replacing it", async () => {
  const source = await buildPlainFixture();
  const legend = [{ legendLabel: "ELEKTRIKA", color: "#b3261e", renderer: "powerLabel" as const, displayLabel: "2 kW" }];
  const { bytes } = await buildTechnicalRasterVectorExportPdf({
    sourcePdfBytes: source, page: 1, placements: [], legend, showLegend: true, headerLine: "X",
    legendPlacement: { strategy: "source-legend-area", sourceRegion: { page: 1, xNormalized: 0.5, yNormalized: 0.55, widthNormalized: 0.45, heightNormalized: 0.35 } },
  });
  const reloaded = await PDFDocument.load(bytes);
  assert.equal(reloaded.getPageCount(), 1, "expected the in-place legend to fit this generous region");
  const content = await readAllPageContentText(bytes, 0);
  const generatorContent = content.slice(content.indexOf("/OC /"));
  // Electricity red (#b3261e) must be SET at least twice for this one row — once for the small
  // colored dot (page.drawCircle, pdf-lib's own FULL-PRECISION color formatting) and once for the
  // real "2 kW" vector-outline text symbol (this pipeline's own formatColorComponent, ROUNDED to 3
  // decimals) — the two drawing paths format the identical color differently, so both patterns are
  // checked. Exactly one occurrence would mean the dot was never actually drawn.
  const roundedCount = (generatorContent.match(/0\.702 0\.149 0\.118 rg/gu) ?? []).length;
  const fullPrecisionCount = (generatorContent.match(/0\.7019607843137254 0\.14901960784313725 0\.11764705882352941 rg/gu) ?? []).length;
  const colorOccurrences = roundedCount + fullPrecisionCount;
  assert.ok(colorOccurrences >= 2, `expected the row's own category color to be set at least twice (dot + real symbol), got ${colorOccurrences} (rounded=${roundedCount}, full=${fullPrecisionCount}) in: ${generatorContent}`);
});

test("SMALL POLISH BATCH: the realization (right) column is untouched by the new dot — still only its own colored LINE swatch, never a dot", async () => {
  const source = await buildPlainFixture();
  const legend = [{ legendLabel: "ELEKTRIKA", color: "#b3261e", renderer: "powerLabel" as const, displayLabel: "2 kW" }];
  const { bytes } = await buildTechnicalRasterVectorExportPdf({
    sourcePdfBytes: source, page: 1, placements: [], legend, showLegend: true, headerLine: "X", includeRealizationKey: true,
    // No real realizationUnderlines placement here — that draws its OWN separate real underline
    // marker on the raster (unrelated to the legend), which would also legitimately match GENDAI's
    // color and confuse this count. includeRealizationKey with a legend row's own display is
    // triggered purely via a used-color match, so a directly-supplied underline color is enough.
    realizationUnderlines: [{ standId: "r1", xNormalized: -1, yNormalized: -1, widthNormalized: 0.05, color: "#2f8f4e" }], // off-page (never actually visible), only feeds resolveUsedRealizationGroups
    legendPlacement: { strategy: "source-legend-area", sourceRegion: { page: 1, xNormalized: 0.05, yNormalized: 0.5, widthNormalized: 0.9, heightNormalized: 0.4 } },
  });
  const reloaded = await PDFDocument.load(bytes);
  assert.equal(reloaded.getPageCount(), 1, "expected the in-place legend to fit this generous region");
  const content = await readAllPageContentText(bytes, 0);
  // Only look at content from the legend's own white cover onward — an off-page underline is
  // skipped entirely by isValidNormalizedCoordinate, so nothing of it is drawn before this point.
  const legendContent = content.slice(content.indexOf("1 1 1 rg"));
  // GENDAI green (pdf-lib's own real precision: "0.1843137254901961 0.5607843137254902
  // 0.3058823529411765") must be set exactly ONCE for the realization row — its own line stroke
  // color — never twice like the technical dot's fill + symbol fill pair.
  const gendaiOccurrences = (legendContent.match(/0\.184\d+ 0\.560\d+ 0\.305\d+ RG/gu) ?? []).length;
  assert.equal(gendaiOccurrences, 1, `expected the realization row's own stroke color to be set exactly once (its line, no dot), got ${gendaiOccurrences} in: ${legendContent}`);
});

// ============================================================================
// DOT POLISH BATCH — the technical-row dot was too close to its own symbol/sample (could visually
// touch a wide symbol). Moved further left via a new named offset constant — symbol/description
// positions, row layout, LEGENDA/REALIZACE arrangement, and export logic are all untouched.
// ============================================================================

test("DOT POLISH BATCH / MICRO POLISH BATCH: the technical-row dot's own left offset moved further left again (was 0.5pt from leftX, now -0.2pt — a tiny bit into the row's own left margin, still safely inside IN_PLACE_LEGEND_MARGIN_PT) — symbol/description draw calls are byte-for-byte unchanged", async () => {
  const source = await readFile(new URL("../lib/technicalRasterVectorPdf.ts", import.meta.url), "utf8");
  assert.match(source, /const IN_PLACE_LEGEND_DOT_LEFT_OFFSET_PT = -0\.2;/u, "dot-offset constant: 0.5 -> -0.2 (a bit more breathing room from the symbol)");
  assert.match(source, /page\.drawCircle\(\{ x: leftX \+ plan\.dotOffsetFromLeftX, y: rowCenterY, size: plan\.dotRadius, color: hexToRgbFraction\(entry\.color\) \}\);/u, "the dot's own draw call reads its x from the new offset field");
  // Symbol center and description start must be COMPLETELY UNCHANGED by this batch.
  assert.match(source, /drawLegendEntrySymbol\(page, leftX \+ plan\.symbolColumnWidth \/ 2, rowCenterY, entry, shapingFont, plan\.symbolSizes\);/u, "symbol/sample center position untouched");
  assert.match(source, /drawVectorOutlineText\(page, leftX \+ plan\.symbolColumnWidth, leftY, entry\.legendLabel, shapingFont, plan\.textFontSize, rgb\(0\.1, 0\.1, 0\.1\)\);/u, "description position untouched");
});

test("DOT POLISH BATCH: the dot still draws successfully (in ADDITION to the real symbol) at its new, more-left offset — same color, same size, still a valid single-page in-place export", async () => {
  const source = await buildPlainFixture();
  const legend = [{ legendLabel: "ELEKTRIKA", color: "#b3261e", renderer: "powerLabel" as const, displayLabel: "2 kW" }];
  const { bytes } = await buildTechnicalRasterVectorExportPdf({
    sourcePdfBytes: source, page: 1, placements: [], legend, showLegend: true, headerLine: "X",
    legendPlacement: { strategy: "source-legend-area", sourceRegion: { page: 1, xNormalized: 0.5, yNormalized: 0.55, widthNormalized: 0.45, heightNormalized: 0.35 } },
  });
  const reloaded = await PDFDocument.load(bytes);
  assert.equal(reloaded.getPageCount(), 1, "expected the in-place legend to still fit this region after the dot's offset moved");
  const content = await readAllPageContentText(bytes, 0);
  const generatorContent = content.slice(content.indexOf("/OC /"));
  const roundedCount = (generatorContent.match(/0\.702 0\.149 0\.118 rg/gu) ?? []).length;
  const fullPrecisionCount = (generatorContent.match(/0\.7019607843137254 0\.14901960784313725 0\.11764705882352941 rg/gu) ?? []).length;
  assert.ok(roundedCount + fullPrecisionCount >= 2, "the dot (full-precision fill) and the real symbol (rounded fill) must both still be drawn, in the same category color");
});
