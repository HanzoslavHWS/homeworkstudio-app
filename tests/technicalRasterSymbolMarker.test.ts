import assert from "node:assert/strict";
import test from "node:test";
import { simulateRenderedPx } from "../domain/technicalRasterSelectedMarker.ts";
import {
  SYMBOL_CLICK_DIAMETER_TARGET_PX,
  SYMBOL_GLYPH_SIZE_TARGET_PX,
  SYMBOL_TEXT_FONT_SIZE_TARGET_PX,
  computeSymbolScreenStyle,
} from "../domain/technicalRasterSymbolMarker.ts";

test("computeSymbolScreenStyle: at zoom 1, the round trip (pre-transform px * zoom) reproduces the exact target on-screen size", () => {
  const style = computeSymbolScreenStyle(1);
  assert.equal(simulateRenderedPx(style.fontSizePx, 1), SYMBOL_TEXT_FONT_SIZE_TARGET_PX);
  assert.equal(simulateRenderedPx(style.glyphSizePx, 1), SYMBOL_GLYPH_SIZE_TARGET_PX);
  assert.equal(simulateRenderedPx(style.clickDiameterPx, 1), SYMBOL_CLICK_DIAMETER_TARGET_PX);
});

test("computeSymbolScreenStyle: zoom-invariant — the actual on-screen size stays constant across a wide zoom range (Fit/100%/600%/1600%/3000%/4000%)", () => {
  for (const zoom of [0.02, 0.5, 1, 6, 16, 30, 40]) {
    const style = computeSymbolScreenStyle(zoom);
    assert.ok(Math.abs(simulateRenderedPx(style.fontSizePx, zoom) - SYMBOL_TEXT_FONT_SIZE_TARGET_PX) < 0.01, `font size drifted at zoom=${zoom}`);
    assert.ok(Math.abs(simulateRenderedPx(style.glyphSizePx, zoom) - SYMBOL_GLYPH_SIZE_TARGET_PX) < 0.01, `glyph size drifted at zoom=${zoom}`);
    assert.ok(Math.abs(simulateRenderedPx(style.clickDiameterPx, zoom) - SYMBOL_CLICK_DIAMETER_TARGET_PX) < 0.01, `click target drifted at zoom=${zoom}`);
  }
});

test("computeSymbolScreenStyle: the click target is always larger than the glyph box, at any zoom", () => {
  for (const zoom of [0.02, 1, 40]) {
    const style = computeSymbolScreenStyle(zoom);
    assert.ok(style.clickDiameterPx > style.glyphSizePx);
  }
});

test("computeSymbolScreenStyle: the selection ring is always larger than the glyph box it surrounds", () => {
  const style = computeSymbolScreenStyle(1);
  assert.ok(style.selectionRingDiameterPx > style.glyphSizePx);
});

test("computeSymbolScreenStyle: at extreme zoom (3000%+), the rendered font/glyph size stays a small, readable on-screen size — never a giant overflow artifact, never grows WITH the raster transform (corrective batch regression guard)", () => {
  for (const zoom of [30, 35.71]) { // 3000%, 3571% (the exact zoom a real manual test used)
    const style = computeSymbolScreenStyle(zoom);
    const renderedFontPx = simulateRenderedPx(style.fontSizePx, zoom);
    const renderedGlyphPx = simulateRenderedPx(style.glyphSizePx, zoom);
    assert.ok(renderedFontPx < 20, `rendered font size ${renderedFontPx}px at zoom=${zoom} is far too large — regression toward the old un-compensated font-size bug`);
    assert.ok(renderedGlyphPx < 20, `rendered glyph size ${renderedGlyphPx}px at zoom=${zoom} is far too large`);
  }
});

test("POST-ACCEPTANCE SIZE BUMP (section 3): visible symbol sizes grew +15–20% over the previous batch's baseline (9px font / 13px glyph), the click target did NOT change at all", () => {
  const PREVIOUS_FONT_TARGET_PX = 9;
  const PREVIOUS_GLYPH_TARGET_PX = 13;
  const PREVIOUS_CLICK_DIAMETER_PX = 26;

  const fontGrowth = SYMBOL_TEXT_FONT_SIZE_TARGET_PX / PREVIOUS_FONT_TARGET_PX;
  const glyphGrowth = SYMBOL_GLYPH_SIZE_TARGET_PX / PREVIOUS_GLYPH_TARGET_PX;
  assert.ok(fontGrowth >= 1.15 && fontGrowth <= 1.20, `font size grew ${((fontGrowth - 1) * 100).toFixed(1)}%, expected +15–20%`);
  assert.ok(glyphGrowth >= 1.15 && glyphGrowth <= 1.20, `glyph size grew ${((glyphGrowth - 1) * 100).toFixed(1)}%, expected +15–20%`);
  assert.equal(SYMBOL_CLICK_DIAMETER_TARGET_PX, PREVIOUS_CLICK_DIAMETER_PX, "the invisible hit target must stay exactly as it was — spec: 'neměnit transparent hit target'");
});
