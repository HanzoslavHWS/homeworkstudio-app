import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFHexString, PDFString, PDFRawStream, decodePDFRawStream, StandardFonts, rgb, degrees } from "pdf-lib";
import { buildTechnicalRasterMultiPageVectorExportPdf, buildTechnicalRasterVectorExportPdf, reconstructOcProperties, resolveSourcePageGeometry, TechnicalRasterVectorExportError } from "../lib/technicalRasterVectorPdf.ts";
import type { TechnicalRasterExportLegendEntry, TechnicalRasterExportPlacementItem } from "../domain/technicalRasterExport.ts";
import { resolveTechnicalServicePresentation } from "../domain/technicalRasterServicePresentation.ts";
import {
  EXPORT_POWER_LABEL_FONT_SIZE_PT,
  EXPORT_SYMBOL_MAX_BOUNDING_HEIGHT_PT,
  EXPORT_SYMBOL_MAX_BOUNDING_WIDTH_PT,
  EXPORT_TEXT_SYMBOL_FONT_SIZE_PT,
  ptToMm,
} from "../domain/technicalRasterExportSymbolSize.ts";

// ============================================================================
// Self-contained synthetic PDF fixtures (spec: never a real customer file in the portable test
// suite — _IMPORT/Hala 1.pdf is only ever used by scripts/technicalRasterRealDiagnostic.ts, which
// is skip-safe). Built directly with pdf-lib, the SAME library the production pipeline uses, so
// these are genuinely representative synthetic PDFs, not hand-typed byte strings.
// ============================================================================

async function buildPlainFixture(options: Readonly<{ rotate?: number }> = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  if (options.rotate) page.setRotation(degrees(options.rotate));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("HALA 1 TEST FIXTURE", { x: 20, y: 100, size: 14, font, color: rgb(0, 0, 0) });
  page.drawLine({ start: { x: 10, y: 10 }, end: { x: 290, y: 190 }, thickness: 1, color: rgb(0, 0, 0) });
  return doc.save();
}

/** A synthetic PDF whose page /Resources/Properties references two OCGs (mirrors how a real OCG-bearing PDF's page resources look, per this batch's own real-file audit) and whose catalog declares matching /OCProperties (one ON, one OFF) — enough to exercise reconstructOcProperties' name-matching without needing genuine BDC/EMC marked-content operators (that logic only ever inspects the resources dict, never the content stream itself). */
async function buildOcgFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("LAYERED FIXTURE", { x: 20, y: 100, size: 14, font, color: rgb(0, 0, 0) });

  const ctx = doc.context;
  const ocg1 = PDFDict.withContext(ctx);
  ocg1.set(PDFName.of("Type"), PDFName.of("OCG"));
  ocg1.set(PDFName.of("Name"), PDFHexString.fromText("VRSTVA A"));
  const ocg1Ref = ctx.register(ocg1);
  const ocg2 = PDFDict.withContext(ctx);
  ocg2.set(PDFName.of("Type"), PDFName.of("OCG"));
  ocg2.set(PDFName.of("Name"), PDFHexString.fromText("VRSTVA B"));
  const ocg2Ref = ctx.register(ocg2);

  const props = PDFDict.withContext(ctx);
  props.set(PDFName.of("OC1"), ocg1Ref);
  props.set(PDFName.of("OC2"), ocg2Ref);
  const resources = page.node.lookup(PDFName.of("Resources"));
  if (resources instanceof PDFDict) resources.set(PDFName.of("Properties"), props);

  const ocgsArr = PDFArray.withContext(ctx);
  ocgsArr.push(ocg1Ref);
  ocgsArr.push(ocg2Ref);
  const onArr = PDFArray.withContext(ctx);
  onArr.push(ocg1Ref);
  const offArr = PDFArray.withContext(ctx);
  offArr.push(ocg2Ref);
  const dDict = PDFDict.withContext(ctx);
  dDict.set(PDFName.of("BaseState"), PDFName.of("ON"));
  dDict.set(PDFName.of("ON"), onArr);
  dDict.set(PDFName.of("OFF"), offArr);
  const ocPropsDict = PDFDict.withContext(ctx);
  ocPropsDict.set(PDFName.of("OCGs"), ctx.register(ocgsArr));
  ocPropsDict.set(PDFName.of("D"), ctx.register(dDict));
  doc.catalog.set(PDFName.of("OCProperties"), ctx.register(ocPropsDict));

  return doc.save();
}

/** Same as buildOcgFixture, but with a THIRD OCG declared in the catalog's /OCProperties/OCGs array that is NEVER referenced by page 1's own /Resources/Properties — a legitimate real-world shape (e.g. a layer only used on a different page of a real multi-page PDF) that reconstructOcProperties must handle gracefully (spec batch 12 section 12: "unknown OCG reference nezpůsobí crash"), not silently pretend it reconstructed. */
async function buildOcgFixtureWithOrphanedGroup(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("LAYERED FIXTURE WITH ORPHAN", { x: 20, y: 100, size: 14, font, color: rgb(0, 0, 0) });

  const ctx = doc.context;
  const ocg1 = PDFDict.withContext(ctx);
  ocg1.set(PDFName.of("Type"), PDFName.of("OCG"));
  ocg1.set(PDFName.of("Name"), PDFHexString.fromText("VRSTVA A"));
  const ocg1Ref = ctx.register(ocg1);
  const orphan = PDFDict.withContext(ctx);
  orphan.set(PDFName.of("Type"), PDFName.of("OCG"));
  orphan.set(PDFName.of("Name"), PDFHexString.fromText("VRSTVA NA JINÉ STRÁNCE"));
  const orphanRef = ctx.register(orphan);

  const props = PDFDict.withContext(ctx);
  props.set(PDFName.of("OC1"), ocg1Ref); // orphan is deliberately NOT added here
  const resources = page.node.lookup(PDFName.of("Resources"));
  if (resources instanceof PDFDict) resources.set(PDFName.of("Properties"), props);

  const ocgsArr = PDFArray.withContext(ctx);
  ocgsArr.push(ocg1Ref);
  ocgsArr.push(orphanRef);
  const onArr = PDFArray.withContext(ctx);
  onArr.push(ocg1Ref);
  onArr.push(orphanRef);
  const dDict = PDFDict.withContext(ctx);
  dDict.set(PDFName.of("BaseState"), PDFName.of("ON"));
  dDict.set(PDFName.of("ON"), onArr);
  const ocPropsDict = PDFDict.withContext(ctx);
  ocPropsDict.set(PDFName.of("OCGs"), ctx.register(ocgsArr));
  ocPropsDict.set(PDFName.of("D"), ctx.register(dDict));
  doc.catalog.set(PDFName.of("OCProperties"), ctx.register(ocPropsDict));

  return doc.save();
}

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

async function decodeForInspection(bytes: Uint8Array) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
  const page = await doc.getPage(1);
  const textContent = await page.getTextContent();
  const operatorList = await page.getOperatorList();
  const ocConfig = await doc.getOptionalContentConfig();
  return { doc, page, textContent, operatorList, ocConfig };
}

// ============================================================================
// A) valid PDF
// ============================================================================

test("A) buildTechnicalRasterVectorExportPdf produces a valid PDF (%PDF- magic bytes)", async () => {
  const source = await buildPlainFixture();
  const { bytes } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: true, headerLine: "X" });
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString("latin1"), "%PDF-");
});

// ============================================================================
// B) source page is NOT a full-page raster image (no image XObjects at all)
// ============================================================================

test("B) the exported page 1 has ZERO image XObjects — never a rasterized replacement of the source", async () => {
  const source = await buildPlainFixture();
  const { bytes } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [placementItem()], legend: [], showLegend: false, headerLine: "X" });
  const reloaded = await PDFDocument.load(bytes);
  const page1 = reloaded.getPage(0);
  const resources = page1.node.lookup(PDFName.of("Resources"));
  const xobjects = resources instanceof PDFDict ? resources.lookup(PDFName.of("XObject")) : undefined;
  assert.ok(!(xobjects instanceof PDFDict) || xobjects.keys().length === 0, "page 1 must have no image XObjects");
});

// ============================================================================
// C) source geometry preserved (page size/rotation untouched)
// ============================================================================

test("C) source page geometry (size) is preserved exactly on page 1 — never resized/rescaled", async () => {
  const source = await buildPlainFixture();
  const { bytes } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X" });
  const reloaded = await PDFDocument.load(bytes);
  const page1 = reloaded.getPage(0);
  assert.equal(page1.getWidth(), 300);
  assert.equal(page1.getHeight(), 200);
});

// ============================================================================
// D) source text still exists
// ============================================================================

test("D) the source page's own real text is still present and extractable after export", async () => {
  const source = await buildPlainFixture();
  const { bytes } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X" });
  const { textContent } = await decodeForInspection(bytes);
  const joined = (textContent.items as { str: string }[]).map((item) => item.str).join("");
  assert.ok(joined.includes("HALA 1 TEST FIXTURE"), `expected source text to survive, got: ${joined}`);
});

// ============================================================================
// E) technical text overlay exists / F) technical vector symbol exists
// ============================================================================

test("E/F) placed technical symbols draw a real filled vector-outline glyph path on page 1 (CORRECTIVE BATCH 3rd sections 8/9: never PDF text-showing operators any more — see the dedicated structural test above)", async () => {
  const source = await buildPlainFixture();
  const placements = [placementItem({ presentation: resolveTechnicalServicePresentation("electricity", "Do 3kW 230V") })];
  const { bytes } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements, legend: [], showLegend: false, headerLine: "X" });
  const markerText = await readPage1ContentEntryFromEnd(bytes);
  assert.match(markerText, /0\.702 0\.149 0\.118 rg/u, "the marker's own presentation color");
  assert.ok(/\bf\b/u.test(markerText), "a real fill paint operator");
  const { operatorList } = await decodeForInspection(bytes);
  assert.ok(operatorList.fnArray.length > 20, "expects real vector drawing operators (the glyph outline curves etc.), not a bare page");
});

test("F) every real renderer kind draws without throwing (powerLabel/refrigeratedStar/textLabel/waterDrop/fallback)", async () => {
  const source = await buildPlainFixture();
  const presentations = [
    resolveTechnicalServicePresentation("electricity", "Do 3kW 230V"),
    resolveTechnicalServicePresentation("electricity", "Lednicový okruh"),
    resolveTechnicalServicePresentation("internet", "Pevná IP"),
    resolveTechnicalServicePresentation("water", "x"),
    resolveTechnicalServicePresentation("some-future-category", "x"),
  ];
  const placements = presentations.map((presentation, index) => placementItem({ placementId: `p-${index}`, xNormalized: 0.1 + index * 0.15, presentation }));
  const { bytes } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements, legend: [], showLegend: false, headerLine: "X" });
  assert.ok(bytes.length > 100);
});

// ============================================================================
// G) normalized placement -> correct raw position (rotation 0 and rotation-aware)
// ============================================================================

test("G) resolveSourcePageGeometry + normalized center (0.5,0.5) resolves to the raw page's own center at rotation 0", async () => {
  const source = await buildPlainFixture();
  const geometry = await resolveSourcePageGeometry(source, 1);
  assert.equal(geometry.displayWidthPt, 300);
  assert.equal(geometry.displayHeightPt, 200);
});

// ============================================================================
// H) landscape correctly (a wide page — never swapped/transposed)
// ============================================================================

test("H) a landscape (wide) source page keeps its own width/height, never swapped", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([842, 595]); // A4 landscape-ish
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("LANDSCAPE", { x: 20, y: 500, size: 14, font, color: rgb(0, 0, 0) });
  const source = await doc.save();

  const { bytes } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [placementItem()], legend: [], showLegend: false, headerLine: "X" });
  const reloaded = await PDFDocument.load(bytes);
  const page1 = reloaded.getPage(0);
  assert.equal(page1.getWidth(), 842);
  assert.equal(page1.getHeight(), 595);
  assert.ok(page1.getWidth() > page1.getHeight(), "must stay landscape, never transposed to portrait");
});

// ============================================================================
// I) source PDF bytes never modified
// ============================================================================

test("I) the source PDF bytes passed in are never mutated", async () => {
  const source = await buildPlainFixture();
  const copyBefore = Uint8Array.from(source);
  await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [placementItem()], legend: [], showLegend: true, headerLine: "X" });
  assert.deepEqual(source, copyBefore, "sourcePdfBytes must be byte-identical after export — pdf-lib's load() is read-only");
});

// ============================================================================
// J) legend/footer never deforms the source page
// ============================================================================

test("J) the legend lives on a SEPARATE page — page 1's own size is completely unaffected by legend content", async () => {
  const source = await buildPlainFixture();
  const legend: readonly TechnicalRasterExportLegendEntry[] = [
    { legendLabel: "PŘÍVOD EL. ENERGIE", color: "#b3261e", renderer: "powerLabel" },
    { legendLabel: "VODA — PŘÍVOD / ODPAD VODY", color: "#1a7a4c", renderer: "waterDrop" },
  ];
  const { bytes } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend, showLegend: true, headerLine: "X" });
  const reloaded = await PDFDocument.load(bytes);
  assert.equal(reloaded.getPageCount(), 2, "page 1 (source) + page 2 (legend)");
  const page1 = reloaded.getPage(0);
  assert.equal(page1.getWidth(), 300);
  assert.equal(page1.getHeight(), 200);
});

test("J) legend page contains the expected labels when shown, and is still present (with a fallback message) when there's nothing to list", async () => {
  const source = await buildPlainFixture();
  const legend: readonly TechnicalRasterExportLegendEntry[] = [{ legendLabel: "PŘÍVOD EL. ENERGIE", color: "#b3261e", renderer: "powerLabel" }];
  const withLegend = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend, showLegend: true, headerLine: "Technický rastr / Hala 1" });
  const reloadedWith = await PDFDocument.load(withLegend.bytes);
  const { textContent: legendText } = await decodeForInspection(withLegend.bytes.slice());
  // decodeForInspection reads page 1 of the passed bytes — build a small helper reading page 2 instead.
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loaded = await pdfjsLib.getDocument({ data: new Uint8Array(withLegend.bytes) }).promise;
  const legendPage = await loaded.getPage(2);
  const legendPageText = await legendPage.getTextContent();
  const joined = (legendPageText.items as { str: string }[]).map((item) => item.str).join(" ");
  assert.ok(joined.includes("PŘÍVOD EL. ENERGIE"), `expected legend label on page 2, got: ${joined}`);
  assert.ok(joined.includes("Technický rastr"), "expected the header line on the legend page");
  assert.equal(reloadedWith.getPageCount(), 2);
  void legendText;
});

// ============================================================================
// Rotation (spec section 30/36-H)
// ============================================================================

test("rotation: a 90-degree-rotated source page still exports without throwing and keeps its own /Rotate value", async () => {
  const source = await buildPlainFixture({ rotate: 90 });
  const { bytes } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [placementItem()], legend: [], showLegend: false, headerLine: "X" });
  const reloaded = await PDFDocument.load(bytes);
  const page1 = reloaded.getPage(0);
  assert.equal(page1.getRotation().angle, 90);
});

// ============================================================================
// No services / nothing to draw — never a crash
// ============================================================================

test("a project with zero placements and an empty legend never crashes — still a valid PDF", async () => {
  const source = await buildPlainFixture();
  const { bytes } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: true, headerLine: "Technický rastr" });
  assert.ok(bytes.length > 100);
});

// ============================================================================
// OCG diagnostic (spec section 16/32)
// ============================================================================

test("OCG: a source PDF with no /OCProperties reports attempted:false, never crashes", async () => {
  const source = await buildPlainFixture();
  const { ocgDiagnostic } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X" });
  assert.equal(ocgDiagnostic.attempted, false);
  assert.equal(ocgDiagnostic.sourceOcgCount, 0);
});

test("OCG: a source PDF WITH OCGs has its OCG names/order/state reconstructed at the catalog level, verified via pdf.js on the re-parsed export", async () => {
  const source = await buildOcgFixture();
  const { bytes, ocgDiagnostic } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X" });
  assert.equal(ocgDiagnostic.attempted, true);
  assert.equal(ocgDiagnostic.sourceOcgCount, 2);
  assert.equal(ocgDiagnostic.reconstructedOcgCount, 2);
  assert.deepEqual(ocgDiagnostic.unmatchedOcgNames, []);

  // CORRECTIVE BATCH (3rd) section 10/11 — every export now also carries a 3rd, generator-owned
  // "GENERÁTOR DATA" OCG (appended after the 2 reconstructed source layers) so generator overlay
  // content can be toggled independently of the original layers.
  const { ocConfig } = await decodeForInspection(bytes);
  const order = ocConfig.getOrder();
  assert.equal(order?.length, 3);
  const names = order!.map((id) => ocConfig.getGroup(id)?.name);
  assert.deepEqual(names, ["VRSTVA A", "VRSTVA B", "GENERÁTOR DATA"]);
});

test("reconstructOcProperties: unit-level — directly exercises the function against pdf-lib PDFDocument objects (source with OCGs, new doc after copyPages)", async () => {
  const sourceBytes = await buildOcgFixture();
  const srcDoc = await PDFDocument.load(sourceBytes);
  const newDoc = await PDFDocument.create();
  const [copiedPage] = await newDoc.copyPages(srcDoc, [0]);
  newDoc.addPage(copiedPage);
  const result = reconstructOcProperties(srcDoc, newDoc, copiedPage);
  assert.equal(result.attempted, true);
  assert.equal(result.sourceOcgCount, 2);
  assert.equal(result.reconstructedOcgCount, 2);
  assert.deepEqual([...result.reconstructedOcgNames].sort(), ["VRSTVA A", "VRSTVA B"]);
});

test("OCG hardening: an orphaned OCG (declared in /OCProperties but never referenced by THIS page's own resources — e.g. only used on a different page of a real multi-page PDF) is reported as unmatched, never crashes, and never blocks reconstructing the OTHER, real groups", async () => {
  const source = await buildOcgFixtureWithOrphanedGroup();
  const { bytes, ocgDiagnostic } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X" });
  assert.equal(ocgDiagnostic.attempted, true);
  assert.equal(ocgDiagnostic.sourceOcgCount, 2);
  assert.equal(ocgDiagnostic.reconstructedOcgCount, 1);
  assert.deepEqual(ocgDiagnostic.unmatchedOcgNames, ["VRSTVA NA JINÉ STRÁNCE"]);

  // The orphaned source group never shows up (never a broken/dangling reference) — but the
  // generator's own "GENERÁTOR DATA" OCG is still always present alongside the one real reconstructed group.
  const { ocConfig } = await decodeForInspection(bytes);
  const order = ocConfig.getOrder();
  assert.equal(order?.length, 2);
  const names = order!.map((id) => ocConfig.getGroup(id)?.name);
  assert.deepEqual(names, ["VRSTVA A", "GENERÁTOR DATA"]);
});

test("OCG hardening: no duplicate catalog registrations — calling reconstructOcProperties does not register the same OCProperties/D/OCGs structure twice even though it touches the context multiple times internally", async () => {
  const sourceBytes = await buildOcgFixture();
  const srcDoc = await PDFDocument.load(sourceBytes);
  const newDoc = await PDFDocument.create();
  const [copiedPage] = await newDoc.copyPages(srcDoc, [0]);
  newDoc.addPage(copiedPage);
  reconstructOcProperties(srcDoc, newDoc, copiedPage);
  const ocPropsRef = newDoc.catalog.get(PDFName.of("OCProperties"));
  assert.ok(ocPropsRef, "exactly one /OCProperties entry exists on the catalog after a single reconstruction call");
  // Re-saving and re-parsing must still show exactly 2 groups, never 4 (which duplicate
  // registration would produce) — the definitive, externally-observable proof.
  const bytes = await newDoc.save();
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loaded = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
  const order = (await loaded.getOptionalContentConfig()).getOrder();
  assert.equal(order?.length, 2);
});

// ============================================================================
// Corrective batch section 3: physical symbol size — never trust "the constant looks small", the
// spec explicitly demands the ACTUAL measured pt/mm bounding box (never a full-page circle badge).
// ============================================================================

test("corrective batch 3/CORRECTIVE BATCH 3rd section 8/9) a text-label placement symbol draws ONLY a filled vector-outline glyph path — never PDF text-showing operators, never a circle backdrop", async () => {
  const source = await buildPlainFixture();
  const placements = [placementItem({ presentation: resolveTechnicalServicePresentation("electricity", "Do 3kW 230V") })];
  const { bytes } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements, legend: [], showLegend: false, headerLine: "X" });
  // The marker's OWN content chunk only (not the whole page — buildPlainFixture's SOURCE content
  // legitimately contains its own real BT/Tj text, which must never be mistaken for a violation).
  const text = await readPage1ContentEntryFromEnd(bytes);
  // CORRECTIVE BATCH (3rd) sections 8/9 — CorelDRAW 2018 was found to drop exactly this
  // page.drawText()-based representation on import; the marker is now genuine vector-outline fill
  // geometry (m/l/c/h + f), never a text-showing operator.
  for (const forbidden of ["BT", "ET", "Tf", "Tj", "TJ"]) {
    assert.ok(!new RegExp(`(^|\\s)${forbidden}(\\s|$)`, "u").test(text), `expected no "${forbidden}" text-showing operator, got: ${text}`);
  }
  assert.ok(/\bf\b/u.test(text), "expected a nonzero-winding fill operator for the vector-outline glyph");
  // pdf-lib's drawCircle emits a Bézier-curve-approximated closed path ('c' curve operators) ending
  // in a fill/stroke paint op — the OLD design always drew one behind every point symbol regardless
  // of renderer. A pure text-label placement must never draw a SECOND, backdrop shape behind its
  // own glyph fill — i.e. never more than one 're' (rectangle) operator, and never a 'B'/'S' stroke
  // paint op, which only a backdrop shape would need.
  assert.ok(!/\bre\b/u.test(text), `expected no rectangle backdrop operator, got: ${text}`);
  assert.ok(!/\b[BS]\b/u.test(text), `expected no stroke/fill-and-stroke backdrop paint operator, got: ${text}`);
});

test("corrective batch 3) a text-label symbol's physical bounding box stays well under the old circle badge size, for every real short label this app produces", async () => {
  const doc = await PDFDocument.create();
  doc.registerFontkit((await import("@pdf-lib/fontkit")).default);
  const { NOTO_SANS_CZECH_BOLD_BASE64 } = await import("../lib/fonts/graphicsProductionFont.ts");
  const bytes = Uint8Array.from(atob(NOTO_SANS_CZECH_BOLD_BASE64), (c) => c.charCodeAt(0));
  const font = await doc.embedFont(bytes, { subset: true });

  // CORRECTIVE BATCH (4th, export-polish-only) — power labels ("N kW"/"EL") now use their own,
  // independently-tuned EXPORT_POWER_LABEL_FONT_SIZE_PT; INT/IP/fallback stay on the original
  // EXPORT_TEXT_SYMBOL_FONT_SIZE_PT, untouched by that batch.
  const powerLabels = new Set(["2 kW", "9 kW", "EL"]);
  for (const label of ["2 kW", "9 kW", "EL", "INT", "IP", "?"]) {
    const sizeForLabel = powerLabels.has(label) ? EXPORT_POWER_LABEL_FONT_SIZE_PT : EXPORT_TEXT_SYMBOL_FONT_SIZE_PT;
    const widthPt = font.widthOfTextAtSize(label, sizeForLabel);
    const heightPt = sizeForLabel;
    assert.ok(widthPt <= EXPORT_SYMBOL_MAX_BOUNDING_WIDTH_PT, `"${label}" width ${widthPt.toFixed(2)}pt exceeds the ${EXPORT_SYMBOL_MAX_BOUNDING_WIDTH_PT}pt ceiling`);
    assert.ok(heightPt <= EXPORT_SYMBOL_MAX_BOUNDING_HEIGHT_PT, `"${label}" height ${heightPt}pt exceeds the ${EXPORT_SYMBOL_MAX_BOUNDING_HEIGHT_PT}pt ceiling`);
    // Explicit mm assertion (spec: "diagnostikuj skutečnou FYZICKOU velikost... pt, mm") — a real
    // technician-facing symbol must read as a few millimeters, not a centimeters-wide badge. The
    // ceiling itself is a bit above the actual measured size (~6mm/~2.5mm at the post-acceptance
    // +17% bumped font size) rather than pinned razor-thin against it, so a future font-metric
    // rounding difference can never flip this test on its own.
    assert.ok(ptToMm(widthPt) < 7, `"${label}" is ${ptToMm(widthPt).toFixed(2)}mm wide — too large for a compact technical mark`);
    assert.ok(ptToMm(heightPt) < 4.5, `"${label}" is ${ptToMm(heightPt).toFixed(2)}mm tall — too large for a compact technical mark`);
  }
});

test("CORRECTIVE BATCH (4th, export-polish-only): electricity power labels are drawn at the smaller EXPORT_POWER_LABEL_FONT_SIZE_PT, INT/IP stay at the unchanged EXPORT_TEXT_SYMBOL_FONT_SIZE_PT, and both remain genuine vector-outline fills (never PDF text-showing operators)", async () => {
  const source = await buildPlainFixture();
  const powerPlacement = placementItem({ placementId: "p-power", xNormalized: 0.3, yNormalized: 0.5, presentation: resolveTechnicalServicePresentation("electricity", "Do 2kW 230V") });
  const intPlacement = placementItem({ placementId: "p-int", xNormalized: 0.7, yNormalized: 0.5, presentation: resolveTechnicalServicePresentation("internet", "Internet") });
  assert.equal(powerPlacement.presentation.displayLabel, "2 kW");
  assert.equal(intPlacement.presentation.displayLabel, "INT");

  const { bytes } = await buildTechnicalRasterVectorExportPdf({
    sourcePdfBytes: source, page: 1, placements: [powerPlacement, intPlacement], legend: [], showLegend: false, headerLine: "X",
  });

  // /Contents = [original, BDC, power-glyph-chunk, int-glyph-chunk, EMC] — drawn in placement order.
  const powerChunk = await readPage1ContentEntryFromEnd(bytes, 2);
  const intChunk = await readPage1ContentEntryFromEnd(bytes, 1);

  // Still genuine vector-outline fills, never text-showing operators, for BOTH labels.
  for (const [label, chunk] of [["power", powerChunk], ["INT", intChunk]] as const) {
    for (const forbidden of ["BT", "ET", "Tf", "Tj", "TJ"]) {
      assert.ok(!new RegExp(`(^|\\s)${forbidden}(\\s|$)`, "u").test(chunk), `${label} label: expected no "${forbidden}" text-showing operator, got: ${chunk}`);
    }
    assert.ok(/\bf\b/u.test(chunk), `${label} label: expected a nonzero-winding fill operator`);
  }

  // Independently re-derive, via the SAME embedded font fontkit shapes in production, the expected
  // glyph height at each candidate font size — then confirm the ACTUAL rendered height (mined
  // directly from the raw m/l/c operator coordinates) matches the label's OWN correct constant,
  // never the other one.
  const fontkitModule = (await import("@pdf-lib/fontkit")).default;
  const { NOTO_SANS_CZECH_BOLD_BASE64 } = await import("../lib/fonts/graphicsProductionFont.ts");
  const fontBytes = Uint8Array.from(atob(NOTO_SANS_CZECH_BOLD_BASE64), (c) => c.charCodeAt(0));
  const shapingFont = fontkitModule.create(fontBytes);

  function expectedHeightAt(text: string, fontSizePt: number): number {
    const glyphs = shapingFont.layout(text).glyphs;
    const minY = Math.min(...glyphs.map((glyph: { cbox: { minY: number } }) => glyph.cbox.minY));
    const maxY = Math.max(...glyphs.map((glyph: { cbox: { maxY: number } }) => glyph.cbox.maxY));
    return (maxY - minY) * (fontSizePt / shapingFont.unitsPerEm);
  }

  function actualHeightFromContent(chunk: string): number {
    const ys: number[] = [];
    for (const m of chunk.matchAll(/(-?[\d.]+) (-?[\d.]+) [ml]\b/gu)) ys.push(Number(m[2]));
    for (const m of chunk.matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) c/gu)) ys.push(Number(m[2]), Number(m[4]), Number(m[6]));
    return Math.max(...ys) - Math.min(...ys);
  }

  const powerActual = actualHeightFromContent(powerChunk);
  const powerExpectedNew = expectedHeightAt("2 kW", EXPORT_POWER_LABEL_FONT_SIZE_PT);
  const powerExpectedOld = expectedHeightAt("2 kW", EXPORT_TEXT_SYMBOL_FONT_SIZE_PT);
  assert.ok(
    Math.abs(powerActual - powerExpectedNew) < 0.05,
    `power label rendered height ${powerActual.toFixed(3)}pt must match the NEW ${EXPORT_POWER_LABEL_FONT_SIZE_PT}pt size (expected ~${powerExpectedNew.toFixed(3)}pt), not the old ${EXPORT_TEXT_SYMBOL_FONT_SIZE_PT}pt size (~${powerExpectedOld.toFixed(3)}pt)`,
  );

  const intActual = actualHeightFromContent(intChunk);
  const intExpectedOld = expectedHeightAt("INT", EXPORT_TEXT_SYMBOL_FONT_SIZE_PT);
  assert.ok(
    Math.abs(intActual - intExpectedOld) < 0.05,
    `INT label rendered height ${intActual.toFixed(3)}pt must stay at the UNCHANGED ${EXPORT_TEXT_SYMBOL_FONT_SIZE_PT}pt size (expected ~${intExpectedOld.toFixed(3)}pt) — INT must never be affected by the power-label-only size change`,
  );
});

// ============================================================================
// Corrective batch section 4: vector white mode export — real content-stream rewriting, verified
// at the LOW LEVEL (raw decoded content stream bytes, via pdf-lib directly — never trusting pdf.js's
// own canvas render, which this pipeline doesn't even use for the export).
// ============================================================================

/** A synthetic PDF whose page content stream tags a rectangle (red fill, blue stroke, painted via a single combined fill+stroke `B`) inside a "/OC /MC0 BDC ... EMC" span for an OCG named "STÁNKY ***" (matches this app's real alias-based stand-layer detection) — plus one rectangle OUTSIDE that span, which vector white mode must never touch. */
async function buildStandLayerContentFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const ctx = doc.context;

  const ocg = PDFDict.withContext(ctx);
  ocg.set(PDFName.of("Type"), PDFName.of("OCG"));
  ocg.set(PDFName.of("Name"), PDFHexString.fromText("STÁNKY ***"));
  const ocgRef = ctx.register(ocg);

  const props = PDFDict.withContext(ctx);
  props.set(PDFName.of("MC0"), ocgRef);
  const resources = page.node.lookup(PDFName.of("Resources"));
  if (resources instanceof PDFDict) resources.set(PDFName.of("Properties"), props);

  const ocgsArr = PDFArray.withContext(ctx);
  ocgsArr.push(ocgRef);
  const onArr = PDFArray.withContext(ctx);
  onArr.push(ocgRef);
  const orderArr = PDFArray.withContext(ctx);
  orderArr.push(ocgRef);
  const dDict = PDFDict.withContext(ctx);
  dDict.set(PDFName.of("BaseState"), PDFName.of("ON"));
  dDict.set(PDFName.of("ON"), onArr);
  dDict.set(PDFName.of("OFF"), PDFArray.withContext(ctx));
  dDict.set(PDFName.of("Order"), orderArr);
  const ocPropsDict = PDFDict.withContext(ctx);
  ocPropsDict.set(PDFName.of("OCGs"), ctx.register(ocgsArr));
  ocPropsDict.set(PDFName.of("D"), ctx.register(dDict));
  doc.catalog.set(PDFName.of("OCProperties"), ctx.register(ocPropsDict));

  const contentText = "/OC /MC0 BDC\n1 0 0 rg 0 0 1 RG 2 w 20 20 100 60 re B\nEMC\n0 0 0 rg 5 5 15 15 re f\n";
  const contentBytes = new TextEncoder().encode(contentText);
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(contentBytes, {})));

  return doc.save();
}

async function readPage1ContentText(bytes: Uint8Array): Promise<string> {
  const reloaded = await PDFDocument.load(bytes);
  const page1 = reloaded.getPage(0);
  const contents = page1.node.Contents();
  let stream: unknown;
  if (contents instanceof PDFArray) {
    stream = reloaded.context.lookup(contents.get(contents.size() - 1));
  } else {
    stream = reloaded.context.lookup(contents as never);
  }
  assert.ok(stream instanceof PDFRawStream, "page 1 must still have a real content stream after white mode");
  return new TextDecoder("latin1").decode(decodePDFRawStream(stream).decode());
}

/** Unlike readPage1ContentText above (which isolates only the LAST /Contents entry, for tests that want to inspect ONLY a freshly-appended overlay), this concatenates EVERY entry — needed once more than one overlay draw call has run, since each may land in its own separate appended stream. */
/**
 * CORRECTIVE BATCH (3rd) sections 10/11 — every overlay is now bracketed in `/OC ... BDC` / `EMC`,
 * so the LAST /Contents entry is always the trailing bare "EMC" chunk, never the last thing actually
 * DRAWN. `offsetFromEnd=1` (the default) grabs the entry right before that (the last real draw call's
 * own chunk) — tests that used to read "the last entry" to inspect one specific overlay draw (a
 * realization underline, drawn immediately before the EMC close) use this instead of the raw index.
 */
async function readPage1ContentEntryFromEnd(bytes: Uint8Array, offsetFromEnd = 1): Promise<string> {
  const reloaded = await PDFDocument.load(bytes);
  const page1 = reloaded.getPage(0);
  const contents = page1.node.Contents();
  let stream: unknown;
  if (contents instanceof PDFArray) {
    stream = reloaded.context.lookup(contents.get(contents.size() - 1 - offsetFromEnd));
  } else {
    stream = reloaded.context.lookup(contents as never);
  }
  assert.ok(stream instanceof PDFRawStream, "expected a real content stream at the requested position");
  return new TextDecoder("latin1").decode(decodePDFRawStream(stream).decode());
}

async function readAllPage1ContentText(bytes: Uint8Array): Promise<string> {
  const reloaded = await PDFDocument.load(bytes);
  const page1 = reloaded.getPage(0);
  const contents = page1.node.Contents();
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

test("corrective batch 4) vector white mode, opacity 1: stand fill becomes opaque white, stroke and unrelated content untouched, no ExtGState needed", async () => {
  const source = await buildStandLayerContentFixture();
  const { bytes, whiteModeDiagnostic } = await buildTechnicalRasterVectorExportPdf({
    sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X", whiteMode: { opacity: 1 },
  });
  assert.equal(whiteModeDiagnostic.status, "applied");
  // CORRECTIVE BATCH (3rd) sections 10/11 — a `/OC ... BDC`/`EMC` bracket is now ALWAYS appended
  // after the (single, patched) original content stream, even with nothing to draw between them, so
  // this must read ALL /Contents entries rather than only the last one.
  const text = await readAllPage1ContentText(bytes);
  assert.match(text, /1 1 1 rg/);
  assert.ok(!text.includes("1 0 0 rg"), "the original red stand fill must be gone");
  assert.match(text, /0 0 1 RG/, "stroke color is completely untouched");
  assert.match(text, /0 0 0 rg/, "content OUTSIDE the OCG span is completely untouched");
  assert.ok(!text.includes(" gs\n") && !text.includes(" gs "), "opacity 1 needs no ExtGState invocation at all");
});

test("corrective batch 4) vector white mode, opacity 0.6: wraps the stand span in q/gs/Q referencing a real ExtGState with /ca 0.6", async () => {
  const source = await buildStandLayerContentFixture();
  const { bytes, whiteModeDiagnostic } = await buildTechnicalRasterVectorExportPdf({
    sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X", whiteMode: { opacity: 0.6 },
  });
  assert.deepEqual(whiteModeDiagnostic, { status: "applied", whitenedFillCommandCount: 1, opacity: 0.6 });
  const text = await readAllPage1ContentText(bytes);
  assert.match(text, /q\n\/\S+ gs\n\s*1 1 1 rg[\s\S]*Q/);

  const reloaded = await PDFDocument.load(bytes);
  const page1 = reloaded.getPage(0);
  const resources = page1.node.lookup(PDFName.of("Resources"));
  assert.ok(resources instanceof PDFDict);
  const extGState = (resources as PDFDict).lookup(PDFName.of("ExtGState"));
  assert.ok(extGState instanceof PDFDict);
  const gsKey = extGState.keys().find((key) => key.decodeText().includes("TechRasterWhite"));
  assert.ok(gsKey, "a real ExtGState resource was registered for the opacity");
  const gsDict = extGState.lookup(gsKey!);
  assert.ok(gsDict instanceof PDFDict);
  assert.equal((gsDict as PDFDict).lookup(PDFName.of("ca"))?.toString(), "0.6");
});

test("REAL EXPORT CRASH REPRODUCTION: white mode at the DEFAULT 60% opacity (every new project's own default) PLUS a technical symbol AND a realization underline drawn afterward must complete without 'Contents.push is not a function' — this exact combination is what a real Hala 1 export always does", async () => {
  const source = await buildStandLayerContentFixture();
  const result = await buildTechnicalRasterVectorExportPdf({
    sourcePdfBytes: source,
    page: 1,
    placements: [placementItem()],
    legend: [],
    showLegend: false,
    headerLine: "X",
    whiteMode: { opacity: 0.6 },
    realizationUnderlines: [{ standId: "s1", xNormalized: 0.5, yNormalized: 0.5, widthNormalized: 0.05, color: "#2f8f4e" }],
  });
  assert.equal(result.whiteModeDiagnostic.status, "applied");
  const text = await readAllPage1ContentText(result.bytes);
  assert.match(text, /1 1 1 rg/, "white mode content survives");
  // CORRECTIVE BATCH (3rd) sections 8/9 — the "3 kW" marker drawn AFTER white mode is no longer
  // extractable PDF text (it is genuine vector-outline fill geometry, on purpose — see
  // domain/technicalRasterVectorGlyphOutline.ts's own doc); its own presentation color (#b3261e ->
  // 0.702 0.149 0.118) followed by a fill operator is the structural proof it survived instead.
  assert.match(text, /0\.702 0\.149 0\.118 rg[\s\S]*\bf\b/u, `expected the technical symbol's own vector-outline fill to survive after white mode, got: ${text}`);
});

test("REAL EXPORT CRASH REPRODUCTION (multi-page function, the one the real UI actually calls): white mode + placements + realization underlines + legend across 2 pages completes without throwing", async () => {
  const source = await buildStandLayerContentFixture();
  const result = await buildTechnicalRasterMultiPageVectorExportPdf({
    sourcePdfBytes: source,
    pages: [{
      page: 1,
      placements: [placementItem()],
      realizationUnderlines: [{ standId: "s1", xNormalized: 0.4, yNormalized: 0.4, widthNormalized: 0.05, color: "#2f8f4e" }],
    }],
    legend: [{ legendLabel: "PŘÍVOD EL. ENERGIE", color: "#b3261e", renderer: "powerLabel" }],
    showLegend: true,
    headerLine: "X",
    whiteMode: { opacity: 0.6 },
    includeRealizationKey: true,
  });
  assert.equal(result.whiteModeDiagnosticsByPage[0]?.status, "applied");
  const reloaded = await PDFDocument.load(result.bytes);
  assert.equal(reloaded.getPageCount(), 2);
});

test("corrective batch 4) vector white mode, opacity 0: fill is fully transparent (ca 0) yet still patched, stroke stays fully opaque/original", async () => {
  const source = await buildStandLayerContentFixture();
  const { whiteModeDiagnostic } = await buildTechnicalRasterVectorExportPdf({
    sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X", whiteMode: { opacity: 0 },
  });
  assert.deepEqual(whiteModeDiagnostic, { status: "applied", whitenedFillCommandCount: 1, opacity: 0 });
});

test("POST-ACCEPTANCE POLICY CHANGE section 2) vector white mode requested but no stand layer exists: the WHOLE EXPORT now fails explicitly, never a silent original-colors fallback", async () => {
  const source = await buildPlainFixture();
  await assert.rejects(
    buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X", whiteMode: { opacity: 0.6 } }),
    (error: unknown) => {
      assert.ok(error instanceof TechnicalRasterVectorExportError);
      assert.equal(error.code, "WHITE_MODE_UNSUPPORTED");
      assert.equal(error.page, 1);
      assert.match(error.message, /Stránku 1/u);
      return true;
    },
  );
});

test("POST-ACCEPTANCE POLICY CHANGE section 2) a Pattern-space fill inside the stand layer also fails the whole export (same policy — never a partial/fallback export)", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const ctx = doc.context;
  const ocg = PDFDict.withContext(ctx);
  ocg.set(PDFName.of("Type"), PDFName.of("OCG"));
  ocg.set(PDFName.of("Name"), PDFHexString.fromText("STÁNKY ***"));
  const ocgRef = ctx.register(ocg);
  const props = PDFDict.withContext(ctx);
  props.set(PDFName.of("MC0"), ocgRef);
  const resources = page.node.lookup(PDFName.of("Resources"));
  if (resources instanceof PDFDict) resources.set(PDFName.of("Properties"), props);
  const ocgsArr = PDFArray.withContext(ctx);
  ocgsArr.push(ocgRef);
  const onArr = PDFArray.withContext(ctx);
  onArr.push(ocgRef);
  const dDict = PDFDict.withContext(ctx);
  dDict.set(PDFName.of("ON"), onArr);
  const ocPropsDict = PDFDict.withContext(ctx);
  ocPropsDict.set(PDFName.of("OCGs"), ctx.register(ocgsArr));
  ocPropsDict.set(PDFName.of("D"), ctx.register(dDict));
  doc.catalog.set(PDFName.of("OCProperties"), ctx.register(ocPropsDict));
  const contentBytes = new TextEncoder().encode("/OC /MC0 BDC\n/Pattern cs /P1 scn 0 0 10 10 re f\nEMC\n");
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(contentBytes, {})));
  const source = await doc.save();

  await assert.rejects(
    buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X", whiteMode: { opacity: 1 } }),
    /WHITE_MODE_UNSUPPORTED|Pattern/u,
  );
});

test("POST-ACCEPTANCE POLICY CHANGE section 2) multi-page: white mode unsupported on ANY page fails the WHOLE multi-page export atomically", async () => {
  const source = await buildPlainFixture();
  await assert.rejects(
    buildTechnicalRasterMultiPageVectorExportPdf({
      sourcePdfBytes: source,
      pages: [{ page: 1, placements: [] }],
      legend: [],
      showLegend: false,
      headerLine: "X",
      whiteMode: { opacity: 0.6 },
    }),
    (error: unknown) => {
      assert.ok(error instanceof TechnicalRasterVectorExportError);
      assert.equal(error.code, "WHITE_MODE_UNSUPPORTED");
      assert.equal(error.page, 1);
      return true;
    },
  );
});

test("POST-ACCEPTANCE POLICY CHANGE section 2) white mode NOT requested still exports fine even when the stand layer can't be found (the requirement only ever applies when white mode is actually requested)", async () => {
  const source = await buildPlainFixture();
  const { whiteModeDiagnostic } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X" });
  assert.deepEqual(whiteModeDiagnostic, { status: "not_requested" });
});

test("corrective batch 4) no whiteMode requested at all: byte-for-byte the same 'not_requested' behavior as before this batch existed", async () => {
  const source = await buildStandLayerContentFixture();
  const { bytes, whiteModeDiagnostic } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X" });
  assert.deepEqual(whiteModeDiagnostic, { status: "not_requested" });
  const text = await readAllPage1ContentText(bytes);
  assert.match(text, /1 0 0 rg/, "original stand fill color is fully preserved when white mode is never requested");
});

// ============================================================================
// Corrective batch section 5: /Catalog /OCProperties /D /Order must actually exist at the LOW
// PDF-STRUCTURE LEVEL — pdf.js's own getOptionalContentConfig() can SYNTHESIZE an order when /Order
// is absent (see "OCG hardening: no duplicate catalog registrations" above, which already shows
// pdf.js reporting a 2-entry order even before this batch ever wrote one) — so it is never proof
// that /D/Order was actually written. These tests read the catalog directly via pdf-lib instead.
// ============================================================================

test("corrective batch 5) /Catalog /OCProperties /D /Order actually exists as a real PDFArray, not just a pdf.js-synthesized order", async () => {
  const source = await buildOcgFixture(); // 2 OCGs, no /D/Order in the SOURCE itself
  const { bytes, ocgDiagnostic } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X" });
  assert.equal(ocgDiagnostic.orderReconstructed, true);

  const reloaded = await PDFDocument.load(bytes);
  const ocProps = reloaded.catalog.lookup(PDFName.of("OCProperties"));
  assert.ok(ocProps instanceof PDFDict);
  const d = (ocProps as PDFDict).lookup(PDFName.of("D"));
  assert.ok(d instanceof PDFDict);
  const order = (d as PDFDict).lookup(PDFName.of("Order"));
  assert.ok(order instanceof PDFArray, "/D/Order must be a real PDFArray at the raw PDF-object level");
  // CORRECTIVE BATCH (3rd) sections 10/11 — the generator's own "GENERÁTOR DATA" OCG is always
  // appended to /D/Order too, alongside the 2 reconstructed source groups.
  assert.equal((order as PDFArray).size(), 3);
});

/** Same 12-layer shape docs/technical-rasters.md describes for Hala 1.pdf, but here as a fully synthetic, committable fixture — a nested /D/Order (one top-level heading string, two real OCGs grouped under it, plus one flat OCG) mirroring how a real hall-plan PDF groups its layers under headings in Acrobat's own Layers panel. */
async function buildNestedOrderOcgFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const ctx = doc.context;

  function ocg(name: string) {
    const dict = PDFDict.withContext(ctx);
    dict.set(PDFName.of("Type"), PDFName.of("OCG"));
    dict.set(PDFName.of("Name"), PDFHexString.fromText(name));
    return ctx.register(dict);
  }
  const a = ocg("STÁNKY ***");
  const b = ocg("POPISKY");
  const c = ocg("MŘÍŽKA");

  const props = PDFDict.withContext(ctx);
  props.set(PDFName.of("OCa"), a);
  props.set(PDFName.of("OCb"), b);
  props.set(PDFName.of("OCc"), c);
  const resources = page.node.lookup(PDFName.of("Resources"));
  if (resources instanceof PDFDict) resources.set(PDFName.of("Properties"), props);

  const ocgsArr = PDFArray.withContext(ctx);
  [a, b, c].forEach((ref) => ocgsArr.push(ref));
  const onArr = PDFArray.withContext(ctx);
  [a, b, c].forEach((ref) => onArr.push(ref));

  // /Order = [ "SKUPINA" [ a b ] c ] — a heading string followed by a nested subtree, then one
  // flat entry (real PDF spec shape, 8.11.4.3).
  const nested = PDFArray.withContext(ctx);
  nested.push(a);
  nested.push(b);
  const order = PDFArray.withContext(ctx);
  order.push(PDFHexString.fromText("SKUPINA"));
  order.push(nested);
  order.push(c);

  const dDict = PDFDict.withContext(ctx);
  dDict.set(PDFName.of("BaseState"), PDFName.of("ON"));
  dDict.set(PDFName.of("ON"), onArr);
  dDict.set(PDFName.of("OFF"), PDFArray.withContext(ctx));
  dDict.set(PDFName.of("Order"), order);
  const ocPropsDict = PDFDict.withContext(ctx);
  ocPropsDict.set(PDFName.of("OCGs"), ctx.register(ocgsArr));
  ocPropsDict.set(PDFName.of("D"), ctx.register(dDict));
  doc.catalog.set(PDFName.of("OCProperties"), ctx.register(ocPropsDict));

  return doc.save();
}

test("corrective batch 5) a nested /D/Order (heading string + sub-group) is preserved structurally, not flattened", async () => {
  const source = await buildNestedOrderOcgFixture();
  const { bytes, ocgDiagnostic } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X" });
  assert.equal(ocgDiagnostic.reconstructedOcgCount, 3);
  assert.equal(ocgDiagnostic.orderReconstructed, true);

  const reloaded = await PDFDocument.load(bytes);
  const ocProps = reloaded.catalog.lookup(PDFName.of("OCProperties"));
  const d = (ocProps as PDFDict).lookup(PDFName.of("D"));
  const order = (d as PDFDict).lookup(PDFName.of("Order")) as PDFArray;
  // CORRECTIVE BATCH (3rd) sections 10/11 — "GENERÁTOR DATA" is appended as one more flat entry.
  assert.equal(order.size(), 4, "heading string + nested subgroup array + one flat OCG ref + GENERÁTOR DATA");
  assert.ok(order.get(0) instanceof PDFString, "the heading string survives");
  assert.equal((order.get(0) as PDFString).decodeText(), "SKUPINA");
  assert.ok(order.get(1) instanceof PDFArray, "the nested sub-group survives as a real nested array, never flattened");
  assert.equal((order.get(1) as PDFArray).size(), 2);
});

test("corrective batch 5) an /Order entry pointing at an OCG this page never actually uses is dropped, never a dangling reference", async () => {
  // Reuse buildOcgFixtureWithOrphanedGroup (VRSTVA A is referenced by the page, the orphan is not)
  // but this time also declare a /D/Order that names BOTH — the orphan must be dropped from Order
  // too, not just from /OCGs/ON.
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const ctx = doc.context;
  const a = (() => { const d = PDFDict.withContext(ctx); d.set(PDFName.of("Type"), PDFName.of("OCG")); d.set(PDFName.of("Name"), PDFHexString.fromText("VRSTVA A")); return ctx.register(d); })();
  const orphan = (() => { const d = PDFDict.withContext(ctx); d.set(PDFName.of("Type"), PDFName.of("OCG")); d.set(PDFName.of("Name"), PDFHexString.fromText("SIROTEK")); return ctx.register(d); })();
  const props = PDFDict.withContext(ctx);
  props.set(PDFName.of("OC1"), a);
  const resources = page.node.lookup(PDFName.of("Resources"));
  if (resources instanceof PDFDict) resources.set(PDFName.of("Properties"), props);
  const ocgsArr = PDFArray.withContext(ctx);
  [a, orphan].forEach((ref) => ocgsArr.push(ref));
  const onArr = PDFArray.withContext(ctx);
  [a, orphan].forEach((ref) => onArr.push(ref));
  const order = PDFArray.withContext(ctx);
  order.push(a);
  order.push(orphan);
  const dDict = PDFDict.withContext(ctx);
  dDict.set(PDFName.of("ON"), onArr);
  dDict.set(PDFName.of("Order"), order);
  const ocPropsDict = PDFDict.withContext(ctx);
  ocPropsDict.set(PDFName.of("OCGs"), ctx.register(ocgsArr));
  ocPropsDict.set(PDFName.of("D"), ctx.register(dDict));
  doc.catalog.set(PDFName.of("OCProperties"), ctx.register(ocPropsDict));
  const source = await doc.save();

  const { bytes } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X" });
  const reloaded = await PDFDocument.load(bytes);
  const ocProps = reloaded.catalog.lookup(PDFName.of("OCProperties"));
  const d = (ocProps as PDFDict).lookup(PDFName.of("D"));
  const orderOut = (d as PDFDict).lookup(PDFName.of("Order")) as PDFArray;
  // CORRECTIVE BATCH (3rd) sections 10/11 — "GENERÁTOR DATA" is always appended too.
  assert.equal(orderOut.size(), 2, "the orphaned OCG must never appear in the exported /Order — only VRSTVA A + GENERÁTOR DATA");
});

// ============================================================================
// CORRECTIVE BATCH (3rd) sections 10/11 — "GENERÁTOR DATA" OCG. Real manual acceptance: turning
// off all 12 original source layers in Acrobat left the generated technical markers/realization
// underlines still visible, since nothing tagged them as belonging to anything. These tests pin the
// exact structural requirements from the spec's own acceptance checklist.
// ============================================================================

test("GENERÁTOR DATA: created exactly once, appears in /OCGs, appears in /D/Order, default ON, and a source PDF with NO layers at all still gets it", async () => {
  const source = await buildPlainFixture(); // no /OCProperties at all
  const placements = [placementItem({ presentation: resolveTechnicalServicePresentation("electricity", "Do 3kW 230V") })];
  const { bytes } = await buildTechnicalRasterVectorExportPdf({
    sourcePdfBytes: source, page: 1, placements, legend: [], showLegend: false, headerLine: "X",
    realizationUnderlines: [{ standId: "s1", xNormalized: 0.4, yNormalized: 0.5, widthNormalized: 0.08, color: "#2f8f4e" }],
  });
  const reloaded = await PDFDocument.load(bytes);
  const ocProps = reloaded.catalog.lookup(PDFName.of("OCProperties"));
  assert.ok(ocProps instanceof PDFDict, "a fresh /OCProperties structure must be created even for a source with none");
  const ocgsArr = (ocProps as PDFDict).lookup(PDFName.of("OCGs")) as PDFArray;
  assert.equal(ocgsArr.size(), 1, "exactly one OCG — GENERÁTOR DATA — never duplicated");
  const ocg = reloaded.context.lookup(ocgsArr.get(0));
  assert.ok(ocg instanceof PDFDict);
  assert.equal((ocg as PDFDict).lookup(PDFName.of("Name"))?.toString().includes("GENER"), true);

  const d = (ocProps as PDFDict).lookup(PDFName.of("D")) as PDFDict;
  assert.equal(d.lookup(PDFName.of("BaseState"))?.toString(), "/ON");
  const onArr = d.lookup(PDFName.of("ON")) as PDFArray;
  assert.equal(onArr.size(), 1, "GENERÁTOR DATA is ON by default");
  const orderArr = d.lookup(PDFName.of("Order")) as PDFArray;
  assert.equal(orderArr.size(), 1, "GENERÁTOR DATA appears in /D/Order");
  const offArr = d.lookup(PDFName.of("OFF"));
  assert.ok(!(offArr instanceof PDFArray) || offArr.size() === 0, "never placed in /D/OFF");

  const { ocConfig } = await decodeForInspection(bytes);
  const config = ocConfig.getGroup(ocConfig.getOrder()![0]!);
  assert.equal(config?.name, "GENERÁTOR DATA");
});

test("GENERÁTOR DATA: original source OCGs remain untouched, and generator overlay content is actually marked as belonging to it (real /OC BDC ... EMC span in the content stream, resolvable via the page's own /Resources/Properties)", async () => {
  const source = await buildOcgFixture(); // 2 real source OCGs
  const placements = [placementItem({ presentation: resolveTechnicalServicePresentation("electricity", "Do 3kW 230V") })];
  const { bytes } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements, legend: [], showLegend: false, headerLine: "X" });

  const reloaded = await PDFDocument.load(bytes);
  const page1 = reloaded.getPage(0);
  const resources = page1.node.lookup(PDFName.of("Resources")) as PDFDict;
  const properties = resources.lookup(PDFName.of("Properties")) as PDFDict;
  // Find the /Resources/Properties key pointing at the GENERÁTOR DATA OCG.
  const ocProps = reloaded.catalog.lookup(PDFName.of("OCProperties")) as PDFDict;
  const d = ocProps.lookup(PDFName.of("D")) as PDFDict;
  const orderArr = d.lookup(PDFName.of("Order")) as PDFArray;
  const genDataRef = orderArr.get(orderArr.size() - 1); // appended last, after the 2 source layers
  const propertyKey = properties.keys().find((key) => properties.get(key)?.toString() === genDataRef.toString());
  assert.ok(propertyKey, "the page's own /Resources/Properties must map SOME key to the GENERÁTOR DATA OCG ref");

  const text = await readAllPage1ContentText(bytes);
  const bdcPattern = new RegExp(`/OC /${propertyKey!.decodeText().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} BDC`, "u");
  assert.match(text, bdcPattern, "the overlay content is bracketed by a real /OC ... BDC operator referencing the resolved property key");
  assert.match(text, /EMC/u, "the bracket is closed with a real EMC operator");

  // Original source OCGs remain fully intact — 2 groups, plus GENERÁTOR DATA = 3.
  const ocgsArr = ocProps.lookup(PDFName.of("OCGs")) as PDFArray;
  assert.equal(ocgsArr.size(), 3);
});

test("GENERÁTOR DATA: source raster content is never accidentally moved into it — the ORIGINAL copied content stream (page.doc content BEFORE any BDC) is completely untouched", async () => {
  const source = await buildStandLayerContentFixture(); // has real content OUTSIDE the app's own overlay
  const { bytes } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X" });
  const reloaded = await PDFDocument.load(bytes);
  const page1 = reloaded.getPage(0);
  const contents = page1.node.Contents();
  assert.ok(contents instanceof PDFArray);
  const firstEntry = reloaded.context.lookup(contents.get(0));
  assert.ok(firstEntry instanceof PDFRawStream);
  const firstText = new TextDecoder("latin1").decode(decodePDFRawStream(firstEntry).decode());
  // The fixture's own real content (the "outside the OCG span" black rectangle at the end, and the
  // stand-layer's own BDC/EMC span) survives as the FIRST content entry, entirely BEFORE the
  // generator's own separate BDC bracket — never merged/moved into the GENERÁTOR DATA span itself.
  assert.match(firstText, /\/OC \/MC0 BDC/u, "the SOURCE's own marked-content span is untouched");
  assert.match(firstText, /0 0 0 rg 5 5 15 15 re f/u, "content outside the source's own OCG span is untouched and stays in the original stream");
  assert.ok(!/GenData/u.test(firstText), "the original content is never itself tagged with the generator's own property key");
});

test("GENERÁTOR DATA: white-mode's own rewrite of source stand fills stays OUTSIDE the GENERÁTOR DATA span — white mode transforms EXISTING content, it is never generator-added content", async () => {
  const source = await buildStandLayerContentFixture();
  const { bytes, whiteModeDiagnostic } = await buildTechnicalRasterVectorExportPdf({
    sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X", whiteMode: { opacity: 1 },
  });
  assert.equal(whiteModeDiagnostic.status, "applied");
  const reloaded = await PDFDocument.load(bytes);
  const page1 = reloaded.getPage(0);
  const contents = page1.node.Contents() as PDFArray;
  const firstEntry = reloaded.context.lookup(contents.get(0));
  const firstText = new TextDecoder("latin1").decode(decodePDFRawStream(firstEntry as PDFRawStream).decode());
  assert.match(firstText, /1 1 1 rg/u, "the whitened fill is part of the FIRST (pre-bracket) content entry");
  // The fixture's own SOURCE content legitimately has its own "/OC /MC0 BDC" (the stand layer's own
  // marked content, untouched by this batch) — the check here is specifically that the generator's
  // OWN property key never appears in this pre-bracket stream, not that no BDC exists at all.
  assert.ok(!firstText.includes("GenData"), "the white-mode-rewritten stream itself never references the generator's own OC property — it is emitted BEFORE the bracket is opened");
});

test("GENERÁTOR DATA: multiple pages in a multi-page export re-use the SAME OCG object — never duplicated across pages", async () => {
  const source = await buildTwoPageOcgSourceFixture();
  const { bytes } = await buildTechnicalRasterMultiPageVectorExportPdf({
    sourcePdfBytes: source,
    pages: [{ page: 1, placements: [] }, { page: 2, placements: [] }],
    legend: [],
    showLegend: false,
    headerLine: "X",
  });
  const reloaded = await PDFDocument.load(bytes);
  const ocProps = reloaded.catalog.lookup(PDFName.of("OCProperties")) as PDFDict;
  const ocgsArr = ocProps.lookup(PDFName.of("OCGs")) as PDFArray;
  const genDataNames = [];
  for (let i = 0; i < ocgsArr.size(); i += 1) {
    const ocg = reloaded.context.lookup(ocgsArr.get(i));
    const name = ocg instanceof PDFDict ? ocg.lookup(PDFName.of("Name"))?.toString() : undefined;
    if (name?.includes("GENER")) genDataNames.push(name);
  }
  assert.equal(genDataNames.length, 1, "exactly one GENERÁTOR DATA entry in the FINAL /OCProperties/OCGs — never duplicated across the 2-page loop");

  // Both pages' own /Resources/Properties must resolve to the SAME underlying OCG object.
  const page1Props = (reloaded.getPage(0).node.lookup(PDFName.of("Resources")) as PDFDict).lookup(PDFName.of("Properties")) as PDFDict;
  const page2Props = (reloaded.getPage(1).node.lookup(PDFName.of("Resources")) as PDFDict).lookup(PDFName.of("Properties")) as PDFDict;
  const page1GenRef = page1Props.keys().map((k) => page1Props.get(k)).find((ref) => {
    const ocg = reloaded.context.lookup(ref!);
    return ocg instanceof PDFDict && ocg.lookup(PDFName.of("Name"))?.toString().includes("GENER");
  });
  const page2GenRef = page2Props.keys().map((k) => page2Props.get(k)).find((ref) => {
    const ocg = reloaded.context.lookup(ref!);
    return ocg instanceof PDFDict && ocg.lookup(PDFName.of("Name"))?.toString().includes("GENER");
  });
  assert.ok(page1GenRef && page2GenRef);
  assert.equal(page1GenRef!.toString(), page2GenRef!.toString(), "both pages' own Properties entries point at the SAME shared OCG ref");
});

async function buildTwoPageOcgSourceFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([300, 200]).drawText("PAGE ONE", { x: 20, y: 100, size: 12, font, color: rgb(0, 0, 0) });
  doc.addPage([300, 200]).drawText("PAGE TWO", { x: 20, y: 100, size: 12, font, color: rgb(0, 0, 0) });
  return doc.save();
}

// ============================================================================
// Corrective batch (post real-file acceptance test) section 4/5/14: realization underlines.
// REPLACES the earlier "badge" tests entirely — that design (white box + dark outline + redrawn
// stand number) failed manual acceptance.
// ============================================================================

test("POST-ACCEPTANCE REDESIGN section 4/5) a realization underline draws ONLY a plain colored line — no text, no box, no fill, never redraws the stand number", async () => {
  const source = await buildPlainFixture();
  const { bytes } = await buildTechnicalRasterVectorExportPdf({
    sourcePdfBytes: source,
    page: 1,
    placements: [],
    legend: [],
    showLegend: false,
    headerLine: "X",
    realizationUnderlines: [{ standId: "s1", xNormalized: 0.4, yNormalized: 0.5, widthNormalized: 0.08, color: "#2f8f4e" }],
  });
  const { textContent } = await decodeForInspection(bytes);
  const joined = (textContent.items as { str: string }[]).map((item) => item.str).join("");
  assert.ok(!/\d[A-Z]\d\d/u.test(joined), `the underline must never draw the stand number as text, got: ${joined}`);

  // CORRECTIVE BATCH (3rd) sections 10/11 — the underline's own draw chunk is now the entry right
  // BEFORE the trailing GENERÁTOR DATA "EMC" close, not the last entry outright.
  const streamText = await readPage1ContentEntryFromEnd(bytes);
  assert.match(streamText, /0\.18[0-9]* 0\.560[0-9]* 0\.30[0-9]* RG/u, "a stroke color op (RG), not a fill (rg) — a plain vector line");
  assert.match(streamText, /\bS\b/u, "a stroke paint operator");
});

test("POST-ACCEPTANCE REDESIGN section 4/5) realization underlines never appear unless explicitly provided (an empty export stays empty)", async () => {
  const source = await buildPlainFixture();
  const { bytes } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X" });
  const { textContent } = await decodeForInspection(bytes);
  const joined = (textContent.items as { str: string }[]).map((item) => item.str).join("");
  assert.ok(!/\d[A-Z]\d\d/u.test(joined), "no stand-number-shaped text when realizationUnderlines is omitted");
});

test("POST-ACCEPTANCE REDESIGN section 5) underline endpoints follow the given normalized geometry, rotation-aware (reuses the same point transform as technical symbols)", async () => {
  const source = await buildPlainFixture(); // 300x200, rotation 0
  const geometry = await resolveSourcePageGeometry(source, 1);
  const item = { standId: "s1", xNormalized: 0.2, yNormalized: 0.3, widthNormalized: 0.1, color: "#b3261e" };
  const expectedStart = { x: item.xNormalized * geometry.displayWidthPt, y: geometry.displayHeightPt - item.yNormalized * geometry.displayHeightPt };
  const expectedEnd = { x: (item.xNormalized + item.widthNormalized) * geometry.displayWidthPt, y: expectedStart.y };

  const { bytes } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X", realizationUnderlines: [item] });
  const streamText = await readPage1ContentEntryFromEnd(bytes);
  const moveMatch = /(-?[\d.]+)\s+(-?[\d.]+)\s+m/u.exec(streamText);
  const lineMatch = /(-?[\d.]+)\s+(-?[\d.]+)\s+l/u.exec(streamText);
  assert.ok(moveMatch && lineMatch, `expected real 'm'/'l' path operators, got: ${streamText}`);
  assert.ok(Math.abs(Number(moveMatch![1]) - expectedStart.x) < 0.1 && Math.abs(Number(moveMatch![2]) - expectedStart.y) < 0.1, `start point mismatch: got (${moveMatch![1]}, ${moveMatch![2]}), expected ~(${expectedStart.x}, ${expectedStart.y})`);
  assert.ok(Math.abs(Number(lineMatch![1]) - expectedEnd.x) < 0.1 && Math.abs(Number(lineMatch![2]) - expectedEnd.y) < 0.1, `end point mismatch: got (${lineMatch![1]}, ${lineMatch![2]}), expected ~(${expectedEnd.x}, ${expectedEnd.y})`);
});

test("POST-ACCEPTANCE REDESIGN section 14) the underline is drawn with a real vector stroke at the central thickness constant — no transparency/ExtGState needed for it", async () => {
  const { REALIZATION_UNDERLINE_THICKNESS_PT } = await import("../domain/technicalRasterExportSymbolSize.ts");
  const source = await buildPlainFixture();
  const { bytes } = await buildTechnicalRasterVectorExportPdf({
    sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X",
    realizationUnderlines: [{ standId: "s1", xNormalized: 0.4, yNormalized: 0.5, widthNormalized: 0.08, color: "#2f8f4e" }],
  });
  const streamText = await readPage1ContentEntryFromEnd(bytes);
  assert.match(streamText, new RegExp(`${REALIZATION_UNDERLINE_THICKNESS_PT}\\s+w`, "u"));
});

test("corrective batch 10) the legend's REALIZACE key lists all 4 canonical groups when includeRealizationKey is true, and is absent otherwise", async () => {
  const source = await buildPlainFixture();
  const withKey = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: true, headerLine: "X", includeRealizationKey: true });
  const reloadedWithKey = await PDFDocument.load(withKey.bytes);
  const legendPage = reloadedWithKey.getPage(1);
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const docWithKey = await pdfjsLib.getDocument({ data: await withKey.bytes }).promise;
  const legendTextWithKey = ((await (await docWithKey.getPage(2)).getTextContent()).items as { str: string }[]).map((item) => item.str).join(" ");
  assert.ok(legendTextWithKey.includes("REALIZACE"));
  assert.ok(legendTextWithKey.includes("GENDAI"));
  assert.ok(legendTextWithKey.includes("CREATIV EXPO"));
  assert.ok(legendTextWithKey.includes("MAC PRAHA"));
  assert.ok(legendTextWithKey.includes("OSTATNÍ"));
  void legendPage;

  const withoutKey = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: true, headerLine: "X" });
  const docWithoutKey = await pdfjsLib.getDocument({ data: await withoutKey.bytes }).promise;
  const legendTextWithoutKey = ((await (await docWithoutKey.getPage(2)).getTextContent()).items as { str: string }[]).map((item) => item.str).join(" ");
  assert.ok(!legendTextWithoutKey.includes("REALIZACE"));
});

// ============================================================================
// Corrective batch section 7: in-place ("source-legend-area") legend placement.
// ============================================================================

test("corrective batch 7) source-legend-area draws the legend directly on the source page — no separate page 2 is appended, page 1's own size is untouched", async () => {
  const source = await buildPlainFixture(); // 300x200
  const legend = [{ legendLabel: "PŘÍVOD EL. ENERGIE", color: "#b3261e", renderer: "powerLabel" as const }];
  const { bytes } = await buildTechnicalRasterVectorExportPdf({
    sourcePdfBytes: source,
    page: 1,
    placements: [],
    legend,
    showLegend: true,
    headerLine: "X",
    legendPlacement: { strategy: "source-legend-area", sourceRegion: { page: 1, xNormalized: 0.7, yNormalized: 0.8, widthNormalized: 0.25, heightNormalized: 0.15 } },
  });
  const reloaded = await PDFDocument.load(bytes);
  assert.equal(reloaded.getPageCount(), 1, "no separate legend page when drawn in-place");
  const page1 = reloaded.getPage(0);
  assert.equal(page1.getWidth(), 300);
  assert.equal(page1.getHeight(), 200);

  const { textContent } = await decodeForInspection(bytes);
  const joined = (textContent.items as { str: string }[]).map((item) => item.str).join(" ");
  assert.ok(joined.includes("LEGENDA"));
  assert.ok(joined.includes("PŘÍVOD EL. ENERGIE"));
});

test("corrective batch 7) source-legend-area with no configured region falls back to today's separate-page behavior", async () => {
  const source = await buildPlainFixture();
  const { bytes } = await buildTechnicalRasterVectorExportPdf({
    sourcePdfBytes: source,
    page: 1,
    placements: [],
    legend: [],
    showLegend: true,
    headerLine: "X",
    legendPlacement: { strategy: "source-legend-area" },
  });
  const reloaded = await PDFDocument.load(bytes);
  assert.equal(reloaded.getPageCount(), 2, "no region configured -> safe fallback to the existing separate legend page");
});

test("corrective batch 7) multi-page: source-legend-area targets ONE specific page, other pages are untouched and no extra page is appended", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([300, 200]);
  doc.addPage([300, 200]);
  const source = await doc.save();
  const legend = [{ legendLabel: "PŘÍVOD EL. ENERGIE", color: "#b3261e", renderer: "powerLabel" as const }];

  const { buildTechnicalRasterMultiPageVectorExportPdf } = await import("../lib/technicalRasterVectorPdf.ts");
  const { bytes, legendPageNumber } = await buildTechnicalRasterMultiPageVectorExportPdf({
    sourcePdfBytes: source,
    pages: [{ page: 1, placements: [] }, { page: 2, placements: [] }],
    legend,
    showLegend: true,
    headerLine: "X",
    legendPlacement: { strategy: "source-legend-area", sourceRegion: { page: 2, xNormalized: 0.7, yNormalized: 0.8, widthNormalized: 0.25, heightNormalized: 0.15 } },
  });
  const reloaded = await PDFDocument.load(bytes);
  assert.equal(reloaded.getPageCount(), 2, "no separate legend page appended");
  assert.equal(legendPageNumber, 2);

  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const docReloaded = await pdfjsLib.getDocument({ data: await bytes }).promise;
  const page1Text = ((await (await docReloaded.getPage(1)).getTextContent()).items as { str: string }[]).map((item) => item.str).join(" ");
  const page2Text = ((await (await docReloaded.getPage(2)).getTextContent()).items as { str: string }[]).map((item) => item.str).join(" ");
  assert.ok(!page1Text.includes("LEGENDA"), "page 1 (not the targeted region's page) must be untouched");
  assert.ok(page2Text.includes("LEGENDA"));
});

// ============================================================================
// Corrective batch section 6 — CorelDRAW compatibility diagnostic: pdf-lib's own `autoNormalizeCTM`
// (on by default) splits the already-copied source content into a bare "q" / <original content> /
// bare "Q" across THREE separate `/Contents` array entries the first time the page is normalized,
// then appends the overlay as a fourth — a shape a less strict PDF importer could plausibly
// mishandle (see lib/technicalRasterVectorPdf.ts's own disableUnnecessaryAutoNormalizeCtm doc for
// the full real-file verification). This pipeline explicitly disables it since it never
// rescales/retranslates the copied page, so it serves no purpose here.
// ============================================================================

test("corrective batch 6) the copied source content is never split by an unnecessary auto-normalize q/Q wrap — the FIRST /Contents entry is always the untouched original", async () => {
  const source = await buildPlainFixture();
  const { bytes } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [placementItem()], legend: [], showLegend: false, headerLine: "X" });
  const reloaded = await PDFDocument.load(bytes);
  const page1 = reloaded.getPage(0);
  const contents = page1.node.Contents();
  assert.ok(contents instanceof PDFArray, "the overlay is still real, separate content streams appended after the original");
  const arr = contents as PDFArray;
  // CORRECTIVE BATCH (3rd) sections 9/11 — the overlay is now [original, /OC BDC bracket, the
  // marker's own vector-outline fill content, EMC] = 4 entries (a placement drawn as vector
  // geometry appends its OWN content chunk, and the whole overlay span is bracketed for the new
  // GENERÁTOR DATA OCG) — never a bare auto-normalize q/Q wrap splitting the ORIGINAL content
  // itself, which is what this test actually guards against.
  assert.equal(arr.size(), 4, "original + BDC bracket + one vector marker chunk + EMC — never a bare q/Q wrap splitting the original into extra entries");
  const first = reloaded.context.lookup(arr.get(0));
  assert.ok(first instanceof PDFRawStream);
  const firstText = new TextDecoder("latin1").decode(decodePDFRawStream(first).decode());
  assert.ok(!/^\s*q\s*$/u.test(firstText), "the first stream must be the ORIGINAL source content, not a bare 'q'");
});
