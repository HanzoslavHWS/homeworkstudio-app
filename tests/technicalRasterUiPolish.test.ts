import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolveTechnicalServicePresentation, TECHNICAL_RASTER_COLORS } from "../domain/technicalRasterServicePresentation.ts";

// =========================================================================================
// UI/CSS POLISH BATCH — Technical Rasters. No React Testing Library/jsdom in this project (same
// constraint as tests/technicalRasterWorkspaceLayout.test.ts) — these are source-scan/CSS-guard
// regression tests pinning the exact structural facts this batch changed: DOM order, the same
// click handlers under new classnames, and the centralized color a CSS-only fix now reads from.
// =========================================================================================

async function readEditorSource(): Promise<string> {
  return readFile(new URL("../components/workflow/technicalRasters/TechnicalRasterEditorPage.tsx", import.meta.url), "utf8");
}
async function readStandDetailSource(): Promise<string> {
  return readFile(new URL("../components/workflow/technicalRasters/TechnicalStandDetailPanel.tsx", import.meta.url), "utf8");
}
async function readPlacementContextSource(): Promise<string> {
  return readFile(new URL("../components/workflow/technicalRasters/TechnicalRasterPlacementContextPanel.tsx", import.meta.url), "utf8");
}
async function readSymbolLayerPanelSource(): Promise<string> {
  return readFile(new URL("../components/workflow/technicalRasters/TechnicalRasterSymbolLayerPanel.tsx", import.meta.url), "utf8");
}
async function readGlobalsCss(): Promise<string> {
  return readFile(new URL("../app/globals.css", import.meta.url), "utf8");
}

function servicesStepBlock(editorSource: string): string {
  const match = editorSource.match(/step === "services" && \(([\s\S]*?)\n {6}\)\)?\}/u);
  assert.ok(match, "expected to find the services step JSX block");
  return match![1]!;
}

// =========================================================================================
// section 1 — Technical Services page order: upload -> conditional preview -> history -> catalog.
// =========================================================================================

test("SECTION ORDER: Technické služby step renders upload -> conditional import preview -> history -> control/catalog, in that exact order", async () => {
  const block = servicesStepBlock(await readEditorSource());
  const uploadIndex = block.indexOf("<TechnicalServiceImportPanel");
  const previewIndex = block.indexOf("pendingImport && (() => {");
  const historyIndex = block.indexOf("HISTORIE IMPORTŮ");
  const catalogIndex = block.indexOf("<TechnicalCatalogImportPanel");
  assert.ok(uploadIndex >= 0, "expected the primary upload panel");
  assert.ok(previewIndex >= 0, "expected the conditional import preview block");
  assert.ok(historyIndex >= 0, "expected the import history card");
  assert.ok(catalogIndex >= 0, "expected the supplemental catalog card");
  assert.ok(uploadIndex < previewIndex, "upload must render before the conditional preview");
  assert.ok(previewIndex < historyIndex, "the conditional preview must render immediately below upload, before history");
  assert.ok(historyIndex < catalogIndex, "the supplemental catalog card must be LAST — after history, never interrupting the primary import workflow");
});

test("SECTION ORDER: the primary import workflow (upload + conditional preview + history) stays contiguous — the catalog card never sits between them", async () => {
  const block = servicesStepBlock(await readEditorSource());
  const catalogIndex = block.indexOf("<TechnicalCatalogImportPanel");
  const historyIndex = block.indexOf("HISTORIE IMPORTŮ");
  const previewIndex = block.indexOf("pendingImport && (() => {");
  assert.ok(catalogIndex > historyIndex && catalogIndex > previewIndex, "the catalog card must come after both the preview and history — never inserted in between");
});

// =========================================================================================
// section 2 — segmented workflow navigation: same steps/logic, new visual language.
// =========================================================================================

test("NAVIGATION: the same 4 steps (raster/services/assignment/outputs) still drive setStep via the STEPS table, unchanged logic", async () => {
  const source = await readEditorSource();
  assert.match(source, /type TechnicalRasterStep = "raster" \| "services" \| "assignment" \| "outputs";/u);
  assert.match(source, /\{ id: "raster", label: "Rastr" \}/u);
  assert.match(source, /\{ id: "services", label: "Technické služby" \}/u);
  assert.match(source, /\{ id: "assignment", label: "Přiřazení" \}/u);
  assert.match(source, /\{ id: "outputs", label: "Výstupy" \}/u);
  assert.match(source, /onClick=\{\(\) => setStep\(entry\.id\)\}/u);
  assert.match(source, /className=\{step === entry\.id \? "technicalRasterStepTab active" : "technicalRasterStepTab"\}/u);
});

test("NAVIGATION CSS: .technicalRasterStepTabs is a rounded segmented-control container, not a bare underlined row", async () => {
  const css = await readGlobalsCss();
  const tabsRule = css.match(/\.technicalRasterStepTabs\s*\{[^}]*\}/u);
  assert.ok(tabsRule, "expected a .technicalRasterStepTabs rule");
  assert.match(tabsRule![0], /border-radius:\s*\d/u, "the outer track must have real rounded geometry");
  assert.match(tabsRule![0], /background:/u, "the outer track needs its own background to read as a segmented control, not a plain nav row");
});

test("NAVIGATION CSS: the active tab is distinguished by more than a thin underline (background/shadow/weight), and has hover + focus-visible states", async () => {
  const css = await readGlobalsCss();
  const activeRule = css.match(/\.technicalRasterStepTab\.active\s*\{[^}]*\}/u);
  assert.ok(activeRule, "expected a .technicalRasterStepTab.active rule");
  assert.match(activeRule![0], /background:/u, "active tab must use a real background, not rely on border-bottom alone");
  assert.doesNotMatch(activeRule![0], /^\s*\{\s*border-bottom/u);
  assert.match(css, /\.technicalRasterStepTab:hover\s*\{/u, "expected an explicit hover state");
  assert.match(css, /\.technicalRasterStepTab:focus-visible\s*\{/u, "expected an explicit focus-visible state");
});

test("NAVIGATION CSS: no bright yellow active-state color is introduced — the active tab uses a plain white/neutral background", async () => {
  const css = await readGlobalsCss();
  const tabsBlock = css.slice(css.indexOf(".technicalRasterStepTabs"), css.indexOf(".technicalRasterWorkspace {"));
  assert.ok(!/yellow|#ff[a-e]\d|#ffd700|#ffeb3b|#ffc107/iu.test(tabsBlock), "the segmented nav must stay in the app's neutral white/gray/black language");
  const activeRule = css.match(/\.technicalRasterStepTab\.active\s*\{[^}]*\}/u)![0];
  assert.match(activeRule, /background:\s*#fff\b/u, "the active tab's own background must be plain white, never a colored/yellow accent");
});

// =========================================================================================
// section 3 — stand detail header hierarchy: content stays present, company name is now prominent.
// =========================================================================================

test("STAND DETAIL: STÁNEK label, stand number, company name, and pairing-status badge are all still rendered, grouped in one identity block", async () => {
  const source = await readStandDetailSource();
  assert.match(source, /<div className="technicalStandIdentity">/u);
  assert.match(source, /<span>STÁNEK<\/span>/u);
  assert.match(source, /<strong>\{stand\.standNumber\}<\/strong>/u);
  assert.match(source, /stand\.companyName && <p className="technicalStandCompanyName">\{stand\.companyName\}<\/p>/u);
  assert.match(source, /stageBadge technicalStandPlacementBadge \$\{stand\.placement\.status\}/u);
});

test("STAND DETAIL CSS: the company name is styled clearly larger/bolder than the old 7px .fieldHint treatment, and wraps instead of clipping long names", async () => {
  const css = await readGlobalsCss();
  const rule = css.match(/\.technicalStandCompanyName\s*\{[^}]*\}/u);
  assert.ok(rule, "expected a .technicalStandCompanyName rule");
  const fontSizeMatch = rule![0].match(/font-size:\s*([\d.]+)px/u);
  assert.ok(fontSizeMatch, "expected an explicit font-size");
  assert.ok(Number(fontSizeMatch![1]) >= 13, "company name must be clearly larger than the 7px fieldHint it replaces");
  assert.match(rule![0], /font-weight:\s*7\d\d/u, "company name must read as prominent/bold");
  assert.match(rule![0], /overflow-wrap:\s*anywhere/u, "a long exhibitor name must wrap safely, never destroy the layout");
  assert.doesNotMatch(rule![0], /text-overflow:\s*ellipsis/u, "must not truncate the company name");
});

test("STAND DETAIL: the pairing-status badge still reuses the SAME stageBadge/technicalStandPlacementBadge classes and status color semantics — no change to matching logic or its visual meaning", async () => {
  const css = await readGlobalsCss();
  assert.match(css, /\.technicalStandPlacementBadge\.matched_auto, \.technicalStandPlacementBadge\.matched_manual \{ background: #edf5ef; color: #45634f; \}/u);
  assert.match(css, /\.technicalStandPlacementBadge\.ambiguous \{ background: #fbeeea; color: #93472b; \}/u);
  assert.match(css, /\.technicalStandPlacementBadge\.unassigned \{ background: #f0f1f2; color: #6b6f72; \}/u);
});

// =========================================================================================
// section 4 — operational actions look like buttons, same handlers.
// =========================================================================================

test("ACTIONS: Umístit / Umístit další bod / Umístit chybějící postupně use the primary action-button style, wired to the SAME onPlaceService/onPlaceMissingSequentially handlers", async () => {
  const source = await readStandDetailSource();
  assert.match(source, /className="technicalActionButton primary compact" disabled=\{placementModeActive\} onClick=\{\(\) => onPlaceMissingSequentially\(stand\.id\)\}/u);
  assert.match(source, /className="technicalActionButton primary compact" disabled=\{placementModeActive\} onClick=\{\(\) => onPlaceService\(stand\.id, service\.id\)\}/u);
});

test("ACTIONS: Spárovat kliknutím do rastru is a clear primary action button, wired to the SAME onAssign handler", async () => {
  const source = await readStandDetailSource();
  assert.match(source, /className="technicalActionButton primary" onClick=\{\(\) => onAssign\(stand\.id\)\}>Spárovat kliknutím do rastru</u);
});

test("ACTIONS: Zrušit spárování and Odstranit umístění use the destructive-secondary treatment, wired to the SAME onClearAssignment/onRemovePlacement handlers — never the primary pairing action's own style", async () => {
  const source = await readStandDetailSource();
  assert.match(source, /className="technicalActionButton destructive" onClick=\{\(\) => onClearAssignment\(stand\.id\)\}>Zrušit spárování</u);
  assert.match(source, /className="technicalActionButton destructive compact" disabled=\{placementModeActive\} onClick=\{\(\) => onRemovePlacement\(stand\.id, service\.id, placement\.id\)\}>Odstranit umístění</u);
});

test("ACTIONS: Přemístit uses the neutral secondary treatment, wired to the SAME onMovePlacement handler", async () => {
  const source = await readStandDetailSource();
  assert.match(source, /className="technicalActionButton secondary compact" disabled=\{placementModeActive\} onClick=\{\(\) => onMovePlacement\(stand\.id, service\.id, placement\.id\)\}>Přemístit</u);
});

test("ACTIONS: the PRÁVĚ UMISŤUJI banner's Zrušit (cancel) also reads as a real button, wired to the SAME onCancel handler", async () => {
  const source = await readPlacementContextSource();
  assert.match(source, /className="technicalActionButton secondary compact" onClick=\{onCancel\}>Zrušit</u);
});

test("ACTIONS CSS: .technicalActionButton has real hover/focus-visible/disabled states for every variant used", async () => {
  const css = await readGlobalsCss();
  assert.match(css, /\.technicalActionButton:focus-visible\s*\{/u);
  assert.match(css, /\.technicalActionButton:disabled\s*\{/u);
  assert.match(css, /\.technicalActionButton\.primary:hover:not\(:disabled\)\s*\{/u);
  assert.match(css, /\.technicalActionButton\.secondary:hover:not\(:disabled\)\s*\{/u);
  assert.match(css, /\.technicalActionButton\.destructive:hover:not\(:disabled\)\s*\{/u);
});

// =========================================================================================
// section 6 — category colors: Cleaning must resolve to the SAME purple as the real ÚKL marker;
// Waste stays gray (deliberately, per spec — no new color invented for it in this batch).
// =========================================================================================

test("CATEGORY COLOR: the filter's cleaning swatch now resolves through the SAME centralized TECHNICAL_RASTER_COLORS.cleaning (purple) the real ÚKL marker already uses — never the neutral fallback gray", () => {
  const cleaningColor = resolveTechnicalServicePresentation("cleaning", "Denní úklid").color;
  assert.equal(cleaningColor, TECHNICAL_RASTER_COLORS.cleaning);
  assert.notEqual(cleaningColor, TECHNICAL_RASTER_COLORS.fallback, "cleaning must no longer read as the neutral unresolved-fallback gray");
});

test("CATEGORY COLOR: the filter panel's own sample-label map now includes cleaning, using the real 'Denní úklid' label (never an invented one)", async () => {
  const source = await readSymbolLayerPanelSource();
  const mapMatch = source.match(/const sampleLabelByCategory: Record<string, string> = \{([^}]*)\};/u);
  assert.ok(mapMatch, "expected the sampleLabelByCategory map");
  assert.match(mapMatch![1]!, /cleaning:\s*"Denní úklid"/u);
});

test("CATEGORY COLOR: waste is deliberately NOT added to the sample-label map yet — it still resolves through the same neutral fallback gray as before (no new color invented for it in this batch)", async () => {
  const source = await readSymbolLayerPanelSource();
  const mapMatch = source.match(/const sampleLabelByCategory: Record<string, string> = \{([^}]*)\};/u);
  assert.ok(mapMatch);
  assert.doesNotMatch(mapMatch![1]!, /waste:/u);
  const wasteColor = resolveTechnicalServicePresentation("waste", "Kontejn 1100 l").color;
  assert.notEqual(wasteColor, TECHNICAL_RASTER_COLORS.cleaning, "waste must never accidentally inherit cleaning's purple");
});

// =========================================================================================
// section 8 — no regression to the already-fixed project-table delete-visibility CSS.
// =========================================================================================

test("REGRESSION GUARD: the technical-raster project table's own delete-visibility CSS (grid-template-columns override + overflow-x safety net) is untouched by this UI polish batch", async () => {
  const css = await readGlobalsCss();
  assert.match(css, /\.technicalRasterProjectTable \.printSurfaceProjectRow\s*\{[^}]*grid-template-columns:/u);
  assert.match(css, /\.technicalRasterProjectTable\s*\{\s*overflow-x:\s*auto;\s*\}/u);
});
