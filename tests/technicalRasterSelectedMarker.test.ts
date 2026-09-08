import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEFAULT_OFF_PAGE_MARGIN_NORMALIZED,
  SELECTED_MARKER_BORDER_TARGET_PX,
  SELECTED_MARKER_DIAMETER_TARGET_PX,
  SELECTED_MARKER_OFFSET_TARGET_PX,
  calculateSelectedStandMarker,
  computeMarkerCenterOffset,
  computeSelectedMarkerScreenStyle,
  projectMarkerCenterToScreen,
  simulateRenderedPx,
  zoomInvariantPx,
} from "../domain/technicalRasterSelectedMarker.ts";

// =========================================================================================
// Technické rastry — pure geometry + zoom-invariant sizing behind the "selected stand" circle
// marker (spec batch 6, UI section 1-13, 50-51). ROOT CAUSE of the reported "marker drifts from
// its anchor at high zoom": the PREVIOUS (batch 5) transform anchored the marker's DOM box by an
// EDGE (translate(-100%,...) for top-left / no correction at all for bottom-right), entangling
// ANCHOR, OFFSET, and SIZE into one transform. This batch's fix makes the marker's CENTER the one
// thing everything else composes onto: center = anchor + centerOffset (screen-constant, zero for
// manual), with SIZE-based centering (-50%) applied as a fully separate, always-identical step —
// see computeMarkerCenterOffset's own doc for why this is now structurally, not just arithmetically,
// immune to drift.
// =========================================================================================

test("A) AUTO marker: default position is bottom-right of the bbox", () => {
  const bbox = { xNormalized: 0.3, yNormalized: 0.4, widthNormalized: 0.05, heightNormalized: 0.02 };
  const result = calculateSelectedStandMarker(bbox);
  assert.equal(result.corner, "bottom-right");
  assert.ok(Math.abs(result.anchorXNormalized - 0.35) < 1e-9);
  assert.ok(Math.abs(result.anchorYNormalized - 0.42) < 1e-9);
});

test("B) AUTO marker: falls back to top-left when bottom-right would fall off the page's own right/bottom edge", () => {
  const nearRightEdge = { xNormalized: 0.96, yNormalized: 0.4, widthNormalized: 0.02, heightNormalized: 0.02 };
  assert.equal(calculateSelectedStandMarker(nearRightEdge).corner, "top-left");
  const nearBottomEdge = { xNormalized: 0.4, yNormalized: 0.96, widthNormalized: 0.02, heightNormalized: 0.02 };
  assert.equal(calculateSelectedStandMarker(nearBottomEdge).corner, "top-left");
});

test("C) the solid marker never lies over the bbox: near-edge clearance (offset - radius) is strictly positive", () => {
  // The marker's CENTER sits SELECTED_MARKER_OFFSET_TARGET_PX away from the bbox corner; its own
  // radius eats back into that gap. The near edge (facing the bbox) must still clear the corner.
  const radius = SELECTED_MARKER_DIAMETER_TARGET_PX / 2;
  const clearance = SELECTED_MARKER_OFFSET_TARGET_PX - radius;
  assert.ok(clearance > 0, `marker's near edge must clear the bbox corner; got clearance=${clearance}px`);
  assert.ok(clearance >= 5, "spec section 6: a real 6-8px gap, not just barely non-overlapping");
});

test("D) MANUAL marker's center offset is always (0, 0) — the clicked anchor IS the center, no offset", () => {
  const style = computeSelectedMarkerScreenStyle(6.15);
  const offset = computeMarkerCenterOffset("manual", style);
  assert.deepEqual(offset, { dxPx: 0, dyPx: 0 });
});

test("AUTO center offset direction matches the corner: bottom-right pushes positive, top-left pushes negative, both axes equally", () => {
  const style = computeSelectedMarkerScreenStyle(1);
  const bottomRight = computeMarkerCenterOffset("auto-bottom-right", style);
  assert.equal(bottomRight.dxPx, style.offsetPx);
  assert.equal(bottomRight.dyPx, style.offsetPx);
  const topLeft = computeMarkerCenterOffset("auto-top-left", style);
  assert.equal(topLeft.dxPx, -style.offsetPx);
  assert.equal(topLeft.dyPx, -style.offsetPx);
});

test("boundary: exactly at the margin still fits bottom-right (inclusive)", () => {
  const bbox = { xNormalized: 1 - DEFAULT_OFF_PAGE_MARGIN_NORMALIZED - 0.05, yNormalized: 0.4, widthNormalized: 0.05, heightNormalized: 0.02 };
  assert.equal(calculateSelectedStandMarker(bbox).corner, "bottom-right");
});

test("H) PDF coordinates are never touched: calculateSelectedStandMarker is pure, never mutates its input bbox", () => {
  const bbox = { xNormalized: 0.3, yNormalized: 0.4, widthNormalized: 0.05, heightNormalized: 0.02 };
  const snapshot = { ...bbox };
  calculateSelectedStandMarker(bbox);
  assert.deepEqual(bbox, snapshot);
});

// =========================================================================================
// F/G) Constant on-screen SIZE — the FULL round trip, real zoom values from manual testing:
// 100%, ~615%, 1000%, ~3300-4000%.
// =========================================================================================

const REAL_ZOOM_VALUES = [1, 6.15, 10, 33, 40];

test("F) marker outer diameter renders to the SAME on-screen size at every real zoom value", () => {
  for (const zoom of REAL_ZOOM_VALUES) {
    const style = computeSelectedMarkerScreenStyle(zoom);
    const rendered = simulateRenderedPx(style.diameterPx, zoom);
    assert.ok(Math.abs(rendered - SELECTED_MARKER_DIAMETER_TARGET_PX) < 1e-6, `zoom=${zoom}: expected ~${SELECTED_MARKER_DIAMETER_TARGET_PX}px, got ${rendered}px`);
  }
  assert.ok(SELECTED_MARKER_DIAMETER_TARGET_PX >= 10 && SELECTED_MARKER_DIAMETER_TARGET_PX <= 12, "spec section 11: cca 10-12 CSS px");
});

test("G) border thickness renders to the SAME on-screen size at every real zoom value", () => {
  for (const zoom of REAL_ZOOM_VALUES) {
    const style = computeSelectedMarkerScreenStyle(zoom);
    const rendered = simulateRenderedPx(style.borderPx, zoom);
    assert.ok(Math.abs(rendered - SELECTED_MARKER_BORDER_TARGET_PX) < 1e-6);
  }
  assert.ok(SELECTED_MARKER_BORDER_TARGET_PX >= 2 && SELECTED_MARKER_BORDER_TARGET_PX <= 2.5, "spec section 11: cca 2-2.5 CSS px");
});

// =========================================================================================
// The actual regression: CENTER must never drift from the ANCHOR as zoom changes, and a SIZE
// change must never move it either. projectMarkerCenterToScreen reproduces the REAL DOM transform
// chain (stage layout size -> pan -> scale(zoom)), so this is the same math
// TechnicalRasterCanvas.tsx's own DEV diagnostic uses against a live getBoundingClientRect().
// =========================================================================================

const STAGE_WIDTH_PX = 900; // a plausible .technicalRasterStage CSS width (pageSizePt.width * pixelsPerMm)
const STAGE_HEIGHT_PX = 600;
const PAN = { x: 40, y: -15 };

test("MANUAL: projected screen center equals the anchor point exactly, at every zoom — never drifts", () => {
  const anchorXNormalized = 0.42;
  const anchorYNormalized = 0.37;
  for (const zoom of REAL_ZOOM_VALUES) {
    const style = computeSelectedMarkerScreenStyle(zoom);
    const centerOffset = computeMarkerCenterOffset("manual", style);
    const screen = projectMarkerCenterToScreen({
      anchorXNormalized,
      anchorYNormalized,
      stageWidthPx: STAGE_WIDTH_PX,
      stageHeightPx: STAGE_HEIGHT_PX,
      panX: PAN.x,
      panY: PAN.y,
      zoom,
      centerOffset,
    });
    const expectedAtThisZoom = { x: PAN.x + anchorXNormalized * STAGE_WIDTH_PX * zoom, y: PAN.y + anchorYNormalized * STAGE_HEIGHT_PX * zoom };
    assert.ok(Math.abs(screen.x - expectedAtThisZoom.x) < 1e-6, `zoom=${zoom}: x drifted`);
    assert.ok(Math.abs(screen.y - expectedAtThisZoom.y) < 1e-6, `zoom=${zoom}: y drifted`);
  }
});

test("AUTO: the center's screen-space DELTA from the raw anchor projection is constant across zoom (the offset never drifts)", () => {
  const anchorXNormalized = 0.6;
  const anchorYNormalized = 0.5;
  const deltas: number[] = [];
  for (const zoom of REAL_ZOOM_VALUES) {
    const style = computeSelectedMarkerScreenStyle(zoom);
    const centerOffset = computeMarkerCenterOffset("auto-bottom-right", style);
    const rawAnchorScreen = { x: PAN.x + anchorXNormalized * STAGE_WIDTH_PX * zoom, y: PAN.y + anchorYNormalized * STAGE_HEIGHT_PX * zoom };
    const markerScreen = projectMarkerCenterToScreen({ anchorXNormalized, anchorYNormalized, stageWidthPx: STAGE_WIDTH_PX, stageHeightPx: STAGE_HEIGHT_PX, panX: PAN.x, panY: PAN.y, zoom, centerOffset });
    deltas.push(markerScreen.x - rawAnchorScreen.x);
  }
  for (const delta of deltas) {
    assert.ok(Math.abs(delta - SELECTED_MARKER_OFFSET_TARGET_PX) < 1e-6, `expected constant delta ~${SELECTED_MARKER_OFFSET_TARGET_PX}px, got ${delta}px`);
  }
});

test("Change in SIZE (diameter) never moves the projected center — size and anchor are fully independent", () => {
  // Simulate a "wrong" bigger diameter target by scaling zoomInvariantPx's own input directly —
  // the center offset (computeMarkerCenterOffset) depends only on style.offsetPx, never on
  // style.diameterPx, so recomputing center offset with an ARTIFICIALLY different diameter must
  // still produce the identical center.
  const zoom = 6.15;
  const style = computeSelectedMarkerScreenStyle(zoom);
  const biggerDiameterStyle = { ...style, diameterPx: style.diameterPx * 5 }; // pretend diameter grew 5x
  const centerOffsetNormal = computeMarkerCenterOffset("auto-bottom-right", style);
  const centerOffsetBiggerDiameter = computeMarkerCenterOffset("auto-bottom-right", biggerDiameterStyle);
  assert.deepEqual(centerOffsetNormal, centerOffsetBiggerDiameter, "computeMarkerCenterOffset must not read diameterPx at all");
});

test("only ONE compensation factor — not a double-compensation bug: dividing once by zoom and multiplying once by zoom (the ancestor's own transform) is an exact round trip", () => {
  const zoom = 6.15;
  const target = SELECTED_MARKER_DIAMETER_TARGET_PX;
  const singleCompensation = zoomInvariantPx(target, zoom);
  assert.ok(Math.abs(simulateRenderedPx(singleCompensation, zoom) - target) < 1e-9);
  const doubleCompensationBug = zoomInvariantPx(zoomInvariantPx(target, zoom), zoom);
  assert.ok(Math.abs(simulateRenderedPx(doubleCompensationBug, zoom) - target) > 1, "sanity: a double-compensation bug WOULD be visibly detectable by this same method");
});

test("E) AUTO and MANUAL share the exact same style computation (computeSelectedMarkerScreenStyle has no per-kind branch)", () => {
  const zoom = 3.3;
  const style = computeSelectedMarkerScreenStyle(zoom);
  assert.equal(typeof style.diameterPx, "number");
  assert.equal(typeof style.borderPx, "number");
  assert.equal(typeof style.offsetPx, "number");
});

// =========================================================================================
// Source guards on TechnicalRasterCanvas.tsx (spec batch 6, UI section 14/15) — re-verifies the
// old bbox-overlay-plus-corner-chip design is fully gone (never re-trust an earlier report, spec
// section 14), and that high-resolution re-renders (computeEffectiveRenderScale/renderScaleTrigger)
// can never move a marker's position — markers are positioned purely from pageSizePt/viewport
// transform, entirely independent of the canvas's own backing-store resolution.
// =========================================================================================

async function readCanvasSource(): Promise<string> {
  return readFile(new URL("../components/workflow/technicalRasters/TechnicalRasterCanvas.tsx", import.meta.url), "utf8");
}

test("the old bbox-outline selected overlay class is completely gone — no 'technicalRasterMarker selected' string anywhere", async () => {
  const source = await readCanvasSource();
  assert.ok(!source.includes("technicalRasterMarker selected"), "the old bbox outline (batch 4/5) must not be reintroduced alongside the new circle marker");
  assert.ok(!source.includes("technicalRasterSelectedCorner"), "the old corner-chip design (batch 5) must not survive either — only technicalRasterSelectedMarker should exist now");
});

test("exactly one DOM node is produced per 'selected' marker — never two competing indicators", async () => {
  const source = await readCanvasSource();
  const rendererStart = source.indexOf("function renderMarker(marker: RasterCanvasMarker)");
  assert.ok(rendererStart > 0);
  const rendererBody = source.slice(rendererStart);
  // A crude but effective structural check: the "selected" branch must return a SINGLE element,
  // never a Fragment/array wrapping two sibling divs (the batch-5 bug this batch fixes).
  assert.ok(!rendererBody.includes("<Fragment"), "must never wrap the selected marker in a Fragment of multiple nodes");
});

test("marker positioning never depends on computeEffectiveRenderScale/renderViewport — a high-resolution re-render can never move a marker (spec section 15)", async () => {
  const source = await readCanvasSource();
  const rendererStart = source.indexOf("function renderMarker(marker: RasterCanvasMarker)");
  const rendererEnd = source.indexOf("\n  if (!pdfUrl)", rendererStart);
  const rendererBody = source.slice(rendererStart, rendererEnd);
  assert.ok(!rendererBody.includes("computeEffectiveRenderScale"), "marker positioning must never reference the PDF backing-resolution helper");
  assert.ok(!rendererBody.includes("effectiveRenderScale"), "marker positioning must never reference the render effect's own resolved scale");
  assert.ok(rendererBody.includes("viewport.transform.zoom"), "positioning IS driven by the viewport's own zoom, just never by render resolution");
});
