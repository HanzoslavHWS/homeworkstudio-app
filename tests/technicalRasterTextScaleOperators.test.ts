import assert from "node:assert/strict";
import test from "node:test";
import { computeTextScalePatchIndices, type TextScaleOpCodes } from "../domain/technicalRasterTextScaleOperators.ts";
import type { OperatorListLike } from "../domain/technicalRasterWhiteModeOperators.ts";

// =========================================================================================
// Technické rastry — PRODUCTION BATCH, PART A: the LIVE EDITOR's own text-scaling operator-list
// patch-plan algorithm (mirrors tests/technicalRasterWhiteModeOperators.test.ts's own fake-op-code
// discipline). This module only ever decides WHICH operator index is a target `setFont` call — the
// actual scaling happens in the canvas Proxy (lib/pdf/pdfWhiteModeCanvasProxy.ts), tested separately.
// =========================================================================================

const BEGIN_MC_PROPS = 70;
const END_MC = 71;
const SET_FONT = 50;

const OPS: TextScaleOpCodes = {
  beginMarkedContentProps: BEGIN_MC_PROPS,
  beginMarkedContent: 69,
  endMarkedContent: END_MC,
  setFont: SET_FONT,
};

function beginMc(groupId: string): [number, unknown] {
  return [BEGIN_MC_PROPS, ["OC", groupId]];
}
function endMc(): [number, unknown] {
  return [END_MC, null];
}
function buildOperatorList(entries: readonly [number, unknown][]): OperatorListLike {
  return { fnArray: entries.map((e) => e[0]), argsArray: entries.map((e) => e[1]) };
}

test("a setFont call inside the target layer's own span is patched", () => {
  const list = buildOperatorList([beginMc("NAMES"), [SET_FONT, ["F1", 12]], endMc()]);
  const result = computeTextScalePatchIndices(list, "NAMES", OPS);
  assert.equal(result.status, "patched");
  if (result.status !== "patched") return;
  assert.deepEqual(result.patchedIndices, [1]);
});

test("a setFont call OUTSIDE the target layer is never patched", () => {
  const list = buildOperatorList([[SET_FONT, ["F1", 12]], beginMc("NAMES"), endMc()]);
  const result = computeTextScalePatchIndices(list, "NAMES", OPS);
  assert.equal(result.status, "unsupported", "zero matches inside the target — nothing to scale");
});

test("a setFont call inside a DIFFERENT layer is never patched — per-layer, not global", () => {
  const list = buildOperatorList([beginMc("STANDS"), [SET_FONT, ["F1", 12]], endMc()]);
  const result = computeTextScalePatchIndices(list, "NAMES", OPS);
  assert.equal(result.status, "unsupported");
});

test("multiple setFont calls inside the same target layer are ALL patched, in index order", () => {
  const list = buildOperatorList([beginMc("NAMES"), [SET_FONT, ["F1", 12]], [1, "Tj"], [SET_FONT, ["F1", 8]], endMc()]);
  const result = computeTextScalePatchIndices(list, "NAMES", OPS);
  assert.equal(result.status, "patched");
  if (result.status !== "patched") return;
  assert.deepEqual(result.patchedIndices, [1, 3]);
});

test("zero text found in the target layer is 'unsupported' — the caller only ever invokes this for a layer already confirmed to contain text", () => {
  const list = buildOperatorList([beginMc("NAMES"), [91, "geometry"], endMc()]);
  const result = computeTextScalePatchIndices(list, "NAMES", OPS);
  assert.equal(result.status, "unsupported");
});
