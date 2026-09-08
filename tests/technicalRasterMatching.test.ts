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

test("F) found exactly once -> matched_auto", () => {
  const labels = [label("1A21")];
  const result = matchStandNumberToRasterLabels("1A21", labels);
  assert.equal(result.status, "matched_auto");
  assert.equal(result.status === "matched_auto" && result.label.normalizedStandNumber, "1A21");
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
