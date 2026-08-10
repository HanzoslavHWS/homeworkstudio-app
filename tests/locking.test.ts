import assert from "node:assert/strict";
import test from "node:test";

import {
  applyUnlockedChange,
  isObjectLocked,
  setUserLock,
  toggleUserLock,
} from "../domain/locking.ts";

const editableObject = {
  id: "chair-1",
  systemLocked: false,
  userLocked: false,
  xMm: 500,
  yMm: 600,
  rotationDeg: 0,
};

test("systemLocked objekt nelze přesunout", () => {
  const systemLocked = {
    ...editableObject,
    systemLocked: true,
  };
  const moved = applyUnlockedChange(systemLocked, { xMm: 900, yMm: 1000 });

  assert.equal(moved, systemLocked);
  assert.equal(moved.xMm, 500);
  assert.equal(moved.yMm, 600);
});

test("systemLocked objekt nelze uživatelsky odemknout", () => {
  const systemLocked = {
    ...editableObject,
    systemLocked: true,
    userLocked: true,
  };
  const result = setUserLock(systemLocked, false);

  assert.equal(result, systemLocked);
  assert.equal(isObjectLocked(result), true);
  assert.equal(result.userLocked, true);
});

test("userLocked mobiliář nelze přesunout", () => {
  const userLocked = setUserLock(editableObject, true);
  const moved = applyUnlockedChange(userLocked, { xMm: 1200, yMm: 1300 });

  assert.equal(moved, userLocked);
  assert.equal(moved.xMm, 500);
  assert.equal(moved.yMm, 600);
});

test("userLocked mobiliář nelze otočit", () => {
  const userLocked = setUserLock(editableObject, true);
  const rotated = applyUnlockedChange(userLocked, { rotationDeg: 135 });

  assert.equal(rotated, userLocked);
  assert.equal(rotated.rotationDeg, 0);
});

test("po odemčení lze mobiliář znovu přesunout a otočit", () => {
  const userLocked = setUserLock(editableObject, true);
  const unlocked = setUserLock(userLocked, false);
  const changed = applyUnlockedChange(unlocked, {
    xMm: 1200,
    yMm: 1300,
    rotationDeg: 37,
  });

  assert.equal(isObjectLocked(unlocked), false);
  assert.equal(changed.xMm, 1200);
  assert.equal(changed.yMm, 1300);
  assert.equal(changed.rotationDeg, 37);
});

test("user lock lze opakovaně toggle", () => {
  const locked = toggleUserLock(editableObject);
  const unlocked = toggleUserLock(locked);

  assert.equal(locked.userLocked, true);
  assert.equal(unlocked.userLocked, false);
});

test("system lock nelze toggle", () => {
  const systemLocked = {
    ...editableObject,
    systemLocked: true,
  };
  const result = toggleUserLock(systemLocked);

  assert.equal(result, systemLocked);
  assert.equal(isObjectLocked(result), true);
});
