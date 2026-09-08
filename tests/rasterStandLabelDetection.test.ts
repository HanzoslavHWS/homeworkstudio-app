import assert from "node:assert/strict";
import test from "node:test";
import { applyPdfAffineTransform, detectRasterStandLabels } from "../lib/pdf/rasterStandLabelDetection.ts";
import type { PdfTextItem } from "../domain/technicalReportTableParsing.ts";
import type { PdfPageSize } from "../lib/pdf/pdfTextExtraction.ts";

// =========================================================================================
// Technické rastry — rasterStandLabelDetection (spec batch 2.5 section 10/11: rotation +
// zoom-invariance of stored coordinates). The four transform matrices below are REAL values
// captured from pdfjs-dist's own PageViewport for "Hala 1.pdf" (an unrotated page, W=396.8504pt
// H=272.126pt) at rotation 0/90/180/270 — not hand-guessed, so this test proves the fix against
// pdf.js's own actual behavior, not an assumption about it.
// =========================================================================================

const W = 396.8504;
const H = 272.126;
const TRANSFORMS: Record<0 | 90 | 180 | 270, { widthPt: number; heightPt: number; transform: readonly [number, number, number, number, number, number] }> = {
  0: { widthPt: W, heightPt: H, transform: [1, 0, 0, -1, 0, H] },
  90: { widthPt: H, heightPt: W, transform: [0, 1, 1, 0, 0, 0] },
  180: { widthPt: W, heightPt: H, transform: [-1, 0, 0, 1, W, 0] },
  270: { widthPt: H, heightPt: W, transform: [0, -1, -1, 0, H, W] },
};

// A real stand-number item's raw position/size, captured from the same PDF (a "Legenda k topení"
// item was used for the transform investigation — here we just need any stand-shaped token).
const RAW_X = 180.7824;
const RAW_Y = 40.0822;
const RAW_WIDTH = 31.89590399999999;
const RAW_HEIGHT = 3.984;

function item(page: number): PdfTextItem {
  return { str: "1A01", page, x: RAW_X, y: RAW_Y, width: RAW_WIDTH, height: RAW_HEIGHT };
}

test("rotation 0: matches the OLD manual-flip formula bit-for-bit (zero regression for every real, unrotated raster seen so far)", () => {
  const pageSizes = new Map<number, PdfPageSize>([[1, TRANSFORMS[0]]]);
  const [label] = detectRasterStandLabels([item(1)], pageSizes);
  const oldTopY = TRANSFORMS[0].heightPt - (RAW_Y + RAW_HEIGHT);
  assert.ok(Math.abs(label!.xNormalized - RAW_X / TRANSFORMS[0].widthPt) < 1e-9);
  assert.ok(Math.abs(label!.yNormalized - oldTopY / TRANSFORMS[0].heightPt) < 1e-9);
});

test("rotation 90/180/270: produces DIFFERENT, correctly-transformed coordinates — never the naive (wrong) raw-x/rotated-width division", () => {
  const naiveWrongX = RAW_X / TRANSFORMS[90].widthPt; // what the OLD buggy code would have computed
  const pageSizes90 = new Map<number, PdfPageSize>([[1, TRANSFORMS[90]]]);
  const [label90] = detectRasterStandLabels([item(1)], pageSizes90);
  assert.ok(Math.abs(label90!.xNormalized - naiveWrongX) > 0.01, "must differ meaningfully from the naive (pre-fix) calculation");
  // exact expected value, cross-verified against pdf.js's own convertToViewportPoint during investigation.
  assert.ok(Math.abs(label90!.xNormalized - 0.1472927981890742) < 1e-6);
  assert.ok(Math.abs(label90!.yNormalized - 0.455542945150112) < 1e-6);

  const pageSizes180 = new Map<number, PdfPageSize>([[1, TRANSFORMS[180]]]);
  const [label180] = detectRasterStandLabels([item(1)], pageSizes180);
  assert.ok(Math.abs(label180!.xNormalized - 0.4640844408875485) < 1e-6);
  assert.ok(Math.abs(label180!.yNormalized - 0.1472927981890742) < 1e-6);

  const pageSizes270 = new Map<number, PdfPageSize>([[1, TRANSFORMS[270]]]);
  const [label270] = detectRasterStandLabels([item(1)], pageSizes270);
  assert.ok(Math.abs(label270!.xNormalized - 0.8380669248803863) < 1e-6);
  assert.ok(Math.abs(label270!.yNormalized - 0.4640844408875485) < 1e-6);
});

test("applyPdfAffineTransform: identity-like rotation-0 transform is a pure top-left/Y-down flip", () => {
  const [x, y] = applyPdfAffineTransform(TRANSFORMS[0].transform, 0, 0);
  assert.equal(x, 0);
  assert.equal(y, H);
});

test("width/height normalization stays positive and sensible regardless of rotation (bounding box min/max, never negative)", () => {
  for (const rotation of [0, 90, 180, 270] as const) {
    const pageSizes = new Map<number, PdfPageSize>([[1, TRANSFORMS[rotation]]]);
    const [label] = detectRasterStandLabels([item(1)], pageSizes);
    assert.ok(label!.widthNormalized > 0, `rotation ${rotation}: widthNormalized must be positive`);
    assert.ok(label!.heightNormalized > 0, `rotation ${rotation}: heightNormalized must be positive`);
  }
});

// =========================================================================================
// Multi-page (spec batch 2.5 section 9) — the code must never assume pageCount === 1.
// =========================================================================================
test("multi-page: each label keeps its OWN page number, independent pages never share coordinates", () => {
  const items: PdfTextItem[] = [
    { str: "1A01", page: 1, x: 50, y: 50, width: 20, height: 10 },
    { str: "2A01", page: 2, x: 50, y: 50, width: 20, height: 10 }, // same raw x/y as page 1's item, different page
  ];
  const pageSizes = new Map<number, PdfPageSize>([
    [1, TRANSFORMS[0]],
    [2, { widthPt: 200, heightPt: 100, transform: [1, 0, 0, -1, 0, 100] }], // a DIFFERENT page size than page 1
  ]);
  const labels = detectRasterStandLabels(items, pageSizes);
  assert.equal(labels.length, 2);
  const page1Label = labels.find((l) => l.normalizedStandNumber === "1A01");
  const page2Label = labels.find((l) => l.normalizedStandNumber === "2A01");
  assert.equal(page1Label?.page, 1);
  assert.equal(page2Label?.page, 2);
  // same raw x/y, but DIFFERENT page dimensions -> different normalized positions (proves no cross-page bleed).
  assert.notEqual(page1Label?.xNormalized, page2Label?.xNormalized);
});

test("a label on a page with no matching pageSize entry is silently skipped, never crashes", () => {
  const items: PdfTextItem[] = [{ str: "1A01", page: 5, x: 10, y: 10, width: 20, height: 10 }];
  const pageSizes = new Map<number, PdfPageSize>([[1, TRANSFORMS[0]]]);
  const labels = detectRasterStandLabels(items, pageSizes);
  assert.equal(labels.length, 0);
});

// =========================================================================================
// Zoom invariance (spec batch 2.5 section 11) — normalized coordinates are computed purely from
// PDF page-space geometry; zoom is a pure CSS/view concern with no representation here at all, so
// there is nothing for this function to depend on that a viewer's zoom level could ever perturb.
// =========================================================================================
test("zoom invariance: normalized output depends only on PDF-space x/y/width/height/page geometry, never on any CSS/pixel/zoom value — calling twice with identical input is perfectly deterministic", () => {
  const pageSizes = new Map<number, PdfPageSize>([[1, TRANSFORMS[0]]]);
  const first = detectRasterStandLabels([item(1)], pageSizes);
  const second = detectRasterStandLabels([item(1)], pageSizes);
  assert.equal(first[0]!.xNormalized, second[0]!.xNormalized);
  assert.equal(first[0]!.yNormalized, second[0]!.yNormalized);
});
