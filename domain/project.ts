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
import type { PlotPolygon, PlotStatus } from "./plot.ts";
import type { FloorZone } from "./floorZones.ts";
import type { RectanglePrimitive } from "./rectanglePrimitives.ts";
import type { VisualizationRenderFingerprint } from "./visualizationRender.ts";
import type { EnvironmentPreset, LightingPreset, PeoplePreset, VisualizationAiMode } from "./visualizationAi.ts";

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
    powerOption: "" | "2kw" | "3kw" | "5kw" | "9kw" | "custom";
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

export type ArtworkPlacementMode = "stretch" | "fit" | "fill";

export type ArtworkPlacement = Readonly<{
  mode: ArtworkPlacementMode;
  /** Uniform multiplier applied after the selected base mode. 1 = 100 %. */
  scale: number;
  /** Physical translation in canonical print-surface coordinates; positive X moves right. */
  offsetXmm: number;
  /** Physical translation in canonical print-surface coordinates; positive Y moves up. */
  offsetYmm: number;
}>;

export type PrintSurfaceAssignment = Readonly<{
  printSurfaceId: string;
  sceneReference: string;
  graphicsKind: "fascia" | "fullWrap";
  artworkStatus: ArtworkStatus;
  artworkFileId?: string;
  /** Missing on legacy projects and interpreted exactly as Stretch / 100 % / 0 / 0. */
  artworkPlacement?: ArtworkPlacement;
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

export type VisualizationView = Readonly<{
  id: string;
  name: string;
  position: readonly [number, number, number];
  target: readonly [number, number, number];
  fov?: number;
  projectionMode: "perspective";
  type: "3d";
  order: number;
  createdAt: string;
}>;

/** Compatibility name for pre-Visualization-v1 callers and persisted project documents. */
export type SavedCameraView = VisualizationView;

export type VisualizationItem = Readonly<{
  id: string;
  name: string;
  sourceViewId: string;
  imageDataUrl: string;
  asset?: StoredAsset;
  type: "technical" | "ai" | "customer";
  purpose: "working" | "presentation";
  createdAt: string;
  reviewStatus: "unreviewed" | "reviewed";
  /**
   * Visualization v2: a CUSTOMER render's tight FK to the VisualizationView it was captured
   * from — only ever set by the new customer-render creation path. The pre-existing
   * `sourceViewId` above is left exactly as before (populated with the view's NAME, not its id,
   * for the technical-snapshot path) — never retrofitted, to avoid touching that working code.
   */
  viewId?: string;
  widthPx?: number;
  heightPx?: number;
  format?: "png" | "jpeg";
  backgroundMode?: "white" | "light-neutral" | "transparent";
  /** Content fingerprint captured at render time — see domain/visualizationRender.ts's evaluateRenderStaleness for how this becomes "Aktuální" / "Může být zastaralý". Absent on every pre-v2/technical/ai item — never asserted stale in that case. */
  contentFingerprint?: VisualizationRenderFingerprint;

  // ---- Visualization v3: AI render fields — only ever set on type: "ai" items. ----
  /** Only "strict-lock" is ever produced this batch; "enhanced" is a reserved future value, never written by any code path yet. */
  mode?: VisualizationAiMode;
  environmentPreset?: EnvironmentPreset;
  peoplePreset?: PeoplePreset;
  lightingPreset?: LightingPreset;
  /** FK to the source Customer Render's VisualizationItem.id this AI render was generated from. `sourceViewId`/`viewId` above are reused verbatim — no separate AI-specific view FK. */
  sourceRenderId?: string;
  /** Provider/model identifiers only — e.g. "deterministic-fake" — NEVER a secret/API key. */
  provider?: string;
  model?: string;
  /** True when the provider's maxInputSize forced a smaller working resolution than the source render, later upscaled back for compositing (report section 26/27 — this is a mechanical resize, never the excluded "AI upscaler" feature). */
  resolutionDownscaled?: boolean;
}>;

/** Visualization v2: readability alias for a persisted customer render — same evolving VisualizationItem shape, never a parallel model (mirrors the existing SavedCameraView = VisualizationView precedent above). */
export type VisualizationRender = VisualizationItem;

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
  /** Persisted raster source dimensions used for deterministic Fit/Fill calculations. */
  widthPx?: number;
  heightPx?: number;
  createdAt?: string;
  /**
   * Explicit, user-chosen role — never inferred from resolution/DPI/mime type (a high-res JPG is
   * not automatically "print data"). Absent (every legacy file) is interpreted as "preview": a
   * file used for a 3D placement check is not assumed print-ready just because it exists. See
   * domain/graphicsExport.ts's Export B, which warns on "preview" rows.
   */
  usageRole?: "preview" | "print-data";
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
  /**
   * Individual-booth plot size (mode=individualni only) — LEGACY foundation fields, the 250 mm
   * layout grid rectangle a project saved before the polygon foundation used as its only plot
   * shape. Kept for backward compatibility (see domain/plot.ts's resolveIndividualPlotPolygon) —
   * never written by a project saved after the polygon foundation; individualPlotPolygon is the
   * real source of truth going forward. Never the manufactured part dimensions either way.
   */
  individualWidthMm?: number;
  individualDepthMm?: number;
  /** The drawing canvas the Individual-mode plot/floor/construction editors work in — NEVER the booth footprint itself (see domain/plot.ts's IndividualWorkspace). Undefined = domain/plot.ts's DEFAULT_INDIVIDUAL_WORKSPACE. */
  individualWorkspaceWidthMm?: number;
  individualWorkspaceDepthMm?: number;
  /** The real, possibly non-rectangular plot boundary (domain/plot.ts's PlotPolygon) — source of truth for every project saved after the polygon foundation. Undefined means "not drawn yet" (or a legacy project — see individualWidthMm/individualDepthMm above and resolveIndividualPlotPolygon). */
  individualPlotPolygon?: PlotPolygon;
  /** EDIT vs CONFIRMED/LOCKED for the plot polygon above (domain/plot.ts's PlotStatus/resolvePlotStatus) — undefined resolves to "draft", never silently "confirmed". */
  individualPlotStatus?: PlotStatus;
  /** Floor zones inside the plot (domain/floorZones.ts) — the rented plot polygon is not necessarily fully covered by one uniform floor finish. Each zone carries its own lock status (FloorZone.status). */
  individualFloorZones?: readonly FloorZone[];
  /** Report section 5-11: the rectangle-primitive authoring helper's CURRENT working set (domain/rectanglePrimitives.ts) — persisted so in-progress authoring survives a reload, but NEVER read as booth geometry by floor/construction/furniture logic; only individualPlotPolygon (produced by "Sloučit do plochy stánku") is the real source of truth. */
  individualPlotPrimitives?: readonly RectanglePrimitive[];
  notes: Notes;
  assemblyNotes: Notes;
  constructionNotes: Readonly<Record<string, Notes>>;
  constructionUserLocks: Readonly<Record<string, boolean>>;
  constructionVisibility: Readonly<Record<string, boolean>>;
  technicalRequirements: TechnicalRequirements;
  importedOrder?: ImportedOrder;
  sceneObjects: readonly PlacedComponent[];
  visualizationViews: readonly VisualizationView[];
  /** Legacy read-only project field; normalized records write only visualizationViews. */
  savedViews?: readonly Partial<VisualizationView>[];
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

export const CURRENT_PROJECT_SCHEMA_VERSION = 5;

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

function isCameraTuple(value: unknown): value is readonly [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
  );
}

/** Upgrades legacy savedViews entries without ever attaching a frozen project scene. */
export function normalizeVisualizationViews(
  views: readonly Partial<VisualizationView>[],
): readonly VisualizationView[] {
  return views
    .flatMap((view, index) => {
      if (
        typeof view.id !== "string" ||
        typeof view.name !== "string" ||
        !isCameraTuple(view.position) ||
        !isCameraTuple(view.target)
      ) {
        return [];
      }
      return [{
        id: view.id,
        name: view.name,
        position: [...view.position] as [number, number, number],
        target: [...view.target] as [number, number, number],
        ...(typeof view.fov === "number" && Number.isFinite(view.fov)
          ? { fov: view.fov }
          : {}),
        projectionMode: "perspective" as const,
        type: "3d" as const,
        order: typeof view.order === "number" && Number.isFinite(view.order) ? view.order : index,
        createdAt: typeof view.createdAt === "string" ? view.createdAt : "",
      }];
    })
    .sort((left, right) => left.order - right.order)
    .map((view, order) => ({ ...view, order }));
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
    individualWidthMm: overrides.individualWidthMm,
    individualDepthMm: overrides.individualDepthMm,
    individualWorkspaceWidthMm: overrides.individualWorkspaceWidthMm,
    individualWorkspaceDepthMm: overrides.individualWorkspaceDepthMm,
    individualPlotPolygon: overrides.individualPlotPolygon,
    individualPlotStatus: overrides.individualPlotStatus,
    individualFloorZones: overrides.individualFloorZones,
    individualPlotPrimitives: overrides.individualPlotPrimitives,
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
    visualizationViews: normalizeVisualizationViews(
      overrides.visualizationViews ?? overrides.savedViews ?? [],
    ),
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
