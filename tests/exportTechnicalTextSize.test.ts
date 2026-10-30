import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { buildTechnicalRasterVectorExportPdf } from "../lib/technicalRasterVectorPdf.ts";
import { buildManualDrawingExportItems, createLineDrawing, createPointDrawing, createTextDrawing, withManualDrawingNote, type TechnicalRasterDrawing } from "../domain/technicalRasterDrawings.ts";
import type { TechnicalRasterExportLegendEntry, TechnicalRasterExportPlacementItem } from "../domain/technicalRasterExport.ts";
import {
  EXPORT_STAR_SYMBOL_FONT_SIZE_PT,
  EXPORT_TECHNICAL_TEXT_FONT_SIZE_PT,
  EXPORT_WATER_DROP_HEIGHT_PT,
  EXPORT_WIFI_SYMBOL_WIDTH_PT,
} from "../domain/technicalRasterExportSymbolSize.ts";
import { DRAWING_SIZES } from "../domain/technicalRasterDrawings.ts";
import { SYMBOL_TEXT_FONT_SIZE_TARGET_PX } from "../domain/technicalRasterSymbolMarker.ts";
import { resolveTechnicalServicePresentation } from "../domain/technicalRasterServicePresentation.ts";

// Every technical text in the PDF export — service/power labels, manual free texts and visible mark
// notes — is exactly 2pt. Measured as the EFFECTIVE size pdf.js reports (Tf × text matrix × CTM),
// not just the Tf operand, so a scaled overlay could never fake it.

async function buildSource(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("ZDROJ 14", { x: 20, y: 150, size: 14, font, color: rgb(0, 0, 0) });
  return doc.save();
}

function placement(id: string, category: string, label: string, x: number): TechnicalRasterExportPlacementItem {
  return { standId: `s-${id}`, standNumber: "1A01", serviceId: `svc-${id}`, placementId: id, xNormalized: x, yNormalized: 0.3, presentation: resolveTechnicalServicePresentation(category, label), category };
}

const SERVICE_LABELS: readonly (readonly [string, string, string])[] = [
  ["electricity", "Do 2kW 230V", "2 kW"],
  ["electricity", "Do 5kW 230V", "5 kW"],
  ["electricity", "Lednicový okruh", "LED"],
  ["electricity", "Rozvaděč 9-21kW", "El.rozvaděč"],
  ["water", "Voda", "Voda"],
  ["internet", "Router zapůjčení", "Router"],
];

function drawings(): TechnicalRasterDrawing[] {
  const texts = (["thin", "medium", "thick"] as const).map((size, index) => createTextDrawing(1, 0.1 + index * 0.25, 0.6, { category: "water", size }, `Přípojka ${size} 3 m³`, `t-${size}`));
  const point = createPointDrawing(1, 0.2, 0.8, { category: "electricity", size: "thick", pointStyle: "dot" }, "p");
  const line = createLineDrawing(1, { x: 0.5, y: 0.8 }, { x: 0.8, y: 0.8 }, { category: "neutral", size: "thick" }, "l");
  const project = { manualDrawings: [...texts, point, line] } as unknown as Parameters<typeof withManualDrawingNote>[0];
  let next = withManualDrawingNote(project, "p", { text: "Přívod ze stropu ³", visible: true });
  next = withManualDrawingNote(next, "l", { text: "Kabel žlutý 5 m", visible: true });
  return [...(next.manualDrawings ?? [])];
}

const LEGEND: readonly TechnicalRasterExportLegendEntry[] = [{ legendLabel: "ELEKTŘINA", color: "#b3261e", key: "category:electricity" }];

async function textItems(bytes: Uint8Array): Promise<{ str: string; size: number }[]> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjsLib.getDocument({ data: new Uint8Array(bytes) });
  const doc = await task.promise;
  const items: { str: string; size: number }[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const content = await (await doc.getPage(pageNumber)).getTextContent();
    for (const item of content.items as { str?: string; transform?: number[] }[]) {
      if (!item.str || !item.transform) continue;
      items.push({ str: item.str, size: Math.hypot(item.transform[2]!, item.transform[3]!) });
    }
  }
  await task.destroy();
  return items;
}

test("EXPORT TEXT SIZE: the central constant is exactly 2pt and every manual text preset / visible note exports at it", () => {
  assert.equal(EXPORT_TECHNICAL_TEXT_FONT_SIZE_PT, 2);
  const items = buildManualDrawingExportItems(drawings(), 1);
  const sizes = items.flatMap((item) => (item.kind === "text" ? [item.fontSizePt] : item.note ? [item.note.fontSizePt] : []));
  assert.deepEqual(sizes, [2, 2, 2, 2, 2], "three text presets + two visible notes");
});

test("EXPORT TEXT SIZE: in the real PDF every service label, free text and visible note is editable text at an effective 2pt; source text and legend keep their sizes", async () => {
  const placements = SERVICE_LABELS.map(([category, label], index) => placement(`p${index}`, category, label, 0.1 + index * 0.14));
  const { bytes, textMode } = await buildTechnicalRasterVectorExportPdf({
    sourcePdfBytes: await buildSource(), page: 1, placements, legend: LEGEND, showLegend: true, headerLine: "Hlavička", manualDrawings: buildManualDrawingExportItems(drawings(), 1),
  });
  assert.equal(textMode, "text", "real editable text (CorelDRAW), not the outlines fallback");
  const items = await textItems(bytes);
  const sizeOf = (text: string) => {
    const found = items.filter((item) => item.str === text);
    assert.ok(found.length > 0, `"${text}" is real extractable text — got ${JSON.stringify(items.map((item) => item.str))}`);
    return found.map((item) => item.size);
  };
  const technical = [...SERVICE_LABELS.map(([, , text]) => text), "Přípojka thin 3 m³", "Přípojka medium 3 m³", "Přípojka thick 3 m³", "Přívod ze stropu ³", "Kabel žlutý 5 m"];
  for (const text of technical) {
    for (const size of sizeOf(text)) assert.ok(Math.abs(size - 2) < 1e-6, `"${text}" must be exactly 2pt, got ${size}pt`);
  }
  for (const size of sizeOf("ZDROJ 14")) assert.ok(Math.abs(size - 14) < 1e-6, "the source PDF's own text is untouched");
  for (const size of sizeOf("ELEKTŘINA")) assert.ok(size > 2.5, `the legend keeps its own size, got ${size}pt`);
});

test("EXPORT TEXT SIZE: graphic symbols, editor sizes and stroke/dot sizes are unchanged", () => {
  assert.deepEqual([EXPORT_STAR_SYMBOL_FONT_SIZE_PT, EXPORT_WATER_DROP_HEIGHT_PT, EXPORT_WIFI_SYMBOL_WIDTH_PT], [3.49, 2.8, 2.98]);
  assert.equal(SYMBOL_TEXT_FONT_SIZE_TARGET_PX, 10.5);
  assert.deepEqual(
    Object.values(DRAWING_SIZES).map(({ strokeScreenPx, crossHalfScreenPx, dotRadiusScreenPx, textScreenPx, strokePt, crossHalfPt, dotRadiusPt }) => [strokeScreenPx, crossHalfScreenPx, dotRadiusScreenPx, textScreenPx, strokePt, crossHalfPt, dotRadiusPt]),
    [[1.5, 6, 3, 11, 0.75, 3, 1.2], [3, 8, 4.5, 15, 1.5, 4, 1.8], [5, 10, 6, 20, 3, 5, 2.6]],
  );
});
