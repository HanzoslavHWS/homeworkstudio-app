import assert from "node:assert/strict";
import test from "node:test";
import { compareStandNumbersNatural, normalizeStandNumber, sortStandNumbersNatural } from "../domain/technicalStandNumber.ts";

// =========================================================================================
// Technické rastry — spec section 37A/37B.
// =========================================================================================

test("A) normalizeStandNumber: conservative whitespace-only normalization, never fuzzy-corrects, never touches the letter suffix", () => {
  assert.equal(normalizeStandNumber("1A01"), "1A01");
  assert.equal(normalizeStandNumber("1A11b"), "1A11b");
  assert.equal(normalizeStandNumber(" 1A21 "), "1A21");
  assert.equal(normalizeStandNumber("1 A 21"), "1A21");
});

test("normalizeStandNumber never changes case or reorders characters", () => {
  assert.equal(normalizeStandNumber("1B02b"), "1B02b");
  assert.equal(normalizeStandNumber("1C01"), "1C01");
});

test("B) natural sorting: 1A09 < 1A10 < 1A11 < 1A11b < 1A12 — never plain lexicographic string sort", () => {
  const input = ["1A11b", "1A12", "1A09", "1A11", "1A10"];
  const sorted = sortStandNumbersNatural(input, (value) => value);
  assert.deepEqual(sorted, ["1A09", "1A10", "1A11", "1A11b", "1A12"]);
});

test("natural sort genuinely differs from a plain lexicographic string sort (single vs. double-digit numbers without a shared prefix)", () => {
  const input = ["1A10", "1A2", "1A1"];
  const naturallySorted = sortStandNumbersNatural(input, (value) => value);
  assert.deepEqual(naturallySorted, ["1A1", "1A2", "1A10"]);

  const naiveSort = [...input].sort();
  assert.notDeepEqual(naiveSort, naturallySorted, "a plain string sort places '1A10' before '1A2' — natural sort must not");
});

test("compareStandNumbersNatural: a shorter value that's a strict prefix of a longer one sorts first (1A11 before 1A11b)", () => {
  assert.ok(compareStandNumbersNatural("1A11", "1A11b") < 0);
  assert.ok(compareStandNumbersNatural("1A11b", "1A11") > 0);
  assert.equal(compareStandNumbersNatural("1A21", "1A21"), 0);
});

test("natural sort handles a realistic multi-sector list correctly", () => {
  const input = ["1B17", "1A01", "1C01", "1A03", "1A11", "1B04", "1A11b", "1A21"];
  const sorted = sortStandNumbersNatural(input, (value) => value);
  assert.deepEqual(sorted, ["1A01", "1A03", "1A11", "1A11b", "1A21", "1B04", "1B17", "1C01"]);
});

// =========================================================================================
// normalizeStandNumber — property-style whitespace variations (spec batch 2.5 section 13). All
// of these are SAFE whitespace-only variations that must collapse to the same "1A21" — but a
// malformed/typo'd token must pass through UNCHANGED (never guessed/auto-corrected), since
// normalizeStandNumber's own contract is "strip whitespace only" (domain/technicalStandNumber.ts).
// =========================================================================================
const SAFE_WHITESPACE_VARIATIONS: readonly string[] = ["1A21", " 1A21 ", "1 A 21", "1A 21", "1 A21", "\t1A21\n", "1A21   "];

for (const variation of SAFE_WHITESPACE_VARIATIONS) {
  test(`normalizeStandNumber(${JSON.stringify(variation)}) -> "1A21"`, () => {
    assert.equal(normalizeStandNumber(variation), "1A21");
  });
}

const MALFORMED_INPUTS_NEVER_CORRECTED: readonly string[] = ["1A2I", "IA21", "1A-21"];

for (const malformed of MALFORMED_INPUTS_NEVER_CORRECTED) {
  test(`normalizeStandNumber(${JSON.stringify(malformed)}) is NEVER aggressively "fixed" to "1A21" — passes through with only whitespace stripped`, () => {
    const result = normalizeStandNumber(malformed);
    assert.notEqual(result, "1A21", `"${malformed}" must not be silently corrected to a valid-looking stand number`);
    assert.equal(result, malformed, "no internal whitespace to strip in these examples, so the result is exactly the (trimmed) input");
  });
}

// =========================================================================================
// Natural sorting — additional edge cases (spec batch 2.5 section 14): letter suffixes a/b/c in
// sequence, and a genuinely different sector prefix (2A01) sorting after all of sector 1's stands.
// =========================================================================================
test("natural sort: consecutive letter suffixes a < b < c sort in that order after their shared base number", () => {
  const input = ["1A11c", "1A11a", "1A11", "1A11b"];
  const sorted = sortStandNumbersNatural(input, (value) => value);
  assert.deepEqual(sorted, ["1A11", "1A11a", "1A11b", "1A11c"]);
});

test("natural sort: a full realistic run (01/02/09/10/11/11a/11b/12, then sector B, then a different HALL prefix 2A01) is stable and correctly ordered", () => {
  const input = ["2A01", "1B01", "1A12", "1A11b", "1A11a", "1A11", "1A10", "1A09", "1A02", "1A01"];
  const sorted = sortStandNumbersNatural(input, (value) => value);
  assert.deepEqual(sorted, ["1A01", "1A02", "1A09", "1A10", "1A11", "1A11a", "1A11b", "1A12", "1B01", "2A01"]);
});

test("natural sort is stable for already-equal values (no reordering of duplicates)", () => {
  const input = ["1A01", "1A01", "1A01"];
  const sorted = sortStandNumbersNatural(input, (value) => value);
  assert.deepEqual(sorted, ["1A01", "1A01", "1A01"]);
});
