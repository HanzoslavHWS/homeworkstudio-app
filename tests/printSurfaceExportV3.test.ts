import test from "node:test";
import assert from "node:assert/strict";
import {
  addMarkerPlacementForExistingItem,
  addPrintSurfaceItemWithPlacement,
  addPrintSurfaceView,
  createPrintSurfaceProject,
  type PrintSurfaceProjectImage,
} from "../domain/printSurfaceProject.ts";
import { buildPrintSurfaceExportViewModel, nextPrintSurfaceExportRevision } from "../domain/printSurfaceExport.ts";
import type { PrintSurfacePreset } from "../domain/printSurfacePreset.ts";
import type { PrintSurfaceProductionDimension } from "../domain/printSurfaceProductionDimension.ts";

function makeImage(seed: string): PrintSurfaceProjectImage {
  return {
    asset: { id: `asset-${seed}`, storageKey: `print-surfaces/p1/image/${seed}.jpg`, originalFileName: `${seed}.jpg`, mimeType: "image/jpeg", size: 100, createdAt: "2026-01-01T00:00:00.000Z", category: "print-surface-image" },
    widthPx: 800,
    heightPx: 600,
  };
}

const PRESETS: readonly PrintSurfacePreset[] = [{ id: "Panel_S_100", typeId: "panel", name: "Panel stěnový 1 x 2,5 m", isActive: true }];
const DIMENSIONS: readonly PrintSurfaceProductionDimension[] = [
  { realizationCompanyId: "creativ-expo", presetId: "Panel_S_100", status: "available", widthMm: 950, heightMm: 2340 },
];

/** item-a/item-b live on view-front, item-c on view-side — labels are PROJECT-wide (A, B, C in creation order), never per-view (see domain/printSurfaceProject.ts's PrintSurfaceItem doc). */
function buildTwoViewProject() {
  let project = createPrintSurfaceProject({ name: "Stánek se 2 pohledy", companyName: "ACME", createdBy: "jan.novak" }, "project-1");
  project = { ...project, realizationCompanyId: "creativ-expo" };
  project = addPrintSurfaceView(project, makeImage("front"), "view-front");
  project = addPrintSurfaceView(project, makeImage("side"), "view-side");
  project = addPrintSurfaceItemWithPlacement(project, { typeId: "panel", presetId: "Panel_S_100" }, "view-front", 0.2, 0.3, { itemId: "item-a", placementId: "placement-a" }).project;
  project = addPrintSurfaceItemWithPlacement(project, { typeId: "fascia", customWidthMm: 3000, customHeightMm: 300 }, "view-front", 0.5, 0.9, { itemId: "item-b", placementId: "placement-b" }).project;
  project = addPrintSurfaceItemWithPlacement(project, { typeId: "showcase" }, "view-side", 0.4, 0.4, { itemId: "item-c", placementId: "placement-c" }).project;
  return project;
}

test("export view model pro 2 obrázky: images obsahuje oba pohledy, každý jen se svými placements", () => {
  const project = buildTwoViewProject();
  const viewModel = buildPrintSurfaceExportViewModel({ project, presets: PRESETS, productionDimensions: DIMENSIONS, revision: 1 });

  assert.equal(viewModel.images.length, 2);
  const front = viewModel.images.find((image) => image.viewId === "view-front");
  const side = viewModel.images.find((image) => image.viewId === "view-side");
  assert.equal(front?.viewLabel, "Pohled 1");
  assert.equal(side?.viewLabel, "Pohled 2");
  assert.deepEqual(front?.markers.map((m) => m.label), ["A", "B"]);
  assert.deepEqual(side?.markers.map((m) => m.label), ["C"]); // labels jsou project-wide, ne per-pohled
});

test("export: markery se správně seskupí podle obrázku (žádný marker neunikne na cizí pohled)", () => {
  const viewModel = buildPrintSurfaceExportViewModel({ project: buildTwoViewProject(), presets: PRESETS, productionDimensions: DIMENSIONS, revision: 1 });
  const front = viewModel.images.find((image) => image.viewId === "view-front")!;
  const side = viewModel.images.find((image) => image.viewId === "view-side")!;
  assert.equal(front.markers.length, 2);
  assert.equal(side.markers.length, 1);
  // marker id = placement id (ne item id) — item-a/item-b patří k view-front přes svá placements, item-c k view-side
  assert.deepEqual(front.markers.map((m) => m.id).sort(), ["placement-a", "placement-b"]);
  assert.deepEqual(side.markers.map((m) => m.id), ["placement-c"]);
});

test("export: sloupec Pohled se zobrazí (showViewColumn=true) jen když je víc než 1 pohled", () => {
  const twoViews = buildPrintSurfaceExportViewModel({ project: buildTwoViewProject(), presets: PRESETS, productionDimensions: DIMENSIONS, revision: 1 });
  assert.equal(twoViews.showViewColumn, true);

  const oneViewProject = addPrintSurfaceView(createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-2"), makeImage("only"), "view-1");
  const oneView = buildPrintSurfaceExportViewModel({ project: oneViewProject, presets: PRESETS, productionDimensions: DIMENSIONS, revision: 1 });
  assert.equal(oneView.showViewColumn, false);
});

test("export: tabulkové řádky nesou správný název pohledu (viewLabel) pro každou plochu — jeden řádek na ITEM, ne na placement", () => {
  const viewModel = buildPrintSurfaceExportViewModel({ project: buildTwoViewProject(), presets: PRESETS, productionDimensions: DIMENSIONS, revision: 1 });
  const rowA = viewModel.rows.find((row) => row.label === "A" && row.surfaceName.includes("Panel"));
  const rowC = viewModel.rows.find((row) => row.label === "C");
  assert.equal(viewModel.rows.length, 3);
  assert.equal(rowA?.viewLabel, "Pohled 1");
  assert.equal(rowC?.viewLabel, "Pohled 2");
  assert.equal(rowC?.dimensionLabel, "Rozměr není definován");
});

test("summary counts: sečte plochy podle skupin (Panely/Límce/Vitríny) a total odpovídá počtu ITEMŮ", () => {
  const viewModel = buildPrintSurfaceExportViewModel({ project: buildTwoViewProject(), presets: PRESETS, productionDimensions: DIMENSIONS, revision: 1 });
  assert.equal(viewModel.summary.total, 3);
  const byId = Object.fromEntries(viewModel.summary.groups.map((g) => [g.id, g.count]));
  assert.equal(byId.panel, 1);
  assert.equal(byId.fascia, 1);
  assert.equal(byId.showcase, 1);
  assert.equal(byId.counter, undefined); // žádný pult -> skupina se vůbec nezobrazí
});

test("fascia (límec) v exportu: customWidth × 300", () => {
  const viewModel = buildPrintSurfaceExportViewModel({ project: buildTwoViewProject(), presets: PRESETS, productionDimensions: DIMENSIONS, revision: 1 });
  const fasciaRow = viewModel.rows.find((row) => row.label === "B");
  assert.equal(fasciaRow?.dimensionLabel, "3000 × 300 mm");
});

test("unavailable / not_defined v exportu se zobrazí jako smysluplný text, nikdy 0x0", () => {
  const project = buildTwoViewProject();
  const macikDimensions: readonly PrintSurfaceProductionDimension[] = [
    { realizationCompanyId: "macik", presetId: "Panel_S_100", status: "unavailable" },
  ];
  const macikProject = { ...project, realizationCompanyId: "macik" };
  const viewModel = buildPrintSurfaceExportViewModel({ project: macikProject, presets: PRESETS, productionDimensions: macikDimensions, revision: 1 });
  const panelRow = viewModel.rows.find((row) => row.label === "A");
  assert.equal(panelRow?.dimensionLabel, "Není v nabídce");
});

test("revize: nextPrintSurfaceExportRevision je počet existujících exportů + 1, jednoduchý odvozený čítač", () => {
  assert.equal(nextPrintSurfaceExportRevision(0), 1);
  assert.equal(nextPrintSurfaceExportRevision(3), 4);
});

test("item na 2 pohledech: exportní tabulka jej uvede JEN JEDNOU, s obojím pohledem spojeným v viewLabel (spec section 9)", () => {
  const project = buildTwoViewProject();
  const withSecondPlacement = addPrintSurfaceItemWithPlacement(project, { typeId: "panel" }, "view-front", 0.1, 0.1, { itemId: "item-shared", placementId: "placement-shared-front" }).project;
  // pin the SAME item (item-shared) again, this time on view-side
  const finalProject = addMarkerPlacementForExistingItem(withSecondPlacement, "item-shared", "view-side", 0.6, 0.6, "placement-shared-side").project;

  const viewModel = buildPrintSurfaceExportViewModel({ project: finalProject, presets: PRESETS, productionDimensions: DIMENSIONS, revision: 1 });
  const sharedRows = viewModel.rows.filter((row) => row.label === "D");
  assert.equal(sharedRows.length, 1, "one physical item pinned on 2 views must still produce exactly ONE export row");
  assert.equal(sharedRows[0]?.viewLabel, "Pohled 1, Pohled 2");
  assert.equal(viewModel.rows.length, 4); // A, B, C, D — never 5
});

test("print layout data mapping: view model dodá vše potřebné pro A4 layout (metadata, revize, obrázky s markery, summary, tabulka)", () => {
  const viewModel = buildPrintSurfaceExportViewModel({
    project: buildTwoViewProject(),
    presets: PRESETS,
    productionDimensions: DIMENSIONS,
    revision: 2,
    eventName: "For Beauty",
    realizationCompanyName: "Creativ Expo",
    imageUrlsByViewId: { "view-front": "https://example.test/front.jpg" },
  });
  assert.equal(viewModel.revision, 2);
  assert.equal(viewModel.eventName, "For Beauty");
  assert.equal(viewModel.realizationCompanyName, "Creativ Expo");
  assert.equal(viewModel.createdBy, "jan.novak");
  assert.equal(viewModel.images.find((i) => i.viewId === "view-front")?.imageUrl, "https://example.test/front.jpg");
  assert.equal(viewModel.images.find((i) => i.viewId === "view-side")?.imageUrl, undefined);
  assert.ok(viewModel.summary.groups.length > 0);
  assert.equal(viewModel.rows.length, 3);
  assert.equal(viewModel.showPrices, false); // default — production PDF stays price-free unless explicitly requested
});
