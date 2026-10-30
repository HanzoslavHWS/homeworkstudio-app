import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, type PDFObject, PDFRef, PDFString, decodePDFRawStream } from "pdf-lib";
import { buildTechnicalRasterMultiPageVectorExportPdf, buildTechnicalRasterVectorExportPdf } from "../lib/technicalRasterVectorPdf.ts";
import { resolveTechnicalServicePresentation } from "../domain/technicalRasterServicePresentation.ts";
import { buildManualDrawingExportItems, createLineDrawing, createPointDrawing } from "../domain/technicalRasterDrawings.ts";
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

const SOURCE_TECHNICAL = "TECHNICKÉ SLUŽBY";
const OUR_LAYER = "ABF – TECHNICKÉ ZNAČKY";

const MARKER = {
  standId: "s1", standNumber: "1A01", serviceId: "svc", placementId: "pl", xNormalized: 0.5, yNormalized: 0.5,
  presentation: resolveTechnicalServicePresentation("electricity", "Do 3kW 230V"), category: "electricity",
} as const;

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

test("F) the generator's own layers (ABF – TECHNICKÉ ZNAČKY + GENERÁTOR DATA) are registered and ON, independent of source layers being OFF", async () => {
  const { bytes } = await exportWith([STAND, TEXT, GRID, DIMS].map((ocgName) => ({ ocgName, visible: false })), {
    placements: [MARKER],
    realizationUnderlines: [{ standId: "s1", xNormalized: 0.4, yNormalized: 0.5, widthNormalized: 0.08, color: "#2f8f4e" }],
  });
  const oc = await readOcProperties(bytes);
  for (const name of ["ABF – TECHNICKÉ ZNAČKY", "GENERÁTOR DATA"]) {
    assert.ok(oc.ocgs.includes(name), name);
    assert.ok(oc.on.has(name) && !oc.off.has(name), name);
    assert.equal((await readViewerVisibility(bytes)).get(name), true, name);
  }
});

test("F2) with nothing generated, the export adds NO layer of its own — exactly the source layers", async () => {
  const { bytes } = await exportWith([{ ocgName: GRID, visible: false }]);
  const oc = await readOcProperties(bytes);
  assert.deepEqual(oc.ocgs, [STAND, TEXT, GRID, DIMS]);
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
    pages: [{ page: 1, placements: [], realizationUnderlines: [{ standId: "s1", xNormalized: 0.4, yNormalized: 0.5, widthNormalized: 0.08, color: "#2f8f4e" }] }],
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
  test(`REAL ${file}: one source layer switched OFF exports OFF; every other layer keeps its own state; order intact; nothing added when nothing is generated`, { skip: !existsSync(filePath) }, async () => {
    const source = new Uint8Array(await readFile(filePath));
    const sourceViewer = await readViewerVisibility(source);
    const layerNames = [...sourceViewer.keys()];
    assert.ok(layerNames.length > 1, "real raster has OCG layers");
    const target = layerNames.find((name) => sourceViewer.get(name)) ?? layerNames[0]!;
    const { bytes } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X", sourceLayerVisibility: [{ ocgName: target, visible: false }] });
    const viewer = await readViewerVisibility(bytes);
    assert.equal(viewer.get(target), false, `${target} exported OFF`);
    for (const name of layerNames) if (name !== target) assert.equal(viewer.get(name), sourceViewer.get(name), `${name} keeps its state`);
    assert.deepEqual([...viewer.keys()], layerNames, "exactly the source layers");
    const oc = await readOcProperties(bytes);
    assert.ok(oc.ocgs.includes(target), "disabled layer still present");
  });

  test(`REAL ${file} (HOTFIX-02): the raster's own TECHNICKÉ SLUŽBY layer is never used or switched — our data goes into ONE new "ABF – TECHNICKÉ ZNAČKY" layer`, { skip: !existsSync(filePath) }, async () => {
    const source = new Uint8Array(await readFile(filePath));
    const sourceViewer = await readViewerVisibility(source);
    assert.ok(sourceViewer.has(SOURCE_TECHNICAL), "the real raster has its own TECHNICKÉ SLUŽBY layer");
    const visibility = [...sourceViewer.keys()].map((ocgName) => ({ ocgName, visible: ocgName === SOURCE_TECHNICAL ? false : sourceViewer.get(ocgName)! }));
    const { bytes, technicalLayerStatus } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [MARKER], legend: [], showLegend: false, headerLine: "X", sourceLayerVisibility: visibility });
    assert.equal(technicalLayerStatus, "created");
    const viewer = await readViewerVisibility(bytes);
    assert.equal(viewer.get(SOURCE_TECHNICAL), false, "the project's OFF for the source layer is respected — it is not ours to switch");
    assert.equal(viewer.get(OUR_LAYER), true);
    assert.deepEqual([...viewer.keys()], [...sourceViewer.keys(), OUR_LAYER], "source layers unchanged and in order, then exactly one layer of ours");
    for (const name of sourceViewer.keys()) if (name !== SOURCE_TECHNICAL) assert.equal(viewer.get(name), sourceViewer.get(name), `${name} keeps its state`);
  });
}

// =========================================================================================
// HOTFIX-02 follow-up (CorelDRAW 2018 showed TWO layers named "TECHNICKÉ SLUŽBY"): the source
// raster's own "TECHNICKÉ SLUŽBY" layer is never used or modified; every technical element of ours
// goes into exactly ONE new layer "ABF – TECHNICKÉ ZNAČKY", appended after the source layers and
// drawn after the source content (on top). Synthetic fixture shaped like the real ABF rasters, so
// this runs everywhere (the real-raster variants above are skip-safe).
// =========================================================================================

/** One page: a source "TECHNICKÉ SLUŽBY" layer WITH its own content (a blue line) + a "RASTR" layer; the source layer is OFF by default. */
async function buildSourceWithTechnicalLayer(pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const technical = ctx.register(ctx.obj({ Type: "OCG", Name: PDFHexString.fromText(SOURCE_TECHNICAL) }));
  const raster = ctx.register(ctx.obj({ Type: "OCG", Name: PDFHexString.fromText("RASTR") }));
  for (let index = 0; index < pages; index += 1) {
    const page = doc.addPage([400, 300]);
    const props = PDFDict.withContext(ctx);
    props.set(PDFName.of("Pr47"), technical);
    props.set(PDFName.of("Pr12"), raster);
    (page.node.lookup(PDFName.of("Resources")) as PDFDict).set(PDFName.of("Properties"), props);
    page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream("/OC /Pr12 BDC 0 0 0 RG 0 150 m 400 150 l S EMC\n/OC /Pr47 BDC 0 0 1 RG 10 10 m 390 290 l S EMC\n", {})));
  }
  const arr = (refs: PDFRef[]) => { const a = PDFArray.withContext(ctx); refs.forEach((ref) => a.push(ref)); return a; };
  doc.catalog.set(PDFName.of("OCProperties"), ctx.obj({ OCGs: arr([technical, raster]), D: ctx.obj({ BaseState: "ON", ON: arr([raster]), OFF: arr([technical]), Order: arr([technical, raster]) }) }));
  return doc.save();
}

async function namedOcgRefs(bytes: Uint8Array, name: string): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const ocgs = (doc.catalog.lookup(PDFName.of("OCProperties")) as PDFDict).lookup(PDFName.of("OCGs")) as PDFArray;
  return ocgs.asArray().filter((ref) => ocgNameOf(doc, ref) === name).map((ref) => ref.toString());
}

test("OWN LAYER: the source TECHNICKÉ SLUŽBY layer is preserved exactly (name, OFF state, its own content, its page key) and EXACTLY ONE new 'ABF – TECHNICKÉ ZNAČKY' layer carries all our technical elements", async () => {
  const source = await buildSourceWithTechnicalLayer();
  const drawings = buildManualDrawingExportItems([
    { ...createPointDrawing(1, 0.3, 0.3, { category: "electricity", size: "medium", pointStyle: "dot" }, "d"), note: { text: "Přívod ze stropu", visible: true } },
    createLineDrawing(1, { x: 0.1, y: 0.7 }, { x: 0.5, y: 0.7 }, { category: "water", size: "thick" }, "l"),
  ], 1);
  const { bytes, technicalLayerStatus } = await buildTechnicalRasterVectorExportPdf({
    sourcePdfBytes: source, page: 1, placements: [MARKER], legend: [], showLegend: false, headerLine: "X",
    noElectricityMarkers: [{ standId: "s2", xNormalized: 0.8, yNormalized: 0.8 }], manualDrawings: drawings,
  });
  assert.equal(technicalLayerStatus, "created");

  // Layer list: the two source layers untouched and in their order, ours exactly once, LAST, ON.
  const viewer = await readViewerVisibility(bytes);
  assert.deepEqual([...viewer.entries()], [[SOURCE_TECHNICAL, false], ["RASTR", true], [OUR_LAYER, true]]);
  assert.equal((await namedOcgRefs(bytes, SOURCE_TECHNICAL)).length, 1, "the source layer exists once — never duplicated");
  assert.equal((await namedOcgRefs(bytes, OUR_LAYER)).length, 1, "exactly one layer of ours");
  const oc = await readOcProperties(bytes);
  assert.ok(oc.off.has(SOURCE_TECHNICAL) && !oc.on.has(SOURCE_TECHNICAL), "the source layer's OFF state is never switched");
  assert.deepEqual(oc.order, [SOURCE_TECHNICAL, "RASTR", OUR_LAYER], "ours appended after the source layers");

  // Content: the source layer keeps exactly its own content; everything of ours is in OUR bracket, after the source content.
  const content = await page1ContentText(bytes);
  assert.equal((content.match(/\/OC \/Pr47 BDC/gu) ?? []).length, 1, "nothing of ours is tagged with the source layer's key");
  assert.match(content, /\/OC \/Pr47 BDC 0 0 1 RG 10 10 m 390 290 l S EMC/u, "the source layer's own drawing is byte-identical");
  const doc = await PDFDocument.load(bytes);
  const props = (doc.getPage(0).node.lookup(PDFName.of("Resources")) as PDFDict).lookup(PDFName.of("Properties")) as PDFDict;
  const ourKey = props.keys().find((key) => ocgNameOf(doc, props.get(key)!) === OUR_LAYER)!;
  assert.ok(ourKey, "our layer is referenced from the page resources");
  const start = content.lastIndexOf(`/OC ${ourKey.toString()} BDC`);
  assert.ok(start > content.indexOf("/OC /Pr47 BDC"), "our content comes after (= above) the source content");
  const ours = content.slice(start, content.indexOf("EMC", start));
  assert.match(ours, /0\.702 0\.149 0\.118 rg [^\n]* Tj ET Q/u, "the service label is real text inside our layer");
  assert.equal((ours.match(/\bTj\b/gu) ?? []).length, 2, "service label + visible note");
  assert.match(ours, /0\.756863 0\.070588 0\.121569 RG/u, "BEZ elektriky X inside our layer");
  assert.match(ours, /0\.101961 0\.478431 0\.298039 RG/u, "manual line inside our layer");
});

function ocgNameOf(doc: PDFDocument, ref: PDFObject): string | undefined {
  const ocg = doc.context.lookup(ref);
  const name = ocg instanceof PDFDict ? ocg.lookup(PDFName.of("Name")) : undefined;
  return name instanceof PDFString || name instanceof PDFHexString ? name.decodeText() : undefined;
}

test("OWN LAYER: no technical data -> no layer of ours, source layers exactly as they were; repeated and multi-page exports never duplicate our layer", async () => {
  const empty = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: await buildSourceWithTechnicalLayer(), page: 1, placements: [], legend: [], showLegend: false, headerLine: "X" });
  assert.equal(empty.technicalLayerStatus, "not_needed");
  assert.deepEqual([...(await readViewerVisibility(empty.bytes)).entries()], [[SOURCE_TECHNICAL, false], ["RASTR", true]]);

  const source = await buildSourceWithTechnicalLayer();
  for (let run = 0; run < 3; run += 1) {
    const { bytes } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [MARKER], legend: [], showLegend: false, headerLine: "X" });
    assert.equal((await namedOcgRefs(bytes, OUR_LAYER)).length, 1, `export #${run + 1}: one layer of ours`);
  }

  const multi = await buildTechnicalRasterMultiPageVectorExportPdf({
    sourcePdfBytes: await buildSourceWithTechnicalLayer(2),
    pages: [{ page: 1, placements: [MARKER] }, { page: 2, placements: [MARKER] }],
    legend: [], showLegend: false, headerLine: "X",
  });
  assert.equal((await namedOcgRefs(multi.bytes, OUR_LAYER)).length, 1, "one shared layer of ours across pages");
  const reloaded = await PDFDocument.load(multi.bytes);
  const refsOnPages = [0, 1].map((index) => {
    const props = (reloaded.getPage(index).node.lookup(PDFName.of("Resources")) as PDFDict).lookup(PDFName.of("Properties")) as PDFDict;
    return props.keys().map((key) => props.get(key)!).find((ref) => ocgNameOf(reloaded, ref) === OUR_LAYER)?.toString();
  });
  assert.ok(refsOnPages[0] && refsOnPages[0] === refsOnPages[1], "both pages point at the SAME layer object");
});
