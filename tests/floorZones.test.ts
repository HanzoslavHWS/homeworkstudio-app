import assert from "node:assert/strict";
import test from "node:test";
import {
  createFloorZone,
  FLOOR_ZONE_FINISHES,
  findFloorZonesOutsidePlot,
  findOverlappingFloorZonePairs,
  floorZoneAreaSquareMeters,
  totalFloorAreaByFinish,
} from "../domain/floorZones.ts";
import { createRectanglePlotPolygon } from "../domain/plot.ts";

// A 5000×4000 plot (20 m²) with a 3750×4000 carpet zone (15 m²) and 1250×4000 left bare.
const PLOT = createRectanglePlotPolygon(5000, 4000);
const CARPET_ZONE = createFloorZone({
  id: "carpet-1",
  polygon: [{ x: 0, y: 0 }, { x: 3750, y: 0 }, { x: 3750, y: 4000 }, { x: 0, y: 4000 }],
  finish: "carpet",
});
const BARE_ZONE = createFloorZone({
  id: "bare-1",
  polygon: [{ x: 3750, y: 0 }, { x: 5000, y: 0 }, { x: 5000, y: 4000 }, { x: 3750, y: 4000 }],
  finish: "none",
});

test("floorZoneAreaSquareMeters: matches the zone's own polygon area", () => {
  assert.equal(floorZoneAreaSquareMeters(CARPET_ZONE), 15);
  assert.equal(floorZoneAreaSquareMeters(BARE_ZONE), 5);
});

test("createFloorZone: base and finish are independently stored — every combination is representable, not a single hardcoded enum", () => {
  const raisedCarpet = createFloorZone({ id: "z1", polygon: PLOT, base: "raised", finish: "carpet" });
  const raisedVinyl = createFloorZone({ id: "z2", polygon: PLOT, base: "raised", finish: "vinyl" });
  const groundCarpet = createFloorZone({ id: "z3", polygon: PLOT, base: "ground", finish: "carpet" });
  const groundNone = createFloorZone({ id: "z4", polygon: PLOT, base: "ground", finish: "none" });
  assert.deepEqual([raisedCarpet.base, raisedCarpet.finish], ["raised", "carpet"]);
  assert.deepEqual([raisedVinyl.base, raisedVinyl.finish], ["raised", "vinyl"]);
  assert.deepEqual([groundCarpet.base, groundCarpet.finish], ["ground", "carpet"]);
  assert.deepEqual([groundNone.base, groundNone.finish], ["ground", "none"]);
});

test("createFloorZone: defaults to ground base + no finish when unspecified — the default booth area is 'bez krytiny' until the user creates a zone", () => {
  const zone = createFloorZone({ id: "z", polygon: PLOT });
  assert.equal(zone.base, "ground");
  assert.equal(zone.finish, "none");
});

test("multiple zones: total booth area (20m²) splits correctly into carpet (15m²) and none (5m²)", () => {
  const totals = totalFloorAreaByFinish([CARPET_ZONE, BARE_ZONE]);
  assert.equal(totals.carpet, 15);
  assert.equal(totals.none, 5);
  assert.equal(totals.vinyl, 0);
  const grandTotal = FLOOR_ZONE_FINISHES.reduce((sum, finish) => sum + totals[finish], 0);
  assert.equal(grandTotal, 20);
});

test("findFloorZonesOutsidePlot: a zone fully inside the plot is never flagged", () => {
  assert.deepEqual(findFloorZonesOutsidePlot([CARPET_ZONE, BARE_ZONE], PLOT), []);
});

test("findFloorZonesOutsidePlot: a zone with a vertex outside the (now-smaller) plot is flagged — never silently clipped/deleted", () => {
  const shrunkPlot = createRectanglePlotPolygon(3000, 4000);
  assert.deepEqual(findFloorZonesOutsidePlot([CARPET_ZONE], shrunkPlot), ["carpet-1"]);
});

test("findOverlappingFloorZonePairs: two disjoint zones never conflict", () => {
  assert.deepEqual(findOverlappingFloorZonePairs([CARPET_ZONE, BARE_ZONE]), []);
});

test("findOverlappingFloorZonePairs: two genuinely overlapping zones are flagged as a conflict pair, never silently resolved", () => {
  const overlapping = createFloorZone({
    id: "overlap-1",
    polygon: [{ x: 3000, y: 0 }, { x: 4500, y: 0 }, { x: 4500, y: 4000 }, { x: 3000, y: 4000 }],
    finish: "vinyl",
  });
  const conflicts = findOverlappingFloorZonePairs([CARPET_ZONE, overlapping]);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0], ["carpet-1", "overlap-1"]);
});

test("save/load: a FloorZone is a plain JSON-serializable object — round-trips through JSON exactly (the same guarantee ProjectRecord JSONB persistence relies on)", () => {
  const restored = JSON.parse(JSON.stringify(CARPET_ZONE));
  assert.deepEqual(restored, CARPET_ZONE);
});
