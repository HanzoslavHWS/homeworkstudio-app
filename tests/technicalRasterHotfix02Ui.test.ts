import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// =========================================================================================
// HOTFIX-02 — editor wiring that has no pure-domain seam (same source-level discipline as
// tests/technicalRasterWorkspaceLayout.test.ts): the collapsible "Nespárované položky" list, the
// manual-drawing toolbar (shape, categories, note + "Zobrazit poznámku v rastru a PDF"), the canvas
// drawing a visible note next to its mark, and the export's text-mode fallback toggle.
// =========================================================================================

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("NESPÁROVANÉ: collapsed by default, count always visible as 'Nespárované položky (N)', opened list scrolls inside its own capped height", async () => {
  const buffer = await read("components/workflow/technicalRasters/TechnicalStandBuffer.tsx");
  const group = buffer.slice(buffer.indexOf(`title="NESPÁROVANÉ"`) - 40, buffer.indexOf(`title="NESPÁROVANÉ"`) + 400);
  assert.match(group, /summaryText=\{\(count\) => `Nespárované položky \(\$\{count\}\)`\}/u);
  assert.match(group, /collapsedByDefault/u);
  assert.match(buffer, /<details className=\{`\$\{groupClassName\} collapsible`\}>/u, "native <details>: click opens, click again closes");
  assert.match(buffer, /<span className="technicalStandBufferChevron" aria-hidden="true">▼<\/span>/u);
  assert.match(buffer, /<div className="technicalStandBufferScroll">\{list\}<\/div>/u, "every stand is still rendered — only inside a scroll area");
  const css = await read("app/globals.css");
  const scroll = css.match(/\.technicalStandBufferScroll \{[^}]*\}/u)?.[0] ?? "";
  assert.match(scroll, /max-height:\s*\d+px/u);
  assert.match(scroll, /overflow-y:\s*auto/u);
  assert.match(css, /\.technicalStandBufferGroup\.collapsible\[open\] > summary \.technicalStandBufferChevron \{[^}]*rotate\(180deg\)/u);
});

test("RUČNÍ ZNAČKY toolbar: dot/cross shapes, the six technical categories, a note with the 'Zobrazit poznámku v rastru a PDF' switch (off by default)", async () => {
  const toolbar = await read("components/workflow/technicalRasters/TechnicalRasterDrawingToolbar.tsx");
  assert.match(toolbar, /DRAWING_POINT_STYLES\.map/u, "point shape picker");
  assert.match(toolbar, /DRAWING_CATEGORIES\.map/u, "categories from the shared technical palette");
  assert.ok(!/DRAWING_COLORS/u.test(toolbar), "the old unrelated palette is gone");
  assert.match(toolbar, /<span>Zobrazit poznámku v rastru a PDF<\/span>/u);
  assert.match(toolbar, /const visible = drawing\.note\?\.visible \?\? false;/u, "default: internal note (off)");
  assert.match(toolbar, /onBlur=\{\(\) => commit\(visible\)\}/u, "saved on blur, never trimmed mid-typing");
});

test("canvas: a note is drawn ONLY when visible, positioned from its own mark (so it moves with it, also while dragging)", async () => {
  const canvas = await read("components/workflow/technicalRasters/TechnicalRasterCanvas.tsx");
  assert.match(canvas, /const noteText = visibleDrawingNoteText\(drawing\);/u);
  assert.match(canvas, /const drawing = dragOffset && dragOffset\.id === original\.id \? moveManualDrawing\(original, dragOffset\.dx, dragOffset\.dy\) : original;/u, "the note is computed from the (dragged) mark");
  assert.match(canvas, /\{noteText && \(\s*<text x=\{cx \+ extent \+ px\(DRAWING_NOTE_GAP_SCREEN_PX\)\}/u, "next to a point");
  assert.match(canvas, /fill=\{color\}/u, "category color");
});

test("editor: the marker tooltip carries the original ABRA name; the drawing toolbar gets the selected drawing's detail and saves notes into the project", async () => {
  const editor = await read("components/workflow/technicalRasters/TechnicalRasterEditorPage.tsx");
  assert.match(editor, /tooltip: `\$\{stand\.standNumber\} · \$\{service\.externalLabel\} · \$\{presentation\.legendLabel\}`/u);
  assert.match(editor, /withManualDrawingNote\(current, drawingId, note\)/u);
  // The selected mark's detail/note sits in the RIGHT sidebar: a toolbar growing above the canvas on
  // selection shifted the canvas mid-drag (found in the browser test).
  const sidebar = editor.slice(editor.indexOf(`<div className="technicalRasterSidebar">`));
  assert.match(sidebar, /\{selectedDrawing && <TechnicalRasterDrawingDetailPanel drawing=\{selectedDrawing\} onNoteChange=\{handleDrawingNoteChange\} \/>\}/u);
  const toolbar = await read("components/workflow/technicalRasters/TechnicalRasterDrawingToolbar.tsx");
  const toolbarComponent = toolbar.slice(toolbar.indexOf("export function TechnicalRasterDrawingToolbar("), toolbar.indexOf("export function TechnicalRasterDrawingDetailPanel("));
  assert.ok(!/DrawingNoteEditor/u.test(toolbarComponent), "no note editor inside the toolbar above the canvas");
  assert.match(editor, /createPointDrawing\(page, x, y, \{ category: drawingCategory, size: drawingSize, pointStyle: drawingPointStyle \}\)/u);
});

test("export panel: real text by default, 'Texty jako křivky (záložní režim)' as the explicit per-export fallback; manual drawings feed the legend", async () => {
  const outputs = await read("components/workflow/technicalRasters/TechnicalRasterOutputsPanel.tsx");
  assert.match(outputs, /const \[textsAsOutlines, setTextsAsOutlines\] = useState\(false\);/u);
  assert.match(outputs, /textMode: textsAsOutlines \? "outlines" : "text",/u);
  assert.match(outputs, /Texty jako křivky \(záložní režim\)/u);
  assert.match(outputs, /buildTechnicalRasterExportLegend\(pages\.flatMap\(\(pageInput\) => pageInput\.placements\), pages\.flatMap\(\(pageInput\) => pageInput\.manualDrawings\)\)/u);
});
