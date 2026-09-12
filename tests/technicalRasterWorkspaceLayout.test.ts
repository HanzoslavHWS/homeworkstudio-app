import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const editorSource = readFileSync(new URL("../components/workflow/technicalRasters/TechnicalRasterEditorPage.tsx", import.meta.url), "utf8");
const standBufferSource = readFileSync(new URL("../components/workflow/technicalRasters/TechnicalStandBuffer.tsx", import.meta.url), "utf8");
const canvasSource = readFileSync(new URL("../components/workflow/technicalRasters/TechnicalRasterCanvas.tsx", import.meta.url), "utf8");
const globalsCss = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

// =========================================================================================
// Manual acceptance batch — there is no React Testing Library/jsdom in this project (see
// tests/individualEditorVisibility.test.ts's own convention). These are source-scan regression
// guards against the exact real-browser layout problems reported: TECHNICKÉ ZNAČKY dominating the
// right sidebar, the right panel's priority order, "ZÁSOBNÍK" branding, and 100% not matching Fit.
// =========================================================================================

test("WORKSPACE LAYOUT (section 2-4): TECHNICKÉ ZNAČKY renders ABOVE .technicalRasterWorkspace (a horizontal bar), never inside .technicalRasterSidebar", () => {
  const assignmentStepMatch = editorSource.match(/step === "assignment" && \(([\s\S]*?)\n {6}\)\)?\}/u);
  assert.ok(assignmentStepMatch, "expected to find the assignment step JSX block");
  const block = assignmentStepMatch![1]!;
  const symbolPanelIndex = block.indexOf("<TechnicalRasterSymbolLayerPanel");
  const workspaceDivIndex = block.indexOf('className="technicalRasterWorkspace"');
  const sidebarDivIndex = block.indexOf('className="technicalRasterSidebar"');
  assert.ok(symbolPanelIndex >= 0, "TechnicalRasterSymbolLayerPanel must still be rendered in the assignment step");
  assert.ok(symbolPanelIndex < workspaceDivIndex, "TECHNICKÉ ZNAČKY must render BEFORE (above) the workspace grid, not inside it");
  assert.ok(symbolPanelIndex < sidebarDivIndex, "TECHNICKÉ ZNAČKY must never be inside the right sidebar anymore");
});

test("WORKSPACE LAYOUT (section 5): the right panel's priority order is PRÁVĚ UMISŤUJI -> vybraný stánek (detail) -> K umístění/Hotovo (buffer) — TechnicalRasterPlacementContextPanel before TechnicalStandDetailPanel before TechnicalStandBuffer", () => {
  const sidebarMatch = editorSource.match(/className="technicalRasterSidebar">([\s\S]*?)\n {12}<\/div>/u);
  assert.ok(sidebarMatch, "expected to find the .technicalRasterSidebar JSX block");
  const block = sidebarMatch![1]!;
  const contextIndex = block.indexOf("<TechnicalRasterPlacementContextPanel");
  const detailIndex = block.indexOf("<TechnicalStandDetailPanel");
  const bufferIndex = block.indexOf("<TechnicalStandBuffer");
  assert.ok(contextIndex >= 0 && detailIndex >= 0 && bufferIndex >= 0, "expected all three components in the sidebar block");
  assert.ok(contextIndex < detailIndex, "PRÁVĚ UMISŤUJI context panel must render before the stand detail panel");
  assert.ok(detailIndex < bufferIndex, "the selected stand's own detail panel must render before the K umístění/Hotovo work queue");
});

test("ZOOM (section 14-17): the canvas toolbar's \"100 %\" button is wired to viewport.fitToBooth (full-page view), never the shared hook's generic viewport.resetZoom (literal 1:1)", () => {
  assert.match(canvasSource, /onReset=\{viewport\.fitToBooth\}/u);
  assert.doesNotMatch(canvasSource, /onReset=\{viewport\.resetZoom\}/u);
});

test("PLACEMENT CONTEXT (section 6): the context panel's mode is threaded from placementMode, and a \"move\" passes its own placementId — never fabricated", () => {
  assert.match(editorSource, /mode=\{placementMode\.mode\}/u);
  assert.match(editorSource, /placementId=\{placementMode\.mode === "move" \? placementMode\.placementId : undefined\}/u);
});

test("WORK QUEUE (section 9): TechnicalStandBuffer no longer renders a \"ZÁSOBNÍK\" header/title", () => {
  assert.doesNotMatch(standBufferSource, />ZÁSOBNÍK</u);
});

test("WORK QUEUE (section 5): group render order is K UMÍSTĚNÍ -> HOTOVO -> BEZ BODOVÝCH SLUŽEB -> PROBLÉMOVÉ -> NESPÁROVANÉ (placement work ahead of stand pairing)", () => {
  const order = ["K UMÍSTĚNÍ", "HOTOVO", "BEZ BODOVÝCH SLUŽEB", "PROBLÉMOVÉ", "NESPÁROVANÉ"];
  const indices = order.map((title) => standBufferSource.indexOf(`title="${title}"`));
  indices.forEach((index, i) => assert.ok(index >= 0, `expected to find group "${order[i]}"`));
  for (let i = 1; i < indices.length; i += 1) {
    assert.ok(indices[i - 1]! < indices[i]!, `"${order[i - 1]}" must render before "${order[i]}"`);
  }
});

test("CSS: .technicalRasterSymbolLayerPanel's own layer list is a horizontal, wrapping flex row (a compact bar) — never the vertical grid TechnicalRasterLayerPanel.tsx's OWN (different, untouched) layer list still uses", () => {
  const scopedRule = globalsCss.match(/\.technicalRasterSymbolLayerPanel \.technicalRasterLayerList \{[^}]*\}/u);
  assert.ok(scopedRule, "expected a .technicalRasterSymbolLayerPanel-scoped override of .technicalRasterLayerList");
  assert.match(scopedRule![0], /display:\s*flex/u);
  assert.match(scopedRule![0], /flex-wrap:\s*wrap/u);

  // The OTHER (real PDF layers) panel's shared base rule must still be the original vertical grid.
  const baseRule = globalsCss.match(/(?<!\.technicalRasterSymbolLayerPanel )\.technicalRasterLayerList \{[^}]*\}/u);
  assert.ok(baseRule, "expected the base .technicalRasterLayerList rule to still exist, unscoped");
  assert.match(baseRule![0], /display:\s*grid/u);
});
