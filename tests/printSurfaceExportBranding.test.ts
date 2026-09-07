import test from "node:test";
import assert from "node:assert/strict";
import { buildPrintSurfaceExportViewModel } from "../domain/printSurfaceExport.ts";
import { addPrintSurfaceItemWithPlacement, createPrintSurfaceProject } from "../domain/printSurfaceProject.ts";
import { resolveEventBranding } from "../domain/eventBranding.ts";
import { normalizeExhibition } from "../domain/organizations.ts";
import type { PrintSurfacePreset } from "../domain/printSurfacePreset.ts";

// =========================================================================================
// Print Surfaces V5 (spec section 16): the export view model must READ event branding data,
// never hardcode any per-event text/logo decision itself.
// =========================================================================================

const PRESETS: readonly PrintSurfacePreset[] = [{ id: "Panel_S_100", typeId: "panel", name: "Panel stěnový 1 x 2,5 m", isActive: true }];

function fixtureProject() {
  const project = createPrintSurfaceProject({ name: "Stánek XY", companyName: "ACME" }, "project-1");
  return addPrintSurfaceItemWithPlacement(project, { typeId: "panel", presetId: "Panel_S_100" }, "view-1", 0.5, 0.5, { itemId: "item-a" }).project;
}

test("FOR BEAUTY: view model's eventBranding carries the resolved logo URL, never a hardcoded 'beauty.png'/if-string-equals-Beauty branch", () => {
  const forBeauty = normalizeExhibition({ id: "for-beauty", slug: "for-beauty-podzim-2026", name: "FOR BEAUTY" });
  const viewModel = buildPrintSurfaceExportViewModel({
    project: fixtureProject(), presets: PRESETS, productionDimensions: [], revision: 1, eventBranding: resolveEventBranding(forBeauty),
  });
  assert.equal(viewModel.eventBranding.displayName, "FOR BEAUTY");
  assert.equal(viewModel.eventBranding.logoUrl, "/events/for-beauty-podzim-2026/logo.png");
});

test("FOR ARCH: the exact same code path resolves a different slug's logo, proving no per-event special-casing exists in the view model builder", () => {
  const forArch = normalizeExhibition({ id: "for-arch", slug: "for-arch-2026", name: "FOR ARCH" });
  const viewModel = buildPrintSurfaceExportViewModel({
    project: fixtureProject(), presets: PRESETS, productionDimensions: [], revision: 1, eventBranding: resolveEventBranding(forArch),
  });
  assert.equal(viewModel.eventBranding.logoUrl, "/events/for-arch-2026/logo.png");
});

test("event bez loga (no eventBranding passed, only a plain eventName string): falls back to text-only displayName, logoUrl stays undefined", () => {
  const viewModel = buildPrintSurfaceExportViewModel({
    project: fixtureProject(), presets: PRESETS, productionDimensions: [], revision: 1, eventName: "Nepojmenovaný veletrh",
  });
  assert.equal(viewModel.eventBranding.displayName, "Nepojmenovaný veletrh");
  assert.equal(viewModel.eventBranding.logoUrl, undefined);
});

test("no event at all: view model still builds successfully with an empty-string displayName, never throws", () => {
  const viewModel = buildPrintSurfaceExportViewModel({ project: fixtureProject(), presets: PRESETS, productionDimensions: [], revision: 1 });
  assert.equal(viewModel.eventBranding.displayName, "");
  assert.equal(viewModel.eventBranding.logoUrl, undefined);
});

test("graphicsInstructions: the view model always carries a non-empty CZ instructions block, resolved via the realization-company resolver (never inline text)", () => {
  const viewModel = buildPrintSurfaceExportViewModel({
    project: fixtureProject(), presets: PRESETS, productionDimensions: [], revision: 1, realizationCompany: { id: "creativ-expo", name: "Creativ Expo" },
  });
  assert.ok(viewModel.graphicsInstructions.cs.length > 0);
  assert.ok(viewModel.graphicsInstructions.en.length > 0);
});
