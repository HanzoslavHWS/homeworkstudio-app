import type {
  ComponentDefinition,
  PlacedComponent,
} from "../domain/models.ts";

export const componentCatalog = {
  cabinet: {
    id: "test-cabinet-800x400",
    type: "cabinet",
    name: "Testovací skříňka",
    sceneLabel: "Skříňka",
    widthMm: 800,
    depthMm: 400,
    frontDirectionDeg: 0,
    rotation: {
      defaultMode: "snap",
      snapStep: 45,
      quickAngles: [0, 45, 90, 135, 180, 225, 270, 315],
      allowFreeRotation: true,
      locked: false,
    },
  },
  chair: {
    id: "test-chair-450x500",
    type: "chair",
    name: "Testovací židle",
    sceneLabel: "Židle",
    widthMm: 450,
    depthMm: 500,
    frontDirectionDeg: 0,
    rotation: {
      defaultMode: "free",
      snapStep: 45,
      quickAngles: [0, 45, 90, 135, 180, 225, 270, 315],
      allowFreeRotation: true,
      locked: false,
    },
  },
} satisfies Record<string, ComponentDefinition>;

export function placeComponent(
  definition: ComponentDefinition,
  instanceId: string,
  xMm: number,
  yMm: number,
): PlacedComponent {
  return {
    id: instanceId,
    definitionId: definition.id,
    type: definition.type,
    name: definition.name,
    widthMm: definition.widthMm,
    depthMm: definition.depthMm,
    xMm,
    yMm,
    rotationDeg: 0,
    rotationMode: definition.rotation.defaultMode,
    rotation: definition.rotation,
    frontDirectionDeg: definition.frontDirectionDeg,
    sceneLabel: definition.sceneLabel,
    assets: definition.assets,
  };
}
