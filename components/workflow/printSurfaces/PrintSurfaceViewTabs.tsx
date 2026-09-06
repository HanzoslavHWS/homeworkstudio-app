"use client";

import { canAddPrintSurfaceView, type PrintSurfaceView } from "../../../domain/printSurfaceProject";

/**
 * Simple pohled ("view") switcher — spec section 6: "Není třeba dělat složitou galerii. Jednoduché
 * a čisté řešení stačí." A tab per view (click anywhere in its input both selects it AND lets the
 * user rename it in place — no separate rename mode) plus a "+ Přidat pohled" action, hidden once
 * MAX_PRINT_SURFACE_VIEWS is reached.
 */
export function PrintSurfaceViewTabs({
  views,
  activeViewId,
  onSelectView,
  onRenameView,
  onAddView,
  isUploading,
}: {
  views: readonly PrintSurfaceView[];
  activeViewId: string | undefined;
  onSelectView: (viewId: string) => void;
  onRenameView: (viewId: string, label: string) => void;
  onAddView: (file: File) => void;
  isUploading: boolean;
}) {
  return (
    <div className="printSurfaceViewTabs">
      {views.map((view) => (
        <input
          key={view.id}
          value={view.label}
          className={view.id === activeViewId ? "printSurfaceViewTab active" : "printSurfaceViewTab"}
          onFocus={() => onSelectView(view.id)}
          onChange={(event) => onRenameView(view.id, event.target.value)}
        />
      ))}
      {canAddPrintSurfaceView(views) && (
        <label className="filePicker compact printSurfaceAddViewButton">
          <span>{isUploading ? "Nahrávám…" : "+ Přidat pohled"}</span>
          <input
            type="file"
            accept="image/png,image/jpeg"
            disabled={isUploading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onAddView(file);
              event.target.value = "";
            }}
          />
        </label>
      )}
    </div>
  );
}
