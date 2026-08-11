import type { PlacedComponent, SceneLayer } from "./models.ts";
import type {
  SavedCameraView,
  VisualizationItem,
} from "./project.ts";

export type ExportLayer = "booth" | SceneLayer | "dimensions";

export type ExportOptions = Readonly<{
  layers: readonly ExportLayer[];
  background: "white" | "transparent";
  language?: ExportLanguage;
  includeFurniturePhotos?: boolean;
}>;

export type ExportLanguage = "cs" | "en";

export const EXPORT_LAYER_LABELS: Readonly<Record<ExportLayer, string>> = {
  booth: "Stánek",
  furniture: "Mobiliář",
  electrical: "Elektro",
  water: "Voda",
  waste: "Odpad",
  annotations: "Popisky / poznámky",
  dimensions: "Kóty",
};

export type ExportPreset = Readonly<{
  id: string;
  name: string;
  options: ExportOptions;
}>;

export const EXPORT_PRESETS: readonly ExportPreset[] = [
  {
    id: "technical-plan",
    name: "Technický půdorys",
    options: { layers: ["booth", "furniture"], background: "white" },
  },
  {
    id: "electrical-clean",
    name: "Čisté elektro",
    options: {
      layers: ["booth", "electrical"],
      background: "white",
    },
  },
  {
    id: "electrical-plan",
    name: "Půdorys s elektřinou",
    options: {
      layers: ["booth", "furniture", "electrical"],
      background: "white",
    },
  },
  {
    id: "complete-plan",
    name: "Kompletní technický půdorys",
    options: {
      layers: [
        "booth",
        "furniture",
        "electrical",
        "water",
        "waste",
        "annotations",
      ],
      background: "white",
    },
  },
];

export interface VisualizationProvider {
  readonly id: string;
  create(input: {
    name: string;
    sourceViewId: string;
    technicalRenderDataUrl: string;
    purpose?: "working" | "presentation";
  }): Promise<VisualizationItem>;
}

export class TechnicalVisualizationProvider implements VisualizationProvider {
  readonly id = "technical-capture";

  async create(input: {
    name: string;
    sourceViewId: string;
    technicalRenderDataUrl: string;
    purpose?: "working" | "presentation";
  }): Promise<VisualizationItem> {
    return {
      id: `visualization-${Date.now()}`,
      name: input.name,
      sourceViewId: input.sourceViewId,
      imageDataUrl: input.technicalRenderDataUrl,
      type: "technical",
      purpose: input.purpose ?? "working",
      createdAt: new Date().toISOString(),
      reviewStatus: "unreviewed",
    };
  }
}

export function saveCameraView(
  input: Omit<SavedCameraView, "id" | "createdAt">,
  now = new Date().toISOString(),
): SavedCameraView {
  return { ...input, id: `view-${Date.now()}`, createdAt: now };
}

export function sceneObjectsForLayers(
  sceneObjects: readonly PlacedComponent[],
  layers: readonly ExportLayer[],
): readonly PlacedComponent[] {
  return sceneObjects.filter(
    (item) => item.showIn2D && layers.includes(item.sceneLayer),
  );
}
