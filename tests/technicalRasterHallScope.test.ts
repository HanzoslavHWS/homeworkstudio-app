import assert from "node:assert/strict";
import test from "node:test";
import { classifyStandScope, inferCurrentHallPrefix, type StandLabelLike } from "../domain/technicalRasterHallScope.ts";

// ============================================================================
// Corrective batch (multi-hall imports) — the ONE central scope-classification helper. Real-world
// problem: ABF sometimes exports a SINGLE technical-service report mixing rows from several halls
// (e.g. an electricity report with 50 Hala 3 rows and 50 Hala 4 rows). These tests pin the exact,
// deliberately conservative rules that distinguish "genuinely outside this raster's own hall" from
// "just hasn't matched yet" (a real typo must never be hidden as a foreign-hall record).
// ============================================================================

function label(normalizedStandNumber: string): StandLabelLike {
  return { normalizedStandNumber };
}

test("inferCurrentHallPrefix: derives the shared leading digit run when every raster label agrees", () => {
  assert.equal(inferCurrentHallPrefix([label("3A01"), label("3A02"), label("3B01"), label("3C10")]), "3");
});

test("inferCurrentHallPrefix: no raster labels at all -> undefined, never a guess", () => {
  assert.equal(inferCurrentHallPrefix([]), undefined);
});

test("inferCurrentHallPrefix: a label with NO leading digit run at all (e.g. 'A01') -> undefined for the WHOLE raster, never a partial guess", () => {
  assert.equal(inferCurrentHallPrefix([label("A01"), label("A02")]), undefined);
  assert.equal(inferCurrentHallPrefix([label("3A01"), label("A02")]), undefined, "one non-conforming label is enough to abandon the whole inference, never a majority vote");
});

test("inferCurrentHallPrefix: labels that disagree on their own leading digit run -> undefined, never assumed", () => {
  assert.equal(inferCurrentHallPrefix([label("3A01"), label("4A01")]), undefined);
});

test("classifyStandScope: BASIC MULTI-HALL CASE — raster 3A01/3A02/3B01, imported 3A01/4A01/4B02", () => {
  const raster = [label("3A01"), label("3A02"), label("3B01")];
  assert.equal(classifyStandScope("3A01", raster), "currentRaster");
  assert.equal(classifyStandScope("4A01", raster), "outsideCurrentRaster");
  assert.equal(classifyStandScope("4B02", raster), "outsideCurrentRaster");
});

test("classifyStandScope: CURRENT-HALL TYPO — a number sharing the current hall's own prefix but not present in the raster is 'currentRaster' scope, NEVER 'outsideCurrentRaster' (a real typo must never be hidden as a foreign hall)", () => {
  const raster = [label("3A01"), label("3A02")];
  assert.equal(classifyStandScope("3A99", raster), "currentRaster");
  assert.equal(classifyStandScope("3Z99", raster), "currentRaster");
});

test("classifyStandScope: NO RELIABLE HALL PREFIX — raster A01/A02 (no leading digit), imported B99 -> 'unknown', never assumed foreign", () => {
  const raster = [label("A01"), label("A02")];
  assert.equal(classifyStandScope("B99", raster), "unknown");
});

test("classifyStandScope: no raster labels at all -> 'unknown' for any imported number, never a guess", () => {
  assert.equal(classifyStandScope("4A01", []), "unknown");
});

test("classifyStandScope: imported number itself has no leading digit run, even with a reliable raster prefix -> 'unknown', never compared", () => {
  const raster = [label("3A01"), label("3A02")];
  assert.equal(classifyStandScope("XYZ", raster), "unknown");
});

test("classifyStandScope: whitespace/formatting in the imported number is normalized the SAME way the rest of the app already does (reuses normalizeStandNumber, never a second normalization step)", () => {
  const raster = [label("3A01")];
  assert.equal(classifyStandScope(" 4 A 01 ", raster), "outsideCurrentRaster");
});

test("classifyStandScope: a bare digit-only imported value ('3') against a raster whose own prefix is '3' still resolves deterministically (matches on the shared digit run alone), never crashing", () => {
  assert.equal(classifyStandScope("3", [label("3A01")]), "currentRaster");
  assert.equal(classifyStandScope("4", [label("3A01")]), "outsideCurrentRaster");
});
