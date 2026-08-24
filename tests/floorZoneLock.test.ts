import assert from "node:assert/strict";
import test from "node:test";
import { createRectanglePlotPolygon, plotAreaSquareMeters } from "../domain/plot.ts";
import {
  confirmFloorZone,
  createFloorZone,
  isFloorZoneConfirmed,
  totalFloorAreaByFinish,
  uncoveredFloorAreaSquareMeters,
  unlockFloorZone,
  validateFloorZoneForConfirm,
  type FloorZone,
} from "../domain/floorZones.ts";
import { createProjectRecord, normalizeProjectRecord } from "../domain/project.ts";

// =========================================================================================
// Turn 5, sections 6-14/28-30: default "bez krytiny" semantics, per-zone confirm/lock, hard
// overlap prevention, outside-plot prevention, area math, and color/decor metadata.
// =========================================================================================

test("FLOOR DEFAULT: a confirmed plot with ZERO floor zones is a valid, complete state — 100% of the plot is uncovered", () => {
  const plot = createRectanglePlotPolygon(4000, 5000); // 20 m^2
  assert.equal(plotAreaSquareMeters(plot), 20);
  assert.equal(uncoveredFloorAreaSquareMeters(plot, []), 20, "0 zones means the whole plot is bez krytiny — no placeholder polygon needed");
});

test("FLOOR ZONE LOCK: zone A confirms, becomes read-only-reserved; zone B may touch A's edge but not overlap it", () => {
  const plot = createRectanglePlotPolygon(4000, 5000); // 20 m^2, x:[0,4000] y:[0,5000]
  const zoneA = createFloorZone({ id: "a", polygon: [{ x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 2000, y: 5000 }, { x: 0, y: 5000 }], finish: "carpet" }); // 10 m^2, right edge at x=2000

  const resultA = validateFloorZoneForConfirm(zoneA, plot, [zoneA]);
  assert.equal(resultA.valid, true);
  const confirmedA = confirmFloorZone(zoneA);
  assert.equal(isFloorZoneConfirmed(confirmedA), true);

  // Zone B touches A's right edge exactly at x=2000 — touching is fine, not an overlap.
  const zoneBTouching = createFloorZone({ id: "b", polygon: [{ x: 2000, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 5000 }, { x: 2000, y: 5000 }], finish: "vinyl" });
  const resultBTouching = validateFloorZoneForConfirm(zoneBTouching, plot, [confirmedA, zoneBTouching]);
  assert.equal(resultBTouching.valid, true, "touching a confirmed zone's edge is allowed");

  // Zone B' genuinely overlaps A's area (starts at x=1000, inside A's [0,2000] span).
  const zoneBOverlapping = createFloorZone({ id: "b2", polygon: [{ x: 1000, y: 0 }, { x: 3000, y: 0 }, { x: 3000, y: 5000 }, { x: 1000, y: 5000 }], finish: "vinyl" });
  const resultBOverlapping = validateFloorZoneForConfirm(zoneBOverlapping, plot, [confirmedA, zoneBOverlapping]);
  assert.equal(resultBOverlapping.valid, false);
  assert.ok(resultBOverlapping.issues.includes("overlaps_confirmed_zone"));

  // Unlocking A returns it to draft — but A itself must still not overlap OTHER confirmed zones
  // if later re-confirmed (here there are none, so re-confirming A alone succeeds again).
  const unlockedA = unlockFloorZone(confirmedA);
  assert.equal(isFloorZoneConfirmed(unlockedA), false);
  const reconfirmA = validateFloorZoneForConfirm(unlockedA, plot, [unlockedA]);
  assert.equal(reconfirmA.valid, true);
});

test("FLOOR ZONE CONFIRM: a zone that pokes outside the plot cannot be confirmed — hard validation at confirm time, never save-then-warn", () => {
  const plot = createRectanglePlotPolygon(3000, 3000);
  const overflowing = createFloorZone({ id: "overflow", polygon: [{ x: 2500, y: 0 }, { x: 3500, y: 0 }, { x: 3500, y: 2000 }, { x: 2500, y: 2000 }] });
  const result = validateFloorZoneForConfirm(overflowing, plot, [overflowing]);
  assert.equal(result.valid, false);
  assert.ok(result.issues.includes("outside_plot"));
});

test("FLOOR AREA: plot 20 m^2, zone A 8 m^2 (confirmed), zone B 5 m^2 (confirmed) -> explicit zones 13 m^2, uncovered 7 m^2, no explicit 'none' polygon required", () => {
  const plot = createRectanglePlotPolygon(4000, 5000); // 20 m^2
  const zoneA = confirmFloorZone(createFloorZone({ id: "a", polygon: createRectanglePlotPolygon(4000, 2000), finish: "carpet" })); // 8 m^2
  const zoneBPolygon = [{ x: 0, y: 2000 }, { x: 2500, y: 2000 }, { x: 2500, y: 4000 }, { x: 0, y: 4000 }]; // 2500x2000 = 5 m^2
  const zoneB = confirmFloorZone(createFloorZone({ id: "b", polygon: zoneBPolygon, finish: "vinyl" }));

  const zones: FloorZone[] = [zoneA, zoneB];
  const totals = totalFloorAreaByFinish(zones);
  assert.equal(totals.carpet, 8);
  assert.equal(totals.vinyl, 5);
  const explicitZonesArea = zones.reduce((sum, z) => sum + plotAreaSquareMeters(z.polygon), 0);
  assert.equal(explicitZonesArea, 13);
  assert.equal(uncoveredFloorAreaSquareMeters(plot, zones), 7);
});

test("FLOOR PROPERTIES: base/finish/colorLabel/label all round-trip through create + save/reload", () => {
  const zone = createFloorZone({
    id: "zone-props",
    polygon: createRectanglePlotPolygon(2000, 2000),
    base: "raised",
    finish: "vinyl",
    colorLabel: "Dub",
    label: "Recepce",
    status: "confirmed",
  });
  assert.equal(zone.base, "raised");
  assert.equal(zone.finish, "vinyl");
  assert.equal(zone.colorLabel, "Dub");
  assert.equal(zone.label, "Recepce");
  assert.equal(zone.status, "confirmed");

  const saved = createProjectRecord({
    id: "floor-props-project",
    projectType: "individualni",
    individualPlotPolygon: createRectanglePlotPolygon(4000, 4000),
    individualFloorZones: [zone],
  });
  const reloaded = normalizeProjectRecord(saved);
  const reloadedZone = reloaded.individualFloorZones?.[0];
  assert.equal(reloadedZone?.base, "raised");
  assert.equal(reloadedZone?.finish, "vinyl");
  assert.equal(reloadedZone?.colorLabel, "Dub");
  assert.equal(reloadedZone?.label, "Recepce");
  assert.equal(reloadedZone?.status, "confirmed", "confirmed lock state survives save/reload");
});

test("FLOOR PROPERTIES: a zone saved before locking existed (no status field) resolves to draft, not confirmed", () => {
  const zone = createFloorZone({ id: "legacy-zone", polygon: createRectanglePlotPolygon(1000, 1000) });
  const legacyShape: FloorZone = { id: zone.id, polygon: zone.polygon, base: "ground", finish: "carpet" };
  assert.equal(isFloorZoneConfirmed(legacyShape), false);
});
