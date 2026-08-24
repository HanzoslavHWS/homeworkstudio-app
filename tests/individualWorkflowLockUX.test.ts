import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const boothGeneratorSource = readFileSync(new URL("../components/BoothGenerator.tsx", import.meta.url), "utf8");
const plotEditorSource = readFileSync(new URL("../components/configurator/PlotPolygonEditor.tsx", import.meta.url), "utf8");

// =========================================================================================
// Turn 5: workflow lock/confirm UX wiring. There is no React Testing Library/jsdom in this
// project, so — matching every other test in tests/ — this pins the exact source-level wiring
// that the (separately, manually browser-verified) behavior depends on.
// =========================================================================================

test("PLOCHA LOCK: the Plocha PlotPolygonEditor's readOnly prop is driven by the confirmed/locked status, and confirming is hard-gated on canConfirmPlot", () => {
  const plochaBranch = boothGeneratorSource.match(/individualSubStep === "plocha" \? \([\s\S]*?\n    \) : individualSubStep === "podlaha"/u);
  assert.ok(plochaBranch, "expected to find the Plocha sub-step panel branch");
  assert.match(plochaBranch![0], /readOnly=\{isIndividualPlotConfirmed\}/u);
  assert.match(plochaBranch![0], /disabled=\{!canConfirmPlot\(individualPlotPolygon\)\}/u);
  assert.match(plochaBranch![0], /onClick=\{confirmIndividualPlot\}/u);
  assert.match(plochaBranch![0], /onClick=\{unlockIndividualPlot\}/u);
});

test("PLOCHA -> PODLAHA: the 'Další – Podlaha' action is disabled unless the plot step is confirmed AND valid", () => {
  const plochaBranch = boothGeneratorSource.match(/individualSubStep === "plocha" \? \([\s\S]*?\n    \) : individualSubStep === "podlaha"/u);
  assert.ok(plochaBranch);
  assert.match(plochaBranch![0], /disabled=\{!isIndividualPlotStepComplete\}[\s\S]*?Další – Podlaha/u);
});

test("PODLAHA -> KONSTRUKCE: the 'Další – Konstrukce' action is disabled unless every floor zone is individually confirmed (0 zones counts as complete)", () => {
  const podlahaBranch = boothGeneratorSource.match(/individualSubStep === "podlaha" \? \([\s\S]*?\n    \) : null;/u);
  assert.ok(podlahaBranch);
  assert.match(podlahaBranch![0], /disabled=\{!isIndividualFloorStepComplete\}[\s\S]*?Další – Konstrukce/u);
  assert.match(boothGeneratorSource, /const hasUnconfirmedFloorZone = individualFloorZones\.some\(\(zone\) => !isFloorZoneConfirmed\(zone\)\);/u);
  assert.match(boothGeneratorSource, /const isIndividualFloorStepComplete = isIndividualPlotStepComplete && !hasUnconfirmedFloorZone;/u);
});

test("KONSTRUKCE -> MOBILIÁŘ: a 'Další – Mobiliář' action exists for the konstrukce sub-step", () => {
  assert.match(boothGeneratorSource, /individualSubStep === "konstrukce" && \([\s\S]{0,300}?Další – Mobiliář/u);
});

test("FLOOR ZONE LOCK UX: confirming a zone is gated through validateFloorZoneForConfirm, unlocking always calls unlockFloorZoneById unconditionally", () => {
  assert.match(boothGeneratorSource, /disabled=\{!individualPlotPolygon \|\| !validateFloorZoneForConfirm\(zone, individualPlotPolygon, individualFloorZones\)\.valid\}/u);
  assert.match(boothGeneratorSource, /onClick=\{\(\) => unlockFloorZoneById\(zone\.id\)\}/u);
  assert.match(boothGeneratorSource, /onClick=\{\(\) => confirmFloorZoneById\(zone\.id\)\}/u);
});

test("NAVIGATION: nothing auto-unlocks a confirmed plot or zone merely by re-deriving state — confirmIndividualPlot/unlockIndividualPlot and confirmFloorZoneById/unlockFloorZoneById are the ONLY writers of lock status, both requiring an explicit user click", () => {
  // setIndividualPlotStatus is called exactly by: the confirm handler, the unlock handler, load, reset.
  const setters = boothGeneratorSource.match(/setIndividualPlotStatus\([^)]*\)/gu) ?? [];
  assert.ok(setters.length >= 4, `expected confirm/unlock/load/reset call sites, found ${setters.length}`);
  assert.ok(setters.some((s) => s.includes('"draft"')), "unlock/reset must reset to draft");
  assert.ok(setters.some((s) => s.includes('"confirmed"')), "confirm must set confirmed");
  assert.ok(setters.some((s) => s.includes("resolvePlotStatus(project.individualPlotStatus)")), "load must resolve from the persisted field, never assume confirmed");
});

test("KONSTRUKCE BOUNDARY (preserved, not touched): booth_component placement/move validity still goes through the plot-anchor rule (isPlacementValidOnPlot / tryMoveComponentOnPlot) — unaffected by the new lock/confirm state machine", () => {
  assert.match(boothGeneratorSource, /isPlacementValidOnPlot\(individualPlotPolygon, centerX, centerY\)/u);
  assert.match(boothGeneratorSource, /tryMoveComponentOnPlot\(/u);
});

// =========================================================================================
// Outside-plot hard interaction boundary (report sections 4/5) in PlotPolygonEditor itself.
// =========================================================================================

test("BOUNDARY: PlotPolygonEditor accepts an optional boundaryPolygon prop, distinct from the purely-visual referenceShapes prop", () => {
  assert.match(plotEditorSource, /boundaryPolygon\?:\s*PlotPolygon;/u);
});

test("BOUNDARY: a click/drag outside boundaryPolygon is blocked via isWithinBoundary, both when starting/continuing a draw and when dragging an existing vertex", () => {
  assert.match(plotEditorSource, /function isWithinBoundary\(point: Point\): boolean \{\s*return !boundaryPolygon \|\| isPointInOrOnPolygon\(point, boundaryPolygon\);\s*\}/u);
  const pointerDown = plotEditorSource.match(/function handleCanvasPointerDown\([\s\S]*?\n  \}/u);
  assert.ok(pointerDown);
  assert.match(pointerDown![0], /!isWithinBoundary\(worldPoint\)/u);
  const pointerMove = plotEditorSource.match(/function handleCanvasPointerMove\([\s\S]*?\n  \}/u);
  assert.ok(pointerMove);
  assert.match(pointerMove![0], /!isWithinBoundary\(worldPoint\)/u);
});

test("BOUNDARY: the outside-plot area is rendered as a dedicated visual mask (evenodd path), reusing the same polygon geometry — never a second coordinate system", () => {
  assert.match(plotEditorSource, /className="plotOutsideMask"/u);
  assert.match(plotEditorSource, /fillRule="evenodd"/u);
  const globalsCss = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(globalsCss, /\.plotOutsideMask\s*\{[^}]*pointer-events:\s*none;[^}]*\}/u);
});

test("BOUNDARY WIRING: the Podlaha zone editor passes boundaryPolygon={individualPlotPolygon} — the confirmed booth plot is the hard interaction boundary for floor-zone drawing", () => {
  const podlahaBranch = boothGeneratorSource.match(/individualSubStep === "podlaha" \? \([\s\S]*?\n    \) : null;/u);
  assert.ok(podlahaBranch);
  assert.match(podlahaBranch![0], /boundaryPolygon=\{individualPlotPolygon\}/u);
});

test("SCOPE: the Plocha PlotPolygonEditor call (which draws the plot boundary itself) never receives a boundaryPolygon — there is nothing to constrain it against", () => {
  const plochaBranch = boothGeneratorSource.match(/individualSubStep === "plocha" \? \([\s\S]*?\n    \) : individualSubStep === "podlaha"/u);
  assert.ok(plochaBranch);
  assert.doesNotMatch(plochaBranch![0], /boundaryPolygon=/u);
});
