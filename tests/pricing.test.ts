import assert from "node:assert/strict";
import test from "node:test";

import { pricingPolicyFor } from "../domain/pricing.ts";

test("typový stánek má fixní cenu konstrukce", () => {
  assert.deepEqual(pricingPolicyFor("typovy"), {
    mode: "fixed",
    structuralChangesAffectPrice: false,
    orderedItemsAffectPrice: true,
  });
});

test("individuální stánek může přecenit změny konstrukce", () => {
  assert.deepEqual(pricingPolicyFor("individualni"), {
    mode: "configuration-dependent",
    structuralChangesAffectPrice: true,
    orderedItemsAffectPrice: true,
  });
});
