import type { ConstructionPricingPolicy, ProjectType } from "./models.ts";

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
