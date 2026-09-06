/**
 * Tiskové plochy — configuration/data layer for the print-surface TYPES a marker can be tagged
 * with (Panel, Límec, Vitrína, ...). Deliberately separate from the React UI (components/workflow/
 * printSurfaces/*) so new types can be added here later without touching component code, and
 * separate from any real production/dimension preset (that's a future layer — see
 * domain/printSurfaceProject.ts's reserved-for-later fields on PrintSurfaceItem).
 *
 * `id` is the stable, language-neutral identifier persisted on every PrintSurfaceItem; `labelCz`
 * is the only thing that may ever change/be retranslated.
 */

export type PrintSurfaceTypeId =
  | "panel"
  | "panel_above_door"
  | "fascia"
  | "counter_front"
  | "counter_side"
  | "showcase"
  | "custom";

export type PrintSurfaceTypeDefinition = Readonly<{
  id: PrintSurfaceTypeId;
  labelCz: string;
}>;

export const PRINT_SURFACE_TYPES: readonly PrintSurfaceTypeDefinition[] = [
  { id: "panel", labelCz: "Panel" },
  { id: "panel_above_door", labelCz: "Panel nad dveřmi" },
  { id: "fascia", labelCz: "Límec" },
  { id: "counter_front", labelCz: "Pult – čelo" },
  { id: "counter_side", labelCz: "Pult – bok" },
  { id: "showcase", labelCz: "Vitrína" },
  { id: "custom", labelCz: "Jiná plocha" },
];

export function findPrintSurfaceType(id: PrintSurfaceTypeId): PrintSurfaceTypeDefinition | undefined {
  return PRINT_SURFACE_TYPES.find((type) => type.id === id);
}

export function printSurfaceTypeLabel(id: PrintSurfaceTypeId): string {
  return findPrintSurfaceType(id)?.labelCz ?? id;
}
