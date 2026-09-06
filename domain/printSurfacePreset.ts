/**
 * Tiskové plochy — a PRESET is a concrete named print-surface variant (e.g. "Panel stěnový 1 x
 * 2,5 m", or a Čelo/Bok child of a physical pult/vitrína) that a PrintSurfaceItem can be tagged
 * with, one level more specific than its TYPE (panel/fascia/…, see
 * domain/printSurfaceTypeCatalog.ts). Deliberately holds no production size itself — the same
 * preset can produce a different real size per realizačka, see
 * domain/printSurfaceProductionDimension.ts. Keeping TYPE / PRESET / PRODUCTION DIMENSION as three
 * separate models (not folded into one) is the whole point of this phase — see the task spec.
 *
 * The source Excel (domain/printSurfaceExcelImport.ts) groups some presets under a parent
 * "product" row that is itself not a real print surface (e.g. "Pult 1 x 0,5 x 1,1 m" groups its
 * own "Čelo"/"Bok" children) — parentId/parentName preserve that relationship so the UI can show
 * an unambiguous "Pult 1 x 0,5 x 1,1 m – Čelo" instead of a bare, ambiguous "Čelo".
 */

import type { PrintSurfaceTypeId } from "./printSurfaceTypeCatalog.ts";

export type PrintSurfacePreset = Readonly<{
  id: string;
  typeId: PrintSurfaceTypeId;
  /** Raw name as imported — for a child row this is just "Čelo"/"Bok"; use printSurfacePresetDisplayName for an unambiguous UI label. */
  name: string;
  description?: string;
  isActive: boolean;
  /** Internal id of the parent "product" row grouping this preset (e.g. a pult/vitrína), if any. */
  parentId?: string;
  /** Denormalized parent name, kept alongside parentId purely for display — see printSurfacePresetDisplayName. */
  parentName?: string;
}>;

export interface PrintSurfacePresetRepository {
  list(): Promise<readonly PrintSurfacePreset[]>;
  /** Full atomic replace — how a fresh Excel import applies its result (see domain/printSurfaceExcelImport.ts). */
  replaceAll(presets: readonly PrintSurfacePreset[]): Promise<void>;
}

/** Active presets belonging to the given type — what a "Preset" dropdown under a chosen "Typ plochy" should offer. */
export function presetsForType(
  presets: readonly PrintSurfacePreset[],
  typeId: PrintSurfaceTypeId,
): readonly PrintSurfacePreset[] {
  return presets.filter((preset) => preset.typeId === typeId && preset.isActive);
}

export function findPreset(presets: readonly PrintSurfacePreset[], id: string | undefined): PrintSurfacePreset | undefined {
  if (!id) return undefined;
  return presets.find((preset) => preset.id === id);
}

/**
 * The single place that composes a preset's UI label — "Pult 1 x 0,5 x 1,1 m – Čelo" for a child
 * of a parent product, or just the plain name ("Panel stěnový 1 x 2,5 m") when there's no parent.
 * Every place that shows a preset name (Inspector's select, the marker list) must go through this,
 * not re-build the "parent – child" string itself.
 */
export function printSurfacePresetDisplayName(preset: PrintSurfacePreset): string {
  return preset.parentName ? `${preset.parentName} – ${preset.name}` : preset.name;
}
