import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFString, StandardFonts, decodePDFRawStream, degrees, rgb } from "pdf-lib";
import {
  buildManualDrawingExportItems,
  createLineDrawing,
  createPointDrawing,
  DEFAULT_DRAWING_COLOR,
  DRAWING_CATEGORIES,
  DRAWING_NOTE_FONT_SIZE_PT,
  DRAWING_SIZES,
  drawingCategoryOf,
  drawingColorOf,
  drawingPointShapeOf,
  effectiveManualDrawings,
  isDegenerateLine,
  moveManualDrawing,
  normalizeManualDrawings,
  withManualDrawingAdded,
  withManualDrawingMoved,
  withManualDrawingNote,
  withManualDrawingRemoved,
  withManualDrawingStyle,
  type DrawingCategory,
  type DrawingPointStyle,
  type DrawingSize,
  type TechnicalRasterDrawing,
} from "../domain/technicalRasterDrawings.ts";
import { TECHNICAL_RASTER_COLORS } from "../domain/technicalRasterServicePresentation.ts";
import { buildTechnicalRasterExportLegend } from "../domain/technicalRasterExport.ts";
import {
  createTechnicalRasterProject,
  mergeTechnicalRasterImportWithDiff,
  placeTechnicalService,
  withRasterStandLabels,
  type TechnicalRasterImport,
  type TechnicalRasterProject,
} from "../domain/technicalRaster.ts";
import { projectToRow, rowToProject, type TechnicalRasterProjectRow } from "../lib/db/technicalRasterProjectRepository.supabase.ts";
import { buildTechnicalRasterMultiPageVectorExportPdf, buildTechnicalRasterVectorExportPdf, resolveSourcePageGeometry } from "../lib/technicalRasterVectorPdf.ts";
import { normalizedDisplayPointToRawPdfPoint } from "../domain/technicalRasterExportPlacementGeometry.ts";
import { resolvePlacementShortcut } from "../domain/technicalRasterPlacementShortcuts.ts";
import type { StoredAsset } from "../domain/assets.ts";

// =========================================================================================
// RUČNÍ ZNAČKY — manual points ("Bod" — dot ● / cross ×) and lines A–B ("Čára"): a separate project
// layer (project.manualDrawings), same normalized page space as placements. HOTFIX-02: technical
// color categories, notes (internal / visible), exported inside the ABF – TECHNICKÉ ZNAČKY layer.
// =========================================================================================

const RED = TECHNICAL_RASTER_COLORS.electricity;
const BLUE = TECHNICAL_RASTER_COLORS.internet;
const GREEN = TECHNICAL_RASTER_COLORS.water;

/** Test shorthand: a point of category/size/shape. */
function mkPoint(page: number, x: number, y: number, category: DrawingCategory, size: DrawingSize, id: string, pointStyle: DrawingPointStyle = "dot") {
  return createPointDrawing(page, x, y, { category, size, pointStyle }, id);
}
function mkLine(page: number, a: Readonly<{ x: number; y: number }>, b: Readonly<{ x: number; y: number }>, category: DrawingCategory, size: DrawingSize, id: string) {
  return createLineDrawing(page, a, b, { category, size }, id);
}

function asset(id: string): StoredAsset {
  return { id, storageKey: `k/${id}.pdf`, originalFileName: `${id}.pdf`, mimeType: "application/pdf", size: 1, createdAt: "2026-01-01T00:00:00.000Z", category: "technical-raster-import" };
}

function baseProject(): TechnicalRasterProject {
  return withRasterStandLabels(createTechnicalRasterProject({ name: "H3" }, "p"), [
    { id: "l1", page: 1, rawText: "3A20", normalizedStandNumber: "3A20", xNormalized: 0.2, yNormalized: 0.2, widthNormalized: 0.02, heightNormalized: 0.01 },
  ]);
}

/** Supabase save -> JSON (what really goes over the wire / into jsonb) -> reload. */
function saveAndReload(project: TechnicalRasterProject): TechnicalRasterProject {
  const row = projectToRow(project);
  const stored = JSON.parse(JSON.stringify(row)) as Omit<TechnicalRasterProjectRow, "id" | "created_at" | "updated_at">;
  return rowToProject({ ...stored, id: project.id, created_at: project.createdAt, updated_at: project.updatedAt } as TechnicalRasterProjectRow);
}

// =========================================================================================
// Model + persistence
// =========================================================================================

test("SAVE + RELOAD: a point survives the real repository mapping (position, page, color, size)", () => {
  const point = mkPoint(1, 0.25, 0.75, "internet", "thick", "pt-1");
  const reloaded = saveAndReload(withManualDrawingAdded(baseProject(), point));
  assert.deepEqual(effectiveManualDrawings(reloaded), [point]);
});

test("SAVE + RELOAD: a line survives the real repository mapping (A, B, page, color, width)", () => {
  const line = mkLine(2, { x: 0.1, y: 0.2 }, { x: 0.8, y: 0.6 }, "water", "thin", "ln-1");
  const reloaded = saveAndReload(withManualDrawingAdded(baseProject(), line));
  assert.deepEqual(effectiveManualDrawings(reloaded), [line]);
});

test("CATEGORY + COLOR are kept exactly; restyling the selected drawing changes only its category/color/size", () => {
  let project = withManualDrawingAdded(baseProject(), mkPoint(1, 0.5, 0.5, "electricity", "medium", "a"));
  project = withManualDrawingAdded(project, mkLine(1, { x: 0, y: 0 }, { x: 1, y: 1 }, "electricity", "medium", "b"));
  project = withManualDrawingStyle(project, "b", { category: "internet", size: "thick" });
  const [a, b] = effectiveManualDrawings(saveAndReload(project));
  assert.equal(a!.color, RED);
  assert.equal(b!.color, BLUE);
  assert.equal(b!.type === "line" && b!.width, "thick");
  assert.equal(b!.category, "internet");
});

test("RELOAD robustness: older projects have no drawings; malformed entries are dropped, bad colors fall back, coordinates are clamped", () => {
  assert.deepEqual(effectiveManualDrawings(saveAndReload(baseProject())), []);
  assert.deepEqual(normalizeManualDrawings(undefined), []);
  assert.deepEqual(normalizeManualDrawings([
    { id: "ok", type: "point", page: 1, x: 1.4, y: -0.2, color: "red; injection" },
    { id: "no-page", type: "point", x: 0.5, y: 0.5, color: RED },
    { id: "nan", type: "line", page: 1, x1: 0, y1: 0, x2: Number.NaN, y2: 1, color: RED },
    { type: "point", page: 1, x: 0.5, y: 0.5 },
    "garbage",
  ]), [{ id: "ok", type: "point", page: 1, x: 1, y: 0, color: DEFAULT_DRAWING_COLOR }]);
});

test("OLDER drawings (saved before HOTFIX-02: no category, no shape, no note) load unchanged — own color, original '+' cross, nothing rewritten", () => {
  const legacy = [
    { id: "old-red", type: "point", page: 1, x: 0.2, y: 0.2, color: "#d62828", size: "thick" },
    { id: "old-black", type: "line", page: 1, x1: 0.1, y1: 0.1, x2: 0.3, y2: 0.3, color: "#111111" },
  ];
  const drawings = normalizeManualDrawings(JSON.parse(JSON.stringify(legacy)));
  assert.deepEqual(drawings, legacy, "stored data is read back verbatim, no field added");
  const [oldRed, oldBlack] = drawings;
  assert.equal(drawingColorOf(oldRed!), "#d62828", "an older color without category keeps its own color");
  assert.equal(drawingCategoryOf(oldRed!), undefined);
  assert.equal(oldRed!.type === "point" && drawingPointShapeOf(oldRed!), "plus", "an older point keeps its original '+' cross");
  assert.equal(drawingCategoryOf(oldBlack!), "neutral", "the old neutral black counts as the Neutrální category");
  const [exported] = buildManualDrawingExportItems([oldRed!], 1);
  assert.equal(exported!.kind === "point" && exported!.shape, "plus");
  assert.equal(exported!.color, "#d62828");
  // Restyling upgrades just that drawing.
  const upgraded = effectiveManualDrawings(withManualDrawingStyle(withManualDrawingAdded(baseProject(), oldRed!), "old-red", { category: "water", pointStyle: "cross" }))[0]!;
  assert.deepEqual([upgraded.category, upgraded.color, upgraded.type === "point" && upgraded.pointStyle], ["water", TECHNICAL_RASTER_COLORS.water, "cross"]);
});

test("CATEGORIES use the technical service colors — one shared palette, no separate drawing colors", () => {
  assert.deepEqual(DRAWING_CATEGORIES.map((category) => [category.id, category.color]), [
    ["electricity", TECHNICAL_RASTER_COLORS.electricity],
    ["internet", TECHNICAL_RASTER_COLORS.internet],
    ["water", TECHNICAL_RASTER_COLORS.water],
    ["cleaning", TECHNICAL_RASTER_COLORS.cleaning],
    ["waste", TECHNICAL_RASTER_COLORS.waste],
    ["neutral", TECHNICAL_RASTER_COLORS.neutral],
  ]);
  const created = mkPoint(1, 0.5, 0.5, "cleaning", "thin", "c", "cross");
  assert.deepEqual([created.category, created.color, created.type === "point" && created.pointStyle, created.type === "point" && created.size], ["cleaning", TECHNICAL_RASTER_COLORS.cleaning, "cross", "thin"]);
});

test("SAVE + RELOAD: category, type, shape, color, size, position and note of every manual mark survive", () => {
  let project = withManualDrawingAdded(baseProject(), mkPoint(1, 0.3, 0.6, "waste", "thick", "dot", "dot"));
  project = withManualDrawingAdded(project, mkLine(2, { x: 0.1, y: 0.1 }, { x: 0.4, y: 0.2 }, "neutral", "thin", "ln"));
  project = withManualDrawingNote(project, "dot", { text: "Kontejner u vstupu", visible: true });
  project = withManualDrawingNote(project, "ln", { text: "Kabel pod kobercem" });
  const reloaded = effectiveManualDrawings(saveAndReload(project));
  assert.deepEqual(reloaded, effectiveManualDrawings(project));
  assert.deepEqual(reloaded[0]!.note, { text: "Kontejner u vstupu", visible: true });
  assert.deepEqual(reloaded[1]!.note, { text: "Kabel pod kobercem", visible: false }, "a note is internal by default");
});

test("NOTES: text is a clean single line (trimmed, collapsed, capped); empty text removes the note; visibility kept when only text changes", () => {
  let project = withManualDrawingAdded(baseProject(), mkPoint(1, 0.5, 0.5, "electricity", "medium", "p"));
  project = withManualDrawingNote(project, "p", { text: "  Přívod \n elektřiny\tze   stropu  ", visible: true });
  assert.deepEqual(effectiveManualDrawings(project)[0]!.note, { text: "Přívod elektřiny ze stropu", visible: true });
  project = withManualDrawingNote(project, "p", { text: "Přívod ze stropu" });
  assert.deepEqual(effectiveManualDrawings(project)[0]!.note, { text: "Přívod ze stropu", visible: true });
  project = withManualDrawingNote(project, "p", { text: "x".repeat(500) });
  assert.equal(effectiveManualDrawings(project)[0]!.note!.text.length, 200);
  project = withManualDrawingNote(project, "p", { text: "   " });
  assert.equal(effectiveManualDrawings(project)[0]!.note, undefined);
  assert.equal(normalizeManualDrawings([{ id: "n", type: "point", page: 1, x: 0, y: 0, color: RED, note: { text: 42, visible: "yes" } }])[0]!.note, undefined, "a malformed note is dropped");
});

test("NOTES move with their mark: moving the mark never leaves the note behind (the note has no coordinates of its own)", () => {
  let project = withManualDrawingAdded(baseProject(), mkPoint(1, 0.5, 0.5, "electricity", "medium", "p"));
  project = withManualDrawingNote(project, "p", { text: "Přívod elektřiny ze stropu", visible: true });
  project = withManualDrawingMoved(project, "p", 0.1, 0.1);
  const [moved] = effectiveManualDrawings(project);
  assert.deepEqual([moved!.type === "point" && moved!.x, moved!.type === "point" && moved!.y], [0.6, 0.6]);
  assert.deepEqual(moved!.note, { text: "Přívod elektřiny ze stropu", visible: true });
  const [item] = buildManualDrawingExportItems([moved!], 1);
  assert.deepEqual([item!.kind === "point" && item!.x, item!.kind === "point" && item!.y, item!.note?.text], [0.6, 0.6, "Přívod elektřiny ze stropu"]);
});

test("EXPORT ITEMS: an internal note never reaches the export; a visible note does, at the technical text size", () => {
  let project = withManualDrawingAdded(baseProject(), mkPoint(1, 0.5, 0.5, "electricity", "medium", "internal"));
  project = withManualDrawingAdded(project, mkPoint(1, 0.6, 0.5, "electricity", "medium", "visible"));
  project = withManualDrawingNote(project, "internal", { text: "jen pro nás" });
  project = withManualDrawingNote(project, "visible", { text: "Přívod ze stropu", visible: true });
  const [internal, visible] = buildManualDrawingExportItems(effectiveManualDrawings(project), 1);
  assert.equal(internal!.note, undefined);
  assert.deepEqual(visible!.note, { text: "Přívod ze stropu", fontSizePt: DRAWING_NOTE_FONT_SIZE_PT, gapPt: 1 });
});

test("LEGEND: manual drawing categories count as used categories; neutral black appears ONLY with a neutral drawing", () => {
  assert.deepEqual(buildTechnicalRasterExportLegend([], []), []);
  const withWater = buildTechnicalRasterExportLegend([], buildManualDrawingExportItems([mkLine(1, { x: 0, y: 0 }, { x: 1, y: 1 }, "water", "medium", "w")], 1));
  assert.deepEqual(withWater.map((entry) => entry.legendLabel), ["VODA"]);
  const withNeutral = buildTechnicalRasterExportLegend([], buildManualDrawingExportItems([mkPoint(1, 0.1, 0.1, "neutral", "medium", "n"), mkPoint(1, 0.2, 0.2, "electricity", "medium", "e")], 1));
  assert.deepEqual(withNeutral.map((entry) => [entry.legendLabel, entry.color]), [["ELEKTŘINA", TECHNICAL_RASTER_COLORS.electricity], ["NEUTRÁLNÍ", TECHNICAL_RASTER_COLORS.neutral]]);
  const legacyOnly = buildTechnicalRasterExportLegend([], buildManualDrawingExportItems(normalizeManualDrawings([{ id: "l", type: "point", page: 1, x: 0, y: 0, color: "#1d4ed8" }]), 1));
  assert.deepEqual(legacyOnly, [], "an older drawing in a color that is no category is not explained by the legend");
});


test("DELETE point: only that point disappears", () => {
  let project = withManualDrawingAdded(baseProject(), mkPoint(1, 0.1, 0.1, "electricity", "medium", "a"));
  project = withManualDrawingAdded(project, mkPoint(1, 0.2, 0.2, "electricity", "medium", "b"));
  assert.deepEqual(effectiveManualDrawings(withManualDrawingRemoved(project, "a")).map((drawing) => drawing.id), ["b"]);
  assert.equal(withManualDrawingRemoved(project, "missing"), project, "unknown id is a no-op");
});

test("DELETE line: only that line disappears", () => {
  let project = withManualDrawingAdded(baseProject(), mkLine(1, { x: 0, y: 0 }, { x: 1, y: 1 }, "electricity", "medium", "line"));
  project = withManualDrawingAdded(project, mkPoint(1, 0.2, 0.2, "electricity", "medium", "point"));
  assert.deepEqual(effectiveManualDrawings(saveAndReload(withManualDrawingRemoved(project, "line"))).map((drawing) => drawing.id), ["point"]);
});

test("MOVE: a point moves (clamped to the page); a whole line moves keeping its exact shape, stopping at the page edge", () => {
  const point = mkPoint(1, 0.5, 0.5, "electricity", "medium", "p");
  assert.deepEqual(moveManualDrawing(point, 0.1, -0.2), { ...point, x: 0.6, y: 0.3 });
  assert.deepEqual(moveManualDrawing(point, 0.9, 0.9), { ...point, x: 1, y: 1 });
  const line = mkLine(1, { x: 0.2, y: 0.2 }, { x: 0.6, y: 0.4 }, "electricity", "medium", "l");
  const moved = moveManualDrawing(line, 0.7, 0);
  assert.ok(moved.type === "line");
  assert.deepEqual([moved.x1, moved.x2].map((value) => Math.round(value * 1000) / 1000), [0.6, 1], "stops at the edge");
  assert.equal(Math.round((moved.x2 - moved.x1) * 1000) / 1000, 0.4, "length unchanged");
  const project = withManualDrawingMoved(withManualDrawingAdded(baseProject(), line), "l", 0.1, 0.1);
  const [stored] = effectiveManualDrawings(project);
  assert.ok(stored!.type === "line");
  assert.deepEqual([stored!.x1, stored!.y1, stored!.x2, stored!.y2].map((value) => Math.round(value * 1000) / 1000), [0.3, 0.3, 0.7, 0.5]);
});

test("LINE DRAFT cancel: a line needs two distinct clicks; a cancelled draft (or A == B) never stores anything", () => {
  assert.equal(isDegenerateLine({ x: 0.3, y: 0.3 }, { x: 0.3, y: 0.3 }), true);
  assert.equal(isDegenerateLine({ x: 0.3, y: 0.3 }, { x: 0.31, y: 0.3 }), false);
  // Escape resolves to the centralized cancel while a line draft is pending (the editor passes
  // placementActive = placement || lineDraft); handleCancelPlacement clears the draft.
  assert.equal(resolvePlacementShortcut({ key: "Escape", target: { tagName: "CANVAS" } }, { placementActive: true, shortcutsEnabled: true }), "cancelPlacement");
});

test("SHORTCUT Delete: removes the selected drawing only when one is selected, never while typing", () => {
  const context = { placementActive: false, shortcutsEnabled: true, drawingSelected: true };
  assert.equal(resolvePlacementShortcut({ key: "Delete", target: { tagName: "CANVAS" } }, context), "deleteDrawing");
  assert.equal(resolvePlacementShortcut({ key: "Backspace", target: { tagName: "CANVAS" } }, context), "deleteDrawing");
  assert.equal(resolvePlacementShortcut({ key: "Delete", target: { tagName: "CANVAS" } }, { ...context, drawingSelected: false }), undefined);
  assert.equal(resolvePlacementShortcut({ key: "Backspace", target: { tagName: "INPUT" } }, context), undefined);
});

// =========================================================================================
// Separation from services
// =========================================================================================

function importElectricity(project: TechnicalRasterProject, id: string, quantity: number, replace?: string) {
  const record: TechnicalRasterImport = { id, category: "electricity", filename: "el.pdf", asset: asset(id), importedAt: "2026-09-29T00:00:00.000Z", parserVersion: "v1", parseStatus: "ok", standsFound: 1, servicesFound: 1, warnings: [] };
  return mergeTechnicalRasterImportWithDiff(project, record, { category: "electricity", rows: [{ standNumber: "3A20", services: [{ category: "electricity", externalLabel: "Do 3kW 230V", quantity, rawValue: String(quantity), sourcePage: 1 }], notes: [] }], warnings: [] }, () => ({ status: "unresolved_product" as const }), replace).project;
}

test("REIMPORT keeps manual drawings untouched (not deleted, not moved, never turned into services)", () => {
  let project = importElectricity(baseProject(), "imp-1", 1);
  const drawings = [mkPoint(1, 0.4, 0.4, "electricity", "medium", "p"), mkLine(1, { x: 0.1, y: 0.1 }, { x: 0.3, y: 0.5 }, "internet", "thick", "l")];
  for (const drawing of drawings) project = withManualDrawingAdded(project, drawing);
  const servicesBefore = project.stands.flatMap((stand) => stand.services).length;
  project = importElectricity(project, "imp-2", 2, "imp-1");
  project = importElectricity(project, "imp-3", 1, "imp-2");
  assert.deepEqual(effectiveManualDrawings(project), drawings);
  assert.equal(project.stands.flatMap((stand) => stand.services).length, servicesBefore, "no service created from a drawing");
});

test("MODES: adding/moving/removing drawings never touches stands, services or their placements", () => {
  let project = importElectricity(baseProject(), "imp-1", 1);
  const stand = project.stands[0]!;
  project = placeTechnicalService(project, stand.id, stand.services[0]!.id, { page: 1, xNormalized: 0.3, yNormalized: 0.3 });
  const standsBefore = project.stands;
  project = withManualDrawingAdded(project, mkPoint(1, 0.3, 0.3, "electricity", "medium", "same-spot"));
  project = withManualDrawingMoved(project, "same-spot", 0.1, 0);
  project = withManualDrawingStyle(project, "same-spot", { category: "internet" });
  project = withManualDrawingRemoved(project, "same-spot");
  assert.equal(project.stands, standsBefore, "stands array is the very same object");
});

test("MODES (editor wiring): tools and service work are mutually exclusive; service symbols clickable only with drawing off", async () => {
  const editor = await readFile(new URL("../components/workflow/technicalRasters/TechnicalRasterEditorPage.tsx", import.meta.url), "utf8");
  const canvas = await readFile(new URL("../components/workflow/technicalRasters/TechnicalRasterCanvas.tsx", import.meta.url), "utf8");
  assert.match(editor, /if \(!placementMode && !assignmentActiveStandId\) return;\s*setDrawingTool\("off"\);/u, "starting a placement/pairing switches drawing off");
  const toolChange = editor.slice(editor.indexOf("function handleDrawingToolChange("), editor.indexOf("function handleDrawingClick("));
  assert.match(toolChange, /setPlacementMode\(undefined\);/u, "turning a tool on cancels an in-progress placement (never deletes placements)");
  assert.ok(!/removeTechnicalServicePlacement|setProject/u.test(toolChange), "switching tools never modifies project data");
  const cancel = editor.slice(editor.indexOf("function handleCancelPlacement()"), editor.indexOf("function handleDrawingToolChange("));
  assert.match(cancel, /setLineDraft\(undefined\);/u, "Escape / cancel clears a pending line");
  assert.match(canvas, /const clickable = Boolean\(onServiceSymbolClick\) && !placementModeActive && drawingTool === "off";/u);
  assert.match(canvas, /if \(drawingTool !== "select" \|\| event\.button !== 0 \|\| viewport\.isSpacePressed\) return;/u, "pan (middle / space+drag) always wins over dragging a drawing");
});

// =========================================================================================
// Export — HOTFIX-02: every manual mark is vector geometry inside the ONE "ABF – TECHNICKÉ ZNAČKY" layer
// (shared with the service markers), a visible note is a real PDF text object.
// =========================================================================================

async function buildSource(options: Readonly<{ rotate?: number; pages?: number }> = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < (options.pages ?? 1); index += 1) {
    const page = doc.addPage([400, 300]);
    if (options.rotate) page.setRotation(degrees(options.rotate));
    page.drawText(`STRANA ${index + 1}`, { x: 20, y: 150, size: 12, font, color: rgb(0, 0, 0) });
  }
  return doc.save();
}

async function pageContent(bytes: Uint8Array, pageIndex: number): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const contents = doc.getPage(pageIndex).node.Contents();
  const streams = contents instanceof PDFArray ? Array.from({ length: contents.size() }, (_, index) => doc.context.lookup(contents.get(index))) : [contents];
  return streams.map((stream) => (stream instanceof PDFRawStream ? new TextDecoder("latin1").decode(decodePDFRawStream(stream).decode()) : "")).join("\n");
}

/** The "ABF – TECHNICKÉ ZNAČKY" marked-content block of a page, plus every stroked segment (m … l), stroke color (RG), fill color (rg), line width (w) and real text show (Tj) in it. */
async function technicalLayerBlock(bytes: Uint8Array, pageIndex: number) {
  const doc = await PDFDocument.load(bytes);
  const properties = (doc.getPage(pageIndex).node.lookup(PDFName.of("Resources")) as PDFDict).lookup(PDFName.of("Properties")) as PDFDict | undefined;
  const key = properties?.keys().find((candidate) => {
    const ocg = doc.context.lookup(properties.get(candidate));
    const name = ocg instanceof PDFDict ? ocg.lookup(PDFName.of("Name")) : undefined;
    return (name instanceof PDFString || name instanceof PDFHexString) && name.decodeText() === "ABF – TECHNICKÉ ZNAČKY";
  });
  if (!key) return undefined;
  const content = await pageContent(bytes, pageIndex);
  // The LAST bracket for the layer = the export's own one (a real raster can already have its own content in the same layer earlier in the stream).
  const start = content.lastIndexOf(`/OC ${key.toString()} BDC`);
  if (start < 0) return undefined;
  const block = content.slice(start, content.indexOf("EMC", start));
  const number = String.raw`(-?\d+(?:\.\d+)?)`;
  const segments = [...block.matchAll(new RegExp(`${number} ${number} m\\s+${number} ${number} l`, "gu"))].map((match) => match.slice(1, 5).map(Number));
  const colors = [...block.matchAll(new RegExp(`${number} ${number} ${number} RG`, "gu"))].map((match) => match.slice(1, 4).map(Number));
  const fills = [...block.matchAll(new RegExp(`${number} ${number} ${number} rg`, "gu"))].map((match) => match.slice(1, 4).map(Number));
  const widths = [...block.matchAll(new RegExp(`${number} w`, "gu"))].map((match) => Number(match[1]));
  const textShows = (block.match(/\bTj\b/gu) ?? []).length;
  return { block, segments, colors, fills, widths, textShows };
}

async function viewerLayers(bytes: Uint8Array): Promise<Map<string, boolean>> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjsLib.getDocument({ data: new Uint8Array(bytes) });
  const doc = await task.promise;
  const config = await doc.getOptionalContentConfig();
  const result = new Map<string, boolean>();
  for (const [, group] of config as unknown as Iterable<[string, { name: string; visible: boolean }]>) result.set(group.name, group.visible);
  await task.destroy();
  return result;
}

async function viewerText(bytes: Uint8Array, pageNumber = 1): Promise<string[]> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjsLib.getDocument({ data: new Uint8Array(bytes) });
  const doc = await task.promise;
  const content = await (await doc.getPage(pageNumber)).getTextContent();
  await task.destroy();
  return (content.items as { str?: string }[]).map((item) => item.str ?? "").filter(Boolean);
}

function hexToFractions(hex: string): number[] {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
}

function near(a: readonly number[], b: readonly number[], tolerance = 0.02): boolean {
  return a.length === b.length && a.every((value, index) => Math.abs(value - b[index]!) <= tolerance);
}

/** An older point as stored before HOTFIX-02 (no shape -> the original "+" cross). */
function legacyPlusPoint(page: number, x: number, y: number, color: string, id: string): TechnicalRasterDrawing {
  return normalizeManualDrawings([{ id, type: "point", page, x, y, color, size: "medium" }])[0]!;
}

for (const rotate of [0, 90]) {
  test(`EXPORT (page rotation ${rotate}°): older "+" point = two strokes crossing at its position, × point = two diagonals, line = one stroke A->B — all in the ON "ABF – TECHNICKÉ ZNAČKY" layer`, async () => {
    const source = await buildSource({ rotate });
    const geometry = await resolveSourcePageGeometry(source, 1);
    const plus = legacyPlusPoint(1, 0.25, 0.4, RED, "p");
    const cross = mkPoint(1, 0.6, 0.6, "neutral", "medium", "x", "cross");
    const ln = mkLine(1, { x: 0.1, y: 0.8 }, { x: 0.9, y: 0.2 }, "internet", "thick", "l");
    const { bytes, technicalLayerStatus } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X", manualDrawings: buildManualDrawingExportItems([plus, cross, ln], 1) });
    assert.equal(technicalLayerStatus, "created", "a source without the layer gets one new ABF – TECHNICKÉ ZNAČKY layer");

    const block = await technicalLayerBlock(bytes, 0);
    assert.ok(block, "ABF – TECHNICKÉ ZNAČKY layer exists on the page");
    const raw = (x: number, y: number) => { const p = normalizedDisplayPointToRawPdfPoint(x, y, geometry.displayWidthPt, geometry.displayHeightPt, geometry.viewportTransform); return [p.x, p.y]; };
    const center = raw(0.25, 0.4);
    const half = DRAWING_SIZES.medium.crossHalfPt;
    assert.ok(block!.segments.some((segment) => near(segment, [center[0]! - half, center[1]!, center[0]! + half, center[1]!])), "horizontal stroke of the older + cross");
    assert.ok(block!.segments.some((segment) => near(segment, [center[0]!, center[1]! - half, center[0]!, center[1]! + half])), "vertical stroke of the older + cross");
    const crossCenter = raw(0.6, 0.6);
    const d = half * Math.SQRT1_2;
    assert.ok(block!.segments.some((segment) => near(segment, [crossCenter[0]! - d, crossCenter[1]! - d, crossCenter[0]! + d, crossCenter[1]! + d])), "first diagonal of ×");
    assert.ok(block!.segments.some((segment) => near(segment, [crossCenter[0]! - d, crossCenter[1]! + d, crossCenter[0]! + d, crossCenter[1]! - d])), "second diagonal of ×");
    assert.ok(block!.segments.some((segment) => near(segment, [...raw(0.1, 0.8), ...raw(0.9, 0.2)])), "the line runs from A to B");
    assert.ok(block!.colors.some((color) => near(color, hexToFractions(RED))), "red (older) point");
    assert.ok(block!.colors.some((color) => near(color, hexToFractions(TECHNICAL_RASTER_COLORS.neutral))), "neutral black ×");
    assert.ok(block!.colors.some((color) => near(color, hexToFractions(BLUE))), "internet-gold line");
    assert.ok(block!.widths.includes(DRAWING_SIZES.thick.strokePt), "thick line width");
    const layers = await viewerLayers(bytes);
    assert.equal(layers.get("ABF – TECHNICKÉ ZNAČKY"), true);
    assert.equal(layers.has("RUČNÍ ZNAČKY"), false, "manual marks never get a separate layer any more");
    assert.equal(layers.has("GENERÁTOR DATA"), false, "no empty generator layer when there is nothing else to put in it");
  });
}

test("EXPORT: a dot ● is a filled vector circle in the category color, centered on the point", async () => {
  const source = await buildSource();
  const geometry = await resolveSourcePageGeometry(source, 1);
  const { bytes } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X", manualDrawings: buildManualDrawingExportItems([mkPoint(1, 0.5, 0.5, "waste", "thick", "d")], 1) });
  const block = await technicalLayerBlock(bytes, 0);
  assert.ok(block!.fills.some((color) => near(color, hexToFractions(TECHNICAL_RASTER_COLORS.waste))), "waste-brown fill");
  const center = normalizedDisplayPointToRawPdfPoint(0.5, 0.5, geometry.displayWidthPt, geometry.displayHeightPt, geometry.viewportTransform);
  const r = DRAWING_SIZES.thick.dotRadiusPt;
  const circleStart = /(-?[\d.]+) (-?[\d.]+) m((?: -?[\d.]+){6} c){4} f/u.exec(block!.block);
  assert.ok(circleStart, "a closed path of 4 Bézier curves, filled");
  assert.ok(Math.abs(Number(circleStart![1]) - (center.x + r)) < 0.01 && Math.abs(Number(circleStart![2]) - center.y) < 0.01, "starting at the circle's right edge -> centered on the point");
  assert.equal(block!.segments.length, 0, "a dot has no strokes");
});

test("EXPORT notes: a VISIBLE note is a real, extractable PDF text object (Czech + ³) in ABF – TECHNICKÉ ZNAČKY; an INTERNAL note is not in the PDF at all", async () => {
  let project = withManualDrawingAdded(baseProject(), mkPoint(1, 0.3, 0.3, "electricity", "medium", "visible"));
  project = withManualDrawingAdded(project, mkLine(1, { x: 0.5, y: 0.5 }, { x: 0.8, y: 0.5 }, "water", "medium", "line"));
  project = withManualDrawingAdded(project, mkPoint(1, 0.7, 0.7, "neutral", "medium", "internal", "cross"));
  project = withManualDrawingNote(project, "visible", { text: "Přívod elektřiny ze stropu", visible: true });
  project = withManualDrawingNote(project, "line", { text: "Odpad 3 m³", visible: true });
  project = withManualDrawingNote(project, "internal", { text: "TAJNÁ interní poznámka" });
  const { bytes } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: await buildSource(), page: 1, placements: [], legend: [], showLegend: false, headerLine: "X", manualDrawings: buildManualDrawingExportItems(effectiveManualDrawings(project), 1) });
  const text = await viewerText(bytes);
  assert.ok(text.includes("Přívod elektřiny ze stropu"), `visible note extractable as text, got ${JSON.stringify(text)}`);
  assert.ok(text.includes("Odpad 3 m³"), "³ survives");
  assert.ok(!text.some((item) => item.includes("TAJNÁ")), "internal note never exported");
  const block = await technicalLayerBlock(bytes, 0);
  assert.equal(block!.textShows, 2, "both visible notes are text shows INSIDE the technical layer");
  assert.ok(block!.fills.some((color) => near(color, hexToFractions(RED))), "note in its mark's color");
});

test("EXPORT notes in the 'outlines' fallback: the visible note becomes vector geometry, no text object", async () => {
  let project = withManualDrawingAdded(baseProject(), mkPoint(1, 0.3, 0.3, "electricity", "medium", "visible"));
  project = withManualDrawingNote(project, "visible", { text: "Přívod ze stropu", visible: true });
  const { bytes, textMode } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: await buildSource(), page: 1, placements: [], legend: [], showLegend: false, headerLine: "X", manualDrawings: buildManualDrawingExportItems(effectiveManualDrawings(project), 1), textMode: "outlines" });
  assert.equal(textMode, "outlines");
  const block = await technicalLayerBlock(bytes, 0);
  assert.equal(block!.textShows, 0);
  assert.ok(!(await viewerText(bytes)).some((item) => item.includes("Přívod")));
});

test("EXPORT without drawings: no ABF – TECHNICKÉ ZNAČKY or RUČNÍ ZNAČKY layer at all (existing exports unchanged)", async () => {
  const layers = await viewerLayers((await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: await buildSource(), page: 1, placements: [], legend: [], showLegend: false, headerLine: "X" })).bytes);
  assert.equal(layers.has("RUČNÍ ZNAČKY"), false);
  assert.equal(layers.has("ABF – TECHNICKÉ ZNAČKY"), false);
});

test("EXPORT multi-page: each drawing lands on its own page; ONE shared ABF – TECHNICKÉ ZNAČKY layer", async () => {
  const drawings = [mkPoint(2, 0.5, 0.5, "water", "thin", "p2", "cross"), mkLine(1, { x: 0.2, y: 0.2 }, { x: 0.4, y: 0.4 }, "electricity", "medium", "l1")];
  const { bytes } = await buildTechnicalRasterMultiPageVectorExportPdf({
    sourcePdfBytes: await buildSource({ pages: 3 }),
    pages: [1, 2, 3].map((page) => ({ page, placements: [], manualDrawings: buildManualDrawingExportItems(drawings, page) })),
    legend: [],
    showLegend: false,
    headerLine: "X",
  });
  const [page1, page2, page3] = await Promise.all([0, 1, 2].map((index) => technicalLayerBlock(bytes, index)));
  assert.equal(page1!.segments.length, 1, "line on page 1");
  assert.equal(page2!.segments.length, 2, "point (cross) on page 2");
  assert.equal(page3, undefined, "no drawings on page 3");
  const layers = await viewerLayers(bytes);
  assert.equal(layers.get("ABF – TECHNICKÉ ZNAČKY"), true);
  assert.equal([...layers.keys()].filter((name) => name === "ABF – TECHNICKÉ ZNAČKY").length, 1);
});

// Real hall rasters — skip-safe (gitignored _IMPORT/ customer files). Both carry their OWN
// "TECHNICKÉ SLUŽBY" layer: it must stay untouched; our marks go into ONE new "ABF – TECHNICKÉ ZNAČKY".
for (const file of ["Hala 1.pdf", "Hala 3_2026- ver.12_NOVY_3.pdf"]) {
  const filePath = new URL(`../_IMPORT/${file}`, import.meta.url);
  test(`REAL ${file}: manual marks + visible note go into ONE new "ABF – TECHNICKÉ ZNAČKY" layer, appended after every untouched source layer`, { skip: !existsSync(filePath) }, async () => {
    const source = new Uint8Array(await readFile(filePath));
    const sourceLayers = await viewerLayers(source);
    const geometry = await resolveSourcePageGeometry(source, 1);
    const ln = mkLine(1, { x: 0.3, y: 0.3 }, { x: 0.6, y: 0.5 }, "water", "medium", "l");
    const pt = { ...mkPoint(1, 0.5, 0.5, "electricity", "medium", "p"), note: { text: "Přívod elektřiny ze stropu", visible: true } };
    const { bytes, technicalLayerStatus } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X", manualDrawings: buildManualDrawingExportItems([pt, ln], 1) });
    assert.equal(technicalLayerStatus, "created");
    const block = await technicalLayerBlock(bytes, 0);
    const a = normalizedDisplayPointToRawPdfPoint(0.3, 0.3, geometry.displayWidthPt, geometry.displayHeightPt, geometry.viewportTransform);
    const b = normalizedDisplayPointToRawPdfPoint(0.6, 0.5, geometry.displayWidthPt, geometry.displayHeightPt, geometry.viewportTransform);
    assert.ok(block!.segments.some((segment) => near(segment, [a.x, a.y, b.x, b.y])));
    assert.ok(block!.colors.some((color) => near(color, hexToFractions(GREEN))));
    assert.ok((await viewerText(bytes)).includes("Přívod elektřiny ze stropu"));
    const layers = await viewerLayers(bytes);
    assert.deepEqual([...layers.keys()], [...sourceLayers.keys(), "ABF – TECHNICKÉ ZNAČKY"], "every source layer in its order, then exactly one layer of ours");
    for (const [name, visible] of sourceLayers) assert.equal(layers.get(name), visible, `${name} keeps its state`);
    assert.equal(layers.get("ABF – TECHNICKÉ ZNAČKY"), true);
  });
}
