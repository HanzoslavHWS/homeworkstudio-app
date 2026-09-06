/**
 * Tiskové plochy V2 — the STICKY active tool (spec section 10). Once the user picks a concrete
 * catalog preset (or enters a Límec width / Jiná plocha width+height), that choice stays active
 * across repeated clicks — click 5 times, get A/B/C/D/E all sharing the same typeId+presetId (or
 * customWidthMm/customHeightMm), with no re-selection in between. Only switching to "Výběr",
 * pressing Escape, or picking a different tool/preset ends it — never a create action itself.
 *
 * V4 (pricing): a "link" tool lets the user place ANOTHER marker for an already-existing
 * PrintSurfaceItem on the currently active view — e.g. the same physical panel A visible on both
 * Pohled 1 and Pohled 2. Clicking with this tool active never creates a new PrintSurfaceItem, only
 * a new MarkerPlacement referencing the chosen existing item — see
 * domain/printSurfaceProject.ts's addMarkerPlacementForExistingItem.
 */

import type { PrintSurfaceTypeId } from "./printSurfaceTypeCatalog.ts";

export type PrintSurfaceActiveTool =
  | Readonly<{ kind: "select" }>
  | Readonly<{ kind: "catalog"; typeId: PrintSurfaceTypeId; presetId: string; label: string }>
  | Readonly<{ kind: "fascia"; widthMm: number }>
  | Readonly<{ kind: "custom"; widthMm: number; heightMm: number }>
  | Readonly<{ kind: "link"; itemId: string; label: string }>;

export const SELECT_TOOL: PrintSurfaceActiveTool = { kind: "select" };

export const FASCIA_HEIGHT_MM = 300;

/** What clicking the image right now should do — stamp a brand new PrintSurfaceItem+placement, or add a placement for an ALREADY-EXISTING item (never both, never a bare item with no placement). */
export type PendingPrintSurfaceAction =
  | Readonly<{ mode: "create"; typeId: PrintSurfaceTypeId; presetId?: string; customWidthMm?: number; customHeightMm?: number }>
  | Readonly<{ mode: "link"; itemId: string }>;

/**
 * What clicking the image right now should do, or undefined if the active tool can't act yet
 * (kind "select", or a fascia/custom width not entered/invalid). The tool itself is NEVER mutated
 * by this — see the module doc: staying sticky is the caller simply not resetting activeTool
 * after a create, which this function has no say in.
 */
export function pendingActionFromActiveTool(tool: PrintSurfaceActiveTool): PendingPrintSurfaceAction | undefined {
  if (tool.kind === "select") return undefined;
  if (tool.kind === "catalog") return { mode: "create", typeId: tool.typeId, presetId: tool.presetId };
  if (tool.kind === "link") return { mode: "link", itemId: tool.itemId };
  if (tool.kind === "fascia") {
    if (!Number.isFinite(tool.widthMm) || tool.widthMm <= 0) return undefined;
    return { mode: "create", typeId: "fascia", customWidthMm: tool.widthMm, customHeightMm: FASCIA_HEIGHT_MM };
  }
  if (!Number.isFinite(tool.widthMm) || tool.widthMm <= 0 || !Number.isFinite(tool.heightMm) || tool.heightMm <= 0) return undefined;
  return { mode: "create", typeId: "custom", customWidthMm: tool.widthMm, customHeightMm: tool.heightMm };
}

/** Short "Aktivní: …" label for the toolbar — undefined for "select" (nothing to announce). */
export function activeToolLabel(tool: PrintSurfaceActiveTool): string | undefined {
  if (tool.kind === "select") return undefined;
  if (tool.kind === "catalog") return tool.label;
  if (tool.kind === "link") return `Propojit s: ${tool.label}`;
  if (tool.kind === "fascia") return `Límec — ${tool.widthMm} × ${FASCIA_HEIGHT_MM} mm`;
  return `Jiná plocha — ${tool.widthMm} × ${tool.heightMm} mm`;
}
