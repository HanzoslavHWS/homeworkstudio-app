import type {
  ComponentDefinition,
  PlacedComponent,
} from "../domain/models.ts";
import { createEmptyNotes } from "../domain/notes.ts";

export const componentCatalog = {
  cabinet: {
    id: "test-cabinet-800x400",
    type: "cabinet",
    name: "Testovací skříňka",
    sceneLabel: "Skříňka",
    widthMm: 800,
    depthMm: 400,
    resizable: false,
    productionProfiles: {},
    frontDirectionDeg: 0,
    systemLocked: false,
    userLocked: false,
    visible: true,
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
    resizable: false,
    productionProfiles: {},
    frontDirectionDeg: 0,
    systemLocked: false,
    userLocked: false,
    visible: true,
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
    heightMm: definition.heightMm,
    resizable: definition.resizable,
    productionProfiles: definition.productionProfiles,
    ...createEmptyNotes(),
    xMm,
    yMm,
    rotationDeg: 0,
    rotationMode: definition.rotation.defaultMode,
    rotation: definition.rotation,
    systemLocked: definition.systemLocked,
    userLocked: definition.userLocked,
    visible: definition.visible,
    frontDirectionDeg: definition.frontDirectionDeg,
    sceneLabel: definition.sceneLabel,
    assets: definition.assets,
  };
}
