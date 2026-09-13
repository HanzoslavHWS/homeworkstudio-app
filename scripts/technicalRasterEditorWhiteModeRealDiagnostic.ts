/**
 * Technické rastry — CORRECTIVE BATCH (editor-only white mode). Real manual acceptance disproved
 * the previous assumption that the editor's white-mode render path (lib/pdf/technicalRasterWhiteRender.ts)
 * needed zero changes for Form-XObject-based rasters: Hala 3's stands stay colored in the editor
 * even though the same project exports a correctly white VECTOR PDF. This script runs the REAL
 * production render mechanism (page.render() + operationsFilter + a fillStyle-forcing Proxy —
 * exactly what renderWhiteModePage does) against the REAL Hala 1 / Hala 3 fixtures, using a
 * minimal in-process Canvas2D/Path2D/DOMMatrix stand-in (Node has no browser <canvas> — this app
 * has no native "canvas" package dependency and none is added here), to get EMPIRICAL proof of:
 *
 *   - how many operator indices computeWhiteModeArgsArray decides to patch
 *   - how many times pdf.js's OWN setFillRGBColor handler actually assigns `ctx.fillStyle` at
 *     one of those patched indices
 *   - which CONCRETE context object (by identity) receives that assignment — the top-level
 *     context our Proxy wraps, or a DIFFERENT (offscreen/transparency-group) context pdf.js
 *     created internally, which would prove the mutation is applied but never composited back.
 *
 * The stub context does not attempt pixel-perfect rendering (fill/stroke/clip/drawImage are
 * no-ops) — it only needs to (a) never throw so the real evaluator/CanvasGraphics code can run to
 * completion, and (b) correctly track enough real state (the affine transform stack via
 * save/restore, via getTransform()/transform()/setTransform()) for pdf.js's own internal
 * transparency-group decision logic (beginGroup's "can we skip the offscreen canvas" fast path,
 * see node_modules/pdfjs-dist's own CanvasGraphics#beginGroup) to run its REAL branching logic
 * rather than a fabricated one.
 *
 * Skip-safe: never depends on the real fixtures being present, never required by `npm test`.
 * Usage: node --no-warnings --experimental-strip-types scripts/technicalRasterEditorWhiteModeRealDiagnostic.ts
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeWhiteModeArgsArray, detectStandLayerId, type WhiteModeOpCodes } from "../domain/technicalRasterWhiteModeOperators.ts";
import { createWhiteModeCanvasContextProxy } from "../lib/pdf/technicalRasterWhiteRender.ts";

const repoRoot = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const importDir = path.join(repoRoot, "_IMPORT");

// ============================================================================
// Minimal Canvas2D / Path2D / DOMMatrix stand-in — just enough surface for pdf.js's real
// CanvasGraphics to execute a real page without throwing. State (transform/fillStyle/etc.) is
// tracked for real via a save/restore stack; every drawing/path method is an intentional no-op
// (we never inspect pixels — only "was fillStyle assigned, on which context object, at which
// operator index").
// ============================================================================

type Affine6 = readonly [number, number, number, number, number, number];

function multiplyAffine(m1: Affine6, m2: Affine6): Affine6 {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [a1 * a2 + c1 * b2, b1 * a2 + d1 * b2, a1 * c2 + c1 * d2, b1 * c2 + d1 * d2, a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1];
}

function makeDomMatrixLike(m: Affine6) {
  const self = { a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] } as Readonly<{ a: number; b: number; c: number; d: number; e: number; f: number }> & { invertSelf: () => typeof self };
  (self as { invertSelf: () => typeof self }).invertSelf = () => {
    const det = self.a * self.d - self.b * self.c;
    const mutable = self as { a: number; b: number; c: number; d: number; e: number; f: number };
    if (det === 0) { mutable.a = 1; mutable.b = 0; mutable.c = 0; mutable.d = 1; mutable.e = 0; mutable.f = 0; return self; }
    const ia = self.d / det, ib = -self.b / det, ic = -self.c / det, id = self.a / det;
    const ie = -(ia * self.e + ic * self.f), iff = -(ib * self.e + id * self.f);
    mutable.a = ia; mutable.b = ib; mutable.c = ic; mutable.d = id; mutable.e = ie; mutable.f = iff;
    return self;
  };
  return self;
}

let nextContextId = 0;
type FillStyleEvent = Readonly<{ contextId: number; value: unknown; operatorIndex: number }>;

function createFakeContext(canvas: Readonly<{ width: number; height: number }>, operatorIndexRef: Readonly<{ current: number }>, onFillStyleSet: (event: FillStyleEvent) => void): CanvasRenderingContext2D {
  const contextId = nextContextId++;
  type State = { matrix: Affine6; fillStyle: unknown; strokeStyle: unknown; globalAlpha: number; globalCompositeOperation: string; lineWidth: number; lineCap: string; lineJoin: string; miterLimit: number; font: string };
  const state: State = { matrix: [1, 0, 0, 1, 0, 0], fillStyle: "#000000", strokeStyle: "#000000", globalAlpha: 1, globalCompositeOperation: "source-over", lineWidth: 1, lineCap: "butt", lineJoin: "miter", miterLimit: 10, font: "10px sans-serif" };
  const stack: State[] = [];
  const methodCache = new Map<PropertyKey, (...args: unknown[]) => unknown>();

  const target: Record<string, unknown> = {
    canvas,
    save() { stack.push({ ...state }); },
    restore() { const s = stack.pop(); if (s) Object.assign(state, s); },
    getTransform() { return makeDomMatrixLike(state.matrix); },
    setTransform(...args: unknown[]) {
      const first = args[0];
      if (first && typeof first === "object") {
        const m = first as Readonly<{ a: number; b: number; c: number; d: number; e: number; f: number }>;
        state.matrix = [m.a, m.b, m.c, m.d, m.e, m.f];
      } else {
        state.matrix = args.slice(0, 6) as unknown as Affine6;
      }
    },
    transform(...args: unknown[]) { state.matrix = multiplyAffine(state.matrix, args as unknown as Affine6); },
    translate(x: number, y: number) { state.matrix = multiplyAffine(state.matrix, [1, 0, 0, 1, x, y]); },
    scale(x: number, y: number) { state.matrix = multiplyAffine(state.matrix, [x, 0, 0, y, 0, 0]); },
    rotate(angle: number) { const c = Math.cos(angle), s = Math.sin(angle); state.matrix = multiplyAffine(state.matrix, [c, s, -s, c, 0, 0]); },
    resetTransform() { state.matrix = [1, 0, 0, 1, 0, 0]; },
    createImageData(w: number, h: number) { return { width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4) }; },
    getImageData(_x: number, _y: number, w: number, h: number) { return { width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4) }; },
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
    createPattern() { return {}; },
    measureText(text: string) { return { width: (text?.length ?? 0) * 5 }; },
    getLineDash() { return []; },
    isPointInPath() { return false; },
    isContextLost() { return false; },
  };

  return new Proxy(target, {
    get(t, prop) {
      if (prop === "fillStyle" || prop === "strokeStyle" || prop === "globalAlpha" || prop === "globalCompositeOperation" || prop === "lineWidth" || prop === "lineCap" || prop === "lineJoin" || prop === "miterLimit" || prop === "font") {
        return state[prop as keyof State];
      }
      if (prop in t) {
        const value = t[prop as string];
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(t) : value;
      }
      if (!methodCache.has(prop)) methodCache.set(prop, () => undefined);
      return methodCache.get(prop);
    },
    set(t, prop, value) {
      if (prop === "fillStyle") { state.fillStyle = value; onFillStyleSet({ contextId, value, operatorIndex: operatorIndexRef.current }); return true; }
      if (prop === "strokeStyle" || prop === "globalAlpha" || prop === "globalCompositeOperation" || prop === "lineWidth" || prop === "lineCap" || prop === "lineJoin" || prop === "miterLimit" || prop === "font") {
        state[prop as keyof State] = value as never;
        return true;
      }
      t[prop as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

class FakePath2D {
  moveTo() {} lineTo() {} bezierCurveTo() {} quadraticCurveTo() {} arc() {} arcTo() {} ellipse() {} rect() {} closePath() {} addPath() {}
}

function installGlobalCanvasPolyfills(): void {
  (globalThis as unknown as { Path2D: unknown }).Path2D = FakePath2D;
  (globalThis as unknown as { DOMMatrix: unknown }).DOMMatrix = class {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
    constructor(init?: readonly number[]) { if (Array.isArray(init) && init.length === 6) [this.a, this.b, this.c, this.d, this.e, this.f] = init; }
    invertSelf() { return makeDomMatrixLike([this.a, this.b, this.c, this.d, this.e, this.f]); }
  };
  (globalThis as unknown as { ImageData: unknown }).ImageData = class {
    width: number; height: number; data: Uint8ClampedArray;
    constructor(dataOrWidth: Uint8ClampedArray | number, widthOrHeight: number, height?: number) {
      if (dataOrWidth instanceof Uint8ClampedArray) { this.data = dataOrWidth; this.width = widthOrHeight; this.height = height ?? 1; }
      else { this.width = dataOrWidth; this.height = widthOrHeight; this.data = new Uint8ClampedArray(this.width * this.height * 4); }
    }
  };
}

function section(title: string): void {
  console.log("\n" + "=".repeat(78));
  console.log(title);
  console.log("=".repeat(78));
}

async function diagnoseFile(filePath: string, label: string, applyFix: boolean): Promise<void> {
  section(`${label} — ${path.basename(filePath)} — ${applyFix ? "WITH FIX (offscreen canvases wrapped)" : "BEFORE FIX (top-level canvas only, today's shipped behavior)"}`);
  nextContextId = 0; // reset so THIS call's top-level context is deterministically id 0 (see below)
  const data = new Uint8Array(readFileSync(filePath));
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const OPS = (pdfjsLib as unknown as { OPS: Record<string, number> }).OPS;
  const opCodes: WhiteModeOpCodes = {
    beginMarkedContentProps: OPS.beginMarkedContentProps,
    beginMarkedContent: OPS.beginMarkedContent,
    endMarkedContent: OPS.endMarkedContent,
    constructPath: OPS.constructPath,
    rawFillPath: OPS.rawFillPath,
    fillPaintTypes: new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]),
    fillColorSetters: new Set([OPS.setFillRGBColor, OPS.setFillGray, OPS.setFillCMYKColor, OPS.setFillColor]),
    unsupportedFillOps: new Set([OPS.setFillColorN, OPS.shadingFill, OPS.paintImageXObject, OPS.paintImageMaskXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObjectRepeat, OPS.paintSolidColorImageMask]),
  };

  class NoOpCanvasFactory {
    create(width: number, height: number) {
      const canvas = { width, height };
      return { canvas, context: createFakeContext(canvas, { current: -1 }, () => {}) };
    }
    reset(entry: { canvas: { width: number; height: number } }, width: number, height: number) { entry.canvas.width = width; entry.canvas.height = height; }
    destroy(entry: { canvas: unknown; context: unknown }) { entry.canvas = null; entry.context = null; }
  }

  // Pass 1: analysis only — mirrors getOrComputePatchPlan exactly.
  const loadingTaskA = pdfjsLib.getDocument({ data: new Uint8Array(data), CanvasFactory: NoOpCanvasFactory });
  const docA = await loadingTaskA.promise;
  const pageA = await docA.getPage(1);
  const ocConfig = await docA.getOptionalContentConfig();
  const order = ocConfig.getOrder() ?? [];
  const layers = order.map((id: string) => ({ id, name: ocConfig.getGroup(id)?.name ?? id }));
  const detection = detectStandLayerId(layers);
  console.log("stand layer detection:", detection);
  if (detection.status !== "found") { await loadingTaskA.destroy(); return; }

  const operatorList = await pageA.getOperatorList({ intent: "display" });
  const totalOps = operatorList.fnArray.length;
  const formBeginCount = operatorList.fnArray.filter((fn: number) => fn === OPS.paintFormXObjectBegin).length;
  const formEndCount = operatorList.fnArray.filter((fn: number) => fn === OPS.paintFormXObjectEnd).length;
  const fillSetterCount = operatorList.fnArray.filter((fn: number) => opCodes.fillColorSetters.has(fn)).length;
  const fillPaintCount = operatorList.fnArray.filter((fn: number) => fn === opCodes.constructPath).length;
  console.log(`total operators = ${totalOps}`);
  console.log(`paintFormXObjectBegin count = ${formBeginCount}`);
  console.log(`paintFormXObjectEnd count = ${formEndCount}`);
  console.log(`fill-color-setter op count = ${fillSetterCount}`);
  console.log(`constructPath op count = ${fillPaintCount}`);

  const result = computeWhiteModeArgsArray(operatorList, detection.layerId, opCodes);
  console.log("computeWhiteModeArgsArray status:", result.status);
  if (result.status !== "patched") { if (result.status === "unsupported") console.log("reason:", result.reason); await loadingTaskA.destroy(); return; }
  console.log(`patched indices count = ${result.patchedIndices.length}`);
  await loadingTaskA.destroy();

  // Pass 2: a REAL page.render() call using the EXACT SAME production mechanism
  // (createWhiteModeCanvasContextProxy + operationsFilter) renderWhiteModePage uses — with every
  // context pdf.js creates internally (top-level AND any offscreen/transparency-group canvases)
  // instrumented to report every `fillStyle` assignment, tagged with the context's own identity
  // and the operator index active at that moment. `applyFix` mirrors the production fix
  // (WhiteModeAwareCanvasFactory): when true, every OFFSCREEN context pdf.js creates internally is
  // ALSO wrapped with the same fillStyle-forcing Proxy the top-level context already gets — proving
  // the fix closes the gap, not just describing it.
  const fillStyleLog: FillStyleEvent[] = [];
  const operatorIndexRef = { current: -1 };
  const patchedIndices = new Set(result.patchedIndices);
  const fillColor = "rgba(255, 255, 255, 1)";
  class TrackedCanvasFactory {
    create(width: number, height: number) {
      const canvas = { width, height };
      const rawContext = createFakeContext(canvas, operatorIndexRef, (event) => fillStyleLog.push(event));
      const context = applyFix ? createWhiteModeCanvasContextProxy(rawContext, patchedIndices, fillColor, operatorIndexRef) : rawContext;
      return { canvas, context };
    }
    reset(entry: { canvas: { width: number; height: number } }, width: number, height: number) { entry.canvas.width = width; entry.canvas.height = height; }
    destroy(entry: { canvas: unknown; context: unknown }) { entry.canvas = null; entry.context = null; }
  }

  const loadingTaskB = pdfjsLib.getDocument({ data: new Uint8Array(data), CanvasFactory: TrackedCanvasFactory });
  const docB = await loadingTaskB.promise;
  const pageB = await docB.getPage(1);
  const viewport = pageB.getViewport({ scale: 1 });
  const topLevelCanvas = { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height) };
  const topLevelContext = createFakeContext(topLevelCanvas, operatorIndexRef, (event) => fillStyleLog.push(event));
  const proxiedTop = createWhiteModeCanvasContextProxy(topLevelContext, patchedIndices, fillColor, operatorIndexRef);

  let renderError: unknown;
  try {
    await pageB.render({
      canvasContext: proxiedTop,
      canvas: null,
      viewport,
      intent: "display",
      operationsFilter: (index: number) => { operatorIndexRef.current = index; return true; },
    } as never).promise;
  } catch (error) {
    renderError = error;
  }
  await loadingTaskB.destroy();

  if (renderError) {
    console.log("REAL render() THREW:", renderError);
    return;
  }

  // The top-level context is whichever contextId fired FIRST in the log for id 0 by construction
  // order — createFakeContext assigns ids in creation order starting at 0, and topLevelContext was
  // the very first one created in this pass.
  const topLevelId = 0;
  console.log(`total fillStyle assignments observed (all contexts) = ${fillStyleLog.length}`);
  const onTop = fillStyleLog.filter((e) => e.contextId === topLevelId);
  const offTop = fillStyleLog.filter((e) => e.contextId !== topLevelId);
  console.log(`fillStyle assignments on the TOP-LEVEL (proxied) context = ${onTop.length}`);
  console.log(`fillStyle assignments on OTHER (offscreen/group) contexts = ${offTop.length}`);
  const distinctOffscreenIds = new Set(offTop.map((e) => e.contextId));
  console.log(`distinct OTHER context ids observed = ${distinctOffscreenIds.size}`, [...distinctOffscreenIds].slice(0, 10));

  const forcedWhiteAtPatchedIndex = fillStyleLog.filter((e) => patchedIndices.has(e.operatorIndex) && e.value === fillColor);
  console.log(`fillStyle actually forced to "${fillColor}" AT a patched index = ${forcedWhiteAtPatchedIndex.length} (expected ${patchedIndices.size})`);
  const forcedWhiteOnTop = forcedWhiteAtPatchedIndex.filter((e) => e.contextId === topLevelId);
  const forcedWhiteOffTop = forcedWhiteAtPatchedIndex.filter((e) => e.contextId !== topLevelId);
  console.log(`  ...of those, on the TOP-LEVEL context (would actually composite to the visible canvas) = ${forcedWhiteOnTop.length}`);
  console.log(`  ...of those, on an OFFSCREEN/group context (LOST unless later composited back) = ${forcedWhiteOffTop.length}`);

  const patchedIndicesNeverForcedWhiteAtAll = [...patchedIndices].filter((idx) => !fillStyleLog.some((e) => e.operatorIndex === idx && e.value === fillColor));
  console.log(`patched indices that NEVER received the forced-white value on ANY context = ${patchedIndicesNeverForcedWhiteAtAll.length}`, patchedIndicesNeverForcedWhiteAtAll.slice(0, 10));
}

installGlobalCanvasPolyfills();

async function main(): Promise<void> {
  const hala1 = path.join(importDir, "Hala 1.pdf");
  const hala3 = path.join(importDir, "Hala 3_2026- ver.12_NOVY_3.pdf");
  if (existsSync(hala1)) {
    await diagnoseFile(hala1, "WORKING CONTROL (FOR DECOR)", false);
    await diagnoseFile(hala1, "WORKING CONTROL (FOR DECOR)", true);
  } else console.log(`${hala1} not found — skipping.`);
  if (existsSync(hala3)) {
    await diagnoseFile(hala3, "FAILING REGRESSION (FOR BEAUTY)", false);
    await diagnoseFile(hala3, "FAILING REGRESSION (FOR BEAUTY)", true);
  } else console.log(`${hala3} not found — skipping.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
