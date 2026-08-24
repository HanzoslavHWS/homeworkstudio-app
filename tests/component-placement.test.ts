import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { boothTypes } from "../data/booths.ts";
import { componentCatalog, placeComponent } from "../data/components.ts";
import { canResizeComponent } from "../domain/components.ts";
import { setUserLock } from "../domain/locking.ts";
import { get2DCollisionObstacles } from "../geometry/construction.ts";
import {
  applySnap,
  createComponentDragOffset,
  resolveDraggedComponentCenter,
  tryMoveComponent,
} from "../geometry/placement.ts";
import {
  getBounds,
  getRotatedCorners,
  polygonsOverlap,
  rectToPoints,
} from "../geometry/polygons.ts";
import { zoomAroundScreenPoint } from "../geometry/viewport.ts";

const booth = boothTypes.find((item) => item.id === "koje-2x2");

if (!booth) {
  throw new Error("Testovací definice Koje 2 × 2 nebyla nalezena.");
}

const chair = placeComponent(
  componentCatalog.chair,
  "chair-coordinate-input",
  1000,
  1500,
);

test("validní ruční změna X přesune objekt", () => {
  const result = tryMoveComponent(booth, chair, 500, chair.yMm);

  assert.equal(result.accepted, true);
  assert.equal(result.component.xMm, 500);
  assert.equal(result.component.yMm, chair.yMm);
});

test("validní ruční změna Y přesune objekt", () => {
  const result = tryMoveComponent(booth, chair, chair.xMm, 1200);

  assert.equal(result.accepted, true);
  assert.equal(result.component.xMm, chair.xMm);
  assert.equal(result.component.yMm, 1200);
});

test("souřadnice mimo footprint jsou odmítnuty", () => {
  const result = tryMoveComponent(booth, chair, -100, chair.yMm);

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "invalid-position");
  assert.equal(result.component, chair);
});

test("souřadnice způsobující collision jsou odmítnuty", () => {
  const result = tryMoveComponent(booth, chair, 1000, 1800);

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "invalid-position");
  assert.equal(result.component, chair);
});

test("P86 UI placement accepts the reported M57 position x=348 y=389", () => {
  const m57 = placeComponent(componentCatalog.chair, "m57-qa-position", 1000, 1000);
  const footprint = getRotatedCorners(
    348,
    389,
    m57.widthMm,
    m57.depthMm,
    0,
  );

  assert.deepEqual(getBounds(footprint), {
    minX: 80.5,
    maxX: 615.5,
    minY: 93,
    maxY: 685,
  });
  assert.equal(
    get2DCollisionObstacles(booth).every(
      (obstacle) => !polygonsOverlap(footprint, rectToPoints(obstacle)),
    ),
    true,
  );

  const result = tryMoveComponent(booth, m57, 348, 389);
  assert.equal(result.accepted, true);
  assert.equal(result.component.xMm, 348);
  assert.equal(result.component.yMm, 389);
});

test("M57 can touch either carpet edge in the open front half", () => {
  const m57 = placeComponent(componentCatalog.chair, "m57-open-front-edges", 1000, 1000);

  assert.equal(tryMoveComponent(booth, m57, 267.5, 389).accepted, true);
  assert.equal(tryMoveComponent(booth, m57, 1732.5, 389).accepted, true);
});

test("M57 remains blocked by both rear side walls and the back wall", () => {
  const m57 = placeComponent(componentCatalog.chair, "m57-real-walls", 1000, 1000);

  assert.equal(tryMoveComponent(booth, m57, 267.5, 1400).accepted, false);
  assert.equal(tryMoveComponent(booth, m57, 1732.5, 1400).accepted, false);
  assert.equal(tryMoveComponent(booth, m57, 1000, 1700).accepted, false);
});

test("M57 reaches the authored P86 walls at physical tangency; 0.001 mm overlap is rejected", () => {
  const m57 = placeComponent(componentCatalog.chair, "m57-physical-tangency", 1000, 1000);
  const tangentCases = [
    { wall: "left", x: 297.5, y: 1400, overlapX: -0.001, overlapY: 0 },
    { wall: "right", x: 1702.5, y: 1400, overlapX: 0.001, overlapY: 0 },
    { wall: "back", x: 1000, y: 1674, overlapX: 0, overlapY: 0.001 },
  ] as const;

  for (const { wall, x, y, overlapX, overlapY } of tangentCases) {
    assert.equal(
      tryMoveComponent(booth, m57, x, y).accepted,
      true,
      `${wall} exact physical touch must be valid`,
    );
    assert.equal(
      tryMoveComponent(booth, m57, x + overlapX, y + overlapY).accepted,
      false,
      `${wall} 0.001 mm physical overlap must be invalid`,
    );
  }
});

test("drag preserves the grabbed point instead of treating the pointer as M57 center", () => {
  const m57 = placeComponent(componentCatalog.chair, "m57-drag-anchor", 348, 389);
  const offset = createComponentDragOffset(m57, { x: 80.5, y: 389 });
  const flushLeftCenter = resolveDraggedComponentCenter(
    { x: 0, y: 389 },
    offset,
  );

  assert.deepEqual(flushLeftCenter, { x: 267.5, y: 389 });
  assert.equal(
    tryMoveComponent(
      booth,
      m57,
      flushLeftCenter.x,
      flushLeftCenter.y,
    ).accepted,
    true,
  );
});

test("P86 snap preserves exact half-millimeter physical tangency on both X and Y", () => {
  const m57 = placeComponent(componentCatalog.chair, "m57-exact-tangent", 1000, 1000);

  const snappedRight = applySnap(booth, m57, 1690, 1400, 0);
  assert.equal(snappedRight.x, 1702.5);
  assert.equal(tryMoveComponent(booth, m57, snappedRight.x, snappedRight.y).accepted, true);
  assert.equal(tryMoveComponent(booth, m57, snappedRight.x + 0.001, snappedRight.y).accepted, false);

  const rotated = { ...m57, rotationDeg: 90 };
  const snappedBack = applySnap(booth, rotated, 1000, 1690, 90);
  assert.equal(snappedBack.y, 1702.5);
  assert.equal(tryMoveComponent(booth, rotated, snappedBack.x, snappedBack.y).accepted, true);
  assert.equal(tryMoveComponent(booth, rotated, snappedBack.x, snappedBack.y + 0.001).accepted, false);
});

test("typovka pointer handler validates the exact snapped center without display rounding", () => {
  const source = readFileSync(
    new URL("../components/BoothGenerator.tsx", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("const directMove = tryMoveComponent(");
  const end = source.indexOf(
    'setEditorMessage(\n      "Kolize s konstrukcí – objekt tudy neprojde."',
    start,
  );
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(source.slice(start, end), /Math\.round\(snapped\.[xy]\)/u);
});

test("userLocked objekt nelze přesunout přes X/Y input", () => {
  const lockedChair = setUserLock(chair, true);
  const result = tryMoveComponent(booth, lockedChair, 500, 1200);

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "locked");
  assert.equal(result.component, lockedChair);
});

test("změna zoomu nemění hodnoty X/Y komponenty", () => {
  const originalPosition = { xMm: chair.xMm, yMm: chair.yMm };

  zoomAroundScreenPoint(
    { zoom: 1, pan: { x: 0, y: 0 } },
    3,
    { x: 300, y: 240 },
  );

  assert.deepEqual(
    { xMm: chair.xMm, yMm: chair.yMm },
    originalPosition,
  );
});

test("rozměry non-resizable komponenty nejsou editovatelné", () => {
  assert.equal(canResizeComponent(componentCatalog.chair), false);
  assert.equal(canResizeComponent(chair), false);
  assert.equal(chair.widthMm, componentCatalog.chair.widthMm);
  assert.equal(chair.depthMm, componentCatalog.chair.depthMm);
});
