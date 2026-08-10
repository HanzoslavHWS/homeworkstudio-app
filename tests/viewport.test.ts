import assert from "node:assert/strict";
import test from "node:test";

import {
  fitWorldToViewport,
  panViewport,
  screenToWorld,
  worldToScreen,
  zoomAroundScreenPoint,
  type ViewportTransform,
} from "../geometry/viewport.ts";

const transform: ViewportTransform = {
  zoom: 2,
  pan: { x: 10, y: 20 },
};

function assertPointClose(
  actual: { x: number; y: number },
  expected: { x: number; y: number },
) {
  assert.ok(Math.abs(actual.x - expected.x) < 1e-9);
  assert.ok(Math.abs(actual.y - expected.y) < 1e-9);
}

test("world coordinates se převedou na screen coordinates", () => {
  assertPointClose(worldToScreen({ x: 100, y: 200 }, transform), {
    x: 70,
    y: 140,
  });
});

test("screen coordinates se převedou zpět na world coordinates", () => {
  assertPointClose(screenToWorld({ x: 70, y: 140 }, transform), {
    x: 100,
    y: 200,
  });
});

test("změna zoomu zachová world position pod kurzorem", () => {
  const worldPosition = { x: 850, y: 1230 };
  const cursorPosition = worldToScreen(worldPosition, transform);
  const zoomed = zoomAroundScreenPoint(transform, 3.5, cursorPosition);

  assertPointClose(screenToWorld(cursorPosition, zoomed), worldPosition);
  assert.deepEqual(worldPosition, { x: 850, y: 1230 });
});

test("pan mění pouze screen position a ne world position", () => {
  const worldPosition = { x: 400, y: 900 };
  const panned = panViewport(transform, { x: 120, y: -45 });
  const screenPosition = worldToScreen(worldPosition, panned);

  assertPointClose(screenToWorld(screenPosition, panned), worldPosition);
  assert.deepEqual(worldPosition, { x: 400, y: 900 });
});

test("Fit přizpůsobí i velký stánek dostupnému viewportu", () => {
  const fitted = fitWorldToViewport(
    { width: 1000, height: 800 },
    { width: 10000, height: 8000 },
  );
  const topLeft = worldToScreen({ x: 0, y: 0 }, fitted);
  const bottomRight = worldToScreen({ x: 10000, y: 8000 }, fitted);

  assert.ok(fitted.zoom >= 0.25 && fitted.zoom <= 4);
  assert.ok(topLeft.x >= 0 && topLeft.y >= 0);
  assert.ok(bottomRight.x <= 1000 && bottomRight.y <= 800);
});
