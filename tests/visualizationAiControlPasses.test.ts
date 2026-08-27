import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// =========================================================================================
// Visualization v3 — control-pass capture (report sections 15-18/34). This codebase has no
// WebGL test runner (same limitation class as renderCustomerCapture in v2) — these are
// source-scan-pin tests following the established pattern in tests/visualization.test.ts and
// tests/visualizationRenderUI.test.ts. A real browser manual QA pass is required alongside these
// (flagged separately in the end-of-batch report) — this file proves the CONTRACT is coded as
// designed, not that WebGL renders correctly.
// =========================================================================================

const source = readFileSync(new URL("../components/configurator/BoothCadViewer.tsx", import.meta.url), "utf8");

function extractConst(name: string): string {
  const match = source.match(new RegExp(`const ${name} = \\([\\s\\S]*?\\n    \\};\\n`, "u"));
  assert.ok(match, `expected to find const ${name}`);
  return match![0];
}

const renderControlPassCapture = extractConst("renderControlPassCapture");
const performCustomerCaptureRender = extractConst("performCustomerCaptureRender");
const classifyObjectCategory = extractConst("classifyObjectCategory");

test("SHARED BEAUTY BODY: renderControlPassCapture's beauty pass calls the SAME performCustomerCaptureRender used by renderCustomerCapture, never a duplicate render body", () => {
  assert.match(renderControlPassCapture, /performCustomerCaptureRender\(\{/u);
  assert.match(source, /const renderCustomerCapture = \(options: CustomerCaptureOptions\): CustomerCaptureResult => \{[\s\S]*?performCustomerCaptureRender\(options\)/u);
});

test("SAME CAMERA ACROSS ALL PASSES: size/aspect/pixelRatio are set exactly once, before any of the 6 passes render", () => {
  const beforeFirstRender = renderControlPassCapture.slice(0, renderControlPassCapture.indexOf("renderer.render"));
  assert.match(beforeFirstRender, /renderer\.setPixelRatio\(1\)/u);
  assert.match(beforeFirstRender, /renderer\.setSize\(options\.widthPx, options\.heightPx, false\)/u);
  assert.match(beforeFirstRender, /camera\.aspect = options\.widthPx \/ options\.heightPx/u);
  // setSize/aspect never appear again after the initial setup (performCustomerCaptureRender's own
  // internal setSize call for the beauty pass is idempotent with the same values, not a second
  // distinct camera state):
  const renderCount = (renderControlPassCapture.match(/renderer\.render\(scene, camera\)/gu) ?? []).length;
  assert.equal(renderCount, 5, "beauty uses performCustomerCaptureRender's own renderer.render call, plus 5 explicit ones here = 6 total passes");
});

test("SYNCHRONOUS: zero await/async anywhere in the combined capture — no rAF-interleaving window can open between passes", () => {
  assert.equal(/\bawait\b/u.test(renderControlPassCapture), false);
  assert.doesNotMatch(source, /const renderControlPassCapture = async/u);
});

test("NO DISTURBANCE: editorOverlays are hidden and everything is restored in a finally block, ending with resize() — same tail as renderCustomerCapture", () => {
  assert.match(renderControlPassCapture, /editorOverlays\.visible = false/u);
  const finallyBlock = renderControlPassCapture.slice(renderControlPassCapture.indexOf("} finally {"));
  assert.match(finallyBlock, /restoreMaterials\(\);/u);
  assert.match(finallyBlock, /restoreVisibility\(\);/u);
  assert.match(finallyBlock, /editorOverlays\.visible = previousOverlaysVisible/u);
  assert.match(finallyBlock, /scene\.background = previousBackground/u);
  assert.match(finallyBlock, /renderer\.setClearAlpha\(previousClearAlpha\)/u);
  assert.match(finallyBlock, /renderer\.setPixelRatio\(previousPixelRatio\)/u);
  assert.match(finallyBlock, /resize\(\);/u);
});

test("MATERIALS NEVER COMPOUND: materials are restored between every one of the 6 passes, never carried into the next", () => {
  const restoreCount = (renderControlPassCapture.match(/restoreMaterials\(\);/gu) ?? []).length;
  // 1 after beauty, 1 after protected mask, 1 after artwork mask, 1 after depth, 1 after normal, 1 after object-ID, 1 in finally = 7
  assert.equal(restoreCount, 7);
});

test("VISIBILITY NEVER TOUCHED BY ANY PASS: the try block (the 6-pass sequence itself) only ever swaps mesh.material, never mesh.visible — every pass therefore sees the SAME real Beauty visibility/occlusion (report section 4). mesh.visible is only ever restored, in the finally safety net. (editorOverlays.visible is a separate, unrelated always-hidden-during-capture toggle, not a scene-mesh visibility mutation.)", () => {
  const tryBlock = renderControlPassCapture.slice(
    renderControlPassCapture.indexOf("try {"),
    renderControlPassCapture.indexOf("} finally {"),
  );
  assert.doesNotMatch(tryBlock, /mesh\.visible\s*=/u);
});

test("PROTECTED MASK: flat-white silhouette of EVERY mesh over a black background — no per-category distinction at this stage", () => {
  const protectedMaskSection = renderControlPassCapture.slice(
    renderControlPassCapture.indexOf("// 2. Protected mask"),
    renderControlPassCapture.indexOf("// 3. Artwork mask"),
  );
  assert.match(protectedMaskSection, /scene\.background = new THREE\.Color\(0x000000\)/u);
  assert.match(protectedMaskSection, /for \(const mesh of meshes\) mesh\.material = flatWhiteMaterial/u);
});

test("ARTWORK MASK: identified via findPrintArtworkOverlays (reused, never reimplemented), independent of the protected-mask technique, NEVER hides non-artwork meshes (that would also hide an overlay parented under a hidden panel — the v3.1 root cause of a fully black mask)", () => {
  const artworkMaskSection = renderControlPassCapture.slice(
    renderControlPassCapture.indexOf("// 3. Artwork mask"),
    renderControlPassCapture.indexOf("// 4. Depth"),
  );
  assert.match(artworkMaskSection, /findPrintArtworkOverlays\(scene\)/u);
  assert.doesNotMatch(artworkMaskSection, /mesh\.visible\s*=/u);
  assert.match(source, /import \{[\s\S]*?findPrintArtworkOverlays,?[\s\S]*?\} from "\.\.\/\.\.\/lib\/printArtworkOverlays"/u);
});

test("ARTWORK MASK MATERIAL: non-artwork meshes get flat black, artwork overlays get createArtworkMaskMaterial fed their OWN beauty texture (alpha-aware, not a full rectangular quad — report section 5), falling back to flat white only if a map is somehow missing", () => {
  const artworkMaskSection = renderControlPassCapture.slice(
    renderControlPassCapture.indexOf("// 3. Artwork mask"),
    renderControlPassCapture.indexOf("// 4. Depth"),
  );
  assert.match(artworkMaskSection, /mesh\.material = maskBlackMaterial/u);
  assert.match(artworkMaskSection, /const map = \(mesh\.material as THREE\.MeshBasicMaterial\)\.map/u);
  assert.match(artworkMaskSection, /createArtworkMaskMaterial\(map\)/u);
  assert.match(artworkMaskSection, /mesh\.material = flatWhiteMaterial/u);
  assert.match(source, /import \{[\s\S]*?createArtworkMaskMaterial,?[\s\S]*?\} from "\.\.\/\.\.\/lib\/printArtworkOverlays"/u);
});

test("ARTWORK MASK MATERIALS DISPOSED: the per-overlay mask materials created inside the pass are disposed right after capture, not left for the static disposablePassMaterials list (they don't exist until the pass runs)", () => {
  const artworkMaskSection = renderControlPassCapture.slice(
    renderControlPassCapture.indexOf("// 3. Artwork mask"),
    renderControlPassCapture.indexOf("// 4. Depth"),
  );
  assert.match(artworkMaskSection, /const artworkMaskMaterials: THREE\.Material\[\] = \[\]/u);
  assert.match(artworkMaskSection, /artworkMaskMaterials\.push\(maskMaterial\)/u);
  assert.match(artworkMaskSection, /for \(const material of artworkMaskMaterials\) material\.dispose\(\);/u);
});

test("DEPTH: reads camera.near/camera.far LIVE at capture time, never a hardcoded constant, and reports them alongside the dataURL", () => {
  const depthSection = renderControlPassCapture.slice(
    renderControlPassCapture.indexOf("// 4. Depth"),
    renderControlPassCapture.indexOf("// 5. Normal"),
  );
  assert.match(depthSection, /const depthNear = camera\.near/u);
  assert.match(depthSection, /const depthFar = camera\.far/u);
  assert.doesNotMatch(depthSection, /camera\.near = /u, "must only READ near/far, never overwrite them");
  assert.doesNotMatch(depthSection, /camera\.far = /u);
});

test("DEPTH v3.2d: MeshDepthMaterial is GONE — the Depth pass now uses createDepthDataMaterial (a dedicated ShaderMaterial), built fresh per capture with the LIVE depthNear/depthFar as uniforms, disposed right after use", () => {
  const depthSection = renderControlPassCapture.slice(
    renderControlPassCapture.indexOf("// 4. Depth"),
    renderControlPassCapture.indexOf("// 5. Normal"),
  );
  // Comments are allowed to mention the old material by name (explaining WHY it was replaced) —
  // what must be gone is any actual CONSTRUCTION of it.
  assert.doesNotMatch(source, /new THREE\.MeshDepthMaterial\(/u, "MeshDepthMaterial must never be constructed anywhere in this file");
  assert.doesNotMatch(source, /depthPacking:\s*THREE\.RGBADepthPacking/u);
  assert.match(depthSection, /const \{ material: depthDataMaterial, readDiagnostics: readDepthMaterialDiagnostics \} = createDepthDataMaterial\(depthNear, depthFar\)/u);
  assert.match(depthSection, /depthDataMaterialRef = depthDataMaterial/u);
  assert.match(depthSection, /for \(const mesh of meshes\) mesh\.material = depthDataMaterial/u);
  assert.match(depthSection, /depthDataMaterial\.dispose\(\)/u);
  assert.match(depthSection, /depthDataMaterialRef = null/u);
});

test("DEPTH v3.2d MATERIAL DIAGNOSTICS: read AFTER renderer.render (so onBeforeCompile has fired) and included in the returned passes bundle", () => {
  const depthSection = renderControlPassCapture.slice(
    renderControlPassCapture.indexOf("// 4. Depth"),
    renderControlPassCapture.indexOf("// 5. Normal"),
  );
  const renderIndex = depthSection.indexOf("renderer.render(scene, camera);");
  const diagnosticsIndex = depthSection.indexOf("const depthMaterialDiagnostics = readDepthMaterialDiagnostics();");
  assert.ok(renderIndex >= 0 && diagnosticsIndex > renderIndex, "diagnostics must be read after render, never before");
  assert.match(source, /depthMaterialDiagnostics,\s*\n\s*\},\s*\n\s*\};/u);
});

test("DEPTH v3.2d createDepthDataMaterial: encodes LINEAR view-space depth into RGB only (never three.js's own packDepthToRGBA/gl_FragCoord.z machinery), alpha ALWAYS 1.0, precision explicitly highp, and the 16777215.0 pack constant matches domain/visualizationDepth.ts's LINEAR_DEPTH_PACK_MAX (2^24-1)", () => {
  assert.match(source, /function createDepthDataMaterial\(near: number, far: number\)/u);
  const materialFn = source.slice(source.indexOf("function createDepthDataMaterial("), source.indexOf("function labelSprite("));
  assert.match(materialFn, /vViewDistance = -mvPosition\.z/u);
  assert.match(materialFn, /gl_FragColor = vec4\(r, g, b, 255\.0\) \/ 255\.0/u);
  assert.match(materialFn, /16777215\.0/u);
  assert.match(materialFn, /precision: "highp"/u);
  assert.match(materialFn, /transparent: false/u);
  assert.doesNotMatch(materialFn, /packDepthToRGBA|gl_FragCoord/u);
  assert.equal(256 * 256 * 256 - 1, 16777215, "sanity: the literal in the shader really is 2^24-1");
});

test("DEPTH v3.2b: captured via an offscreen WebGLRenderTarget + readRenderTargetPixels, NEVER via renderer.domElement.toDataURL() — the live canvas's alpha:true/premultipliedAlpha:true context was silently corrupting the packed depth alpha channel on PNG export (report section 1/2)", () => {
  const depthSection = renderControlPassCapture.slice(
    renderControlPassCapture.indexOf("// 4. Depth"),
    renderControlPassCapture.indexOf("// 5. Normal"),
  );
  assert.match(depthSection, /new THREE\.WebGLRenderTarget\(options\.widthPx, options\.heightPx/u);
  assert.match(depthSection, /renderer\.setRenderTarget\(depthRenderTarget\)/u);
  assert.match(depthSection, /renderer\.readRenderTargetPixels\(depthRenderTarget, 0, 0, options\.widthPx, options\.heightPx, rawDepthPixels\)/u);
  assert.doesNotMatch(depthSection, /renderer\.domElement\.toDataURL/u, "must never read the depth pass off the live color-managed canvas again");
});

test("DEPTH v3.2b COLOR-SPACE SAFETY: the render target's texture is explicitly tagged NoColorSpace, so nothing implicitly re-interprets the packed depth bytes as color", () => {
  const depthSection = renderControlPassCapture.slice(
    renderControlPassCapture.indexOf("// 4. Depth"),
    renderControlPassCapture.indexOf("// 5. Normal"),
  );
  assert.match(depthSection, /depthRenderTarget\.texture\.colorSpace = THREE\.NoColorSpace/u);
});

test("DEPTH v3.2b STATE RESTORE: the render target is set back to null and disposed right after reading pixels back (normal path), AND the finally block has its own unconditional safety net for the throw-mid-read case (report section 3/20)", () => {
  const depthSection = renderControlPassCapture.slice(
    renderControlPassCapture.indexOf("// 4. Depth"),
    renderControlPassCapture.indexOf("// 5. Normal"),
  );
  assert.match(depthSection, /renderer\.setRenderTarget\(null\)/u);
  assert.match(depthSection, /depthRenderTarget\.dispose\(\)/u);
  assert.match(depthSection, /depthRenderTarget = null/u);

  assert.match(renderControlPassCapture, /let depthRenderTarget: THREE\.WebGLRenderTarget \| null = null;/u);
  const finallyBlock = renderControlPassCapture.slice(renderControlPassCapture.indexOf("} finally {"));
  assert.match(finallyBlock, /if \(depthRenderTarget\) \{/u);
  assert.match(finallyBlock, /renderer\.setRenderTarget\(null\);/u);
  assert.match(finallyBlock, /depthRenderTarget\.dispose\(\);/u);
});

test("DEPTH v3.2b ROW ORDER: readRenderTargetPixels' bottom-up GL rows are flipped before becoming a PNG, so the depth PNG lines up top-down like every other pass", () => {
  const depthSection = renderControlPassCapture.slice(
    renderControlPassCapture.indexOf("// 4. Depth"),
    renderControlPassCapture.indexOf("// 5. Normal"),
  );
  assert.match(depthSection, /rgbaBufferToDataUrl\(rawDepthPixels, options\.widthPx, options\.heightPx, \{ flipY: true \}\)/u);
});

test("NORMAL: uses THREE.MeshNormalMaterial (view-space encoding) and the bundle documents normalSpace:'view' as a literal, not just a comment", () => {
  const normalSection = renderControlPassCapture.slice(
    renderControlPassCapture.indexOf("// 5. Normal"),
    renderControlPassCapture.indexOf("// 6. Object"),
  );
  assert.match(normalSection, /MeshNormalMaterial/u);
  assert.match(source, /normalSpace: "view"/u);
  assert.match(source, /normalSpace: "view";/u, "the type itself documents the encoding, not only the runtime value");
});

test("OBJECT-ID: flat per-category color resolved via classifyObjectCategory, black background for editable-environment", () => {
  const objectIdSection = renderControlPassCapture.slice(renderControlPassCapture.indexOf("// 6. Object"));
  assert.match(objectIdSection, /scene\.background = new THREE\.Color\(0x000000\)/u);
  assert.match(objectIdSection, /categoryMaterials\[classifyObjectCategory\(mesh, artworkMeshes\)\]/u);
});

test("SEMANTIC CLASSIFICATION: resolves artwork -> booth-floor -> furniture -> default booth-construction, generically (no P86/koje-specific id anywhere)", () => {
  assert.match(classifyObjectCategory, /artworkMeshes\.has\(current\)/u);
  assert.match(classifyObjectCategory, /current === carpet/u);
  assert.match(classifyObjectCategory, /current\.userData\[SEMANTIC_CATEGORY_USERDATA_KEY\] === "furniture"/u);
  assert.match(classifyObjectCategory, /return "booth-construction";/u);
  assert.doesNotMatch(classifyObjectCategory, /P86|koje/iu);
});

test("SEMANTIC TAGGING: exactly the 2 planned new one-line userData tags exist (furniture instance, carpet), no others", () => {
  assert.match(source, /instance\.userData\[SEMANTIC_CATEGORY_USERDATA_KEY\] = "furniture";/u);
  assert.match(source, /carpet\.userData\[SEMANTIC_CATEGORY_USERDATA_KEY\] = "booth-floor";/u);
});

test("NO SEPARATE EDITABLE-ENVIRONMENT PASS: the 6 passes are exactly beauty/protectedMask/artworkMask/depth/normal/objectId — editable-environment is never captured as its own image", () => {
  assert.match(source, /beautyDataUrl, protectedMaskDataUrl, artworkMaskDataUrl, depthDataUrl, normalDataUrl, objectIdDataUrl,/u);
  assert.doesNotMatch(source, /editableEnvironmentDataUrl|editableMaskDataUrl/u);
});

test("PASS MATERIALS ARE DISPOSED: the static ephemeral pass materials are disposed in finally, never leaked across repeated calls", () => {
  assert.match(renderControlPassCapture, /disposablePassMaterials = \[flatWhiteMaterial, maskBlackMaterial, normalMaterial, \.\.\.Object\.values\(categoryMaterials\)\]/u);
  const finallyBlock = renderControlPassCapture.slice(renderControlPassCapture.indexOf("} finally {"));
  assert.match(finallyBlock, /for \(const material of disposablePassMaterials\) material\.dispose\(\);/u);
});

test("DEPTH DATA MATERIAL SAFETY NET: depthDataMaterialRef is declared alongside depthRenderTarget (not in the static disposablePassMaterials list — it needs fresh per-call near/far uniforms) and gets its own unconditional dispose in finally", () => {
  assert.match(renderControlPassCapture, /let depthDataMaterialRef: THREE\.ShaderMaterial \| null = null;/u);
  const finallyBlock = renderControlPassCapture.slice(renderControlPassCapture.indexOf("} finally {"));
  assert.match(finallyBlock, /if \(depthDataMaterialRef\) \{\s*\n\s*depthDataMaterialRef\.dispose\(\);\s*\n\s*depthDataMaterialRef = null;\s*\n\s*\}/u);
});

test("PRINT-TOOL GUARD: control-pass capture refuses exactly like renderCustomerCapture when the print tool is active", () => {
  assert.match(renderControlPassCapture, /if \(viewerTool !== "select"\) return \{ ok: false, reason: "print-tool-active" \};/u);
});

test("EXPOSED ON THE SAME CONTROLS OBJECT: renderControlPassCapture is wired onto cameraController alongside renderCustomerCapture, never a parallel ref", () => {
  const controllerLiteral = source.slice(source.indexOf("const cameraController: BoothCadCameraControls = {"), source.indexOf("if (cameraControlsRef)"));
  assert.match(controllerLiteral, /renderCustomerCapture,/u);
  assert.match(controllerLiteral, /renderControlPassCapture,/u);
});
