import assert from "node:assert/strict";
import test from "node:test";
import {
  computeWhiteModeArgsArray,
  detectStandLayerId,
  type OperatorListLike,
  type WhiteModeOpCodes,
} from "../domain/technicalRasterWhiteModeOperators.ts";

// =========================================================================================
// Technické rastry — white-mode operator-list patching (spec batch 2, section 24 A-G). Real PDF
// evidence (Hala 1.pdf): every stand is drawn with ONE combined constructPath call whose paint
// type is closeEOFillStroke, preceded by setFillRGBColor/setStrokeRGBColor — so this module must
// whiten only the fill-COLOR-SETTING operator, never the paint call itself (which also strokes).
// Fake, small op codes are used throughout — this file has zero pdf.js dependency by design.
// =========================================================================================

const OPS: WhiteModeOpCodes = {
  beginMarkedContentProps: 70,
  beginMarkedContent: 69,
  endMarkedContent: 71,
  constructPath: 91,
  rawFillPath: 94,
  fillPaintTypes: new Set([22, 23, 24, 25, 26, 27]), // fill, eoFill, fillStroke, eoFillStroke, closeFillStroke, closeEOFillStroke
  fillColorSetters: new Set([54, 57, 59, 61]), // setFillColor, setFillGray, setFillRGBColor, setFillCMYKColor
  // setFillColorN(55) is deliberately here, not above — the real adapter (lib/pdf/technicalRasterWhiteRender.ts)
  // excludes it from fillColorSetters because it resolves to a Pattern/TilingPattern object, not a
  // plain CSS color string assigned synchronously like setFillRGBColor (verified against pdf.js's
  // own source in Batch 2) — this fixture mirrors that real classification exactly.
  unsupportedFillOps: new Set([55, 62, 85, 83]), // setFillColorN, shadingFill, paintImageXObject, paintImageMaskXObject
};

const SET_FILL_RGB = 59;
const SET_STROKE_RGB = 58;
const CONSTRUCT_PATH = 91;
const BEGIN_MC_PROPS = 70;
const END_MC = 71;
const FILL_STROKE = 24;
const CLOSE_EO_FILL_STROKE = 27;
const STROKE_ONLY = 20;
const FILL_ONLY = 22;

function beginMc(groupId: string): [number, unknown] {
  return [BEGIN_MC_PROPS, ["OC", groupId]];
}
function endMc(): [number, unknown] {
  return [END_MC, null];
}

function buildOperatorList(entries: readonly [number, unknown][]): OperatorListLike {
  return { fnArray: entries.map((e) => e[0]), argsArray: entries.map((e) => e[1]) };
}

test("A) fillStroke inside the stand layer: fill color is whitened, stroke color op is untouched", () => {
  const list = buildOperatorList([
    beginMc("STANDS"),
    [SET_STROKE_RGB, ["#2c2e35"]],
    [SET_FILL_RGB, ["#009edd"]],
    [CONSTRUCT_PATH, [FILL_STROKE, "geometry-a"]],
    endMc(),
  ]);
  const result = computeWhiteModeArgsArray(list, "STANDS", OPS);
  assert.equal(result.status, "patched");
  if (result.status !== "patched") return;
  assert.deepEqual(result.argsArray[1], ["#2c2e35"], "stroke color must be exactly unchanged");
  assert.deepEqual(result.argsArray[2], ["#ffffff"], "fill color must become white");
  assert.deepEqual(result.argsArray[3], [FILL_STROKE, "geometry-a"], "the paint/geometry op itself is never touched");
});

test("B) closeEOFillStroke (the real Hala 1.pdf paint type) inside the stand layer: fill whitened, stroke untouched", () => {
  const list = buildOperatorList([
    beginMc("STANDS"),
    [SET_STROKE_RGB, ["#2c2e35"]],
    [SET_FILL_RGB, ["#00b9f2"]],
    [CONSTRUCT_PATH, [CLOSE_EO_FILL_STROKE, "geometry-b"]],
    endMc(),
  ]);
  const result = computeWhiteModeArgsArray(list, "STANDS", OPS);
  assert.equal(result.status, "patched");
  if (result.status !== "patched") return;
  assert.deepEqual(result.argsArray[1], ["#2c2e35"]);
  assert.deepEqual(result.argsArray[2], ["#ffffff"]);
});

test("C) a fill inside a DIFFERENT layer (not the target stand layer) is never touched", () => {
  const list = buildOperatorList([
    beginMc("OTHER_LAYER"),
    [SET_FILL_RGB, ["#009edd"]],
    [CONSTRUCT_PATH, [FILL_STROKE, "geometry-c"]],
    endMc(),
  ]);
  const result = computeWhiteModeArgsArray(list, "STANDS", OPS);
  // no patchable fill was ever found inside the target layer -> refused, never a silent no-op guess.
  assert.equal(result.status, "unsupported");
});

test("D) a pure stroke (no fill component) inside the stand layer is never modified", () => {
  const list = buildOperatorList([
    beginMc("STANDS"),
    [SET_STROKE_RGB, ["#2c2e35"]],
    [SET_FILL_RGB, ["#009edd"]], // set but never used for painting below — a pure stroke op ignores fill entirely
    [CONSTRUCT_PATH, [STROKE_ONLY, "geometry-d"]],
    endMc(),
  ]);
  const result = computeWhiteModeArgsArray(list, "STANDS", OPS);
  // the fill color was set but never consumed by a fill-family paint -> nothing to whiten.
  assert.equal(result.status, "unsupported");
});

test("E) a pure fill (fill-only paint, no stroke) inside the stand layer: fill whitened", () => {
  const list = buildOperatorList([
    beginMc("STANDS"),
    [SET_FILL_RGB, ["#f2d600"]],
    [CONSTRUCT_PATH, [FILL_ONLY, "geometry-e"]],
    endMc(),
  ]);
  const result = computeWhiteModeArgsArray(list, "STANDS", OPS);
  assert.equal(result.status, "patched");
  if (result.status !== "patched") return;
  assert.deepEqual(result.argsArray[1], ["#ffffff"]);
});

test("F) an unresolvable/ambiguous stand layer never triggers a repaint — detectStandLayerId reports it, computeWhiteModeArgsArray is simply never called by the caller", () => {
  assert.deepEqual(detectStandLayerId([{ id: "1", name: "TOPENÍ" }, { id: "2", name: "KANÁLKY" }]), { status: "none" });
  assert.deepEqual(detectStandLayerId([{ id: "1", name: "STÁNKY ***" }, { id: "2", name: "STANDS (duplicate)" }]), { status: "ambiguous", candidateLayerIds: ["1", "2"] });
  // exactly one alias match, diacritics/asterisks/case all tolerated.
  assert.deepEqual(detectStandLayerId([{ id: "46R", name: "STÁNKY ***" }, { id: "17R", name: "TOPENÍ" }]), { status: "found", layerId: "46R" });
});

test("F-continued) a fill mechanism this transform can't safely rewrite (shading/image) inside the target layer refuses the WHOLE transform, never a partial guess", () => {
  const list = buildOperatorList([
    beginMc("STANDS"),
    [62 /* shadingFill */, ["shading-pattern-ref"]],
    endMc(),
  ]);
  const result = computeWhiteModeArgsArray(list, "STANDS", OPS);
  assert.equal(result.status, "unsupported");
});

test("G) the SOURCE operator list is never mutated — computeWhiteModeArgsArray returns an independent copy", () => {
  const sourceArgsArray: unknown[] = [beginMc("STANDS")[1], ["#2c2e35"], ["#009edd"], [FILL_STROKE, "geometry-g"], endMc()[1]];
  const sourceFnArray = [BEGIN_MC_PROPS, SET_STROKE_RGB, SET_FILL_RGB, CONSTRUCT_PATH, END_MC];
  const frozenSnapshot = sourceArgsArray.map((entry) => JSON.stringify(entry));

  const result = computeWhiteModeArgsArray({ fnArray: sourceFnArray, argsArray: sourceArgsArray }, "STANDS", OPS);
  assert.equal(result.status, "patched");

  // the ORIGINAL array's own entries must be byte-for-byte identical to before the call.
  assert.deepEqual(sourceArgsArray.map((entry) => JSON.stringify(entry)), frozenSnapshot);
  if (result.status === "patched") {
    assert.notEqual(result.argsArray, sourceArgsArray, "the result must be a different array instance");
    assert.deepEqual(sourceArgsArray[2], ["#009edd"], "the source's fill-color arg must remain the original color");
  }
});

// Real PDFs (verified against Hala 1.pdf) wrap EACH shape's own color+paint in its own
// save/restore, always re-declaring its own fill color immediately before painting — so this
// algorithm deliberately tracks only "the most recently EXECUTED fill-color-setter, in linear
// operator order" and does NOT simulate a full graphics-state save/restore stack. That is correct
// and sufficient for every real report/raster seen; a PDF that instead relied on `restore()` alone
// (no re-declared color) to bring back an outer color after a nested group is outside this
// module's scope (documented limitation, not a silent miscalculation).
// =========================================================================================
// Explicit coverage for every fill-family paint type this pdf.js version's OPS enum defines
// (spec batch 2.5 section 4: "pure fill, eoFill, fillStroke, eoFillStroke, closeFillStroke,
// closeEOFillStroke" — all six are real, distinct op codes in pdfjs-dist 6.3.289's own OPS
// object, verified directly against it in Batch 2's investigation; none are invented here).
// =========================================================================================
const FILL_TYPE_CASES: readonly (readonly [string, number])[] = [
  ["fill", 22],
  ["eoFill", 23],
  ["fillStroke", 24],
  ["eoFillStroke", 25],
  ["closeFillStroke", 26],
  ["closeEOFillStroke", 27],
];

for (const [name, code] of FILL_TYPE_CASES) {
  test(`paint type "${name}" (op ${code}) inside the stand layer: fill whitened`, () => {
    const list = buildOperatorList([
      beginMc("STANDS"),
      [SET_STROKE_RGB, ["#2c2e35"]],
      [SET_FILL_RGB, ["#00b9f2"]],
      [CONSTRUCT_PATH, [code, "geometry"]],
      endMc(),
    ]);
    const result = computeWhiteModeArgsArray(list, "STANDS", OPS);
    assert.equal(result.status, "patched", `"${name}" must be recognized as a fill-family paint type`);
    if (result.status !== "patched") return;
    assert.deepEqual(result.argsArray[2], ["#ffffff"]);
    assert.deepEqual(result.argsArray[1], ["#2c2e35"], "stroke untouched");
  });
}

test("stroke(20)/closeStroke(21) — the two NON-fill paint types — never trigger a patch even inside the stand layer", () => {
  for (const strokeOnlyCode of [20, 21]) {
    const list = buildOperatorList([
      beginMc("STANDS"),
      [SET_FILL_RGB, ["#00b9f2"]],
      [CONSTRUCT_PATH, [strokeOnlyCode, "geometry"]],
      endMc(),
    ]);
    assert.equal(computeWhiteModeArgsArray(list, "STANDS", OPS).status, "unsupported");
  }
});

test("rawFillPath (fill-only fast path some pdf.js versions use instead of constructPath) inside the stand layer: fill whitened", () => {
  const RAW_FILL_PATH = 94;
  const list = buildOperatorList([
    beginMc("STANDS"),
    [SET_FILL_RGB, ["#8ce1f9"]],
    [RAW_FILL_PATH, ["geometry-rawfill"]],
    endMc(),
  ]);
  const result = computeWhiteModeArgsArray(list, "STANDS", OPS);
  assert.equal(result.status, "patched");
  if (result.status !== "patched") return;
  assert.deepEqual(result.argsArray[1], ["#ffffff"]);
});

// =========================================================================================
// Untouched-state verification (spec batch 2.5 section 4): geometry/transform/line width/dash
// pattern must survive byte-for-byte — only the fill-color-setter's own args entry may change.
// =========================================================================================
test("transform, line width, and dash pattern ops surrounding a whitened fill are all preserved exactly", () => {
  const SET_LINE_WIDTH = 2;
  const SET_DASH = 6;
  const TRANSFORM = 12;
  const list = buildOperatorList([
    beginMc("STANDS"),
    [TRANSFORM, [1, 0, 0, 1, 10, 20]],
    [SET_LINE_WIDTH, [0.216]],
    [SET_DASH, [[2, 2], 0]],
    [SET_STROKE_RGB, ["#2c2e35"]],
    [SET_FILL_RGB, ["#009edd"]],
    [CONSTRUCT_PATH, [CLOSE_EO_FILL_STROKE, "geometry-h"]],
    endMc(),
  ]);
  const result = computeWhiteModeArgsArray(list, "STANDS", OPS);
  assert.equal(result.status, "patched");
  if (result.status !== "patched") return;
  assert.deepEqual(result.argsArray[1], [1, 0, 0, 1, 10, 20], "transform untouched");
  assert.deepEqual(result.argsArray[2], [0.216], "line width untouched");
  assert.deepEqual(result.argsArray[3], [[2, 2], 0], "dash pattern untouched");
  assert.deepEqual(result.argsArray[4], ["#2c2e35"], "stroke color untouched");
  assert.deepEqual(result.argsArray[5], ["#ffffff"], "only the fill color changed");
  assert.deepEqual(result.argsArray[6], [CLOSE_EO_FILL_STROKE, "geometry-h"], "path geometry/paint op untouched");
});

// =========================================================================================
// Nested OCG — the OTHER direction from the existing test below: an OUTER (unrelated) OCG
// wrapping the target stand OCG (spec batch 2.5 section 5's first example).
// =========================================================================================
test("an outer, unrelated OCG wrapping the target stand OCG: paints inside the nested target layer are still correctly whitened", () => {
  const list = buildOperatorList([
    beginMc("OUTER_UNRELATED"),
    [SET_FILL_RGB, ["#111111"]],
    beginMc("STANDS"),
    [SET_FILL_RGB, ["#009edd"]],
    [CONSTRUCT_PATH, [FILL_ONLY, "geometry-nested-target"]],
    endMc(),
    [CONSTRUCT_PATH, [FILL_ONLY, "geometry-outer-own"]],
    endMc(),
  ]);
  const result = computeWhiteModeArgsArray(list, "STANDS", OPS);
  assert.equal(result.status, "patched");
  if (result.status !== "patched") return;
  assert.deepEqual(result.argsArray[3], ["#ffffff"], "the nested target-layer fill is whitened");
  // the outer layer's OWN paint (outside the target OCG) must never receive a fake white fill —
  // there is nothing to assert it changed to, since it was never a patch target: confirm no
  // unexpected second index got whitened.
  assert.deepEqual(result.patchedIndices, [3]);
});

test("unsupported fill via setFillColorN (pattern fill) specifically — never confused with the safe setFillRGBColor family", () => {
  const SET_FILL_COLOR_N = 55;
  const list = buildOperatorList([
    beginMc("STANDS"),
    [SET_FILL_COLOR_N, ["pattern-ref-1"]],
    [CONSTRUCT_PATH, [FILL_ONLY, "geometry-pattern"]],
    endMc(),
  ]);
  const result = computeWhiteModeArgsArray(list, "STANDS", OPS);
  assert.equal(result.status, "unsupported");
});

test("nested marked-content: an inner unrelated layer's own fill never leaks into the stand layer, and the stand layer's OWN re-declared color (as real PDFs do) is whitened correctly", () => {
  const list = buildOperatorList([
    beginMc("STANDS"),
    [SET_FILL_RGB, ["#009edd"]],
    beginMc("INNER_UNRELATED"),
    [SET_FILL_RGB, ["#ff0000"]],
    [CONSTRUCT_PATH, [FILL_ONLY, "geometry-inner"]],
    endMc(),
    [SET_FILL_RGB, ["#009edd"]], // the stand layer re-declares its own color after the nested group, exactly like the real PDF does per shape
    [CONSTRUCT_PATH, [FILL_ONLY, "geometry-outer"]],
    endMc(),
  ]);
  const result = computeWhiteModeArgsArray(list, "STANDS", OPS);
  assert.equal(result.status, "patched");
  if (result.status !== "patched") return;
  // the inner layer's own red fill must survive untouched.
  assert.deepEqual(result.argsArray[3], ["#ff0000"]);
  // the outer stand-layer's re-declared color is whitened.
  assert.deepEqual(result.argsArray[6], ["#ffffff"]);
});
