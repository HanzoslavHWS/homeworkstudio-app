import assert from "node:assert/strict";
import test from "node:test";
import { createRectanglePlotPolygon, plotAreaSquareMeters } from "../domain/plot.ts";
import {
  confirmFloorZone,
  createFloorZone,
  freeFloorAreaRegions,
  validateFloorZoneForConfirm,
} from "../domain/floorZones.ts";
import { validatePolygon } from "../geometry/polygons.ts";

// =========================================================================================
// Turn 5 LIVE QA sections 12-13/49: explicit regression matrix for the hard overlap rule —
// exact-duplicate, fully-contained, and partial overlap must all be blocked; touching an edge
// and sitting adjacent must both be allowed. Also section 12's root-cause audit: two zones
// created back-to-back must never be geometrically indistinguishable duplicates.
// =========================================================================================

test("OVERLAP MATRIX: Zone B with the EXACT SAME polygon as confirmed Zone A cannot be confirmed", () => {
  const plot = createRectanglePlotPolygon(6000, 6000);
  const rect = [{ x: 1000, y: 1000 }, { x: 3000, y: 1000 }, { x: 3000, y: 3000 }, { x: 1000, y: 3000 }];
  const zoneA = confirmFloorZone(createFloorZone({ id: "a", polygon: rect }));
  const zoneB = createFloorZone({ id: "b", polygon: rect.map((p) => ({ ...p })) });

  const result = validateFloorZoneForConfirm(zoneB, plot, [zoneA, zoneB]);
  assert.equal(result.valid, false);
  assert.ok(result.issues.includes("overlaps_confirmed_zone"));
});

test("OVERLAP MATRIX: Zone B fully CONTAINED inside confirmed Zone A cannot be confirmed", () => {
  const plot = createRectanglePlotPolygon(6000, 6000);
  const zoneA = confirmFloorZone(createFloorZone({ id: "a", polygon: [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 4000 }, { x: 0, y: 4000 }] }));
  const zoneB = createFloorZone({ id: "b", polygon: [{ x: 1000, y: 1000 }, { x: 2000, y: 1000 }, { x: 2000, y: 2000 }, { x: 1000, y: 2000 }] });

  const result = validateFloorZoneForConfirm(zoneB, plot, [zoneA, zoneB]);
  assert.equal(result.valid, false);
  assert.ok(result.issues.includes("overlaps_confirmed_zone"));
});

test("OVERLAP MATRIX: Zone B partially overlapping confirmed Zone A cannot be confirmed", () => {
  const plot = createRectanglePlotPolygon(6000, 6000);
  const zoneA = confirmFloorZone(createFloorZone({ id: "a", polygon: [{ x: 0, y: 0 }, { x: 3000, y: 0 }, { x: 3000, y: 3000 }, { x: 0, y: 3000 }] }));
  const zoneB = createFloorZone({ id: "b", polygon: [{ x: 2000, y: 2000 }, { x: 5000, y: 2000 }, { x: 5000, y: 5000 }, { x: 2000, y: 5000 }] });

  const result = validateFloorZoneForConfirm(zoneB, plot, [zoneA, zoneB]);
  assert.equal(result.valid, false);
  assert.ok(result.issues.includes("overlaps_confirmed_zone"));
});

test("OVERLAP MATRIX: Zone B only TOUCHING confirmed Zone A's edge (zero shared area) CAN be confirmed", () => {
  const plot = createRectanglePlotPolygon(6000, 6000);
  const zoneA = confirmFloorZone(createFloorZone({ id: "a", polygon: [{ x: 0, y: 0 }, { x: 3000, y: 0 }, { x: 3000, y: 3000 }, { x: 0, y: 3000 }] }));
  const zoneB = createFloorZone({ id: "b", polygon: [{ x: 3000, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 3000 }, { x: 3000, y: 3000 }] });

  const result = validateFloorZoneForConfirm(zoneB, plot, [zoneA, zoneB]);
  assert.equal(result.valid, true);
});

test("OVERLAP MATRIX: Zone B ADJACENT to confirmed Zone A (separated, not touching) CAN be confirmed", () => {
  const plot = createRectanglePlotPolygon(8000, 6000);
  const zoneA = confirmFloorZone(createFloorZone({ id: "a", polygon: [{ x: 0, y: 0 }, { x: 3000, y: 0 }, { x: 3000, y: 3000 }, { x: 0, y: 3000 }] }));
  const zoneB = createFloorZone({ id: "b", polygon: [{ x: 5000, y: 0 }, { x: 8000, y: 0 }, { x: 8000, y: 3000 }, { x: 5000, y: 3000 }] });

  const result = validateFloorZoneForConfirm(zoneB, plot, [zoneA, zoneB]);
  assert.equal(result.valid, true);
});

// =========================================================================================
// Turn 5 LIVE QA sections 16-18/50: "Vyplnit volnou plochu" — plot minus union of OTHER
// confirmed zones, largest region when the free area is disconnected.
// =========================================================================================

test("FILL FREE AREA: 5x5 booth (25 m^2), 0 zones -> fill gives the whole plot", () => {
  const plot = createRectanglePlotPolygon(5000, 5000);
  const regions = freeFloorAreaRegions(plot, []);
  assert.equal(regions.length, 1);
  assert.equal(plotAreaSquareMeters(regions[0]!), 25);
});

test("FILL FREE AREA: booth 20 m^2, Zone A confirmed = 8 m^2 -> fill for a new Zone B gives exactly the 12 m^2 remainder", () => {
  const plot = createRectanglePlotPolygon(4000, 5000); // 20 m^2
  const zoneA = confirmFloorZone(createFloorZone({ id: "a", polygon: createRectanglePlotPolygon(4000, 2000) })); // 8 m^2, y:[0,2000]
  const regions = freeFloorAreaRegions(plot, [zoneA]);
  assert.equal(regions.length, 1);
  assert.equal(plotAreaSquareMeters(regions[0]!), 12);
});

test("FILL FREE AREA: all area occupied by confirmed zones -> no free region (fill would be a no-op)", () => {
  const plot = createRectanglePlotPolygon(4000, 4000);
  const zoneA = confirmFloorZone(createFloorZone({ id: "a", polygon: createRectanglePlotPolygon(4000, 4000) }));
  const regions = freeFloorAreaRegions(plot, [zoneA]);
  assert.equal(regions.length, 0, "difference of the plot with itself yields zero regions");
});

test("FILL FREE AREA: concave L-shaped booth minus a corner zone yields the correct L-shaped remainder area", () => {
  // L-shape: 6000x6000 square minus a 3000x3000 corner notch (top-right) -> area 36-9=27 m^2.
  const lShapedPlot = [
    { x: 0, y: 0 },
    { x: 6000, y: 0 },
    { x: 6000, y: 3000 },
    { x: 3000, y: 3000 },
    { x: 3000, y: 6000 },
    { x: 0, y: 6000 },
  ];
  assert.equal(plotAreaSquareMeters(lShapedPlot), 27);

  const zoneA = confirmFloorZone(createFloorZone({ id: "a", polygon: [{ x: 0, y: 0 }, { x: 3000, y: 0 }, { x: 3000, y: 3000 }, { x: 0, y: 3000 }] })); // 9 m^2 corner of the L
  const regions = freeFloorAreaRegions(lShapedPlot, [zoneA]);
  const totalFreeArea = regions.reduce((sum, region) => sum + plotAreaSquareMeters(region), 0);
  assert.equal(totalFreeArea, 27 - 9, "the L-shaped remainder area is exact, computed from real polygon geometry");
});

test("FILL FREE AREA REGRESSION: the returned region is a clean, VALID polygon — no trailing zero-length closing edge from polygon-clipping's explicitly-closed-ring output (same root cause/fix as rectanglePrimitives.test.ts's UNION REGRESSION)", () => {
  const plot = createRectanglePlotPolygon(4000, 5000);
  const zoneA = confirmFloorZone(createFloorZone({ id: "a", polygon: createRectanglePlotPolygon(4000, 2000) }));
  const regions = freeFloorAreaRegions(plot, [zoneA]);
  assert.equal(regions.length, 1);
  assert.equal(validatePolygon(regions[0]!).valid, true);
});

test("FILL FREE AREA: draft (unconfirmed) zones never reduce the free area — only CONFIRMED zones are subtracted", () => {
  const plot = createRectanglePlotPolygon(5000, 5000);
  const draftZone = createFloorZone({ id: "draft", polygon: createRectanglePlotPolygon(2000, 2000) }); // status defaults to "draft"
  const regions = freeFloorAreaRegions(plot, [draftZone]);
  assert.equal(regions.length, 1);
  assert.equal(plotAreaSquareMeters(regions[0]!), 25, "a draft zone doesn't reserve any area yet");
});
