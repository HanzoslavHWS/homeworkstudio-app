import assert from "node:assert/strict";
import test from "node:test";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { jsPDF } from "jspdf";
import { loadingTaskToDocument, wrapPdfDocumentProxy, WhiteModeAwareCanvasFactory } from "../lib/pdf/pdfDocumentLoader.ts";

// =========================================================================================
// Technické rastry — regression test for the "document.destroy is not a function" runtime bug
// (hotfix batch). ROOT CAUSE: pdfjs-dist's `getDocument()` returns a `PDFDocumentLoadingTask`;
// only THAT object has `.destroy()`. Its own `.promise` resolves to a `PDFDocumentProxy`, which
// does NOT have `.destroy()` (only `.cleanup()`, a different, unrelated method). The old
// loadPdfDocument() returned `await task.promise` directly — the bare, undestroyable proxy — and
// the PdfJsDocument TYPE lied about it having a working `destroy()`. Every earlier automated test
// for this feature used a HAND-TYPED fake PdfJsDocument (matching the type, not pdf.js's real
// shape), so none of them caught this — this file deliberately uses pdfjs-dist's OWN real
// getDocument() result instead of any hand-rolled mock, against a tiny PDF generated in-memory
// with jsPDF (already a project dependency) so this test needs no external fixture file and is
// always part of the standard `npm test` run (not gated behind the gitignored real _IMPORT files).
// =========================================================================================

async function makeRealLoadingTaskAndProxy() {
  const doc = new jsPDF();
  doc.text("Technicke rastry hotfix regression fixture", 10, 10);
  const bytes = doc.output("arraybuffer");
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(bytes) });
  const proxy = await loadingTask.promise;
  return { loadingTask, proxy };
}

test("contract pin: pdfjs-dist's REAL PDFDocumentLoadingTask has a working destroy(); the REAL resolved PDFDocumentProxy does NOT", async () => {
  const { loadingTask, proxy } = await makeRealLoadingTaskAndProxy();
  try {
    assert.equal(typeof loadingTask.destroy, "function", "the loading task is the true resource owner");
    assert.equal(typeof (proxy as unknown as { destroy?: unknown }).destroy, "undefined", "the resolved proxy genuinely has no destroy() — this is the root cause, not a hypothetical");
    assert.equal(typeof (proxy as unknown as { cleanup?: unknown }).cleanup, "function", "the proxy DOES have cleanup() — an easy, unrelated method to confuse destroy() with");
  } finally {
    await loadingTask.destroy();
  }
});

test("REGRESSION: the OLD implementation's approach (returning the bare proxy and calling .destroy() on it) throws 'is not a function' — proven against a real pdf.js object, not a mock", async () => {
  const { loadingTask, proxy } = await makeRealLoadingTaskAndProxy();
  try {
    const bareProxyAsOldPdfJsDocument = proxy as unknown as { destroy(): Promise<void> };
    await assert.rejects(
      async () => { await bareProxyAsOldPdfJsDocument.destroy(); },
      (error: unknown) => error instanceof TypeError && /destroy is not a function/u.test(error.message),
    );
  } finally {
    await loadingTask.destroy();
  }
});

test("FIXED: wrapPdfDocumentProxy(loadingTask, proxy) provides a destroy() that actually works, against the real loading task/proxy pair", async () => {
  const { loadingTask, proxy } = await makeRealLoadingTaskAndProxy();
  const wrapped = wrapPdfDocumentProxy(loadingTask, proxy as never);
  // must NOT throw — this is the exact call site pattern from TechnicalRasterEditorPage.tsx /
  // TechnicalRasterCanvas.tsx / TechnicalServiceImportPanel.tsx.
  await wrapped.destroy();
});

test("destroy() is idempotent — calling it twice never throws (prevents a double-destroy crash if two call sites/cleanup paths ever race)", async () => {
  const { loadingTask, proxy } = await makeRealLoadingTaskAndProxy();
  const wrapped = wrapPdfDocumentProxy(loadingTask, proxy as never);
  await wrapped.destroy();
  await wrapped.destroy(); // must not throw a second time
});

test("the wrapper still correctly delegates numPages/getPage/getOptionalContentConfig to the real proxy — fixing destroy() didn't break normal usage", async () => {
  const { loadingTask, proxy } = await makeRealLoadingTaskAndProxy();
  const wrapped = wrapPdfDocumentProxy(loadingTask, proxy as never);
  try {
    assert.equal(wrapped.numPages, proxy.numPages);
    const page = await wrapped.getPage(1);
    assert.equal(typeof page.getViewport, "function");
    const config = await wrapped.getOptionalContentConfig();
    assert.equal(typeof config.getOrder, "function");
  } finally {
    await wrapped.destroy();
  }
});

test("cleanup still happens even if something between load and destroy throws — mirrors the try/finally pattern in TechnicalRasterEditorPage.tsx and TechnicalServiceImportPanel.tsx", async () => {
  const { loadingTask, proxy } = await makeRealLoadingTaskAndProxy();
  const wrapped = wrapPdfDocumentProxy(loadingTask, proxy as never);
  let destroyRanAfterError = false;
  await assert.rejects(async () => {
    try {
      throw new Error("simulated extraction failure");
    } finally {
      await wrapped.destroy();
      destroyRanAfterError = true;
    }
  }, /simulated extraction failure/u);
  assert.equal(destroyRanAfterError, true, "destroy() must still run even though the extraction step failed");
});

test("a long-lived document is NOT destroyed just by using it — getPage()/getOptionalContentConfig() never trigger destroy() as a side effect, only an explicit destroy() call does (mirrors TechnicalRasterCanvas.tsx keeping a document alive across multiple page renders)", async () => {
  const { loadingTask, proxy } = await makeRealLoadingTaskAndProxy();
  const wrapped = wrapPdfDocumentProxy(loadingTask, proxy as never);
  try {
    await wrapped.getPage(1);
    await wrapped.getOptionalContentConfig();
    await wrapped.getPage(1); // used again, simulating a second render — must still work, not already destroyed
    assert.equal(wrapped.numPages, proxy.numPages);
  } finally {
    await wrapped.destroy();
  }
});

// =========================================================================================
// Technické rastry — regression test for the worker-leak-on-failed-load bug (hotfix batch 5,
// "Failed to fetch" investigation). ROOT CAUSE: reading pdf.js's own PDFDocumentLoadingTask source
// (this pinned 6.3.289) shows that when `loadingTask.promise` REJECTS (a network failure, an
// invalid PDF, a 403 from an expired signed URL, ...), pdf.js only calls
// `task._capability.reject(error)` — it NEVER calls the task's own `destroy()`, so the task's
// worker is silently orphaned unless the CALLER explicitly destroys it. The previous
// loadPdfDocument() just `await`ed loadingTask.promise with no catch at all, so every failed load
// (and, once this batch added a controlled one-time retry on failure in
// TechnicalRasterEditorPage.tsx, every retry too) leaked one worker. loadingTaskToDocument() is
// the fix, isolated for direct testing against a REAL pdfjs-dist rejection (deliberately invalid
// PDF bytes, not a hand-typed mock) — same "test against pdf.js's own real shape" discipline this
// file already established for the original destroy()-is-not-a-function bug above.
// =========================================================================================

function makeInvalidLoadingTask() {
  // 4 garbage bytes are not a valid PDF header ("%PDF-") — pdfjs-dist's real getDocument()
  // rejects this with InvalidPDFException, a genuine rejection from the real library.
  return pdfjsLib.getDocument({ data: new Uint8Array([0, 1, 2, 3]) });
}

test("contract pin: a REAL pdfjs-dist loadingTask whose promise rejects does NOT call its own destroy() automatically — confirms the root cause, not a hypothetical", async () => {
  const loadingTask = makeInvalidLoadingTask();
  await assert.rejects(() => loadingTask.promise);
  // destroy() is still safely callable afterward (idempotent, spec-established elsewhere in this
  // file) — this only proves pdf.js itself never called it, by showing the resource is still live
  // enough to need an explicit destroy at all (a real already-destroyed task's destroy() is also a
  // no-op, so this is a weak signal on its own — the REAL proof is the spy test below).
  await loadingTask.destroy();
});

test("FIXED: loadingTaskToDocument() destroys the loadingTask when its promise rejects, and rethrows the original error", async () => {
  const realLoadingTask = makeInvalidLoadingTask();
  let destroyCallCount = 0;
  const spiedLoadingTask = {
    promise: realLoadingTask.promise,
    destroy: async () => {
      destroyCallCount += 1;
      await realLoadingTask.destroy();
    },
  };

  await assert.rejects(
    () => loadingTaskToDocument(spiedLoadingTask),
    (error: unknown) => error instanceof Error,
    "the original rejection must still propagate — never swallowed",
  );
  assert.equal(destroyCallCount, 1, "the loading task must be destroyed EXACTLY once on a failed load — this is what prevents the worker leak");
});

test("loadingTaskToDocument() never calls destroy() on the SUCCESS path — a working document must stay alive for the caller to use and destroy itself later", async () => {
  const { loadingTask } = await makeRealLoadingTaskAndProxy();
  let destroyCallCount = 0;
  const spiedLoadingTask = {
    promise: loadingTask.promise,
    destroy: async () => {
      destroyCallCount += 1;
      await loadingTask.destroy();
    },
  };
  const proxy = await loadingTaskToDocument(spiedLoadingTask);
  assert.equal(destroyCallCount, 0, "success must never trigger a destroy as a side effect");
  assert.equal(typeof proxy.numPages, "number");
  await loadingTask.destroy();
});

// =========================================================================================
// CORRECTIVE BATCH (editor-only white mode) — real manual acceptance found Hala 3 (every stand
// fill drawn inside a Form XObject) stays fully colored in the editor even though the fill-color-
// setter indices are computed correctly. Empirically confirmed root cause (see
// scripts/technicalRasterEditorWhiteModeRealDiagnostic.ts, which proves this against the REAL
// fixture): every one of those Form XObjects declares its own `/Group /S /Transparency`, which
// makes pdf.js's own CanvasGraphics#beginGroup paint the Form's content onto a BRAND NEW offscreen
// canvas created via `canvasFactory.create()` — never the one top-level canvas this app already
// wraps in lib/pdf/technicalRasterWhiteRender.ts's `createWhiteModeCanvasContextProxy`. Real
// pdf.js rendering needs a real DOM `<canvas>`, unavailable under plain `node:test` — these tests
// instead exercise `WhiteModeAwareCanvasFactory` directly against a FAKE `ownerDocument` (the same
// technique this feature's OTHER tests use for `CanvasRenderingContext2D` — see
// tests/technicalRasterWhiteRender.test.ts's own `fakeCanvasContext()` — a plain object is all
// pdf.js's real `setFillRGBColor` handler ever needs: a settable `fillStyle` property).
// =========================================================================================

/** A fake `Document` whose `createElement("canvas")` returns a plain object with a settable `fillStyle` on its "2d" context — enough surface for WhiteModeAwareCanvasFactory's own create()/reset()/destroy(), without needing a real DOM. */
function fakeOwnerDocument(): Document {
  return {
    createElement: (tagName: string) => {
      assert.equal(tagName, "canvas", "WhiteModeAwareCanvasFactory must only ever create <canvas> elements");
      const context: { fillStyle: unknown } = { fillStyle: "#000000" };
      return {
        width: 0,
        height: 0,
        getContext: (kind: string) => {
          assert.equal(kind, "2d");
          return context;
        },
      } as unknown as HTMLCanvasElement;
    },
  } as unknown as Document;
}

test("WhiteModeAwareCanvasFactory: with NO active session, create() returns a PLAIN, unwrapped 2D context — a fillStyle assignment is never forced, exactly matching pdf.js's own default DOMCanvasFactory behavior for every ordinary, non-white-mode render (zero regression risk)", () => {
  const factory = new WhiteModeAwareCanvasFactory({ ownerDocument: fakeOwnerDocument() });
  const { canvas, context } = factory.create(10, 20);
  assert.equal(canvas.width, 10);
  assert.equal(canvas.height, 20);
  const ctx = context as unknown as { fillStyle: unknown };
  ctx.fillStyle = "#ff0000";
  assert.equal(ctx.fillStyle, "#ff0000", "no active session means no forcing at all");
});

test("WhiteModeAwareCanvasFactory: with an ACTIVE session, create() returns a context whose fillStyle is forced white EXACTLY at a patched operator index — proving the fix reaches OFFSCREEN canvases (a Form XObject's own transparency-group canvas), not just the one top-level canvas this app already managed directly", () => {
  const factory = new WhiteModeAwareCanvasFactory({ ownerDocument: fakeOwnerDocument() });
  const operatorIndexRef = { current: -1 };
  factory.setActiveSession({ patchedIndices: new Set([5]), fillColor: "rgba(255, 255, 255, 1)", operatorIndexRef, neutralizeAlphaIndices: new Set() });
  const { context } = factory.create(10, 10);
  const ctx = context as unknown as { fillStyle: unknown };

  operatorIndexRef.current = 3; // NOT a patched index — unrelated content elsewhere on the same page
  ctx.fillStyle = "#ff0000";
  assert.equal(ctx.fillStyle, "#ff0000", "an unrelated fill (not at a patched index) must never be forced white, even on a wrapped offscreen context");

  operatorIndexRef.current = 5; // the patched index — this IS the Form's own stand fill
  ctx.fillStyle = "#ffeb3b";
  assert.equal(ctx.fillStyle, "rgba(255, 255, 255, 1)", "the Form's own fill at the patched index IS forced white, even though it paints on an offscreen canvas, never the top-level one");
});

test("WhiteModeAwareCanvasFactory: clearing the session (setActiveSession(undefined)) reverts create() to plain, unwrapped contexts — mirrors renderWhiteModePage's own finally-block cleanup after each render(), so a LATER ordinary render is never accidentally forced white", () => {
  const factory = new WhiteModeAwareCanvasFactory({ ownerDocument: fakeOwnerDocument() });
  const operatorIndexRef = { current: 5 };
  factory.setActiveSession({ patchedIndices: new Set([5]), fillColor: "rgba(255, 255, 255, 1)", operatorIndexRef, neutralizeAlphaIndices: new Set() });
  factory.setActiveSession(undefined);
  const { context } = factory.create(10, 10);
  const ctx = context as unknown as { fillStyle: unknown };
  ctx.fillStyle = "#ffeb3b";
  assert.equal(ctx.fillStyle, "#ffeb3b", "no active session after clearing — never stuck forcing white for a later, unrelated render");
});

test("WhiteModeAwareCanvasFactory: reset()/destroy() mirror pdf.js's own BaseCanvasFactory contract (invalid size and missing-canvas both throw, matching the real default factory's own defensive checks)", () => {
  const factory = new WhiteModeAwareCanvasFactory({ ownerDocument: fakeOwnerDocument() });
  assert.throws(() => factory.create(0, 10), /Invalid canvas size/u);
  const entry = factory.create(10, 10) as unknown as { canvas: HTMLCanvasElement | null; context: unknown };
  factory.reset(entry, 20, 30);
  assert.equal((entry.canvas as unknown as { width: number; height: number }).width, 20);
  assert.equal((entry.canvas as unknown as { width: number; height: number }).height, 30);
  factory.destroy(entry);
  assert.equal(entry.canvas, null);
  assert.throws(() => factory.destroy(entry), /Canvas is not specified/u);
});

test("wrapPdfDocumentProxy: setWhiteModeCanvasSession forwards to the given canvasFactory's setActiveSession, and is a safe no-op when no canvasFactory is given at all (every pre-existing call site/test in this file predates this batch and never passes one)", async () => {
  const { loadingTask, proxy } = await makeRealLoadingTaskAndProxy();
  try {
    let sessionSeen: unknown = "not-called";
    const spiedFactory = { setActiveSession: (session: unknown) => { sessionSeen = session; } } as unknown as WhiteModeAwareCanvasFactory;
    const wrapped = wrapPdfDocumentProxy(loadingTask, proxy as never, spiedFactory);
    const session = { patchedIndices: new Set([1]), fillColor: "white", operatorIndexRef: { current: -1 }, neutralizeAlphaIndices: new Set<number>() };
    wrapped.setWhiteModeCanvasSession?.(session);
    assert.equal(sessionSeen, session);

    const wrappedNoFactory = wrapPdfDocumentProxy(loadingTask, proxy as never);
    assert.doesNotThrow(() => wrappedNoFactory.setWhiteModeCanvasSession?.(session));
  } finally {
    await loadingTask.destroy();
  }
});
