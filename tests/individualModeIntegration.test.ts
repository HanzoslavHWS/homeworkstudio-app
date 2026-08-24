import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const boothGeneratorSource = readFileSync(new URL("../components/BoothGenerator.tsx", import.meta.url), "utf8");
const componentLibrarySource = readFileSync(new URL("../components/configurator/ComponentLibrary.tsx", import.meta.url), "utf8");
const boothCadViewerSource = readFileSync(new URL("../components/configurator/BoothCadViewer.tsx", import.meta.url), "utf8");
const cad3dSource = readFileSync(new URL("../domain/cad3d.ts", import.meta.url), "utf8");

// =========================================================================================
// 1. Individual mode selection reuses the existing "Typ projektu" toggle — never a second one.
// =========================================================================================

test("INDIVIDUAL: 'Typ projektu' selector still offers both typovy and individualni — one toggle, reused, not duplicated", () => {
  assert.match(boothGeneratorSource, /setType\(\s*"typovy"\s*\)/u);
  assert.match(boothGeneratorSource, /setType\(\s*"individualni"\s*\)/u);
  assert.equal((boothGeneratorSource.match(/className="projectType"/gu) ?? []).length, 1, "exactly one project-type selector section");
});

// =========================================================================================
// 2. Step 2 branches into a real plot-size form for Individual — never the old placeholder.
// =========================================================================================

test("INDIVIDUAL: step 2 no longer shows the old 'samostatnou část generátoru' placeholder", () => {
  assert.doesNotMatch(boothGeneratorSource, /připravíme jako samostatnou/u);
});

test("INDIVIDUAL: step 2's individual branch wires both PlotSizeInput fields to individualWidthMm/individualDepthMm state", () => {
  assert.match(boothGeneratorSource, /<PlotSizeInput[\s\S]{0,120}value=\{individualWidthMm\}[\s\S]{0,60}onCommit=\{setIndividualWidthMm\}/u);
  assert.match(boothGeneratorSource, /<PlotSizeInput[\s\S]{0,120}value=\{individualDepthMm\}[\s\S]{0,60}onCommit=\{setIndividualDepthMm\}/u);
});

// =========================================================================================
// 3. Step 3 uses a booth_component-only picker for Individual — furniture/technical/inventory
// sections (ComponentLibrary) are never shown in Individual mode.
// =========================================================================================

test("INDIVIDUAL: step 3 swaps in BoothComponentLibrary for individualni+konstrukce and keeps ComponentLibrary everywhere else (typovy, AND individualni+mobiliar)", () => {
  // Turn 5 LIVE QA (report section 39-41): Mobiliář must reuse the SAME production furniture
  // catalog as typovka, never BoothComponentLibrary — so the switch is on individualSubStep, not
  // just projectType. See tests/individualWorkflowLockUX.test.ts for the Mobiliář-specific assertions.
  assert.match(
    boothGeneratorSource,
    /\{type === "individualni" && individualSubStep === "konstrukce" \? \([\s\S]{0,80}<BoothComponentLibrary[\s\S]{0,400}\) : \([\s\S]{0,80}<ComponentLibrary[\s\S]{0,150}\)\}/u,
  );
});

test("INDIVIDUAL: BoothComponentLibrary is fed the DB booth_component list (dbBoothComponents), not the static furniture catalog", () => {
  assert.match(boothGeneratorSource, /<BoothComponentLibrary[\s\S]{0,120}items=\{dbBoothComponents\}/u);
});

// =========================================================================================
// 4. No runtime GLB scaling was introduced — the only scale calls are the pre-existing
// declared model-unit conversions, never a per-catalog-dimension scale.
// =========================================================================================

test("REGRESSION: booth and component GLBs use only declared model-unit scale calls, never dimension-based scaling for Individual", () => {
  const scaleCalls = boothCadViewerSource.match(/\.scale\.setScalar\(/gu) ?? [];
  assert.equal(scaleCalls.length, 1, "component GLB scaling remains local to BoothCadViewer");
  for (const call of boothCadViewerSource.match(/\.scale\.setScalar\([^)]*\)/gu) ?? []) {
    assert.match(call, /modelUnitScaleToScene\((?:asset\.)?unit\)/u);
  }
  assert.match(cad3dSource, /root\.scale\.setScalar\(modelUnitScaleToScene\(asset\.unit\)\)/u, "booth GLB scaling lives in the shared view transform");
  assert.doesNotMatch(boothCadViewerSource, /scale\.setScalar\([^)]*(?:widthMm|depthMm|heightMm)/u);
  assert.doesNotMatch(cad3dSource, /scale\.setScalar\([^)]*(?:widthMm|depthMm|heightMm)/u);
});

// =========================================================================================
// 5. Typovka regression — the furniture/technical picker used by typovka is untouched.
// =========================================================================================

test("REGRESSION: ComponentLibrary.tsx (typovka picker) is untouched — still reads the static componentCatalogItems catalog, not the DB booth_component list", () => {
  assert.match(componentLibrarySource, /import \{ componentCatalogItems \} from "\.\.\/\.\.\/data\/components"/u);
  assert.doesNotMatch(componentLibrarySource, /booth_component/u);
});

test("REGRESSION: typovka's booth-type grid/variant-selection JSX is still gated on type === \"typovy\"", () => {
  assert.match(boothGeneratorSource, /\{type ===[\s\S]{0,20}"typovy" \? \(/u);
});
