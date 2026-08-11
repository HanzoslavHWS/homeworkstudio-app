import type { FinishVariant, PricingEntry } from "./models.ts";

export const NO_CARPET_FINISH_ID = "none";

export const carpetFinishVariants: readonly FinishVariant[] = [
  { id: NO_CARPET_FINISH_ID, code: "NO-CARPET", name: "Bez koberce", materialRole: "CARPET", active: true },
  { id: "carpet-black", code: "CARPET-BLACK", name: "Černý", swatchColor: "#282828", materialRole: "CARPET", active: true, pricingUnit: "square-meter", pricingEntries: [] },
  { id: "carpet-grey", code: "CARPET-GREY", name: "Šedý", swatchColor: "#8d9092", materialRole: "CARPET", active: true, pricingUnit: "square-meter", pricingEntries: [] },
  { id: "carpet-blue", code: "CARPET-BLUE", name: "Modrý", swatchColor: "#355f84", materialRole: "CARPET", active: true, pricingUnit: "square-meter", pricingEntries: [] },
  { id: "carpet-red", code: "CARPET-RED", name: "Červený", swatchColor: "#8b3d3d", materialRole: "CARPET", active: true, pricingUnit: "square-meter", pricingEntries: [] },
];

export const constructionFinishVariants: readonly FinishVariant[] = [
  { id: "construction-white", code: "OCT-WHITE", name: "Bílá", swatchColor: "#f2f2ef", materialRole: "OCTANORM_WHITE", active: true },
  { id: "construction-black", code: "OCT-BLACK", name: "Černá", swatchColor: "#202224", materialRole: "OCTANORM_BLACK", active: true },
];

export function selectedFinish(
  variants: readonly FinishVariant[],
  id: string,
): FinishVariant | undefined {
  return variants.find((variant) => variant.id === id && variant.active);
}

export function finishPricingEntries(finish: FinishVariant): readonly PricingEntry[] {
  return finish.pricingEntries ?? [];
}

export function nominalAreaSquareMeters(dimensions: {
  widthMm: number;
  depthMm: number;
}): number {
  return (dimensions.widthMm * dimensions.depthMm) / 1_000_000;
}
