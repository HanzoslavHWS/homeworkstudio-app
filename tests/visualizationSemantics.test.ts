import assert from "node:assert/strict";
import test from "node:test";
import {
  EDITABLE_ENVIRONMENT_COLOR,
  isProtectedCategory,
  PROTECTED_CATEGORIES,
  SEMANTIC_CATEGORY_COLORS,
  SEMANTIC_CATEGORY_USERDATA_KEY,
  SEMANTIC_TAGGING_CONTRACT,
} from "../domain/visualizationSemantics.ts";

// =========================================================================================
// Visualization v3 — semantic tagging contract (report section 3/39): generic, never
// P86/koje-2x2-specific; editable-environment is the mask complement, never enumerated.
// =========================================================================================

test("CATEGORIES: exactly the 4 concrete protected categories, panels collapsed into booth-construction", () => {
  assert.deepEqual([...PROTECTED_CATEGORIES].sort(), ["artwork", "booth-construction", "booth-floor", "furniture"]);
});

test("EDITABLE ENVIRONMENT: never a member of the protected category enum", () => {
  assert.equal(isProtectedCategory("editable-environment"), false);
  assert.ok(!(PROTECTED_CATEGORIES as readonly string[]).includes("editable-environment"));
});

test("COLORS: every protected category has a distinct color, none of them equal to the editable-environment (black) color", () => {
  const colors = PROTECTED_CATEGORIES.map((category) => SEMANTIC_CATEGORY_COLORS[category]);
  const serialized = colors.map((color) => `${color.r},${color.g},${color.b}`);
  assert.equal(new Set(serialized).size, colors.length, "no two protected categories share a color");
  assert.ok(colors.every((color) => !(color.r === EDITABLE_ENVIRONMENT_COLOR.r && color.g === EDITABLE_ENVIRONMENT_COLOR.g && color.b === EDITABLE_ENVIRONMENT_COLOR.b)));
});

test("CONTRACT: every protected category has exactly one tagging rule", () => {
  const categories = SEMANTIC_TAGGING_CONTRACT.map((rule) => rule.category).sort();
  assert.deepEqual(categories, [...PROTECTED_CATEGORIES].sort());
});

test("CONTRACT: booth-construction and artwork need NO new tagging — resolved from identifiers that already exist for other reasons", () => {
  const construction = SEMANTIC_TAGGING_CONTRACT.find((rule) => rule.category === "booth-construction")!;
  const artwork = SEMANTIC_TAGGING_CONTRACT.find((rule) => rule.category === "artwork")!;
  assert.equal(construction.isNewTagging, false);
  assert.equal(artwork.isNewTagging, false);
  assert.match(artwork.identifier, /PRINT_ARTWORK_OVERLAY_MARKER/u);
});

test("CONTRACT: furniture and booth-floor are the only categories needing new tagging — exactly one userData key, applied minimally", () => {
  const furniture = SEMANTIC_TAGGING_CONTRACT.find((rule) => rule.category === "furniture")!;
  const boothFloor = SEMANTIC_TAGGING_CONTRACT.find((rule) => rule.category === "booth-floor")!;
  assert.equal(furniture.isNewTagging, true);
  assert.equal(boothFloor.isNewTagging, true);
  assert.match(furniture.identifier, new RegExp(SEMANTIC_CATEGORY_USERDATA_KEY));
  assert.match(boothFloor.identifier, new RegExp(SEMANTIC_CATEGORY_USERDATA_KEY));
});

test("GENERIC: no rule identifier or source mentions a specific booth/product id (P86, koje-2x2, or similar)", () => {
  const serialized = JSON.stringify(SEMANTIC_TAGGING_CONTRACT);
  assert.doesNotMatch(serialized, /P86|koje/iu);
});
