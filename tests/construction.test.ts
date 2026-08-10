import assert from "node:assert/strict";
import test from "node:test";

import { boothTypes } from "../data/booths.ts";
import {
  getVisiblePlanConstructionParts,
  groupConstructionParts,
} from "../domain/construction.ts";
import { get2DCollisionObstacles } from "../geometry/construction.ts";
import { isPlacementValid } from "../geometry/placement.ts";

const booth = boothTypes.find((item) => item.id === "koje-2x2");

if (!booth) {
  throw new Error("Testovací definice Koje 2 × 2 nebyla nalezena.");
}

test("overhead konstrukce má collision2D vypnutou", () => {
  const overheadParts = booth.constructionParts.filter(
    (part) => part.planViewType === "overhead",
  );

  assert.deepEqual(
    overheadParts.map((part) => part.id),
    ["collar", "upper-grid"],
  );
  assert.equal(overheadParts.every((part) => !part.collision2D), true);
});

test("overhead překážka se nezapočítá do 2D hard collision", () => {
  const boothWithOverheadObstacle = {
    ...booth,
    constructionParts: booth.constructionParts.map((part) =>
      part.id === "upper-grid"
        ? { ...part, collisionObstacleId: "upper-grid-obstacle" }
        : part,
    ),
    collisionObstacles: [
      ...booth.collisionObstacles,
      { id: "upper-grid-obstacle", x: 80, y: 80, width: 1840, height: 1840 },
    ],
  };

  assert.equal(
    get2DCollisionObstacles(boothWithOverheadObstacle).some(
      (obstacle) => obstacle.id === "upper-grid-obstacle",
    ),
    false,
  );
});

test("ground konstrukce stále koliduje", () => {
  assert.equal(
    isPlacementValid(
      booth,
      { widthMm: 200, depthMm: 200 },
      { x: 100, y: 500, rotationDeg: 0 },
    ),
    false,
  );
  assert.equal(
    get2DCollisionObstacles(booth).some(
      (obstacle) => obstacle.id === "left-wall",
    ),
    true,
  );
});

test("hidden overhead prvek se nevrátí k vykreslení", () => {
  const visibleOverhead = getVisiblePlanConstructionParts(
    booth,
    "overhead",
    { "upper-grid": false },
  );

  assert.equal(visibleOverhead.some((part) => part.id === "upper-grid"), false);
  assert.equal(visibleOverhead.some((part) => part.id === "collar"), true);
});

test("vypnutí visibility overhead prvku nemění projektová data", () => {
  const upperGrid = booth.constructionParts.find(
    (part) => part.id === "upper-grid",
  );
  const visibilityOverride = { "upper-grid": false } as const;

  getVisiblePlanConstructionParts(
    booth,
    "overhead",
    visibilityOverride,
  );

  assert.ok(upperGrid);
  assert.equal(upperGrid.visible, true);
  assert.equal(booth.constructionParts.includes(upperGrid), true);
  assert.equal(booth.constructionParts.length, 5);
});

test("Scene struktura odděluje ground a overhead prvky", () => {
  const groups = groupConstructionParts(booth.constructionParts);

  assert.deepEqual(
    groups.ground.map((part) => part.id),
    ["back-wall", "left-wall", "right-wall"],
  );
  assert.deepEqual(
    groups.overhead.map((part) => part.id),
    ["collar", "upper-grid"],
  );
});
