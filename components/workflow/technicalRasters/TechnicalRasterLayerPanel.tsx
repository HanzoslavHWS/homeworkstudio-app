"use client";

import type { RasterLayer, RasterSettings } from "../../../domain/technicalRaster";
import type { WhiteModeAvailability } from "../../../lib/pdf/technicalRasterWhiteRender";

/**
 * VRSTVY RASTRU (spec section 5/6) — layer names come straight from the PDF, never hardcoded.
 * `workModeHiddenLayerIds` (the per-layer "skrýt v pracovním režimu" checkboxes below) is a
 * GENERAL "hide this whole OCG while I work" preference — safe for any layer, but never used for
 * the stand layer's own colored fill (whole-layer hiding removes edges along with fills — see
 * lib/pdf/technicalRasterWhiteRender.ts). Turning stand fills white specifically is a SEPARATE,
 * always-safe mechanism controlled by the same "Pracovní bílý režim"/"Původní vzhled" toggle, but
 * only actually available when `whiteModeAvailability.status === "available"` (spec section
 * 15/16: exactly one stand-layer candidate could be detected) — otherwise the toggle explains why
 * and the page simply stays in its original colors.
 */
export function TechnicalRasterLayerPanel({
  layers,
  settings,
  whiteModeAvailability,
  onToggleLayer,
  onSetViewMode,
  onSetWorkModeHiddenLayers,
}: {
  layers: readonly RasterLayer[];
  settings: RasterSettings;
  whiteModeAvailability: WhiteModeAvailability;
  onToggleLayer: (layerId: string, visible: boolean) => void;
  onSetViewMode: (mode: RasterSettings["viewMode"]) => void;
  onSetWorkModeHiddenLayers: (layerIds: readonly string[]) => void;
}) {
  const whiteModeUnavailable = whiteModeAvailability.status === "unavailable";
  if (layers.length === 0) {
    return (
      <div className="workflowCard technicalRasterLayerPanel">
        <div className="workflowCardHeader"><div><span>VRSTVY RASTRU</span></div></div>
        <p className="fieldHint">Tento PDF neobsahuje rozpoznatelné volitelné vrstvy (Optional Content Groups) — zobrazuje se celý beze změny.</p>
      </div>
    );
  }

  function toggleWorkModeHidden(layerId: string, hidden: boolean) {
    const next = hidden
      ? [...settings.workModeHiddenLayerIds, layerId].filter((id, index, all) => all.indexOf(id) === index)
      : settings.workModeHiddenLayerIds.filter((id) => id !== layerId);
    onSetWorkModeHiddenLayers(next);
  }

  return (
    <div className="workflowCard technicalRasterLayerPanel">
      <div className="workflowCardHeader">
        <div><span>VRSTVY RASTRU</span></div>
      </div>

      <div className="technicalRasterViewModeToggle">
        <label>
          <input type="radio" name="technicalRasterViewMode" checked={settings.viewMode === "work"} disabled={whiteModeUnavailable} onChange={() => onSetViewMode("work")} />
          Pracovní — bílé
        </label>
        <label>
          <input type="radio" name="technicalRasterViewMode" checked={settings.viewMode === "original"} onChange={() => onSetViewMode("original")} />
          Originální barvy
        </label>
      </div>
      {whiteModeUnavailable && (
        <p className="uploadError">U tohoto PDF nelze bezpečně změnit pouze výplně stánků — {whiteModeAvailability.reason}</p>
      )}

      <ul className="technicalRasterLayerList">
        {layers.map((layer) => (
          <li key={layer.id}>
            <label>
              <input
                type="checkbox"
                checked={settings.layerVisibility[layer.id] ?? layer.defaultVisible}
                onChange={(event) => onToggleLayer(layer.id, event.target.checked)}
              />
              {layer.name}
            </label>
            {settings.viewMode === "work" && (
              <label className="technicalRasterWorkModeHideOption fieldHint">
                <input
                  type="checkbox"
                  checked={settings.workModeHiddenLayerIds.includes(layer.id)}
                  onChange={(event) => toggleWorkModeHidden(layer.id, event.target.checked)}
                />
                skrýt v pracovním režimu
              </label>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
