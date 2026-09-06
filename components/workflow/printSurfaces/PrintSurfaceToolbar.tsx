"use client";

import { useState } from "react";
import {
  PRINT_SURFACE_PRODUCT_GROUPS,
  productsForGroup,
  type PrintSurfaceProductGroupId,
} from "../../../domain/printSurfaceProductGroup";
import type { PrintSurfacePreset } from "../../../domain/printSurfacePreset";
import { resolvePrintSurfaceProductionDimension, type PrintSurfaceProductionDimension } from "../../../domain/printSurfaceProductionDimension";
import { activeToolLabel, FASCIA_HEIGHT_MM, SELECT_TOOL, type PrintSurfaceActiveTool } from "../../../domain/printSurfaceActiveTool";
import { printSurfaceItemSurfaceName, type PrintSurfaceItem } from "../../../domain/printSurfaceProject";

const GROUP_ICONS: Record<PrintSurfaceProductGroupId, string> = {
  panel: "▭",
  counter: "▤",
  showcase: "▥",
  counter_showcase: "▦",
  fascia: "▬",
  custom: "◆",
};

type ExpandedGroup = PrintSurfaceProductGroupId | "link";

export function PrintSurfaceToolbar({
  presets,
  productionDimensions,
  realizationCompanyId,
  linkableItems,
  activeTool,
  onChangeTool,
}: {
  presets: readonly PrintSurfacePreset[];
  productionDimensions: readonly PrintSurfaceProductionDimension[];
  realizationCompanyId: string | undefined;
  /** Items that do NOT yet have a placement on the currently active view (see domain/printSurfaceProject.ts's itemsWithoutPlacementOnView) — what "Propojit plochu" offers. */
  linkableItems: readonly PrintSurfaceItem[];
  activeTool: PrintSurfaceActiveTool;
  onChangeTool: (tool: PrintSurfaceActiveTool) => void;
}) {
  const [expandedGroup, setExpandedGroup] = useState<ExpandedGroup | null>(null);
  const [expandedProductKey, setExpandedProductKey] = useState<string | null>(null);
  const [fasciaWidthInput, setFasciaWidthInput] = useState("3000");
  const [customWidthInput, setCustomWidthInput] = useState("1000");
  const [customHeightInput, setCustomHeightInput] = useState("1000");

  function isAvailable(presetId: string): boolean {
    const resolution = resolvePrintSurfaceProductionDimension({ realizationCompanyId, presetId }, productionDimensions);
    return resolution.status !== "unavailable";
  }

  function selectGroup(groupId: PrintSurfaceProductGroupId) {
    setExpandedProductKey(null);
    if (groupId === "fascia") {
      const width = Number(fasciaWidthInput);
      setExpandedGroup("fascia");
      onChangeTool(Number.isFinite(width) && width > 0 ? { kind: "fascia", widthMm: width } : SELECT_TOOL);
      return;
    }
    if (groupId === "custom") {
      const width = Number(customWidthInput);
      const height = Number(customHeightInput);
      setExpandedGroup("custom");
      onChangeTool(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0 ? { kind: "custom", widthMm: width, heightMm: height } : SELECT_TOOL);
      return;
    }
    setExpandedGroup(groupId);
  }

  function selectPreset(preset: PrintSurfacePreset, productLabel: string) {
    if (!isAvailable(preset.id)) return;
    onChangeTool({ kind: "catalog", typeId: preset.typeId, presetId: preset.id, label: preset.parentName ? `${productLabel} – ${preset.name}` : preset.name });
  }

  function handleFasciaWidthChange(value: string) {
    setFasciaWidthInput(value);
    const width = Number(value);
    onChangeTool(Number.isFinite(width) && width > 0 ? { kind: "fascia", widthMm: width } : SELECT_TOOL);
  }

  function handleCustomDimensionChange(widthValue: string, heightValue: string) {
    setCustomWidthInput(widthValue);
    setCustomHeightInput(heightValue);
    const width = Number(widthValue);
    const height = Number(heightValue);
    onChangeTool(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0 ? { kind: "custom", widthMm: width, heightMm: height } : SELECT_TOOL);
  }

  function resetToSelect() {
    setExpandedGroup(null);
    setExpandedProductKey(null);
    onChangeTool(SELECT_TOOL);
  }

  function selectLink(item: PrintSurfaceItem) {
    onChangeTool({ kind: "link", itemId: item.id, label: `${item.label} — ${printSurfaceItemSurfaceName(item, presets)}` });
  }

  const activeGroupProducts = expandedGroup && expandedGroup !== "fascia" && expandedGroup !== "custom" && expandedGroup !== "link"
    ? productsForGroup(presets, expandedGroup)
    : [];
  const activeLabel = activeToolLabel(activeTool);

  return (
    <div className="printSurfaceToolbarV2">
      <div className="adminCategoryTabs printSurfaceToolbar">
        <button type="button" className={activeTool.kind === "select" ? "active" : ""} onClick={resetToSelect}>
          Výběr
        </button>
        {PRINT_SURFACE_PRODUCT_GROUPS.map((group) => (
          <button
            key={group.id}
            type="button"
            className={expandedGroup === group.id ? "active" : ""}
            onClick={() => selectGroup(group.id)}
          >
            <span className="printSurfaceGroupIcon" aria-hidden="true">{GROUP_ICONS[group.id]}</span> {group.labelCz}
          </button>
        ))}
        <button
          type="button"
          className={expandedGroup === "link" ? "active" : ""}
          onClick={() => { setExpandedProductKey(null); setExpandedGroup("link"); }}
        >
          <span className="printSurfaceGroupIcon" aria-hidden="true">⚭</span> Propojit plochu
        </button>
      </div>

      {expandedGroup === "link" && (
        <div className="printSurfaceCompactOptionRow printSurfaceProductRow">
          {linkableItems.length === 0 ? (
            <span className="fieldHint">Žádná plocha k propojení — buď žádná neexistuje, nebo je už na tomto pohledu umístěná.</span>
          ) : (
            linkableItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className={activeTool.kind === "link" && activeTool.itemId === item.id ? "active" : ""}
                onClick={() => selectLink(item)}
              >
                {item.label} — {printSurfaceItemSurfaceName(item, presets)}
              </button>
            ))
          )}
        </div>
      )}

      {expandedGroup === "fascia" && (
        <div className="printSurfaceCompactOptionRow">
          <label>
            <span>Šířka</span>
            <input
              type="number"
              min={1}
              value={fasciaWidthInput}
              onChange={(event) => handleFasciaWidthChange(event.target.value)}
            />
            <span>mm</span>
          </label>
          <span className="fieldHint">Výška je vždy {FASCIA_HEIGHT_MM} mm.</span>
        </div>
      )}

      {expandedGroup === "custom" && (
        <div className="printSurfaceCompactOptionRow">
          <label>
            <span>Šířka</span>
            <input
              type="number"
              min={1}
              value={customWidthInput}
              onChange={(event) => handleCustomDimensionChange(event.target.value, customHeightInput)}
            />
            <span>mm</span>
          </label>
          <label>
            <span>Výška</span>
            <input
              type="number"
              min={1}
              value={customHeightInput}
              onChange={(event) => handleCustomDimensionChange(customWidthInput, event.target.value)}
            />
            <span>mm</span>
          </label>
        </div>
      )}

      {activeGroupProducts.length > 0 && (
        <div className="printSurfaceCompactOptionRow printSurfaceProductRow">
          {activeGroupProducts.map((product) => (
            <div key={product.key} className="printSurfaceProductGroup">
              {product.presets.length === 1 ? (
                <button
                  type="button"
                  className={!isAvailable(product.presets[0]!.id) ? "unavailable" : ""}
                  disabled={!isAvailable(product.presets[0]!.id)}
                  onClick={() => selectPreset(product.presets[0]!, product.label)}
                >
                  {product.label}
                  {!isAvailable(product.presets[0]!.id) && " — Není v nabídce"}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className={expandedProductKey === product.key ? "active" : ""}
                    onClick={() => setExpandedProductKey((current) => (current === product.key ? null : product.key))}
                  >
                    {product.label}
                  </button>
                  {expandedProductKey === product.key && (
                    <div className="printSurfaceProductPresets">
                      {product.presets.map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          className={!isAvailable(preset.id) ? "unavailable" : ""}
                          disabled={!isAvailable(preset.id)}
                          onClick={() => selectPreset(preset, product.label)}
                        >
                          {preset.name}
                          {!isAvailable(preset.id) && " — Není v nabídce"}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {activeLabel && (
        <p className="printSurfaceActiveToolLabel">Aktivní: <strong>{activeLabel}</strong></p>
      )}
    </div>
  );
}
