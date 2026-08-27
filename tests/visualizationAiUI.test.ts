import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// =========================================================================================
// Visualization v3 — UI wiring (report sections 20-24/34). No DOM test runner in this codebase
// (same limitation as v2/v2.1) — source-scan-pin tests, following the established pattern in
// tests/visualizationRenderUI.test.ts.
// =========================================================================================

const panelSource = readFileSync(new URL("../components/workflow/AiVisualizationPanel.tsx", import.meta.url), "utf8");
const workflowSource = readFileSync(new URL("../components/workflow/WorkflowSteps.tsx", import.meta.url), "utf8");

test("GATING: the panel refuses to offer generation when there is no renderable view (no Customer Render exists anywhere) — the legacy/zero-render case", () => {
  assert.match(panelSource, /if \(renderableViews\.length === 0\) \{/u);
  assert.match(panelSource, /Nejprve vyrenderujte alespoň jeden Customer Render/u);
});

test("GATING: renderableViews is filtered from latestCustomerRenders — only views with a customer render are ever offered, never an arbitrary view/viewport", () => {
  assert.match(panelSource, /views\.filter\(\(view\) => latestCustomerRenders\.has\(view\.id\)\)/u);
});

test("GENERATE BUTTON: disabled while a generation is in flight or when no source render is resolved — never a double-submit or a generation with an undefined source", () => {
  assert.match(panelSource, /disabled=\{progress !== null \|\| !sourceRender\}/u);
});

test("4-STATE PROGRESS: exactly preparing/generating/compositing/saving, each with a distinct Czech label", () => {
  assert.match(panelSource, /type AiGenerationProgress = "preparing" \| "generating" \| "compositing" \| "saving";/u);
  assert.match(panelSource, /preparing: "Připravuji kontrolní data…"/u);
  assert.match(panelSource, /generating: "Generuji prostředí…"/u);
  assert.match(panelSource, /compositing: "Skládám finální vizualizaci…"/u);
  assert.match(panelSource, /saving: "Ukládám…"/u);
});

test("PIPELINE ORDER: preparing (control passes) -> generating (server call) -> compositing (browser composite) -> saving (createAiVisualizationRender + onAddVisualization), strictly in that order", () => {
  const preparingIndex = panelSource.indexOf('setProgress("preparing")');
  const passesIndex = panelSource.indexOf("renderControlPassCapture(");
  const generatingIndex = panelSource.indexOf('setProgress("generating")');
  const fetchIndex = panelSource.indexOf('fetch("/api/visualizations/ai-generate"');
  const compositingIndex = panelSource.indexOf('setProgress("compositing")');
  const compositeIndex = panelSource.indexOf("compositeStrictLockInBrowser(");
  const savingIndex = panelSource.indexOf('setProgress("saving")');
  const createIndex = panelSource.indexOf("createAiVisualizationRender(");
  const addIndex = panelSource.indexOf("onAddVisualization(item)");
  assert.ok(preparingIndex < passesIndex);
  assert.ok(passesIndex < generatingIndex);
  assert.ok(generatingIndex < fetchIndex);
  assert.ok(fetchIndex < compositingIndex);
  assert.ok(compositingIndex < compositeIndex);
  assert.ok(compositeIndex < savingIndex);
  assert.ok(savingIndex < createIndex);
  assert.ok(createIndex < addIndex);
});

test("NEVER AUTO-GENERATES: the only call sites of generate(...) are explicit user click handlers (handleGenerateClick / handleRegenerate), never inside a useEffect/render body", () => {
  assert.doesNotMatch(panelSource, /useEffect\(\(\) => \{[\s\S]*?void generate\(/u);
  assert.match(panelSource, /function handleGenerateClick\(\) \{[\s\S]*?void generate\(/u);
  assert.match(panelSource, /function handleRegenerate\([\s\S]*?void generate\(/u);
});

test("FAILURE BEHAVIOR: every failure path sets an error and resets progress to null, never proceeds to createAiVisualizationRender/onAddVisualization on a control-pass, provider, or compositing failure", () => {
  const failureBranches = panelSource.match(/setError\([^)]*\);\s*setProgress\(null\);\s*return;/gu) ?? [];
  assert.ok(failureBranches.length >= 3, "expected at least 3 distinct early-return failure branches (control-pass, provider response, compositing)");
});

test("PRE-SAVE VALIDATION: re-resolves the source render fresh (from latestCustomerRenders) right before saving, never trusting a stale closure — refuses to save if the source vanished mid-flow", () => {
  assert.match(panelSource, /const currentSource = latestCustomerRenders\.get\(view\.id\);/u);
  assert.match(panelSource, /if \(!currentSource\) \{/u);
});

test("MODEL FIELDS: createAiVisualizationRender is called with sourceRenderId, provider, model, resolutionDownscaled, and mode:'strict-lock' settings — never a fabricated provider/model string", () => {
  const createCallSection = panelSource.slice(panelSource.indexOf("const item = createAiVisualizationRender({"), panelSource.indexOf("onAddVisualization(item);"));
  assert.match(createCallSection, /sourceRenderId: source\.id/u);
  assert.match(createCallSection, /provider: generated\.provider/u);
  assert.match(createCallSection, /model: generated\.model/u);
  assert.match(createCallSection, /resolutionDownscaled: generated\.resolutionDownscaled/u);
  assert.match(panelSource, /mode: "strict-lock"/u);
});

test("REGENERATE: reuses the EXISTING AI render's own settings (never the form's currently-selected preset values) and warns when the source is possibly-outdated", () => {
  const regenerateFn = panelSource.slice(panelSource.indexOf("function handleRegenerate"), panelSource.indexOf("const lightboxView"));
  assert.match(regenerateFn, /environmentPreset: render\.environmentPreset \?\? "clean-hall"/u);
  assert.match(regenerateFn, /peoplePreset: render\.peoplePreset \?\? "none"/u);
  assert.match(regenerateFn, /lightingPreset: render\.lightingPreset \?\? "neutral"/u);
  assert.match(regenerateFn, /evaluateRenderStaleness\(source, currentFingerprint\)/u);
  assert.match(regenerateFn, /window\.confirm\(/u);
});

test("REUSES ViewRenderCard/RenderLightbox: no parallel thumbnail/lightbox markup — imported from WorkflowSteps.tsx, never redefined", () => {
  assert.match(panelSource, /import \{ ViewRenderCard, RenderLightbox, type CommonProject \} from "\.\/WorkflowSteps"/u);
  assert.doesNotMatch(panelSource, /function ViewRenderCard/u);
  assert.doesNotMatch(panelSource, /function RenderLightbox/u);
});

test("BEFORE/AFTER: a simple two-button toggle (never a slider/drag component), only shown once both a source render and an existing AI render are resolved", () => {
  assert.match(panelSource, /aiVisualizationBeforeAfterToggle/u);
  assert.doesNotMatch(panelSource, /range|slider/iu);
  assert.match(panelSource, /selectedView && sourceRender && existingAiRender && \(/u);
});

test("WIRED INTO WorkflowSteps: replaces the old dead disabled button, no leftover 'budoucí provider' placeholder", () => {
  assert.doesNotMatch(workflowSource, /budoucí provider/u);
  assert.match(workflowSource, /<AiVisualizationPanel\b/u);
  assert.match(workflowSource, /import \{ AiVisualizationPanel \} from "\.\/AiVisualizationPanel";/u);
});

test("PRESENTATION EXPORT admits AI renders: PresentationExportPanel now uses latestPresentableRendersByView (customer+ai), not the customer-only selector", () => {
  const presentationPanel = workflowSource.slice(workflowSource.indexOf("function PresentationExportPanel"), workflowSource.indexOf("async function createPresentationPdf"));
  assert.match(presentationPanel, /latestPresentableRendersByView\(project\.visualizations\)/u);
  assert.doesNotMatch(presentationPanel, /latestCustomerRendersByView\(project\.visualizations\)/u);
});

test("SELECTORS IMPORTED: WorkflowSteps.tsx imports latestPresentableRendersByView alongside the existing latestCustomerRendersByView (still used by VisualizationStep's own customer-render grid)", () => {
  assert.match(workflowSource, /latestCustomerRendersByView,\s*\n\s*latestPresentableRendersByView,/u);
});

test("EXPORTED FOR REUSE: CommonProject/ViewRenderCard/RenderLightbox are exported from WorkflowSteps.tsx specifically so AiVisualizationPanel.tsx can reuse them without a parallel implementation", () => {
  assert.match(workflowSource, /export type CommonProject = \{/u);
  assert.match(workflowSource, /export function ViewRenderCard\(/u);
  assert.match(workflowSource, /export function RenderLightbox\(/u);
});
