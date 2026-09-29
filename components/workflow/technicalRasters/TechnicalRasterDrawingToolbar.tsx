"use client";

import { DRAWING_COLORS, DRAWING_SIZES, type DrawingSize, type TechnicalRasterDrawingTool } from "../../../domain/technicalRasterDrawings";

const TOOLS: readonly Readonly<{ id: Exclude<TechnicalRasterDrawingTool, "off">; label: string }>[] = [
  { id: "select", label: "Vybrat" },
  { id: "point", label: "Bod" },
  { id: "line", label: "Čára" },
];

/** What the next click does — shown as text so the active tool is never ambiguous (not color alone). */
function describeTool(tool: TechnicalRasterDrawingTool, hasLineDraft: boolean, hasSelection: boolean): string {
  switch (tool) {
    case "off": return "Kreslení je vypnuté — rastr slouží ke službám.";
    case "select": return hasSelection ? "Vybráno: tažením přesunete, Delete / Smazat odstraní, barva a tloušťka se změní." : "Klikněte na ruční značku pro výběr.";
    case "point": return "Bod: klikněte do rastru.";
    case "line": return hasLineDraft ? "Čára: klikněte na bod B (Esc zruší rozkreslenou čáru)." : "Čára: klikněte na bod A.";
  }
}

/**
 * RUČNÍ ZNAČKY — manual point/line tools. Clicking the active tool again switches drawing off (back to
 * normal service work). Picking a color or thickness also restyles the selected drawing.
 */
export function TechnicalRasterDrawingToolbar({
  tool,
  onToolChange,
  color,
  onColorChange,
  size,
  onSizeChange,
  hasSelection,
  hasLineDraft,
  onDeleteSelected,
  onCancelLineDraft,
}: {
  tool: TechnicalRasterDrawingTool;
  onToolChange: (tool: TechnicalRasterDrawingTool) => void;
  color: string;
  onColorChange: (color: string) => void;
  size: DrawingSize;
  onSizeChange: (size: DrawingSize) => void;
  hasSelection: boolean;
  hasLineDraft: boolean;
  onDeleteSelected: () => void;
  onCancelLineDraft: () => void;
}) {
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
      <div className="technicalRasterDrawingToolGroup" role="radiogroup" aria-label="Barva">
        {DRAWING_COLORS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="radio"
            aria-checked={color === entry.hex}
            aria-label={entry.label}
            title={entry.label}
            className={color === entry.hex ? "technicalRasterDrawingColor active" : "technicalRasterDrawingColor"}
            style={{ background: entry.hex }}
            onClick={() => onColorChange(entry.hex)}
          />
        ))}
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
