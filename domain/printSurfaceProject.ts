/**
 * Tiskové plochy — editor for marking print surfaces on an uploaded booth photo/visualization.
 * Deliberately a standalone module, NOT wired into domain/printSurfaces.ts / PrintSurfaceAssignment
 * (the existing project-scoped "assign artwork to a booth panel" feature consumed by
 * components/configurator/GraphicsSurfacePanel.tsx) — same spirit as this app's project-independent
 * "E-maily" tab (see domain/emailTemplate.ts), not a replacement for the 3D generator's own concept.
 *
 * V2 (database-first): a project is now a real, independently persisted, listable/openable
 * record — see PrintSurfaceProjectRepository below — not a single always-current localStorage
 * draft.
 *
 * V3: a project can have up to MAX_PRINT_SURFACE_VIEWS uploaded images ("pohledy").
 *
 * V4 (pricing): PrintSurfaceItem and "a pin on the image" are now TWO separate things —
 * PrintSurfaceItem is the physical print surface (what gets priced, once), MarkerPlacement is one
 * pin of it on one specific view. The same physical surface can have a placement on more than one
 * view (e.g. panel A visible on both Pohled 1 and Pohled 2) while still being ONE PrintSurfaceItem
 * — priced/counted exactly once regardless of how many placements it has. Every placement
 * references its item via itemId; every placement belongs to exactly one view via imageId. See
 * placementsForView / itemForPlacement / addPrintSurfaceItemWithPlacement /
 * addMarkerPlacementForExistingItem.
 *
 * Marker positions are stored NORMALIZED (0–1) relative to their OWN view's image pixel
 * dimensions, never in absolute screen/viewport pixels — that's what keeps a marker glued to the
 * right spot on the photo across zoom, pan, Fit and viewport-resize (see xNormalized/yNormalized).
 */

import type { StoredAsset } from "./assets.ts";
import type { PrintSurfaceTypeId } from "./printSurfaceTypeCatalog.ts";
import { findPreset, printSurfacePresetDisplayName, type PrintSurfacePreset } from "./printSurfacePreset.ts";
import {
  resolvePrintSurfaceProductionDimension,
  type PrintSurfaceProductionDimension,
} from "./printSurfaceProductionDimension.ts";
import { printSurfaceTypeLabel } from "./printSurfaceTypeCatalog.ts";

export type PrintSurfaceProjectImage = Readonly<{
  asset: StoredAsset;
  /** Real pixel dimensions of the uploaded raster — the basis xNormalized/yNormalized are relative to. */
  widthPx: number;
  heightPx: number;
}>;

/** One uploaded "pohled" (view) of the booth — a project may have up to MAX_PRINT_SURFACE_VIEWS of these. */
export type PrintSurfaceView = Readonly<{
  id: string;
  /** User-renamable — defaults to "Pohled 1"/"Pohled 2" at creation, see nextDefaultViewLabel. */
  label: string;
  image: PrintSurfaceProjectImage;
  /** Display/tab order — always the order views were added in for this MVP (no manual reordering yet). */
  order: number;
}>;

export const MAX_PRINT_SURFACE_VIEWS = 2;

export function canAddPrintSurfaceView(views: readonly PrintSurfaceView[]): boolean {
  return views.length < MAX_PRINT_SURFACE_VIEWS;
}

export function findPrintSurfaceView(views: readonly PrintSurfaceView[], id: string | undefined): PrintSurfaceView | undefined {
  if (!id) return undefined;
  return views.find((view) => view.id === id);
}

/**
 * A PHYSICAL print surface — the thing that gets manufactured and priced. Deliberately has NO
 * position/view of its own (see MarkerPlacement) — the same physical surface can be pinned on more
 * than one view while remaining exactly one PrintSurfaceItem, priced/counted once.
 */
export type PrintSurfaceItem = Readonly<{
  id: string;
  /** Auto-generated as A/B/C… on creation (project-wide — see nextPrintSurfaceLabel), freely re-editable afterwards. */
  label: string;
  typeId: PrintSurfaceTypeId;
  note: string;
  /**
   * The concrete PrintSurfacePreset this item is tagged with (see domain/printSurfacePreset.ts)
   * — must belong to this item's own typeId; see changePrintSurfaceItemType for the invariant that
   * keeps it that way whenever typeId changes. Never set together with customWidthMm/customHeightMm
   * — an item is either catalog-backed (presetId) or manual/custom (customWidthMm/customHeightMm),
   * never both (see resolvePrintSurfaceItemDimension).
   */
  presetId?: string;
  /**
   * Manual/explicit dimension, used ONLY for typeId "fascia" (límec — customHeightMm is always
   * exactly 300) and "custom" (jiná plocha — both dimensions are free). Deliberately never copied
   * from a catalog production dimension automatically (spec) — resolvePrintSurfaceItemDimension
   * always prefers these over any catalog lookup whenever they're present.
   */
  customWidthMm?: number;
  customHeightMm?: number;
  /** How many physical prints of this exact graphic are needed — defaults to 1 (see the export table's "Počet" column, and pricing's quantity multiplier). */
  quantity?: number;
  /** Explicit opt-in to the pricing calculation (spec section 9.1) — defaults to false; a surface never silently affects the project total just by existing. */
  includeInCalculation: boolean;
}>;

/** One pin of a PrintSurfaceItem on one specific view — see the module doc for why this is a separate entity from the item itself. */
export type MarkerPlacement = Readonly<{
  id: string;
  itemId: string;
  imageId: string;
  /** 0–1, relative to its view's image widthPx — NOT absolute screen pixels. */
  xNormalized: number;
  /** 0–1, relative to its view's image heightPx — NOT absolute screen pixels. */
  yNormalized: number;
}>;

export const PRINT_SURFACE_PROJECT_STATUSES = ["draft", "ready", "sent"] as const;
export type PrintSurfaceProjectStatus = (typeof PRINT_SURFACE_PROJECT_STATUSES)[number];

export type PrintSurfaceProject = Readonly<{
  id: string;
  name: string;
  companyName: string;
  eventId?: string;
  realizationCompanyId?: string;
  views: readonly PrintSurfaceView[];
  items: readonly PrintSurfaceItem[];
  placements: readonly MarkerPlacement[];
  status: PrintSurfaceProjectStatus;
  /** Reserved for a future real per-user login — always undefined until real accounts exist (same convention as domain/emailHistory.ts's userId). */
  createdBy?: string;
  /**
   * Only ever set by an explicit, real "mark as sent" action — NEVER just because an Outlook
   * draft/PDF was opened (spec section 14). Both present together or both absent.
   */
  sentAt?: string;
  sentBy?: string;
  createdAt: string;
  updatedAt: string;
  /** The ONE current PDF artifact for this project (real-usage follow-up) — see PrintSurfaceLatestPdf/withLatestPdf/isPrintSurfacePdfCurrent below. Absent until the first PDF is generated. */
  latestPdf?: PrintSurfaceLatestPdf;
}>;

// ============================================================================
// Current/latest PDF — one artifact per project, staleness by content fingerprint
// (real-usage follow-up: "nechci vytvářet novou fyzickou PDF variantu při každém exportu")
// ============================================================================

/**
 * The subset of project content that actually affects what the PDF shows — everything a real
 * content edit could change (name/companyName/event/realizační firma, every view's image, every
 * item's editable fields, every placement's position). Deliberately excludes status/sentAt/sentBy/
 * createdAt/updatedAt/latestPdf itself/id — none of those change what the exported PDF would
 * contain. Every array is sorted by id so two fingerprints built from the same logical state
 * always compare equal regardless of array insertion order — same discipline as
 * domain/visualizationRender.ts's buildVisualizationRenderFingerprint.
 */
export type PrintSurfaceProjectFingerprint = Readonly<{
  name: string;
  companyName: string;
  eventId?: string;
  realizationCompanyId?: string;
  views: readonly Readonly<{ id: string; label: string; storageKey: string }>[];
  items: readonly Readonly<{
    id: string;
    label: string;
    typeId: PrintSurfaceTypeId;
    note: string;
    presetId?: string;
    customWidthMm?: number;
    customHeightMm?: number;
    quantity?: number;
  }>[];
  placements: readonly Readonly<{ id: string; itemId: string; imageId: string; xNormalized: number; yNormalized: number }>[];
}>;

export function buildPrintSurfaceProjectFingerprint(
  project: Pick<PrintSurfaceProject, "name" | "companyName" | "eventId" | "realizationCompanyId" | "views" | "items" | "placements">,
): PrintSurfaceProjectFingerprint {
  return {
    name: project.name,
    companyName: project.companyName,
    eventId: project.eventId,
    realizationCompanyId: project.realizationCompanyId,
    views: [...project.views]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((view) => ({ id: view.id, label: view.label, storageKey: view.image.asset.storageKey })),
    items: [...project.items]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((item) => ({
        id: item.id, label: item.label, typeId: item.typeId, note: item.note,
        presetId: item.presetId, customWidthMm: item.customWidthMm, customHeightMm: item.customHeightMm, quantity: item.quantity,
      })),
    placements: [...project.placements]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((placement) => ({ id: placement.id, itemId: placement.itemId, imageId: placement.imageId, xNormalized: placement.xNormalized, yNormalized: placement.yNormalized })),
  };
}

export function printSurfaceProjectFingerprintsEqual(a: PrintSurfaceProjectFingerprint, b: PrintSurfaceProjectFingerprint): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export type PrintSurfaceLatestPdf = Readonly<{
  storageKey: string;
  fileName: string;
  generatedAt: string;
  /** Content fingerprint of the project at the moment this PDF was generated — see isPrintSurfacePdfCurrent. */
  projectFingerprint: PrintSurfaceProjectFingerprint;
}>;

/**
 * Attaches the "current PDF" reference. Deliberately does NOT bump `updatedAt`, unlike every other
 * with-/add-/remove- helper in this module — attaching a generated-PDF reference is metadata about
 * a side artifact, not a content edit. This matters concretely: print_surface_projects has a blind
 * `set_updated_at` trigger (supabase/migrations/20260906150000_print_surfaces.sql) that bumps
 * updated_at on EVERY row UPDATE regardless of which columns changed, including the very save that
 * persists this latestPdf reference — so a timestamp-based freshness check would make a just-
 * generated PDF register as stale the instant it's saved. Freshness is judged by a content
 * FINGERPRINT instead (embedded inside latestPdf itself), which is completely decoupled from
 * updatedAt/DB triggers — same reasoning already established by
 * domain/visualizationRender.ts's render-staleness fingerprint ("project.modifiedAt... cannot
 * reliably distinguish edited-before from edited-after a given capture moment").
 */
export function withLatestPdf(project: PrintSurfaceProject, latestPdf: PrintSurfaceLatestPdf): PrintSurfaceProject {
  return { ...project, latestPdf };
}

/**
 * True only when a PDF was generated AND the project's fingerprinted content hasn't changed since
 * (see withLatestPdf's doc for why this is fingerprint-based, not updatedAt-based). No latestPdf
 * at all -> always false (the UI shows "Vygenerovat PDF", never "Aktualizovat"/"Stáhnout").
 */
export function isPrintSurfacePdfCurrent(
  project: Pick<PrintSurfaceProject, "name" | "companyName" | "eventId" | "realizationCompanyId" | "views" | "items" | "placements">,
  latestPdf: PrintSurfaceLatestPdf | undefined,
): boolean {
  if (!latestPdf) return false;
  return printSurfaceProjectFingerprintsEqual(latestPdf.projectFingerprint, buildPrintSurfaceProjectFingerprint(project));
}

/** Lightweight projection for the project list/home screen — never ships the full items/placements/views. */
export type PrintSurfaceProjectSummary = Readonly<{
  id: string;
  name: string;
  companyName: string;
  eventId?: string;
  realizationCompanyId?: string;
  status: PrintSurfaceProjectStatus;
  itemCount: number;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  /** Spec section 15's "Odesláno datum" project-list column — reads the SAME field markPrintSurfaceProjectSent already writes, never a second sent-tracking mechanism. */
  sentAt?: string;
  /**
   * Quick-PDF projection for the project list (real-usage follow-up) — `isCurrent` is PRE-COMPUTED
   * (via isPrintSurfacePdfCurrent) rather than shipped as a raw fingerprint: the summary
   * deliberately never carries views/items/placements, so the client couldn't recompute freshness
   * itself even if it wanted to, and there's no reason to leak the fingerprint's internal shape to
   * the list UI for a single boolean.
   */
  latestPdf?: Readonly<{ storageKey: string; fileName: string; isCurrent: boolean }>;
}>;

export function summarizePrintSurfaceProject(project: PrintSurfaceProject): PrintSurfaceProjectSummary {
  return {
    id: project.id,
    name: project.name,
    companyName: project.companyName,
    eventId: project.eventId,
    realizationCompanyId: project.realizationCompanyId,
    status: project.status,
    itemCount: project.items.length,
    createdBy: project.createdBy,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    sentAt: project.sentAt,
    latestPdf: project.latestPdf
      ? { storageKey: project.latestPdf.storageKey, fileName: project.latestPdf.fileName, isCurrent: isPrintSurfacePdfCurrent(project, project.latestPdf) }
      : undefined,
  };
}

export type PrintSurfaceProjectCreateInput = Readonly<{
  name: string;
  companyName: string;
  eventId?: string;
  realizationCompanyId?: string;
  createdBy?: string;
}>;

/**
 * A real, independently persisted project record — list/get/create/save/delete, not a single
 * always-current draft (see the now-removed load/save/clear shape from the localStorage-only
 * phase). `save` persists the full project (views/items/placements/status included) — the caller
 * is expected to have already applied whichever pure `with*`/`add*`/`remove*` helper below before
 * calling it.
 */
export interface PrintSurfaceProjectRepository {
  list(): Promise<readonly PrintSurfaceProjectSummary[]>;
  get(id: string): Promise<PrintSurfaceProject | undefined>;
  create(input: PrintSurfaceProjectCreateInput): Promise<PrintSurfaceProject>;
  save(project: PrintSurfaceProject): Promise<PrintSurfaceProject>;
  delete(id: string): Promise<void>;
}

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
 *   - deleting an item FREES its label for reuse by the next created item (A,B,C,D → delete C
 *     → next new item becomes C again — never left permanently retired);
 *   - manually renaming another item to "C" occupies C just the same, so the next created
 *     item skips it (existing A,B + an item renamed to C → next new item becomes D);
 *   - several gaps are filled lowest-first, one at a time, as items are created (A,B,C,D →
 *     delete B and D → next new item gets B, the one after that gets D).
 * Existing items are NEVER renamed/renumbered by this function — it only decides the label for
 * an item being created right now. Project-wide (not per-view) — an item's label identifies the
 * physical surface, independent of which view(s) it happens to be pinned on.
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
  presetId?: string;
  customWidthMm?: number;
  customHeightMm?: number;
}>;

/** Pure preview of the item addPrintSurfaceItemWithPlacement would create — label picked from the CURRENT project-wide items (see nextPrintSurfaceLabel). */
export function createPrintSurfaceItem(
  existingItems: readonly PrintSurfaceItem[],
  input: PrintSurfaceItemCreateInput,
  id: string = crypto.randomUUID(),
): PrintSurfaceItem {
  return {
    id,
    label: nextPrintSurfaceLabel(existingItems.map((item) => item.label)),
    typeId: input.typeId,
    note: "",
    presetId: input.presetId,
    customWidthMm: input.customWidthMm,
    customHeightMm: input.customHeightMm,
    includeInCalculation: false,
  };
}

export function createMarkerPlacement(
  itemId: string,
  imageId: string,
  xNormalized: number,
  yNormalized: number,
  id: string = crypto.randomUUID(),
): MarkerPlacement {
  return { id, itemId, imageId, xNormalized: clamp01(xNormalized), yNormalized: clamp01(yNormalized) };
}

export type PrintSurfaceItemEdit = Partial<Pick<PrintSurfaceItem, "label" | "typeId" | "note" | "presetId" | "customWidthMm" | "customHeightMm" | "quantity" | "includeInCalculation">>;

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
 * Existing items are never touched — only the targeted item.
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

export function findPrintSurfaceItem(items: readonly PrintSurfaceItem[], id: string | undefined): PrintSurfaceItem | undefined {
  if (!id) return undefined;
  return items.find((item) => item.id === id);
}

export function findMarkerPlacement(placements: readonly MarkerPlacement[], id: string | undefined): MarkerPlacement | undefined {
  if (!id) return undefined;
  return placements.find((placement) => placement.id === id);
}

/** All placements belonging to one specific view — the single place the canvas (visible/editable pins) filters this. */
export function placementsForView(placements: readonly MarkerPlacement[], imageId: string | undefined): readonly MarkerPlacement[] {
  if (!imageId) return [];
  return placements.filter((placement) => placement.imageId === imageId);
}

/** All placements referencing one specific item — used to detect "is this the item's last placement" (removeMarkerPlacement) and to show "also on: Pohled X" in the Inspector. */
export function placementsForItem(placements: readonly MarkerPlacement[], itemId: string): readonly MarkerPlacement[] {
  return placements.filter((placement) => placement.itemId === itemId);
}

export function itemForPlacement(items: readonly PrintSurfaceItem[], placement: MarkerPlacement | undefined): PrintSurfaceItem | undefined {
  if (!placement) return undefined;
  return findPrintSurfaceItem(items, placement.itemId);
}

/** Items that do NOT yet have a placement on the given view — what a "Propojit existující plochu" picker should offer (placing the same item twice on one view would be redundant/ambiguous). */
export function itemsWithoutPlacementOnView(
  items: readonly PrintSurfaceItem[],
  placements: readonly MarkerPlacement[],
  imageId: string | undefined,
): readonly PrintSurfaceItem[] {
  if (!imageId) return items;
  const placedItemIds = new Set(placementsForView(placements, imageId).map((placement) => placement.itemId));
  return items.filter((item) => !placedItemIds.has(item.id));
}

export function createPrintSurfaceProject(
  input: PrintSurfaceProjectCreateInput,
  id: string = crypto.randomUUID(),
  now: string = new Date().toISOString(),
): PrintSurfaceProject {
  return {
    id,
    name: input.name,
    companyName: input.companyName,
    eventId: input.eventId,
    realizationCompanyId: input.realizationCompanyId,
    views: [],
    items: [],
    placements: [],
    status: "draft",
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
}

/** Creates a BRAND NEW physical surface (item) and its first placement (pin) together — the normal "click the image with a catalog/límec/custom tool active" flow (spec: a marker is never created without an item, and vice versa). */
export function addPrintSurfaceItemWithPlacement(
  project: PrintSurfaceProject,
  itemInput: PrintSurfaceItemCreateInput,
  imageId: string,
  xNormalized: number,
  yNormalized: number,
  ids?: Readonly<{ itemId?: string; placementId?: string }>,
): Readonly<{ project: PrintSurfaceProject; item: PrintSurfaceItem; placement: MarkerPlacement }> {
  const item = createPrintSurfaceItem(project.items, itemInput, ids?.itemId);
  const placement = createMarkerPlacement(item.id, imageId, xNormalized, yNormalized, ids?.placementId);
  return {
    project: { ...project, items: [...project.items, item], placements: [...project.placements, placement], updatedAt: new Date().toISOString() },
    item,
    placement,
  };
}

/**
 * Adds a placement for an ALREADY-EXISTING item on the given view — "the same physical plocha A
 * is also visible on Pohled 2" (spec section 9: priced once regardless). Refuses (no-op) if that
 * item already has a placement on this exact view — a second pin for the same item on the same
 * view would be redundant/ambiguous, never silently duplicated.
 */
export function addMarkerPlacementForExistingItem(
  project: PrintSurfaceProject,
  itemId: string,
  imageId: string,
  xNormalized: number,
  yNormalized: number,
  id?: string,
): Readonly<{ project: PrintSurfaceProject; placement: MarkerPlacement | undefined }> {
  const alreadyPlaced = placementsForView(project.placements, imageId).some((placement) => placement.itemId === itemId);
  if (alreadyPlaced) return { project, placement: undefined };
  const placement = createMarkerPlacement(itemId, imageId, xNormalized, yNormalized, id);
  return {
    project: { ...project, placements: [...project.placements, placement], updatedAt: new Date().toISOString() },
    placement,
  };
}

export function movePlacement(
  placements: readonly MarkerPlacement[],
  id: string,
  xNormalized: number,
  yNormalized: number,
): readonly MarkerPlacement[] {
  return placements.map((placement) =>
    placement.id === id ? { ...placement, xNormalized: clamp01(xNormalized), yNormalized: clamp01(yNormalized) } : placement,
  );
}

/**
 * Removes ONE placement (unpin this marker from this view). If that was the item's LAST placement
 * anywhere in the project, the now-orphaned item is removed too — an item with zero placements
 * would never be visible/editable again anyway, so this avoids silently accumulating zombie
 * pricing entries. Use deletePrintSurfaceItem instead when the intent is explicitly "delete this
 * whole physical surface, including every placement it has".
 */
export function removeMarkerPlacement(project: PrintSurfaceProject, placementId: string): PrintSurfaceProject {
  const target = findMarkerPlacement(project.placements, placementId);
  if (!target) return project;
  const remainingPlacements = project.placements.filter((placement) => placement.id !== placementId);
  const itemStillPlaced = remainingPlacements.some((placement) => placement.itemId === target.itemId);
  return {
    ...project,
    placements: remainingPlacements,
    items: itemStillPlaced ? project.items : project.items.filter((item) => item.id !== target.itemId),
    updatedAt: new Date().toISOString(),
  };
}

/** Deletes a physical surface AND every placement it has, on every view — the explicit "remove this plocha entirely" action. */
export function deletePrintSurfaceItem(project: PrintSurfaceProject, itemId: string): PrintSurfaceProject {
  return {
    ...project,
    items: project.items.filter((item) => item.id !== itemId),
    placements: project.placements.filter((placement) => placement.itemId !== itemId),
    updatedAt: new Date().toISOString(),
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

function nextDefaultViewLabel(existingViews: readonly PrintSurfaceView[]): string {
  return `Pohled ${existingViews.length + 1}`;
}

/**
 * Adds a brand new view (uploaded image) to the project — up to MAX_PRINT_SURFACE_VIEWS (spec
 * section 5). Silently refuses beyond the limit rather than throwing, since the UI is expected to
 * hide/disable the "add view" action once canAddPrintSurfaceView is false; callers that need to
 * distinguish "refused" from "added" can compare views.length before/after.
 */
export function addPrintSurfaceView(
  project: PrintSurfaceProject,
  image: PrintSurfaceProjectImage,
  id: string = crypto.randomUUID(),
): PrintSurfaceProject {
  if (!canAddPrintSurfaceView(project.views)) return project;
  const view: PrintSurfaceView = { id, label: nextDefaultViewLabel(project.views), image, order: project.views.length };
  return { ...project, views: [...project.views, view], updatedAt: new Date().toISOString() };
}

/** Replaces an EXISTING view's image (re-upload) — keeps its id/label/order, so placements already on it stay linked, even though their x/y may now visually mismatch the new photo (the caller is expected to warn the user before calling this — see PrintSurfaceCanvas). */
export function replacePrintSurfaceViewImage(
  project: PrintSurfaceProject,
  viewId: string,
  image: PrintSurfaceProjectImage,
): PrintSurfaceProject {
  return {
    ...project,
    views: project.views.map((view) => (view.id === viewId ? { ...view, image } : view)),
    updatedAt: new Date().toISOString(),
  };
}

export function renamePrintSurfaceView(project: PrintSurfaceProject, viewId: string, label: string): PrintSurfaceProject {
  return {
    ...project,
    views: project.views.map((view) => (view.id === viewId ? { ...view, label } : view)),
    updatedAt: new Date().toISOString(),
  };
}

export function withItems(project: PrintSurfaceProject, items: readonly PrintSurfaceItem[]): PrintSurfaceProject {
  return { ...project, items, updatedAt: new Date().toISOString() };
}

export function withPlacements(project: PrintSurfaceProject, placements: readonly MarkerPlacement[]): PrintSurfaceProject {
  return { ...project, placements, updatedAt: new Date().toISOString() };
}

export function withProjectFields(
  project: PrintSurfaceProject,
  fields: Partial<Pick<PrintSurfaceProject, "name" | "companyName" | "eventId" | "realizationCompanyId">>,
): PrintSurfaceProject {
  return { ...project, ...fields, updatedAt: new Date().toISOString() };
}

/** Manual draft/ready status toggle — never used to set "sent", see markPrintSurfaceProjectSent. */
export function setPrintSurfaceProjectStatus(
  project: PrintSurfaceProject,
  status: Extract<PrintSurfaceProjectStatus, "draft" | "ready">,
): PrintSurfaceProject {
  return { ...project, status, updatedAt: new Date().toISOString() };
}

/**
 * The ONLY way a project may become "sent" — always records who/when. Never call this just
 * because an Outlook draft or a PDF preview was opened (spec section 14) — only once a real send
 * action actually completes.
 */
export function markPrintSurfaceProjectSent(
  project: PrintSurfaceProject,
  sentBy: string | undefined,
  now: string = new Date().toISOString(),
): PrintSurfaceProject {
  return { ...project, status: "sent", sentAt: now, sentBy, updatedAt: now };
}

export type PrintSurfaceItemDimensionResolution =
  | Readonly<{ status: "available"; widthMm: number; heightMm: number; source: "catalog" | "custom" }>
  | Readonly<{ status: "unavailable" }>
  | Readonly<{ status: "not_defined" }>;

/**
 * The single source of truth for "what size does THIS item actually get produced at" —
 * fascia/custom items ALWAYS resolve from their own customWidthMm/customHeightMm and NEVER
 * consult the catalog resolver at all (spec section 11: "resolver musí bezpečně preferovat
 * explicitní custom dimension před katalogovým resolverem" — the strongest form of preference is
 * to never look at the catalog in the first place for these two types). Every other type resolves
 * through the catalog via resolvePrintSurfaceProductionDimension, unchanged.
 */
export function resolvePrintSurfaceItemDimension(
  item: Pick<PrintSurfaceItem, "typeId" | "presetId" | "customWidthMm" | "customHeightMm">,
  realizationCompanyId: string | undefined,
  productionDimensions: readonly PrintSurfaceProductionDimension[],
): PrintSurfaceItemDimensionResolution {
  if (item.typeId === "fascia" || item.typeId === "custom") {
    if (typeof item.customWidthMm === "number" && item.customWidthMm > 0 && typeof item.customHeightMm === "number" && item.customHeightMm > 0) {
      return { status: "available", widthMm: item.customWidthMm, heightMm: item.customHeightMm, source: "custom" };
    }
    return { status: "not_defined" };
  }
  const catalogResolution = resolvePrintSurfaceProductionDimension({ realizationCompanyId, presetId: item.presetId }, productionDimensions);
  if (catalogResolution.status === "available") {
    return { status: "available", widthMm: catalogResolution.widthMm, heightMm: catalogResolution.heightMm, source: "catalog" };
  }
  return catalogResolution;
}

/** The single place a resolved item dimension becomes Czech display text — Inspector, list and export must all go through this, never re-implement it. */
export function formatPrintSurfaceItemDimension(resolution: PrintSurfaceItemDimensionResolution): string {
  if (resolution.status === "available") return `${resolution.widthMm} × ${resolution.heightMm} mm`;
  if (resolution.status === "unavailable") return "Není v nabídce";
  return "Rozměr není definován";
}

/** The single place an item's display name is composed — preset display name when catalog-backed, else the plain type label (Límec/Jiná plocha). */
export function printSurfaceItemSurfaceName(item: Pick<PrintSurfaceItem, "typeId" | "presetId">, presets: readonly PrintSurfacePreset[]): string {
  const preset = findPreset(presets, item.presetId);
  return preset ? printSurfacePresetDisplayName(preset) : printSurfaceTypeLabel(item.typeId);
}

/**
 * Legacy documents (saved before V4) embedded position/imageId directly on each item — one
 * "item" WAS one placement, 1:1. Splits each such legacy item into a position-less PrintSurfaceItem
 * (+ includeInCalculation defaulted false) and its own single MarkerPlacement, so
 * already-persisted V2/V3 projects keep working under the current views[]/items[]/placements[]
 * shape rather than silently losing data — see lib/db/printSurfaceProjectRepository.supabase.ts's
 * rowToProject, the only caller. Documents already in the current shape (`placements` present)
 * pass through unchanged.
 */
export function migrateLegacyPrintSurfaceDocument(document: Readonly<{
  image?: PrintSurfaceProjectImage;
  views?: readonly PrintSurfaceView[];
  placements?: readonly MarkerPlacement[];
  items?: readonly unknown[];
}>): Readonly<{ views: readonly PrintSurfaceView[]; items: readonly PrintSurfaceItem[]; placements: readonly MarkerPlacement[] }> {
  if (document.placements) {
    return {
      views: document.views ?? [],
      items: (document.items ?? []) as readonly PrintSurfaceItem[],
      placements: document.placements,
    };
  }

  // Pre-V4: `views` may already exist (V3), or we may still be on a single pre-V3 `image`.
  let views = document.views ?? [];
  let legacyItems = (document.items ?? []) as readonly (Readonly<{
    id: string;
    label: string;
    typeId: PrintSurfaceTypeId;
    note: string;
    presetId?: string;
    customWidthMm?: number;
    customHeightMm?: number;
    quantity?: number;
    imageId?: string;
    xNormalized?: number;
    yNormalized?: number;
  }>)[];

  if (views.length === 0 && document.image) {
    const legacyViewId = "legacy-view-1";
    views = [{ id: legacyViewId, label: "Pohled 1", image: document.image, order: 0 }];
    legacyItems = legacyItems.map((item) => ({ ...item, imageId: item.imageId ?? legacyViewId }));
  }

  const items: PrintSurfaceItem[] = [];
  const placements: MarkerPlacement[] = [];
  for (const legacyItem of legacyItems) {
    const { imageId, xNormalized, yNormalized, ...rest } = legacyItem;
    items.push({ ...rest, includeInCalculation: false });
    if (imageId !== undefined && xNormalized !== undefined && yNormalized !== undefined) {
      placements.push({ id: `placement-${legacyItem.id}`, itemId: legacyItem.id, imageId, xNormalized, yNormalized });
    }
  }

  return { views, items, placements };
}
