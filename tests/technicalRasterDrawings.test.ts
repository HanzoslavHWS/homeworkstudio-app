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
  DRAWING_COLORS,
  DRAWING_SIZES,
  effectiveManualDrawings,
  isDegenerateLine,
  moveManualDrawing,
  normalizeManualDrawings,
  withManualDrawingAdded,
  withManualDrawingMoved,
  withManualDrawingRemoved,
  withManualDrawingStyle,
} from "../domain/technicalRasterDrawings.ts";
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
// RUČNÍ ZNAČKY — manual points ("Bod") and lines A–B ("Čára"): a separate project layer
// (project.manualDrawings), same normalized page space as placements, own PDF export layer.
// =========================================================================================

const RED = DRAWING_COLORS.find((color) => color.id === "red")!.hex;
const BLUE = DRAWING_COLORS.find((color) => color.id === "blue")!.hex;
const GREEN = DRAWING_COLORS.find((color) => color.id === "green")!.hex;

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
  const point = createPointDrawing(1, 0.25, 0.75, BLUE, "thick", "pt-1");
  const reloaded = saveAndReload(withManualDrawingAdded(baseProject(), point));
  assert.deepEqual(effectiveManualDrawings(reloaded), [point]);
});

test("SAVE + RELOAD: a line survives the real repository mapping (A, B, page, color, width)", () => {
  const line = createLineDrawing(2, { x: 0.1, y: 0.2 }, { x: 0.8, y: 0.6 }, GREEN, "thin", "ln-1");
  const reloaded = saveAndReload(withManualDrawingAdded(baseProject(), line));
  assert.deepEqual(effectiveManualDrawings(reloaded), [line]);
});

test("COLOR is kept exactly; restyling the selected drawing changes only its color/size", () => {
  let project = withManualDrawingAdded(baseProject(), createPointDrawing(1, 0.5, 0.5, RED, "medium", "a"));
  project = withManualDrawingAdded(project, createLineDrawing(1, { x: 0, y: 0 }, { x: 1, y: 1 }, RED, "medium", "b"));
  project = withManualDrawingStyle(project, "b", { color: BLUE, size: "thick" });
  const [a, b] = effectiveManualDrawings(saveAndReload(project));
  assert.equal(a!.color, RED);
  assert.equal(b!.color, BLUE);
  assert.equal(b!.type === "line" && b!.width, "thick");
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

test("DELETE point: only that point disappears", () => {
  let project = withManualDrawingAdded(baseProject(), createPointDrawing(1, 0.1, 0.1, RED, "medium", "a"));
  project = withManualDrawingAdded(project, createPointDrawing(1, 0.2, 0.2, RED, "medium", "b"));
  assert.deepEqual(effectiveManualDrawings(withManualDrawingRemoved(project, "a")).map((drawing) => drawing.id), ["b"]);
  assert.equal(withManualDrawingRemoved(project, "missing"), project, "unknown id is a no-op");
});

test("DELETE line: only that line disappears", () => {
  let project = withManualDrawingAdded(baseProject(), createLineDrawing(1, { x: 0, y: 0 }, { x: 1, y: 1 }, RED, "medium", "line"));
  project = withManualDrawingAdded(project, createPointDrawing(1, 0.2, 0.2, RED, "medium", "point"));
  assert.deepEqual(effectiveManualDrawings(saveAndReload(withManualDrawingRemoved(project, "line"))).map((drawing) => drawing.id), ["point"]);
});

test("MOVE: a point moves (clamped to the page); a whole line moves keeping its exact shape, stopping at the page edge", () => {
  const point = createPointDrawing(1, 0.5, 0.5, RED, "medium", "p");
  assert.deepEqual(moveManualDrawing(point, 0.1, -0.2), { ...point, x: 0.6, y: 0.3 });
  assert.deepEqual(moveManualDrawing(point, 0.9, 0.9), { ...point, x: 1, y: 1 });
  const line = createLineDrawing(1, { x: 0.2, y: 0.2 }, { x: 0.6, y: 0.4 }, RED, "medium", "l");
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
  const drawings = [createPointDrawing(1, 0.4, 0.4, RED, "medium", "p"), createLineDrawing(1, { x: 0.1, y: 0.1 }, { x: 0.3, y: 0.5 }, BLUE, "thick", "l")];
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
  project = withManualDrawingAdded(project, createPointDrawing(1, 0.3, 0.3, RED, "medium", "same-spot"));
  project = withManualDrawingMoved(project, "same-spot", 0.1, 0);
  project = withManualDrawingStyle(project, "same-spot", { color: BLUE });
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
// Export
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
  return streams.map((stream) => (stream instanceof PDFRawStream ? new TextDecoder().decode(decodePDFRawStream(stream).decode()) : "")).join("\n");
}

/** The "RUČNÍ ZNAČKY" marked-content block of a page, plus every stroked segment (m … l) and stroke color (RG) in it. */
async function manualLayerBlock(bytes: Uint8Array, pageIndex: number) {
  const doc = await PDFDocument.load(bytes);
  const properties = (doc.getPage(pageIndex).node.lookup(PDFName.of("Resources")) as PDFDict).lookup(PDFName.of("Properties")) as PDFDict | undefined;
  const key = properties?.keys().find((candidate) => {
    const ocg = doc.context.lookup(properties.get(candidate));
    const name = ocg instanceof PDFDict ? ocg.lookup(PDFName.of("Name")) : undefined;
    return (name instanceof PDFString || name instanceof PDFHexString) && name.decodeText() === "RUČNÍ ZNAČKY";
  });
  if (!key) return undefined;
  const content = await pageContent(bytes, pageIndex);
  const start = content.indexOf(`/OC ${key.toString()} BDC`);
  const block = content.slice(start, content.indexOf("EMC", start));
  const number = String.raw`(-?\d+(?:\.\d+)?)`;
  const segments = [...block.matchAll(new RegExp(`${number} ${number} m\\s+${number} ${number} l`, "gu"))].map((match) => match.slice(1, 5).map(Number));
  const colors = [...block.matchAll(new RegExp(`${number} ${number} ${number} RG`, "gu"))].map((match) => match.slice(1, 4).map(Number));
  const widths = [...block.matchAll(new RegExp(`${number} w`, "gu"))].map((match) => Number(match[1]));
  return { segments, colors, widths };
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

function hexToFractions(hex: string): number[] {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
}

function near(a: readonly number[], b: readonly number[], tolerance = 0.02): boolean {
  return a.length === b.length && a.every((value, index) => Math.abs(value - b[index]!) <= tolerance);
}

for (const rotate of [0, 90]) {
  test(`EXPORT (page rotation ${rotate}°): point = two colored strokes crossing at its position, line = one stroke A->B, in their own ON "RUČNÍ ZNAČKY" layer`, async () => {
    const source = await buildSource({ rotate });
    const geometry = await resolveSourcePageGeometry(source, 1);
    const point = createPointDrawing(1, 0.25, 0.4, RED, "medium", "p");
    const line = createLineDrawing(1, { x: 0.1, y: 0.8 }, { x: 0.9, y: 0.2 }, BLUE, "thick", "l");
    const { bytes } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X", manualDrawings: buildManualDrawingExportItems([point, line], 1) });

    const block = await manualLayerBlock(bytes, 0);
    assert.ok(block, "RUČNÍ ZNAČKY layer exists on the page");
    const raw = (x: number, y: number) => { const p = normalizedDisplayPointToRawPdfPoint(x, y, geometry.displayWidthPt, geometry.displayHeightPt, geometry.viewportTransform); return [p.x, p.y]; };
    const center = raw(0.25, 0.4);
    const half = DRAWING_SIZES.medium.crossHalfPt;
    assert.ok(block!.segments.some((segment) => near(segment, [center[0]! - half, center[1]!, center[0]! + half, center[1]!])), "horizontal stroke of the cross");
    assert.ok(block!.segments.some((segment) => near(segment, [center[0]!, center[1]! - half, center[0]!, center[1]! + half])), "vertical stroke of the cross");
    assert.ok(block!.segments.some((segment) => near(segment, [...raw(0.1, 0.8), ...raw(0.9, 0.2)])), "the line runs from A to B");
    assert.ok(block!.colors.some((color) => near(color, hexToFractions(RED))), "red point");
    assert.ok(block!.colors.some((color) => near(color, hexToFractions(BLUE))), "blue line");
    assert.ok(block!.widths.includes(DRAWING_SIZES.thick.strokePt), "thick line width");
    const layers = await viewerLayers(bytes);
    assert.equal(layers.get("RUČNÍ ZNAČKY"), true);
    assert.equal(layers.get("GENERÁTOR DATA"), true, "generated data layer untouched");
  });
}

test("EXPORT without drawings: no RUČNÍ ZNAČKY layer at all (existing exports unchanged)", async () => {
  const { bytes } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: await buildSource(), page: 1, placements: [], legend: [], showLegend: false, headerLine: "X" });
  assert.equal((await viewerLayers(bytes)).has("RUČNÍ ZNAČKY"), false);
});

test("EXPORT multi-page: each drawing lands on its own page; one shared RUČNÍ ZNAČKY layer", async () => {
  const drawings = [createPointDrawing(2, 0.5, 0.5, GREEN, "thin", "p2"), createLineDrawing(1, { x: 0.2, y: 0.2 }, { x: 0.4, y: 0.4 }, RED, "medium", "l1")];
  const { bytes } = await buildTechnicalRasterMultiPageVectorExportPdf({
    sourcePdfBytes: await buildSource({ pages: 3 }),
    pages: [1, 2, 3].map((page) => ({ page, placements: [], manualDrawings: buildManualDrawingExportItems(drawings, page) })),
    legend: [],
    showLegend: false,
    headerLine: "X",
  });
  const [page1, page2, page3] = await Promise.all([0, 1, 2].map((index) => manualLayerBlock(bytes, index)));
  assert.equal(page1!.segments.length, 1, "line on page 1");
  assert.equal(page2!.segments.length, 2, "point (cross) on page 2");
  assert.equal(page3, undefined, "no drawings on page 3");
  assert.equal((await viewerLayers(bytes)).get("RUČNÍ ZNAČKY"), true);
});

// Real hall rasters — skip-safe (gitignored _IMPORT/ customer files).
for (const file of ["Hala 1.pdf", "Hala 3_2026- ver.12_NOVY_3.pdf"]) {
  const filePath = new URL(`../_IMPORT/${file}`, import.meta.url);
  test(`REAL ${file}: a point and a line export at the right place and color`, { skip: !existsSync(filePath) }, async () => {
    const source = new Uint8Array(await readFile(filePath));
    const geometry = await resolveSourcePageGeometry(source, 1);
    const line = createLineDrawing(1, { x: 0.3, y: 0.3 }, { x: 0.6, y: 0.5 }, GREEN, "medium", "l");
    const { bytes } = await buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X", manualDrawings: buildManualDrawingExportItems([createPointDrawing(1, 0.5, 0.5, RED, "medium", "p"), line], 1) });
    const block = await manualLayerBlock(bytes, 0);
    const a = normalizedDisplayPointToRawPdfPoint(0.3, 0.3, geometry.displayWidthPt, geometry.displayHeightPt, geometry.viewportTransform);
    const b = normalizedDisplayPointToRawPdfPoint(0.6, 0.5, geometry.displayWidthPt, geometry.displayHeightPt, geometry.viewportTransform);
    assert.ok(block!.segments.some((segment) => near(segment, [a.x, a.y, b.x, b.y])));
    assert.ok(block!.colors.some((color) => near(color, hexToFractions(GREEN))));
    assert.equal((await viewerLayers(bytes)).get("RUČNÍ ZNAČKY"), true);
  });
}
