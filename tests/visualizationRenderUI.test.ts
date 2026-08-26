import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// =========================================================================================
// Visualization v2.1 — compact render UI + thumbnail lightbox. This is a UI-only cleanup
// (no render/capture/persistence logic changes), and this codebase has no DOM/component test
// runner — same source-contract regression pattern already used in tests/visualization.test.ts
// for WebGL-dependent behavior that can't run under node:test.
// =========================================================================================

const workflowSource = readFileSync(new URL("../components/workflow/WorkflowSteps.tsx", import.meta.url), "utf8");

function extractFunction(name: string): string {
  const match = workflowSource.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}\\n`, "u"));
  assert.ok(match, `expected to find function ${name}`);
  return match![0];
}

const viewRenderCard = extractFunction("ViewRenderCard");
const renderLightbox = extractFunction("RenderLightbox");
const visualizationStep = workflowSource.slice(
  workflowSource.indexOf("export function VisualizationStep"),
  workflowSource.indexOf("\nfunction ViewRenderCard"),
);

test("THUMBNAIL: only rendered when a render exists — an empty view gets a 'Bez náhledu' placeholder, never a broken/empty <img>", () => {
  assert.match(viewRenderCard, /render \? \(/u);
  assert.match(viewRenderCard, /visualizationRenderCardThumb--empty/u);
  assert.match(viewRenderCard, /Bez náhledu/u);
  assert.match(viewRenderCard, /<img src=\{render\.imageDataUrl\}/u);
});

test("THUMBNAIL CLICK: the thumbnail is a button that calls onOpenThumbnail, wired to open the lightbox for that view", () => {
  assert.match(viewRenderCard, /className="visualizationRenderCardThumb" onClick=\{onOpenThumbnail\}/u);
  assert.match(visualizationStep, /onOpenThumbnail=\{\(\) => setLightboxViewId\(view\.id\)\}/u);
});

test("LIGHTBOX: renders only when both a view AND its render are resolved, using the SAME latestRenders lookup the cards use", () => {
  assert.match(visualizationStep, /lightboxView && lightboxRender && \(/u);
  assert.match(visualizationStep, /const lightboxView = lightboxViewId \? views\.find/u);
  assert.match(visualizationStep, /const lightboxRender = lightboxView \? latestRenders\.get\(lightboxView\.id\) : undefined;/u);
});

test("LIGHTBOX CLOSE: a labeled close button calls onClose", () => {
  assert.match(renderLightbox, /className="visualizationLightboxClose" aria-label="Zavřít náhled" onClick=\{onClose\}/u);
});

test("LIGHTBOX ESCAPE: an Escape keydown listener calls onClose, registered/cleaned up via useEffect", () => {
  assert.match(renderLightbox, /useEffect\(\(\) => \{/u);
  assert.match(renderLightbox, /event\.key === "Escape"\) onClose\(\)/u);
  assert.match(renderLightbox, /window\.addEventListener\("keydown", handleKeyDown\)/u);
  assert.match(renderLightbox, /return \(\) => window\.removeEventListener\("keydown", handleKeyDown\)/u);
});

test("LIGHTBOX OVERLAY VS CONTENT: clicking the overlay closes it, but clicking the card content does not (stopPropagation)", () => {
  assert.match(renderLightbox, /className="visualizationLightboxOverlay" role="dialog" aria-modal="true"[^>]*onClick=\{onClose\}/u);
  assert.match(renderLightbox, /className="visualizationLightboxCard" onClick=\{\(event\) => event\.stopPropagation\(\)\}/u);
});

test("DOWNLOAD: individual download stays available on every rendered card and inside the lightbox, using the human-readable filename builder", () => {
  assert.match(viewRenderCard, /<button type="button" onClick=\{onDownload\}>Stáhnout<\/button>/u);
  assert.match(visualizationStep, /onDownload=\{\(\) => downloadDataUrl\(lightboxRender\.imageDataUrl, renderFileName\(lightboxView, lightboxRender\)\)\}/u);
  assert.match(visualizationStep, /function downloadSingleRender\(view: VisualizationView\) \{/u);
});

test("RENDER BUTTON: a view with no render yet shows a primary 'Vyrenderovat' action", () => {
  assert.match(viewRenderCard, /<button type="button" onClick=\{onRender\} disabled=\{renderBlocked\}>Vyrenderovat<\/button>/u);
});

test("LATEST RENDER: VisualizationStep resolves each card's render via latestCustomerRendersByView, never a stale/first render", () => {
  assert.match(visualizationStep, /const latestRenders = useMemo\(\(\) => latestCustomerRendersByView\(project\.visualizations\), \[project\.visualizations\]\);/u);
  assert.match(visualizationStep, /const render = latestRenders\.get\(view\.id\);/u);
});

test("STALE STATUS: current/possibly-outdated is shown as a small badge under the view name, never a large standalone section", () => {
  assert.match(viewRenderCard, /visualizationStatusBadge--stale/u);
  assert.match(viewRenderCard, /visualizationStatusBadge--current/u);
  assert.match(viewRenderCard, /Může být zastaralý/u);
  assert.match(viewRenderCard, /Aktuální/u);
});

test("NO STANDALONE LARGE PREVIEW: nothing renders a full-size render image directly in the page flow outside the thumbnail button and the lightbox", () => {
  // The only two places an <img src={render/...imageDataUrl}> may appear are inside
  // ViewRenderCard's thumbnail button and RenderLightbox — never a third, unconstrained,
  // always-visible preview block sitting directly under the 3D viewer.
  const imgTagCount = (workflowSource.match(/<img src=\{(render|lightboxRender)\.imageDataUrl\}/gu) ?? []).length;
  assert.equal(imgTagCount, 2, "expected exactly the card-thumbnail <img> and the lightbox <img>, no third standalone preview");
});

test("RENDER DATA UNTOUCHED: the customer-render creation/persistence call path is unchanged by this UI batch (createCustomerVisualizationRender + onAddVisualization)", () => {
  assert.match(visualizationStep, /function renderCustomerItem\(view: VisualizationView\): VisualizationItem \| undefined \{/u);
  assert.match(visualizationStep, /visualizationCameraControlsRef\.current\?\.renderCustomerCapture\(captureOptions\)/u);
  assert.match(visualizationStep, /return createCustomerVisualizationRender\(\{/u);
  assert.match(visualizationStep, /function renderSingleView\(view: VisualizationView\) \{\s*const item = renderCustomerItem\(view\);\s*if \(item\) onAddVisualization\(item\);/u);
});

test("RENDER SETTINGS: resolution/format/background selects remain present in a compact bar", () => {
  assert.match(visualizationStep, /className="renderOptionsBar"/u);
  assert.match(visualizationStep, /value=\{resolutionPreset\} onChange=\{\(event\) => setResolutionPreset/u);
  assert.match(visualizationStep, /value=\{renderFormat\} onChange=\{\(event\) => \{ const format = event\.target\.value as CustomerRenderFormat;/u);
  assert.match(visualizationStep, /value=\{backgroundMode\} onChange=\{\(event\) => setBackgroundMode/u);
});

test("RENDER ALL: 'Vyrenderovat všechny' stays available near the view grid", () => {
  assert.match(visualizationStep, /onClick=\{\(\) => void renderAllViews\(\)\}/u);
  assert.match(visualizationStep, /Vyrenderovat všechny/u);
});

test("PRESENTATION / BULK DOWNLOAD: PresentationExportPanel (PDF + ZIP) stays wired into the Visualization step", () => {
  assert.match(visualizationStep, /<PresentationExportPanel project=\{project\} views=\{views\} \/>/u);
  const presentationPanel = workflowSource.slice(
    workflowSource.indexOf("function PresentationExportPanel"),
    workflowSource.indexOf("export function SummaryStep"),
  );
  assert.match(presentationPanel, /onClick=\{\(\) => void createPresentationPdf\(\)\}/u);
  assert.match(presentationPanel, /onClick=\{\(\) => void downloadAllRenders\(\)\}/u);
});

test("VIEWER FIRST: the 3D viewer mounts before the render-options/card grid section in the returned JSX, matching the target information hierarchy", () => {
  const viewerIndex = visualizationStep.indexOf("<BoothCadViewer");
  const cardsIndex = visualizationStep.indexOf("visualizationCardGrid");
  assert.ok(viewerIndex > -1 && cardsIndex > -1);
  assert.ok(viewerIndex < cardsIndex, "BoothCadViewer must appear before the card grid in source order");
});

test("EXISTING ACTIONS PRESERVED: open/rename/reorder/delete/re-render/select-for-export all still exist, now inside the compact ⋯ menu", () => {
  assert.match(viewRenderCard, /className="visualizationCardMenu"/u);
  assert.match(viewRenderCard, /onClick=\{onOpenCamera\}>Otevřít</u);
  assert.match(viewRenderCard, />Přerenderovat</u);
  assert.match(viewRenderCard, /onClick=\{onRename\}>Přejmenovat</u);
  assert.match(viewRenderCard, /disabled=\{!canMoveUp\} onClick=\{onMoveUp\}/u);
  assert.match(viewRenderCard, /disabled=\{!canMoveDown\} onClick=\{onMoveDown\}/u);
  assert.match(viewRenderCard, /checked=\{selected\} onChange=\{onToggleSelected\}/u);
  assert.match(viewRenderCard, /onClick=\{onDelete\}>Smazat</u);
});
