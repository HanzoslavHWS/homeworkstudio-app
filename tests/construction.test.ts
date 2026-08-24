import assert from "node:assert/strict";
import test from "node:test";

import { boothTypes } from "../data/booths.ts";
import {
  getVisiblePlanConstructionParts,
  groupConstructionParts,
} from "../domain/construction.ts";
import { resolveBoothPlanPresentation } from "../domain/boothPlan.ts";
import {
  collisionObstacleToPlanRect,
  get2DCollisionObstacles,
} from "../geometry/construction.ts";
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
      { x: 100, y: 1500, rotationDeg: 0 },
    ),
    false,
  );
  assert.equal(
    isPlacementValid(
      booth,
      { widthMm: 200, depthMm: 200 },
      { x: 100, y: 500, rotationDeg: 0 },
    ),
    true,
  );
  assert.equal(
    get2DCollisionObstacles(booth).some(
      (obstacle) => obstacle.id === "left-wall",
    ),
    true,
  );
});

test("P86 uses the authored 30 mm inward physical obstruction, never the legacy 80 mm visual profile", () => {
  assert.deepEqual(get2DCollisionObstacles(booth), [
    { id: "back-wall", x: 0, y: 1970, width: 2000, height: 30 },
    { id: "left-wall", x: 0, y: 1000, width: 30, height: 1000 },
    { id: "right-wall", x: 1970, y: 1000, width: 30, height: 1000 },
  ]);
});

test("P86 internal collision presentation geometry stays derived from the physical obstacles", () => {
  const depthMm = booth.depthMm ?? 0;
  const obstacles = get2DCollisionObstacles(booth);
  const plan = resolveBoothPlanPresentation(booth);

  assert.deepEqual(
    plan.constructionAreas.map(({ rect }) => rect),
    obstacles.map((obstacle) =>
      collisionObstacleToPlanRect(obstacle, depthMm),
    ),
  );
  assert.deepEqual(
    plan.collisionLines.map(({ constructionPartId, x1, y1, x2, y2 }) => ({
      constructionPartId,
      x1,
      y1,
      x2,
      y2,
    })),
    [
      { constructionPartId: "back-wall", x1: 0, y1: 30, x2: 2000, y2: 30 },
      { constructionPartId: "left-wall", x1: 30, y1: 0, x2: 30, y2: 1000 },
      { constructionPartId: "right-wall", x1: 1970, y1: 0, x2: 1970, y2: 1000 },
    ],
  );
});

test("each hidden HWS wall removes its hard obstacle and internal presentation line together", () => {
  const wallAssemblies = [
    ["HWS_ASM_BACK_WALL", "back-wall"],
    ["HWS_ASM_LEFT_WALL", "left-wall"],
    ["HWS_ASM_RIGHT_WALL", "right-wall"],
  ] as const;

  for (const [assemblyId, obstacleId] of wallAssemblies) {
    const visibility = { [assemblyId]: false };
    assert.equal(
      get2DCollisionObstacles(booth, visibility).some(
        (obstacle) => obstacle.id === obstacleId,
      ),
      false,
    );
    assert.equal(
      resolveBoothPlanPresentation(booth, visibility).collisionLines.some(
        (line) => line.constructionPartId === obstacleId,
      ),
      false,
    );
  }
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
