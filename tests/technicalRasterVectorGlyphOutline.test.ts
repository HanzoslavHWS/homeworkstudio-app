import assert from "node:assert/strict";
import test from "node:test";
import { buildVectorGlyphPathOperators, type GlyphOutlineCommand, type PositionedGlyphOutline } from "../domain/technicalRasterVectorGlyphOutline.ts";

// ============================================================================
// Corrective batch (3rd, post real-file acceptance test) section 8/9 — CorelDRAW 2018 was found to
// drop this app's own generator-added technical placement TEXT (2kW/5kW/INT/IP/"*") on import, while
// non-text vector overlays (realization underlines, the water-drop symbol) import fine. This module
// is the structural fix: it converts a shaped glyph run into pure fill-path operators, never a
// text-showing operator. These tests pin down the STRUCTURE of what gets emitted — proving the
// generated content genuinely never depends on BT/Tf/Tj/TJ/ET or any font resource at all.
// ============================================================================

const FORBIDDEN_TEXT_OPERATORS = ["BT", "ET", "Tf", "Tj", "TJ", "Tr", "Td", "TD"];

function assertNoTextOperators(output: string): void {
  const tokens = output.split(/\s+/u);
  for (const forbidden of FORBIDDEN_TEXT_OPERATORS) {
    assert.ok(!tokens.includes(forbidden), `output must never contain the text-showing operator "${forbidden}" — got:\n${output}`);
  }
}

test("a single straight-line glyph (a synthetic square, moveTo/lineTo/closePath only) emits m/l/h operators plus a trailing fill, no text operators at all", () => {
  const commands: GlyphOutlineCommand[] = [
    { type: "moveTo", x: 0, y: 0 },
    { type: "lineTo", x: 100, y: 0 },
    { type: "lineTo", x: 100, y: 100 },
    { type: "lineTo", x: 0, y: 100 },
    { type: "closePath" },
  ];
  const glyphs: PositionedGlyphOutline[] = [{ commands, advanceOffset: 0 }];
  const output = buildVectorGlyphPathOperators(glyphs, 10, 20, 1000, 10);
  assertNoTextOperators(output);
  assert.ok(output.trimEnd().endsWith("f"), "must end with a nonzero-winding fill operator");
  assert.ok(output.includes(" m"), "must include a moveTo");
  assert.ok(output.includes(" l"), "must include lineTo operators");
  assert.ok(output.includes("h"), "must include the closePath operator");
  assert.ok(!output.includes(" c"), "a straight-line-only glyph must never emit a curve operator");
});

test("a quadratic curve command is degree-elevated to an exact cubic 'c' operator via the standard 2/3 control-point formula", () => {
  // A single quadratic segment: P0=(0,0) -> Q=(50,100) -> P1=(100,0), unitsPerEm=1 so PDF points equal design units directly (scale factor fontSizePt/unitsPerEm = 1).
  const commands: GlyphOutlineCommand[] = [
    { type: "moveTo", x: 0, y: 0 },
    { type: "quadraticCurveTo", cx: 50, cy: 100, x: 100, y: 0 },
  ];
  const output = buildVectorGlyphPathOperators([{ commands, advanceOffset: 0 }], 0, 0, 1, 1);
  assertNoTextOperators(output);
  // Expected exact cubic control points: C1 = (0,0) + 2/3*(50,100) = (33.333, 66.667); C2 = (100,0) + 2/3*(50-100, 100-0) = (66.667, 66.667).
  const cLine = output.split("\n").find((line) => line.endsWith(" c"));
  assert.ok(cLine, "must contain exactly one cubic curve operator line");
  const numbers = cLine!.split(" ").slice(0, -1).map(Number);
  assert.equal(numbers.length, 6);
  const [c1x, c1y, c2x, c2y, px, py] = numbers;
  assert.ok(Math.abs(c1x! - 33.333) < 0.01);
  assert.ok(Math.abs(c1y! - 66.667) < 0.01);
  assert.ok(Math.abs(c2x! - 66.667) < 0.01);
  assert.ok(Math.abs(c2y! - 66.667) < 0.01);
  assert.equal(px, 100);
  assert.equal(py, 0);
});

test("multiple glyphs in a run are positioned left-to-right via advanceOffset, scaled by fontSizePt/unitsPerEm, and share ONE trailing fill", () => {
  const glyphA: PositionedGlyphOutline = { commands: [{ type: "moveTo", x: 0, y: 0 }, { type: "lineTo", x: 500, y: 0 }, { type: "closePath" }], advanceOffset: 0 };
  const glyphB: PositionedGlyphOutline = { commands: [{ type: "moveTo", x: 0, y: 0 }, { type: "lineTo", x: 500, y: 0 }, { type: "closePath" }], advanceOffset: 600 };
  // unitsPerEm=1000, fontSizePt=10 -> scale factor 0.01; glyphB's own origin shifts by 600*0.01=6pt from originX.
  const output = buildVectorGlyphPathOperators([glyphA, glyphB], 100, 200, 1000, 10);
  assert.equal(output.split("\n").filter((line) => line === "f").length, 1, "exactly one trailing fill for the whole run, never per-glyph");
  const moveLines = output.split("\n").filter((line) => line.endsWith(" m"));
  assert.equal(moveLines.length, 2, "one moveTo per glyph");
  assert.equal(moveLines[0], "100 200 m");
  assert.equal(moveLines[1], "106 200 m", "second glyph's origin must be shifted by its own advanceOffset * (fontSizePt/unitsPerEm)");
});

test("an empty glyph run (e.g. an all-whitespace label) produces an empty string, never a bare/invalid fill operator", () => {
  assert.equal(buildVectorGlyphPathOperators([], 0, 0, 1000, 10), "");
  assert.equal(buildVectorGlyphPathOperators([{ commands: [], advanceOffset: 0 }], 0, 0, 1000, 10), "");
});

test("the emitted output structurally never contains any text-showing or font-selection operator, for a realistic multi-glyph label", () => {
  const digit: GlyphOutlineCommand[] = [
    { type: "moveTo", x: 100, y: 0 },
    { type: "quadraticCurveTo", cx: 200, cy: 50, x: 100, y: 700 },
    { type: "quadraticCurveTo", cx: 0, cy: 350, x: 100, y: 0 },
    { type: "closePath" },
  ];
  const glyphs: PositionedGlyphOutline[] = [
    { commands: digit, advanceOffset: 0 },
    { commands: digit, advanceOffset: 550 },
    { commands: digit, advanceOffset: 1100 },
  ];
  const output = buildVectorGlyphPathOperators(glyphs, 0, 0, 1000, 3.3);
  assertNoTextOperators(output);
  assert.ok(!output.includes("/"), "must never reference a font resource name (no '/FontName' operand of any kind)");
});
