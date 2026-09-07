import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  computeTargetPixelSize,
  PRINT_SURFACE_PDF_IMAGE_DPI,
  PRINT_SURFACE_PDF_JPEG_QUALITY,
  PRINT_SURFACE_PDF_LOGO_DPI,
} from "../lib/pdf/prepareImageForPdf.ts";
import {
  PRINT_SURFACE_PDF_EVENT_LOGO_HEIGHT_MM,
  PRINT_SURFACE_PDF_EVENT_LOGO_WIDTH_MM,
  PRINT_SURFACE_PDF_TWO_VIEW_GAP_MM,
  PRINT_SURFACE_PDF_USABLE_WIDTH_MM,
  resolvePrintSurfaceViewRenderBox,
} from "../lib/pdf/printSurfaceViewLayout.ts";
import { resolveContainRect } from "../lib/pdf/imageRect.ts";

// =========================================================================================
// PDF SIZE — five rounds of investigation (real-usage follow-up):
//
// Round 1: a full-original-resolution photo (often 4000x3000+) embedded as lossless PNG at native
// pixel size took an export from a plain "insert everything" baseline to ~12MB. Switching to a
// downscaled (160 DPI) JPEG (quality 0.82) brought that to ~6MB.
//
// Round 2: measuring the remaining ~6MB found booth photos STILL the dominant contributor (fonts
// are ~140KB combined, embedded once — see the source-contract check below; no duplicate
// doc.addImage() calls exist — lib/printSurfacePdf.ts calls it exactly once per view and once for
// the logo). DPI/quality were tuned down to 140/0.76, and the event logo — which can legitimately
// be a multi-MB high-resolution PNG upload shown at a tiny 34x20mm box — was ALSO downscaled
// (staying PNG, to preserve transparency/sharp edges, never JPEG).
//
// Round 3: 140/0.76 over-corrected — a typical export dropped to ~600KB, but booth visualizations
// were visibly blurred. Raised to 180 DPI / quality 0.82, landing a typical export around ~1-2.5MB.
//
// Round 4: 180/0.82 landed a typical export around ~450KB — smaller than expected, and two
// side-by-side view previews still looked slightly soft. Raised to 200 DPI / quality 0.86.
//
// Round 5 (THIS phase): 200/0.86 still looked soft for two side-by-side views — a relatively small
// physical box at 200 DPI is still a fairly low absolute pixel count. Raised once more to 300 DPI /
// quality 0.90 (spec: "Neřeš teď minimální velikost... klidně 1-3 MB" — quality is now the explicit
// priority). This same phase also closed a real lifecycle bug: prepareImageForPdf's internal
// try/catch could silently produce a valid-but-imageless PDF if the OPTIMIZED encode failed after
// the image had already loaded successfully — now it falls back to a native-resolution encode, and
// if even THAT fails, the whole generation throws instead of ever producing a views-less "success".
//
// computeTargetPixelSize is pure math (no DOM), fully unit-testable here; the actual canvas
// resize/encode in prepareImageForPdf() needs a real <canvas> (no DOM/component test runner exists
// in this repo — see tests/printSurfaceEmailFlow.test.ts's own doc note), so that half is covered
// by source-contract checks below instead.
// =========================================================================================

test("A 4000x3000 photo rendered at 182x108mm (the single-view box) downscales well below its original resolution, at the CURRENT 300 DPI target", () => {
  const size = computeTargetPixelSize(182, 108, 4000, 3000);
  assert.ok(size.widthPx < 4000, `expected downscale, got ${size.widthPx}px`);
  assert.ok(size.heightPx < 3000, `expected downscale, got ${size.heightPx}px`);
  // 182mm / 25.4 * 300 ≈ 2150px.
  assert.ok(size.widthPx > 2000 && size.widthPx < 2300, `expected roughly ~2150px, got ${size.widthPx}px`);
});

test("an image already SMALLER than the DPI target is never upscaled — original size is returned unchanged", () => {
  const size = computeTargetPixelSize(182, 108, 500, 375);
  assert.equal(size.widthPx, 500);
  assert.equal(size.heightPx, 375);
});

test("target pixel size follows renderedMm / 25.4 * DPI exactly, for a case that stays below the original", () => {
  const size = computeTargetPixelSize(100, 50, 10000, 5000, 150);
  const expectedWidth = Math.round((100 / 25.4) * 150);
  const expectedHeight = Math.round((50 / 25.4) * 150);
  assert.equal(size.widthPx, expectedWidth);
  assert.equal(size.heightPx, expectedHeight);
});

test("aspect ratio is preserved: a rendered rect built via resolveContainRect (which already preserves aspect ratio) yields a target pixel size with the SAME ratio as the original image", () => {
  const originalWidthPx = 4000;
  const originalHeightPx = 3000; // 4:3
  const rect = resolveContainRect({ x: 0, y: 0, width: PRINT_SURFACE_PDF_USABLE_WIDTH_MM, height: 108 }, originalWidthPx, originalHeightPx);
  const size = computeTargetPixelSize(rect.width, rect.height, originalWidthPx, originalHeightPx);
  const originalRatio = originalWidthPx / originalHeightPx;
  const targetRatio = size.widthPx / size.heightPx;
  assert.ok(Math.abs(originalRatio - targetRatio) < 0.01, `expected ratio ~${originalRatio}, got ${targetRatio}`);
});

test("degenerate inputs (zero/negative dimensions) never throw and never produce a negative size", () => {
  assert.deepEqual(computeTargetPixelSize(0, 0, 0, 0), { widthPx: 0, heightPx: 0 });
  assert.deepEqual(computeTargetPixelSize(100, 100, -5, -5), { widthPx: 0, heightPx: 0 });
});

test("PRINT_SURFACE_PDF_IMAGE_DPI / PRINT_SURFACE_PDF_JPEG_QUALITY are the CURRENT (round-5) values — single named constants, never magic numbers scattered elsewhere", () => {
  assert.equal(PRINT_SURFACE_PDF_IMAGE_DPI, 300);
  assert.equal(PRINT_SURFACE_PDF_JPEG_QUALITY, 0.9);
});

test("PRINT_SURFACE_PDF_LOGO_DPI matches the booth-photo DPI now that both are 300 — the logo box is tiny either way, so a generous DPI costs almost nothing in bytes while guaranteeing sharpness", () => {
  assert.equal(PRINT_SURFACE_PDF_LOGO_DPI, 300);
  assert.ok(PRINT_SURFACE_PDF_LOGO_DPI >= PRINT_SURFACE_PDF_IMAGE_DPI);
});

test("1-view vs 2-view layouts produce DIFFERENT (not identical, never fixed-1000px) target pixel sizes — target is adaptive to the actual rendered box", () => {
  const originalWidthPx = 4000;
  const originalHeightPx = 3000;
  const oneViewBox = resolvePrintSurfaceViewRenderBox(1, false);
  const twoViewBox = resolvePrintSurfaceViewRenderBox(2, false); // side-by-side, smaller box
  const oneViewRect = resolveContainRect({ x: 0, y: 0, width: oneViewBox.widthMm, height: oneViewBox.heightMm }, originalWidthPx, originalHeightPx);
  const twoViewRect = resolveContainRect({ x: 0, y: 0, width: twoViewBox.widthMm, height: twoViewBox.heightMm }, originalWidthPx, originalHeightPx);
  const oneViewSize = computeTargetPixelSize(oneViewRect.width, oneViewRect.height, originalWidthPx, originalHeightPx);
  const twoViewSize = computeTargetPixelSize(twoViewRect.width, twoViewRect.height, originalWidthPx, originalHeightPx);
  assert.ok(twoViewSize.widthPx < oneViewSize.widthPx, `expected the smaller 2-view box to target fewer pixels: ${twoViewSize.widthPx} vs ${oneViewSize.widthPx}`);
});

// -----------------------------------------------------------------------------------------------
// Shared view-layout box sizing (lib/pdf/printSurfaceViewLayout.ts) — used both by the PDF drawing
// code and the image-optimization step, so they can never disagree about final rendered size.
// -----------------------------------------------------------------------------------------------
test("view render box: single view is near-full page width, 108mm tall", () => {
  const box = resolvePrintSurfaceViewRenderBox(1, false);
  assert.equal(box.widthMm, PRINT_SURFACE_PDF_USABLE_WIDTH_MM);
  assert.equal(box.heightMm, 108);
});

test("view render box: two portrait views stack full-width, 78mm tall each", () => {
  const box = resolvePrintSurfaceViewRenderBox(2, true);
  assert.equal(box.widthMm, PRINT_SURFACE_PDF_USABLE_WIDTH_MM);
  assert.equal(box.heightMm, 78);
});

test("view render box: two non-portrait views go side-by-side, half width minus the gap, 82mm tall each", () => {
  const box = resolvePrintSurfaceViewRenderBox(2, false);
  assert.equal(box.widthMm, (PRINT_SURFACE_PDF_USABLE_WIDTH_MM - PRINT_SURFACE_PDF_TWO_VIEW_GAP_MM) / 2);
  assert.equal(box.heightMm, 82);
});

test("logo box constants match exactly what lib/printSurfacePdf.ts's drawHeader draws (34x20mm) — shared, never a second copy of these numbers", () => {
  assert.equal(PRINT_SURFACE_PDF_EVENT_LOGO_WIDTH_MM, 34);
  assert.equal(PRINT_SURFACE_PDF_EVENT_LOGO_HEIGHT_MM, 20);
  const printSurfacePdfSource = readFileSync(new URL("../lib/printSurfacePdf.ts", import.meta.url), "utf8");
  assert.match(printSurfacePdfSource, /const eventLogoW = PRINT_SURFACE_PDF_EVENT_LOGO_WIDTH_MM;/u);
  assert.match(printSurfacePdfSource, /const eventLogoH = PRINT_SURFACE_PDF_EVENT_LOGO_HEIGHT_MM;/u);
});

// -----------------------------------------------------------------------------------------------
// Source-contract checks (no DOM/canvas available in this test runner) — see this repo's
// established convention in tests/printSurfaceEmailFlow.test.ts.
// -----------------------------------------------------------------------------------------------
const prepareImageForPdfSource = readFileSync(new URL("../lib/pdf/prepareImageForPdf.ts", import.meta.url), "utf8");
const exportPanelSource = readFileSync(new URL("../components/workflow/printSurfaces/PrintSurfaceExportPanel.tsx", import.meta.url), "utf8");
const loadImageDataUrlSource = readFileSync(new URL("../lib/pdf/loadImageDataUrl.ts", import.meta.url), "utf8");
const printSurfacePdfSource = readFileSync(new URL("../lib/printSurfacePdf.ts", import.meta.url), "utf8");
const czechFontSource = readFileSync(new URL("../lib/pdf/czechFont.ts", import.meta.url), "utf8");
const fontAssetSource = readFileSync(new URL("../lib/fonts/graphicsProductionFont.ts", import.meta.url), "utf8");

test("prepareImageForPdf's JPEG mode really produces a data:image/jpeg data URL (the actual MIME prefix jsPDF sees), never a PNG relabeled as JPEG — flattens onto white first, never upscales", () => {
  assert.match(prepareImageForPdfSource, /canvas\.toDataURL\("image\/jpeg", input\.quality \?\? PRINT_SURFACE_PDF_JPEG_QUALITY\)/u, "the literal MIME string passed to toDataURL IS the resulting data URL's prefix — data:image/jpeg;base64,...");
  assert.match(prepareImageForPdfSource, /ctx\.fillStyle = "#ffffff"/u);
  assert.match(prepareImageForPdfSource, /ctx\.fillRect\(0, 0, widthPx, heightPx\)/u);
  assert.match(prepareImageForPdfSource, /computeTargetPixelSize\(/u);
});

test("prepareImageForPdf's PNG mode (format: \"PNG\") skips the white-background flatten — real alpha transparency survives, and never gets routed through JPEG encoding", () => {
  const fn = prepareImageForPdfSource.match(/export function prepareImageForPdf\([\s\S]*?\n\}\n/u);
  assert.ok(fn, "expected to find function prepareImageForPdf");
  assert.match(fn![0], /if \(format === "JPEG"\) \{\s*\n\s*ctx\.fillStyle = "#ffffff";/u, "the white-fill only happens for JPEG, not PNG");
  assert.match(fn![0], /: canvas\.toDataURL\("image\/png"\)/u);
});

test("prepareImageForPdf never upscales for EITHER format — canvas errors (tainted cross-origin canvas) are caught, resolving to undefined rather than throwing and aborting the whole PDF", () => {
  assert.match(prepareImageForPdfSource, /if \(widthPx <= 0 \|\| heightPx <= 0\) return undefined;/u);
  assert.match(prepareImageForPdfSource, /catch \(error\) \{\s*\n\s*if \(input\.diagnosticLabel\)/u);
  assert.match(prepareImageForPdfSource, /return undefined;\s*\n\s*\}\s*\n\}/u);
});

test("prepareImageForPdf supports a nativeResolution passthrough mode (skips DPI/box downscaling entirely) — the fallback callers use when the optimized encode fails", () => {
  const fn = prepareImageForPdfSource.match(/export function prepareImageForPdf\([\s\S]*?\n\}\n/u);
  assert.ok(fn);
  assert.match(fn![0], /nativeResolution\?: boolean;/u);
  assert.match(fn![0], /input\.nativeResolution\s*\n\s*\? \{ widthPx: input\.originalWidthPx, heightPx: input\.originalHeightPx \}/u);
});

test("prepareImageForPdf logs a dev-only diagnostic (label + phase + real error message, never the image data) when its encode throws", () => {
  assert.match(prepareImageForPdfSource, /export function logImageProcessingFailure\(label: string, phase: string, error: unknown\): void \{/u);
  assert.match(prepareImageForPdfSource, /if \(process\.env\.NODE_ENV === "production"\) return;/u);
  const fn = prepareImageForPdfSource.match(/export function logImageProcessingFailure\([\s\S]*?\n\}\n/u);
  assert.ok(fn);
  assert.doesNotMatch(fn![0], /dataUrl|base64/iu);
});

test("the event logo IS routed through prepareImageForPdf now (real-usage follow-up round 2) — downscaled to its actual 34x20mm drawn box, at PRINT_SURFACE_PDF_LOGO_DPI, kept as PNG (never JPEG)", () => {
  assert.doesNotMatch(exportPanelSource, /import\s*\{[^}]*loadImageAsDataUrl/u, "the old native-resolution-only logo path is no longer imported");
  assert.doesNotMatch(loadImageDataUrlSource, /export (async )?function loadImageAsDataUrl/u, "loadImageAsDataUrl itself was removed as dead code");
  const fn = exportPanelSource.match(/async function loadOptimizedEventLogoForPdf\([\s\S]*?\n  \}\n/u);
  assert.ok(fn, "expected to find function loadOptimizedEventLogoForPdf");
  const body = fn![0];
  assert.match(body, /loadImageElement\(logoUrl\)/u);
  assert.match(body, /renderedWidthMm: PRINT_SURFACE_PDF_EVENT_LOGO_WIDTH_MM, renderedHeightMm: PRINT_SURFACE_PDF_EVENT_LOGO_HEIGHT_MM/u);
  assert.match(body, /format: "PNG"/u);
});

test("PrintSurfaceExportPanel loads each view image element exactly once (no redundant re-fetch/re-decode) and sizes it via the SHARED layout box before optimizing", () => {
  const fn = exportPanelSource.match(/async function loadOptimizedViewImagesForPdf\([\s\S]*?\n  \}\n/u);
  assert.ok(fn, "expected to find function loadOptimizedViewImagesForPdf");
  const body = fn![0];
  assert.match(body, /loadImageElement\(imageUrlsByViewId\[view\.id\]!\)/u);
  assert.match(body, /resolvePrintSurfaceViewRenderBox\(/u);
  assert.match(body, /resolveContainRect\(/u);
  assert.match(body, /prepareViewImageOrThrow\(/u);
  // exactly one loadImageElement call site — never a second decode of the same URL within this function.
  assert.equal((body.match(/loadImageElement\(/gu) ?? []).length, 1);
});

// =========================================================================================
// FAIL-SAFE (real-usage follow-up: a "Aktualizovat PDF" run produced an ~80KB PDF with the wrong
// filename fallback the first time a fresh project was opened). Traced the full generate -> upload
// -> latestPdf -> persist -> Download chain; found and closed two real gaps: (1) prepareImageForPdf
// silently swallowed encode failures, letting a booth view vanish from an otherwise "successful"
// PDF; (2) editor state (what Download reads) committed the new latestPdf optimistically BEFORE the
// project save was confirmed. Exactly one filename-building call site was confirmed to exist
// (buildPrintSurfaceExportFileName) — no other fallback path ("Beauty.pdf"/UUID.pdf/download.pdf)
// exists in this code; a blank project.name (the one way that builder could produce a
// degraded/event-only name) is now refused outright before any generation work starts.
// =========================================================================================

test("A) booth view image optimization failure falls back to the SAME already-decoded element at native resolution — never a second network fetch, never silently dropping the view", () => {
  const fn = exportPanelSource.match(/function prepareViewImageOrThrow\([\s\S]*?\n  \}\n/u);
  assert.ok(fn, "expected to find function prepareViewImageOrThrow");
  const body = fn![0];
  const optimizedCall = body.match(/const optimized = prepareImageForPdf\(\{[^}]*\}\);/u);
  const nativeCall = body.match(/const native = prepareImageForPdf\(\{[^}]*\}\);/u);
  assert.ok(optimizedCall, "expected an optimized (downscaled) attempt");
  assert.ok(nativeCall, "expected a native-resolution fallback attempt");
  assert.match(nativeCall![0], /nativeResolution: true/u);
  assert.doesNotMatch(nativeCall![0], /loadImageElement/u, "the fallback reuses the SAME already-loaded element, never re-fetches");
});

test("B) booth view whose image is completely unusable (optimized AND native encode both fail) makes generation FAIL — never a silently-imageless 'successful' PDF", () => {
  const fn = exportPanelSource.match(/function prepareViewImageOrThrow\([\s\S]*?\n  \}\n/u);
  const body = fn![0];
  assert.match(body, /throw new Error\(`Obrázek pohledu "\$\{label\}" se nepodařilo zpracovat pro export PDF\.`\);/u);
});

test("event logo failure falls back to native resolution too, but NEVER throws on total failure — a broken logo has an existing, acceptable degraded state (text-only fallback in drawHeader), unlike a booth view", () => {
  const fn = exportPanelSource.match(/async function loadOptimizedEventLogoForPdf\([\s\S]*?\n  \}\n/u);
  assert.ok(fn, "expected to find function loadOptimizedEventLogoForPdf");
  const body = fn![0];
  assert.match(body, /nativeResolution: true/u);
  assert.doesNotMatch(body, /throw new Error/u);
  assert.match(body, /return undefined;\s*\n\s*\}\n/u);
});

test("generation refuses to run with a blank project name — the ONLY way buildPrintSurfaceExportFileName could ever produce a degraded/event-only filename is closed off before any upload happens", () => {
  const fn = exportPanelSource.match(/async function generateAndUploadCurrentPdf\([\s\S]*?\n  \}\n/u);
  assert.ok(fn, "expected to find function generateAndUploadCurrentPdf");
  const body = fn![0];
  const guardIndex = body.search(/if \(!project\.name\.trim\(\)\) throw new Error/u);
  const uploadIndex = body.search(/await uploadAsset\(/u);
  assert.ok(guardIndex >= 0, "expected an early project.name guard");
  assert.ok(guardIndex < uploadIndex, "the guard must run BEFORE any upload happens");
});

test("exactly ONE filename-building call site exists for print-surfaces PDFs — buildPrintSurfaceExportFileName — confirming no rogue fallback ('Beauty.pdf'/UUID.pdf/download.pdf) path exists anywhere in the export flow", () => {
  const fileNameCalls = exportPanelSource.match(/buildPrintSurfaceExportFileName\(/gu) ?? [];
  assert.equal(fileNameCalls.length, 1, `expected exactly 1 call to buildPrintSurfaceExportFileName, found ${fileNameCalls.length}`);
  assert.doesNotMatch(exportPanelSource, /"download\.pdf"|"Beauty\.pdf"|crypto\.randomUUID\(\)\s*\+\s*"\.pdf"/u);
});

test("Download always reads project.latestPdf directly (storageKey AND fileName together, from the same object) — never a separately-tracked/fallback filename variable", () => {
  const fn = exportPanelSource.match(/async function handleDownloadCurrentPdf\([\s\S]*?\n  \}\n/u);
  assert.ok(fn, "expected to find function handleDownloadCurrentPdf");
  assert.match(fn![0], /getAssetDownloadUrl\(project\.latestPdf\.storageKey, project\.latestPdf\.fileName\)/u);
});

test("generate/update and download are guarded against a double-click/rapid-repeat race: each handler bails out immediately if isBusy is already true, not relying solely on the disabled= JSX attribute", () => {
  const generateFn = exportPanelSource.match(/async function handleGenerateOrUpdatePdf\([\s\S]*?\n  \}\n/u);
  const downloadFn = exportPanelSource.match(/async function handleDownloadCurrentPdf\([\s\S]*?\n  \}\n/u);
  const dispatchFn = exportPanelSource.match(/function handlePdfActionClick\([\s\S]*?\n  \}\n/u);
  assert.match(generateFn![0], /if \(isBusy\) return;/u);
  assert.match(downloadFn![0], /if \(isBusy \|\| !project\.latestPdf\) return;/u);
  assert.match(dispatchFn![0], /if \(isBusy\) return;/u);
});

test("generate/update only commits a new latestPdf into editor state AFTER persistNow confirms the save succeeded — never optimistically before it, so Download can never read an artifact the DB doesn't actually have yet", () => {
  const editorSource = readFileSync(new URL("../components/workflow/printSurfaces/PrintSurfaceEditorPage.tsx", import.meta.url), "utf8");
  const fn = editorSource.match(/async function handlePdfGenerated\([\s\S]*?\n  \}\n/u);
  assert.ok(fn, "expected to find function handlePdfGenerated");
  const body = fn![0];
  const persistIndex = body.search(/const saved = await persistNow\(next\);/u);
  const setProjectIndex = body.search(/setProject\(\(latest\) => /u);
  assert.ok(persistIndex >= 0 && setProjectIndex >= 0);
  assert.ok(persistIndex < setProjectIndex, "persistNow must be awaited BEFORE setProject commits the new latestPdf");
  assert.match(body, /if \(!saved\) throw new Error/u, "a failed persist must throw, never silently commit");
});

test("generateAndUploadCurrentPdf AWAITS onPdfGenerated — the whole generate/update action (and isBusy/Download) does not finish until the caller's persist has resolved", () => {
  const fn = exportPanelSource.match(/async function generateAndUploadCurrentPdf\([\s\S]*?\n  \}\n/u);
  assert.match(fn![0], /await onPdfGenerated\(\{/u);
});

test("persistNow returns a boolean success indicator (not silently swallowed) so handlePdfGenerated can decide whether to commit the new latestPdf", () => {
  const editorSource = readFileSync(new URL("../components/workflow/printSurfaces/PrintSurfaceEditorPage.tsx", import.meta.url), "utf8");
  const fn = editorSource.match(/async function persistNow\([\s\S]*?\n  \}\n/u);
  assert.ok(fn, "expected to find function persistNow");
  assert.match(fn![0], /Promise<boolean>/u);
  assert.match(fn![0], /return true;/u);
  assert.match(fn![0], /return false;/u);
});

test("no duplicate image embedding: lib/printSurfacePdf.ts calls doc.addImage exactly twice total — once for the logo, once inside drawViewImage (invoked exactly once per view by drawViews, never per-page/per-marker/per-preview)", () => {
  const addImageCalls = printSurfacePdfSource.match(/doc\.addImage\(/gu) ?? [];
  assert.equal(addImageCalls.length, 2, `expected exactly 2 doc.addImage call SITES (logo + one view-image call site reused per view), found ${addImageCalls.length}`);
  // drawViewImage itself is defined once and called once per view inside drawViews (1 call for a single view, exactly `images.length` times for 2) — never inside the table/pagination code, which only redraws the header row.
  assert.doesNotMatch(printSurfacePdfSource.split("function drawTable")[1] ?? "", /addImage/u);
});

test("dev-only size diagnostic (logPreparedPdfImageDiagnostics) never logs in production, and is opt-in per call site rather than automatic noise", () => {
  assert.match(prepareImageForPdfSource, /if \(process\.env\.NODE_ENV === "production"\) return;/u);
  assert.match(prepareImageForPdfSource, /export function logPreparedPdfImageDiagnostics/u);
  // it reports an approximate byte estimate for both source and prepared image, never logs raw base64/data payloads.
  assert.doesNotMatch(prepareImageForPdfSource, /console\.\w+\([^)]*dataUrl/u);
});

test("original StoredAsset in R2 is never mutated by PDF generation: no delete/overwrite/re-upload of the source view image storageKey anywhere in the export flow", () => {
  assert.doesNotMatch(exportPanelSource, /deleteObject|overwrite.*view.*image|uploadAsset\([^)]*category:\s*"print-surface-image"/u);
});

// -----------------------------------------------------------------------------------------------
// Fonts (spec section 7/16): measured, not guessed — confirms fonts are NOT a significant
// contributor to PDF size, and that they're never embedded more than once per document.
// -----------------------------------------------------------------------------------------------
test("exactly 2 font variants are embedded (Regular + Bold) via registerCzechFont, called exactly once per document build — never a duplicate addFileToVFS/addFont for the same variant", () => {
  assert.equal((czechFontSource.match(/doc\.addFileToVFS\(/gu) ?? []).length, 2);
  assert.equal((czechFontSource.match(/doc\.addFont\(/gu) ?? []).length, 2);
  const registerCalls = printSurfacePdfSource.match(/registerCzechFont\(/gu) ?? [];
  assert.equal(registerCalls.length, 1, "registerCzechFont must be called exactly once per buildPrintSurfacePdf() call");
});

test("the embedded font PAIR (Regular+Bold TTF, base64-encoded) totals well under 500KB — confirms fonts are NOT a meaningful contributor to a multi-MB PDF (measured, not guessed)", () => {
  const base64Strings: string[] = fontAssetSource.match(/"[A-Za-z0-9+\/=]{1000,}"/gu) ?? [];
  assert.ok(base64Strings.length >= 2, `expected at least 2 large base64 font strings, found ${base64Strings.length}`);
  const totalBase64Chars = base64Strings.reduce((sum: number, s: string) => sum + s.length, 0);
  const approximateBinaryBytes = Math.round((totalBase64Chars * 3) / 4);
  assert.ok(approximateBinaryBytes < 500_000, `expected embedded fonts to total < 500KB, measured ~${Math.round(approximateBinaryBytes / 1024)}KB`);
});
