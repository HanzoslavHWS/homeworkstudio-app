import type {
  Currency,
  Notes,
  PlacedComponent,
  ProjectType,
} from "./models.ts";
import { createEmptyNotes } from "./notes.ts";
import type { CustomDimension, ProjectAnnotation } from "./spatialAnnotations.ts";
import type { ExportLayer } from "./workflow.ts";
import type { StoredAsset } from "./assets.ts";

export type ProjectMode = "proposal" | "order" | "production";
export type ProjectStatus = "draft" | "inProgress" | "ready" | "archived";
export type ProjectStage = "quote" | "design" | "approved" | "done";
export type CommunicationLanguage = "cs" | "en";

export type ProjectContact = Readonly<{
  name: string;
  phone: string;
  email: string;
}>;

export type ProjectAccess = Readonly<{
  userId: string;
  role: "owner" | "member";
  canEdit: boolean;
}>;
export type RequirementStatus =
  | "unspecified"
  | "notWanted"
  | "inquire"
  | "ordered"
  | "dataReceived"
  | "ready";

export type TechnicalRequirement = Readonly<{
  status: RequirementStatus;
  note: string;
}>;

export type CleaningRequirement = Readonly<{
  status: "unspecified" | "notWanted" | "inquire" | "oneTime" | "daily";
  note: string;
  /** Optional future multiplier; no business default is inferred. */
  dayCount?: number;
}>;

export type ContainerRequirement = Readonly<{
  status: "unspecified" | "notWanted" | "inquire" | "wanted";
  volumeSize: string;
  note: string;
  individualPriceNet?: number;
}>;

export type ElectricityRequirement = TechnicalRequirement &
  Readonly<{
    powerOption: "" | "3kw" | "5kw" | "9kw" | "custom";
    customPower: string;
  }>;

export type TechnicalRequirements = Readonly<{
  electricity: ElectricityRequirement;
  water: TechnicalRequirement;
  waste: TechnicalRequirement;
  graphics: TechnicalRequirement;
  fasciaGraphics: TechnicalRequirement;
  fullWrapGraphics: TechnicalRequirement;
  cleaning: CleaningRequirement;
  container: ContainerRequirement;
}>;

export type ArtworkStatus = "missing" | "received" | "ready";

export type PrintSurfaceAssignment = Readonly<{
  printSurfaceId: string;
  sceneReference: string;
  graphicsKind: "fascia" | "fullWrap";
  artworkStatus: ArtworkStatus;
  artworkFileId?: string;
  selectedForPrint: boolean;
  canonicalWidthMm: number;
  canonicalHeightMm: number;
  productionWidthMm: number;
  productionHeightMm: number;
  includedInPackage: boolean;
  pricedSeparately: boolean;
}>;

export type Measurement3D = Readonly<{
  id: string;
  pointA: readonly [number, number, number];
  pointB: readonly [number, number, number];
  measuredValueMm: number;
  displayLabel?: string;
  displayOffset?: readonly [number, number, number];
  snapA?: "vertex" | "edge" | "surface";
  snapB?: "vertex" | "edge" | "surface";
}>;

export type ExportCalculationOptions = Readonly<{
  includeVisuals: boolean;
  includePricingTable: boolean;
  includeVatSummary: boolean;
  includeProjectNote: boolean;
  includeItemNotes: boolean;
  includeContact: boolean;
  includeEventLogo: boolean;
  selectedOutputIds: readonly string[];
}>;

export type ImportedOrderMappingStatus = "matched" | "unresolved" | "ignored";
export type ImportedOrderItemType =
  | "booth"
  | "furniture"
  | "technical"
  | "graphics"
  | "service"
  | "unknown";

export type ImportedOrderLine = Readonly<{
  id: string;
  sourceCode: string;
  sourceName: string;
  quantity: number;
  unit: string;
  rawText: string;
  mappedCatalogItemId?: string;
  mappingStatus: ImportedOrderMappingStatus;
  itemType: ImportedOrderItemType;
}>;

export type ImportedOrder = Readonly<{
  id: string;
  fileName: string;
  mimeType: string;
  importedAt: string;
  parserId: string;
  status: "awaiting-parser" | "parsed";
  lines: readonly ImportedOrderLine[];
}>;

export type SavedCameraView = Readonly<{
  id: string;
  name: string;
  position: readonly [number, number, number];
  target: readonly [number, number, number];
  fov?: number;
  createdAt: string;
}>;

export type VisualizationItem = Readonly<{
  id: string;
  name: string;
  sourceViewId: string;
  imageDataUrl: string;
  asset?: StoredAsset;
  type: "technical" | "ai";
  purpose: "working" | "presentation";
  createdAt: string;
  reviewStatus: "unreviewed" | "reviewed";
}>;

export type GeneratedPlanOutput = Readonly<{
  id: string;
  name: string;
  type: "plan2d";
  layers: readonly ExportLayer[];
  imageDataUrl: string;
  asset?: StoredAsset;
  createdAt: string;
  reviewStatus: "unreviewed" | "reviewed";
}>;

export type GraphicFileReference = Readonly<{
  id: string;
  name: string;
  size: number;
  mimeType: string;
  availability: "temporary-session" | "persistent";
  storageUrl?: string;
  storageKey?: string;
  asset?: StoredAsset;
  status?: "uploaded" | "dataReceived" | "ready";
  associatedRequirement?: "fascia" | "fullWrap";
  printSurfaceId?: string;
  createdAt?: string;
}>;

export type ProjectRecord = Readonly<{
  schemaVersion: number;
  id: string;
  name: string;
  fairId: string;
  company: string;
  contact: ProjectContact;
  boothNumber: string;
  boothId: string;
  variantId: string;
  realizationProfileId: string;
  communicationLanguage: CommunicationLanguage;
  currency: Currency;
  createdAt: string;
  modifiedAt: string;
  status: ProjectStatus;
  stage: ProjectStage;
  waitingForCustomer: boolean;
  requiresAction: boolean;
  mode: ProjectMode;
  projectType: ProjectType;
  notes: Notes;
  assemblyNotes: Notes;
  constructionNotes: Readonly<Record<string, Notes>>;
  constructionUserLocks: Readonly<Record<string, boolean>>;
  constructionVisibility: Readonly<Record<string, boolean>>;
  technicalRequirements: TechnicalRequirements;
  importedOrder?: ImportedOrder;
  sceneObjects: readonly PlacedComponent[];
  savedViews: readonly SavedCameraView[];
  visualizations: readonly VisualizationItem[];
  generatedPlanOutputs: readonly GeneratedPlanOutput[];
  selectedOutputIds: readonly string[];
  selectedEventDocumentIds: readonly string[];
  selectedVisualizationViewIds: readonly string[];
  visualizationPurpose: "working" | "presentation";
  visualization2DLayers: readonly string[];
  graphicsFiles: readonly GraphicFileReference[];
  carpetFinishId: string;
  constructionFinishId: string;
  annotations: readonly ProjectAnnotation[];
  customDimensions: readonly CustomDimension[];
  printSurfaceAssignments: readonly PrintSurfaceAssignment[];
  measurements3D: readonly Measurement3D[];
  dimensionOffsets3D: Readonly<Record<"width" | "depth" | "height", number>>;
  exportCalculationOptions: ExportCalculationOptions;
  access: readonly ProjectAccess[];
}>;

export const CURRENT_PROJECT_SCHEMA_VERSION = 4;

export const DEFAULT_REALIZATION_COMPANY_ID = "default";

export function createDefaultTechnicalRequirements(): TechnicalRequirements {
  const base = { status: "unspecified" as const, note: "" };
  return {
    electricity: { ...base, powerOption: "", customPower: "" },
    water: { ...base },
    waste: { ...base },
    graphics: { ...base },
    fasciaGraphics: { ...base },
    fullWrapGraphics: { ...base },
    cleaning: { status: "unspecified", note: "" },
    container: { status: "unspecified", volumeSize: "", note: "" },
  };
}

export function createDefaultExportCalculationOptions(): ExportCalculationOptions {
  return {
    includeVisuals: true,
    includePricingTable: true,
    includeVatSummary: true,
    includeProjectNote: true,
    includeItemNotes: true,
    includeContact: true,
    includeEventLogo: true,
    selectedOutputIds: [],
  };
}

export function createProjectRecord(
  overrides: Partial<ProjectRecord> = {},
  now = new Date().toISOString(),
): ProjectRecord {
  return {
    schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
    id: overrides.id ?? `project-${Date.now()}`,
    name: overrides.name ?? "Nový projekt",
    fairId: overrides.fairId ?? "",
    company: overrides.company ?? "",
    contact: normalizeProjectContact(overrides.contact),
    boothNumber: overrides.boothNumber ?? "",
    boothId: overrides.boothId ?? "",
    variantId: overrides.variantId ?? "",
    realizationProfileId:
      overrides.realizationProfileId ?? DEFAULT_REALIZATION_COMPANY_ID,
    communicationLanguage: overrides.communicationLanguage ?? "cs",
    currency: overrides.currency ?? "CZK",
    createdAt: overrides.createdAt ?? now,
    modifiedAt: overrides.modifiedAt ?? now,
    status: overrides.status ?? "draft",
    stage: overrides.stage ?? "quote",
    waitingForCustomer: overrides.waitingForCustomer ?? false,
    requiresAction: overrides.requiresAction ?? false,
    mode: overrides.mode ?? "proposal",
    projectType: overrides.projectType ?? "typovy",
    notes: overrides.notes ?? createEmptyNotes(),
    assemblyNotes: overrides.assemblyNotes ?? createEmptyNotes(),
    constructionNotes: overrides.constructionNotes ?? {},
    constructionUserLocks: overrides.constructionUserLocks ?? {},
    constructionVisibility: overrides.constructionVisibility ?? {},
    technicalRequirements: normalizeTechnicalRequirements(
      overrides.technicalRequirements,
    ),
    importedOrder: overrides.importedOrder,
    sceneObjects: (overrides.sceneObjects ?? []).map((item) => ({
      ...item,
      internalNote: item.internalNote ?? "",
      customerNote: item.customerNote ?? "",
      visible: item.visible ?? true,
      userLocked: item.userLocked ?? false,
      displayOrder2D: item.displayOrder2D ?? 0,
    })),
    savedViews: overrides.savedViews ?? [],
    visualizations: (overrides.visualizations ?? []).map((item) => ({
      ...item,
      reviewStatus: item.reviewStatus ?? "unreviewed",
    })),
    generatedPlanOutputs: (overrides.generatedPlanOutputs ?? []).map((item) => ({
      ...item,
      layers: item.layers ?? [],
      reviewStatus: item.reviewStatus ?? "unreviewed",
    })),
    selectedOutputIds: overrides.selectedOutputIds ?? [],
    selectedEventDocumentIds: overrides.selectedEventDocumentIds ?? [],
    selectedVisualizationViewIds: overrides.selectedVisualizationViewIds ?? [],
    visualizationPurpose: overrides.visualizationPurpose ?? "working",
    visualization2DLayers: overrides.visualization2DLayers ?? [
      "booth",
      "furniture",
      "annotations",
    ],
    graphicsFiles: (overrides.graphicsFiles ?? []).map((file) => ({
      ...file,
      storageKey: file.storageKey ?? file.asset?.storageKey,
      availability: file.storageKey || file.asset?.storageKey ? "persistent" : file.availability ?? "temporary-session",
      status: file.status ?? (file.storageKey || file.asset?.storageKey ? "uploaded" : undefined),
      createdAt: file.createdAt ?? file.asset?.createdAt,
    })),
    carpetFinishId: overrides.carpetFinishId ?? "carpet-grey",
    constructionFinishId:
      overrides.constructionFinishId ?? "construction-white",
    annotations: (overrides.annotations ?? []).map((item) => ({
      ...item,
      visible: item.visible ?? true,
      textSize: item.textSize ?? "medium",
    })),
    customDimensions: overrides.customDimensions ?? [],
    printSurfaceAssignments: overrides.printSurfaceAssignments ?? [],
    measurements3D: overrides.measurements3D ?? [],
    dimensionOffsets3D: overrides.dimensionOffsets3D ?? {
      width: 0,
      depth: 0,
      height: 0,
    },
    exportCalculationOptions: {
      ...createDefaultExportCalculationOptions(),
      ...(overrides.exportCalculationOptions ?? {}),
      selectedOutputIds:
        overrides.exportCalculationOptions?.selectedOutputIds ?? [],
    },
    access: overrides.access ?? [],
  };
}

function normalizeTechnicalRequirements(
  requirements: TechnicalRequirements | undefined,
): TechnicalRequirements {
  const defaults = createDefaultTechnicalRequirements();
  if (!requirements) return defaults;
  return {
    electricity: {
      ...defaults.electricity,
      ...(requirements.electricity ?? {}),
    },
    water: { ...defaults.water, ...(requirements.water ?? {}) },
    waste: { ...defaults.waste, ...(requirements.waste ?? {}) },
    graphics: { ...defaults.graphics, ...(requirements.graphics ?? {}) },
    fasciaGraphics: {
      ...defaults.fasciaGraphics,
      ...(requirements.fasciaGraphics ?? requirements.graphics ?? {}),
    },
    fullWrapGraphics: {
      ...defaults.fullWrapGraphics,
      ...(requirements.fullWrapGraphics ?? {}),
    },
    cleaning: { ...defaults.cleaning, ...(requirements.cleaning ?? {}) },
    container: { ...defaults.container, ...(requirements.container ?? {}) },
  };
}

export function normalizeProjectContact(
  contact: ProjectContact | string | undefined,
): ProjectContact {
  if (typeof contact === "string") {
    return contact.includes("@")
      ? { name: "", phone: "", email: contact }
      : { name: contact, phone: "", email: "" };
  }
  return {
    name: contact?.name ?? "",
    phone: contact?.phone ?? "",
    email: contact?.email ?? "",
  };
}

export function normalizeProjectRecord(
  project: Omit<Partial<ProjectRecord>, "contact"> &
    Pick<ProjectRecord, "id"> & { contact?: ProjectContact | string },
): ProjectRecord {
  return createProjectRecord(
    { ...project, contact: normalizeProjectContact(project.contact) },
    project.modifiedAt ?? new Date().toISOString(),
  );
}

export type GeneratedProjectOutput = GeneratedPlanOutput | VisualizationItem;

export function renameGeneratedOutput<T extends GeneratedProjectOutput>(
  output: T,
  name: string,
): T {
  const trimmed = name.trim();
  return (trimmed && trimmed !== output.name
    ? { ...output, name: trimmed }
    : output) as T;
}

export function setGeneratedOutputReview<T extends GeneratedProjectOutput>(
  output: T,
  reviewStatus: GeneratedProjectOutput["reviewStatus"],
): T {
  return (output.reviewStatus === reviewStatus
    ? output
    : { ...output, reviewStatus }) as T;
}

export function deleteGeneratedOutput(
  project: ProjectRecord,
  outputId: string,
): ProjectRecord {
  return {
    ...project,
    generatedPlanOutputs: project.generatedPlanOutputs.filter(
      (item) => item.id !== outputId,
    ),
    visualizations: project.visualizations.filter(
      (item) => item.id !== outputId,
    ),
    selectedOutputIds: project.selectedOutputIds.filter(
      (id) => id !== outputId,
    ),
  };
}

export function touchProject(
  project: ProjectRecord,
  modifiedAt = new Date().toISOString(),
): ProjectRecord {
  return { ...project, modifiedAt };
}
