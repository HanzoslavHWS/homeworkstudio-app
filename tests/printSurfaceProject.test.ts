import test from "node:test";
import assert from "node:assert/strict";
import {
  addMarkerPlacementForExistingItem,
  addPrintSurfaceItemWithPlacement,
  addPrintSurfaceView,
  clamp01,
  createMarkerPlacement,
  createPrintSurfaceItem,
  createPrintSurfaceProject,
  deletePrintSurfaceItem,
  findMarkerPlacement,
  findPrintSurfaceItem,
  itemForPlacement,
  itemsWithoutPlacementOnView,
  movePlacement,
  nextPrintSurfaceLabel,
  normalizeImagePosition,
  placementsForItem,
  placementsForView,
  removeMarkerPlacement,
  updatePrintSurfaceItem,
  type PrintSurfaceItem,
  type PrintSurfaceProject,
} from "../domain/printSurfaceProject.ts";
import { fitWorldToViewport, screenToWorld, worldToScreen } from "../geometry/viewport.ts";
import { PRINT_SURFACE_TYPES, printSurfaceTypeLabel } from "../domain/printSurfaceTypeCatalog.ts";

function makeItem(overrides: Partial<PrintSurfaceItem> = {}): PrintSurfaceItem {
  return {
    id: overrides.id ?? "item-1",
    label: overrides.label ?? "A",
    typeId: overrides.typeId ?? "panel",
    note: overrides.note ?? "",
    presetId: overrides.presetId,
    includeInCalculation: overrides.includeInCalculation ?? false,
  };
}

/** Mirrors the editor's "click the image with a create tool active" flow — a brand new item + its first placement, together. */
function addItem(project: PrintSurfaceProject, id: string) {
  return addPrintSurfaceItemWithPlacement(project, { typeId: "panel" }, "view-1", 0.1, 0.1, { itemId: id });
}

test("nextPrintSurfaceLabel: běžné pořadí A, B, C", () => {
  assert.equal(nextPrintSurfaceLabel([]), "A");
  assert.equal(nextPrintSurfaceLabel(["A"]), "B");
  assert.equal(nextPrintSurfaceLabel(["A", "B"]), "C");
});

test("nextPrintSurfaceLabel rolls over past Z into AA", () => {
  const allLetters = Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index));
  assert.equal(nextPrintSurfaceLabel(allLetters), "AA");
});

test("nextPrintSurfaceLabel: smazání C uvolní label C pro znovupoužití", () => {
  assert.equal(nextPrintSurfaceLabel(["A", "B", "D"]), "C");
});

test("nextPrintSurfaceLabel: ručně obsazené budoucí C -> nový marker dostane D", () => {
  assert.equal(nextPrintSurfaceLabel(["A", "B", "C"]), "D");
});

test("nextPrintSurfaceLabel: více děr v řadě vždy vyplní první volný label", () => {
  assert.equal(nextPrintSurfaceLabel(["A", "D"]), "B");
  assert.equal(nextPrintSurfaceLabel(["A", "B", "D"]), "C");
});

test("addPrintSurfaceItemWithPlacement: A, B, C, D -> smazání C -> nový marker dostane C znovu, ostatní se nepřejmenují", () => {
  const empty = createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1", "2026-01-01T00:00:00.000Z");
  const a = addItem(empty, "item-a");
  const b = addItem(a.project, "item-b");
  const c = addItem(b.project, "item-c");
  const d = addItem(c.project, "item-d");
  assert.deepEqual(d.project.items.map((item) => item.label), ["A", "B", "C", "D"]);

  const afterDeleteC = deletePrintSurfaceItem(d.project, c.item.id);
  assert.deepEqual(afterDeleteC.items.map((item) => item.label), ["A", "B", "D"]);

  const recreated = addItem(afterDeleteC, "item-new-c");
  assert.equal(recreated.item.label, "C");
  assert.deepEqual(
    recreated.project.items.filter((item) => item.id !== recreated.item.id).map((item) => item.label),
    ["A", "B", "D"],
  );
});

test("addPrintSurfaceItemWithPlacement: existuje A, B a jiný marker byl ručně přejmenován na C — nová plocha dostane D", () => {
  const empty = createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1", "2026-01-01T00:00:00.000Z");
  const a = addItem(empty, "item-a"); // "A"
  const b = addItem(a.project, "item-b"); // "B"
  const c = addItem(b.project, "item-c"); // auto "C"
  const d = addItem(c.project, "item-d"); // auto "D"
  assert.deepEqual(d.project.items.map((item) => item.label), ["A", "B", "C", "D"]);

  const afterDeleteC = deletePrintSurfaceItem(d.project, c.item.id);
  const withManualRename = { ...afterDeleteC, items: updatePrintSurfaceItem(afterDeleteC.items, d.item.id, { label: "C" }) };
  assert.deepEqual(withManualRename.items.map((item) => item.label), ["A", "B", "C"]);

  const next = addItem(withManualRename, "item-next");
  assert.equal(next.item.label, "D");
  assert.deepEqual(
    next.project.items.filter((item) => item.id !== next.item.id).map((item) => item.label),
    ["A", "B", "C"],
  );
});

test("addPrintSurfaceItemWithPlacement: více děr v řadě (A,B,C,D -> smazání B a D) -> nové plochy dostanou nejdřív B, pak D", () => {
  const empty = createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1", "2026-01-01T00:00:00.000Z");
  const a = addItem(empty, "item-a");
  const b = addItem(a.project, "item-b");
  const c = addItem(b.project, "item-c");
  const d = addItem(c.project, "item-d");
  assert.deepEqual(d.project.items.map((item) => item.label), ["A", "B", "C", "D"]);

  const afterDeletes = deletePrintSurfaceItem(deletePrintSurfaceItem(d.project, b.item.id), d.item.id);
  assert.deepEqual(afterDeletes.items.map((item) => item.label), ["A", "C"]);

  const firstNew = addItem(afterDeletes, "item-e");
  assert.equal(firstNew.item.label, "B");

  const secondNew = addItem(firstNew.project, "item-f");
  assert.equal(secondNew.item.label, "D");

  assert.deepEqual(secondNew.project.items.map((item) => item.label), ["A", "C", "B", "D"]);
});

test("createPrintSurfaceItem is a pure preview of what addPrintSurfaceItemWithPlacement would create, without mutating anything", () => {
  const project = createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1", "2026-01-01T00:00:00.000Z");
  const item = createPrintSurfaceItem(project.items, { typeId: "panel" }, "item-a");
  assert.equal(item.label, "A");
  assert.equal(item.includeInCalculation, false);
  assert.deepEqual(project.items, []); // unchanged — createPrintSurfaceItem does not mutate
});

test("clamp01 keeps values within 0..1", () => {
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(2), 1);
  assert.equal(clamp01(0.42), 0.42);
});

test("normalizeImagePosition converts pixel coordinates relative to image size", () => {
  const result = normalizeImagePosition(400, 300, 800, 600);
  assert.equal(result.xNormalized, 0.5);
  assert.equal(result.yNormalized, 0.5);
});

test("normalizeImagePosition clamps out-of-bounds pixel coordinates", () => {
  const result = normalizeImagePosition(-50, 900, 800, 600);
  assert.equal(result.xNormalized, 0);
  assert.equal(result.yNormalized, 1);
});

test("updatePrintSurfaceItem changes only the targeted item's type", () => {
  const items = [makeItem({ id: "a", label: "A", typeId: "panel" }), makeItem({ id: "b", label: "B", typeId: "panel" })];
  const next = updatePrintSurfaceItem(items, "b", { typeId: "fascia" });
  assert.equal(next.find((item) => item.id === "a")?.typeId, "panel");
  assert.equal(next.find((item) => item.id === "b")?.typeId, "fascia");
});

test("updatePrintSurfaceItem can rename a label to any custom string, including pure letters", () => {
  const items = [makeItem({ id: "a", label: "A" })];
  const next = updatePrintSurfaceItem(items, "a", { label: "Vstup" });
  assert.equal(next[0]?.label, "Vstup");
});

test("updatePrintSurfaceItem toggles includeInCalculation independently of other fields", () => {
  const items = [makeItem({ id: "a", includeInCalculation: false })];
  const next = updatePrintSurfaceItem(items, "a", { includeInCalculation: true });
  assert.equal(next[0]?.includeInCalculation, true);
});

test("movePlacement updates and clamps the normalized position of just the targeted placement", () => {
  const placements = [createMarkerPlacement("item-a", "view-1", 0.2, 0.2, "placement-a"), createMarkerPlacement("item-a", "view-2", 0.5, 0.5, "placement-b")];
  const next = movePlacement(placements, "placement-a", 0.9, 1.5);
  assert.equal(next.find((p) => p.id === "placement-a")?.xNormalized, 0.9);
  assert.equal(next.find((p) => p.id === "placement-a")?.yNormalized, 1);
  // the other placement (even for the SAME item) is untouched
  assert.equal(next.find((p) => p.id === "placement-b")?.xNormalized, 0.5);
});

test("deletePrintSurfaceItem removes the item and every one of its placements, leaving other items/placements (and their labels) untouched", () => {
  const empty = createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1");
  const a = addItem(empty, "item-a");
  const b = addItem(a.project, "item-b");
  const c = addItem(b.project, "item-c");
  const next = deletePrintSurfaceItem(c.project, b.item.id);
  assert.deepEqual(next.items.map((item) => item.id), ["item-a", "item-c"]);
  assert.deepEqual(next.items.map((item) => item.label), ["A", "C"]);
  assert.deepEqual(next.placements.map((placement) => placement.itemId), ["item-a", "item-c"]);
});

test("findPrintSurfaceItem resolves the single selected item shared by canvas and list", () => {
  const items = [makeItem({ id: "a" }), makeItem({ id: "b" })];
  assert.equal(findPrintSurfaceItem(items, "b")?.id, "b");
  assert.equal(findPrintSurfaceItem(items, "missing"), undefined);
  assert.equal(findPrintSurfaceItem(items, undefined), undefined);
});

test("findMarkerPlacement resolves the single selected placement shared by canvas and list", () => {
  const placements = [createMarkerPlacement("item-a", "view-1", 0.5, 0.5, "p-a"), createMarkerPlacement("item-b", "view-1", 0.5, 0.5, "p-b")];
  assert.equal(findMarkerPlacement(placements, "p-b")?.id, "p-b");
  assert.equal(findMarkerPlacement(placements, "missing"), undefined);
  assert.equal(findMarkerPlacement(placements, undefined), undefined);
});

test("item/placement split: jedna fyzická plocha může mít placement na dvou pohledech a zůstává to JEDEN item (spec section 9)", () => {
  let project = createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1");
  project = addPrintSurfaceView(project, { asset: { id: "asset-1", storageKey: "k1", originalFileName: "a.jpg", mimeType: "image/jpeg", size: 1, createdAt: "2026-01-01T00:00:00.000Z", category: "print-surface-image" }, widthPx: 800, heightPx: 600 }, "view-1");
  project = addPrintSurfaceView(project, { asset: { id: "asset-2", storageKey: "k2", originalFileName: "b.jpg", mimeType: "image/jpeg", size: 1, createdAt: "2026-01-01T00:00:00.000Z", category: "print-surface-image" }, widthPx: 800, heightPx: 600 }, "view-2");

  const created = addPrintSurfaceItemWithPlacement(project, { typeId: "panel" }, "view-1", 0.2, 0.2, { itemId: "item-a", placementId: "placement-1" });
  project = created.project;
  assert.equal(project.items.length, 1);

  const linked = addMarkerPlacementForExistingItem(project, "item-a", "view-2", 0.7, 0.7, "placement-2");
  project = linked.project;
  assert.equal(project.items.length, 1, "still exactly ONE physical item — pinning it on a second view never duplicates it");
  assert.equal(project.placements.length, 2);
  assert.deepEqual(placementsForItem(project.placements, "item-a").map((p) => p.imageId).sort(), ["view-1", "view-2"]);
  assert.deepEqual(placementsForView(project.placements, "view-1").map((p) => p.id), ["placement-1"]);
  assert.deepEqual(placementsForView(project.placements, "view-2").map((p) => p.id), ["placement-2"]);
  assert.equal(itemForPlacement(project.items, linked.placement)?.id, "item-a");
});

test("addMarkerPlacementForExistingItem refuses a second placement for the same item on the SAME view (no silent duplicate pin)", () => {
  const empty = createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1");
  const created = addPrintSurfaceItemWithPlacement(empty, { typeId: "panel" }, "view-1", 0.2, 0.2, { itemId: "item-a" });
  const attempt = addMarkerPlacementForExistingItem(created.project, "item-a", "view-1", 0.9, 0.9);
  assert.equal(attempt.placement, undefined);
  assert.equal(attempt.project, created.project);
  assert.equal(created.project.placements.length, 1);
});

test("itemsWithoutPlacementOnView: only offers items NOT yet pinned on the given view — what the toolbar's 'Propojit plochu' picker shows", () => {
  const empty = createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1");
  const a = addPrintSurfaceItemWithPlacement(empty, { typeId: "panel" }, "view-1", 0.1, 0.1, { itemId: "item-a" });
  const b = addPrintSurfaceItemWithPlacement(a.project, { typeId: "panel" }, "view-2", 0.1, 0.1, { itemId: "item-b" });
  const linkable = itemsWithoutPlacementOnView(b.project.items, b.project.placements, "view-1");
  assert.deepEqual(linkable.map((item) => item.id), ["item-b"]);
});

test("removeMarkerPlacement: unpinning the item's LAST placement anywhere cascades to remove the orphaned item too", () => {
  const empty = createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1");
  const created = addPrintSurfaceItemWithPlacement(empty, { typeId: "panel" }, "view-1", 0.2, 0.2, { itemId: "item-a", placementId: "placement-a" });
  const next = removeMarkerPlacement(created.project, "placement-a");
  assert.deepEqual(next.items, []);
  assert.deepEqual(next.placements, []);
});

test("removeMarkerPlacement: unpinning ONE of two placements keeps the item alive (still priced once, just fewer pins)", () => {
  const empty = createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1");
  const created = addPrintSurfaceItemWithPlacement(empty, { typeId: "panel" }, "view-1", 0.2, 0.2, { itemId: "item-a", placementId: "placement-1" });
  const linked = addMarkerPlacementForExistingItem(created.project, "item-a", "view-2", 0.7, 0.7, "placement-2");
  const next = removeMarkerPlacement(linked.project, "placement-1");
  assert.deepEqual(next.items.map((item) => item.id), ["item-a"]);
  assert.deepEqual(next.placements.map((p) => p.id), ["placement-2"]);
});

test("print surface type catalog has the 7 MVP types with stable, language-neutral ids", () => {
  const ids = PRINT_SURFACE_TYPES.map((type) => type.id);
  assert.deepEqual(ids, [
    "panel",
    "panel_above_door",
    "fascia",
    "counter_front",
    "counter_side",
    "showcase",
    "custom",
  ]);
});

test("printSurfaceTypeLabel returns the Czech label for a known type", () => {
  assert.equal(printSurfaceTypeLabel("fascia"), "Límec");
  assert.equal(printSurfaceTypeLabel("panel_above_door"), "Panel nad dveřmi");
});

test("a marker's normalized position resolves to the same image-space point regardless of viewport size or zoom", () => {
  const imageWidthPx = 2000;
  const imageHeightPx = 1200;

  const markerWorldPoint = { x: 500, y: 300 };
  const originalNormalized = normalizeImagePosition(markerWorldPoint.x, markerWorldPoint.y, imageWidthPx, imageHeightPx);

  const transformWide = fitWorldToViewport({ width: 1600, height: 900 }, { width: imageWidthPx, height: imageHeightPx });
  const transformNarrow = fitWorldToViewport({ width: 400, height: 700 }, { width: imageWidthPx, height: imageHeightPx });

  for (const transform of [transformWide, transformNarrow]) {
    const screenPoint = worldToScreen(markerWorldPoint, transform);
    const roundTrippedWorld = screenToWorld(screenPoint, transform);
    const roundTrippedNormalized = normalizeImagePosition(roundTrippedWorld.x, roundTrippedWorld.y, imageWidthPx, imageHeightPx);
    assert.ok(Math.abs(roundTrippedNormalized.xNormalized - originalNormalized.xNormalized) < 1e-9);
    assert.ok(Math.abs(roundTrippedNormalized.yNormalized - originalNormalized.yNormalized) < 1e-9);
  }
});
