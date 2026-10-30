"use client";

import { useEffect, useRef, useState } from "react";
import {
  DRAWING_CATEGORIES,
  DRAWING_POINT_STYLES,
  DRAWING_SIZES,
  MAX_DRAWING_NOTE_LENGTH,
  drawingCategoryOf,
  type DrawingCategory,
  type DrawingPointStyle,
  type DrawingSize,
  type TechnicalRasterDrawing,
  type TechnicalRasterDrawingTool,
} from "../../../domain/technicalRasterDrawings";

const TOOLS: readonly Readonly<{ id: Exclude<TechnicalRasterDrawingTool, "off">; label: string }>[] = [
  { id: "select", label: "Vybrat" },
  { id: "point", label: "Bod" },
  { id: "line", label: "Čára" },
  { id: "text", label: "Text" },
];

/** What the next click does — shown as text so the active tool is never ambiguous (not color alone). */
function describeTool(tool: TechnicalRasterDrawingTool, hasLineDraft: boolean, hasSelection: boolean): string {
  switch (tool) {
    case "off": return "Kreslení je vypnuté — rastr slouží ke službám.";
    case "select": return hasSelection ? "Vybráno: tažením přesunete (i s poznámkou), Delete / Smazat odstraní, kategorie, tvar a tloušťka se změní." : "Klikněte na ruční značku pro výběr.";
    case "point": return "Bod: klikněte do rastru — detail nové značky se otevře vpravo, můžete pokračovat dalším bodem.";
    case "line": return hasLineDraft ? "Čára: klikněte na bod B (Esc zruší rozkreslenou čáru)." : "Čára: klikněte na bod A.";
    case "text": return "Text: klikněte do rastru — text napíšete vpravo v detailu.";
  }
}

/**
 * The selected drawing's note. Typed into a local draft and saved on blur/Enter (saving on every
 * keystroke would trim the space the user is about to type between words). `key` = drawing id, so
 * selecting another drawing starts from that drawing's own note.
 */
/** Focuses the field right after a mark was placed — without scrolling the page; the canvas never moves. */
function useFocusOnMount(focus: boolean) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focus) ref.current?.focus({ preventScroll: true });
  }, [focus]);
  return ref;
}

function DrawingNoteEditor({ drawing, onNoteChange, focusOnMount }: { drawing: TechnicalRasterDrawing; onNoteChange: (note: Readonly<{ text: string; visible: boolean }>) => void; focusOnMount: boolean }) {
  const inputRef = useFocusOnMount(focusOnMount);
  const [draft, setDraft] = useState(drawing.note?.text ?? "");
  const visible = drawing.note?.visible ?? false;
  const commit = (nextVisible: boolean) => {
    if (draft.trim() === (drawing.note?.text ?? "") && nextVisible === visible) return;
    onNoteChange({ text: draft, visible: nextVisible });
  };
  return (
    <div className="technicalRasterDrawingNote">
      <label className="technicalRasterDrawingNoteField">
        <span>Poznámka</span>
        <input
          ref={inputRef}
          type="text"
          value={draft}
          maxLength={MAX_DRAWING_NOTE_LENGTH}
          placeholder="např. Přívod elektřiny ze stropu"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => commit(visible)}
          onKeyDown={(event) => { if (event.key === "Enter") commit(visible); }}
        />
      </label>
      <label className="technicalRasterDrawingNoteToggle">
        <input type="checkbox" checked={visible} disabled={!draft.trim()} onChange={(event) => commit(event.target.checked)} />
        <span>Zobrazit poznámku v rastru a PDF</span>
      </label>
      <span className="fieldHint">{visible ? "Poznámka je u značky v editoru a vyexportuje se do PDF jako upravitelný text." : "Interní poznámka — zůstává jen v projektu, do rastru ani PDF se nevykreslí."}</span>
    </div>
  );
}

/** The text of a "Text" object — same draft/commit-on-blur behavior as the note; an empty text is not saved. */
function DrawingTextEditor({ drawing, onTextChange, focusOnMount }: { drawing: Extract<TechnicalRasterDrawing, { type: "text" }>; onTextChange: (text: string) => void; focusOnMount: boolean }) {
  const inputRef = useFocusOnMount(focusOnMount);
  const [draft, setDraft] = useState(drawing.text);
  const commit = () => { if (draft.trim() && draft.trim() !== drawing.text) onTextChange(draft); };
  return (
    <label className="technicalRasterDrawingNoteField">
      <span>Text</span>
      <input
        ref={inputRef}
        type="text"
        value={draft}
        maxLength={MAX_DRAWING_NOTE_LENGTH}
        onFocus={(event) => { if (focusOnMount) event.target.select(); }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === "Enter") commit(); }}
      />
      <span className="fieldHint">Exportuje se do PDF jako upravitelný text ve vrstvě „ABF – TECHNICKÉ ZNAČKY“. Barvu a velikost změníte v liště Ruční značky.</span>
    </label>
  );
}

/**
 * RUČNÍ ZNAČKY — manual point/line/text tools. Clicking the active tool again switches drawing off (back to
 * normal service work). Picking a category, shape or thickness also restyles the selected drawing.
 * Colors are the technical service categories (Elektřina red, Internet gold, …) — never a separate palette.
 */
export function TechnicalRasterDrawingToolbar({
  tool,
  onToolChange,
  category,
  onCategoryChange,
  pointStyle,
  onPointStyleChange,
  size,
  onSizeChange,
  selectedDrawing,
  hasLineDraft,
  onDeleteSelected,
  onCancelLineDraft,
}: {
  tool: TechnicalRasterDrawingTool;
  onToolChange: (tool: TechnicalRasterDrawingTool) => void;
  category: DrawingCategory;
  onCategoryChange: (category: DrawingCategory) => void;
  pointStyle: DrawingPointStyle;
  onPointStyleChange: (pointStyle: DrawingPointStyle) => void;
  size: DrawingSize;
  onSizeChange: (size: DrawingSize) => void;
  /** The selected drawing (select tool only) — its category/shape are shown as active. Its note lives in TechnicalRasterDrawingDetailPanel (right sidebar). */
  selectedDrawing?: TechnicalRasterDrawing;
  hasLineDraft: boolean;
  onDeleteSelected: () => void;
  onCancelLineDraft: () => void;
}) {
  const hasSelection = Boolean(selectedDrawing);
  const activeCategory = selectedDrawing ? drawingCategoryOf(selectedDrawing) : category;
  const activePointStyle = selectedDrawing?.type === "point" ? selectedDrawing.pointStyle : pointStyle;
  const showPointStyles = tool === "point" || selectedDrawing?.type === "point";
  return (
    <div className={tool === "off" ? "workflowCard technicalRasterDrawingToolbar" : "workflowCard technicalRasterDrawingToolbar active"}>
      <span className="technicalRasterDrawingToolbarTitle">RUČNÍ ZNAČKY</span>
      <div className="technicalRasterDrawingToolGroup" role="group" aria-label="Nástroj kreslení">
        {TOOLS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={tool === entry.id ? "technicalRasterDrawingTool active" : "technicalRasterDrawingTool"}
            aria-pressed={tool === entry.id}
            onClick={() => onToolChange(tool === entry.id ? "off" : entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {showPointStyles && (
        <div className="technicalRasterDrawingToolGroup" role="radiogroup" aria-label="Tvar bodu">
          {DRAWING_POINT_STYLES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="radio"
              aria-checked={activePointStyle === entry.id}
              className={activePointStyle === entry.id ? "technicalRasterDrawingTool active" : "technicalRasterDrawingTool"}
              onClick={() => onPointStyleChange(entry.id)}
            >
              <span aria-hidden="true">{entry.glyph}</span> {entry.label}
            </button>
          ))}
        </div>
      )}
      <div className="technicalRasterDrawingToolGroup" role="radiogroup" aria-label="Kategorie (barva)">
        {DRAWING_CATEGORIES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="radio"
            aria-checked={activeCategory === entry.id}
            aria-label={entry.label}
            title={entry.label}
            className={activeCategory === entry.id ? "technicalRasterDrawingColor active" : "technicalRasterDrawingColor"}
            style={{ background: entry.color }}
            onClick={() => onCategoryChange(entry.id)}
          />
        ))}
        <span className="technicalRasterDrawingCategoryName">{DRAWING_CATEGORIES.find((entry) => entry.id === activeCategory)?.label ?? "Původní barva"}</span>
      </div>
      <div className="technicalRasterDrawingToolGroup" role="radiogroup" aria-label="Tloušťka">
        {(Object.keys(DRAWING_SIZES) as DrawingSize[]).map((entry) => (
          <button
            key={entry}
            type="button"
            role="radio"
            aria-checked={size === entry}
            className={size === entry ? "technicalRasterDrawingTool active" : "technicalRasterDrawingTool"}
            onClick={() => onSizeChange(entry)}
          >
            {DRAWING_SIZES[entry].label}
          </button>
        ))}
      </div>
      {hasLineDraft && <button type="button" className="technicalRasterDrawingTool" onClick={onCancelLineDraft}>Zrušit čáru</button>}
      <button type="button" className="technicalRasterDrawingTool danger" disabled={!hasSelection} onClick={onDeleteSelected}>Smazat</button>
      <span className="technicalRasterDrawingHint" role="status">{describeTool(tool, hasLineDraft, hasSelection)}</span>
    </div>
  );
}

/**
 * DETAIL RUČNÍ ZNAČKY — the selected manual mark's detail with its note (a text object: its text), in the
 * RIGHT sidebar (never in the toolbar above the canvas: a toolbar that grows on selection would push the
 * whole canvas down mid-drag, found in the browser test). Opens automatically for a just-placed mark,
 * with the field focused so the user can type at once.
 */
export function TechnicalRasterDrawingDetailPanel({
  drawing,
  onNoteChange,
  onTextChange,
  onDelete,
  focusOnMount = false,
}: {
  drawing: TechnicalRasterDrawing;
  onNoteChange: (drawingId: string, note: Readonly<{ text: string; visible: boolean }>) => void;
  onTextChange: (drawingId: string, text: string) => void;
  onDelete: (drawingId: string) => void;
  /** True right after the mark was placed: the note/text field takes the focus. */
  focusOnMount?: boolean;
}) {
  const category = DRAWING_CATEGORIES.find((entry) => entry.id === drawingCategoryOf(drawing));
  const shape = drawing.type === "point" ? DRAWING_POINT_STYLES.find((entry) => entry.id === drawing.pointStyle) : undefined;
  return (
    <div className="workflowCard technicalRasterDrawingDetail">
      <div className="workflowCardHeader">
        <div>
          <span>DETAIL RUČNÍ ZNAČKY</span>
          <strong>{drawing.type === "point" ? `Bod${shape ? ` ${shape.glyph} ${shape.label.toLowerCase()}` : ""}` : drawing.type === "text" ? "Text" : "Čára"} · {category?.label ?? "původní barva"}</strong>
        </div>
        <button type="button" className="technicalActionButton destructive compact" onClick={() => onDelete(drawing.id)}>Smazat</button>
      </div>
      {drawing.type === "text"
        ? <DrawingTextEditor key={drawing.id} drawing={drawing} onTextChange={(text) => onTextChange(drawing.id, text)} focusOnMount={focusOnMount} />
        : <DrawingNoteEditor key={drawing.id} drawing={drawing} onNoteChange={(note) => onNoteChange(drawing.id, note)} focusOnMount={focusOnMount} />}
    </div>
  );
}
