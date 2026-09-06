import test from "node:test";
import assert from "node:assert/strict";
import {
  addPrintSurfaceItemWithPlacement,
  addPrintSurfaceView,
  canAddPrintSurfaceView,
  createPrintSurfaceProject,
  findPrintSurfaceView,
  MAX_PRINT_SURFACE_VIEWS,
  migrateLegacyPrintSurfaceDocument,
  placementsForView,
  renamePrintSurfaceView,
  replacePrintSurfaceViewImage,
  type PrintSurfaceProjectImage,
} from "../domain/printSurfaceProject.ts";

function makeImage(seed: string): PrintSurfaceProjectImage {
  return {
    asset: { id: `asset-${seed}`, storageKey: `print-surfaces/p1/image/${seed}.jpg`, originalFileName: `${seed}.jpg`, mimeType: "image/jpeg", size: 100, createdAt: "2026-01-01T00:00:00.000Z", category: "print-surface-image" },
    widthPx: 800,
    heightPx: 600,
  };
}

test("addPrintSurfaceView: první pohled dostane 'Pohled 1', druhý 'Pohled 2'", () => {
  const empty = createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1");
  const withFirst = addPrintSurfaceView(empty, makeImage("a"), "view-1");
  assert.equal(withFirst.views.length, 1);
  assert.equal(withFirst.views[0]?.label, "Pohled 1");

  const withSecond = addPrintSurfaceView(withFirst, makeImage("b"), "view-2");
  assert.equal(withSecond.views.length, 2);
  assert.equal(withSecond.views[1]?.label, "Pohled 2");
});

test("canAddPrintSurfaceView: projekt podporuje maximálně MAX_PRINT_SURFACE_VIEWS (2) pohledy", () => {
  assert.equal(MAX_PRINT_SURFACE_VIEWS, 2);
  const empty = createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1");
  const withOne = addPrintSurfaceView(empty, makeImage("a"), "view-1");
  assert.equal(canAddPrintSurfaceView(withOne.views), true);
  const withTwo = addPrintSurfaceView(withOne, makeImage("b"), "view-2");
  assert.equal(canAddPrintSurfaceView(withTwo.views), false);
});

test("addPrintSurfaceView: nad limit (2) se nic nepřidá, projekt zůstane beze změny", () => {
  const empty = createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1");
  const withTwo = addPrintSurfaceView(addPrintSurfaceView(empty, makeImage("a"), "view-1"), makeImage("b"), "view-2");
  const attemptThird = addPrintSurfaceView(withTwo, makeImage("c"), "view-3");
  assert.equal(attemptThird.views.length, 2);
  assert.deepEqual(attemptThird.views.map((v) => v.id), ["view-1", "view-2"]);
});

test("renamePrintSurfaceView: přejmenuje jen cílový pohled, ostatní beze změny", () => {
  const withTwo = addPrintSurfaceView(addPrintSurfaceView(createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1"), makeImage("a"), "view-1"), makeImage("b"), "view-2");
  const renamed = renamePrintSurfaceView(withTwo, "view-2", "Boční pohled");
  assert.equal(renamed.views.find((v) => v.id === "view-1")?.label, "Pohled 1");
  assert.equal(renamed.views.find((v) => v.id === "view-2")?.label, "Boční pohled");
});

test("replacePrintSurfaceViewImage: nahradí jen obrázek daného pohledu, id/label/order zůstávají", () => {
  const withView = addPrintSurfaceView(createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1"), makeImage("a"), "view-1");
  const replaced = replacePrintSurfaceViewImage(withView, "view-1", makeImage("new"));
  assert.equal(replaced.views[0]?.id, "view-1");
  assert.equal(replaced.views[0]?.label, "Pohled 1");
  assert.equal(replaced.views[0]?.image.asset.id, "asset-new");
});

test("placement je navázaný na konkrétní pohled (imageId) — nový placement se vytvoří vždy na AKTUÁLNĚ vybraném pohledu", () => {
  const withTwo = addPrintSurfaceView(addPrintSurfaceView(createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1"), makeImage("a"), "view-1"), makeImage("b"), "view-2");
  const { project: withMarkerOnView2 } = addPrintSurfaceItemWithPlacement(withTwo, { typeId: "panel" }, "view-2", 0.5, 0.5);
  assert.equal(withMarkerOnView2.placements.length, 1);
  assert.equal(withMarkerOnView2.placements[0]?.imageId, "view-2");
});

test("placementsForView: filtruje placements jen na daný pohled — přepnutí pohledu tedy mění, které markery jsou viditelné", () => {
  let project = addPrintSurfaceView(addPrintSurfaceView(createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1"), makeImage("a"), "view-1"), makeImage("b"), "view-2");
  project = addPrintSurfaceItemWithPlacement(project, { typeId: "panel" }, "view-1", 0.1, 0.1, { itemId: "item-a1" }).project;
  project = addPrintSurfaceItemWithPlacement(project, { typeId: "panel" }, "view-1", 0.2, 0.2, { itemId: "item-a2" }).project;
  project = addPrintSurfaceItemWithPlacement(project, { typeId: "showcase" }, "view-2", 0.3, 0.3, { itemId: "item-b1" }).project;

  const view1Placements = placementsForView(project.placements, "view-1");
  const view2Placements = placementsForView(project.placements, "view-2");
  assert.deepEqual(view1Placements.map((p) => p.itemId), ["item-a1", "item-a2"]);
  assert.deepEqual(view2Placements.map((p) => p.itemId), ["item-b1"]);
  // labels jsou project-wide, nezávisle na tom, kolik pohledů projekt má
  assert.equal(project.items.find((item) => item.id === "item-a1")?.label, "A");
  assert.equal(project.items.find((item) => item.id === "item-b1")?.label, "C");
});

test("placementsForView: bez imageId (undefined) vrací prázdné pole, nikdy nehodí chybu", () => {
  const project = createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1");
  assert.deepEqual(placementsForView(project.placements, undefined), []);
});

test("findPrintSurfaceView: najde pohled podle id, jinak undefined", () => {
  const withView = addPrintSurfaceView(createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1"), makeImage("a"), "view-1");
  assert.equal(findPrintSurfaceView(withView.views, "view-1")?.id, "view-1");
  assert.equal(findPrintSurfaceView(withView.views, "missing"), undefined);
  assert.equal(findPrintSurfaceView(withView.views, undefined), undefined);
});

test("migrateLegacyPrintSurfaceDocument: staré dokumenty s jedním `image` polem a items s vestavěnou pozicí se bezpečně migrují na views[]/items[]/placements[]", () => {
  const legacyImage = makeImage("legacy");
  const legacyDocument = {
    image: legacyImage,
    items: [{ id: "item-1", label: "A", typeId: "panel" as const, xNormalized: 0.5, yNormalized: 0.5, note: "" }],
  };
  const migrated = migrateLegacyPrintSurfaceDocument(legacyDocument);
  assert.equal(migrated.views.length, 1);
  assert.equal(migrated.views[0]?.label, "Pohled 1");
  assert.equal(migrated.views[0]?.image.asset.id, legacyImage.asset.id);
  assert.equal(migrated.items[0]?.includeInCalculation, false);
  assert.equal(migrated.placements.length, 1);
  assert.equal(migrated.placements[0]?.itemId, "item-1");
  assert.equal(migrated.placements[0]?.imageId, migrated.views[0]?.id);
});

test("migrateLegacyPrintSurfaceDocument: dokument bez views i bez image vrátí prázdný projekt (nová prázdná views[]/items[]/placements[])", () => {
  const migrated = migrateLegacyPrintSurfaceDocument({});
  assert.deepEqual(migrated.views, []);
  assert.deepEqual(migrated.items, []);
  assert.deepEqual(migrated.placements, []);
});

test("migrateLegacyPrintSurfaceDocument: dokument, který už má placements[], se nemigruje — projde beze změny", () => {
  const withView = addPrintSurfaceView(createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1"), makeImage("a"), "view-1");
  const { project } = addPrintSurfaceItemWithPlacement(withView, { typeId: "panel" }, "view-1", 0.5, 0.5);
  const migrated = migrateLegacyPrintSurfaceDocument({ views: project.views, items: project.items, placements: project.placements });
  assert.deepEqual(migrated.views, project.views);
  assert.deepEqual(migrated.placements, project.placements);
});
