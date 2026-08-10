import type {
  ComponentDimensions,
  ComponentDefinition,
  PlacedComponent,
} from "./models.ts";

type ProductionComponent = Pick<
  ComponentDefinition | PlacedComponent,
  "widthMm" | "depthMm" | "heightMm" | "productionProfiles"
>;

export function getNominalDimensions(
  component: ProductionComponent,
): ComponentDimensions {
  return {
    widthMm: component.widthMm,
    depthMm: component.depthMm,
    heightMm: component.heightMm,
  };
}

export function getProductionDimensions(
  component: ProductionComponent,
  realizationProfileId: string,
): ComponentDimensions {
  const nominal = getNominalDimensions(component);
  const override = component.productionProfiles[realizationProfileId];

  return {
    widthMm: override?.exportWidthMm ?? nominal.widthMm,
    depthMm: override?.exportDepthMm ?? nominal.depthMm,
    heightMm: override?.exportHeightMm ?? nominal.heightMm,
  };
}
