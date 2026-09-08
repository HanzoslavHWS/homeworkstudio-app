import assert from "node:assert/strict";
import test from "node:test";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { jsPDF } from "jspdf";
import { loadingTaskToDocument, wrapPdfDocumentProxy } from "../lib/pdf/pdfDocumentLoader.ts";

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
