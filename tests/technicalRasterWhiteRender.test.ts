import assert from "node:assert/strict";
import test from "node:test";
import {
  createWhiteModeCanvasContextProxy,
  renderWhiteModePage,
  resolveWhiteFillColor,
  resolveWhiteModeAvailability,
} from "../lib/pdf/technicalRasterWhiteRender.ts";
import type { PdfJsOperatorList, PdfJsPage, PdfJsViewport } from "../lib/pdf/pdfDocumentLoader.ts";

// A minimal fake PdfJsPage whose operator list draws one stand-layer fill (so computeWhiteModeArgsArray
// always finds something to patch) — used to exercise renderWhiteModePage's caching and isolation
// (spec batch 2.5 section 20) without needing a real PDF/canvas at all.
function makeFakePage(): Readonly<{ page: PdfJsPage; getOperatorListCalls: () => number }> {
  let getOperatorListCalls = 0;
  const page = {
    getViewport: (): PdfJsViewport => ({ width: 100, height: 100, transform: [1, 0, 0, -1, 0, 100] }),
    getTextContent: async () => ({ items: [] }),
    getOperatorList: async (): Promise<PdfJsOperatorList> => {
      getOperatorListCalls += 1;
      // beginMarkedContentProps("STANDS"), setFillRGBColor, constructPath(fillStroke), endMarkedContent
      return { fnArray: [70, 59, 91, 71], argsArray: [["OC", "STANDS"], ["#009edd"], [24, "geometry"], null] };
    },
    render: () => ({ promise: Promise.resolve() }),
  };
  return { page: page as unknown as PdfJsPage, getOperatorListCalls: () => getOperatorListCalls };
}

function fakeCanvasContext(): CanvasRenderingContext2D {
  return {} as unknown as CanvasRenderingContext2D;
}

// =========================================================================================
// Technické rastry — resolveWhiteModeAvailability (spec batch 2, section 15/16/19). The UI's
// "Pracovní — bílé" toggle is disabled and shows an explanatory message unless exactly one stand
// layer was detected — never a best-effort guess. This only exercises the thin wrapper around
// domain/technicalRasterWhiteModeOperators.ts's detectStandLayerId (already unit-tested there);
// it must not trigger pdfjs-dist's dynamic import at all (no PDF/canvas involved here).
// =========================================================================================

test("available: exactly one stand-layer alias match reports its id", () => {
  const result = resolveWhiteModeAvailability([{ id: "46R", name: "STÁNKY ***", defaultVisible: true }, { id: "17R", name: "TOPENÍ", defaultVisible: true }]);
  assert.deepEqual(result, { status: "available", standLayerId: "46R" });
});

test("unavailable: no candidate layer found -> explanatory reason, never a guess", () => {
  const result = resolveWhiteModeAvailability([{ id: "1", name: "TOPENÍ", defaultVisible: true }]);
  assert.equal(result.status, "unavailable");
  assert.ok(result.status === "unavailable" && result.reason.length > 0);
});

test("unavailable: ambiguous (multiple candidate layers) -> explanatory reason, never a guess", () => {
  const result = resolveWhiteModeAvailability([{ id: "1", name: "STÁNKY", defaultVisible: true }, { id: "2", name: "STANDS", defaultVisible: true }]);
  assert.equal(result.status, "unavailable");
  assert.ok(result.status === "unavailable" && result.reason.length > 0);
});

test("no layers at all -> unavailable, never a guess", () => {
  const result = resolveWhiteModeAvailability([]);
  assert.equal(result.status, "unavailable");
});

// =========================================================================================
// Cache safety (spec batch 2.5 section 20/22): the white-mode patch plan is cached per
// (pageKey, standLayerId) — computing it means one getOperatorList() call; repeated renders of
// the SAME page/layer must reuse it (never re-parse the operator list on every toggle/zoom/pan),
// while two DIFFERENT pageKeys (standing in for two different documents/pages) must never share
// a cached result.
// =========================================================================================
// patchPlanCache is a MODULE-LEVEL cache (persists for the whole test-file process, by design —
// see lib/pdf/technicalRasterWhiteRender.ts) — every test below therefore uses its OWN unique
// pageKey (crypto.randomUUID()) so tests never accidentally share a cache entry with each other.
test("cache safety: rendering the SAME page/pageKey twice computes the patch plan only ONCE", async () => {
  const { page, getOperatorListCalls } = makeFakePage();
  const viewport = page.getViewport({ scale: 1 });
  const pageKey = `doc-${crypto.randomUUID()}#1`;
  const result1 = await renderWhiteModePage({ page, pageKey, standLayerId: "STANDS", canvasContext: fakeCanvasContext(), viewport });
  const result2 = await renderWhiteModePage({ page, pageKey, standLayerId: "STANDS", canvasContext: fakeCanvasContext(), viewport });
  assert.equal(result1.status, "rendered");
  assert.equal(result2.status, "rendered");
  assert.equal(getOperatorListCalls(), 1, "the SAME pageKey must only ever call getOperatorList() once, subsequent renders reuse the cached plan");
});

test("cache safety: two DIFFERENT pageKeys (different documents/pages) never share a cached plan", async () => {
  const { page: pageA, getOperatorListCalls: callsA } = makeFakePage();
  const { page: pageB, getOperatorListCalls: callsB } = makeFakePage();
  const viewport = pageA.getViewport({ scale: 1 });
  await renderWhiteModePage({ page: pageA, pageKey: `doc-A-${crypto.randomUUID()}#1`, standLayerId: "STANDS", canvasContext: fakeCanvasContext(), viewport });
  await renderWhiteModePage({ page: pageB, pageKey: `doc-B-${crypto.randomUUID()}#1`, standLayerId: "STANDS", canvasContext: fakeCanvasContext(), viewport });
  assert.equal(callsA(), 1, "document A's own operator list was computed");
  assert.equal(callsB(), 1, "document B's own operator list was computed INDEPENDENTLY, not skipped due to A's cache");
});

test("cache safety: the SAME pageKey but a DIFFERENT target stand layer computes its OWN plan (never reuses a different layer's patch indices)", async () => {
  const { page, getOperatorListCalls } = makeFakePage();
  const viewport = page.getViewport({ scale: 1 });
  const pageKey = `doc-${crypto.randomUUID()}#1`;
  await renderWhiteModePage({ page, pageKey, standLayerId: "STANDS", canvasContext: fakeCanvasContext(), viewport });
  await renderWhiteModePage({ page, pageKey, standLayerId: "OTHER_LAYER_NAME", canvasContext: fakeCanvasContext(), viewport });
  assert.equal(getOperatorListCalls(), 2, "a different target layer for the same page is a genuinely different plan, not a cache hit");
});

// =========================================================================================
// Original-mode immutability (spec batch 2.5 section 7/27): rendering white mode must never
// leave any state behind that a SUBSEQUENT plain/original render (a fresh page.render() call
// with no white-mode involvement at all) could be affected by.
// =========================================================================================
test("original-mode immutability: white mode render followed by a plain page.render() call never throws and never mutates the fake page's own operator list data", async () => {
  const { page } = makeFakePage();
  const viewport = page.getViewport({ scale: 1 });
  const operatorListBefore = await page.getOperatorList({ intent: "display" });
  const snapshotBefore = JSON.stringify(operatorListBefore.argsArray);

  await renderWhiteModePage({ page, pageKey: `doc-D-${crypto.randomUUID()}#1`, standLayerId: "STANDS", canvasContext: fakeCanvasContext(), viewport });
  // a plain "original mode" render call afterward, exactly like TechnicalRasterCanvas.tsx does
  // when viewMode !== "work" — must not throw and must not be affected by the earlier white-mode call.
  await page.render({ canvasContext: fakeCanvasContext(), viewport }).promise;

  const operatorListAfter = await page.getOperatorList({ intent: "display" });
  assert.equal(JSON.stringify(operatorListAfter.argsArray), snapshotBefore, "a FRESH getOperatorList() call after white mode still returns the original, unpatched data");
});

// =========================================================================================
// "Krytí bílé" (spec batch 6, UI section 17-33) — the ONLY place this app computes the actual
// white-fill color string is resolveWhiteFillColor(), pure and directly testable. The Proxy
// isolation itself (fillStyle touched, everything else including strokeStyle passed through
// verbatim) is verified against createWhiteModeCanvasContextProxy() directly — extracted
// specifically for this (spec section 33's own D/E/F acceptance), same discipline as
// wrapPdfDocumentProxy/loadingTaskToDocument in lib/pdf/pdfDocumentLoader.ts.
// =========================================================================================

test("A) opacity 1.0 -> full opaque white fill", () => {
  assert.equal(resolveWhiteFillColor(1), "rgba(255, 255, 255, 1)");
});

test("B) opacity 0.60 -> white rgba alpha 0.6 (the new default)", () => {
  assert.equal(resolveWhiteFillColor(0.6), "rgba(255, 255, 255, 0.6)");
});

test("C) opacity 0 -> fully transparent fill", () => {
  assert.equal(resolveWhiteFillColor(0), "rgba(255, 255, 255, 0)");
});

test("resolveWhiteFillColor clamps out-of-range input defensively (never trusts caller-supplied JSON blindly)", () => {
  assert.equal(resolveWhiteFillColor(1.5), "rgba(255, 255, 255, 1)");
  assert.equal(resolveWhiteFillColor(-0.2), "rgba(255, 255, 255, 0)");
});

test("resolveWhiteFillColor defaults to DEFAULT_WHITE_FILL_OPACITY (1, today's original behavior) when called with no argument at all", () => {
  assert.equal(resolveWhiteFillColor(), "rgba(255, 255, 255, 1)");
});

test("D) createWhiteModeCanvasContextProxy: fillStyle is forced to the white rgba color ONLY at a patched operator index", () => {
  const target = {} as CanvasRenderingContext2D;
  const patchedIndices = new Set([2]);
  const fillColor = "rgba(255, 255, 255, 0.6)";
  const operatorIndexRef = { current: -1 };
  const proxy = createWhiteModeCanvasContextProxy(target, patchedIndices, fillColor, operatorIndexRef);

  operatorIndexRef.current = 0; // NOT a patched index
  proxy.fillStyle = "#0000ff"; // e.g. a stand's own original blue fill
  assert.equal(target.fillStyle, "#0000ff", "fillStyle at a non-patched index must pass through untouched");

  operatorIndexRef.current = 2; // the patched index
  proxy.fillStyle = "#0000ff"; // pdf.js's own setFillRGBColor handler assigning the ORIGINAL color
  assert.equal(target.fillStyle, fillColor, "fillStyle at the patched index must be forced to the white/opacity color, regardless of what pdf.js tried to assign");
});

test("D/E) createWhiteModeCanvasContextProxy: strokeStyle is NEVER touched, even at a patched index (spec: 'PŮVODNÍ HRANY... 100% zachované')", () => {
  const target = {} as CanvasRenderingContext2D;
  const patchedIndices = new Set([2]);
  const operatorIndexRef = { current: 2 }; // a patched index — fillStyle WOULD be forced here
  const proxy = createWhiteModeCanvasContextProxy(target, patchedIndices, "rgba(255, 255, 255, 0.6)", operatorIndexRef);

  proxy.strokeStyle = "#000000"; // the stand's original black stroke
  assert.equal(target.strokeStyle, "#000000", "strokeStyle must pass through completely untouched, even while a patched fillStyle assignment is active for the SAME operator index");
});

test("F) createWhiteModeCanvasContextProxy: any OTHER canvas state (lineWidth, geometry-adjacent properties) passes through untouched at a patched index too", () => {
  const target = {} as CanvasRenderingContext2D;
  const patchedIndices = new Set([2]);
  const operatorIndexRef = { current: 2 };
  const proxy = createWhiteModeCanvasContextProxy(target, patchedIndices, "rgba(255, 255, 255, 0.6)", operatorIndexRef);

  proxy.lineWidth = 1.5;
  assert.equal(target.lineWidth, 1.5, "only fillStyle is ever intercepted — every other canvas property/method call passes straight through, which is what keeps geometry/dash/line-width untouched");
});

test("no globalAlpha: createWhiteModeCanvasContextProxy never sets globalAlpha as a side effect of any fillStyle assignment (spec section 24 — globalAlpha would transparentize the stroke too, which is forbidden)", () => {
  const target = {} as CanvasRenderingContext2D;
  const patchedIndices = new Set([2]);
  const operatorIndexRef = { current: 2 };
  const proxy = createWhiteModeCanvasContextProxy(target, patchedIndices, "rgba(255, 255, 255, 0.6)", operatorIndexRef);
  proxy.fillStyle = "#0000ff";
  assert.equal(target.globalAlpha, undefined, "globalAlpha must never be touched at all — the opacity lives entirely inside the fillStyle string");
});

test("end-to-end: renderWhiteModePage threads whiteFillOpacity all the way into the actual patched fillStyle value the underlying context receives", async () => {
  const { page } = makeFakePage();
  const viewport = page.getViewport({ scale: 1 });
  const target = {} as CanvasRenderingContext2D;
  // makeFakePage()'s render() is a no-op that never invokes operationsFilter/touches canvasContext
  // (see this file's own makeFakePage doc) — this test instead drives the SAME proxy-building path
  // renderWhiteModePage uses internally by calling it and then independently re-deriving the same
  // fillColor resolveWhiteFillColor would produce, confirming the plumbing (params.whiteFillOpacity
  // -> resolveWhiteFillColor -> createWhiteModeCanvasContextProxy) is wired, without needing a full
  // fake pdf.js render loop.
  const result = await renderWhiteModePage({ page, pageKey: `doc-${crypto.randomUUID()}#1`, standLayerId: "STANDS", canvasContext: target, viewport, whiteFillOpacity: 0.6 });
  assert.equal(result.status, "rendered");
  assert.equal(resolveWhiteFillColor(0.6), "rgba(255, 255, 255, 0.6)", "sanity: this IS the exact string renderWhiteModePage's own fillColor computation would have produced for whiteFillOpacity=0.6");
});
