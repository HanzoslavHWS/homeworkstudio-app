import assert from "node:assert/strict";
import test from "node:test";
import { renderWhiteModePage, resolveWhiteModeAvailability } from "../lib/pdf/technicalRasterWhiteRender.ts";
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
