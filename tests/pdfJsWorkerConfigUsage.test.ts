import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pdfDocumentLoaderSource = readFileSync(new URL("../lib/pdf/pdfDocumentLoader.ts", import.meta.url), "utf8");
const technicalRasterVectorPdfSource = readFileSync(new URL("../lib/technicalRasterVectorPdf.ts", import.meta.url), "utf8");

// =========================================================================================
// Manual acceptance batch, section 32: "PDF.JS WORKER CONFIG MUSÍ BÝT JEDNOU" — pins that BOTH
// pdf.js entry points this app imports go through the ONE shared helper, never a second ad-hoc
// `GlobalWorkerOptions.workerSrc = ...` literal scattered across components/libs.
// =========================================================================================

test("WORKER CONFIG: pdfDocumentLoader.ts (the raster canvas/parser path) configures its worker via the shared helper, never a bare `GlobalWorkerOptions.workerSrc =` assignment", () => {
  assert.match(pdfDocumentLoaderSource, /ensurePdfJsWorkerConfigured\(/u);
  assert.doesNotMatch(pdfDocumentLoaderSource, /GlobalWorkerOptions\.workerSrc\s*=/u);
});

test("WORKER CONFIG: technicalRasterVectorPdf.ts's resolveSourcePageGeometry (the export path that previously threw the real GlobalWorkerOptions error) also configures its worker via the SAME shared helper, never a bare assignment", () => {
  assert.match(technicalRasterVectorPdfSource, /ensurePdfJsWorkerConfigured\(/u);
  assert.doesNotMatch(technicalRasterVectorPdfSource, /GlobalWorkerOptions\.workerSrc\s*=/u);
});

test("WORKER CONFIG: both call sites import the SAME shared module (./pdfJsWorkerConfig / ./pdf/pdfJsWorkerConfig), never two independent copies of this logic", () => {
  assert.match(pdfDocumentLoaderSource, /from\s+"\.\/pdfJsWorkerConfig(\.ts)?"/u);
  assert.match(technicalRasterVectorPdfSource, /from\s+"\.\/pdf\/pdfJsWorkerConfig(\.ts)?"/u);
});
