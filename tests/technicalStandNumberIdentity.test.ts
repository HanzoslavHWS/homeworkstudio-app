import assert from "node:assert/strict";
import test from "node:test";
import { computeStandNumberCanonicalIdentity, parseStandNumberIdentityParts, standNumbersShareCanonicalIdentity } from "../domain/technicalStandNumberIdentity.ts";

// =========================================================================================
// Technické rastry — CORRECTIVE BATCH (real production, tolerant stand-number matching). Real H3
// evidence: raster labels read "3A1"/"3B7" (no leading zero), imported rows read "3A01"/"3B07" for
// the SAME physical stand. This module's canonical identity is deliberately narrow: leading-zero
// equivalence on numeric segments only — never case-insensitive, never letter-suffix-insensitive.
// =========================================================================================

test("parseStandNumberIdentityParts: '3A01' -> [digits:3, text:'A', digits:1] (leading zero already collapsed into the numeric VALUE)", () => {
  assert.deepEqual(parseStandNumberIdentityParts("3A01"), [{ kind: "digits", value: 3 }, { kind: "text", value: "A" }, { kind: "digits", value: 1 }]);
});

test("parseStandNumberIdentityParts: '1B02b' -> [digits:1, text:'B', digits:2, text:'b'] — letter suffix kept as exact text", () => {
  assert.deepEqual(parseStandNumberIdentityParts("1B02b"), [{ kind: "digits", value: 1 }, { kind: "text", value: "B" }, { kind: "digits", value: 2 }, { kind: "text", value: "b" }]);
});

test("computeStandNumberCanonicalIdentity: 3A1 == 3A01 == 3A001 (same integer once parsed)", () => {
  const a = computeStandNumberCanonicalIdentity("3A1");
  const b = computeStandNumberCanonicalIdentity("3A01");
  const c = computeStandNumberCanonicalIdentity("3A001");
  assert.equal(a, b);
  assert.equal(b, c);
});

test("computeStandNumberCanonicalIdentity: 3B7 == 3B07", () => {
  assert.equal(computeStandNumberCanonicalIdentity("3B7"), computeStandNumberCanonicalIdentity("3B07"));
});

test("computeStandNumberCanonicalIdentity: 1A1 == 1A01", () => {
  assert.equal(computeStandNumberCanonicalIdentity("1A1"), computeStandNumberCanonicalIdentity("1A01"));
});

test("computeStandNumberCanonicalIdentity: 1B02b == 1B2b (suffix compared as exact text, unaffected by the numeric-segment tolerance)", () => {
  assert.equal(computeStandNumberCanonicalIdentity("1B02b"), computeStandNumberCanonicalIdentity("1B2b"));
});

test("computeStandNumberCanonicalIdentity: NEVER removes all zeros blindly — a zero that is genuinely part of a DIFFERENT integer stays different", () => {
  assert.notEqual(computeStandNumberCanonicalIdentity("3A10"), computeStandNumberCanonicalIdentity("3A1"), "10 and 1 are genuinely different numbers, not a leading-zero variant of each other");
  assert.notEqual(computeStandNumberCanonicalIdentity("3A100"), computeStandNumberCanonicalIdentity("3A10"));
});

test("computeStandNumberCanonicalIdentity: case is NEVER touched — 1a11 != 1A11 (exact-match's own pinned case-sensitivity guarantee stays intact)", () => {
  assert.notEqual(computeStandNumberCanonicalIdentity("1a11"), computeStandNumberCanonicalIdentity("1A11"));
});

test("computeStandNumberCanonicalIdentity: a letter suffix present on only ONE side is never dropped/ignored — 1A11 != 1A11b", () => {
  assert.notEqual(computeStandNumberCanonicalIdentity("1A11"), computeStandNumberCanonicalIdentity("1A11b"));
});

test("computeStandNumberCanonicalIdentity: whitespace is normalized first, same discipline as normalizeStandNumber elsewhere", () => {
  assert.equal(computeStandNumberCanonicalIdentity(" 3 A 01 "), computeStandNumberCanonicalIdentity("3A1"));
});

test("standNumbersShareCanonicalIdentity: thin boolean wrapper matches computeStandNumberCanonicalIdentity directly", () => {
  assert.equal(standNumbersShareCanonicalIdentity("3A01", "3A1"), true);
  assert.equal(standNumbersShareCanonicalIdentity("3A01", "3A2"), false);
});

test("a bare all-digit stand number (no letters at all) still parses/compares sensibly — '105' == '105', never crashes", () => {
  assert.equal(computeStandNumberCanonicalIdentity("105"), computeStandNumberCanonicalIdentity("105"));
  assert.notEqual(computeStandNumberCanonicalIdentity("105"), computeStandNumberCanonicalIdentity("15"));
});

test("an empty string never crashes — resolves to a stable (if degenerate) canonical identity", () => {
  assert.doesNotThrow(() => computeStandNumberCanonicalIdentity(""));
  assert.equal(computeStandNumberCanonicalIdentity(""), computeStandNumberCanonicalIdentity(""));
});
