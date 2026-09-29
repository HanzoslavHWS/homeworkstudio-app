import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFRef, PDFString, decodePDFRawStream } from "pdf-lib";
import { buildTechnicalRasterMultiPageVectorExportPdf, buildTechnicalRasterVectorExportPdf } from "../lib/technicalRasterVectorPdf.ts";
import {
  createTechnicalRasterProject,
  effectiveHiddenLayerIds,
  resolveExportSourceLayerVisibility,
  withLayerVisibility,
  withRasterLayers,
  withRasterViewMode,
  withWorkModeHiddenLayers,
} from "../domain/technicalRaster.ts";

// =========================================================================================
// CORRECTIVE BATCH — the project's ACTUAL source-layer ON/OFF must survive export.
// Root cause: reconstructOcProperties rebuilt /D/ON and /D/OFF from the SOURCE PDF's own defaults
// only; the project's layerVisibility never reached the export, so a layer the user switched OFF
// opened ON again in the exported PDF. "Nezobrazovat v pracovní verzi" (workModeHiddenLayerIds) is
// a working-view preference and must NOT affect the export.
// =========================================================================================

const STAND = "STÁNKY ***";
const TEXT = "NÁZVY + ROZMĚRY ***";
const GRID = "MŘÍŽKA";
const DIMS = "KÓTY"; // OFF in the source PDF itself

/** 4 OCGs with real marked content; KÓTY is OFF in the source; /Order = [ "SKUPINA" [STAND TEXT] GRID DIMS ]. */
async function buildLayeredSource(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const ctx = doc.context;
  const refs = new Map<string, PDFRef>();
  for (const name of [STAND, TEXT, GRID, DIMS]) {
    const ocg = PDFDict.withContext(ctx);
    ocg.set(PDFName.of("Type"), PDFName.of("OCG"));
    ocg.set(PDFName.of("Name"), PDFHexString.fromText(name));
    refs.set(name, ctx.register(ocg));
  }
  const props = PDFDict.withContext(ctx);
  props.set(PDFName.of("MC0"), refs.get(STAND)!);
  props.set(PDFName.of("MC1"), refs.get(TEXT)!);
  props.set(PDFName.of("MC2"), refs.get(GRID)!);
  props.set(PDFName.of("MC3"), refs.get(DIMS)!);
  const resources = page.node.lookup(PDFName.of("Resources"));
  if (resources instanceof PDFDict) resources.set(PDFName.of("Properties"), props);

  const ocgs = PDFArray.withContext(ctx);
  const on = PDFArray.withContext(ctx);
  const off = PDFArray.withContext(ctx);
  for (const name of [STAND, TEXT, GRID, DIMS]) { ocgs.push(refs.get(name)!); (name === DIMS ? off : on).push(refs.get(name)!); }
  const nested = PDFArray.withContext(ctx);
  nested.push(refs.get(STAND)!);
  nested.push(refs.get(TEXT)!);
  const order = PDFArray.withContext(ctx);
  order.push(PDFHexString.fromText("SKUPINA"));
  order.push(nested);
  order.push(refs.get(GRID)!);
  order.push(refs.get(DIMS)!);
  const d = PDFDict.withContext(ctx);
  d.set(PDFName.of("BaseState"), PDFName.of("ON"));
  d.set(PDFName.of("ON"), on);
  d.set(PDFName.of("OFF"), off);
  d.set(PDFName.of("Order"), order);
  const ocProps = PDFDict.withContext(ctx);
  ocProps.set(PDFName.of("OCGs"), ctx.register(ocgs));
  ocProps.set(PDFName.of("D"), ctx.register(d));
  doc.catalog.set(PDFName.of("OCProperties"), ctx.register(ocProps));

  const content = [
    "/OC /MC0 BDC 1 0 0 rg 0 0 1 RG 2 w 20 20 100 60 re B EMC",
    "/OC /MC1 BDC BT /F1 12 Tf 30 150 Td (Firma XY) Tj ET EMC",
    "/OC /MC2 BDC 0 0 0 RG 0.5 w 0 100 m 300 100 l S EMC",
    "/OC /MC3 BDC 0 0 0 RG 0.5 w 150 0 m 150 200 l S EMC",
  ].join("\n");
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(new TextEncoder().encode(content), {})));
  return doc.save();
}

function nameOf(doc: PDFDocument, ref: unknown): string | undefined {
  const ocg = doc.context.lookup(ref as PDFRef);
  const name = ocg instanceof PDFDict ? ocg.lookup(PDFName.of("Name")) : undefined;
  return name instanceof PDFHexString || name instanceof PDFString ? name.decodeText() : undefined;
}

function namesIn(doc: PDFDocument, array: unknown): string[] {
  if (!(array instanceof PDFArray)) return [];
  return Array.from({ length: array.size() }, (_, index) => nameOf(doc, array.get(index))).filter((name): name is string => Boolean(name));
}

type OrderNode = string | readonly OrderNode[];
function orderTree(doc: PDFDocument, array: PDFArray): OrderNode[] {
  const out: OrderNode[] = [];
  for (let index = 0; index < array.size(); index += 1) {
    const entry = array.get(index);
    const resolved = doc.context.lookup(entry);
    if (resolved instanceof PDFArray) out.push(orderTree(doc, resolved));
    else if (entry instanceof PDFString || entry instanceof PDFHexString) out.push(`«${entry.decodeText()}»`);
    else out.push(nameOf(doc, entry) ?? "?");
  }
  return out;
}

/** Raw /OCProperties as written (pdf-lib). */
async function readOcProperties(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  const ocProps = doc.catalog.lookup(PDFName.of("OCProperties")) as PDFDict;
  const d = ocProps.lookup(PDFName.of("D")) as PDFDict;
  return {
    ocgs: namesIn(doc, ocProps.lookup(PDFName.of("OCGs"))),
    on: new Set(namesIn(doc, d.lookup(PDFName.of("ON")))),
    off: new Set(namesIn(doc, d.lookup(PDFName.of("OFF")))),
    order: orderTree(doc, d.lookup(PDFName.of("Order")) as PDFArray),
    doc,
  };
}

/** What a viewer shows (pdf.js): OCG name -> visible by default. */
async function readViewerVisibility(bytes: Uint8Array): Promise<Map<string, boolean>> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(bytes) });
  const doc = await loadingTask.promise;
  const config = await doc.getOptionalContentConfig();
  const result = new Map<string, boolean>();
  for (const [, group] of config as unknown as Iterable<[string, { name: string; visible: boolean }]>) result.set(group.name, group.visible);
  await loadingTask.destroy();
  return result;
}

async function page1ContentText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const contents = doc.getPage(0).node.Contents();
  const streams = contents instanceof PDFArray ? Array.from({ length: contents.size() }, (_, index) => doc.context.lookup(contents.get(index))) : [contents];
  return streams.map((stream) => (stream instanceof PDFRawStream ? new TextDecoder().decode(decodePDFRawStream(stream).decode()) : "")).join("\n");
}

async function exportWith(visibility: readonly { ocgName: string; visible: boolean }[], extra: Partial<Parameters<typeof buildTechnicalRasterVectorExportPdf>[0]> = {}) {
  return buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: await buildLayeredSource(), page: 1, placements: [], legend: [], showLegend: false, headerLine: "X", sourceLayerVisibility: visibility, ...extra });
}

// =========================================================================================

test("A) actual source layer OFF -> the exported PDF opens with that OCG OFF (raw /D and in a viewer)", async () => {
  const { bytes } = await exportWith([{ ocgName: GRID, visible: false }]);
  const oc = await readOcProperties(bytes);
  assert.ok(oc.off.has(GRID));
  assert.ok(!oc.on.has(GRID));
  assert.equal((await readViewerVisibility(bytes)).get(GRID), false);
});

test("B) actual source layer ON -> ON in the export, even when the SOURCE PDF itself had it OFF", async () => {
  const { bytes } = await exportWith([{ ocgName: DIMS, visible: true }]);
  const oc = await readOcProperties(bytes);
  assert.ok(oc.on.has(DIMS));
  assert.ok(!oc.off.has(DIMS));
  assert.equal((await readViewerVisibility(bytes)).get(DIMS), true);
});

test("B2) no project state given -> the source PDF's own defaults are kept (unchanged behavior)", async () => {
  const { bytes } = await exportWith([]);
  const viewer = await readViewerVisibility(bytes);
  assert.deepEqual([viewer.get(STAND), viewer.get(TEXT), viewer.get(GRID), viewer.get(DIMS)], [true, true, true, false]);
});

test("C) 'Nezobrazovat v pracovní verzi' + layer ON -> hidden in the editor's work mode, ON in the export", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p");
  project = withRasterLayers(project, [
    { id: "L-grid", name: GRID, defaultVisible: true },
    { id: "L-dims", name: DIMS, defaultVisible: false },
  ]);
  project = withRasterViewMode(withWorkModeHiddenLayers(project, ["L-grid"]), "work");
  assert.ok(effectiveHiddenLayerIds(project).has("L-grid"), "editor hides it while working");
  assert.deepEqual(resolveExportSourceLayerVisibility(project), [
    { ocgName: GRID, visible: true },
    { ocgName: DIMS, visible: false },
  ], "export ignores the working-view hide; unset layers fall back to the PDF default");
  const switchedOff = withLayerVisibility(project, "L-grid", false);
  assert.deepEqual(resolveExportSourceLayerVisibility(switchedOff)[0], { ocgName: GRID, visible: false }, "the ACTUAL layer switch is what the export follows");
});

test("C2) end to end: working-hidden-but-enabled layer exports ON", async () => {
  let project = withRasterLayers(createTechnicalRasterProject({ name: "X" }, "p"), [{ id: "L-grid", name: GRID, defaultVisible: true }]);
  project = withRasterViewMode(withWorkModeHiddenLayers(project, ["L-grid"]), "work");
  const { bytes } = await exportWith(resolveExportSourceLayerVisibility(project));
  assert.equal((await readViewerVisibility(bytes)).get(GRID), true);
});

test("D) mixed state across several layers: every layer follows its own setting independently", async () => {
  const { bytes } = await exportWith([
    { ocgName: STAND, visible: true },
    { ocgName: TEXT, visible: false },
    { ocgName: GRID, visible: false },
    { ocgName: DIMS, visible: true },
  ]);
  const viewer = await readViewerVisibility(bytes);
  assert.deepEqual([viewer.get(STAND), viewer.get(TEXT), viewer.get(GRID), viewer.get(DIMS)], [true, false, false, true]);
});

test("E) source /OCGs order and nested /Order (heading + subgroup) are preserved", async () => {
  const { bytes } = await exportWith([{ ocgName: TEXT, visible: false }, { ocgName: DIMS, visible: true }]);
  const oc = await readOcProperties(bytes);
  assert.deepEqual(oc.ocgs.filter((name) => name !== "GENERÁTOR DATA"), [STAND, TEXT, GRID, DIMS]);
  assert.deepEqual(oc.order.filter((node) => node !== "GENERÁTOR DATA"), ["«SKUPINA»", [STAND, TEXT], GRID, DIMS]);
});

test("F) GENERÁTOR DATA stays registered and ON, independent of source layers being OFF", async () => {
  const { bytes } = await exportWith([STAND, TEXT, GRID, DIMS].map((ocgName) => ({ ocgName, visible: false })));
  const oc = await readOcProperties(bytes);
  assert.ok(oc.ocgs.includes("GENERÁTOR DATA"));
  assert.ok(oc.on.has("GENERÁTOR DATA"));
  assert.ok(!oc.off.has("GENERÁTOR DATA"));
  assert.equal((await readViewerVisibility(bytes)).get("GENERÁTOR DATA"), true);
});

test("G) a disabled layer is NOT deleted: its OCG object and its marked content are still in the PDF", async () => {
  const { bytes } = await exportWith([{ ocgName: GRID, visible: false }]);
  const oc = await readOcProperties(bytes);
  assert.ok(oc.ocgs.includes(GRID));
  const content = await page1ContentText(bytes);
  assert.match(content, /\/OC \/MC2 BDC[\s\S]*?0 100 m 300 100 l S[\s\S]*?EMC/u, "the layer's drawing is still there, just default-hidden");
});

test("H) text scaling on a disabled layer does not re-enable it (and is still applied)", async () => {
  const { bytes, textScaleDiagnostics } = await exportWith([{ ocgName: TEXT, visible: false }], { textScales: [{ ocgName: TEXT, scale: 0.7 }] });
  assert.equal(textScaleDiagnostics[0]?.status, "applied");
  const oc = await readOcProperties(bytes);
  assert.ok(oc.off.has(TEXT) && !oc.on.has(TEXT));
  assert.equal((await readViewerVisibility(bytes)).get(TEXT), false);
});

test("I) white mode on a disabled stand layer does not re-enable it (and is still applied)", async () => {
  const { bytes, whiteModeDiagnostic } = await exportWith([{ ocgName: STAND, visible: false }], { whiteMode: { opacity: 0.6 } });
  assert.equal(whiteModeDiagnostic.status, "applied");
  const oc = await readOcProperties(bytes);
  assert.ok(oc.off.has(STAND) && !oc.on.has(STAND));
  assert.equal((await readViewerVisibility(bytes)).get(STAND), false);
});

test("MULTI-PAGE export applies the same source-layer defaults", async () => {
  const { bytes } = await buildTechnicalRasterMultiPageVectorExportPdf({
    sourcePdfBytes: await buildLayeredSource(),
    pages: [{ page: 1, placements: [] }],
    legend: [],
    showLegend: false,
    headerLine: "X",
    sourceLayerVisibility: [{ ocgName: GRID, visible: false }, { ocgName: DIMS, visible: true }],
  });
  const viewer = await readViewerVisibility(bytes);
  assert.deepEqual([viewer.get(GRID), viewer.get(DIMS), viewer.get("GENERÁTOR DATA")], [false, true, true]);
});

// =========================================================================================
// Real hall rasters — skip-safe (gitignored _IMPORT/ customer files, never required by npm test)
// =========================================================================================

for (const file of ["Hala 1.pdf", "Hala 3_2026- ver.12_NOVY_3.pdf"]) {
  const filePath = new URL(`../_IMPORT/${file}`, import.meta.url);
  test(`REAL ${file}: one source layer switched OFF exports OFF; every other layer keeps its own state; order + GENERÁTOR DATA intact`, { skip: !existsSync(filePath) }, async () => {
    const source = new Uint8Array(await readFile(filePath));
    const sourceViewer = await readViewerVisibility(source);
    const layerNames = [...sourceViewer.keys()];
    assert.ok(layerNames.length > 1, "real raster has OCG layers");
    const target = layerNames.find((name) => sourceViewer.get(name)) ?? layerNames[0]!;
    const { bytes } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X", sourceLayerVisibility: [{ ocgName: target, visible: false }] });
    const viewer = await readViewerVisibility(bytes);
    assert.equal(viewer.get(target), false, `${target} exported OFF`);
    for (const name of layerNames) if (name !== target) assert.equal(viewer.get(name), sourceViewer.get(name), `${name} keeps its state`);
    assert.equal(viewer.get("GENERÁTOR DATA"), true);
    const oc = await readOcProperties(bytes);
    assert.ok(oc.ocgs.includes(target), "disabled layer still present");
  });
}
