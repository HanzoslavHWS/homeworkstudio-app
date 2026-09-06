/**
 * Tiskové plochy V2 — the toolbar no longer exposes raw printSurfaceTypeCatalog types directly
 * (spec section 8: "Nevytvářej duplicitu katalogových dat v UI"). Instead it shows PRODUCT
 * GROUPS — Panel/Pult/Vitrína/Pultová vitrína/Límec/Jiná plocha — a purely UI-facing grouping
 * layer sitting one level above PrintSurfacePreset. Fascia (Límec) and custom (Jiná plocha) are
 * never catalog presets — they're always manual/explicit-dimension markers (see
 * domain/printSurfaceProject.ts's customWidthMm/customHeightMm) — so they never appear from
 * productGroupForPreset/presetsForProductGroup below; the toolbar wires their compact width/
 * height inputs directly.
 */

import type { PrintSurfaceTypeId } from "./printSurfaceTypeCatalog.ts";
import type { PrintSurfacePreset } from "./printSurfacePreset.ts";

export type PrintSurfaceProductGroupId = "panel" | "counter" | "showcase" | "counter_showcase" | "fascia" | "custom";

export type PrintSurfaceProductGroupDefinition = Readonly<{ id: PrintSurfaceProductGroupId; labelCz: string }>;

export const PRINT_SURFACE_PRODUCT_GROUPS: readonly PrintSurfaceProductGroupDefinition[] = [
  { id: "panel", labelCz: "Panel" },
  { id: "counter", labelCz: "Pult" },
  { id: "showcase", labelCz: "Vitrína" },
  { id: "counter_showcase", labelCz: "Pultová vitrína" },
  { id: "fascia", labelCz: "Límec" },
  { id: "custom", labelCz: "Jiná plocha" },
];

/**
 * Classifies a catalog preset into one of the toolbar's product groups — the SINGLE place this
 * happens, never inline in a component. counter_front/counter_side alone can't distinguish "Pult"
 * from "Pultová vitrína" (both are typ=counter in the source Excel — see
 * domain/printSurfaceExcelImport.ts) — that split is read from the parent PRODUCT's own name,
 * which is real, business-controlled Czech text from the Excel, same spirit as
 * mapExcelRowToPrintSurfaceType's own text-based panel/naddveřní distinction.
 */
export function productGroupForPreset(preset: PrintSurfacePreset): Exclude<PrintSurfaceProductGroupId, "fascia" | "custom"> {
  if (preset.typeId === "panel" || preset.typeId === "panel_above_door") return "panel";
  if (preset.typeId === "showcase") return "showcase";
  return preset.parentName?.trim().toLowerCase().startsWith("pultová vitrína") ? "counter_showcase" : "counter";
}

/** Active presets belonging to a toolbar group. Always empty for fascia/custom (never catalog-backed). */
export function presetsForProductGroup(
  presets: readonly PrintSurfacePreset[],
  groupId: PrintSurfaceProductGroupId,
): readonly PrintSurfacePreset[] {
  if (groupId === "fascia" || groupId === "custom") return [];
  return presets.filter((preset) => preset.isActive && productGroupForPreset(preset) === groupId);
}

export type PrintSurfaceProductGroupProduct = Readonly<{
  /** The parent product's internal id for grouped presets (Pult/Vitrína/Pultová vitrína); for a standalone preset (Panel — no parent), this is just the preset's own id. */
  key: string;
  label: string;
  presets: readonly PrintSurfacePreset[];
}>;

/**
 * Second drill-down level (spec section 9): within a group, presets sharing the same parent
 * product fold into one PRODUCT entry — e.g. "Pult 1 x 0,5 x 1,1 m" → [Čelo, Bok]. A preset with
 * no parent (Panel) instead becomes its own one-preset "product" entry, so Panel's drill-down is
 * effectively flat (one click shows the real panel presets directly, per spec's own example).
 */
export function productsForGroup(
  presets: readonly PrintSurfacePreset[],
  groupId: PrintSurfaceProductGroupId,
): readonly PrintSurfaceProductGroupProduct[] {
  const groupPresets = presetsForProductGroup(presets, groupId);
  const byParent = new Map<string, PrintSurfacePreset[]>();
  const standalone: PrintSurfacePreset[] = [];
  for (const preset of groupPresets) {
    if (preset.parentId) {
      const list = byParent.get(preset.parentId) ?? [];
      list.push(preset);
      byParent.set(preset.parentId, list);
    } else {
      standalone.push(preset);
    }
  }
  const products: PrintSurfaceProductGroupProduct[] = [...byParent.entries()].map(([parentId, children]) => ({
    key: parentId,
    label: children[0]?.parentName ?? parentId,
    presets: children,
  }));
  for (const preset of standalone) {
    products.push({ key: preset.id, label: preset.name, presets: [preset] });
  }
  return products;
}

/** Reverse lookup used only to pre-select a toolbar group when editing an existing catalog-backed marker. */
export function productGroupForTypeId(typeId: PrintSurfaceTypeId): PrintSurfaceProductGroupId | undefined {
  if (typeId === "panel" || typeId === "panel_above_door") return "panel";
  if (typeId === "showcase") return "showcase";
  if (typeId === "fascia") return "fascia";
  if (typeId === "custom") return "custom";
  return undefined; // counter_front/counter_side are ambiguous between "counter"/"counter_showcase" without the preset's parentName
}
