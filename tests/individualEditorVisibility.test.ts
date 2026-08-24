import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const plotEditorSource = readFileSync(new URL("../components/configurator/PlotPolygonEditor.tsx", import.meta.url), "utf8");
const globalsCss = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const boothGeneratorSource = readFileSync(new URL("../components/BoothGenerator.tsx", import.meta.url), "utf8");
const useBoothViewportSource = readFileSync(new URL("../hooks/useBoothViewport.ts", import.meta.url), "utf8");

// =========================================================================================
// Section 17 (Plocha/Podlaha editor visibility) — these pin the EXACT bug that made the
// browser-tested drawing canvas invisible: PlotPolygonEditor reused the shared boothViewport/
// canvasArea/viewportStage classes, which carry a global `.boothViewport { height: 100% }`
// override elsewhere in globals.css that only resolves against the typovka configurator's own
// CSS-grid ancestor — standalone, it collapsed to 0 height. There is no React Testing Library/
// jsdom in this project (every existing test in tests/ is domain/geometry-level or a source-scan
// regression guard against a real, browser-verified bug — see tests/individualModeIntegration.
// test.ts's own convention) — the actual fix was verified live via a temporary Playwright
// session (screenshots), not by these tests; these tests exist to make sure nobody accidentally
// reintroduces the exact class-name collision or the percentage-height dependency.
// =========================================================================================

test("PLOCHA/PODLAHA EDITOR VISIBILITY: PlotPolygonEditor never reuses the shared boothViewport/canvasArea/viewportStage classes — it has its own dedicated, self-contained ones", () => {
  assert.doesNotMatch(plotEditorSource, /className="boothViewport/u);
  assert.doesNotMatch(plotEditorSource, /className="canvasArea"/u);
  assert.doesNotMatch(plotEditorSource, /className="viewportStage"/u);
  assert.match(plotEditorSource, /className="plotEditorViewportArea"/u);
  assert.match(plotEditorSource, /"plotEditorViewport panning"|"plotEditorViewport panReady"|"plotEditorViewport"/u);
  assert.match(plotEditorSource, /className="plotEditorViewportStage"/u);
});

test("PLOCHA/PODLAHA EDITOR VISIBILITY: .plotEditorViewport has an explicit, self-contained height — never a bare percentage that depends on an ancestor grid/flex context it doesn't have here", () => {
  const rule = globalsCss.match(/\.plotEditorViewport\s*\{[^}]*\}/u);
  assert.ok(rule, "expected to find the .plotEditorViewport rule");
  assert.match(rule![0], /height:\s*min\(/u, "expected an explicit min()-based height, not a bare percentage");
  assert.doesNotMatch(rule![0], /height:\s*100%/u);
});

test("PLOCHA/PODLAHA EDITOR VISIBILITY: the real render path exists — grid lines, the drawn/reference shape polygon(s), and vertex handles are all actually emitted, not just a container div", () => {
  assert.match(plotEditorSource, /<line[\s\S]{0,60}className=\{`plotGridLine/u);
  assert.match(plotEditorSource, /<polygon[\s\S]{0,120}shapeClassName/u);
  assert.match(plotEditorSource, /<circle[\s\S]{0,60}className=\{\["plotVertex"/u);
});

test("PLOCHA/PODLAHA EDITOR VISIBILITY: Podlaha always renders PlotPolygonEditor once a plot exists — even before any floor zone is selected (readOnly preview), never an empty panel with no canvas at all", () => {
  const podlahaBranch = boothGeneratorSource.match(/individualSubStep === "podlaha" \? \([\s\S]*?\n    \) : null;/u);
  assert.ok(podlahaBranch, "expected to find the Podlaha sub-step panel branch");
  assert.match(podlahaBranch![0], /\{individualPlotPolygon && \(\s*<PlotPolygonEditor/u, "PlotPolygonEditor must render whenever a plot exists, not only when editingFloorZone is set");
  // Turn 5 (floor zone lock, section 8): read-only both when no zone is selected AND when the
  // selected zone is already confirmed/locked — editing a confirmed zone requires "Upravit zónu" first.
  assert.match(podlahaBranch![0], /readOnly=\{!editingFloorZone \|\| editingFloorZoneConfirmed\}/u);
});

// =========================================================================================
// Section 19 (wheel/Ctrl+wheel) — the wheel-attaching effect must re-run when the DOM element
// it measures gets freshly (re)mounted by a conditionally-rendered caller (Individual mode's
// tabs), not just when `enabled` changes. This was the second real bug found in browser
// testing: `enabled` was already true while the user was on Plocha/Podlaha (before
// .configuratorWorkspace ever mounted), so the wheel effect ran once against a null ref and
// never attached a listener for the whole rest of that element's later lifetime.
// =========================================================================================

test("WHEEL FIX: the wheel-listener effect depends on fitKey (not just enabled) so it re-attaches when its DOM element is freshly (re)mounted by a tab switch", () => {
  const wheelEffect = useBoothViewportSource.match(/const handleWheel = \(event: WheelEvent\) => \{[\s\S]*?\}, \[[^\]]*\]\);/u);
  assert.ok(wheelEffect, "expected to find the wheel-effect block");
  assert.match(wheelEffect![0], /\[enabled, fitKey\]/u);
});

test("WHEEL FIX: the size-measuring effect (ResizeObserver + initial fit) also depends on fitKey, for the same reason", () => {
  const sizeEffect = useBoothViewportSource.match(/const updateSize = \(\) => \{[\s\S]*?\}, \[[^\]]*\]\);/u);
  assert.ok(sizeEffect, "expected to find the size-measuring effect block");
  assert.match(
    sizeEffect![0],
    /\[enabled, worldWidthMm, worldHeightMm, fitKey, initialFitReady\]/u,
  );
});

test("WHEEL FIX: the wheel handler always preventDefault()s (never gated on ctrlKey) — plain wheel zooms the plan directly, and since the listener is element-scoped, wheel events outside it are never touched", () => {
  const handler = useBoothViewportSource.match(/const handleWheel = \(event: WheelEvent\) => \{[\s\S]*?\n    \};/u);
  assert.ok(handler);
  assert.doesNotMatch(handler![0], /if \(!event\.ctrlKey\)/u);
  assert.match(handler![0], /event\.preventDefault\(\);/u);
});

test("WHEEL FIX: the wheel listener is attached with { passive: false } directly on the specific viewport element (never window/document)", () => {
  assert.match(useBoothViewportSource, /element\.addEventListener\("wheel", handleWheel, \{ passive: false \}\);/u);
});

// =========================================================================================
// Section 5/6/9 (Fit priority + shared architecture) — the shared boothViewport instance
// (Konstrukce/Mobiliář) is wired to prioritize the real plot bounds over the full workspace,
// and re-fits whenever Individual mode's sub-step changes.
// =========================================================================================

test("FIT PRIORITY: the shared boothViewport uses plot bounds and keys typovka fit by its current visual", () => {
  const hookCall = boothGeneratorSource.match(/const boothViewport = useBoothViewport\(\{[\s\S]*?\n  \}\);/u);
  assert.ok(hookCall, "expected to find the shared boothViewport hook call");
  assert.match(hookCall![0], /fitBounds: individualPlotFitBounds/u);
  assert.match(hookCall![0], /\? individualSubStep[\s\S]*?: \(selectedBoothPlanVisualKey \?\? "typovka"\)/u);
  assert.match(hookCall![0], /initialFitReady:/u);
});

test("FIT PRIORITY: individualPlotFitBounds is computed through worldToPlanView (display space), never raw world coordinates — the exact mismatch that mis-framed the very first Plocha screenshot in browser testing", () => {
  const boundsComputation = boothGeneratorSource.match(/const individualPlotFitBounds =[\s\S]{0,500}?;/u);
  assert.ok(boundsComputation, "expected to find the individualPlotFitBounds computation");
  assert.match(boundsComputation![0], /worldToPlanView\(/u);
});

test("REGRESSION: the Fit button uses individualPlotFitBounds when available, falling back to the existing typovka scenePlanBounds computation — typovka's own Fit math is completely untouched", () => {
  assert.match(boothGeneratorSource, /onFit=\{editorView === "3d" \? \(\) => booth3DCameraControlsRef\.current\?\.fit\(\) : \(\) => boothViewport\.fitToContent\(individualPlotFitBounds \?\? scenePlanBounds\(/u);
});
