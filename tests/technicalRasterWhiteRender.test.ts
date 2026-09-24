import assert from "node:assert/strict";
import test from "node:test";
import {
  createWhiteModeCanvasContextProxy,
  renderWhiteModePage,
  resolveWhiteFillColor,
  resolveWhiteModeAvailability,
} from "../lib/pdf/technicalRasterWhiteRender.ts";
import { scaleFontSizeInCssFontString } from "../lib/pdf/pdfWhiteModeCanvasProxy.ts";
import type { PdfJsDocument, PdfJsOperatorList, PdfJsPage, PdfJsViewport } from "../lib/pdf/pdfDocumentLoader.ts";

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

/** Mirrors H3's own REAL operator shape: a source `gs` (setGState, op code 74 — pdf.js's real numeric value for this pinned version) reached inside the target OCG scope, BEFORE the fill-color-setter — real evidence a page-level `/ca 0.76` ExtGState is set right before invoking a stand's own transparency-group Form XObject. */
function makeFakePageWithSourceGs(): Readonly<{ page: PdfJsPage }> {
  const page = {
    getViewport: (): PdfJsViewport => ({ width: 100, height: 100, transform: [1, 0, 0, -1, 0, 100] }),
    getTextContent: async () => ({ items: [] }),
    getOperatorList: async (): Promise<PdfJsOperatorList> => ({
      // beginMarkedContentProps("STANDS"), setGState(ca=0.76), setFillRGBColor, constructPath(fillStroke), endMarkedContent
      // (9 is pdf.js's own REAL numeric OPS.setGState value for this pinned version — verified
      // directly, since getWhiteModeOpCodes() reads the real "pdfjs-dist" module's own OPS object)
      fnArray: [70, 9, 59, 91, 71],
      argsArray: [["OC", "STANDS"], [[["ca", 0.76]]], ["#ffeb3b"], [24, "geometry"], null],
    }),
    render: () => ({ promise: Promise.resolve() }),
  };
  return { page: page as unknown as PdfJsPage };
}

/** A minimal fake `PdfJsDocument` whose `setWhiteModeCanvasSession` records every call — used to prove renderWhiteModePage's own session install/clear wiring (corrective batch, editor-only white mode) without needing a real pdf.js canvas factory at all. */
function makeSpyDocument(): Readonly<{ document: PdfJsDocument; sessions: unknown[] }> {
  const sessions: unknown[] = [];
  const document = {
    numPages: 1,
    getPage: async () => { throw new Error("not used by this fake"); },
    getOptionalContentConfig: async () => { throw new Error("not used by this fake"); },
    setWhiteModeCanvasSession: (session: unknown) => { sessions.push(session); },
    destroy: async () => {},
  } as unknown as PdfJsDocument;
  return { document, sessions };
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

// =========================================================================================
// PRODUCTION BATCH (per-source-OCG-layer text-size reduction, part A) — createWhiteModeCanvasContextProxy's
// THIRD, independent interception: `font` assignments at a configured `fontScaleByIndex` entry.
// =========================================================================================

test("scaleFontSizeInCssFontString: rewrites only the leading '<number>px' size, multiplied by scale — the rest of the font shorthand is untouched", () => {
  assert.equal(scaleFontSizeInCssFontString("12px sans-serif", 0.5), "6px sans-serif");
  assert.equal(scaleFontSizeInCssFontString("italic 700 16px Arial, sans-serif", 0.75), "italic 700 12px Arial, sans-serif");
});

test("scaleFontSizeInCssFontString: a string with no 'px' size at all is returned unchanged, never crashes", () => {
  assert.equal(scaleFontSizeInCssFontString("sans-serif", 0.5), "sans-serif");
});

test("createWhiteModeCanvasContextProxy: 'font' is scaled ONLY at an operator index present in fontScaleByIndex", () => {
  const target = {} as CanvasRenderingContext2D;
  const operatorIndexRef = { current: -1 };
  const proxy = createWhiteModeCanvasContextProxy(target, new Set(), "", operatorIndexRef, new Set(), new Map([[3, 0.8]]));

  operatorIndexRef.current = 0; // NOT a font-scale index
  proxy.font = "10px NotoSans";
  assert.equal(target.font, "10px NotoSans", "an unconfigured index passes the font string through completely untouched");

  operatorIndexRef.current = 3; // the configured index
  proxy.font = "10px NotoSans";
  assert.equal(target.font, "8px NotoSans", "10 * 0.8 = 8 — the SAME multiplier pdf.js's own setFont(Tf) handler assigns synchronously, forced here at the exact operator index");
});

test("createWhiteModeCanvasContextProxy: font scaling and fillStyle whitening are fully independent — both can be active on the SAME render for DIFFERENT operator indices", () => {
  const target = {} as CanvasRenderingContext2D;
  const operatorIndexRef = { current: -1 };
  const proxy = createWhiteModeCanvasContextProxy(target, new Set([1]), "rgba(255, 255, 255, 1)", operatorIndexRef, new Set(), new Map([[5, 0.5]]));

  operatorIndexRef.current = 1;
  proxy.fillStyle = "#ff0000";
  assert.equal(target.fillStyle, "rgba(255, 255, 255, 1)", "white-mode fill whitening still works exactly as before");

  operatorIndexRef.current = 5;
  proxy.font = "20px NotoSans";
  assert.equal(target.font, "10px NotoSans", "text scaling works independently at its own index");
});

test("createWhiteModeCanvasContextProxy: omitting fontScaleByIndex entirely (every pre-existing call site) never touches 'font' at all", () => {
  const target = {} as CanvasRenderingContext2D;
  const operatorIndexRef = { current: 0 };
  const proxy = createWhiteModeCanvasContextProxy(target, new Set(), "", operatorIndexRef);
  proxy.font = "14px Arial";
  assert.equal(target.font, "14px Arial");
});

test("no globalAlpha SIDE EFFECT: merely setting a patched fillStyle never itself touches globalAlpha — it only arms a pending override, consumed by a LATER real globalAlpha assignment (see the dedicated CORRECTIVE BATCH tests below for that mechanism)", () => {
  const target = {} as CanvasRenderingContext2D;
  const patchedIndices = new Set([2]);
  const operatorIndexRef = { current: 2 };
  const proxy = createWhiteModeCanvasContextProxy(target, patchedIndices, "rgba(255, 255, 255, 0.6)", operatorIndexRef);
  proxy.fillStyle = "#0000ff";
  assert.equal(target.globalAlpha, undefined, "fillStyle alone never writes globalAlpha");
});

// ============================================================================
// CORRECTIVE BATCH (real production — H3 100% white / grid-through-fill) — real evidence: Hala 3's
// source PDF sets a genuine per-stand `/ca 0.76 /CA 0.76` ExtGState via a page-level `gs` call.
// Reading pdf.js's own source confirms `setGState`'s `ca` case does
// `ctx.globalAlpha = current.fillAlpha = value`, and `CanvasGraphics#fillStroke` (the handler for a
// combined fill+stroke paint) does, IN ORDER: `ctx.globalAlpha = fillAlpha; ctx.fill(...);
// ctx.globalAlpha = strokeAlpha; ctx.stroke(...)`. Canvas 2D MULTIPLIES a fill's own rgba() alpha
// by `globalAlpha` at paint time, so a source `ca` left untouched would silently transparentize a
// "fully opaque" forced-white fill — exactly the reported grid-through-fill symptom, now also
// reproduced structurally here with a synthetic fixture mirroring H3's real operator order.
// ============================================================================

test("CORRECTIVE BATCH: a globalAlpha assignment reached IMMEDIATELY after a patched fillStyle (the real pdf.js fillAlpha-before-fill() sequence) is forced to 1 — neutralizing a source 'ca' so the forced-white fill's own opacity is the ONLY thing determining the final result", () => {
  const target = { fillStyle: undefined, globalAlpha: undefined } as unknown as CanvasRenderingContext2D;
  const patchedIndices = new Set([2]);
  const operatorIndexRef = { current: 2 };
  const proxy = createWhiteModeCanvasContextProxy(target, patchedIndices, "rgba(255, 255, 255, 1)", operatorIndexRef);
  proxy.fillStyle = "#ffeb3b"; // the patched fill-color-setter's own turn — forces white, arms the pending override
  proxy.globalAlpha = 0.76; // pdf.js's own `ctx.globalAlpha = fillAlpha` — a real source 'ca' value, must be neutralized
  assert.equal(target.globalAlpha, 1, "the source's own ca=0.76 must be overridden to 1 — otherwise 1(our fill alpha)×0.76 = 0.76, not the requested 100%");
});

test("CORRECTIVE BATCH: the override fires EXACTLY ONCE — a SECOND globalAlpha assignment (pdf.js's own strokeAlpha, set right before ctx.stroke()) passes through completely untouched, preserving the source's own stroke opacity", () => {
  const target = { fillStyle: undefined, globalAlpha: undefined } as unknown as CanvasRenderingContext2D;
  const patchedIndices = new Set([2]);
  const operatorIndexRef = { current: 2 };
  const proxy = createWhiteModeCanvasContextProxy(target, patchedIndices, "rgba(255, 255, 255, 1)", operatorIndexRef);
  proxy.fillStyle = "#ffeb3b";
  proxy.globalAlpha = 0.76; // fillAlpha -> forced to 1
  assert.equal(target.globalAlpha, 1);
  proxy.globalAlpha = 0.76; // strokeAlpha (CA) -> the override was already consumed, must pass through unmodified
  assert.equal(target.globalAlpha, 0.76, "stroke alpha (CA) must never be touched — only the fill's own alpha (ca) is ever neutralized");
});

test("CORRECTIVE BATCH: a globalAlpha assignment that happens WITHOUT a preceding patched fillStyle (unrelated content) is never touched at all", () => {
  const target = { globalAlpha: undefined } as unknown as CanvasRenderingContext2D;
  const patchedIndices = new Set([2]);
  const operatorIndexRef = { current: 5 }; // NOT a patched index
  const proxy = createWhiteModeCanvasContextProxy(target, patchedIndices, "rgba(255, 255, 255, 1)", operatorIndexRef);
  proxy.globalAlpha = 0.76;
  assert.equal(target.globalAlpha, 0.76, "unrelated content's own alpha must never be overridden");
});

test("CORRECTIVE BATCH: an UN-patched fillStyle set cancels any stale pending override, defensively", () => {
  const target = { fillStyle: undefined, globalAlpha: undefined } as unknown as CanvasRenderingContext2D;
  const patchedIndices = new Set([2]);
  const operatorIndexRef = { current: 2 };
  const proxy = createWhiteModeCanvasContextProxy(target, patchedIndices, "rgba(255, 255, 255, 1)", operatorIndexRef);
  proxy.fillStyle = "#ffeb3b"; // patched -> arms override
  operatorIndexRef.current = 9; // move to an unrelated, unpatched index
  proxy.fillStyle = "#000000"; // a DIFFERENT, unpatched fill color -> cancels the stale armed override
  proxy.globalAlpha = 0.5;
  assert.equal(target.globalAlpha, 0.5, "the stale override must not leak forward onto unrelated later content");
});

// ============================================================================
// CORRECTIVE BATCH (real production — H3 100% white / grid-through-fill) — real evidence: H3's own
// page-level `/ca 0.76` ExtGState is set via a `gs` operator reached from inside the target OCG
// scope, BEFORE any Form/offscreen-canvas swap ever happens — the fillStyle-forcing backstop above
// never sees it (it fires on a completely different context, later). `neutralizeAlphaIndices`
// (domain/technicalRasterWhiteModeOperators.ts's `sourceGsIndicesInsideTarget`) is the fix: force
// `globalAlpha` to 1 at EXACTLY the operator indices where a source `gs` ran inside target scope,
// on WHATEVER canvas receives it — mirroring the export side's "reassert after any source gs
// inside target" policy exactly.
// ============================================================================

test("CORRECTIVE BATCH (H3 100% grid-through-fill): a globalAlpha assignment at an index in neutralizeAlphaIndices is forced to 1 — this is what actually neutralizes a real source 'ca' reached BEFORE any fillStyle has even been patched yet", () => {
  const target = { globalAlpha: undefined } as unknown as CanvasRenderingContext2D;
  const patchedIndices = new Set([10]); // the fill-color-setter's own index — far LATER than the gs
  const neutralizeAlphaIndices = new Set([3]); // the source gs operator's own index
  const operatorIndexRef = { current: 3 };
  const proxy = createWhiteModeCanvasContextProxy(target, patchedIndices, "rgba(255, 255, 255, 1)", operatorIndexRef, neutralizeAlphaIndices);
  proxy.globalAlpha = 0.76; // pdf.js's own setGState 'ca' handler, reached before ANY fillStyle patch
  assert.equal(target.globalAlpha, 1, "a source ca reached inside target scope must be neutralized even with no pending fillStyle override at all");
});

test("CORRECTIVE BATCH (H3 100% grid-through-fill): a globalAlpha assignment at an index NOT in neutralizeAlphaIndices, with no pending fillStyle override either, passes through completely untouched", () => {
  const target = { globalAlpha: undefined } as unknown as CanvasRenderingContext2D;
  const patchedIndices = new Set([10]);
  const neutralizeAlphaIndices = new Set([3]);
  const operatorIndexRef = { current: 7 }; // neither a neutralize index nor a patched index
  const proxy = createWhiteModeCanvasContextProxy(target, patchedIndices, "rgba(255, 255, 255, 1)", operatorIndexRef, neutralizeAlphaIndices);
  proxy.globalAlpha = 0.5;
  assert.equal(target.globalAlpha, 0.5, "unrelated content's own alpha must never be overridden");
});

test("CORRECTIVE BATCH (H3 100% grid-through-fill): omitting neutralizeAlphaIndices entirely (every pre-existing call site/test above this batch) never throws — it's purely additive, defaulting to an empty set", () => {
  const target = { fillStyle: undefined, globalAlpha: undefined } as unknown as CanvasRenderingContext2D;
  const patchedIndices = new Set([2]);
  const operatorIndexRef = { current: 2 };
  const proxy = createWhiteModeCanvasContextProxy(target, patchedIndices, "rgba(255, 255, 255, 0.6)", operatorIndexRef);
  proxy.fillStyle = "#0000ff";
  proxy.globalAlpha = 0.76;
  assert.equal(target.globalAlpha, 1, "the pre-existing fillStyle-driven backstop mechanism alone still works when neutralizeAlphaIndices is omitted");
});

test("CORRECTIVE BATCH (H3 100% grid-through-fill): both mechanisms coexist safely — a neutralize-index gs (before any fill) AND a later patched-fillStyle-driven fill both end up at globalAlpha=1, matching the real H3 operator sequence end-to-end", () => {
  const target = { fillStyle: undefined, globalAlpha: undefined } as unknown as CanvasRenderingContext2D;
  const patchedIndices = new Set([10]);
  const neutralizeAlphaIndices = new Set([3]);
  const operatorIndexRef = { current: 3 };
  const proxy = createWhiteModeCanvasContextProxy(target, patchedIndices, "rgba(255, 255, 255, 1)", operatorIndexRef, neutralizeAlphaIndices);

  proxy.globalAlpha = 0.76; // the page-level source gs, BEFORE the Form/offscreen swap
  assert.equal(target.globalAlpha, 1, "neutralized via neutralizeAlphaIndices");

  operatorIndexRef.current = 10; // later: the fill-color-setter's own turn
  proxy.fillStyle = "#ffeb3b"; // patched -> arms the backstop
  assert.equal(target.fillStyle, "rgba(255, 255, 255, 1)");
  proxy.globalAlpha = 0.76; // e.g. a stale internal fillAlpha re-application right before ctx.fill()
  assert.equal(target.globalAlpha, 1, "neutralized via the fillStyle-driven backstop");
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

// ============================================================================
// CORRECTIVE BATCH (editor-only white mode) — real manual acceptance found Hala 3 (every stand
// fill drawn inside a Form XObject) stays fully colored in the editor. Root cause, confirmed
// empirically (scripts/technicalRasterEditorWhiteModeRealDiagnostic.ts): a Form XObject's own
// `/Group /S /Transparency` makes pdf.js paint onto a brand-new OFFSCREEN canvas the top-level-only
// Proxy never reached. The fix threads an "active session" through the OWNING PdfJsDocument's own
// canvas factory (WhiteModeAwareCanvasFactory, tests/pdfDocumentLoader.test.ts) for the duration of
// ONE page.render() call — these tests prove renderWhiteModePage installs/clears that session
// correctly, using a fake PdfJsDocument (no real pdf.js canvas factory needed to prove the wiring).
// ============================================================================

test("renderWhiteModePage: installs the active white-mode session on the OWNING document BEFORE render(), and clears it back to undefined immediately after — so an offscreen canvas created DURING this render() can also be wrapped, and a LATER render never inherits a stale session", async () => {
  const { page } = makeFakePage();
  const viewport = page.getViewport({ scale: 1 });
  const { document, sessions } = makeSpyDocument();
  const result = await renderWhiteModePage({ page, pageKey: `doc-${crypto.randomUUID()}#1`, standLayerId: "STANDS", canvasContext: fakeCanvasContext(), viewport, document });
  assert.equal(result.status, "rendered");
  assert.equal(sessions.length, 2, "exactly one 'install' call before render(), one 'clear' call after");
  const installed = sessions[0] as Readonly<{ patchedIndices: ReadonlySet<number>; fillColor: string; operatorIndexRef: Readonly<{ current: number }>; neutralizeAlphaIndices: ReadonlySet<number> }>;
  // makeFakePage()'s own fixed operator list: beginMarkedContentProps("STANDS")=0, setFillRGBColor=1,
  // constructPath(fillStroke)=2, endMarkedContent=3 — index 1 (the fill-color setter) is the one
  // computeWhiteModeArgsArray patches.
  assert.deepEqual([...installed.patchedIndices], [1]);
  assert.equal(installed.fillColor, resolveWhiteFillColor());
  assert.deepEqual([...installed.neutralizeAlphaIndices], [], "no 'gs' operator anywhere in this fixture's own operator list — never a guess/fabricated index");
  assert.equal(sessions[1], undefined, "cleared back to undefined immediately after render() completes");
});

test("CORRECTIVE BATCH (H3 100% grid-through-fill): renderWhiteModePage installs neutralizeAlphaIndices from a source 'gs' reached inside target scope — the real H3 shape", async () => {
  const { page } = makeFakePageWithSourceGs();
  const viewport = page.getViewport({ scale: 1 });
  const { document, sessions } = makeSpyDocument();
  const result = await renderWhiteModePage({ page, pageKey: `doc-${crypto.randomUUID()}#1`, standLayerId: "STANDS", canvasContext: fakeCanvasContext(), viewport, document });
  assert.equal(result.status, "rendered");
  const installed = sessions[0] as Readonly<{ patchedIndices: ReadonlySet<number>; neutralizeAlphaIndices: ReadonlySet<number> }>;
  // fnArray: beginMarkedContentProps("STANDS")=0, setGState(ca=0.76)=1, setFillRGBColor=2, constructPath=3, endMarkedContent=4.
  assert.deepEqual([...installed.patchedIndices], [2], "the fill-color-setter is still the one whitened");
  assert.deepEqual([...installed.neutralizeAlphaIndices], [1], "the source gs's own index is recorded for globalAlpha neutralization");
});

test("renderWhiteModePage: the session is cleared even if page.render() itself throws — never leaves a stale active session behind for a later, unrelated render on the same document", async () => {
  const { page } = makeFakePage();
  const viewport = page.getViewport({ scale: 1 });
  const { document, sessions } = makeSpyDocument();
  const throwingPage = { ...page, render: () => ({ promise: Promise.reject(new Error("simulated render failure")) }) } as unknown as PdfJsPage;
  await assert.rejects(
    () => renderWhiteModePage({ page: throwingPage, pageKey: `doc-${crypto.randomUUID()}#1`, standLayerId: "STANDS", canvasContext: fakeCanvasContext(), viewport, document }),
    /simulated render failure/u,
  );
  assert.equal(sessions.length, 2);
  assert.equal(sessions[1], undefined, "cleared even though render() rejected");
});

test("renderWhiteModePage: omitting `document` entirely (every pre-existing call site/test above this batch) never throws — installing the session is purely additive, never required", async () => {
  const { page } = makeFakePage();
  const viewport = page.getViewport({ scale: 1 });
  const result = await renderWhiteModePage({ page, pageKey: `doc-${crypto.randomUUID()}#1`, standLayerId: "STANDS", canvasContext: fakeCanvasContext(), viewport });
  assert.equal(result.status, "rendered");
});

// =========================================================================================
// PRODUCTION BATCH (per-source-OCG-layer text-size reduction, part A) — renderWhiteModePage now
// ALSO drives text scaling, independent of white mode (spec section 6: "editor and export must
// match"). `standLayerId` is optional; `textScaleLayers` composes with it on the SAME session.
// =========================================================================================

/** beginMarkedContentProps("STANDS")=0, setFillRGBColor=1, constructPath(fillStroke)=2, endMarkedContent=3, beginMarkedContentProps("NAMES")=4, setFont("F1",12)=5, endMarkedContent=6. Op code 37 is pdf.js's own REAL numeric OPS.setFont value for this pinned version (verified directly, same discipline as makeFakePageWithSourceGs's own OPS.setGState=9 comment — getTextScaleOpCodes() reads the real "pdfjs-dist" module's own OPS object). */
function makeFakePageWithTextLayer(): Readonly<{ page: PdfJsPage }> {
  const page = {
    getViewport: (): PdfJsViewport => ({ width: 100, height: 100, transform: [1, 0, 0, -1, 0, 100] }),
    getTextContent: async () => ({ items: [] }),
    getOperatorList: async (): Promise<PdfJsOperatorList> => ({
      fnArray: [70, 59, 91, 71, 70, 37, 71],
      argsArray: [["OC", "STANDS"], ["#009edd"], [24, "geometry"], null, ["OC", "NAMES"], ["F1", 12], null],
    }),
    render: () => ({ promise: Promise.resolve() }),
  };
  return { page: page as unknown as PdfJsPage };
}

test("renderWhiteModePage: standLayerId omitted, textScaleLayers only — installs a session with an empty white-mode patch set and a real fontScaleByIndex", async () => {
  const { page } = makeFakePageWithTextLayer();
  const viewport = page.getViewport({ scale: 1 });
  const { document, sessions } = makeSpyDocument();
  const result = await renderWhiteModePage({
    page,
    pageKey: `doc-${crypto.randomUUID()}#1`,
    canvasContext: fakeCanvasContext(),
    viewport,
    document,
    textScaleLayers: [{ layerId: "NAMES", scale: 0.8 }],
  });
  assert.equal(result.status, "rendered");
  const installed = sessions[0] as Readonly<{ patchedIndices: ReadonlySet<number>; fontScaleByIndex: ReadonlyMap<number, number> }>;
  assert.deepEqual([...installed.patchedIndices], [], "no white mode requested at all");
  assert.deepEqual([...installed.fontScaleByIndex.entries()], [[5, 0.8]], "the setFont op's own index (5) maps to the configured 0.8 scale");
});

test("renderWhiteModePage: white mode AND text scaling active together, on two DIFFERENT OCGs of the SAME page, compose into one session", async () => {
  const { page } = makeFakePageWithTextLayer();
  const viewport = page.getViewport({ scale: 1 });
  const { document, sessions } = makeSpyDocument();
  const result = await renderWhiteModePage({
    page,
    pageKey: `doc-${crypto.randomUUID()}#1`,
    standLayerId: "STANDS",
    canvasContext: fakeCanvasContext(),
    viewport,
    document,
    textScaleLayers: [{ layerId: "NAMES", scale: 0.5 }],
  });
  assert.equal(result.status, "rendered");
  const installed = sessions[0] as Readonly<{ patchedIndices: ReadonlySet<number>; fontScaleByIndex: ReadonlyMap<number, number> }>;
  assert.deepEqual([...installed.patchedIndices], [1], "white mode's own fill-color-setter index, unaffected by text scaling");
  assert.deepEqual([...installed.fontScaleByIndex.entries()], [[5, 0.5]]);
});

test("renderWhiteModePage: a text-scale layer that can't be found on this page reports via onTextScaleUnsupported, but the render still completes (never blocks, unlike white mode's own unsupported case)", async () => {
  const { page } = makeFakePageWithTextLayer();
  const viewport = page.getViewport({ scale: 1 });
  const unsupported: [string, string][] = [];
  const result = await renderWhiteModePage({
    page,
    pageKey: `doc-${crypto.randomUUID()}#1`,
    canvasContext: fakeCanvasContext(),
    viewport,
    textScaleLayers: [{ layerId: "DOES_NOT_EXIST", scale: 0.7 }],
    onTextScaleUnsupported: (layerId, reason) => unsupported.push([layerId, reason]),
  });
  assert.equal(result.status, "rendered");
  assert.equal(unsupported.length, 1);
  assert.equal(unsupported[0]![0], "DOES_NOT_EXIST");
});

test("renderWhiteModePage: textScaleLayers omitted entirely is a plain, unaffected render (every pre-existing white-mode-only call site/test) — empty fontScaleByIndex installed", async () => {
  const { page } = makeFakePage();
  const viewport = page.getViewport({ scale: 1 });
  const { document, sessions } = makeSpyDocument();
  const result = await renderWhiteModePage({ page, pageKey: `doc-${crypto.randomUUID()}#1`, standLayerId: "STANDS", canvasContext: fakeCanvasContext(), viewport, document });
  assert.equal(result.status, "rendered");
  const installed = sessions[0] as Readonly<{ fontScaleByIndex: ReadonlyMap<number, number> }>;
  assert.deepEqual([...installed.fontScaleByIndex.entries()], []);
});
