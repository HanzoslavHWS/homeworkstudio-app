/**
 * Technické rastry — MANUAL technical drawings: a free point ("Bod" — a dot ● or a cross ×), a
 * straight line A–B ("Čára") and a free text ("Text", real editable text in the PDF). A completely separate layer of project data
 * (`TechnicalRasterProject.manualDrawings`): never a service, never a placement, never touched by a
 * report (re-)import, no link/snapping to service markers.
 *
 * Coordinates use the SAME space as service placements: the page number plus x/y normalized to the
 * displayed page (0–1, rotation-aware display space). The editor multiplies them by the stage size,
 * the PDF export converts them with normalizedDisplayPointToRawPdfPoint — so they line up at any
 * zoom, after reload, and in the export.
 *
 * HOTFIX-02 (phases 3/4):
 *   - a drawing has a technical COLOR CATEGORY (electricity/internet/water/cleaning/waste/neutral)
 *     whose color comes from the same TECHNICAL_RASTER_COLORS the services use — no second palette;
 *   - a point has a shape: "dot" ● or "cross" ×;
 *   - every drawing may carry a note; `visible: false` = internal (project + detail only, never drawn,
 *     never exported), `visible: true` = drawn next to the mark in the editor AND exported to the PDF
 *     as a real text object. The note's position is derived from its mark, so moving the mark moves
 *     the note.
 * Older drawings (saved before HOTFIX-02) have no category/shape/note: they keep their stored color
 * and their original "+" cross, nothing in the stored data is rewritten. Picking a category or shape
 * for such a drawing upgrades just that drawing.
 */
import type { TechnicalRasterProject } from "./technicalRaster.ts";
import { TECHNICAL_RASTER_COLORS } from "./technicalRasterServicePresentation.ts";

export type DrawingSize = "thin" | "medium" | "thick";

export type DrawingCategory = "electricity" | "internet" | "water" | "cleaning" | "waste" | "neutral";

/** A point's stored shape. Older points have none and keep their original "+" cross (see drawingPointShapeOf). */
export type DrawingPointStyle = "dot" | "cross";
/** What is actually drawn: "plus" = the original pre-HOTFIX-02 cross of an older point. */
export type DrawingPointShape = DrawingPointStyle | "plus";

export type DrawingNote = Readonly<{
  text: string;
  /** false (default) = internal note, true = "Zobrazit poznámku v rastru a PDF". */
  visible: boolean;
}>;

export type TechnicalRasterDrawing =
  | Readonly<{ id: string; type: "point"; page: number; x: number; y: number; color: string; size?: DrawingSize; category?: DrawingCategory; pointStyle?: DrawingPointStyle; note?: DrawingNote }>
  | Readonly<{ id: string; type: "line"; page: number; x1: number; y1: number; x2: number; y2: number; color: string; width?: DrawingSize; category?: DrawingCategory; note?: DrawingNote }>
  /** A free text: (x, y) is its left end, vertically centered; `size` picks the font size. */
  | Readonly<{ id: string; type: "text"; page: number; x: number; y: number; text: string; color: string; size?: DrawingSize; category?: DrawingCategory; note?: DrawingNote }>;

export type TechnicalRasterDrawingTool = "off" | "select" | "point" | "line" | "text";

/** The text a new "Text" object starts with — the user types over it in the detail panel. */
export const DEFAULT_DRAWING_TEXT = "Text";

/** The color categories, in toolbar/legend order — colors straight from the shared technical palette. */
export const DRAWING_CATEGORIES: readonly Readonly<{ id: DrawingCategory; label: string; color: string }>[] = [
  { id: "electricity", label: "Elektřina", color: TECHNICAL_RASTER_COLORS.electricity },
  { id: "internet", label: "Internet / WiFi", color: TECHNICAL_RASTER_COLORS.internet },
  { id: "water", label: "Voda", color: TECHNICAL_RASTER_COLORS.water },
  { id: "cleaning", label: "Úklid", color: TECHNICAL_RASTER_COLORS.cleaning },
  { id: "waste", label: "Odpad", color: TECHNICAL_RASTER_COLORS.waste },
  { id: "neutral", label: "Neutrální", color: TECHNICAL_RASTER_COLORS.neutral },
];

export const DRAWING_POINT_STYLES: readonly Readonly<{ id: DrawingPointStyle; label: string; glyph: string }>[] = [
  { id: "dot", label: "Puntík", glyph: "●" },
  { id: "cross", label: "Křížek", glyph: "×" },
];

export const DEFAULT_DRAWING_CATEGORY: DrawingCategory = "electricity";
export const DEFAULT_DRAWING_POINT_STYLE: DrawingPointStyle = "dot";
export const DEFAULT_DRAWING_SIZE: DrawingSize = "medium";
/** Fallback for a stored drawing whose own color is invalid — the neutral category color. */
export const DEFAULT_DRAWING_COLOR: string = TECHNICAL_RASTER_COLORS.neutral;
export const MAX_DRAWING_NOTE_LENGTH = 200;

/**
 * One preset -> sizes. Editor sizes are SCREEN px (zoom-invariant, divided by zoom at render time,
 * same as every other marker in the editor); export sizes are PDF points.
 */
export const DRAWING_SIZES: Readonly<Record<DrawingSize, Readonly<{ label: string; strokeScreenPx: number; crossHalfScreenPx: number; dotRadiusScreenPx: number; textScreenPx: number; strokePt: number; crossHalfPt: number; dotRadiusPt: number; textPt: number }>>> = {
  thin: { label: "Tenká", strokeScreenPx: 1.5, crossHalfScreenPx: 6, dotRadiusScreenPx: 3, textScreenPx: 11, strokePt: 0.75, crossHalfPt: 3, dotRadiusPt: 1.2, textPt: 2.8 },
  medium: { label: "Střední", strokeScreenPx: 3, crossHalfScreenPx: 8, dotRadiusScreenPx: 4.5, textScreenPx: 15, strokePt: 1.5, crossHalfPt: 4, dotRadiusPt: 1.8, textPt: 4.2 },
  thick: { label: "Silná", strokeScreenPx: 5, crossHalfScreenPx: 10, dotRadiusScreenPx: 6, textScreenPx: 20, strokePt: 3, crossHalfPt: 5, dotRadiusPt: 2.6, textPt: 6 },
};

/** Visible-note text size: screen px in the editor (zoom-invariant), PDF points in the export (= the technical marker text size). */
export const DRAWING_NOTE_SCREEN_PX = 11;
export const DRAWING_NOTE_FONT_SIZE_PT = 2.8;
/** Gap between a mark and its visible note (screen px / PDF points). */
export const DRAWING_NOTE_GAP_SCREEN_PX = 4;
export const DRAWING_NOTE_GAP_PT = 1;

const HEX_COLOR = /^#[0-9a-f]{6}$/iu;
const CATEGORY_IDS: ReadonlySet<string> = new Set(DRAWING_CATEGORIES.map((category) => category.id));

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSize(value: unknown): value is DrawingSize {
  return value === "thin" || value === "medium" || value === "thick";
}

function isCategory(value: unknown): value is DrawingCategory {
  return typeof value === "string" && CATEGORY_IDS.has(value);
}

function isPointStyle(value: unknown): value is DrawingPointStyle {
  return value === "dot" || value === "cross";
}

export function drawingCategoryColor(category: DrawingCategory): string {
  return DRAWING_CATEGORIES.find((entry) => entry.id === category)!.color;
}

/** Single line, no control characters, trimmed, capped — what a note can be. Empty -> undefined. */
export function sanitizeDrawingNoteText(text: string): string | undefined {
  const cleaned = text.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, MAX_DRAWING_NOTE_LENGTH).trim();
  return cleaned || undefined;
}

export function drawingSizeOf(drawing: TechnicalRasterDrawing): DrawingSize {
  return (drawing.type === "line" ? drawing.width : drawing.size) ?? DEFAULT_DRAWING_SIZE;
}

/** The drawing's category; an older drawing without one counts as "neutral" only when it was the old neutral black, otherwise it has none (kept in its own stored color, not explained by the legend). */
export function drawingCategoryOf(drawing: TechnicalRasterDrawing): DrawingCategory | undefined {
  if (drawing.category) return drawing.category;
  return drawing.color.toLowerCase() === TECHNICAL_RASTER_COLORS.neutral ? "neutral" : undefined;
}

/** The color actually drawn: always the category color when there is a category, else the stored (older) color. */
export function drawingColorOf(drawing: TechnicalRasterDrawing): string {
  return drawing.category ? drawingCategoryColor(drawing.category) : drawing.color;
}

export function drawingPointShapeOf(drawing: Extract<TechnicalRasterDrawing, { type: "point" }>): DrawingPointShape {
  return drawing.pointStyle ?? "plus";
}

/** The note, only when it should be drawn (editor + PDF). A text object IS its text — it has no separate note. */
export function visibleDrawingNoteText(drawing: TechnicalRasterDrawing): string | undefined {
  if (drawing.type === "text") return undefined;
  return drawing.note?.visible ? drawing.note.text : undefined;
}

function normalizeNote(value: unknown): DrawingNote | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const text = typeof raw.text === "string" ? sanitizeDrawingNoteText(raw.text) : undefined;
  return text ? { text, visible: raw.visible === true } : undefined;
}

/** Reads persisted/untrusted drawings: drops malformed entries, clamps coordinates into the page, falls back to the default color for an invalid one, keeps only valid category/shape/note fields. Never throws. */
export function normalizeManualDrawings(value: unknown): readonly TechnicalRasterDrawing[] {
  if (!Array.isArray(value)) return [];
  const result: TechnicalRasterDrawing[] = [];
  for (const raw of value as Record<string, unknown>[]) {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !Number.isInteger(raw.page) || (raw.page as number) < 1) continue;
    const color = typeof raw.color === "string" && HEX_COLOR.test(raw.color) ? raw.color : DEFAULT_DRAWING_COLOR;
    const note = normalizeNote(raw.note);
    const common = { ...(isCategory(raw.category) ? { category: raw.category } : {}), ...(note ? { note } : {}) };
    if (raw.type === "point" && isFiniteNumber(raw.x) && isFiniteNumber(raw.y)) {
      result.push({ id: raw.id, type: "point", page: raw.page as number, x: clamp01(raw.x), y: clamp01(raw.y), color, ...(isSize(raw.size) ? { size: raw.size } : {}), ...(isPointStyle(raw.pointStyle) ? { pointStyle: raw.pointStyle } : {}), ...common });
    } else if (raw.type === "text" && isFiniteNumber(raw.x) && isFiniteNumber(raw.y)) {
      const textValue = typeof raw.text === "string" ? sanitizeDrawingNoteText(raw.text) : undefined;
      if (!textValue) continue;
      result.push({ id: raw.id, type: "text", page: raw.page as number, x: clamp01(raw.x), y: clamp01(raw.y), text: textValue, color, ...(isSize(raw.size) ? { size: raw.size } : {}), ...common });
    } else if (raw.type === "line" && [raw.x1, raw.y1, raw.x2, raw.y2].every(isFiniteNumber)) {
      result.push({ id: raw.id, type: "line", page: raw.page as number, x1: clamp01(raw.x1 as number), y1: clamp01(raw.y1 as number), x2: clamp01(raw.x2 as number), y2: clamp01(raw.y2 as number), color, ...(isSize(raw.width) ? { width: raw.width } : {}), ...common });
    }
  }
  return result;
}

export function effectiveManualDrawings(project: Pick<TechnicalRasterProject, "manualDrawings">): readonly TechnicalRasterDrawing[] {
  return project.manualDrawings ?? [];
}

export type NewDrawingStyle = Readonly<{ category: DrawingCategory; size: DrawingSize }>;

export function createPointDrawing(page: number, x: number, y: number, style: NewDrawingStyle & Readonly<{ pointStyle: DrawingPointStyle }>, id: string = crypto.randomUUID()): TechnicalRasterDrawing {
  return { id, type: "point", page, x: clamp01(x), y: clamp01(y), color: drawingCategoryColor(style.category), size: style.size, category: style.category, pointStyle: style.pointStyle };
}

export function createLineDrawing(page: number, a: Readonly<{ x: number; y: number }>, b: Readonly<{ x: number; y: number }>, style: NewDrawingStyle, id: string = crypto.randomUUID()): TechnicalRasterDrawing {
  return { id, type: "line", page, x1: clamp01(a.x), y1: clamp01(a.y), x2: clamp01(b.x), y2: clamp01(b.y), color: drawingCategoryColor(style.category), width: style.size, category: style.category };
}

export function createTextDrawing(page: number, x: number, y: number, style: NewDrawingStyle, text: string = DEFAULT_DRAWING_TEXT, id: string = crypto.randomUUID()): TechnicalRasterDrawing {
  return { id, type: "text", page, x: clamp01(x), y: clamp01(y), text: sanitizeDrawingNoteText(text) ?? DEFAULT_DRAWING_TEXT, color: drawingCategoryColor(style.category), size: style.size, category: style.category };
}

/** Changes a text object's text (single line, capped like a note). Empty text is refused — delete the object instead. */
export function withManualDrawingText(project: TechnicalRasterProject, drawingId: string, text: string): TechnicalRasterProject {
  const cleaned = sanitizeDrawingNoteText(text);
  if (!cleaned) return project;
  return withOneDrawing(project, drawingId, (drawing) => (drawing.type === "text" && drawing.text !== cleaned ? { ...drawing, text: cleaned } : drawing));
}

/** A line whose two clicks landed on the same spot draws nothing visible — never stored. */
export function isDegenerateLine(a: Readonly<{ x: number; y: number }>, b: Readonly<{ x: number; y: number }>): boolean {
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
}

function withDrawings(project: TechnicalRasterProject, manualDrawings: readonly TechnicalRasterDrawing[]): TechnicalRasterProject {
  return { ...project, manualDrawings, updatedAt: new Date().toISOString() };
}

function withOneDrawing(project: TechnicalRasterProject, drawingId: string, update: (drawing: TechnicalRasterDrawing) => TechnicalRasterDrawing): TechnicalRasterProject {
  const drawings = effectiveManualDrawings(project);
  if (!drawings.some((drawing) => drawing.id === drawingId)) return project;
  return withDrawings(project, drawings.map((drawing) => (drawing.id === drawingId ? update(drawing) : drawing)));
}

export function withManualDrawingAdded(project: TechnicalRasterProject, drawing: TechnicalRasterDrawing): TechnicalRasterProject {
  return withDrawings(project, [...effectiveManualDrawings(project), drawing]);
}

export function withManualDrawingRemoved(project: TechnicalRasterProject, drawingId: string): TechnicalRasterProject {
  const drawings = effectiveManualDrawings(project);
  if (!drawings.some((drawing) => drawing.id === drawingId)) return project;
  return withDrawings(project, drawings.filter((drawing) => drawing.id !== drawingId));
}

/**
 * Moves a point, or a whole line (both endpoints by the same offset). The offset is limited so the
 * drawing stays on the page — a line keeps its exact shape instead of being squashed at the edge.
 * The note has no coordinates of its own, so it always moves with its mark.
 */
export function moveManualDrawing(drawing: TechnicalRasterDrawing, dx: number, dy: number): TechnicalRasterDrawing {
  if (drawing.type === "point" || drawing.type === "text") return { ...drawing, x: clamp01(drawing.x + dx), y: clamp01(drawing.y + dy) };
  const limit = (delta: number, a: number, b: number) => Math.min(Math.max(delta, -Math.min(a, b)), 1 - Math.max(a, b));
  const ldx = limit(dx, drawing.x1, drawing.x2);
  const ldy = limit(dy, drawing.y1, drawing.y2);
  return { ...drawing, x1: drawing.x1 + ldx, y1: drawing.y1 + ldy, x2: drawing.x2 + ldx, y2: drawing.y2 + ldy };
}

export function withManualDrawingMoved(project: TechnicalRasterProject, drawingId: string, dx: number, dy: number): TechnicalRasterProject {
  if (dx === 0 && dy === 0) return project;
  return withOneDrawing(project, drawingId, (drawing) => moveManualDrawing(drawing, dx, dy));
}

/** Restyles one existing drawing (a category, thickness or point shape picked while it is selected). A category also sets the stored color to that category's color. */
export function withManualDrawingStyle(project: TechnicalRasterProject, drawingId: string, style: Readonly<{ category?: DrawingCategory; size?: DrawingSize; pointStyle?: DrawingPointStyle }>): TechnicalRasterProject {
  return withOneDrawing(project, drawingId, (drawing) => {
    const categoryFields = style.category ? { category: style.category, color: drawingCategoryColor(style.category) } : {};
    if (drawing.type === "point") return { ...drawing, ...categoryFields, size: style.size ?? drawing.size, ...(style.pointStyle ? { pointStyle: style.pointStyle } : {}) };
    if (drawing.type === "text") return { ...drawing, ...categoryFields, size: style.size ?? drawing.size };
    return { ...drawing, ...categoryFields, width: style.size ?? drawing.width };
  });
}

/** Sets (or, with empty text, removes) a drawing's note. `visible` defaults to off — an internal note. */
export function withManualDrawingNote(project: TechnicalRasterProject, drawingId: string, note: Readonly<{ text: string; visible?: boolean }>): TechnicalRasterProject {
  return withOneDrawing(project, drawingId, (drawing) => {
    const text = sanitizeDrawingNoteText(note.text);
    if (!text) {
      const { note: _removed, ...rest } = drawing;
      void _removed;
      return rest as TechnicalRasterDrawing;
    }
    return { ...drawing, note: { text, visible: note.visible ?? drawing.note?.visible ?? false } };
  });
}

/** What the PDF export draws for one drawing on one page — sizes already resolved to PDF points, color already resolved from the category. */
export type TechnicalRasterExportDrawingNote = Readonly<{ text: string; fontSizePt: number; gapPt: number }>;

export type TechnicalRasterExportDrawingItem =
  | Readonly<{ id: string; kind: "point"; shape: DrawingPointShape; x: number; y: number; color: string; category?: DrawingCategory; strokePt: number; crossHalfPt: number; dotRadiusPt: number; note?: TechnicalRasterExportDrawingNote }>
  | Readonly<{ id: string; kind: "line"; x1: number; y1: number; x2: number; y2: number; color: string; category?: DrawingCategory; strokePt: number; note?: TechnicalRasterExportDrawingNote }>
  | Readonly<{ id: string; kind: "text"; x: number; y: number; text: string; color: string; category?: DrawingCategory; fontSizePt: number }>;

/** Internal notes are never part of the export — only a visible note becomes an item's `note`. */
export function buildManualDrawingExportItems(drawings: readonly TechnicalRasterDrawing[], page: number): readonly TechnicalRasterExportDrawingItem[] {
  return drawings.filter((drawing) => drawing.page === page).map((drawing) => {
    const size = DRAWING_SIZES[drawingSizeOf(drawing)];
    const noteText = visibleDrawingNoteText(drawing);
    const note = noteText ? { note: { text: noteText, fontSizePt: DRAWING_NOTE_FONT_SIZE_PT, gapPt: DRAWING_NOTE_GAP_PT } } : {};
    const category = drawingCategoryOf(drawing);
    const common = { id: drawing.id, color: drawingColorOf(drawing), ...(category ? { category } : {}), strokePt: size.strokePt, ...note };
    if (drawing.type === "text") return { id: drawing.id, kind: "text" as const, x: drawing.x, y: drawing.y, text: drawing.text, color: drawingColorOf(drawing), ...(category ? { category } : {}), fontSizePt: size.textPt };
    return drawing.type === "point"
      ? { ...common, kind: "point" as const, shape: drawingPointShapeOf(drawing), x: drawing.x, y: drawing.y, crossHalfPt: size.crossHalfPt, dotRadiusPt: size.dotRadiusPt }
      : { ...common, kind: "line" as const, x1: drawing.x1, y1: drawing.y1, x2: drawing.x2, y2: drawing.y2 };
  });
}
