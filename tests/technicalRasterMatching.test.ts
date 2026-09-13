import assert from "node:assert/strict";
import test from "node:test";
import { matchStandNumberToRasterLabels } from "../domain/technicalRasterMatching.ts";
import type { RasterStandLabel } from "../domain/technicalRaster.ts";

// =========================================================================================
// Technické rastry — exact-match assignment engine (spec section 19/37F-H). NO AI, NO fuzzy
// matching: string equality only, and a duplicate NEVER auto-picks one candidate.
// =========================================================================================

function label(normalizedStandNumber: string, id = crypto.randomUUID()): RasterStandLabel {
  return { id, rawText: normalizedStandNumber, normalizedStandNumber, page: 1, xNormalized: 0.1, yNormalized: 0.1, widthNormalized: 0.02, heightNormalized: 0.01 };
}

test("F) found exactly once -> matched_auto, matchMethod 'exact'", () => {
  const labels = [label("1A21")];
  const result = matchStandNumberToRasterLabels("1A21", labels);
  assert.equal(result.status, "matched_auto");
  assert.equal(result.status === "matched_auto" && result.label.normalizedStandNumber, "1A21");
  assert.equal(result.status === "matched_auto" && result.matchMethod, "exact");
});

test("G) found more than once -> ambiguous, NEVER auto-picks one of the candidates", () => {
  const labels = [label("1A21", "a"), label("1A21", "b")];
  const result = matchStandNumberToRasterLabels("1A21", labels);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.status === "ambiguous" && result.candidateLabels.length, 2);
});

test("H) not found in the raster at all -> unassigned", () => {
  const labels = [label("1A01")];
  const result = matchStandNumberToRasterLabels("1B99", labels);
  assert.equal(result.status, "unassigned");
});

test("matching is exact-string only — a different suffix or case never matches (no fuzzy correction)", () => {
  const labels = [label("1A11")];
  assert.equal(matchStandNumberToRasterLabels("1A11b", labels).status, "unassigned");
  assert.equal(matchStandNumberToRasterLabels("1a11", labels).status, "unassigned");
});

test("three or more occurrences of the same number are still reported as ambiguous with ALL candidates, not just the first two", () => {
  const labels = [label("1A21", "a"), label("1A21", "b"), label("1A21", "c")];
  const result = matchStandNumberToRasterLabels("1A21", labels);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.status === "ambiguous" && result.candidateLabels.length, 3);
});

// =========================================================================================
// CORRECTIVE BATCH (real production, tolerant stand-number matching) — real H3 evidence: raster
// labels read "3A1"/"3B7" (no leading zero), imported technical/catalog rows read "3A01"/"3B07".
// See domain/technicalStandNumberIdentity.ts's own doc for the exact canonical-identity scope.
// =========================================================================================

test("TOLERANT: raster '3A1', imported '3A01' -> matched_auto via the tolerant canonical pass (real H3 evidence)", () => {
  const labels = [label("3A1")];
  const result = matchStandNumberToRasterLabels("3A01", labels);
  assert.equal(result.status, "matched_auto");
  assert.equal(result.status === "matched_auto" && result.matchMethod, "tolerant_normalized");
  assert.equal(result.status === "matched_auto" && result.label.normalizedStandNumber, "3A1", "the RASTER's own raw label text is never rewritten");
});

test("TOLERANT: raster '3B7', imported '3B07' -> matched_auto (tolerant)", () => {
  const result = matchStandNumberToRasterLabels("3B07", [label("3B7")]);
  assert.equal(result.status, "matched_auto");
  assert.equal(result.status === "matched_auto" && result.matchMethod, "tolerant_normalized");
});

test("TOLERANT: raster '1B02b', imported '1B2b' -> matched_auto (tolerant) — the letter suffix is compared as exact text, never touched by the zero-tolerance", () => {
  const result = matchStandNumberToRasterLabels("1B2b", [label("1B02b")]);
  assert.equal(result.status, "matched_auto");
  assert.equal(result.status === "matched_auto" && result.matchMethod, "tolerant_normalized");
});

test("TOLERANT: reversed direction also works — raster '3A01', imported '3A1' -> matched_auto (tolerant)", () => {
  const result = matchStandNumberToRasterLabels("3A1", [label("3A01")]);
  assert.equal(result.status, "matched_auto");
  assert.equal(result.status === "matched_auto" && result.matchMethod, "tolerant_normalized");
});

test("PRECEDENCE: an EXACT match always wins over a tolerant one, even when a tolerant candidate ALSO exists in the raster", () => {
  // Raster somehow contains BOTH "3A1" and "3A01" (a real, if unusual, raster-detection shape).
  const labels = [label("3A1"), label("3A01")];
  const result = matchStandNumberToRasterLabels("3A01", labels);
  assert.equal(result.status, "matched_auto");
  assert.equal(result.status === "matched_auto" && result.matchMethod, "exact", "the exact '3A01' label must win outright, never falling through to the tolerant pass");
  assert.equal(result.status === "matched_auto" && result.label.normalizedStandNumber, "3A01");
});

test("PRECEDENCE: canonical ambiguity — raster contains BOTH '3A1' and '3A01', imported '3A001' (no exact match) shares its canonical identity with BOTH -> ambiguous, never a guess", () => {
  const labels = [label("3A1"), label("3A01")];
  const result = matchStandNumberToRasterLabels("3A001", labels);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.status === "ambiguous" && result.candidateLabels.length, 2);
});

test("TOLERANT never widens exact match's own case-sensitivity/suffix-exactness guarantees — a different suffix or case still never matches even under the tolerant pass", () => {
  const labels = [label("1A11")];
  assert.equal(matchStandNumberToRasterLabels("1A11b", labels).status, "unassigned");
  assert.equal(matchStandNumberToRasterLabels("1a11", labels).status, "unassigned");
});
