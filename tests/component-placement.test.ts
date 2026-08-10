import assert from "node:assert/strict";
import test from "node:test";

import { boothTypes } from "../data/booths.ts";
import { componentCatalog, placeComponent } from "../data/components.ts";
import { canResizeComponent } from "../domain/components.ts";
import { setUserLock } from "../domain/locking.ts";
import { tryMoveComponent } from "../geometry/placement.ts";
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
  const result = tryMoveComponent(booth, chair, 1000, 200);

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "invalid-position");
  assert.equal(result.component, chair);
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
