import assert from "node:assert/strict";
import test from "node:test";
import { ensurePdfJsWorkerConfigured } from "../lib/pdf/pdfJsWorkerConfig.ts";

// =========================================================================================
// Manual acceptance batch, section 30-33: root cause of the real user-facing
// `No "GlobalWorkerOptions.workerSrc" specified.` error on the Výstupy (export) step was
// lib/technicalRasterVectorPdf.ts's resolveSourcePageGeometry() importing pdfjs-dist's "legacy"
// build directly and NEVER configuring its own GlobalWorkerOptions.workerSrc — unlike
// lib/pdf/pdfDocumentLoader.ts's loadPdfDocument() (used by the raster canvas, confirmed working),
// which already did. These tests pin the SHARED fix (ensurePdfJsWorkerConfigured) both modules now
// call — never a re-introduced ad-hoc `workerSrc = ...` literal.
// =========================================================================================

function fakePdfjsModule() {
  return { GlobalWorkerOptions: { workerSrc: "" } };
}

test("under plain Node (this test runner) — a no-op: never assigns workerSrc, matching pdf.js's own legacy-build behavior of running workerless outside a browser", () => {
  const mod = fakePdfjsModule();
  ensurePdfJsWorkerConfigured(mod, "https://example.invalid/worker.mjs");
  assert.equal(mod.GlobalWorkerOptions.workerSrc, "", "Node has no `window` — this must stay a no-op");
});

test("simulated browser (typeof window defined): configures workerSrc on the first call", () => {
  const original = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {};
  try {
    const mod = fakePdfjsModule();
    ensurePdfJsWorkerConfigured(mod, "https://example.invalid/worker.mjs");
    assert.equal(mod.GlobalWorkerOptions.workerSrc, "https://example.invalid/worker.mjs");
  } finally {
    (globalThis as { window?: unknown }).window = original;
  }
});

test("simulated browser: configuring the SAME module instance twice never re-assigns workerSrc a second time (a caller changing workerSrc back never gets silently overwritten again)", () => {
  const original = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {};
  try {
    const mod = fakePdfjsModule();
    ensurePdfJsWorkerConfigured(mod, "https://example.invalid/first.mjs");
    mod.GlobalWorkerOptions.workerSrc = "https://example.invalid/overridden.mjs";
    ensurePdfJsWorkerConfigured(mod, "https://example.invalid/second.mjs");
    assert.equal(mod.GlobalWorkerOptions.workerSrc, "https://example.invalid/overridden.mjs", "a second call for the SAME module instance must be a no-op");
  } finally {
    (globalThis as { window?: unknown }).window = original;
  }
});

test("simulated browser: two DIFFERENT module instances (e.g. \"pdfjs-dist\" main vs \"pdfjs-dist/legacy/build/pdf.mjs\") are configured INDEPENDENTLY — configuring one never marks the other as already-configured", () => {
  const original = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {};
  try {
    const moduleA = fakePdfjsModule();
    const moduleB = fakePdfjsModule();
    ensurePdfJsWorkerConfigured(moduleA, "https://example.invalid/a.mjs");
    ensurePdfJsWorkerConfigured(moduleB, "https://example.invalid/b.mjs");
    assert.equal(moduleA.GlobalWorkerOptions.workerSrc, "https://example.invalid/a.mjs");
    assert.equal(moduleB.GlobalWorkerOptions.workerSrc, "https://example.invalid/b.mjs");
  } finally {
    (globalThis as { window?: unknown }).window = original;
  }
});

test("accepts a real URL object (not just a string) and stores its string form", () => {
  const original = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {};
  try {
    const mod = fakePdfjsModule();
    const url = new URL("https://example.invalid/worker.mjs");
    ensurePdfJsWorkerConfigured(mod, url);
    assert.equal(mod.GlobalWorkerOptions.workerSrc, url.toString());
  } finally {
    (globalThis as { window?: unknown }).window = original;
  }
});
