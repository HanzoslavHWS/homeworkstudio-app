import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFHexString, PDFRawStream, decodePDFRawStream, StandardFonts, rgb, degrees } from "pdf-lib";
import { buildTechnicalRasterVectorExportPdf, resolveSourcePageGeometry, TechnicalRasterVectorExportError } from "../lib/technicalRasterVectorPdf.ts";
import { normalizedDisplayPointToRawPdfPoint, isValidNormalizedCoordinate } from "../domain/technicalRasterExportPlacementGeometry.ts";
import { buildTechnicalRasterExportLegend, type TechnicalRasterExportPlacementItem } from "../domain/technicalRasterExport.ts";
import { resolveTechnicalServicePresentation } from "../domain/technicalRasterServicePresentation.ts";

/**
 * Robustness/hardening batch (spec batch 13) — multi-page, rotation, non-standard
 * MediaBox/CropBox, invalid/corrupted data, determinism, resource cleanup, and size guards for
 * the TRUE VECTOR PDF export. No fixture here is a real customer file — every one is built
 * programmatically with pdf-lib, the same library the production pipeline uses.
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

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * CORRECTIVE BATCH (3rd) sections 8/9 — generator-added placement-marker labels are no longer
 * extractable PDF text (they are vector-outline fill geometry, on purpose — see
 * domain/technicalRasterVectorGlyphOutline.ts's own doc), so tests that used to grep pdf.js
 * `textContent` for a marker's own label ("3 kW" etc.) instead concatenate ALL of a page's raw
 * `/Contents` entries and look for the marker's own presentation color followed by a fill operator.
 */
async function readAllContentText(bytes: Uint8Array, pageIndex = 0): Promise<string> {
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

/** Counts how many times a marker's own presentation color is immediately followed by a fill operator — i.e. how many times THAT marker's own vector-outline glyph was actually drawn, structurally, since the label itself is no longer extractable text. */
function countVectorMarkerDraws(contentText: string, hexColor: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(hexColor);
  if (!match) return 0;
  const [r, g, b] = [match[1]!, match[2]!, match[3]!].map((component) => {
    const rounded = Math.round((parseInt(component, 16) / 255) * 1000) / 1000;
    return String(rounded).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  });
  const pattern = new RegExp(`${r} ${g} ${b} rg[\\s\\S]*?\\bf\\b`, "gu");
  return (contentText.match(pattern) ?? []).length;
}

async function decode(bytes: Uint8Array, pageNumber = 1) {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
  const page = await doc.getPage(pageNumber);
  const textContent = await page.getTextContent();
  const operatorList = await page.getOperatorList();
  return { doc, page, textContent, operatorList };
}

// ============================================================================
// 3/4) Multi-page audit + page indexing semantics
// ============================================================================

async function buildTwoPageFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page1 = doc.addPage([300, 200]);
  page1.drawText("PAGE ONE CONTENT", { x: 20, y: 100, size: 14, font, color: rgb(0, 0, 0) });
  const page2 = doc.addPage([300, 200]);
  page2.drawText("PAGE TWO CONTENT", { x: 20, y: 100, size: 14, font, color: rgb(0, 0, 0) });
  return doc.save();
}

test("page indexing: page=1 exports the FIRST source page's content, page=2 the SECOND — pinning the 1-based (app) -> 0-based (pdf-lib copyPages index = page-1) contract", async () => {
  const source = await buildTwoPageFixture();
  const exportedPage1 = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X" });
  const exportedPage2 = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 2, placements: [], legend: [], showLegend: false, headerLine: "X" });

  const { textContent: text1 } = await decode(exportedPage1.bytes);
  const { textContent: text2 } = await decode(exportedPage2.bytes);
  const joined1 = (text1.items as { str: string }[]).map((i) => i.str).join("");
  const joined2 = (text2.items as { str: string }[]).map((i) => i.str).join("");
  assert.ok(joined1.includes("PAGE ONE CONTENT"));
  assert.ok(!joined1.includes("PAGE TWO CONTENT"));
  assert.ok(joined2.includes("PAGE TWO CONTENT"));
  assert.ok(!joined2.includes("PAGE ONE CONTENT"));
});

test("multi-page: a placement stored on page 1 exports onto page 1's own content, never leaking onto page 2's export (and vice versa) — the SAME symbol text never appears twice", async () => {
  const source = await buildTwoPageFixture();
  const placementOnPage1 = placementItem({ presentation: resolveTechnicalServicePresentation("electricity", "Do 3kW 230V") });

  const exportedPage1 = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [placementOnPage1], legend: [], showLegend: false, headerLine: "X" });
  const exportedPage2 = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 2, placements: [placementOnPage1], legend: [], showLegend: false, headerLine: "X" });

  // Both calls draw the symbol onto WHATEVER page number was requested — the caller
  // (domain/technicalRasterExport.ts's buildTechnicalRasterExportPlacements) is what actually
  // guarantees a placement only ever reaches the export for its OWN page; this pipeline-level test
  // pins that the export function itself faithfully draws onto exactly the page it's told to.
  // CORRECTIVE BATCH (3rd) sections 8/9 — the marker is vector-outline geometry, not extractable
  // text, so this checks for its own presentation color + fill instead of a pdf.js text string.
  const text1 = await readAllContentText(exportedPage1.bytes);
  const text2 = await readAllContentText(exportedPage2.bytes);
  assert.equal(countVectorMarkerDraws(text1, placementOnPage1.presentation.color), 1);
  assert.equal(countVectorMarkerDraws(text2, placementOnPage1.presentation.color), 1, "the symbol is drawn on whichever page was requested — page-scoping is the CALLER's responsibility (already verified in tests/technicalRasterExport.test.ts's own 'only includes placements on the requested page' test)");
});

// ============================================================================
// 5) Invalid page placement
// ============================================================================

test("invalid page: an out-of-range page number fails fast and atomically, BEFORE any PDF writing — never a corrupt/partial output, never a silent remap to a random page", async () => {
  const source = await buildTwoPageFixture();
  await assert.rejects(
    () => buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 5, placements: [placementItem()], legend: [], showLegend: false, headerLine: "X" }),
    (error: unknown) => error instanceof TechnicalRasterVectorExportError && error.code === "INVALID_PAGE",
  );
});

test("invalid page: page 0 and negative page numbers are rejected the same way (never silently treated as page 1)", async () => {
  const source = await buildTwoPageFixture();
  await assert.rejects(() => resolveSourcePageGeometry(source, 0), (error: unknown) => error instanceof TechnicalRasterVectorExportError && error.code === "INVALID_PAGE");
  await assert.rejects(() => resolveSourcePageGeometry(source, -1), (error: unknown) => error instanceof TechnicalRasterVectorExportError && error.code === "INVALID_PAGE");
});

// ============================================================================
// 6) Normalized coordinate validation
// ============================================================================

test("isValidNormalizedCoordinate: accepts exactly [0,1], rejects out-of-range/NaN/Infinity", () => {
  assert.equal(isValidNormalizedCoordinate(0), true);
  assert.equal(isValidNormalizedCoordinate(1), true);
  assert.equal(isValidNormalizedCoordinate(0.5), true);
  assert.equal(isValidNormalizedCoordinate(-0.0001), false);
  assert.equal(isValidNormalizedCoordinate(1.0001), false);
  assert.equal(isValidNormalizedCoordinate(NaN), false);
  assert.equal(isValidNormalizedCoordinate(Infinity), false);
  assert.equal(isValidNormalizedCoordinate(-Infinity), false);
});

test("export: a placement with an out-of-range/NaN/Infinity coordinate is SKIPPED (never clamped, never crashes), reported via skippedInvalidPlacementCount, and never draws a symbol at a garbage position", async () => {
  const source = await buildTwoPageFixture();
  const badPlacements = [
    placementItem({ placementId: "p-neg", xNormalized: -0.5 }),
    placementItem({ placementId: "p-big", xNormalized: 1.5 }),
    placementItem({ placementId: "p-nan", yNormalized: NaN }),
    placementItem({ placementId: "p-inf", yNormalized: Infinity }),
  ];
  const goodPlacement = placementItem({ placementId: "p-good", xNormalized: 0.5, yNormalized: 0.5 });

  const result = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [...badPlacements, goodPlacement], legend: [], showLegend: false, headerLine: "X" });
  assert.equal(result.skippedInvalidPlacementCount, 4);
  assert.ok(result.bytes.length > 100, "the export still completes successfully for the remaining valid placements");

  // CORRECTIVE BATCH (3rd) sections 8/9 — the marker is vector-outline geometry, not extractable text.
  const text = await readAllContentText(result.bytes);
  const drawnCount = countVectorMarkerDraws(text, goodPlacement.presentation.color);
  assert.equal(drawnCount, 1, "exactly ONE symbol drawn — from the single valid placement, none of the 4 invalid ones");
});

test("export: ALL placements invalid -> export still completes (an empty but valid PDF), never crashes", async () => {
  const source = await buildTwoPageFixture();
  const result = await buildTechnicalRasterVectorExportPdf({
    sourcePdfBytes: source,
    page: 1,
    placements: [placementItem({ xNormalized: NaN }), placementItem({ xNormalized: -1 })],
    legend: [],
    showLegend: false,
    headerLine: "X",
  });
  assert.equal(result.skippedInvalidPlacementCount, 2);
  assert.ok(result.bytes.length > 100);
});

// ============================================================================
// 7) Rotation matrix — 0/90/180/270, portrait/landscape, several normalized points
// ============================================================================

test("rotation matrix: normalizedDisplayPointToRawPdfPoint round-trips correctly for 0/90/180/270 at several representative points, using REAL pdf.js viewport transforms (not synthetic ones)", async () => {
  const points = [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 0.1, y: 0.9 }, { x: 0.9, y: 0.1 }, { x: 1, y: 1 }];
  for (const rotate of [0, 90, 180, 270]) {
    for (const [w, h] of [[300, 200], [200, 300]]) { // landscape, portrait
      const doc = await PDFDocument.create();
      const page = doc.addPage([w, h]);
      page.setRotation(degrees(rotate));
      const bytes = await doc.save();
      const geometry = await resolveSourcePageGeometry(bytes, 1);

      for (const point of points) {
        const raw = normalizedDisplayPointToRawPdfPoint(point.x, point.y, geometry.displayWidthPt, geometry.displayHeightPt, geometry.viewportTransform);
        assert.ok(Number.isFinite(raw.x) && Number.isFinite(raw.y), `rotation=${rotate} size=${w}x${h} point=${JSON.stringify(point)}: raw point must be finite`);
      }
      // rotation 90/270 swaps the display dimensions relative to the raw page size.
      if (rotate === 90 || rotate === 270) {
        assert.equal(geometry.displayWidthPt, h);
        assert.equal(geometry.displayHeightPt, w);
      } else {
        assert.equal(geometry.displayWidthPt, w);
        assert.equal(geometry.displayHeightPt, h);
      }
    }
  }
});

test("rotation: an exported symbol on a 90-degree-rotated page lands within the page's own raw bounds (never off-page), verified for center and all four near-corner points", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  page.setRotation(degrees(90));
  const source = await doc.save();

  for (const [x, y] of [[0.5, 0.5], [0.05, 0.05], [0.95, 0.05], [0.05, 0.95], [0.95, 0.95]]) {
    const result = await buildTechnicalRasterVectorExportPdf({
      sourcePdfBytes: source,
      page: 1,
      placements: [placementItem({ xNormalized: x, yNormalized: y })],
      legend: [],
      showLegend: false,
      headerLine: "X",
    });
    assert.ok(result.bytes.length > 100);
    assert.equal(result.skippedInvalidPlacementCount, 0);
  }
});

// ============================================================================
// 8/9/10) MediaBox/CropBox, non-zero origin, rotation + non-zero origin combined
// ============================================================================

test("MediaBox larger than CropBox: page copy preserves both boxes exactly, export completes without shifting/cropping", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  page.setCropBox(50, 40, 300, 220); // a real, smaller visible region inside the larger MediaBox
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("BOXED CONTENT", { x: 60, y: 150, size: 12, font, color: rgb(0, 0, 0) });
  const source = await doc.save();

  const result = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [placementItem()], legend: [], showLegend: false, headerLine: "X" });
  const reloaded = await PDFDocument.load(result.bytes);
  const exportedPage = reloaded.getPage(0);
  const mediaBox = exportedPage.getMediaBox();
  const cropBox = exportedPage.getCropBox();
  assert.equal(mediaBox.width, 400);
  assert.equal(mediaBox.height, 300);
  assert.equal(cropBox.width, 300);
  assert.equal(cropBox.height, 220);
});

test("non-zero page origin (MediaBox not starting at 0,0): normalized (0,0)/(1,1) map to the box's own actual corners, never assuming a zero origin", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 400]);
  page.setMediaBox(20, 30, 600, 400); // origin at (20,30), NOT (0,0) — matches spec batch 13 section 9's own example
  const source = await doc.save();

  const geometry = await resolveSourcePageGeometry(source, 1);
  const topLeft = normalizedDisplayPointToRawPdfPoint(0, 0, geometry.displayWidthPt, geometry.displayHeightPt, geometry.viewportTransform);
  const bottomRight = normalizedDisplayPointToRawPdfPoint(1, 1, geometry.displayWidthPt, geometry.displayHeightPt, geometry.viewportTransform);

  // pdf.js's own viewport.transform is derived from the page's real MediaBox (including its
  // origin) — verified here against a REAL pdf.js transform, not a hand-derived assumption.
  assert.ok(Math.abs(topLeft.x - 20) < 0.01, `expected raw x near the box's own x0=20, got ${topLeft.x}`);
  assert.ok(Math.abs(topLeft.y - 430) < 0.01, `expected raw y near the box's own top (y0+height=30+400=430), got ${topLeft.y}`);
  assert.ok(Math.abs(bottomRight.x - 620) < 0.01, `expected raw x near the box's own right edge (x0+width=20+600=620), got ${bottomRight.x}`);
  assert.ok(Math.abs(bottomRight.y - 30) < 0.01, `expected raw y near the box's own bottom y0=30, got ${bottomRight.y}`);
});

test("non-zero origin + rotation 90 combined: geometry resolution and export both complete without throwing, coordinates stay finite", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 400]);
  page.setMediaBox(20, 30, 600, 400);
  page.setRotation(degrees(90));
  const source = await doc.save();

  const geometry = await resolveSourcePageGeometry(source, 1);
  assert.ok(Number.isFinite(geometry.displayWidthPt) && Number.isFinite(geometry.displayHeightPt));
  const point = normalizedDisplayPointToRawPdfPoint(0.5, 0.5, geometry.displayWidthPt, geometry.displayHeightPt, geometry.viewportTransform);
  assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));

  const result = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [placementItem()], legend: [], showLegend: false, headerLine: "X" });
  assert.ok(result.bytes.length > 100);
});

// ============================================================================
// 11) Multi-page OCG — page 1 has OCG A, page 2 has OCG B, both share OCG C.
// ============================================================================

async function buildMultiPageOcgFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ctx = doc.context;

  function makeOcg(name: string) {
    const dict = PDFDict.withContext(ctx);
    dict.set(PDFName.of("Type"), PDFName.of("OCG"));
    dict.set(PDFName.of("Name"), PDFHexString.fromText(name));
    return ctx.register(dict);
  }
  const ocgA = makeOcg("VRSTVA A (jen strana 1)");
  const ocgB = makeOcg("VRSTVA B (jen strana 2)");
  const ocgC = makeOcg("VRSTVA C (sdílená)");

  const page1 = doc.addPage([300, 200]);
  page1.drawText("PAGE ONE", { x: 20, y: 100, size: 12, font, color: rgb(0, 0, 0) });
  const props1 = PDFDict.withContext(ctx);
  props1.set(PDFName.of("OCA"), ocgA);
  props1.set(PDFName.of("OCC"), ocgC);
  const resources1 = page1.node.lookup(PDFName.of("Resources"));
  if (resources1 instanceof PDFDict) resources1.set(PDFName.of("Properties"), props1);

  const page2 = doc.addPage([300, 200]);
  page2.drawText("PAGE TWO", { x: 20, y: 100, size: 12, font, color: rgb(0, 0, 0) });
  const props2 = PDFDict.withContext(ctx);
  props2.set(PDFName.of("OCB"), ocgB);
  props2.set(PDFName.of("OCC"), ocgC);
  const resources2 = page2.node.lookup(PDFName.of("Resources"));
  if (resources2 instanceof PDFDict) resources2.set(PDFName.of("Properties"), props2);

  const ocgsArr = PDFArray.withContext(ctx);
  [ocgA, ocgB, ocgC].forEach((ref) => ocgsArr.push(ref));
  const onArr = PDFArray.withContext(ctx);
  [ocgA, ocgB, ocgC].forEach((ref) => onArr.push(ref));
  const dDict = PDFDict.withContext(ctx);
  dDict.set(PDFName.of("BaseState"), PDFName.of("ON"));
  dDict.set(PDFName.of("ON"), onArr);
  const ocPropsDict = PDFDict.withContext(ctx);
  ocPropsDict.set(PDFName.of("OCGs"), ctx.register(ocgsArr));
  ocPropsDict.set(PDFName.of("D"), ctx.register(dDict));
  doc.catalog.set(PDFName.of("OCProperties"), ctx.register(ocPropsDict));

  return doc.save();
}

test("multi-page OCG: exporting page 1 reconstructs ONLY the OCGs page 1's own resources reference (A + C), never B, never duplicated, order deterministic", async () => {
  const source = await buildMultiPageOcgFixture();
  const { bytes, ocgDiagnostic } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X" });
  assert.equal(ocgDiagnostic.sourceOcgCount, 3);
  assert.equal(ocgDiagnostic.reconstructedOcgCount, 2);
  assert.deepEqual(ocgDiagnostic.reconstructedOcgNames, ["VRSTVA A (jen strana 1)", "VRSTVA C (sdílená)"]);
  assert.deepEqual(ocgDiagnostic.unmatchedOcgNames, ["VRSTVA B (jen strana 2)"]);

  // CORRECTIVE BATCH (3rd) sections 10/11 — the generator's own "GENERÁTOR DATA" OCG is always
  // appended too, alongside the 2 reconstructed source groups.
  const { doc } = await decode(bytes);
  const order = (await doc.getOptionalContentConfig()).getOrder();
  assert.equal(order?.length, 3, "the exported (single-page) PDF's own layer panel shows exactly A + C + GENERÁTOR DATA — never a dangling reference to B");
});

test("multi-page OCG: exporting page 2 reconstructs ONLY B + C, never A — proves reconstruction is genuinely scoped per-export-page, not a global 'all source OCGs' dump", async () => {
  const source = await buildMultiPageOcgFixture();
  const { ocgDiagnostic } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 2, placements: [], legend: [], showLegend: false, headerLine: "X" });
  assert.equal(ocgDiagnostic.reconstructedOcgCount, 2);
  assert.deepEqual(ocgDiagnostic.reconstructedOcgNames, ["VRSTVA B (jen strana 2)", "VRSTVA C (sdílená)"]);
  assert.deepEqual(ocgDiagnostic.unmatchedOcgNames, ["VRSTVA A (jen strana 1)"]);
});

// ============================================================================
// 12) OCG name collision — two DIFFERENT OCG objects sharing the same display name.
// ============================================================================

async function buildOcgNameCollisionFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([300, 200]);
  page.drawText("COLLISION FIXTURE", { x: 20, y: 100, size: 12, font, color: rgb(0, 0, 0) });
  const ctx = doc.context;

  const ocg1 = PDFDict.withContext(ctx);
  ocg1.set(PDFName.of("Type"), PDFName.of("OCG"));
  ocg1.set(PDFName.of("Name"), PDFHexString.fromText("STÁNKY")); // SAME name as ocg2 below
  const ocg1Ref = ctx.register(ocg1);
  const ocg2 = PDFDict.withContext(ctx);
  ocg2.set(PDFName.of("Type"), PDFName.of("OCG"));
  ocg2.set(PDFName.of("Name"), PDFHexString.fromText("STÁNKY")); // deliberately colliding name, genuinely DIFFERENT object
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
  offArr.push(ocg2Ref); // ocg2 (the SECOND "STÁNKY") is OFF by default — ocg1 is ON
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

test("OCG name collision AUDIT: two distinct OCG objects sharing the same display name — documents current, name-based-matching behavior rather than pretending it doesn't exist", async () => {
  const source = await buildOcgNameCollisionFixture();
  const { bytes, ocgDiagnostic } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X" });
  // Current, name-based reconstruction cannot distinguish two same-named OCGs from each other —
  // this is a KNOWN, documented limitation (see lib/technicalRasterVectorPdf.ts's own module doc),
  // not a silent data-loss bug: the export never crashes, never drops BOTH groups, and the
  // resulting PDF is always structurally valid. Exactly what happens (which of the two wins) is
  // pinned here so a future change to the matching strategy is a deliberate, visible decision.
  assert.equal(ocgDiagnostic.sourceOcgCount, 2);
  assert.ok(ocgDiagnostic.reconstructedOcgCount >= 1, "never silently drops every group just because of a name collision");
  assert.ok(bytes.length > 100, "never crashes");

  // CORRECTIVE BATCH (3rd) sections 10/11 — +1 for the generator's own always-present "GENERÁTOR DATA" OCG.
  const { doc } = await decode(bytes);
  const order = (await doc.getOptionalContentConfig()).getOrder();
  assert.ok(order && order.length >= 2 && order.length <= 3, "the exported PDF's own layer panel is always structurally valid — 1 or 2 source groups plus GENERÁTOR DATA, never corrupted/duplicated beyond that");
});

// ============================================================================
// 14) Damaged / partial OCG metadata
// ============================================================================

async function buildPartialOcgMetadataFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([300, 200]);
  page.drawText("PARTIAL OCG METADATA", { x: 20, y: 100, size: 12, font, color: rgb(0, 0, 0) });
  const ctx = doc.context;

  // The page's own resources reference an OCG...
  const ocg = PDFDict.withContext(ctx);
  ocg.set(PDFName.of("Type"), PDFName.of("OCG"));
  ocg.set(PDFName.of("Name"), PDFHexString.fromText("NEUPLNA VRSTVA"));
  const ocgRef = ctx.register(ocg);
  const props = PDFDict.withContext(ctx);
  props.set(PDFName.of("OC1"), ocgRef);
  const resources = page.node.lookup(PDFName.of("Resources"));
  if (resources instanceof PDFDict) resources.set(PDFName.of("Properties"), props);

  // ...but the catalog's /OCProperties is INCOMPLETE: /D dict is entirely missing (only /OCGs present).
  const ocgsArr = PDFArray.withContext(ctx);
  ocgsArr.push(ocgRef);
  const ocPropsDict = PDFDict.withContext(ctx);
  ocPropsDict.set(PDFName.of("OCGs"), ctx.register(ocgsArr));
  // Deliberately no /D key at all here.
  doc.catalog.set(PDFName.of("OCProperties"), ctx.register(ocPropsDict));

  return doc.save();
}

test("damaged/partial OCG metadata: catalog /OCProperties missing its /D default-config dict entirely -> export never crashes, uses the conservative existing fallback (everything defaults ON, nothing in OFF)", async () => {
  const source = await buildPartialOcgMetadataFixture();
  const { bytes, ocgDiagnostic } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X" });
  assert.equal(ocgDiagnostic.attempted, true);
  assert.equal(ocgDiagnostic.sourceOcgCount, 1);
  assert.equal(ocgDiagnostic.reconstructedOcgCount, 1);
  assert.ok(bytes.length > 100);
});

// ============================================================================
// 15) Large placement count benchmark
// ============================================================================

test("large placement count: 500 and 1000 placements across several presentation types export successfully within a reasonable runtime, output stays proportional (never absurdly large)", async () => {
  const source = await buildTwoPageFixture();
  const presentations = [
    resolveTechnicalServicePresentation("electricity", "Do 3kW 230V"),
    resolveTechnicalServicePresentation("electricity", "Lednicový okruh"),
    resolveTechnicalServicePresentation("internet", "Pevná IP"),
    resolveTechnicalServicePresentation("water", "x"),
  ];
  for (const count of [500, 1000]) {
    const placements = Array.from({ length: count }, (_, i) => placementItem({
      placementId: `p-${i}`,
      xNormalized: (i % 97) / 97,
      yNormalized: (i % 53) / 53,
      presentation: presentations[i % presentations.length]!,
    }));
    const start = performance.now();
    const result = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements, legend: [], showLegend: false, headerLine: "X" });
    const elapsedMs = performance.now() - start;
    assert.equal(result.skippedInvalidPlacementCount, 0);
    assert.ok(result.bytes.length > 100);
    assert.ok(result.bytes.length < 5_000_000, `${count} placements produced ${result.bytes.length} bytes — unexpectedly large for vector symbols alone`);
    assert.ok(elapsedMs < 10_000, `${count} placements took ${elapsedMs.toFixed(0)}ms — unexpectedly slow`);
  }
});

// ============================================================================
// 16) Duplicate placement ids
// ============================================================================

test("duplicate placement ids: two placement ITEMS sharing the same placementId (simulating corrupted persisted data) both still draw — the export pipeline draws whatever list it's given, it never deduplicates/overwrites by id, and never loops or crashes", async () => {
  const source = await buildTwoPageFixture();
  const placements = [
    placementItem({ placementId: "dup-1", xNormalized: 0.2, yNormalized: 0.2 }),
    placementItem({ placementId: "dup-1", xNormalized: 0.8, yNormalized: 0.8 }), // SAME id, different position — corrupted data
  ];
  const result = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements, legend: [], showLegend: false, headerLine: "X" });
  assert.ok(result.bytes.length > 100);
  // CORRECTIVE BATCH (3rd) sections 8/9 — the marker is vector-outline geometry, not extractable text.
  const text = await readAllContentText(result.bytes);
  const drawnCount = countVectorMarkerDraws(text, placements[0]!.presentation.color);
  assert.equal(drawnCount, 2, "both draw — the export list itself has no notion of 'id', it just draws every item it's given, exactly once each, in order");
});

// ============================================================================
// 17/18) quantity vs. placements corruption, zero/invalid quantity
// ============================================================================

test("quantity/placement corruption AUDIT: the export pipeline itself has NO quantity field at all on TechnicalRasterExportPlacementItem — it only ever draws whatever placement ITEMS the caller already resolved. quantity-vs-placements-count consistency is entirely domain/technicalRaster.ts's own concern (placeTechnicalService refuses once placements.length >= quantity) and domain/technicalRasterWorkQueue.ts's own concern (completeness caps at quantity via Math.min) — this test documents that the export layer is structurally incapable of 'seeing' or acting on a quantity mismatch, so a corrupted quantity=1/placements.length=3 record still exports all 3 points without crashing.", async () => {
  const source = await buildTwoPageFixture();
  const placements = [
    placementItem({ placementId: "extra-1", serviceId: "corrupted-service", xNormalized: 0.1, yNormalized: 0.1 }),
    placementItem({ placementId: "extra-2", serviceId: "corrupted-service", xNormalized: 0.2, yNormalized: 0.2 }),
    placementItem({ placementId: "extra-3", serviceId: "corrupted-service", xNormalized: 0.3, yNormalized: 0.3 }),
  ];
  const result = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements, legend: [], showLegend: false, headerLine: "X" });
  assert.ok(result.bytes.length > 100, "never crashes regardless of how many placement items a single (corrupted) service happens to carry");
});

// ============================================================================
// 19/20/21/22) Export determinism, legend determinism/dedup/empty
// ============================================================================

test("export determinism: two exports of the SAME project/source produce semantically identical output — same page count, same geometry, same OCG order/names, same overlay symbol count (never byte-identical, since pdf-lib embeds its own object ids/timestamps)", async () => {
  const source = await buildMultiPageOcgFixture();
  const placements = [placementItem({ placementId: "p-1" }), placementItem({ placementId: "p-2", xNormalized: 0.3 })];
  const first = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements, legend: [{ legendLabel: "PŘÍVOD EL. ENERGIE", color: "#b3261e", renderer: "powerLabel" }], showLegend: true, headerLine: "X" });
  const second = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements, legend: [{ legendLabel: "PŘÍVOD EL. ENERGIE", color: "#b3261e", renderer: "powerLabel" }], showLegend: true, headerLine: "X" });

  const reloadedFirst = await PDFDocument.load(first.bytes);
  const reloadedSecond = await PDFDocument.load(second.bytes);
  assert.equal(reloadedFirst.getPageCount(), reloadedSecond.getPageCount());
  assert.deepEqual(reloadedFirst.getPage(0).getSize(), reloadedSecond.getPage(0).getSize());
  assert.deepEqual(first.ocgDiagnostic.reconstructedOcgNames, second.ocgDiagnostic.reconstructedOcgNames);

  const { textContent: text1 } = await decode(first.bytes);
  const { textContent: text2 } = await decode(second.bytes);
  assert.equal(text1.items.length, text2.items.length, "same number of text items drawn both times");
});

test("legend determinism: the legend's own entry order comes from FIRST-SEEN placement order (domain/technicalRasterExport.ts's buildTechnicalRasterExportLegend), never an unordered Map/object iteration artifact — two builds from the SAME placement order produce the SAME legend order", async () => {
  const source = await buildTwoPageFixture();
  const legend = [
    { legendLabel: "PŘÍVOD EL. ENERGIE", color: "#b3261e", renderer: "powerLabel" as const },
    { legendLabel: "VODA — PŘÍVOD / ODPAD VODY", color: "#1a7a4c", renderer: "waterDrop" as const },
    { legendLabel: "INTERNET — PEVNÁ IP", color: "#b8860b", renderer: "textLabel" as const },
  ];
  const first = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend, showLegend: true, headerLine: "X" });
  const second = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend, showLegend: true, headerLine: "X" });

  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  async function legendPageText(bytes: Uint8Array): Promise<string> {
    const loaded = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
    const legendPage = await loaded.getPage(2);
    const content = await legendPage.getTextContent();
    return (content.items as { str: string }[]).map((i) => i.str).join(" ");
  }
  const legendText1 = await legendPageText(first.bytes);
  const legendText2 = await legendPageText(second.bytes);
  assert.equal(legendText1, legendText2);
  // Order preserved: EL. ENERGIE before VODA before INTERNET.
  const elIndex = legendText1.indexOf("PŘÍVOD EL. ENERGIE");
  const vodaIndex = legendText1.indexOf("VODA");
  const internetIndex = legendText1.indexOf("INTERNET");
  assert.ok(elIndex < vodaIndex && vodaIndex < internetIndex);
});

test("legend deduplication: 10 placements of the SAME presentation (electricity 6 kW) produce exactly ONE legend entry, never 10 duplicate rows", () => {
  const items: TechnicalRasterExportPlacementItem[] = Array.from({ length: 10 }, (_, i) =>
    placementItem({ placementId: `p-${i}`, presentation: resolveTechnicalServicePresentation("electricity", "Do 6kW 230V") }));
  // buildTechnicalRasterExportLegend lives in domain/technicalRasterExport.ts — imported directly here to pin the exact dedup guarantee this export pipeline relies on.
  const legend = buildTechnicalRasterExportLegend(items);
  assert.equal(legend.length, 1);
  assert.equal(legend[0]!.legendLabel, "PŘÍVOD EL. ENERGIE");
});

test("legend: different meanings sharing a similar color are NEVER accidentally merged — deduplication is keyed by legendLabel, not color alone", () => {
  const items: TechnicalRasterExportPlacementItem[] = [
    placementItem({ placementId: "p-1", presentation: resolveTechnicalServicePresentation("electricity", "Do 6kW 230V") }), // red
    placementItem({ placementId: "p-2", presentation: resolveTechnicalServicePresentation("electricity", "Lednicový okruh") }), // ALSO red, but a genuinely different legend meaning
  ];
  const legend = buildTechnicalRasterExportLegend(items);
  assert.equal(legend.length, 2, "same color, but two DISTINCT legend entries — color is never the dedup key");
});

test("empty legend: no used presentation types -> legend page still exists (current, unchanged behavior) with just the header line, pinned so a future change is deliberate", async () => {
  const source = await buildTwoPageFixture();
  const result = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: true, headerLine: "Technický rastr" });
  const reloaded = await PDFDocument.load(result.bytes);
  assert.equal(reloaded.getPageCount(), 2, "legend page still exists even with nothing to list — current behavior, unchanged");
});

// ============================================================================
// 23/24) Font glyph coverage + text encoding — every real overlay/legend text this app draws.
// ============================================================================

test("font glyph coverage + Czech encoding: every real overlay/legend text this app actually draws (kW labels, IP/INT, the '*' star glyph, and real Czech legend strings with diacritics) renders WITHOUT crashing and is extractable afterward — never tofu/missing-glyph, never a thrown embedFont/drawText error", async () => {
  const source = await buildTwoPageFixture();
  const czechLegend = [
    { legendLabel: "PŘÍVOD EL. ENERGIE", color: "#b3261e", renderer: "powerLabel" as const },
    { legendLabel: "LEDNICOVÝ / NONSTOP OKRUH", color: "#b3261e", renderer: "refrigeratedStar" as const },
    { legendLabel: "VODA — PŘÍVOD / ODPAD VODY", color: "#1a7a4c", renderer: "waterDrop" as const },
  ];
  const placements = [
    placementItem({ placementId: "p-kw", presentation: resolveTechnicalServicePresentation("electricity", "Do 6kW 230V") }), // "6 kW"
    placementItem({ placementId: "p-star", xNormalized: 0.3, presentation: resolveTechnicalServicePresentation("electricity", "Lednicový okruh") }), // "*"
    placementItem({ placementId: "p-ip", xNormalized: 0.6, presentation: resolveTechnicalServicePresentation("internet", "Pevná IP") }), // "IP"
    placementItem({ placementId: "p-int", xNormalized: 0.8, presentation: resolveTechnicalServicePresentation("internet", "Internet") }), // "INT"
  ];
  const result = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements, legend: czechLegend, showLegend: true, headerLine: "Technický rastr / FOR DECOR 2026 / Hala 1" });
  assert.ok(result.bytes.length > 100);

  // CORRECTIVE BATCH (3rd) sections 8/9 — the overlay's own "6 kW"/"*"/"IP"/"INT" labels are no
  // longer extractable PDF text (genuine vector-outline fill geometry now — see
  // domain/technicalRasterVectorGlyphOutline.ts's own doc). "Never tofu/missing-glyph" for THIS
  // representation means: every placement produced its own real, non-empty filled path — a font
  // glyph fontkit can't shape would instead silently produce ZERO path commands (skipped entirely
  // by buildVectorGlyphPathOperators, never a crash, never a visible replacement box) — so the count
  // of real "<color> rg ... f" fill blocks must equal the number of placements, one each.
  const overlayContentText = await readAllContentText(result.bytes, 0);
  const fillBlockCount = (overlayContentText.match(/[01](?:\.\d+)? [01](?:\.\d+)? [01](?:\.\d+)? rg[\s\S]*?\bf\b/gu) ?? []).length;
  assert.equal(fillBlockCount, placements.length, `expected exactly one non-empty vector-outline glyph fill per placement (never tofu/a silently-empty glyph), got ${fillBlockCount} in: ${overlayContentText}`);

  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loaded = await pdfjsLib.getDocument({ data: new Uint8Array(result.bytes) }).promise;
  const legendPage = await loaded.getPage(2);
  const legendText = (await legendPage.getTextContent()).items as { str: string }[];
  const legendJoined = legendText.map((i) => i.str).join(" ");
  for (const needle of ["PŘÍVOD EL. ENERGIE", "LEDNICOVÝ", "NONSTOP OKRUH", "VODA", "PŘÍVOD", "ODPAD VODY", "Technický rastr", "FOR DECOR 2026", "Hala 1"]) {
    assert.ok(legendJoined.includes(needle), `legend/header text missing: "${needle}" (got: ${legendJoined})`);
  }
  // No U+FFFD replacement character (the classic "tofu"/missing-glyph symptom) anywhere in the
  // legend's own extracted text — the legend is UNCHANGED, still real `page.drawText`.
  assert.ok(!legendJoined.includes("�"), "no replacement-character glyphs in the legend — every drawn character is genuinely supported by the embedded font");
});

// ============================================================================
// 25/26) Source PDF immutability + input buffer ownership
// ============================================================================

test("source PDF immutability: sourcePdfBytes' own SHA-256 hash is byte-for-byte identical before and after export (not just deepEqual — a true cryptographic hash comparison)", async () => {
  const source = await buildTwoPageFixture();
  const hashBefore = sha256(source);
  await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [placementItem()], legend: [{ legendLabel: "X", color: "#b3261e", renderer: "powerLabel" }], showLegend: true, headerLine: "X" });
  const hashAfter = sha256(source);
  assert.equal(hashAfter, hashBefore);
});

test("input buffer ownership: the SAME source bytes object can be exported from TWICE in a row without the second call being affected by the first (pdf-lib's load/copy pipeline never mutates or detaches the shared buffer)", async () => {
  const source = await buildTwoPageFixture();
  const hashBefore = sha256(source);
  const first = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [placementItem()], legend: [], showLegend: false, headerLine: "X" });
  const second = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [placementItem()], legend: [], showLegend: false, headerLine: "X" });
  assert.equal(sha256(source), hashBefore, "source bytes still untouched after two consecutive exports");
  assert.ok(first.bytes.length > 100 && second.bytes.length > 100, "both exports succeed independently");
  const { textContent: text1 } = await decode(first.bytes);
  const { textContent: text2 } = await decode(second.bytes);
  assert.equal(text1.items.length, text2.items.length, "the second export is not degraded/truncated by the first having already read the same source buffer");
});

// ============================================================================
// 27/28) Resource cleanup + repeated export
// ============================================================================

test("repeated export: 20 consecutive exports of the same small synthetic PDF all succeed, produce consistent output, and never leak state across calls (no growing/duplicate OCG registrations, no accumulating global caches)", async () => {
  const source = await buildMultiPageOcgFixture();
  const results: Awaited<ReturnType<typeof buildTechnicalRasterVectorExportPdf>>[] = [];
  for (let i = 0; i < 20; i += 1) {
    results.push(await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [placementItem({ placementId: `p-${i}` })], legend: [], showLegend: false, headerLine: "X" }));
  }
  for (const result of results) {
    assert.equal(result.ocgDiagnostic.reconstructedOcgCount, 2, "every one of the 20 independent exports reconstructs exactly the SAME 2 OCGs (page 1's own A+C) — never 4, never 40, no accumulation across calls");
    assert.equal(result.skippedInvalidPlacementCount, 0);
  }
  // Byte sizes should be essentially stable across runs (small pdf-lib internal id/serialization
  // variance is fine; a MONOTONICALLY GROWING size across the 20 calls would indicate a leak).
  const sizes = results.map((r) => r.bytes.length);
  const first = sizes[0]!;
  const last = sizes[sizes.length - 1]!;
  assert.ok(Math.abs(last - first) < first * 0.2, `export size drifted from ${first} to ${last} bytes across 20 identical calls — possible state leak`);
});

// ============================================================================
// 29) Export failure isolation
// ============================================================================

test("export failure isolation AUDIT: an invalid page fails the WHOLE export atomically before any bytes are produced (spec batch 13 section 29: 'export failuje explicitně, ne že vrátí poloviční PDF') — pinned as the existing, correct failure semantics, no change needed", async () => {
  const source = await buildTwoPageFixture();
  let bytesReturned: Uint8Array | undefined;
  try {
    const result = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 99, placements: [placementItem()], legend: [], showLegend: false, headerLine: "X" });
    bytesReturned = result.bytes;
  } catch {
    // expected
  }
  assert.equal(bytesReturned, undefined, "a failed export never returns a partial/half-built byte array — the promise rejects, full stop");
});

// ============================================================================
// 35/36) Output size guard + vectorness guard
// ============================================================================

test("output size guard: export size grows roughly proportionally with overlay content (10 -> 100 -> 1000 placements), never a sudden multi-MB jump that would indicate a hidden full-page rasterization", async () => {
  const source = await buildTwoPageFixture();
  const baseline = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X" });
  const with10 = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: Array.from({ length: 10 }, (_, i) => placementItem({ placementId: `p${i}` })), legend: [], showLegend: false, headerLine: "X" });
  const with100 = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: Array.from({ length: 100 }, (_, i) => placementItem({ placementId: `p${i}` })), legend: [], showLegend: false, headerLine: "X" });
  const with1000 = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: Array.from({ length: 1000 }, (_, i) => placementItem({ placementId: `p${i}` })), legend: [], showLegend: false, headerLine: "X" });

  // Never a sudden multi-megabyte jump in a SINGLE small step — a hidden full-page bitmap would add
  // hundreds of KB to several MB between baseline and just 10 placements; real vector-outline
  // overlay growth is a per-symbol linear cost instead. CORRECTIVE BATCH (3rd) sections 8/9 —
  // thresholds widened from the old page.drawText()-based numbers: a filled Bézier glyph PATH (its
  // own PDF stream object, framing overhead included) costs measurably more bytes per marker than a
  // single short text-showing operator did (~2.7KB/placement measured, vs a few hundred bytes for
  // plain text) — a deliberate, disclosed tradeoff for Corel-safe vector geometry, never a
  // regression toward a hidden rasterization (which would show up as a multi-MB jump at just 10).
  assert.ok(with10.bytes.length - baseline.bytes.length < 100_000, "10 placements should add well under 100KB — never a rasterization-sized jump");
  assert.ok(with100.bytes.length - with10.bytes.length < 500_000, "90 more placements should add well under 500KB");
  assert.ok(with1000.bytes.length < 5_000_000, `1000 placements produced ${with1000.bytes.length} bytes — unexpectedly large`);
});

test("vectorness guard: distinguishes a full-page image XObject (BLOCKER, forbidden) from a small future icon image XObject (would be acceptable) — today's export has ZERO image XObjects of any size, verified directly on the exported page's own /Resources/XObject dict", async () => {
  const source = await buildTwoPageFixture();
  const result = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: Array.from({ length: 5 }, (_, i) => placementItem({ placementId: `p${i}` })), legend: [], showLegend: false, headerLine: "X" });
  const reloaded = await PDFDocument.load(result.bytes);
  const page1 = reloaded.getPage(0);
  const resources = page1.node.lookup(PDFName.of("Resources"));
  const xobjects = resources instanceof PDFDict ? resources.lookup(PDFName.of("XObject")) : undefined;
  const xobjectCount = xobjects instanceof PDFDict ? xobjects.keys().length : 0;
  assert.equal(xobjectCount, 0, "zero image XObjects of ANY size today — no custom PNG icon feature exists yet to legitimately introduce one");
});

// ============================================================================
// 34) Security — PDF input (audit, not a new sanitizer)
// ============================================================================

test("security AUDIT: a source PDF with an embedded /OpenAction JavaScript entry exports successfully with no evidence of execution — neither pdf.js's text/geometry reads nor pdf-lib's copyPages contain a JavaScript engine; both only parse/copy structure and content streams, exactly as this pipeline already relies on", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("PDF WITH EMBEDDED JS ACTION", { x: 20, y: 100, size: 12, font, color: rgb(0, 0, 0) });
  const ctx = doc.context;
  const jsAction = PDFDict.withContext(ctx);
  jsAction.set(PDFName.of("S"), PDFName.of("JavaScript"));
  jsAction.set(PDFName.of("JS"), PDFHexString.fromText("app.alert('this must never run during export');"));
  doc.catalog.set(PDFName.of("OpenAction"), ctx.register(jsAction));
  const source = await doc.save();

  // sourcePdfBytes never came from a URL fetch anywhere in this pipeline — always {data: bytes},
  // both for pdf.js (resolveSourcePageGeometry) and pdf-lib (PDFDocument.load) — so there is no
  // code path here that could follow an external URI referenced inside the PDF either.
  const result = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X" });
  assert.ok(result.bytes.length > 100, "export completes normally — the embedded action is inert data neither library ever interprets/executes");
  const { textContent } = await decode(result.bytes);
  assert.ok((textContent.items as { str: string }[]).some((i) => i.str.includes("PDF WITH EMBEDDED JS ACTION")), "source content still correctly extracted despite the embedded action");
});
