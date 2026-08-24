import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PIXELS_PER_MM,
  MAX_VIEWPORT_ZOOM,
  MIN_VIEWPORT_ZOOM,
  clampZoom,
  defaultFitPaddingPx,
  fitBoundsToViewport,
  fitWorldToViewport,
  resolveInitialViewportFit,
  worldToScreen,
  zoomAroundScreenPoint,
} from "../geometry/viewport.ts";

test("initial fit waits for both viewport size and booth visual readiness", () => {
  const base = {
    initialized: false,
    world: { width: 2000, height: 2000 },
  } as const;

  assert.equal(
    resolveInitialViewportFit({
      ...base,
      visualReady: true,
      viewport: { width: 0, height: 700 },
    }),
    null,
  );
  assert.equal(
    resolveInitialViewportFit({
      ...base,
      visualReady: false,
      viewport: { width: 1000, height: 700 },
    }),
    null,
  );
  assert.ok(
    resolveInitialViewportFit({
      ...base,
      visualReady: true,
      viewport: { width: 1000, height: 700 },
    }),
  );
});

test("initial P86 fit centers canonical 2000x2000 in the actual render area", () => {
  const viewport = { width: 1000, height: 700 };
  const transform = resolveInitialViewportFit({
    initialized: false,
    visualReady: true,
    viewport,
    world: { width: 2000, height: 2000 },
  });

  assert.ok(transform);
  assert.deepEqual(worldToScreen({ x: 1000, y: 1000 }, transform), {
    x: viewport.width / 2,
    y: viewport.height / 2,
  });
});

test("initial fit is canonical-only and does not reset a later manual zoom", () => {
  const result = resolveInitialViewportFit({
    initialized: true,
    visualReady: true,
    viewport: { width: 1000, height: 700 },
    world: { width: 2000, height: 2000 },
  });

  assert.equal(result, null);
});

// =========================================================================================
// Section 18: Fit math — viewport vs. bounding box, with padding, always centered and
// always fully contained.
// =========================================================================================

test("Fit: viewport 1000×700px, plot 3000×2000mm — the whole bbox lands inside the viewport with real padding on every side", () => {
  const transform = fitBoundsToViewport({ width: 1000, height: 700 }, { minX: 0, minY: 0, maxX: 3000, maxY: 2000 });
  const topLeft = worldToScreen({ x: 0, y: 0 }, transform);
  const bottomRight = worldToScreen({ x: 3000, y: 2000 }, transform);
  const padding = defaultFitPaddingPx({ width: 1000, height: 700 });

  assert.ok(topLeft.x >= padding - 1 && topLeft.y >= padding - 1, "top-left must clear the padding, not touch the viewport edge");
  assert.ok(bottomRight.x <= 1000 - padding + 1 && bottomRight.y <= 700 - padding + 1, "bottom-right must clear the padding on the opposite edge");
  assert.ok(topLeft.x >= 0 && topLeft.y >= 0 && bottomRight.x <= 1000 && bottomRight.y <= 700, "never clipped, regardless of padding");
});

test("Fit: a plot exactly as large as the workspace (10000×10000mm) still fits entirely, centered", () => {
  const transform = fitWorldToViewport({ width: 1200, height: 800 }, { width: 10000, height: 10000 });
  const topLeft = worldToScreen({ x: 0, y: 0 }, transform);
  const bottomRight = worldToScreen({ x: 10000, y: 10000 }, transform);
  assert.ok(topLeft.x >= 0 && topLeft.y >= 0);
  assert.ok(bottomRight.x <= 1200 && bottomRight.y <= 800);
  // centered: equal-ish margin on the constraining axis
  assert.ok(Math.abs(topLeft.x - (1200 - bottomRight.x)) < 1);
});

test("Fit priority: fitting to the real (small) plot bounds yields a dramatically more usable zoom than fitting to the full workspace — this is what 'primary Fit uses the plot, not the workspace' actually buys", () => {
  const viewport = { width: 1100, height: 560 };
  const workspaceFit = fitWorldToViewport(viewport, { width: 10000, height: 10000 });
  const plotFit = fitBoundsToViewport(viewport, { minX: 0, minY: 0, maxX: 3000, maxY: 2000 });
  assert.ok(plotFit.zoom > workspaceFit.zoom * 3, "the plot-priority fit should be dramatically more zoomed-in than fitting the whole empty workspace");
});

test("Fit: a large plot that needs a sub-0.25 zoom to fit is NOT clamped up to the old 25% floor — this was the exact 'workspace looks unusable' bug (report section 3/11)", () => {
  const transform = fitWorldToViewport({ width: 800, height: 600 }, { width: 20000, height: 20000 });
  // The mathematically ideal zoom here is ~0.084 — well below the OLD MIN_VIEWPORT_ZOOM (0.25).
  assert.ok(transform.zoom < 0.15, `expected an unclamped small zoom, got ${transform.zoom}`);
  assert.ok(transform.zoom >= MIN_VIEWPORT_ZOOM);
});

// =========================================================================================
// Section 11: dynamic-enough (wide) zoom limits — never the old 0.25/4 ceiling that blocked
// fitting a large stand or inspecting a ~40mm Octanorm profile up close.
// =========================================================================================

test("zoom limits: MIN allows fitting a stand an order of magnitude larger than before, MAX allows real close-up detail work", () => {
  assert.ok(MIN_VIEWPORT_ZOOM <= 0.05);
  assert.ok(MAX_VIEWPORT_ZOOM >= 20);
  // A 40mm Octanorm post should be inspectable at a real, usable on-screen size near MAX zoom.
  const postScreenWidthPx = 40 * DEFAULT_PIXELS_PER_MM * MAX_VIEWPORT_ZOOM;
  assert.ok(postScreenWidthPx >= 200, `expected a 40mm post to render at least 200px wide near max zoom, got ${postScreenWidthPx}`);
});

test("clampZoom: still clamps to the (now wider) range, never lets a requested zoom escape it", () => {
  assert.equal(clampZoom(0.0001), MIN_VIEWPORT_ZOOM);
  assert.equal(clampZoom(9999), MAX_VIEWPORT_ZOOM);
  assert.equal(clampZoom(1), 1);
});

// =========================================================================================
// Section 19: cursor-relative zoom must never produce NaN/Infinity, even at the zoom extremes.
// =========================================================================================

test("zoomAroundScreenPoint: cursor-relative zoom never produces NaN/Infinity at the min or max zoom extreme", () => {
  const base = { zoom: 1, pan: { x: 0, y: 0 } };
  for (const targetZoom of [MIN_VIEWPORT_ZOOM, MAX_VIEWPORT_ZOOM, MIN_VIEWPORT_ZOOM / 2, MAX_VIEWPORT_ZOOM * 2]) {
    const result = zoomAroundScreenPoint(base, targetZoom, { x: 400, y: 300 });
    assert.ok(Number.isFinite(result.zoom), `zoom must be finite, got ${result.zoom}`);
    assert.ok(Number.isFinite(result.pan.x) && Number.isFinite(result.pan.y), `pan must be finite, got ${JSON.stringify(result.pan)}`);
  }
});

test("zoomAroundScreenPoint: the world point under the cursor stays under the cursor after zooming (the actual point of cursor-relative zoom)", () => {
  const transform = { zoom: 0.5, pan: { x: 20, y: 30 } };
  const cursorScreenPoint = { x: 500, y: 400 };
  const zoomed = zoomAroundScreenPoint(transform, 2.3, cursorScreenPoint);
  const rescreened = worldToScreen(
    { x: (cursorScreenPoint.x - transform.pan.x) / (DEFAULT_PIXELS_PER_MM * transform.zoom), y: (cursorScreenPoint.y - transform.pan.y) / (DEFAULT_PIXELS_PER_MM * transform.zoom) },
    zoomed,
  );
  assert.ok(Math.abs(rescreened.x - cursorScreenPoint.x) < 1e-6);
  assert.ok(Math.abs(rescreened.y - cursorScreenPoint.y) < 1e-6);
});
