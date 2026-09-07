import test from "node:test";
import assert from "node:assert/strict";
import { resolveGraphicsInstructions } from "../domain/graphicsInstructions.ts";

// Print Surfaces V5 (spec section 7): a resolver, not inline text in the export code — today it
// always returns the safe generic CZ/EN text regardless of company, but a future per-company
// lookup can replace the constant without any call site changing.

test("resolveGraphicsInstructions: returns non-empty CZ and EN text for a known company", () => {
  const instructions = resolveGraphicsInstructions({ id: "creativ-expo", name: "Creativ Expo" });
  assert.ok(instructions.cs.length > 0);
  assert.ok(instructions.en.length > 0);
});

test("resolveGraphicsInstructions: never throws / returns safe fallback text when no company is given", () => {
  const instructions = resolveGraphicsInstructions(undefined);
  assert.ok(instructions.cs.length > 0);
});

test("resolveGraphicsInstructions: today returns the SAME text regardless of which company is passed (no fictional per-company content invented)", () => {
  const a = resolveGraphicsInstructions({ id: "creativ-expo", name: "Creativ Expo" });
  const b = resolveGraphicsInstructions({ id: "macik", name: "Macík" });
  assert.deepEqual(a, b);
});
