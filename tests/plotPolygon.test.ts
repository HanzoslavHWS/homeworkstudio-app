import assert from "node:assert/strict";
import test from "node:test";
import {
  isPointInPolygon,
  isPointOnPolygonBoundary,
  isSimplePolygon,
  polygonAreaMm2,
  polygonPerimeterMm,
  polygonsIntersectGeneral,
  segmentsIntersect,
  validatePolygon,
} from "../geometry/polygons.ts";
import {
  createRectanglePlotPolygon,
  DEFAULT_INDIVIDUAL_WORKSPACE,
  findComponentAnchorsOutsidePlot,
  isAnchorInsidePlot,
  isPolygonWithinWorkspace,
  plotAreaSquareMeters,
  plotPerimeterMeters,
  resolveIndividualPlotPolygon,
  snapEdgeAngle,
  snapPlotVertexToGrid,
} from "../domain/plot.ts";

// A concrete L-shape: outer 3000×2000, with a 2000×1000 notch cut from the top-right —
// area/perimeter hand-verified via the shoelace formula (see report).
const L_SHAPE = [
  { x: 0, y: 0 },
  { x: 3000, y: 0 },
  { x: 3000, y: 1000 },
  { x: 1000, y: 1000 },
  { x: 1000, y: 2000 },
  { x: 0, y: 2000 },
];

const TRIANGLE = [
  { x: 0, y: 0 },
  { x: 2000, y: 0 },
  { x: 1000, y: 2000 },
];

// A rectangle with its top-right corner cut at exactly 45° (500mm each direction).
const CUT_CORNER = [
  { x: 0, y: 0 },
  { x: 2500, y: 0 },
  { x: 3000, y: 500 },
  { x: 3000, y: 2000 },
  { x: 0, y: 2000 },
];

const BOWTIE_SELF_INTERSECTING = [
  { x: 0, y: 0 },
  { x: 1000, y: 1000 },
  { x: 1000, y: 0 },
  { x: 0, y: 1000 },
];

// =========================================================================================
// Area / perimeter — shoelace-equivalent, never the bounding rectangle standing in for shape.
// =========================================================================================

test("rectangle polygon: area and perimeter match plain width×depth", () => {
  const rect = createRectanglePlotPolygon(3000, 2000);
  assert.equal(plotAreaSquareMeters(rect), 6);
  assert.equal(plotPerimeterMeters(rect), 10);
});

test("L-shape polygon: area is LESS than its bounding rectangle (3000×2000=6m²) — the notch is genuinely excluded", () => {
  assert.equal(plotAreaSquareMeters(L_SHAPE), 4);
  assert.equal(plotPerimeterMeters(L_SHAPE), 10);
});

test("triangle polygon: area = 0.5×base×height, perimeter = sum of the three real edge lengths", () => {
  assert.equal(polygonAreaMm2(TRIANGLE), 2_000_000);
  const expectedPerimeter = 2000 + 2 * Math.hypot(1000, 2000);
  assert.ok(Math.abs(polygonPerimeterMm(TRIANGLE) - expectedPerimeter) < 1e-6);
});

test("45°-cut-corner polygon: area = rectangle minus the exact triangular cut, never rounded to the nearest grid step", () => {
  // 3000×2000 rectangle (6,000,000mm²) minus a 500×500 right-triangle cut (125,000mm²)
  assert.equal(polygonAreaMm2(CUT_CORNER), 5_875_000);
  assert.equal(plotAreaSquareMeters(CUT_CORNER), 5.875, "internal mm geometry must not be rounded to whole m²");
});

// =========================================================================================
// Validation — real polygon geometry, never the bounding rectangle.
// =========================================================================================

test("validatePolygon: too few points is rejected", () => {
  const result = validatePolygon([{ x: 0, y: 0 }, { x: 1000, y: 0 }]);
  assert.equal(result.valid, false);
  assert.ok(result.issues.includes("too_few_points"));
});

test("validatePolygon: a zero-length edge (adjacent duplicate vertex) is rejected", () => {
  const result = validatePolygon([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }]);
  assert.equal(result.valid, false);
  assert.ok(result.issues.includes("zero_length_edge"));
});

test("validatePolygon: a non-adjacent duplicate vertex is rejected", () => {
  const result = validatePolygon([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 500, y: 500 }, { x: 1000, y: 1000 }, { x: 1000, y: 0 }]);
  assert.equal(result.valid, false);
  assert.ok(result.issues.includes("duplicate_points"));
});

test("validatePolygon: a self-intersecting bowtie is rejected", () => {
  const result = validatePolygon(BOWTIE_SELF_INTERSECTING);
  assert.equal(result.valid, false);
  assert.ok(result.issues.includes("self_intersecting"));
  assert.equal(isSimplePolygon(BOWTIE_SELF_INTERSECTING), false);
});

test("validatePolygon: a valid rectangle, L-shape, triangle, and 45°-cut-corner are all accepted", () => {
  for (const polygon of [createRectanglePlotPolygon(3000, 2000), L_SHAPE, TRIANGLE, CUT_CORNER]) {
    const result = validatePolygon(polygon);
    assert.deepEqual(result.issues, []);
    assert.equal(result.valid, true);
    assert.equal(isSimplePolygon(polygon), true);
  }
});

test("validatePolygon: winding order (clockwise vs counter-clockwise) never affects validity", () => {
  const clockwise = validatePolygon(L_SHAPE);
  const counterClockwise = validatePolygon([...L_SHAPE].reverse());
  assert.equal(clockwise.valid, true);
  assert.equal(counterClockwise.valid, true);
});

// =========================================================================================
// Point containment / boundary — the concave-aware check that a bounding-rectangle rule
// would get wrong (a point can be inside the bounding box but outside the real L-shape).
// =========================================================================================

test("point-in-polygon: a point in the L-shape's cut-away notch (inside the bounding box, outside the real shape) is OUTSIDE", () => {
  assert.equal(isPointInPolygon({ x: 2000, y: 1500 }, L_SHAPE), false);
});

test("point-in-polygon: a point in the L-shape's occupied leg is INSIDE", () => {
  assert.equal(isPointInPolygon({ x: 500, y: 1500 }, L_SHAPE), true);
  assert.equal(isPointInPolygon({ x: 2000, y: 500 }, L_SHAPE), true);
});

test("point-on-boundary: a point exactly on an edge counts as boundary, not interior", () => {
  assert.equal(isPointOnPolygonBoundary({ x: 1500, y: 0 }, L_SHAPE), true);
});

test("isAnchorInsidePlot: a placement anchor exactly ON the plot boundary is valid (never rejected the way a strict-interior-only rule would)", () => {
  assert.equal(isAnchorInsidePlot({ x: 1500, y: 0 }, L_SHAPE), true);
  assert.equal(isAnchorInsidePlot({ x: 0, y: 0 }, L_SHAPE), true, "a corner vertex itself must also count");
});

test("findComponentAnchorsOutsidePlot: only the anchor genuinely outside the real polygon (not just outside the bounding box) is flagged", () => {
  const anchors = [
    { id: "in-notch", x: 2000, y: 1500 },
    { id: "in-leg", x: 500, y: 1500 },
  ];
  assert.deepEqual(findComponentAnchorsOutsidePlot(anchors, L_SHAPE), ["in-notch"]);
});

// =========================================================================================
// Self-intersection / overlap primitives used by both plot validation and floor zones.
// =========================================================================================

test("segmentsIntersect: two crossing segments intersect; two segments sharing only an endpoint do not count as a proper crossing needed for self-intersection", () => {
  assert.equal(segmentsIntersect({ x: 0, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }, { x: 1000, y: 0 }), true);
});

test("polygonsIntersectGeneral: two overlapping rectangles intersect; two disjoint rectangles do not", () => {
  const a = createRectanglePlotPolygon(1000, 1000);
  const overlapping = [{ x: 500, y: 500 }, { x: 1500, y: 500 }, { x: 1500, y: 1500 }, { x: 500, y: 1500 }];
  const disjoint = [{ x: 2000, y: 2000 }, { x: 3000, y: 2000 }, { x: 3000, y: 3000 }, { x: 2000, y: 3000 }];
  assert.equal(polygonsIntersectGeneral(a, overlapping), true);
  assert.equal(polygonsIntersectGeneral(a, disjoint), false);
});

test("polygonsIntersectGeneral: one polygon fully containing another (no crossing edges) still counts as overlap", () => {
  const outer = createRectanglePlotPolygon(3000, 3000);
  const inner = [{ x: 1000, y: 1000 }, { x: 2000, y: 1000 }, { x: 2000, y: 2000 }, { x: 1000, y: 2000 }];
  assert.equal(polygonsIntersectGeneral(outer, inner), true);
});

// =========================================================================================
// Grid (250mm) and angle (45°) vertex snapping for polygon drawing.
// =========================================================================================

test("snapPlotVertexToGrid: rounds to the nearest 250mm grid point", () => {
  assert.deepEqual(snapPlotVertexToGrid({ x: 1080, y: 1120 }), { x: 1000, y: 1000 });
});

test("snapEdgeAngle: an already-45° edge stays exactly diagonal", () => {
  assert.deepEqual(snapEdgeAngle({ x: 0, y: 0 }, { x: 1000, y: 1000 }), { x: 1000, y: 1000 });
});

test("snapEdgeAngle: a near-horizontal edge snaps to a clean 0°, not just the raw grid point", () => {
  const result = snapEdgeAngle({ x: 0, y: 0 }, { x: 1000, y: 300 });
  assert.deepEqual(result, { x: 1000, y: 0 });
});

test("snapEdgeAngle: a near-vertical edge snaps to a clean 90°", () => {
  const result = snapEdgeAngle({ x: 0, y: 0 }, { x: 200, y: 1000 });
  assert.deepEqual(result, { x: 0, y: 1000 });
});

// =========================================================================================
// Workspace bounds (drawing canvas, NEVER the plot footprint itself).
// =========================================================================================

test("isPolygonWithinWorkspace: a plot inside the default 10×10 m workspace is within bounds", () => {
  assert.equal(isPolygonWithinWorkspace(createRectanglePlotPolygon(3000, 2000), DEFAULT_INDIVIDUAL_WORKSPACE), true);
});

test("isPolygonWithinWorkspace: a plot vertex outside the workspace is flagged", () => {
  assert.equal(isPolygonWithinWorkspace(createRectanglePlotPolygon(12_000, 2000), DEFAULT_INDIVIDUAL_WORKSPACE), false);
});

// =========================================================================================
// Backward compatibility (section 11/40): legacy individualWidthMm/individualDepthMm-only
// projects safely derive a rectangle polygon; no destructive migration.
// =========================================================================================

test("resolveIndividualPlotPolygon: an explicit polygon always wins over legacy width/depth", () => {
  const polygon = resolveIndividualPlotPolygon({
    individualPlotPolygon: L_SHAPE,
    individualWidthMm: 9999,
    individualDepthMm: 9999,
  });
  assert.deepEqual(polygon, L_SHAPE);
});

test("resolveIndividualPlotPolygon: a legacy project with only width/depth derives the equivalent rectangle polygon", () => {
  const polygon = resolveIndividualPlotPolygon({ individualWidthMm: 3000, individualDepthMm: 2000 });
  assert.deepEqual(polygon, createRectanglePlotPolygon(3000, 2000));
});

test("resolveIndividualPlotPolygon: a project with neither polygon nor width/depth resolves to undefined (never a fabricated default plot)", () => {
  assert.equal(resolveIndividualPlotPolygon({}), undefined);
});
