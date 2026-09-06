/**
 * Tiskové plochy — a PRESET is a concrete named print-surface variant (e.g. "Panel standard",
 * "Panel nad dveřmi", "Límec") that a PrintSurfaceItem can be tagged with, one level more specific
 * than its TYPE (panel/fascia/…, see domain/printSurfaceTypeCatalog.ts). Deliberately holds no
 * production size itself — the same preset can produce a different real size per realizačka, see
 * domain/printSurfaceProductionDimension.ts. Keeping TYPE / PRESET / PRODUCTION DIMENSION as three
 * separate models (not folded into one) is the whole point of this phase — see the task spec.
 */

import type { PrintSurfaceTypeId } from "./printSurfaceTypeCatalog.ts";

export type PrintSurfacePreset = Readonly<{
  id: string;
  typeId: PrintSurfaceTypeId;
  name: string;
  description?: string;
  isActive: boolean;
}>;

export interface PrintSurfacePresetRepository {
  list(): Promise<readonly PrintSurfacePreset[]>;
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
