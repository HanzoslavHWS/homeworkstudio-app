/**
 * Technické rastry — corrective batch (3rd, post real-file acceptance test) section 8/9: pure
 * geometry/text-serialization for converting a SHAPED font glyph run into raw PDF path-construction
 * operators (`m`/`l`/`c`/`h` plus a trailing nonzero-winding fill `f`), completely bypassing PDF
 * text-showing operators (`BT`/`Tf`/`Tj`/`TJ`/`ET`) and any embedded Type0/CID composite font.
 *
 * WHY: real manual acceptance found CorelDRAW 2018 drops this app's own generator-added technical
 * placement labels (2kW/5kW/6kW/INT/IP/"*") on import, while the SAME export's realization
 * underlines (`page.drawLine`, pure vector stroke, no font involved) and the water-drop symbol
 * (`page.drawSvgPath`, pure vector fill, no font involved) import correctly. Since every FAILING
 * overlay element uses `page.drawText()` (this app's embedded NotoSansCzech font, a Type0 composite
 * font with `/Identity-H` encoding, a `CIDFontType2` descendant, and an embedded `FontFile2` — a
 * well-documented category of PDF-import incompatibility in various Corel versions) and every
 * SUCCEEDING element has zero text/font operators at all, elimination points squarely at the
 * Type0/CID text representation itself, not at a generic overlay/content-stream problem. Converting
 * ONLY the generator's own marker glyphs to true vector outlines sidesteps the font-compatibility
 * question entirely — filled Bézier path geometry renders identically in any PDF-conformant
 * consumer, Corel included, without depending on how well that consumer implements composite fonts.
 *
 * This module is deliberately the PURE half of that fix (framework-free, zero fontkit/pdf-lib
 * dependency — fully unit-testable with synthetic glyph-command fixtures, same domain/lib split
 * this codebase already uses throughout): it only knows how to turn an already-shaped glyph run
 * (font-design-unit coordinates, TrueType-style quadratic Béziers) into PDF operator text. Loading
 * the real embedded font via fontkit and shaping a real string into glyphs is lib/technicalRasterVectorPdf.ts's
 * own job — this module never touches a font file.
 */

export type GlyphOutlineCommand =
  | Readonly<{ type: "moveTo"; x: number; y: number }>
  | Readonly<{ type: "lineTo"; x: number; y: number }>
  | Readonly<{ type: "quadraticCurveTo"; cx: number; cy: number; x: number; y: number }>
  | Readonly<{ type: "bezierCurveTo"; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number }>
  | Readonly<{ type: "closePath" }>;

export type PositionedGlyphOutline = Readonly<{
  /** One glyph's own path commands, in the font's native design-unit coordinate space (Y-up, PDF-space convention — never pre-flipped). */
  commands: readonly GlyphOutlineCommand[];
  /** This glyph's cumulative horizontal advance offset from the start of the string, in the SAME font design units as the commands' own x/y — i.e. NOT yet scaled by fontSizePt/unitsPerEm. */
  advanceOffset: number;
}>;

function formatCoord(value: number): string {
  // Rounds to a sub-hundredth-of-a-point precision (plenty for a ~3-4pt marker glyph) and strips a
  // trailing ".000"/trailing zeros so the emitted operators stay compact — cosmetic only, every
  // real PDF reader accepts arbitrary decimal precision here.
  const rounded = Math.round(value * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

/**
 * Degree-elevates ONE quadratic Bézier segment (TrueType's own native curve type — every command
 * this module ever receives from a real TrueType outline is `moveTo`/`lineTo`/`quadraticCurveTo`/
 * `closePath`, never a cubic) into the PDF content stream's own cubic-only `c` operator, using the
 * standard exact conversion: given quadratic control point Q with segment endpoints P0 (the current
 * point) and P1 (this command's own endpoint), the equivalent cubic control points are
 * `C1 = P0 + (2/3)(Q-P0)` and `C2 = P1 + (2/3)(Q-P1)` — algebraically exact, not an approximation.
 */
function quadraticToCubicControlPoints(
  p0x: number,
  p0y: number,
  qx: number,
  qy: number,
  p1x: number,
  p1y: number,
): Readonly<{ c1x: number; c1y: number; c2x: number; c2y: number }> {
  return {
    c1x: p0x + (2 / 3) * (qx - p0x),
    c1y: p0y + (2 / 3) * (qy - p0y),
    c2x: p1x + (2 / 3) * (qx - p1x),
    c2y: p1y + (2 / 3) * (qy - p1y),
  };
}

/** Emits the raw path-construction operators for ONE glyph's own commands, already translated to `(originX, originY)` and scaled by `unitsToPt` — never a fill/paint operator itself (the caller wraps the WHOLE string's worth of glyphs into a single trailing `f`, exactly like a real font rasterizer's nonzero-winding fill would, so a glyph with an inner counter like "8" or "0" still renders correctly). */
function buildGlyphPathOperators(commands: readonly GlyphOutlineCommand[], originX: number, originY: number, unitsToPt: number): readonly string[] {
  const lines: string[] = [];
  let currentX = 0;
  let currentY = 0;
  const project = (x: number, y: number): readonly [number, number] => [originX + x * unitsToPt, originY + y * unitsToPt];

  for (const command of commands) {
    switch (command.type) {
      case "moveTo": {
        const [px, py] = project(command.x, command.y);
        lines.push(`${formatCoord(px)} ${formatCoord(py)} m`);
        currentX = command.x;
        currentY = command.y;
        break;
      }
      case "lineTo": {
        const [px, py] = project(command.x, command.y);
        lines.push(`${formatCoord(px)} ${formatCoord(py)} l`);
        currentX = command.x;
        currentY = command.y;
        break;
      }
      case "quadraticCurveTo": {
        const control = quadraticToCubicControlPoints(currentX, currentY, command.cx, command.cy, command.x, command.y);
        const [c1x, c1y] = project(control.c1x, control.c1y);
        const [c2x, c2y] = project(control.c2x, control.c2y);
        const [px, py] = project(command.x, command.y);
        lines.push(`${formatCoord(c1x)} ${formatCoord(c1y)} ${formatCoord(c2x)} ${formatCoord(c2y)} ${formatCoord(px)} ${formatCoord(py)} c`);
        currentX = command.x;
        currentY = command.y;
        break;
      }
      case "bezierCurveTo": {
        const [c1x, c1y] = project(command.c1x, command.c1y);
        const [c2x, c2y] = project(command.c2x, command.c2y);
        const [px, py] = project(command.x, command.y);
        lines.push(`${formatCoord(c1x)} ${formatCoord(c1y)} ${formatCoord(c2x)} ${formatCoord(c2y)} ${formatCoord(px)} ${formatCoord(py)} c`);
        currentX = command.x;
        currentY = command.y;
        break;
      }
      case "closePath":
        lines.push("h");
        break;
    }
  }
  return lines;
}

/**
 * Builds a complete, self-contained PDF path-fill content-stream FRAGMENT (no leading color-setting
 * operator, no leading/trailing whitespace requirement, no `BT`/`ET`/`Tf`/`Tj`/`TJ` anywhere) for a
 * whole shaped glyph run, positioned left-to-right from `(originX, originY)` in PDF user-space
 * points. `unitsPerEm`/`fontSizePt` together give the exact scale factor
 * (`fontSizePt / unitsPerEm`) a real text-showing operator would apply internally — computed
 * explicitly here since this bypasses text-showing entirely. Returns an empty string for an empty
 * glyph run (e.g. an all-whitespace label) — never emits a bare/invalid `f` with nothing to fill.
 */
export function buildVectorGlyphPathOperators(glyphs: readonly PositionedGlyphOutline[], originX: number, originY: number, unitsPerEm: number, fontSizePt: number): string {
  const unitsToPt = fontSizePt / unitsPerEm;
  const allLines: string[] = [];
  for (const glyph of glyphs) {
    const glyphOriginX = originX + glyph.advanceOffset * unitsToPt;
    allLines.push(...buildGlyphPathOperators(glyph.commands, glyphOriginX, originY, unitsToPt));
  }
  if (allLines.length === 0) return "";
  return `${allLines.join("\n")}\nf`;
}
