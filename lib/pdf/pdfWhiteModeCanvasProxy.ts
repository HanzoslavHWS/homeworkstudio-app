"use client";

/**
 * Technické rastry — the fillStyle-forcing `CanvasRenderingContext2D` Proxy behind "pracovní bílé"
 * in the editor (spec batch 2/6). Split out of lib/pdf/technicalRasterWhiteRender.ts (which still
 * re-exports it, so nothing else needs to change import paths) into its own zero-pdfjs-dist-import
 * module specifically so lib/pdf/pdfDocumentLoader.ts can also use it — see that module's own
 * WhiteModeAwareCanvasFactory doc for why: a real Form XObject whose `/Group /S /Transparency`
 * triggers pdf.js's internal transparency-group compositing paints onto a BRAND NEW OFFSCREEN
 * canvas context (created via pdf.js's own `canvasFactory.create()`, never the top-level
 * `canvasContext` this app hands to `page.render()`) — wrapping only the top-level context (the
 * ONLY thing this module did before that corrective batch) never sees those fills at all, which is
 * the real, empirically-confirmed root cause of "Hala 3's stands stay colored in the editor" (see
 * scripts/technicalRasterEditorWhiteModeRealDiagnostic.ts for the real-file proof). Keeping this
 * Proxy-building logic in its OWN module (rather than moving it into pdfDocumentLoader.ts outright)
 * avoids a circular import: pdfDocumentLoader.ts needs this proxy builder, and
 * technicalRasterWhiteRender.ts needs pdfDocumentLoader.ts's own PdfJs* types.
 *
 * CORRECTIVE BATCH (real production — H3 100% white / grid-through-fill) — real evidence: Hala 3's
 * source PDF sets a genuine per-stand `/ca 0.76 /CA 0.76` ExtGState (via a page-level `gs` call,
 * completely independent of this app's own "Krytí bílé" slider). Reading pdf.js's own source (this
 * pinned version) confirms `setGState`'s `case "ca"` does `this.ctx.globalAlpha = this.current.fillAlpha
 * = value` — a REAL `globalAlpha` assignment this Proxy's `set` trap sees — and `CanvasGraphics#fillStroke`
 * (the handler for a combined fill+stroke paint, e.g. `closeEOFillStroke`) does, in order:
 * `ctx.globalAlpha = fillAlpha; ctx.fill(...); ctx.globalAlpha = strokeAlpha; ctx.stroke(...)`.
 * Canvas 2D MULTIPLIES a fill's own rgba() alpha by `globalAlpha` at paint time — so forcing
 * `fillStyle` to `rgba(255,255,255,1)` (100% requested) while `globalAlpha` is still the source's
 * own 0.76 renders at 1×0.76=0.76, letting the hall's own background grid show through even a
 * "fully opaque" white fill. Never previously touched because the ONLY property this Proxy forced
 * was `fillStyle` itself.
 *
 * FIRST fix (kept as a defensive backstop, insufficient alone): `pendingFillAlphaOverride`
 * remembers that the LAST `fillStyle` set was one of ours (a patched index) and forces exactly the
 * NEXT `globalAlpha` assignment to `1` — matching pdf.js's own fill-then-stroke ordering, this is
 * always the `fillAlpha` assignment (the one immediately preceding `ctx.fill()`), never the LATER
 * `strokeAlpha` one, so the stand's OWN border keeps whatever opacity the source PDF originally
 * gave it. This alone did NOT fully fix H3, because for a GROUPED Form (H3's real shape), pdf.js's
 * own `beginGroup` ALREADY resets the OFFSCREEN canvas's own alpha to 1 internally BEFORE the
 * Form's content ever runs — so this backstop was never even needed there. The REAL remaining leak
 * (confirmed empirically — see scripts/technicalRasterEditorWhiteModeRealDiagnostic.ts) is
 * upstream: the PARENT canvas's own `globalAlpha`, set by the source's page-level `ca` BEFORE
 * `Do`/`beginGroup` ever runs, is NEVER reset — and `endGroup`'s own final `ctx.drawImage(groupCtx.canvas,
 * ...)` (compositing the now-correctly-opaque offscreen group back onto the parent) runs using
 * WHATEVER `globalAlpha` the PARENT happens to have at that exact moment, which is still the
 * source's own un-neutralized 0.76 — diluting an internally-fully-opaque white fill right back
 * down to 76% the instant it's composited onto the visible page.
 *
 * SECOND, actually-sufficient fix: `neutralizeAlphaIndices` (computed by
 * domain/technicalRasterWhiteModeOperators.ts's `computeWhiteModeArgsArray`, when its own
 * `WhiteModeOpCodes.setGState` is supplied — see that type's own doc) is the set of every operator
 * index where a source `gs` operator ran WHILE inside the target OCG scope. Forcing
 * `ctx.globalAlpha` to `1` at EXACTLY these indices — on WHATEVER canvas the `gs` happens to be
 * setting alpha on, top-level or offscreen — neutralizes the source's own `ca` at the moment it
 * would otherwise take effect, mirroring the EXPORT side's own "reassert opacity after any source
 * gs inside target" policy exactly, just implemented as a canvas-property override instead of a
 * PDF-byte rewrite. This is safe for stroke alpha too: `case "CA"` (pdf.js's own setGState handler)
 * never writes `ctx.globalAlpha` directly — only `case "ca"` does — so this mechanism can only ever
 * neutralize a genuine non-stroking (`ca`) source alpha, never a stroking (`CA`) one.
 *
 * PRODUCTION BATCH (per-source-OCG-layer text-size reduction, part A) — `fontScaleByIndex` adds a
 * THIRD, fully independent interception: pdf.js's own `CanvasGraphics#setFont` handler (the `Tf`
 * operator) assigns `ctx.font = "<size>px <family>"` directly, the SAME "operator handler configures
 * canvas 2D state synchronously" pattern `fillStyle` already relies on above — reading that pinned
 * pdfjs-dist version's own source confirms this. Whenever the CURRENTLY EXECUTING operator index
 * (the SAME `operatorIndexRef` white mode already tracks) is a key in `fontScaleByIndex`, the
 * assigned font string's own leading `<number>px` size is parsed and multiplied by that index's own
 * scale, then the modified string is what's actually written — every other `font` assignment (any
 * OTHER Tf call, anywhere else on the page) passes through completely untouched. Independent of the
 * fillStyle/globalAlpha mechanisms above: a single render can have white mode active for one OCG and
 * text scaling active for a completely different one at the same time, on the SAME canvas.
 */
const FONT_SIZE_PATTERN = /(-?\d+(?:\.\d+)?)px/u;

/** Rewrites a CSS `font` shorthand string's own leading `<number>px` size, multiplied by `scale` — every other part of the string (style/weight/family) is left byte-for-byte untouched. Returns the ORIGINAL string unchanged if no `px` size token is found at all (defensive; pdf.js always emits one for this app's own real fonts). */
export function scaleFontSizeInCssFontString(font: string, scale: number): string {
  return font.replace(FONT_SIZE_PATTERN, (_match, sizeText: string) => `${Number(sizeText) * scale}px`);
}

export function createWhiteModeCanvasContextProxy(
  canvasContext: CanvasRenderingContext2D,
  patchedIndices: ReadonlySet<number>,
  fillColor: string,
  operatorIndexRef: Readonly<{ current: number }>,
  neutralizeAlphaIndices: ReadonlySet<number> = new Set(),
  fontScaleByIndex: ReadonlyMap<number, number> = new Map(),
): CanvasRenderingContext2D {
  let pendingFillAlphaOverride = false;
  return new Proxy(canvasContext, {
    // Both traps force `target` as the receiver (never the default, which would be the proxy
    // itself) — the real CanvasRenderingContext2D's accessors are native-backed and throw if
    // invoked with `this` bound to anything other than the real context (verified against
    // node-canvas; the same defensive binding is kept for the browser for the same reason).
    get(target, property) {
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) {
      if (property === "fillStyle") {
        if (patchedIndices.has(operatorIndexRef.current)) {
          pendingFillAlphaOverride = true;
          return Reflect.set(target, property, fillColor, target);
        }
        // Any OTHER (non-patched) fillStyle set cancels a stale pending override — defensive only;
        // pdf.js always paints immediately after setting a color, so this should never matter in
        // practice, but it keeps the flag from ever surviving past the fill it was meant for.
        pendingFillAlphaOverride = false;
        return Reflect.set(target, property, value, target);
      }
      if (property === "globalAlpha") {
        // PRIMARY mechanism: a source `gs` reached inside target scope, on ANY canvas — see this
        // function's own doc for why this is what actually fixes H3's real 100%-opacity leak.
        if (neutralizeAlphaIndices.has(operatorIndexRef.current)) {
          return Reflect.set(target, property, 1, target);
        }
        // Defensive backstop: forces exactly ONE globalAlpha assignment (the fillAlpha one) to 1
        // right after a patched fillStyle — never the LATER strokeAlpha one. strokeStyle and every
        // other property are never touched, ever, by either mechanism.
        if (pendingFillAlphaOverride) {
          pendingFillAlphaOverride = false;
          return Reflect.set(target, property, 1, target);
        }
      }
      if (property === "font" && typeof value === "string") {
        const scale = fontScaleByIndex.get(operatorIndexRef.current);
        if (scale !== undefined) {
          return Reflect.set(target, property, scaleFontSizeInCssFontString(value, scale), target);
        }
      }
      return Reflect.set(target, property, value, target);
    },
  });
}
