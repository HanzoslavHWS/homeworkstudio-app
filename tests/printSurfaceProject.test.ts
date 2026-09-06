import test from "node:test";
import assert from "node:assert/strict";
import {
  addPrintSurfaceItem,
  clamp01,
  createPrintSurfaceItem,
  createPrintSurfaceProject,
  findPrintSurfaceItem,
  movePrintSurfaceItem,
  nextPrintSurfaceLabel,
  normalizeImagePosition,
  removePrintSurfaceItem,
  updatePrintSurfaceItem,
  type PrintSurfaceItem,
} from "../domain/printSurfaceProject.ts";
import { fitWorldToViewport, screenToWorld, worldToScreen } from "../geometry/viewport.ts";
import { PRINT_SURFACE_TYPES, printSurfaceTypeLabel } from "../domain/printSurfaceTypeCatalog.ts";

function makeItem(overrides: Partial<PrintSurfaceItem> = {}): PrintSurfaceItem {
  return {
    id: overrides.id ?? "item-1",
    label: overrides.label ?? "A",
    typeId: overrides.typeId ?? "panel",
    xNormalized: overrides.xNormalized ?? 0.5,
    yNormalized: overrides.yNormalized ?? 0.5,
    note: overrides.note ?? "",
  };
}

function addItem(project: ReturnType<typeof createPrintSurfaceProject>, id: string) {
  return addPrintSurfaceItem(project, { typeId: "panel", xNormalized: 0.1, yNormalized: 0.1 }, id);
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
  // A, B, C, D existovaly; C bylo smazáno -> zůstává A, B, D
  assert.equal(nextPrintSurfaceLabel(["A", "B", "D"]), "C");
});

test("nextPrintSurfaceLabel: ručně obsazené budoucí C -> nový marker dostane D", () => {
  // existuje A, B a jiný marker byl ručně přejmenován na C
  assert.equal(nextPrintSurfaceLabel(["A", "B", "C"]), "D");
});

test("nextPrintSurfaceLabel: více děr v řadě vždy vyplní první volný label", () => {
  // A, D existují (B a C chybí) -> první díra je B
  assert.equal(nextPrintSurfaceLabel(["A", "D"]), "B");
  // po doplnění B zbývá díra jen na C
  assert.equal(nextPrintSurfaceLabel(["A", "B", "D"]), "C");
});

test("addPrintSurfaceItem: A, B, C, D -> smazání C -> nový marker dostane C znovu, ostatní se nepřejmenují", () => {
  const empty = createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1", "2026-01-01T00:00:00.000Z");
  const a = addItem(empty, "item-a");
  const b = addItem(a.project, "item-b");
  const c = addItem(b.project, "item-c");
  const d = addItem(c.project, "item-d");
  assert.deepEqual(d.project.items.map((item) => item.label), ["A", "B", "C", "D"]);

  const afterDeleteC = { ...d.project, items: removePrintSurfaceItem(d.project.items, c.item.id) };
  assert.deepEqual(afterDeleteC.items.map((item) => item.label), ["A", "B", "D"]);

  const recreated = addItem(afterDeleteC, "item-new-c");
  assert.equal(recreated.item.label, "C");
  // existující markery zůstaly beze změny labelu
  assert.deepEqual(
    recreated.project.items.filter((item) => item.id !== recreated.item.id).map((item) => item.label),
    ["A", "B", "D"],
  );
});

test("addPrintSurfaceItem: existuje A, B a jiný marker byl ručně přejmenován na C — nová plocha dostane D", () => {
  const empty = createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1", "2026-01-01T00:00:00.000Z");
  const a = addItem(empty, "item-a"); // "A"
  const b = addItem(a.project, "item-b"); // "B"
  const c = addItem(b.project, "item-c"); // auto "C"
  const d = addItem(c.project, "item-d"); // auto "D"
  assert.deepEqual(d.project.items.map((item) => item.label), ["A", "B", "C", "D"]);

  // smažeme původní "C" (uvolníme C) a poté ručně přejmenujeme JINÝ marker (item-d, dosud "D") na "C"
  const afterDeleteC = { ...d.project, items: removePrintSurfaceItem(d.project.items, c.item.id) };
  const withManualRename = {
    ...afterDeleteC,
    items: updatePrintSurfaceItem(afterDeleteC.items, d.item.id, { label: "C" }),
  };
  assert.deepEqual(withManualRename.items.map((item) => item.label), ["A", "B", "C"]);

  // "D" je teď volné (item-d se přesunul na "C"), takže nová plocha musí dostat D, ne E
  const next = addItem(withManualRename, "item-next");
  assert.equal(next.item.label, "D");
  // existující markery (A, B a ručně přejmenované C) zůstaly beze změny
  assert.deepEqual(
    next.project.items.filter((item) => item.id !== next.item.id).map((item) => item.label),
    ["A", "B", "C"],
  );
});

test("addPrintSurfaceItem: více děr v řadě (A,B,C,D -> smazání B a D) -> nové plochy dostanou nejdřív B, pak D", () => {
  const empty = createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1", "2026-01-01T00:00:00.000Z");
  const a = addItem(empty, "item-a");
  const b = addItem(a.project, "item-b");
  const c = addItem(b.project, "item-c");
  const d = addItem(c.project, "item-d");
  assert.deepEqual(d.project.items.map((item) => item.label), ["A", "B", "C", "D"]);

  const afterDeletes = {
    ...d.project,
    items: removePrintSurfaceItem(removePrintSurfaceItem(d.project.items, b.item.id), d.item.id),
  };
  assert.deepEqual(afterDeletes.items.map((item) => item.label), ["A", "C"]);

  const firstNew = addItem(afterDeletes, "item-e");
  assert.equal(firstNew.item.label, "B");

  const secondNew = addItem(firstNew.project, "item-f");
  assert.equal(secondNew.item.label, "D");

  // existující markery (A, C a nově vytvořené B) zůstaly beze změny při vytvoření D
  assert.deepEqual(secondNew.project.items.map((item) => item.label), ["A", "C", "B", "D"]);
});

test("createPrintSurfaceItem is a pure preview of what addPrintSurfaceItem would create, without mutating anything", () => {
  const project = createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1", "2026-01-01T00:00:00.000Z");
  const item = createPrintSurfaceItem(project.items, { typeId: "panel", xNormalized: 0.5, yNormalized: 0.5 }, "item-a");
  assert.equal(item.label, "A");
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

test("movePrintSurfaceItem updates and clamps the normalized position", () => {
  const items = [makeItem({ id: "a", xNormalized: 0.2, yNormalized: 0.2 })];
  const next = movePrintSurfaceItem(items, "a", 0.9, 1.5);
  assert.equal(next[0]?.xNormalized, 0.9);
  assert.equal(next[0]?.yNormalized, 1);
});

test("removePrintSurfaceItem deletes the targeted item and leaves the rest (and their labels) untouched", () => {
  const items = [makeItem({ id: "a", label: "A" }), makeItem({ id: "b", label: "B" }), makeItem({ id: "c", label: "C" })];
  const next = removePrintSurfaceItem(items, "b");
  assert.deepEqual(next.map((item) => item.id), ["a", "c"]);
  assert.deepEqual(next.map((item) => item.label), ["A", "C"]);
});

test("findPrintSurfaceItem resolves the single selected item shared by canvas and list", () => {
  const items = [makeItem({ id: "a" }), makeItem({ id: "b" })];
  assert.equal(findPrintSurfaceItem(items, "b")?.id, "b");
  assert.equal(findPrintSurfaceItem(items, "missing"), undefined);
  assert.equal(findPrintSurfaceItem(items, undefined), undefined);
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

  // A marker sitting at a fixed spot on the image.
  const markerWorldPoint = { x: 500, y: 300 };
  const originalNormalized = normalizeImagePosition(markerWorldPoint.x, markerWorldPoint.y, imageWidthPx, imageHeightPx);

  // Fit the same image into two very different viewport sizes (simulating a window resize / Fit image).
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
