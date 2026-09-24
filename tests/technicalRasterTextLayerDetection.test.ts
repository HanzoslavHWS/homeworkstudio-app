import assert from "node:assert/strict";
import test from "node:test";
import { detectOcgIdsContainingText, type OperatorListLike, type TextLayerDetectionOpCodes } from "../domain/technicalRasterTextLayerDetection.ts";

// =========================================================================================
// Technické rastry — PRODUCTION BATCH, PART A section 3: "detect whether the layer contains text
// operators before showing the size control." Fake, small op codes — zero pdf.js dependency.
// =========================================================================================

const BEGIN_MC_PROPS = 70;
const END_MC = 71;
const SHOW_TEXT = 40;
const SHOW_SPACED_TEXT = 41;
const CONSTRUCT_PATH = 91;

const OPS: TextLayerDetectionOpCodes = {
  beginMarkedContentProps: BEGIN_MC_PROPS,
  beginMarkedContent: 69,
  endMarkedContent: END_MC,
  showTextOps: new Set([SHOW_TEXT, SHOW_SPACED_TEXT]),
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

test("a layer with a real showText operator inside its own span is detected as containing text", () => {
  const list = buildOperatorList([beginMc("NAMES"), [SHOW_TEXT, ["Stand 1"]], endMc()]);
  assert.deepEqual([...detectOcgIdsContainingText(list, OPS)], ["NAMES"]);
});

test("a purely geometric layer (no text operator anywhere) is never flagged", () => {
  const list = buildOperatorList([beginMc("STANDS"), [CONSTRUCT_PATH, "geometry"], endMc()]);
  assert.deepEqual([...detectOcgIdsContainingText(list, OPS)], []);
});

test("text outside any marked-content span never attributes to a layer", () => {
  const list = buildOperatorList([[SHOW_TEXT, ["free text"]]]);
  assert.deepEqual([...detectOcgIdsContainingText(list, OPS)], []);
});

test("text nested inside an unrelated tagged span (e.g. accessibility BMC) still attributes to the nearest REAL OCG ancestor", () => {
  const list = buildOperatorList([beginMc("NAMES"), [69, undefined], [SHOW_TEXT, ["x"]], [END_MC, null], endMc()]);
  assert.deepEqual([...detectOcgIdsContainingText(list, OPS)], ["NAMES"]);
});

test("multiple distinct layers with text are all reported, each exactly once regardless of how many text ops they contain", () => {
  const list = buildOperatorList([
    beginMc("NAMES"), [SHOW_TEXT, ["a"]], [SHOW_TEXT, ["b"]], endMc(),
    beginMc("NUMBERS"), [SHOW_SPACED_TEXT, ["c"]], endMc(),
    beginMc("STANDS"), [CONSTRUCT_PATH, "geom"], endMc(),
  ]);
  assert.deepEqual([...detectOcgIdsContainingText(list, OPS)].sort(), ["NAMES", "NUMBERS"]);
});

test("an empty operator list never crashes, returns an empty set", () => {
  assert.deepEqual([...detectOcgIdsContainingText(buildOperatorList([]), OPS)], []);
});
