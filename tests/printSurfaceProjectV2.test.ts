import test from "node:test";
import assert from "node:assert/strict";
import {
  createPrintSurfaceProject,
  formatPrintSurfaceItemDimension,
  markPrintSurfaceProjectSent,
  resolvePrintSurfaceItemDimension,
  setPrintSurfaceProjectStatus,
  summarizePrintSurfaceProject,
  type PrintSurfaceItem,
} from "../domain/printSurfaceProject.ts";
import type { PrintSurfaceProductionDimension } from "../domain/printSurfaceProductionDimension.ts";
import { buildPrintSurfaceExportViewModel } from "../domain/printSurfaceExport.ts";
import type { PrintSurfacePreset } from "../domain/printSurfacePreset.ts";

function makeItem(overrides: Partial<PrintSurfaceItem> = {}): PrintSurfaceItem {
  return {
    id: overrides.id ?? "item-1",
    label: overrides.label ?? "A",
    typeId: overrides.typeId ?? "panel",
    note: overrides.note ?? "",
    presetId: overrides.presetId,
    customWidthMm: overrides.customWidthMm,
    customHeightMm: overrides.customHeightMm,
    includeInCalculation: overrides.includeInCalculation ?? false,
  };
}

const DIMENSIONS: readonly PrintSurfaceProductionDimension[] = [
  { realizationCompanyId: "creativ-expo", presetId: "Panel_S_100", status: "available", widthMm: 950, heightMm: 2340 },
  { realizationCompanyId: "macik", presetId: "Pult_Vit_100x50_Celo", status: "unavailable" },
];

test("createPrintSurfaceProject: nový projekt má status draft a createdBy podle vstupu", () => {
  const project = createPrintSurfaceProject({ name: "Test", companyName: "ACME", createdBy: "jan.novak" }, "project-1", "2026-01-01T00:00:00.000Z");
  assert.equal(project.status, "draft");
  assert.equal(project.createdBy, "jan.novak");
  assert.equal(project.sentAt, undefined);
  assert.equal(project.sentBy, undefined);
});

test("createPrintSurfaceProject: createdBy je volitelné — bez reálného účtu zůstává undefined, nikdy fake uživatel", () => {
  const project = createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1", "2026-01-01T00:00:00.000Z");
  assert.equal(project.createdBy, undefined);
});

test("status transitions: draft -> ready je bezpečná manuální změna", () => {
  const project = createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1");
  const ready = setPrintSurfaceProjectStatus(project, "ready");
  assert.equal(ready.status, "ready");
  assert.equal(ready.sentAt, undefined);
});

test("status transitions: markPrintSurfaceProjectSent je JEDINÁ cesta k sent a vždy zapíše sentAt+sentBy společně", () => {
  const project = createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1");
  const sent = markPrintSurfaceProjectSent(project, "jan.novak", "2026-02-01T10:00:00.000Z");
  assert.equal(sent.status, "sent");
  assert.equal(sent.sentAt, "2026-02-01T10:00:00.000Z");
  assert.equal(sent.sentBy, "jan.novak");
});

test("summarizePrintSurfaceProject: itemCount odpovídá počtu markerů, souhrn neobsahuje image ani items", () => {
  const project = createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1");
  const withItems = { ...project, items: [makeItem({ id: "a" }), makeItem({ id: "b" })] };
  const summary = summarizePrintSurfaceProject(withItems);
  assert.equal(summary.itemCount, 2);
  assert.equal("items" in summary, false);
  assert.equal("image" in summary, false);
});

test("resolvePrintSurfaceItemDimension: katalogová plocha řeší přes resolver produkčních rozměrů (available)", () => {
  const item = makeItem({ typeId: "panel", presetId: "Panel_S_100" });
  const resolution = resolvePrintSurfaceItemDimension(item, "creativ-expo", DIMENSIONS);
  assert.equal(resolution.status, "available");
  assert.equal(resolution.status === "available" && resolution.source, "catalog");
  assert.equal(resolution.status === "available" && resolution.widthMm, 950);
});

test("resolvePrintSurfaceItemDimension: katalogová plocha bez realizačky/presetu je not_defined", () => {
  const item = makeItem({ typeId: "panel", presetId: undefined });
  const resolution = resolvePrintSurfaceItemDimension(item, "creativ-expo", DIMENSIONS);
  assert.equal(resolution.status, "not_defined");
});

test("resolvePrintSurfaceItemDimension: unavailable katalogová kombinace (Macík) se nikdy nezamění za not_defined", () => {
  const item = makeItem({ typeId: "counter_front", presetId: "Pult_Vit_100x50_Celo" });
  const resolution = resolvePrintSurfaceItemDimension(item, "macik", DIMENSIONS);
  assert.equal(resolution.status, "unavailable");
});

test("resolvePrintSurfaceItemDimension: Límec VŽDY preferuje customWidthMm/customHeightMm, nikdy nekonzultuje katalog (i kdyby měl presetId)", () => {
  const item = makeItem({ typeId: "fascia", presetId: "Panel_S_100", customWidthMm: 3000, customHeightMm: 300 });
  // realizačka+presetId by v katalogu odpovídaly Panel_S_100/creativ-expo (950x2340) — resolver to musí ignorovat.
  const resolution = resolvePrintSurfaceItemDimension(item, "creativ-expo", DIMENSIONS);
  assert.equal(resolution.status, "available");
  assert.equal(resolution.status === "available" && resolution.source, "custom");
  assert.equal(resolution.status === "available" && resolution.widthMm, 3000);
  assert.equal(resolution.status === "available" && resolution.heightMm, 300);
});

test("resolvePrintSurfaceItemDimension: Jiná plocha (custom) používá customWidthMm+customHeightMm", () => {
  const item = makeItem({ typeId: "custom", customWidthMm: 1200, customHeightMm: 800 });
  const resolution = resolvePrintSurfaceItemDimension(item, undefined, DIMENSIONS);
  assert.equal(resolution.status, "available");
  assert.equal(resolution.status === "available" && resolution.widthMm, 1200);
  assert.equal(resolution.status === "available" && resolution.heightMm, 800);
});

test("resolvePrintSurfaceItemDimension: Límec/Jiná plocha bez vyplněných custom rozměrů je not_defined, nikdy 0", () => {
  const fascia = makeItem({ typeId: "fascia", customWidthMm: undefined, customHeightMm: undefined });
  assert.equal(resolvePrintSurfaceItemDimension(fascia, undefined, DIMENSIONS).status, "not_defined");
  const custom = makeItem({ typeId: "custom", customWidthMm: 0, customHeightMm: 0 });
  assert.equal(resolvePrintSurfaceItemDimension(custom, undefined, DIMENSIONS).status, "not_defined");
});

test("formatPrintSurfaceItemDimension: české texty pro všechny 3 stavy", () => {
  assert.equal(formatPrintSurfaceItemDimension({ status: "available", widthMm: 950, heightMm: 700, source: "catalog" }), "950 × 700 mm");
  assert.equal(formatPrintSurfaceItemDimension({ status: "unavailable" }), "Není v nabídce");
  assert.equal(formatPrintSurfaceItemDimension({ status: "not_defined" }), "Rozměr není definován");
});

test("buildPrintSurfaceExportViewModel: sestaví řádky se správným rozměrovým textem pro katalog/límec/custom/unavailable/not_defined", () => {
  const presets: readonly PrintSurfacePreset[] = [{ id: "Panel_S_100", typeId: "panel", name: "Panel stěnový 1 x 2,5 m", isActive: true }];
  const project = {
    ...createPrintSurfaceProject({ name: "Stánek XY", companyName: "ACME", createdBy: "jan.novak" }, "project-1"),
    realizationCompanyId: "creativ-expo",
    views: [{ id: "view-1", label: "Pohled 1", order: 0, image: { asset: { id: "asset-1", storageKey: "print-surfaces/project-1/image/a.jpg", originalFileName: "a.jpg", mimeType: "image/jpeg", size: 100, createdAt: "2026-01-01T00:00:00.000Z", category: "print-surface-image" as const }, widthPx: 800, heightPx: 600 } }],
    items: [
      makeItem({ id: "a", label: "A", typeId: "panel", presetId: "Panel_S_100" }),
      makeItem({ id: "b", label: "B", typeId: "fascia", customWidthMm: 3000, customHeightMm: 300 }),
      makeItem({ id: "c", label: "C", typeId: "custom", customWidthMm: 500, customHeightMm: 400 }),
      makeItem({ id: "d", label: "D", typeId: "counter_front", presetId: "Pult_Vit_100x50_Celo" }),
      makeItem({ id: "e", label: "E", typeId: "panel", presetId: undefined }),
    ],
  };
  const viewModel = buildPrintSurfaceExportViewModel({
    project,
    presets,
    productionDimensions: DIMENSIONS,
    revision: 1,
    eventName: "For Beauty",
    realizationCompanyName: "Creativ Expo",
  });

  assert.equal(viewModel.projectName, "Stánek XY");
  assert.equal(viewModel.createdBy, "jan.novak");
  assert.equal(viewModel.rows.length, 5);
  assert.equal(viewModel.rows[0]?.dimensionLabel, "950 × 2340 mm");
  assert.equal(viewModel.rows[1]?.dimensionLabel, "3000 × 300 mm");
  assert.equal(viewModel.rows[2]?.dimensionLabel, "500 × 400 mm");
  // DIMENSIONS only has a Pult_Vit_100x50_Celo row for "macik", not "creativ-expo" (this project's
  // realizationCompanyId) — so this resolves to not_defined here, not unavailable. The distinct
  // "unavailable" case is already covered directly by the resolvePrintSurfaceItemDimension test above.
  assert.equal(viewModel.rows[3]?.dimensionLabel, "Rozměr není definován");
  assert.equal(viewModel.rows[4]?.dimensionLabel, "Rozměr není definován");
});
