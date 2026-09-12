import assert from "node:assert/strict";
import test from "node:test";
import { simulateRenderedPx } from "../domain/technicalRasterSelectedMarker.ts";
import {
  REALIZATION_UNDERLINE_FALLBACK_WIDTH_NORMALIZED,
  REALIZATION_UNDERLINE_THICKNESS_TARGET_PX,
  computeRealizationUnderlineGeometry,
  computeRealizationUnderlineScreenStyle,
} from "../domain/technicalRasterRealizationUnderline.ts";

// ============================================================================
// Corrective batch (post real-file acceptance test) section 4/5 — realization UNDERLINE, replacing
// the "badge" design that failed manual acceptance.
// ============================================================================

test("computeRealizationUnderlineGeometry: WITH a real label bbox — the line spans roughly the label's own width, positioned strictly BELOW its bottom edge", () => {
  const bbox = { widthNormalized: 0.05, heightNormalized: 0.02 };
  const anchor = { xNormalized: 0.3, yNormalized: 0.4 }; // label's own top-left
  const geometry = computeRealizationUnderlineGeometry(anchor, bbox);

  // Below the bbox's own bottom edge (anchor.y + bbox.height), never overlapping the number itself.
  assert.ok(geometry.yNormalized > anchor.yNormalized + bbox.heightNormalized, "the line must sit BELOW the label, never overlapping it");
  // Roughly the label's own width, with only a small padding — never "sahá zbytečně daleko".
  assert.ok(geometry.widthNormalized > bbox.widthNormalized, "should be at least as wide as the label (plus small padding)");
  assert.ok(geometry.widthNormalized < bbox.widthNormalized * 1.3, "padding must stay small — never a wildly oversized line");
  // Centered-ish on the label (padding split evenly).
  assert.ok(geometry.xNormalized < anchor.xNormalized, "left edge extends slightly left of the label's own left edge");
});

test("computeRealizationUnderlineGeometry: WITHOUT a bbox (manual match, anchor only) — falls back to a small fixed-width line, never crashes, never invents a large size", () => {
  const anchor = { xNormalized: 0.5, yNormalized: 0.5 };
  const geometry = computeRealizationUnderlineGeometry(anchor);
  assert.equal(geometry.widthNormalized, REALIZATION_UNDERLINE_FALLBACK_WIDTH_NORMALIZED);
  assert.ok(geometry.yNormalized > anchor.yNormalized, "still positioned below the anchor point");
  // Centered on the anchor.
  assert.ok(Math.abs(geometry.xNormalized + geometry.widthNormalized / 2 - anchor.xNormalized) < 1e-9);
});

test("computeRealizationUnderlineGeometry: different label widths produce proportionally different line widths — never a fixed magic number regardless of the real label size", () => {
  const anchor = { xNormalized: 0.1, yNormalized: 0.1 };
  const short = computeRealizationUnderlineGeometry(anchor, { widthNormalized: 0.02, heightNormalized: 0.01 });
  const long = computeRealizationUnderlineGeometry(anchor, { widthNormalized: 0.08, heightNormalized: 0.01 });
  assert.ok(long.widthNormalized > short.widthNormalized * 3, "a 4x wider label must produce a meaningfully wider line");
});

test("computeRealizationUnderlineScreenStyle: zoom-invariant line thickness across Fit/100%/600%/1600%/3000%+", () => {
  for (const zoom of [0.05, 1, 6, 16, 30, 40]) {
    const style = computeRealizationUnderlineScreenStyle(zoom);
    assert.ok(Math.abs(simulateRenderedPx(style.thicknessPx, zoom) - REALIZATION_UNDERLINE_THICKNESS_TARGET_PX) < 0.05, `thickness drifted at zoom=${zoom}`);
  }
});

test("computeRealizationUnderlineScreenStyle: at extreme zoom (3571%, the exact value a real manual test used), the rendered thickness stays small — never grows with the raster transform", () => {
  const zoom = 35.71;
  const style = computeRealizationUnderlineScreenStyle(zoom);
  const rendered = simulateRenderedPx(style.thicknessPx, zoom);
  assert.ok(rendered < 10, `rendered thickness ${rendered}px at zoom=${zoom} is far too large — the exact 'extremely dominant at zoom' failure this redesign must avoid`);
});

test("computeRealizationUnderlineScreenStyle: the line is visible but not dominant — thickness stays modest relative to typical text/glyph sizes in this module family", () => {
  const style = computeRealizationUnderlineScreenStyle(1);
  assert.ok(style.thicknessPx >= 2 && style.thicknessPx <= 5, `thickness ${style.thicknessPx}px at 100% zoom should read as a visible but not dominant line`);
});
