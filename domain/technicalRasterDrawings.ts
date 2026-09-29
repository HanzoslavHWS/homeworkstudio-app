/**
 * Technické rastry — MANUAL technical drawings: a free point ("Bod", drawn as a colored cross) and
 * a straight line A–B ("Čára"). A completely separate layer of project data
 * (`TechnicalRasterProject.manualDrawings`): never a service, never a placement, never touched by a
 * report (re-)import, no link/snapping to service markers.
 *
 * Coordinates use the SAME space as service placements: the page number plus x/y normalized to the
 * displayed page (0–1, rotation-aware display space). The editor multiplies them by the stage size,
 * the PDF export converts them with normalizedDisplayPointToRawPdfPoint — so they line up at any
 * zoom, after reload, and in the export.
 */
import type { TechnicalRasterProject } from "./technicalRaster.ts";

export type DrawingSize = "thin" | "medium" | "thick";

export type TechnicalRasterDrawing =
  | Readonly<{ id: string; type: "point"; page: number; x: number; y: number; color: string; size?: DrawingSize }>
  | Readonly<{ id: string; type: "line"; page: number; x1: number; y1: number; x2: number; y2: number; color: string; width?: DrawingSize }>;

export type TechnicalRasterDrawingTool = "off" | "select" | "point" | "line";

export const DRAWING_COLORS: readonly Readonly<{ id: string; label: string; hex: string }>[] = [
  { id: "red", label: "Červená", hex: "#d62828" },
  { id: "blue", label: "Modrá", hex: "#1d4ed8" },
  { id: "green", label: "Zelená", hex: "#15803d" },
  { id: "orange", label: "Oranžová", hex: "#ea580c" },
  { id: "black", label: "Černá", hex: "#111111" },
];

export const DEFAULT_DRAWING_COLOR = DRAWING_COLORS[0]!.hex;
export const DEFAULT_DRAWING_SIZE: DrawingSize = "medium";

/**
 * One preset -> sizes. Editor sizes are SCREEN px (zoom-invariant, divided by zoom at render time,
 * same as every other marker in the editor); export sizes are PDF points.
 */
export const DRAWING_SIZES: Readonly<Record<DrawingSize, Readonly<{ label: string; strokeScreenPx: number; crossHalfScreenPx: number; strokePt: number; crossHalfPt: number }>>> = {
  thin: { label: "Tenká", strokeScreenPx: 1.5, crossHalfScreenPx: 6, strokePt: 0.75, crossHalfPt: 3 },
  medium: { label: "Střední", strokeScreenPx: 3, crossHalfScreenPx: 8, strokePt: 1.5, crossHalfPt: 4 },
  thick: { label: "Silná", strokeScreenPx: 5, crossHalfScreenPx: 10, strokePt: 3, crossHalfPt: 5 },
};

const HEX_COLOR = /^#[0-9a-f]{6}$/iu;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSize(value: unknown): value is DrawingSize {
  return value === "thin" || value === "medium" || value === "thick";
}

export function drawingSizeOf(drawing: TechnicalRasterDrawing): DrawingSize {
  return (drawing.type === "point" ? drawing.size : drawing.width) ?? DEFAULT_DRAWING_SIZE;
}

/** Reads persisted/untrusted drawings: drops malformed entries, clamps coordinates into the page, falls back to the default color for an invalid one. Never throws. */
export function normalizeManualDrawings(value: unknown): readonly TechnicalRasterDrawing[] {
  if (!Array.isArray(value)) return [];
  const result: TechnicalRasterDrawing[] = [];
  for (const raw of value as Record<string, unknown>[]) {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !Number.isInteger(raw.page) || (raw.page as number) < 1) continue;
    const color = typeof raw.color === "string" && HEX_COLOR.test(raw.color) ? raw.color : DEFAULT_DRAWING_COLOR;
    if (raw.type === "point" && isFiniteNumber(raw.x) && isFiniteNumber(raw.y)) {
      result.push({ id: raw.id, type: "point", page: raw.page as number, x: clamp01(raw.x), y: clamp01(raw.y), color, ...(isSize(raw.size) ? { size: raw.size } : {}) });
    } else if (raw.type === "line" && [raw.x1, raw.y1, raw.x2, raw.y2].every(isFiniteNumber)) {
      result.push({ id: raw.id, type: "line", page: raw.page as number, x1: clamp01(raw.x1 as number), y1: clamp01(raw.y1 as number), x2: clamp01(raw.x2 as number), y2: clamp01(raw.y2 as number), color, ...(isSize(raw.width) ? { width: raw.width } : {}) });
    }
  }
  return result;
}

export function effectiveManualDrawings(project: Pick<TechnicalRasterProject, "manualDrawings">): readonly TechnicalRasterDrawing[] {
  return project.manualDrawings ?? [];
}

export function createPointDrawing(page: number, x: number, y: number, color: string, size: DrawingSize, id: string = crypto.randomUUID()): TechnicalRasterDrawing {
  return { id, type: "point", page, x: clamp01(x), y: clamp01(y), color, size };
}

export function createLineDrawing(page: number, a: Readonly<{ x: number; y: number }>, b: Readonly<{ x: number; y: number }>, color: string, width: DrawingSize, id: string = crypto.randomUUID()): TechnicalRasterDrawing {
  return { id, type: "line", page, x1: clamp01(a.x), y1: clamp01(a.y), x2: clamp01(b.x), y2: clamp01(b.y), color, width };
}

/** A line whose two clicks landed on the same spot draws nothing visible — never stored. */
export function isDegenerateLine(a: Readonly<{ x: number; y: number }>, b: Readonly<{ x: number; y: number }>): boolean {
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
}

function withDrawings(project: TechnicalRasterProject, manualDrawings: readonly TechnicalRasterDrawing[]): TechnicalRasterProject {
  return { ...project, manualDrawings, updatedAt: new Date().toISOString() };
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
 */
export function moveManualDrawing(drawing: TechnicalRasterDrawing, dx: number, dy: number): TechnicalRasterDrawing {
  if (drawing.type === "point") return { ...drawing, x: clamp01(drawing.x + dx), y: clamp01(drawing.y + dy) };
  const limit = (delta: number, a: number, b: number) => Math.min(Math.max(delta, -Math.min(a, b)), 1 - Math.max(a, b));
  const ldx = limit(dx, drawing.x1, drawing.x2);
  const ldy = limit(dy, drawing.y1, drawing.y2);
  return { ...drawing, x1: drawing.x1 + ldx, y1: drawing.y1 + ldy, x2: drawing.x2 + ldx, y2: drawing.y2 + ldy };
}

export function withManualDrawingMoved(project: TechnicalRasterProject, drawingId: string, dx: number, dy: number): TechnicalRasterProject {
  if (dx === 0 && dy === 0) return project;
  const drawings = effectiveManualDrawings(project);
  if (!drawings.some((drawing) => drawing.id === drawingId)) return project;
  return withDrawings(project, drawings.map((drawing) => (drawing.id === drawingId ? moveManualDrawing(drawing, dx, dy) : drawing)));
}

/** Recolors / resizes one existing drawing (used when a color or thickness is picked while a drawing is selected). */
export function withManualDrawingStyle(project: TechnicalRasterProject, drawingId: string, style: Readonly<{ color?: string; size?: DrawingSize }>): TechnicalRasterProject {
  const drawings = effectiveManualDrawings(project);
  if (!drawings.some((drawing) => drawing.id === drawingId)) return project;
  return withDrawings(project, drawings.map((drawing) => {
    if (drawing.id !== drawingId) return drawing;
    const color = style.color ?? drawing.color;
    if (drawing.type === "point") return { ...drawing, color, size: style.size ?? drawing.size };
    return { ...drawing, color, width: style.size ?? drawing.width };
  }));
}

/** What the PDF export draws for one drawing on one page — sizes already resolved to PDF points. */
export type TechnicalRasterExportDrawingItem =
  | Readonly<{ id: string; kind: "point"; x: number; y: number; color: string; strokePt: number; crossHalfPt: number }>
  | Readonly<{ id: string; kind: "line"; x1: number; y1: number; x2: number; y2: number; color: string; strokePt: number }>;

export function buildManualDrawingExportItems(drawings: readonly TechnicalRasterDrawing[], page: number): readonly TechnicalRasterExportDrawingItem[] {
  return drawings.filter((drawing) => drawing.page === page).map((drawing) => {
    const size = DRAWING_SIZES[drawingSizeOf(drawing)];
    return drawing.type === "point"
      ? { id: drawing.id, kind: "point", x: drawing.x, y: drawing.y, color: drawing.color, strokePt: size.strokePt, crossHalfPt: size.crossHalfPt }
      : { id: drawing.id, kind: "line", x1: drawing.x1, y1: drawing.y1, x2: drawing.x2, y2: drawing.y2, color: drawing.color, strokePt: size.strokePt };
  });
}
