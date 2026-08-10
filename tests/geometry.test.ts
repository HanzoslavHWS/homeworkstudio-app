import assert from "node:assert/strict";
import test from "node:test";

import { boothTypes } from "../data/booths.ts";
import { applySnap, isPlacementValid } from "../geometry/placement.ts";
import { quickRotation, rotationForMode } from "../geometry/rotation.ts";

const booth = boothTypes.find((item) => item.id === "koje-2x2");

if (!booth) {
  throw new Error("Testovací definice Koje 2 × 2 nebyla nalezena.");
}

const furniture = { widthMm: 400, depthMm: 400 };
const compactFurniture = { widthMm: 200, depthMm: 200 };
const snap45Rotation = {
  defaultMode: "snap",
  snapStep: 45,
  quickAngles: [0, 45, 90, 135, 180, 225, 270, 315],
  allowFreeRotation: true,
  locked: false,
} as const;
const snap90Rotation = {
  defaultMode: "snap",
  snapStep: 90,
  quickAngles: [0, 90, 180, 270],
  allowFreeRotation: false,
  locked: false,
} as const;
const lockedRotation = {
  ...snap90Rotation,
  locked: true,
} as const;

test("objekt neprojde skrz konstrukční stěnu", () => {
  assert.equal(
    isPlacementValid(booth, furniture, {
      x: 1000,
      y: 200,
      rotationDeg: 0,
    }),
    false,
  );
});

test("objekt se může konstrukční stěny přesně dotknout", () => {
  assert.equal(
    isPlacementValid(booth, furniture, {
      x: 1000,
      y: 280,
      rotationDeg: 0,
    }),
    true,
  );
});

test("objekt nesmí opustit plochu stánku", () => {
  assert.equal(
    isPlacementValid(booth, furniture, {
      x: 1000,
      y: 1900,
      rotationDeg: 0,
    }),
    false,
  );
});

test("objekt koliduje s levým bokem pouze v oblasti Y < 1000", () => {
  assert.equal(
    isPlacementValid(booth, compactFurniture, {
      x: 100,
      y: 500,
      rotationDeg: 0,
    }),
    false,
  );
  assert.equal(
    isPlacementValid(booth, compactFurniture, {
      x: 100,
      y: 1500,
      rotationDeg: 0,
    }),
    true,
  );
  assert.equal(
    applySnap(booth, compactFurniture, 120, 1500, 0).x,
    100,
  );
});

test("objekt koliduje s pravým bokem pouze v oblasti Y < 1000", () => {
  assert.equal(
    isPlacementValid(booth, compactFurniture, {
      x: 1900,
      y: 500,
      rotationDeg: 0,
    }),
    false,
  );
  assert.equal(
    isPlacementValid(booth, compactFurniture, {
      x: 1900,
      y: 1500,
      rotationDeg: 0,
    }),
    true,
  );
  assert.equal(
    applySnap(booth, compactFurniture, 1880, 1500, 0).x,
    1900,
  );
});

test("free rotation zachová libovolný normalizovaný úhel 0–359°", () => {
  assert.equal(rotationForMode(snap45Rotation, "free", 37, 0), 37);
  assert.equal(rotationForMode(snap45Rotation, "free", -5, 0), 355);
  assert.equal(rotationForMode(snap45Rotation, "free", 360, 0), 0);
});

test("rychlá rotace po 45° funguje", () => {
  assert.equal(rotationForMode(snap45Rotation, "snap", 43, 0), 45);
  assert.equal(quickRotation(snap45Rotation, 135, 0), 135);
});

test("rychlá rotace po 90° funguje", () => {
  assert.equal(rotationForMode(snap90Rotation, "snap", 44, 0), 0);
  assert.equal(rotationForMode(snap90Rotation, "snap", 46, 0), 90);
  assert.equal(quickRotation(snap90Rotation, 270, 0), 270);
});

test("locked rotation zachová původní úhel", () => {
  assert.equal(rotationForMode(lockedRotation, "snap", 90, 17), 17);
  assert.equal(quickRotation(lockedRotation, 90, 17), 17);
});
