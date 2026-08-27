import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// =========================================================================================
// Visualization v3.1 — Control Pass Debug Viewer wiring for manual QA. No DOM test runner in
// this codebase (same limitation as the rest of Visualization v2/v2.1/v3) — source-scan-pin
// tests, following the established pattern in tests/visualizationRenderUI.test.ts and
// tests/visualizationAiUI.test.ts.
// =========================================================================================

const viewerSource = readFileSync(new URL("../components/configurator/ControlPassDebugViewer.tsx", import.meta.url), "utf8");
const workflowSource = readFileSync(new URL("../components/workflow/WorkflowSteps.tsx", import.meta.url), "utf8");

test("DEVELOPMENT-ONLY: the NODE_ENV production gate lives inside the component itself, not at the call site", () => {
  assert.match(viewerSource, /if \(process\.env\.NODE_ENV === "production"\) return null;/u);
  // The call site in WorkflowSteps.tsx passes no conditional guard around it — the gate is the
  // component's own responsibility, so a stray future import elsewhere stays safe too.
  const mountSite = workflowSource.slice(workflowSource.indexOf("<ControlPassDebugViewer"), workflowSource.indexOf("<ControlPassDebugViewer") + 260);
  assert.doesNotMatch(mountSite, /NODE_ENV/u);
});

test("USES THE EXISTING CAPTURE FUNCTION: calls cameraControlsRef.current?.renderControlPassCapture(...) — never a re-implementation of the 6-pass logic", () => {
  assert.match(viewerSource, /cameraControlsRef\.current\?\.renderControlPassCapture\(\{ widthPx, heightPx, backgroundMode \}\)/u);
});

test("DEPTH DEBUG PREVIEW: built via the existing pure/browser depth-unpack helper, never a re-implementation of the unpack math here, and never mutates or replaces passes.depthDataUrl (the raw pass stays available for any future provider)", () => {
  assert.match(viewerSource, /import \{ buildDepthDebugPreviewDataUrl \} from "\.\.\/\.\.\/lib\/visualizationDepthDebug\.browser"/u);
  assert.match(viewerSource, /await buildDepthDebugPreviewDataUrl\(\{\s*\n\s*depthDataUrl: result\.passes\.depthDataUrl,\s*\n\s*near: result\.passes\.depthNear,\s*\n\s*far: result\.passes\.depthFar,\s*\n\s*protectedMaskDataUrl: result\.passes\.protectedMaskDataUrl,\s*\n\s*\}\)/u);
  assert.doesNotMatch(viewerSource, /unpackRGBAToDepth|linearizeDepth|packDepthToRGBA/u, "unpack/linearize math must live only in domain/visualizationDepth.ts, never reimplemented in the viewer");
});

test("v3.2c COVERAGE MASK: the SAME-capture Protected Mask is fed to the depth-preview helper as an independent foreground/coverage signal, never a guess derived from the depth bytes themselves", () => {
  assert.match(viewerSource, /protectedMaskDataUrl: result\.passes\.protectedMaskDataUrl/u);
});

test("DEPTH TILE SHOWS THE HUMAN-READABLE PREVIEW, RAW STAYS THE FALLBACK/DOCUMENTED SOURCE: the depth tile's dataUrl prefers depthPreviewDataUrl over the raw passes.depthDataUrl, and its note documents the raw packing/near/far", () => {
  assert.match(viewerSource, /dataUrl: depthPreviewDataUrl \?\? passes\.depthDataUrl,/u);
  assert.match(viewerSource, /note: `raw: RGBA packed · near \$\{passes\.depthNear\.toFixed\(3\)\} · far \$\{passes\.depthFar\.toFixed\(3\)\}`/u);
});

test("DEPTH DEV DIAGNOSTICS (v3.2b report section 7): the depth tile shows foreground pixel count, min/max linear depth, and unique-gray-value count from the SAME stats the pure algorithm computed — never a separate re-derivation in the viewer", () => {
  assert.match(viewerSource, /import type \{ DepthDebugStats, ProtectedMaskDepthCorrelation, RawDepthByteDiagnostics \} from "\.\.\/\.\.\/domain\/visualizationDepth"/u);
  assert.match(viewerSource, /const \[depthStats, setDepthStats\] = useState<DepthDebugStats \| null>\(null\)/u);
  assert.match(viewerSource, /setDepthStats\(preview\.ok === true \? preview\.stats : null\)/u);
  assert.match(viewerSource, /depthStats\.foregroundPixelCount/u);
  assert.match(viewerSource, /depthStats\.minLinearDepth/u);
  assert.match(viewerSource, /depthStats\.maxLinearDepth/u);
  assert.match(viewerSource, /depthStats\.uniqueGrayValueCount/u);
});

test("v3.2c RAW BYTE DIAGNOSTICS (pre-unpack): the depth tile also surfaces diagnoseRawDepthBytes' output — total pixels, RGBA-all-zero count, RGB-zero/alpha-nonzero count, unique alpha count, alpha min/max, and the first non-zero samples — computed from the SAME lib helper, never re-derived in the viewer", () => {
  assert.match(viewerSource, /const \[depthRawDiagnostics, setDepthRawDiagnostics\] = useState<RawDepthByteDiagnostics \| null>\(null\)/u);
  assert.match(viewerSource, /setDepthRawDiagnostics\(preview\.ok === true \? preview\.rawDiagnostics : null\)/u);
  assert.match(viewerSource, /depthRawDiagnostics\.totalPixelCount/u);
  assert.match(viewerSource, /depthRawDiagnostics\.rgbaAllZeroCount/u);
  assert.match(viewerSource, /depthRawDiagnostics\.rgbZeroAlphaNonzeroCount/u);
  assert.match(viewerSource, /depthRawDiagnostics\.uniqueAlphaCount/u);
  assert.match(viewerSource, /depthRawDiagnostics\.alphaMin/u);
  assert.match(viewerSource, /depthRawDiagnostics\.alphaMax/u);
  assert.match(viewerSource, /depthRawDiagnostics\.firstNonZeroSamples/u);
});

test("v3.2d DEPTH MATERIAL RUNTIME DIAGNOSTICS: passes.depthMaterialDiagnostics (report section 2) is displayed verbatim — type/transparent/blending/colorWrite/depthWrite/depthTest/precision, plus the compiled fragment shader source — never re-derived in the viewer", () => {
  assert.match(viewerSource, /passes\.depthMaterialDiagnostics\.type/u);
  assert.match(viewerSource, /passes\.depthMaterialDiagnostics\.transparent/u);
  assert.match(viewerSource, /passes\.depthMaterialDiagnostics\.blending/u);
  assert.match(viewerSource, /passes\.depthMaterialDiagnostics\.colorWrite/u);
  assert.match(viewerSource, /passes\.depthMaterialDiagnostics\.depthWrite/u);
  assert.match(viewerSource, /passes\.depthMaterialDiagnostics\.depthTest/u);
  assert.match(viewerSource, /passes\.depthMaterialDiagnostics\.precision/u);
  assert.match(viewerSource, /passes\.depthMaterialDiagnostics\.compiledFragmentShader/u);
});

test("v3.2d PROTECTED MASK ↔ RAW DEPTH CORRELATION (report section 6): the SAME preview.protectedMaskCorrelation from the browser helper is stored and displayed, never re-derived in the viewer", () => {
  assert.match(viewerSource, /const \[depthCorrelation, setDepthCorrelation\] = useState<ProtectedMaskDepthCorrelation \| null>\(null\)/u);
  assert.match(viewerSource, /setDepthCorrelation\(preview\.ok === true \? preview\.protectedMaskCorrelation : null\)/u);
  assert.match(viewerSource, /\{depthCorrelation && /u);
});

test("v3.2d KNOWN-DISTANCE SANITY TEST (report section 7): a dedicated button calls cameraControlsRef.current?.runDepthSanityCheck() (the existing BoothCadViewer.tsx method, never a re-implementation here) and shows ok/monotonic status plus the raw samples", () => {
  assert.match(viewerSource, /function handleRunDepthSanityCheck\(\)/u);
  assert.match(viewerSource, /cameraControlsRef\.current\?\.runDepthSanityCheck\(\)/u);
  assert.match(viewerSource, /onClick=\{handleRunDepthSanityCheck\}/u);
  assert.match(viewerSource, /depthSanityResult\.monotonic/u);
});

test("NO SECOND CAPTURE IMPLEMENTATION: the file never defines its own renderer/scene/camera/material-swap logic — no THREE import, no WebGLRenderer, no MeshBasicMaterial/MeshDepthMaterial/MeshNormalMaterial", () => {
  assert.doesNotMatch(viewerSource, /from "three"/u);
  assert.doesNotMatch(viewerSource, /WebGLRenderer|MeshBasicMaterial|MeshDepthMaterial|MeshNormalMaterial|renderer\.render\(/u);
});

test("NEVER MOVES THE CAMERA: the generate handler never calls applyView (or any camera/target/zoom mutation) — it captures the CURRENT live camera as-is", () => {
  const generateFn = viewerSource
    .slice(viewerSource.indexOf("function handleGenerate()"), viewerSource.indexOf("return (\n    <details"))
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(generateFn, /\.applyView\(|camera\.position|controls\.target|\.zoomBy\(|\.zoomIn\(|\.zoomOut\(/u);
});

test("ALL SIX PASSES: the tile list covers beauty/protectedMask/artworkMask/depth/normal/objectId, and nothing else", () => {
  assert.match(viewerSource, /beautyDataUrl/u);
  assert.match(viewerSource, /protectedMaskDataUrl/u);
  assert.match(viewerSource, /artworkMaskDataUrl/u);
  assert.match(viewerSource, /depthDataUrl/u);
  assert.match(viewerSource, /normalDataUrl/u);
  assert.match(viewerSource, /objectIdDataUrl/u);
  // 5 tiles are the single-line `slug: "...", label: "...", dataUrl: passes.` shape; the depth
  // tile is the one deliberate exception (multi-line, dataUrl sourced from the debug preview
  // with a raw-passes fallback, plus a `note` field) — asserted by name below instead.
  const simpleTileCount = (viewerSource.match(/slug: "[a-z-]+", label: "[^"]+", dataUrl: passes\./gu) ?? []).length;
  assert.equal(simpleTileCount, 5);
  assert.match(viewerSource, /slug: "depth",\s*\n\s*label: "Depth \(vizualizace\)",/u);
  const tileSlugCount = (viewerSource.match(/slug: "[a-z-]+",/gu) ?? []).length;
  assert.equal(tileSlugCount, 6);
});

test("THUMBNAILS: each tile preserves aspect ratio (object-fit: contain via CSS) and opens a lightbox on click", () => {
  assert.match(viewerSource, /className="controlPassDebugThumb" onClick=\{\(\) => setLightboxSlug\(tile\.slug\)\}/u);
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.controlPassDebugThumb img \{[^}]*object-fit: contain/u);
});

test("DOWNLOAD: every tile and the lightbox offer a PNG download via the existing downloadDataUrl helper, never a new download mechanism", () => {
  assert.match(viewerSource, /import \{ downloadDataUrl \} from "\.\.\/\.\.\/lib\/planExport"/u);
  const downloadCallCount = (viewerSource.match(/downloadDataUrl\(/gu) ?? []).length;
  assert.equal(downloadCallCount, 2, "one per-tile download call + one lightbox download call");
});

test("OBJECT-ID LEGEND: derived directly from PROTECTED_CATEGORIES/SEMANTIC_CATEGORY_COLORS/EDITABLE_ENVIRONMENT_COLOR — no invented colors, no hardcoded category list", () => {
  assert.match(viewerSource, /import \{ PROTECTED_CATEGORIES, SEMANTIC_CATEGORY_COLORS, EDITABLE_ENVIRONMENT_COLOR \} from "\.\.\/\.\.\/domain\/visualizationSemantics"/u);
  assert.match(viewerSource, /PROTECTED_CATEGORIES\.map\(\(category\) => /u);
  assert.match(viewerSource, /backgroundColor: rgbCss\(SEMANTIC_CATEGORY_COLORS\[category\]\)/u);
  assert.match(viewerSource, /backgroundColor: rgbCss\(EDITABLE_ENVIRONMENT_COLOR\)/u);
  assert.doesNotMatch(viewerSource, /#[0-9a-fA-F]{6}.*booth-construction|rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\).*artwork/u, "colors must come from the imported constants, never a hand-written literal next to a category label");
});

test("COLLAPSIBLE SECTION: rendered as a <details>/<summary> with the exact label 'Debug AI renderu ▾', same disclosure pattern as the existing '⋯' menus", () => {
  assert.match(viewerSource, /<details className="controlPassDebugSection">/u);
  assert.match(viewerSource, /<summary>Debug AI renderu ▾<\/summary>/u);
});

test("WIRED INTO WorkflowSteps: mounted unconditionally (gating is the component's own job), fed the camera ref and the same capture options the customer render already uses", () => {
  assert.match(workflowSource, /import \{ ControlPassDebugViewer \} from "\.\.\/configurator\/ControlPassDebugViewer";/u);
  assert.match(workflowSource, /<ControlPassDebugViewer\s*\n\s*cameraControlsRef=\{visualizationCameraControlsRef\}\s*\n\s*widthPx=\{captureOptions\.widthPx\}\s*\n\s*heightPx=\{captureOptions\.heightPx\}\s*\n\s*backgroundMode=\{captureOptions\.backgroundMode\}\s*\n\s*\/>/u);
});

test("NO PIPELINE CHANGES: BoothCadViewer.tsx's renderControlPassCapture/performCustomerCaptureRender are untouched by this batch (still exactly one combined synchronous 6-pass function, still sharing the same beauty body)", () => {
  const boothCadSource = readFileSync(new URL("../components/configurator/BoothCadViewer.tsx", import.meta.url), "utf8");
  const renderCount = (boothCadSource.match(/const renderControlPassCapture = \(options: ControlPassCaptureOptions\)/gu) ?? []).length;
  assert.equal(renderCount, 1, "still exactly one capture implementation in BoothCadViewer.tsx");
});
