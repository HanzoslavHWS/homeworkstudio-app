import type { ConstructionPricingPolicy, ProjectType } from "./models.ts";

export const DEFAULT_CZ_VAT_RATE_PERCENT = 21;

export type TaxBreakdown = Readonly<{
  net: number;
  vat: number;
  gross: number;
  vatRatePercent: number;
}>;

export function calculateNetVatGross(
  net: number,
  vatRatePercent = DEFAULT_CZ_VAT_RATE_PERCENT,
): TaxBreakdown {
  const vat = Math.round(net * vatRatePercent) / 100;
  return {
    net,
    vat,
    gross: Math.round((net + vat) * 100) / 100,
    vatRatePercent,
  };
}

export function calculateMarginDelta(
  salePriceNet: number,
  purchasePriceNet: number,
): number {
  return Math.round((salePriceNet - purchasePriceNet) * 100) / 100;
}

export const STANDARD_BOOTH_PRICING: ConstructionPricingPolicy = {
  mode: "fixed",
  structuralChangesAffectPrice: false,
  orderedItemsAffectPrice: true,
};

export const CUSTOM_BOOTH_PRICING: ConstructionPricingPolicy = {
  mode: "configuration-dependent",
  structuralChangesAffectPrice: true,
  orderedItemsAffectPrice: true,
};

export function pricingPolicyFor(
  projectType: ProjectType,
): ConstructionPricingPolicy {
  return projectType === "typovy"
    ? STANDARD_BOOTH_PRICING
    : CUSTOM_BOOTH_PRICING;
}
