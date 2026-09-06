/**
 * Tiskové plochy — MVP editor for marking print surfaces on an uploaded booth photo/visualization.
 * Deliberately a standalone module, NOT wired into domain/printSurfaces.ts / PrintSurfaceAssignment
 * (the existing project-scoped "assign artwork to a booth panel" feature consumed by
 * components/configurator/GraphicsSurfacePanel.tsx) — same spirit as this app's project-independent
 * "E-maily" tab (see domain/emailTemplate.ts), not a replacement for the 3D generator's own concept.
 *
 * Marker positions are stored NORMALIZED (0–1) relative to the uploaded image's own pixel
 * dimensions, never in absolute screen/viewport pixels — that's what keeps a marker glued to the
 * right spot on the photo across zoom, pan, Fit and viewport-resize (see xNormalized/yNormalized).
 *
 * Several fields below are reserved for later phases (real production dimensions from an
 * Excel-imported realizačka, quantity, a dimension preset) and are intentionally optional/unused —
 * see the module doc in the task spec, section 9/10. No dimension logic is implemented yet.
 */

export type PrintSurfaceProjectImage = Readonly<{
  /** Client-side only for this MVP phase — see lib/db/printSurfaceProjectRepository.localStorage.client.ts. */
  dataUrl: string;
  /** Real pixel dimensions of the uploaded raster — the basis xNormalized/yNormalized are relative to. */
  widthPx: number;
  heightPx: number;
  fileName: string;
}>;

import type { PrintSurfaceTypeId } from "./printSurfaceTypeCatalog.ts";
import { findPreset, type PrintSurfacePreset } from "./printSurfacePreset.ts";

export type PrintSurfaceItem = Readonly<{
  id: string;
  /** Auto-generated as A/B/C… on creation (see nextPrintSurfaceLabel) but freely re-editable afterwards — may later hold "01"/"02" or any custom text, so it's a plain string, not a generated-only enum. */
  label: string;
  typeId: PrintSurfaceTypeId;
  /** 0–1, relative to the image's own widthPx — NOT absolute screen pixels. */
  xNormalized: number;
  /** 0–1, relative to the image's own heightPx — NOT absolute screen pixels. */
  yNormalized: number;
  note: string;
  /**
   * The concrete PrintSurfacePreset this marker is tagged with (see domain/printSurfacePreset.ts)
   * — must belong to this item's own typeId; see changePrintSurfaceItemType for the invariant that
   * keeps it that way whenever typeId changes. The item's actual production SIZE is never stored
   * here — it's always resolved on the fly from (project.realizationCompanyId, presetId) via
   * domain/printSurfaceProductionDimension.ts's resolvePrintSurfaceProductionDimension.
   */
  presetId?: string;

  // ---- Reserved for a later phase — never read/written by this MVP's logic yet ----
  /** Real-world size on the MASTER (design) print file, once known. */
  widthMasterMm?: number;
  heightMasterMm?: number;
  /** Real-world size actually produced for a specific realizačka, once an Excel import supplies it. */
  widthProductionMm?: number;
  heightProductionMm?: number;
  /** Per-surface override of the project's realizationCompanyId, for the rare case production splits across realizačky. */
  realizationCompanyId?: string;
  quantity?: number;
}>;

export type PrintSurfaceProject = Readonly<{
  id: string;
  name: string;
  companyName: string;
  eventId?: string;
  realizationCompanyId?: string;
  image?: PrintSurfaceProjectImage;
  items: readonly PrintSurfaceItem[];
  /**
   * @deprecated Kept only for backward compatibility with already-persisted projects — no longer
   * read or written when generating a new label. The source of truth for the next free auto label
   * is always the CURRENT items' labels (see nextPrintSurfaceLabel) — a plain incrementing counter
   * can't express "reuse a freed letter" (A,B,C,D → delete C → next new marker becomes C again) or
   * "skip a letter a manually renamed marker now occupies" (existing A,B + a marker manually
   * renamed to C → next new marker becomes D), both of which are required behavior.
   */
  nextLabelIndex: number;
  createdAt: string;
  updatedAt: string;
}>;

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Converts a 0-based index to Excel-column-style letters: 0→A, 25→Z, 26→AA, ... */
function letterLabelForIndex(index: number): string {
  let n = index + 1;
  let label = "";
  while (n > 0) {
    const remainder = (n - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

/**
 * The first currently-unused auto label — A, B, C, … Z, AA, AB, … — given the labels every
 * existing item currently holds, whether auto-generated or manually renamed. A slot counts as
 * "used" purely by whether some item's label currently equals it (trimmed, case-insensitive), so:
 *   - deleting a marker FREES its label for reuse by the next created marker (A,B,C,D → delete C
 *     → next new marker becomes C again — never left permanently retired);
 *   - manually renaming another marker to "C" occupies C just the same, so the next created
 *     marker skips it (existing A,B + a marker renamed to C → next new marker becomes D);
 *   - several gaps are filled lowest-first, one at a time, as markers are created (A,B,C,D →
 *     delete B and D → next new marker gets B, the one after that gets D).
 * Existing markers are NEVER renamed/renumbered by this function — it only decides the label for
 * a marker being created right now.
 */
export function nextPrintSurfaceLabel(existingLabels: readonly string[]): string {
  const used = new Set(existingLabels.map((label) => label.trim().toUpperCase()));
  for (let index = 0; ; index++) {
    const candidate = letterLabelForIndex(index);
    if (!used.has(candidate)) return candidate;
  }
}

export type PrintSurfaceItemCreateInput = Readonly<{
  typeId: PrintSurfaceTypeId;
  xNormalized: number;
  yNormalized: number;
}>;

/** Pure preview of the item addPrintSurfaceItem would create — label picked from the CURRENT items' labels (see nextPrintSurfaceLabel), never from the project's deprecated nextLabelIndex counter. */
export function createPrintSurfaceItem(
  existingItems: readonly PrintSurfaceItem[],
  input: PrintSurfaceItemCreateInput,
  id: string = crypto.randomUUID(),
): PrintSurfaceItem {
  return {
    id,
    label: nextPrintSurfaceLabel(existingItems.map((item) => item.label)),
    typeId: input.typeId,
    xNormalized: clamp01(input.xNormalized),
    yNormalized: clamp01(input.yNormalized),
    note: "",
  };
}

export type PrintSurfaceItemEdit = Partial<Pick<PrintSurfaceItem, "label" | "typeId" | "note" | "presetId">>;

export function updatePrintSurfaceItem(
  items: readonly PrintSurfaceItem[],
  id: string,
  edit: PrintSurfaceItemEdit,
): readonly PrintSurfaceItem[] {
  return items.map((item) => (item.id === id ? { ...item, ...edit } : item));
}

/**
 * Applies a type change to a single item, resetting presetId whenever the CURRENT preset no
 * longer belongs to the new type (spec section 5) — a preset must always belong to its item's own
 * typeId, so this is the only correct way to change typeId once a preset may already be set.
 * Existing markers are never touched — only the targeted item.
 */
export function changePrintSurfaceItemType(
  item: PrintSurfaceItem,
  newTypeId: PrintSurfaceTypeId,
  presets: readonly PrintSurfacePreset[],
): PrintSurfaceItem {
  const currentPreset = findPreset(presets, item.presetId);
  const presetStillValid = currentPreset?.typeId === newTypeId;
  return { ...item, typeId: newTypeId, presetId: presetStillValid ? item.presetId : undefined };
}

export function updatePrintSurfaceItemType(
  items: readonly PrintSurfaceItem[],
  id: string,
  newTypeId: PrintSurfaceTypeId,
  presets: readonly PrintSurfacePreset[],
): readonly PrintSurfaceItem[] {
  return items.map((item) => (item.id === id ? changePrintSurfaceItemType(item, newTypeId, presets) : item));
}

export function movePrintSurfaceItem(
  items: readonly PrintSurfaceItem[],
  id: string,
  xNormalized: number,
  yNormalized: number,
): readonly PrintSurfaceItem[] {
  return items.map((item) =>
    item.id === id ? { ...item, xNormalized: clamp01(xNormalized), yNormalized: clamp01(yNormalized) } : item,
  );
}

export function removePrintSurfaceItem(items: readonly PrintSurfaceItem[], id: string): readonly PrintSurfaceItem[] {
  return items.filter((item) => item.id !== id);
}

export function findPrintSurfaceItem(items: readonly PrintSurfaceItem[], id: string | undefined): PrintSurfaceItem | undefined {
  if (!id) return undefined;
  return items.find((item) => item.id === id);
}

export function createPrintSurfaceProject(
  input: Readonly<{ name: string; companyName: string; eventId?: string; realizationCompanyId?: string }>,
  id: string = crypto.randomUUID(),
  now: string = new Date().toISOString(),
): PrintSurfaceProject {
  return {
    id,
    name: input.name,
    companyName: input.companyName,
    eventId: input.eventId,
    realizationCompanyId: input.realizationCompanyId,
    image: undefined,
    items: [],
    nextLabelIndex: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/** Adds a new item to the project — the only way an item should be added. Label comes from the project's CURRENT items (see createPrintSurfaceItem/nextPrintSurfaceLabel); nextLabelIndex is left untouched (deprecated, no longer meaningful). */
export function addPrintSurfaceItem(
  project: PrintSurfaceProject,
  input: PrintSurfaceItemCreateInput,
  id?: string,
): Readonly<{ project: PrintSurfaceProject; item: PrintSurfaceItem }> {
  const item = createPrintSurfaceItem(project.items, input, id);
  return {
    project: { ...project, items: [...project.items, item], updatedAt: new Date().toISOString() },
    item,
  };
}

/** Pixel click position (relative to the image's own top-left, in image px) → normalized 0–1. */
export function normalizeImagePosition(
  pixelX: number,
  pixelY: number,
  imageWidthPx: number,
  imageHeightPx: number,
): Readonly<{ xNormalized: number; yNormalized: number }> {
  if (imageWidthPx <= 0 || imageHeightPx <= 0) {
    return { xNormalized: 0, yNormalized: 0 };
  }
  return {
    xNormalized: clamp01(pixelX / imageWidthPx),
    yNormalized: clamp01(pixelY / imageHeightPx),
  };
}

export function withImage(project: PrintSurfaceProject, image: PrintSurfaceProjectImage): PrintSurfaceProject {
  return { ...project, image, updatedAt: new Date().toISOString() };
}

export function withItems(project: PrintSurfaceProject, items: readonly PrintSurfaceItem[]): PrintSurfaceProject {
  return { ...project, items, updatedAt: new Date().toISOString() };
}

export function withProjectFields(
  project: PrintSurfaceProject,
  fields: Partial<Pick<PrintSurfaceProject, "name" | "companyName" | "eventId" | "realizationCompanyId">>,
): PrintSurfaceProject {
  return { ...project, ...fields, updatedAt: new Date().toISOString() };
}
