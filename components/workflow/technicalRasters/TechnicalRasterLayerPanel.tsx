"use client";

import { useEffect, useRef, useState } from "react";
import { effectiveWhiteFillOpacity, type RasterLayer, type RasterSettings } from "../../../domain/technicalRaster";
import type { WhiteModeAvailability } from "../../../lib/pdf/technicalRasterWhiteRender";

/** How long after the user stops dragging "Krytí bílé" before the actual (re-render-triggering) value is committed — spec batch 6, UI section 30: UI value reacts instantly, only the render is debounced. */
const WHITE_OPACITY_DEBOUNCE_MS = 150;

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
 *
 * "Krytí bílé" (spec batch 6, UI section 17-23) is only ever shown alongside "Pracovní — bílé"
 * itself being both selected AND actually available — never a control that does nothing (spec
 * section 32).
 */
export function TechnicalRasterLayerPanel({
  layers,
  settings,
  whiteModeAvailability,
  onToggleLayer,
  onSetViewMode,
  onSetWorkModeHiddenLayers,
  onSetWhiteFillOpacity,
}: {
  layers: readonly RasterLayer[];
  settings: RasterSettings;
  whiteModeAvailability: WhiteModeAvailability;
  onToggleLayer: (layerId: string, visible: boolean) => void;
  onSetViewMode: (mode: RasterSettings["viewMode"]) => void;
  onSetWorkModeHiddenLayers: (layerIds: readonly string[]) => void;
  onSetWhiteFillOpacity: (opacity: number) => void;
}) {
  const whiteModeUnavailable = whiteModeAvailability.status === "unavailable";
  const whiteModeActive = settings.viewMode === "work" && whiteModeAvailability.status === "available";
  const persistedOpacityPercent = Math.round(effectiveWhiteFillOpacity(settings) * 100);
  // Local state so the slider's own displayed value/thumb reacts INSTANTLY while dragging (spec
  // section 30) — the actual project-state update (which triggers a real page re-render) is
  // debounced separately, below.
  const [displayedOpacityPercent, setDisplayedOpacityPercent] = useState(persistedOpacityPercent);
  const debounceTimeoutRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    setDisplayedOpacityPercent(persistedOpacityPercent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistedOpacityPercent]);
  useEffect(() => () => { if (debounceTimeoutRef.current !== undefined) window.clearTimeout(debounceTimeoutRef.current); }, []);

  function handleOpacitySliderChange(percent: number) {
    setDisplayedOpacityPercent(percent);
    if (debounceTimeoutRef.current !== undefined) window.clearTimeout(debounceTimeoutRef.current);
    debounceTimeoutRef.current = window.setTimeout(() => onSetWhiteFillOpacity(percent / 100), WHITE_OPACITY_DEBOUNCE_MS);
  }
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
        {whiteModeActive && (
          <label className="technicalRasterWhiteOpacityRow fieldHint">
            Krytí bílé
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={displayedOpacityPercent}
              onChange={(event) => handleOpacitySliderChange(Number(event.target.value))}
            />
            <span>{displayedOpacityPercent} %</span>
          </label>
        )}
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
