import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sanitizeUrlForLogging, toPdfLoadFailureInfo } from "../lib/pdf/pdfLoadDiagnostics.ts";

// =========================================================================================
// Technické rastry — "Failed to fetch" investigation regression tests (spec batch 5, UI section
// 17-26, 36-37). ROOT CAUSE (see the full report): getAssetDownloadUrl() returns a presigned R2
// URL that expires after 900s (lib/storage/cloudflareR2.server.ts's own default) and is resolved
// exactly ONCE per project.sourceRasterAsset (TechnicalRasterEditorPage.tsx) — but "Rastr" and
// "Přiřazení" each mount their OWN separate <TechnicalRasterCanvas>, so switching between them (or
// simply leaving the project open past ~15 minutes) makes a fresh mount call loadPdfDocument()
// again against a URL that may already be expired, with nothing that ever refreshed it. The fix:
// a single controlled retry (fresh URL, one more attempt), a friendly Czech error on ultimate
// failure (never the raw "Failed to fetch" string), and structured diagnostic logging.
//
// This repo's test runner has no JSX/DOM transform, so component-level React state can't be
// mounted directly here (same constraint as tests/technicalRasterCanvasBlankRegression.test.ts).
// Two things ARE directly testable without that: the diagnostic-logging helpers themselves (pure
// functions), and precise source-level guards pinning the EXACT structural claims this fix
// depends on — so a later edit can't silently undo them.
// =========================================================================================

test("sanitizeUrlForLogging: strips the query string (where a presigned URL's signature/token lives) — never logs it", () => {
  const url = "https://example.r2.cloudflarestorage.com/bucket/technical-rasters/p1/source/raster.pdf?X-Amz-Signature=secret-token-value&X-Amz-Expires=900";
  const sanitized = sanitizeUrlForLogging(url);
  assert.equal(sanitized, "https://example.r2.cloudflarestorage.com/bucket/technical-rasters/p1/source/raster.pdf");
  assert.ok(!sanitized.includes("secret-token-value"));
  assert.ok(!sanitized.includes("X-Amz-Signature"));
});

test("sanitizeUrlForLogging: a plain URL with no query string passes through unchanged (origin + pathname)", () => {
  assert.equal(sanitizeUrlForLogging("https://example.com/a/b.pdf"), "https://example.com/a/b.pdf");
});

test("sanitizeUrlForLogging: never throws on an unparsable value — logging a failure must never itself fail", () => {
  assert.doesNotThrow(() => sanitizeUrlForLogging("not a url"));
  assert.equal(sanitizeUrlForLogging("not a url"), "(unparsable url)");
});

test("toPdfLoadFailureInfo: captures error.name/message for a real Error, never the raw error object itself", () => {
  const info = toPdfLoadFailureInfo(new TypeError("Failed to fetch"), "https://example.com/x.pdf");
  assert.equal(info.errorName, "TypeError");
  assert.equal(info.errorMessage, "Failed to fetch");
  assert.equal(info.url, "https://example.com/x.pdf");
});

test("toPdfLoadFailureInfo: handles a non-Error rejection value without throwing", () => {
  const info = toPdfLoadFailureInfo("some string rejection");
  assert.equal(info.errorMessage, "some string rejection");
});

// =========================================================================================
// Source guards — pin the exact structural facts the fix depends on.
// =========================================================================================

async function readCanvasSource(): Promise<string> {
  return readFile(new URL("../components/workflow/technicalRasters/TechnicalRasterCanvas.tsx", import.meta.url), "utf8");
}

async function readEditorPageSource(): Promise<string> {
  return readFile(new URL("../components/workflow/technicalRasters/TechnicalRasterEditorPage.tsx", import.meta.url), "utf8");
}

test("item 21: the PDF-loading effect's dependency array is [pdfUrl] ONLY — a zoom-driven re-render trigger can never appear here, so it can never cause a re-fetch", async () => {
  const source = await readCanvasSource();
  assert.match(
    source,
    /\}, \[pdfUrl\]\);/u,
    "the loading effect must be keyed on pdfUrl alone — if renderScaleTrigger (or anything zoom-derived) is ever added here, a high-resolution re-render would start re-fetching the PDF from network",
  );
});

test("item 21: renderScaleTrigger (the zoom-driven re-render signal) lives ONLY in the render effect's deps, never the loading effect's", async () => {
  const source = await readCanvasSource();
  assert.match(source, /\}, \[activePage, renderKey, whiteModeStandLayerId, whiteFillOpacity, documentVersion, renderScaleTrigger\]\);/u);
  const loadingEffectDeps = source.match(/\}, \[pdfUrl\]\);/u);
  assert.ok(loadingEffectDeps, "loading effect deps array must exist verbatim as [pdfUrl]");
});

test("item 21/37: the render effect never calls loadPdfDocument itself — it only reuses the already-loaded document via document.getPage()", async () => {
  const source = await readCanvasSource();
  // Isolate the render effect's own body: from its own comment marker to its closing deps line.
  const renderEffectStart = source.indexOf("// Render the active page whenever");
  const renderEffectEnd = source.indexOf("}, [activePage, renderKey, whiteModeStandLayerId, whiteFillOpacity, documentVersion, renderScaleTrigger]);");
  assert.ok(renderEffectStart > 0 && renderEffectEnd > renderEffectStart);
  const renderEffectBody = source.slice(renderEffectStart, renderEffectEnd);
  assert.ok(!renderEffectBody.includes("loadPdfDocument("), "the render effect must never call loadPdfDocument — only the separate loading effect does");
  assert.ok(renderEffectBody.includes("document.getPage(activePage)"), "the render effect must reuse the existing document via getPage()");
});

test("item 23: the loading effect's catch never shows the raw error/error.message to the user — always a fixed Czech string", async () => {
  const source = await readCanvasSource();
  const catchStart = source.indexOf(".catch((loadError) => {");
  const catchEnd = source.indexOf("return () => {", catchStart);
  const catchBody = source.slice(catchStart, catchEnd);
  assert.ok(!/setError\(\s*loadError/u.test(catchBody), "setError must never be given loadError or loadError.message directly");
  assert.match(catchBody, /setError\("Rastr se nepodařilo načíst\."\)/u);
});

test("item 18: a load failure is logged via logPdfLoadFailure with the url and assetReference, and reported to the owner via onLoadFailed", async () => {
  const source = await readCanvasSource();
  const catchStart = source.indexOf(".catch((loadError) => {");
  const catchEnd = source.indexOf("return () => {", catchStart);
  const catchBody = source.slice(catchStart, catchEnd);
  assert.match(catchBody, /logPdfLoadFailure\(\{ phase: "canvas_load", assetReference, url: pdfUrl, error: loadError \}\)/u);
  assert.match(catchBody, /onLoadFailed\?\.\(/u);
});

test("item 22: the retry is bounded by rasterLoadRetriedRef — a SECOND failure never triggers another retry (never an infinite loop)", async () => {
  const source = await readEditorPageSource();
  const retryFnStart = source.indexOf("function handleRasterCanvasLoadFailed()");
  const retryFnEnd = source.indexOf("\n  }\n", retryFnStart);
  const retryFnBody = source.slice(retryFnStart, retryFnEnd);
  assert.match(retryFnBody, /if \(rasterLoadRetriedRef\.current\) \{/u, "must check the retry guard BEFORE attempting another fetch");
  assert.match(retryFnBody, /rasterLoadRetriedRef\.current = true;/u, "must set the guard before retrying, so a second failure on the SAME asset takes the early-return path above");
});

test("item 22: the retry guard is reset whenever the source raster asset (re)resolves, so a genuinely NEW raster gets its own fresh retry budget", async () => {
  const source = await readEditorPageSource();
  const resolveEffectStart = source.indexOf("rasterLoadRetriedRef.current = false;");
  assert.ok(resolveEffectStart > 0, "the asset-url-resolving effect must reset the retry guard");
});

test("item 24: a raster load failure never touches project state — only local rasterUrl/rasterUrlError state, never setProject/stands/imports", async () => {
  const source = await readEditorPageSource();
  const retryFnStart = source.indexOf("function handleRasterCanvasLoadFailed()");
  const retryFnEnd = source.indexOf("\n  }\n", retryFnStart);
  const retryFnBody = source.slice(retryFnStart, retryFnEnd);
  assert.ok(!retryFnBody.includes("setProject("), "must never touch project state on a load failure");
  assert.ok(!retryFnBody.includes("updateProject("), "must never touch project state on a load failure");
});

test("item 25: both TechnicalRasterCanvas mount points pass onLoadFailed, so the retry/logging path covers the Rastr AND Přiřazení steps", async () => {
  const source = await readEditorPageSource();
  const occurrences = source.split("onLoadFailed={handleRasterCanvasLoadFailed}").length - 1;
  assert.equal(occurrences, 2, "both <TechnicalRasterCanvas> mounts (raster step, assignment step) must wire the same retry handler");
});

test("spec batch 6, item 29: whiteFillOpacity is NOT part of the [pdfUrl]-only loading effect's deps — a slider change can never trigger a PDF re-fetch, only listed in the RENDER effect's own deps", async () => {
  const source = await readCanvasSource();
  assert.match(source, /\}, \[activePage, renderKey, whiteModeStandLayerId, whiteFillOpacity, documentVersion, renderScaleTrigger\]\);/u, "whiteFillOpacity must be a dependency of the RENDER effect only");
  const loadingEffectDeps = source.match(/\}, \[pdfUrl\]\);/u);
  assert.ok(loadingEffectDeps, "the loading effect's deps array must remain exactly [pdfUrl] — whiteFillOpacity must never appear there");
});
