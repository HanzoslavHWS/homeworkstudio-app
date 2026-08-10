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
    category: "cabinets",
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
    id: "chair-basic",
    type: "chair",
    name: "Židle",
    category: "chairs",
    sceneLabel: "Židle",
    widthMm: 535,
    depthMm: 592,
    heightMm: 795,
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
    assets: {
      sourceId: "chair-basic",
      scale: 1,
      unit: "mm",
      models3d: [
        {
          id: "chair-basic-model",
          url: "/models/chairs/zidle.glb",
          role: "component",
          unit: "mm",
          axisSystem: "x-right-y-depth-z-up",
          anchor: "footprint-center-floor",
        },
      ],
    },
  },
} satisfies Record<string, ComponentDefinition>;

export const componentCatalogItems: readonly ComponentDefinition[] =
  Object.values(componentCatalog);

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
    category: definition.category,
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
