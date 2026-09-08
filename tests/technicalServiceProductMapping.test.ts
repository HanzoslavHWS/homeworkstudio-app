import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TECHNICAL_SERVICE_PRODUCT_MAPPING,
  resolveTechnicalServiceProduct,
} from "../domain/technicalServiceProductMapping.ts";

// =========================================================================================
// Technické rastry — service label -> internal product code resolution (spec section 11/29).
// Never a blind hardcoded guess: unresolved unless BOTH a configured mapping AND the live
// catalog agree, and never a second/parallel product catalog.
// =========================================================================================

test("DEFAULT_TECHNICAL_SERVICE_PRODUCT_MAPPING is deliberately empty — no pre-guessed codes shipped", () => {
  assert.deepEqual(DEFAULT_TECHNICAL_SERVICE_PRODUCT_MAPPING, {});
});

test("with the default (empty) mapping, every label is unresolved_product regardless of the catalog", () => {
  const catalog = [{ id: "cat-1", internalCode: "L21" }];
  const result = resolveTechnicalServiceProduct("electricity", "Do 2 kW 230V", catalog);
  assert.deepEqual(result, { status: "unresolved_product" });
});

test("resolves only when the mapping's target code ALSO actually exists in the live catalog", () => {
  const mapping = { electricity: { "do 2 kw 230v": "L21" } };
  const catalogWithCode = [{ id: "cat-1", internalCode: "L21" }];
  const resolved = resolveTechnicalServiceProduct("electricity", "Do 2 kW 230V", catalogWithCode, mapping);
  assert.deepEqual(resolved, { status: "resolved", internalProductId: "cat-1", internalProductCode: "L21" });
});

test("a configured code that has drifted out of the live catalog (renamed/removed) is unresolved_product, never trusted blindly", () => {
  const mapping = { electricity: { "do 2 kw 230v": "L21" } };
  const catalogWithoutCode = [{ id: "cat-2", internalCode: "L99" }];
  const result = resolveTechnicalServiceProduct("electricity", "Do 2 kW 230V", catalogWithoutCode, mapping);
  assert.deepEqual(result, { status: "unresolved_product" });
});

test("label matching is whitespace/case tolerant but NOT fuzzy across categories — same label in a different category does not resolve", () => {
  const mapping = { electricity: { "internet": "L21" } };
  const catalog = [{ id: "cat-1", internalCode: "L21" }];
  const result = resolveTechnicalServiceProduct("internet", "Internet", catalog, mapping);
  assert.deepEqual(result, { status: "unresolved_product" });
});

test("label key normalization tolerates surrounding whitespace and extra internal spaces", () => {
  const mapping = { electricity: { "do 2 kw 230v": "L21" } };
  const catalog = [{ id: "cat-1", internalCode: "L21" }];
  const result = resolveTechnicalServiceProduct("electricity", "  Do  2 kW 230V  ", catalog, mapping);
  assert.equal(result.status, "resolved");
});
