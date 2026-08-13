"use client";

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { boothTypes } from "../data/booths";
import { componentCatalogItems, placeComponent } from "../data/components";
import { fairs } from "../data/fairs";
import { exhibitions, priceLists } from "../data/organizations";
import {
  DEFAULT_REALIZATION_PROFILE_ID,
  realizationProfiles,
} from "../data/realizationProfiles";
import type {
  Currency,
  ComponentDefinition,
  Notes,
  PlacedComponent,
  ProjectType,
  RotationControlMode,
} from "../domain/models";
import type {
  GraphicFileReference,
  GeneratedPlanOutput,
  ImportedOrder,
  CommunicationLanguage,
  ProjectMode,
  ProjectRecord,
  ProjectStage,
  ProjectStatus,
  ExportCalculationOptions,
  Measurement3D,
  PrintSurfaceAssignment,
  SavedCameraView,
  TechnicalRequirements,
  VisualizationItem,
} from "../domain/project";
import {
  createDefaultExportCalculationOptions,
  createDefaultTechnicalRequirements,
  createProjectRecord,
} from "../domain/project";
import { calculateOrderInventory } from "../domain/order";
import { LocalProjectRepository, type ProjectRepository } from "../domain/repository";
import { LocalEventRepository, type EventRepository } from "../domain/eventRepository";
import { saveCameraView } from "../domain/workflow";
import type { Exhibition, PriceList } from "../domain/organizations";
import {
  carpetFinishVariants,
  constructionFinishVariants,
  selectedFinish,
} from "../domain/finishes";
import {
  createCustomDimension,
  dimensionDisplayLabel,
  type CustomDimension,
  type ProjectAnnotation,
} from "../domain/spatialAnnotations";
import {
  planView180ToWorld,
  worldRotationToPlanView180,
  worldToPlanView180,
} from "../domain/planView";
import { getMasterReferenceModel } from "../domain/cad3d";
import {
  componentZIndex,
  moveComponentDisplayOrder,
  scenePlanBounds,
  sortComponentsFor2D,
} from "../domain/displayOrder";
import {
  effectiveFasciaRequirement,
  productionPrintSurfaceDimensions,
} from "../domain/technicalServices";
import { isObjectLocked, toggleUserLock } from "../domain/locking";
import {
  createEmptyNotes,
  notesForEntity,
  updateEntityNotes,
  updateNotes,
  type NoteField,
  type NotesByEntityId,
} from "../domain/notes";
import { toggleVisibility } from "../domain/visibility";
import {
  applySnap as snapPlacement,
  isPlacementValid,
  tryMoveComponent,
} from "../geometry/placement";
import { quickRotation, rotationForMode } from "../geometry/rotation";
import { useBoothViewport } from "../hooks/useBoothViewport";
import { AppSidebar } from "./AppSidebar";
import { StepHeader } from "./StepHeader";
import { ComponentLibrary } from "./configurator/ComponentLibrary";
import { BoothCadViewer } from "./configurator/BoothCadViewer";
import { BoothCadPlanView } from "./configurator/BoothCadPlanView";
import { ConfiguratorHelp } from "./configurator/ConfiguratorHelp";
import { NotesEditor } from "./configurator/NotesEditor";
import { CoordinateInput } from "./configurator/CoordinateInput";
import { PricingBar } from "./configurator/PricingBar";
import { RotationNavigator } from "./configurator/RotationNavigator";
import { ScenePanel } from "./configurator/ScenePanel";
import { ViewportToolbar } from "./configurator/ViewportToolbar";
import { OrderImportPanel } from "./workflow/OrderImportPanel";
import { TechnicalRequirementsEditor } from "./workflow/TechnicalRequirementsEditor";
import {
  BoothCatalogPage,
  ComponentCatalogPage,
  ProjectsPage,
} from "./workflow/AdminPages";
import {
  ExportStep,
  SummaryStep,
  VisualizationStep,
} from "./workflow/WorkflowSteps";
import {
  EventLogo,
  EventsPage,
  PriceListsPage,
} from "./workflow/CatalogManagementPages";
import { dataUrlToFile, uploadAsset, type UploadProgress } from "../lib/storage/assetClient";

export default function BoothGenerator() {
  const repositoryRef = useRef<ProjectRepository | null>(null);
  const eventRepositoryRef = useRef<EventRepository | null>(null);
  const [workspaceSection, setWorkspaceSection] = useState<
    "project" | "projects" | "booths" | "components" | "events" | "priceLists"
  >("project");
  const [adminEvents, setAdminEvents] = useState<Exhibition[]>([...exhibitions]);
  const [eventsHydrated, setEventsHydrated] = useState(false);
  const [eventDirty, setEventDirty] = useState(false);
  const [adminPriceLists, setAdminPriceLists] = useState<PriceList[]>([...priceLists]);
  const [step, setStep] =
    useState(1);

  const [projectId, setProjectId] = useState("");
  const [projectName, setProjectName] = useState("Nový projekt");
  const [boothNumber, setBoothNumber] = useState("");
  const [projectMode, setProjectMode] = useState<ProjectMode>("proposal");
  const [projectStatus, setProjectStatus] = useState<ProjectStatus>("draft");
  const [projectStage, setProjectStage] = useState<ProjectStage>("quote");
  const [communicationLanguage, setCommunicationLanguage] =
    useState<CommunicationLanguage>("cs");
  const [waitingForCustomer, setWaitingForCustomer] = useState(false);
  const [requiresAction, setRequiresAction] = useState(false);
  const [projectCreatedAt, setProjectCreatedAt] = useState("");
  const [technicalRequirements, setTechnicalRequirements] =
    useState<TechnicalRequirements>(() => createDefaultTechnicalRequirements());
  const [importedOrder, setImportedOrder] = useState<ImportedOrder | undefined>();
  const [savedViews, setSavedViews] = useState<SavedCameraView[]>([]);
  const [visualizations, setVisualizations] = useState<VisualizationItem[]>([]);
  const [generatedPlanOutputs, setGeneratedPlanOutputs] =
    useState<GeneratedPlanOutput[]>([]);
  const [selectedOutputIds, setSelectedOutputIds] = useState<string[]>([]);
  const [selectedEventDocumentIds, setSelectedEventDocumentIds] =
    useState<string[]>([]);
  const [selectedVisualizationViewIds, setSelectedVisualizationViewIds] = useState<string[]>([]);
  const [visualizationPurpose, setVisualizationPurpose] = useState<"working" | "presentation">("working");
  const [visualization2DLayers, setVisualization2DLayers] = useState<string[]>(["booth", "furniture", "annotations"]);
  const [graphicsFiles, setGraphicsFiles] = useState<GraphicFileReference[]>([]);
  const [graphicsUpload, setGraphicsUpload] = useState<UploadProgress | undefined>();
  const [carpetFinishId, setCarpetFinishId] = useState("carpet-grey");
  const [constructionFinishId, setConstructionFinishId] =
    useState("construction-white");
  const [annotations, setAnnotations] = useState<ProjectAnnotation[]>([]);
  const [customDimensions, setCustomDimensions] = useState<CustomDimension[]>([]);
  const [measurements3D, setMeasurements3D] = useState<Measurement3D[]>([]);
  const [dimensionOffsets3D, setDimensionOffsets3D] = useState<Record<"width" | "depth" | "height", number>>({ width: 0, depth: 0, height: 0 });
  const [printSurfaceAssignments, setPrintSurfaceAssignments] = useState<PrintSurfaceAssignment[]>([]);
  const [selectedPrintSurfaceId, setSelectedPrintSurfaceId] = useState<string | null>(null);
  const [exportCalculationOptions, setExportCalculationOptions] = useState<ExportCalculationOptions>(() => createDefaultExportCalculationOptions());
  const [editorTool, setEditorTool] =
    useState<"select" | "annotation" | "measure">("select");
  const [pendingMeasurePoint, setPendingMeasurePoint] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [measureHoverPoint, setMeasureHoverPoint] = useState<{ x: number; y: number } | null>(null);
  const [draggingAnnotationId, setDraggingAnnotationId] =
    useState<string | null>(null);
  const [showPlanDimensions, setShowPlanDimensions] = useState(false);
  const temporaryGraphicFilesRef = useRef(new Map<string, File>());
  const [savedProjects, setSavedProjects] = useState<ProjectRecord[]>([]);
  const [saveStatus, setSaveStatus] = useState("");

  const [isSidebarCollapsed, setIsSidebarCollapsed] =
    useState(false);

  const [isHelpOpen, setIsHelpOpen] =
    useState(false);
  const [isProjectInspectorOpen, setIsProjectInspectorOpen] = useState(false);

  const [editorView, setEditorView] =
    useState<"2d" | "3d">("2d");

  const [type, setType] =
    useState<ProjectType>("typovy");

  const [fairId, setFairId] =
    useState("");

  const [company, setCompany] =
    useState("");

  const [contactName, setContactName] =
    useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");

  const [currency, setCurrency] =
    useState<Currency>("CZK");

  const [realizationProfileId, setRealizationProfileId] =
    useState(DEFAULT_REALIZATION_PROFILE_ID);

  const [projectNotes, setProjectNotes] =
    useState<Notes>(() => createEmptyNotes());

  const [isProjectNotesOpen, setIsProjectNotesOpen] =
    useState(false);

  const [assemblyNotes, setAssemblyNotes] =
    useState<Notes>(() => createEmptyNotes());

  const [constructionNotes, setConstructionNotes] =
    useState<NotesByEntityId>({});

  const [
    selectedBoothId,
    setSelectedBoothId,
  ] = useState("");

  const [
    selectedVariantId,
    setSelectedVariantId,
  ] = useState("");

  const [
    placedComponents,
    setPlacedComponents,
  ] = useState<PlacedComponent[]>([]);

  const [
    selectedComponentId,
    setSelectedComponentId,
  ] = useState<string | null>(null);

  const [
    selectedConstructionPartId,
    setSelectedConstructionPartId,
  ] = useState<string | null>(null);

  const [
    constructionUserLocks,
    setConstructionUserLocks,
  ] = useState<Record<string, boolean>>({});

  const [
    constructionVisibility,
    setConstructionVisibility,
  ] = useState<Record<string, boolean>>({});

  const [
    draggingComponentId,
    setDraggingComponentId,
  ] = useState<string | null>(null);

  const [
    editorMessage,
    setEditorMessage,
  ] = useState("");

  useEffect(() => {
    const repository = new LocalProjectRepository(window.localStorage);
    repositoryRef.current = repository;
    repository.list().then((projects) => setSavedProjects([...projects]));
    const eventRepository = new LocalEventRepository(window.localStorage, exhibitions);
    eventRepositoryRef.current = eventRepository;
    eventRepository.list().then((events) => {
      setAdminEvents([...events]);
      setEventsHydrated(true);
    });
  }, []);

  useEffect(() => {
    const cancelTool = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || editorTool === "select") return;
      setEditorTool("select");
      setPendingMeasurePoint(null);
      setMeasureHoverPoint(null);
      setEditorMessage("");
    };
    window.addEventListener("keydown", cancelTool);
    return () => window.removeEventListener("keydown", cancelTool);
  }, [editorTool]);

  function confirmLeaveEvent(): boolean {
    return !eventDirty || window.confirm("Máte neuložené změny. Opravdu chcete pokračovat?");
  }

  function navigateWorkspace(section: typeof workspaceSection) {
    if (workspaceSection === "events" && section !== "events" && !confirmLeaveEvent()) return;
    if (workspaceSection === "events" && section !== "events" && eventDirty) {
      eventRepositoryRef.current?.list().then((events) => setAdminEvents([...events]));
      setEventDirty(false);
    }
    setWorkspaceSection(section);
    if (section === "projects") {
      repositoryRef.current?.list().then((projects) => setSavedProjects([...projects]));
    }
  }

  /* ================================================= */
  /* DERIVED                                          */
  /* ================================================= */

  const selectedExhibition = adminEvents.find((event) => event.id === fairId);
  const selectedFair =
    fairs.find((fair) => fair.id === fairId) ??
    (selectedExhibition
      ? {
          id: selectedExhibition.id,
          name: selectedExhibition.name,
          priceList:
            adminPriceLists.find(
              (list) => list.id === selectedExhibition.defaultPriceListId,
            )?.name ??
            adminPriceLists.find((list) =>
              selectedExhibition.priceListIds.includes(list.id),
            )?.name ??
            "Bez přiřazeného ceníku",
          defaultCurrency: selectedExhibition.defaultCurrency,
          logo: selectedExhibition.logoUrl,
        }
      : undefined);

  const selectedRealizationProfile = realizationProfiles.find(
    (profile) => profile.id === realizationProfileId,
  );

  const hasProjectNotes = Boolean(
    projectNotes.internalNote.trim() || projectNotes.customerNote.trim(),
  );

  const selectedBooth =
    boothTypes.find(
      (booth) =>
        booth.id ===
        selectedBoothId
    );

  const selectedBoothMasterModel = getMasterReferenceModel(
    selectedBooth?.assets,
  );

  const selectedVariant =
    selectedBooth?.variants.find(
      (variant) =>
        variant.id ===
        selectedVariantId
    );

  const selectedPlacedComponent =
    placedComponents.find(
      (component) =>
        component.id ===
        selectedComponentId
    );

  const selectedPlacedComponentLocked =
    selectedPlacedComponent
      ? isObjectLocked(selectedPlacedComponent)
      : false;
  const selectedPrintSurface = selectedBooth?.printSurfaces?.find((surface) => surface.id === selectedPrintSurfaceId);
  const selectedPrintAssignment = printSurfaceAssignments.find((assignment) => assignment.printSurfaceId === selectedPrintSurfaceId);

  useEffect(() => {
    if (!selectedBooth) {
      return;
    }
    setPrintSurfaceAssignments((current) =>
      (selectedBooth.printSurfaces ?? []).map((surface) => {
        const existing = current.find((item) => item.printSurfaceId === surface.id);
        const production = productionPrintSurfaceDimensions(surface, realizationProfileId);
        const included = Boolean(
          selectedBooth.packageContents?.some(
            (item) => item.printSurfaceId === surface.id && item.includedInBasePrice,
          ),
        );
        return {
          printSurfaceId: surface.id,
          sceneReference: selectedBooth.id,
          graphicsKind: existing?.graphicsKind ?? (included ? "fascia" : "fullWrap"),
          artworkStatus: existing?.artworkStatus ?? "missing",
          artworkFileId: existing?.artworkFileId,
          selectedForPrint: existing?.selectedForPrint ?? included,
          canonicalWidthMm: surface.widthMm,
          canonicalHeightMm: surface.heightMm,
          productionWidthMm: production.widthMm,
          productionHeightMm: production.heightMm,
          includedInPackage: included,
          pricedSeparately: !included,
        };
      }),
    );
  }, [realizationProfileId, selectedBooth]);

  const selectedConstructionPart =
    selectedConstructionPartId && selectedConstructionPartId !== "assembly"
      ? selectedBooth?.constructionParts.find(
          (part) => part.id === selectedConstructionPartId,
        )
      : undefined;

  const selectedConstructionName =
    selectedConstructionPartId === "assembly"
      ? selectedBooth?.name
      : selectedConstructionPart?.name;

  const selectedConstructionLayer =
    selectedConstructionPartId === "assembly"
      ? "Sestava"
      : selectedConstructionPart?.planViewType === "overhead"
        ? "Horní konstrukce"
        : "Konstrukce u podlahy";

  const selectedConstructionLocked =
    selectedConstructionPartId === "assembly"
      ? Boolean(
          selectedBooth &&
            (selectedBooth.systemLocked ||
              (constructionUserLocks.assembly ?? selectedBooth.userLocked)),
        )
      : Boolean(
          selectedConstructionPart &&
            (selectedConstructionPart.systemLocked ||
              (constructionUserLocks[selectedConstructionPart.id] ??
                selectedConstructionPart.userLocked)),
        );

  const selectedConstructionNotes =
    selectedConstructionPartId === "assembly"
      ? assemblyNotes
      : selectedConstructionPartId
        ? notesForEntity(constructionNotes, selectedConstructionPartId)
        : undefined;

  const constructionAssemblyVisible = selectedBooth
    ? (constructionVisibility.assembly ?? selectedBooth.visible)
    : true;

  const boothViewport = useBoothViewport({
    worldWidthMm: selectedBooth?.widthMm ?? 2000,
    worldHeightMm: selectedBooth?.depthMm ?? 2000,
    enabled: step === 3 && Boolean(selectedBooth),
  });

  const canOpenConfigurator =
    Boolean(
      selectedBooth &&
        selectedBooth.configReady &&
        (
          selectedBooth.variants.length ===
            0 ||
          selectedVariantId !== ""
        )
    );

  const orderInventory = calculateOrderInventory(
    importedOrder,
    placedComponents,
  );
  const selectedCarpetFinish = selectedFinish(
    selectedBooth?.carpetVariants ?? carpetFinishVariants,
    carpetFinishId,
  );
  const selectedConstructionFinish = selectedFinish(
    selectedBooth?.finishVariants ?? constructionFinishVariants,
    constructionFinishId,
  );

  const workflowStep = step <= 2 ? 1 : step - 1;

  const workflowProject = {
    id: projectId,
    name: projectName,
    fairName: selectedFair?.name ?? "—",
    event: selectedExhibition,
    company,
    contact: { name: contactName, phone: contactPhone, email: contactEmail },
    boothNumber,
    mode: projectMode,
    stage: projectStage,
    communicationLanguage,
    waitingForCustomer,
    requiresAction,
    realizationName: selectedRealizationProfile?.name ?? "—",
    currency,
    booth: selectedBooth,
    sceneObjects: placedComponents,
    requirements: technicalRequirements,
    order: importedOrder,
    inventory: orderInventory,
    savedViews,
    visualizations,
    generatedPlanOutputs,
    selectedOutputIds,
    selectedEventDocumentIds,
    selectedVisualizationViewIds,
    visualizationPurpose,
    visualization2DLayers,
    graphicsFiles,
    annotations,
    customDimensions,
    carpetFinishId,
    constructionFinishId,
    internalNote: projectNotes.internalNote,
    customerNote: projectNotes.customerNote,
    printSurfaceAssignments,
    exportCalculationOptions,
  };

  function ensureProjectStorageId(): string {
    if (projectId) return projectId;
    const id = `project-${crypto.randomUUID()}`;
    setProjectId(id);
    setProjectCreatedAt((current) => current || new Date().toISOString());
    return id;
  }

  async function addPersistentGraphics(files: FileList | readonly File[]) {
    const ownerId = ensureProjectStorageId();
    const batch = Array.from(files);
    const results = await Promise.allSettled(batch.map(async (file) => {
      const asset = await uploadAsset(file, { category: "project-graphics", ownerId }, setGraphicsUpload);
      return {
        id: asset.id,
        name: asset.originalFileName,
        size: asset.size,
        mimeType: asset.mimeType,
        availability: "persistent" as const,
        storageKey: asset.storageKey,
        asset,
        status: "uploaded" as const,
        associatedRequirement: !["unspecified", "notWanted"].includes(technicalRequirements.fullWrapGraphics.status) ? "fullWrap" as const : "fascia" as const,
        printSurfaceId: selectedPrintSurfaceId ?? undefined,
        createdAt: asset.createdAt,
      };
    }));
    const additions = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (additions.length) setGraphicsFiles((current) => [...current, ...additions]);
    batch.forEach((file, index) => {
      if (results[index]?.status === "rejected") temporaryGraphicFilesRef.current.set(`retry-${Date.now()}-${index}`, file);
    });
  }

  async function retryPersistentGraphics() {
    const files = [...temporaryGraphicFilesRef.current.entries()].filter(([id]) => id.startsWith("retry-")).map(([, file]) => file);
    [...temporaryGraphicFilesRef.current.keys()].filter((id) => id.startsWith("retry-")).forEach((id) => temporaryGraphicFilesRef.current.delete(id));
    if (files.length) await addPersistentGraphics(files);
  }

  function removeTemporaryGraphic(id: string) {
    temporaryGraphicFilesRef.current.delete(id);
    setGraphicsFiles((current) => current.filter((file) => file.id !== id));
  }

  async function addPersistentVisualization(item: VisualizationItem) {
    setVisualizations((items) => [...items, item]);
    try {
      const file = await dataUrlToFile(item.imageDataUrl, `${item.id}.png`);
      const asset = await uploadAsset(file, { category: "project-visualization", ownerId: ensureProjectStorageId(), displayName: item.name });
      setVisualizations((items) => items.map((current) => current.id === item.id ? { ...current, asset } : current));
    } catch { /* legacy data URL remains a non-destructive fallback */ }
  }

  async function addPersistentPlanOutput(item: GeneratedPlanOutput) {
    setGeneratedPlanOutputs((items) => [...items, item]);
    setSelectedOutputIds((items) => [...items, item.id]);
    try {
      const file = await dataUrlToFile(item.imageDataUrl, `${item.id}.png`);
      const asset = await uploadAsset(file, { category: "project-floorplan", ownerId: ensureProjectStorageId(), displayName: item.name });
      setGeneratedPlanOutputs((items) => items.map((current) => current.id === item.id ? { ...current, asset } : current));
    } catch { /* legacy data URL remains a non-destructive fallback */ }
  }

  function pointFromPlanPointer(
    event: Pick<ReactPointerEvent<HTMLElement>, "clientX" | "clientY">,
    element: HTMLElement,
  ) {
    if (!selectedBooth?.widthMm || !selectedBooth.depthMm) return null;
    const canvas = element.closest(".boothCanvas") as HTMLElement | null;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const display = {
      x: Math.max(0, Math.min(selectedBooth.widthMm, ((event.clientX - rect.left) / rect.width) * selectedBooth.widthMm)),
      y: Math.max(0, Math.min(selectedBooth.depthMm, ((event.clientY - rect.top) / rect.height) * selectedBooth.depthMm)),
    };
    const world = planView180ToWorld(display, selectedBooth.widthMm, selectedBooth.depthMm);
    return { x: Math.round(world.x / 40) * 40, y: Math.round(world.y / 40) * 40 };
  }

  function handlePlanToolPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (editorTool === "select") return;
    if ((event.target as HTMLElement).closest(".placedComponent,.planAnnotation,.customDimensionLabel")) return;
    const point = pointFromPlanPointer(event, event.currentTarget);
    if (!point) return;
    if (editorTool === "annotation") {
      const text = window.prompt("Text poznámky");
      if (text?.trim()) {
        setAnnotations((items) => [...items, { id: `annotation-${Date.now()}`, text: text.trim(), position: point, visible: true, textSize: "medium", createdAt: new Date().toISOString() }]);
      }
      setEditorTool("select");
      return;
    }
    if (!pendingMeasurePoint) {
      setPendingMeasurePoint(point);
      setMeasureHoverPoint(point);
      setEditorMessage("Klikněte na druhý bod");
    } else {
      setCustomDimensions((items) => [...items, createCustomDimension(`dimension-${Date.now()}`, pendingMeasurePoint, point)]);
      setPendingMeasurePoint(null);
      setMeasureHoverPoint(null);
      setEditorTool("select");
      setEditorMessage("");
    }
  }

  function handlePlanToolPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (editorTool !== "measure") return;
    const point = pointFromPlanPointer(event, event.currentTarget);
    if (point) setMeasureHoverPoint(point);
  }

  function handleAnnotationPointerMove(
    event: ReactPointerEvent<HTMLElement>,
    annotationId: string,
  ) {
    if (draggingAnnotationId !== annotationId) return;
    const point = pointFromPlanPointer(event, event.currentTarget);
    if (!point) return;
    setAnnotations((items) => items.map((item) => item.id === annotationId ? { ...item, position: point } : item));
  }

  /* ================================================= */
  /* PROJECT                                          */
  /* ================================================= */

  function handleFairChange(
    id: string
  ) {
    setFairId(id);

    const fair = adminEvents.find((item) => item.id === id);

    if (fair) {
      setCurrency(
        fair.defaultCurrency
      );
      if (fair.realizationCompanyId) {
        setRealizationProfileId(fair.realizationCompanyId);
      }
    } else {
      setCurrency("CZK");
    }
  }

  function handleBoothSelect(
    boothId: string
  ) {
    const booth = boothTypes.find((item) => item.id === boothId);
    setSelectedBoothId(
      boothId
    );

    setSelectedVariantId("");
    setEditorView("2d");

    setPlacedComponents([]);
    setSelectedComponentId(null);
    setSelectedConstructionPartId(null);
    setConstructionUserLocks({});
    setConstructionVisibility({});
    setCarpetFinishId(
      booth?.defaultCarpetFinishId ??
      (booth?.carpetVariants?.some((finish) => finish.id === "carpet-grey")
        ? "carpet-grey"
        : "none")
    );
    setConstructionFinishId("construction-white");
    setAssemblyNotes(createEmptyNotes());
    setConstructionNotes({});
    setMeasurements3D([]);
    setSelectedPrintSurfaceId(null);
    setPrintSurfaceAssignments((booth?.printSurfaces ?? []).map((surface) => {
      const production = productionPrintSurfaceDimensions(surface, realizationProfileId);
      const included = Boolean(booth?.packageContents?.some((item) => item.printSurfaceId === surface.id && item.includedInBasePrice));
      return {
        printSurfaceId: surface.id,
        sceneReference: booth?.id ?? "booth",
        graphicsKind: included ? "fascia" as const : "fullWrap" as const,
        artworkStatus: "missing" as const,
        selectedForPrint: included,
        canonicalWidthMm: surface.widthMm,
        canonicalHeightMm: surface.heightMm,
        productionWidthMm: production.widthMm,
        productionHeightMm: production.heightMm,
        includedInPackage: included,
        pricedSeparately: !included,
      };
    }));

    setEditorMessage("");
  }

  function handleVariantSelect(variantId: string) {
    if (variantId === selectedVariantId) {
      return;
    }

    setSelectedVariantId(variantId);
    setAssemblyNotes(createEmptyNotes());
    setConstructionNotes({});
  }

  function startNewProject() {
    if (workspaceSection === "events" && !confirmLeaveEvent()) return;
    if (workspaceSection === "events" && eventDirty) {
      eventRepositoryRef.current?.list().then((events) => setAdminEvents([...events]));
      setEventDirty(false);
    }
    setWorkspaceSection("project");
    setStep(1);

    setProjectId("");
    setProjectName("Nový projekt");
    setBoothNumber("");
    setProjectMode("proposal");
    setProjectStatus("draft");
    setProjectStage("quote");
    setCommunicationLanguage("cs");
    setWaitingForCustomer(false);
    setRequiresAction(false);
    setProjectCreatedAt("");
    setTechnicalRequirements(createDefaultTechnicalRequirements());
    setImportedOrder(undefined);
    setSavedViews([]);
    setVisualizations([]);
    setGeneratedPlanOutputs([]);
    setSelectedOutputIds([]);
    setSelectedEventDocumentIds([]);
    setSelectedVisualizationViewIds([]);
    setVisualizationPurpose("working");
    setVisualization2DLayers(["booth", "furniture", "annotations"]);
    setGraphicsFiles([]);
    setCarpetFinishId("carpet-grey");
    setConstructionFinishId("construction-white");
    setAnnotations([]);
    setCustomDimensions([]);
    setMeasurements3D([]);
    setDimensionOffsets3D({ width: 0, depth: 0, height: 0 });
    setPrintSurfaceAssignments([]);
    setSelectedPrintSurfaceId(null);
    setExportCalculationOptions(createDefaultExportCalculationOptions());
    setEditorTool("select");
    setPendingMeasurePoint(null);
    temporaryGraphicFilesRef.current.clear();
    setSaveStatus("");

    setType("typovy");
    setEditorView("2d");

    setFairId("");
    setCompany("");
    setContactName("");
    setContactPhone("");
    setContactEmail("");

    setCurrency("CZK");
    setRealizationProfileId(DEFAULT_REALIZATION_PROFILE_ID);
    setProjectNotes(createEmptyNotes());
    setIsProjectNotesOpen(false);
    setAssemblyNotes(createEmptyNotes());
    setConstructionNotes({});

    setSelectedBoothId("");
    setSelectedVariantId("");

    setPlacedComponents([]);
    setSelectedComponentId(null);
    setSelectedConstructionPartId(null);
    setConstructionUserLocks({});
    setConstructionVisibility({});

    setDraggingComponentId(null);

    setEditorMessage("");
  }

  function projectSnapshot(id = projectId || crypto.randomUUID()): ProjectRecord {
    const now = new Date().toISOString();
    return createProjectRecord({
      id,
      name: projectName,
      fairId,
      company,
      contact: {
        name: contactName,
        phone: contactPhone,
        email: contactEmail,
      },
      boothNumber,
      boothId: selectedBoothId,
      variantId: selectedVariantId,
      realizationProfileId,
      communicationLanguage,
      currency,
      createdAt: projectCreatedAt || now,
      modifiedAt: now,
      status: projectStatus,
      stage: projectStage,
      waitingForCustomer,
      requiresAction,
      mode: projectMode,
      projectType: type,
      notes: projectNotes,
      assemblyNotes,
      constructionNotes,
      constructionUserLocks,
      constructionVisibility,
      technicalRequirements,
      importedOrder,
      sceneObjects: placedComponents,
      savedViews,
      visualizations,
      generatedPlanOutputs,
      selectedOutputIds,
      selectedEventDocumentIds,
      selectedVisualizationViewIds,
      visualizationPurpose,
      visualization2DLayers,
      graphicsFiles,
      carpetFinishId,
      constructionFinishId,
      annotations,
      customDimensions,
      measurements3D,
      dimensionOffsets3D,
      printSurfaceAssignments,
      exportCalculationOptions,
    }, now);
  }

  async function saveProject() {
    const repository = repositoryRef.current;
    if (!repository) return;
    const snapshot = projectSnapshot();
    setProjectId(snapshot.id);
    setProjectCreatedAt(snapshot.createdAt);
    await repository.save(snapshot);
    setSavedProjects([...(await repository.list())]);
    setSaveStatus("Uloženo");
    window.setTimeout(() => setSaveStatus(""), 1400);
  }

  function openProject(project: ProjectRecord) {
    setProjectId(project.id);
    setProjectName(project.name);
    setFairId(project.fairId);
    setCompany(project.company);
    setContactName(project.contact.name);
    setContactPhone(project.contact.phone);
    setContactEmail(project.contact.email);
    setBoothNumber(project.boothNumber);
    setSelectedBoothId(project.boothId);
    setSelectedVariantId(project.variantId);
    setRealizationProfileId(project.realizationProfileId);
    setCommunicationLanguage(project.communicationLanguage);
    setCurrency(project.currency);
    setProjectCreatedAt(project.createdAt);
    setProjectStatus(project.status);
    setProjectStage(project.stage);
    setWaitingForCustomer(project.waitingForCustomer);
    setRequiresAction(project.requiresAction);
    setProjectMode(project.mode);
    setType(project.projectType);
    setProjectNotes(project.notes);
    setAssemblyNotes(project.assemblyNotes);
    setConstructionNotes({ ...project.constructionNotes });
    setConstructionUserLocks({ ...project.constructionUserLocks });
    setConstructionVisibility({ ...project.constructionVisibility });
    setTechnicalRequirements(project.technicalRequirements);
    setImportedOrder(project.importedOrder);
    setPlacedComponents([...project.sceneObjects]);
    setSavedViews([...project.savedViews]);
    setVisualizations([...project.visualizations]);
    setGeneratedPlanOutputs([...project.generatedPlanOutputs]);
    setSelectedOutputIds([...project.selectedOutputIds]);
    setSelectedEventDocumentIds([...project.selectedEventDocumentIds]);
    setSelectedVisualizationViewIds([...project.selectedVisualizationViewIds]);
    setVisualizationPurpose(project.visualizationPurpose);
    setVisualization2DLayers([...project.visualization2DLayers]);
    setGraphicsFiles([...project.graphicsFiles]);
    setCarpetFinishId(project.carpetFinishId);
    setConstructionFinishId(project.constructionFinishId);
    setAnnotations([...project.annotations]);
    setCustomDimensions([...project.customDimensions]);
    setMeasurements3D([...project.measurements3D]);
    setDimensionOffsets3D({ ...project.dimensionOffsets3D });
    setPrintSurfaceAssignments([...project.printSurfaceAssignments]);
    setExportCalculationOptions(project.exportCalculationOptions);
    setSelectedPrintSurfaceId(null);
    temporaryGraphicFilesRef.current.clear();
    setSelectedComponentId(null);
    setSelectedConstructionPartId(null);
    setWorkspaceSection("project");
    setStep(project.boothId ? 3 : 1);
  }

  async function deleteProject(projectToDeleteId: string) {
    const repository = repositoryRef.current;
    if (!repository) return;
    await repository.delete(projectToDeleteId);
    setSavedProjects([...(await repository.list())]);
  }

  function selectWorkflowStep(target: number) {
    if (workspaceSection === "events" && !confirmLeaveEvent()) return;
    if (workspaceSection === "events" && eventDirty) {
      eventRepositoryRef.current?.list().then((events) => setAdminEvents([...events]));
      setEventDirty(false);
    }
    setWorkspaceSection("project");
    if (target === 1) setStep(1);
    else if (target === 2) setStep(selectedBooth?.configReady ? 3 : 2);
    else setStep(target + 1);
  }

  /* ================================================= */
  /* COLLISION                                        */
  /* ================================================= */



  function isPositionValid(
    component: PlacedComponent,
    centerX: number,
    centerY: number,
    rotationDeg: number
  ) {
    return selectedBooth
      ? isPlacementValid(selectedBooth, component, {
          x: centerX,
          y: centerY,
          rotationDeg,
        })
      : false;
  }

  /* ================================================= */
  /* SNAP                                             */
  /* ================================================= */

  function applySnap(
    component: PlacedComponent,
    centerX: number,
    centerY: number,
    rotationDeg: number
  ) {
    return selectedBooth
      ? snapPlacement(
          selectedBooth,
          component,
          centerX,
          centerY,
          rotationDeg
        )
      : { x: centerX, y: centerY };
  }

  /* ================================================= */
  /* ADD COMPONENTS                                   */
  /* ================================================= */

  function addComponent(definition: ComponentDefinition) {
    const component = placeComponent(
      definition,
      `${definition.type}-${Date.now()}`,
      1000,
      1500
    );

    setPlacedComponents((items) => [...items, component]);
    setSelectedComponentId(component.id);
    setSelectedConstructionPartId(null);
    setEditorMessage("");
  }

  /* ================================================= */
  /* MOVE                                             */
  /* ================================================= */

  function handleComponentPointerDown(
    event: ReactPointerEvent<HTMLButtonElement>,
    componentId: string
  ) {
    if (
      event.button !== 0 ||
      boothViewport.isSpacePressed ||
      editorTool !== "select"
    ) {
      return;
    }

    const component = placedComponents.find(
      (item) => item.id === componentId
    );

    event.stopPropagation();

    setSelectedComponentId(
      componentId
    );
    setSelectedConstructionPartId(null);

    if (!component || isObjectLocked(component)) {
      setDraggingComponentId(null);
      setEditorMessage("");
      return;
    }

    setDraggingComponentId(
      componentId
    );

    setEditorMessage("");

    event.currentTarget.setPointerCapture(
      event.pointerId
    );
  }

  function handleComponentPointerMove(
    event: ReactPointerEvent<HTMLButtonElement>,
    componentId: string
  ) {
    if (
      draggingComponentId !==
        componentId ||
      !selectedBooth?.widthMm ||
      !selectedBooth.depthMm
    ) {
      return;
    }

    const component =
      placedComponents.find(
        (item) =>
          item.id ===
          componentId
      );

    if (!component) {
      return;
    }

    if (isObjectLocked(component)) {
      setDraggingComponentId(null);
      return;
    }

    const displayPointer = boothViewport.clientToWorld(
      event.clientX,
      event.clientY
    );

    if (!displayPointer) {
      return;
    }

    const pointer = planView180ToWorld(
      displayPointer,
      selectedBooth.widthMm,
      selectedBooth.depthMm,
    );

    const snapped =
      applySnap(
        component,

        pointer.x,
        pointer.y,

        component.rotationDeg
      );

    const moveComponent = (movedComponent: PlacedComponent) => {
      setPlacedComponents((items) =>
        items.map((item) =>
          item.id === componentId ? movedComponent : item
        )
      );
    };

    const directMove = tryMoveComponent(
      selectedBooth,
      component,
      Math.round(snapped.x),
      Math.round(snapped.y),
    );

    if (directMove.accepted) {
      moveComponent(directMove.component);

      setEditorMessage("");

      return;
    }

    /*
      2. Pokud je tam překážka,
      zkusíme sklouznout pouze po X.
    */

    const xOnlyMove = tryMoveComponent(
      selectedBooth,
      component,
      Math.round(snapped.x),
      component.yMm,
    );

    if (xOnlyMove.accepted) {
      moveComponent(xOnlyMove.component);

      setEditorMessage(
        "Konstrukce blokuje pohyb v ose Y."
      );

      return;
    }

    /*
      3. Potom pouze Y.
    */

    const yOnlyMove = tryMoveComponent(
      selectedBooth,
      component,
      component.xMm,
      Math.round(snapped.y),
    );

    if (yOnlyMove.accepted) {
      moveComponent(yOnlyMove.component);

      setEditorMessage(
        "Konstrukce blokuje pohyb v ose X."
      );

      return;
    }

    /*
      4. Jinak objekt zůstane stát.
    */

    setEditorMessage(
      "Kolize s konstrukcí – objekt tudy neprojde."
    );
  }

  function handleComponentPointerUp(
    event: ReactPointerEvent<HTMLButtonElement>
  ) {
    setDraggingComponentId(
      null
    );

    if (
      event.currentTarget.hasPointerCapture(
        event.pointerId
      )
    ) {
      event.currentTarget.releasePointerCapture(
        event.pointerId
      );
    }
  }

  function handleViewportPointerDown(
    event: ReactPointerEvent<HTMLDivElement>
  ) {
    if (boothViewport.startPan(event)) {
      return;
    }

    if (editorTool !== "select") return;

    if (event.button === 0) {
      setSelectedComponentId(null);
      setSelectedConstructionPartId(null);
      setEditorMessage("");
    }
  }

  /* ================================================= */
  /* ROTATION                                         */
  /* ================================================= */

  function setSelectedRotation(
    requestedAngle: number
  ) {
    if (
      !selectedPlacedComponent ||
      isObjectLocked(selectedPlacedComponent)
    ) {
      return;
    }

    const newAngle = rotationForMode(
      selectedPlacedComponent.rotation,
      selectedPlacedComponent.rotationMode,
      requestedAngle,
      selectedPlacedComponent.rotationDeg
    );

    if (
      selectedPlacedComponent.rotation.locked ||
      newAngle === selectedPlacedComponent.rotationDeg
    ) {
      return;
    }

    const valid = isPositionValid(
      selectedPlacedComponent,
      selectedPlacedComponent.xMm,
      selectedPlacedComponent.yMm,
      newAngle
    );

    if (!valid) {
      setEditorMessage(
        "Rotaci blokuje konstrukce nebo hranice stánku."
      );
      return;
    }

    setPlacedComponents((items) =>
      items.map((item) =>
        item.id === selectedPlacedComponent.id
          ? { ...item, rotationDeg: newAngle }
          : item
      )
    );
    setEditorMessage("");
  }

  function setSelectedQuickRotation(
    requestedAngle: number
  ) {
    if (
      !selectedPlacedComponent ||
      isObjectLocked(selectedPlacedComponent)
    ) {
      return;
    }

    const newAngle = quickRotation(
      selectedPlacedComponent.rotation,
      requestedAngle,
      selectedPlacedComponent.rotationDeg
    );

    if (
      selectedPlacedComponent.rotation.locked ||
      newAngle === selectedPlacedComponent.rotationDeg
    ) {
      return;
    }

    if (
      !isPositionValid(
        selectedPlacedComponent,
        selectedPlacedComponent.xMm,
        selectedPlacedComponent.yMm,
        newAngle
      )
    ) {
      setEditorMessage(
        "Rotaci blokuje konstrukce nebo hranice stánku."
      );
      return;
    }

    setPlacedComponents((items) =>
      items.map((item) =>
        item.id === selectedPlacedComponent.id
          ? { ...item, rotationDeg: newAngle }
          : item
      )
    );
    setEditorMessage("");
  }

  function setSelectedRotationMode(
    mode: RotationControlMode
  ) {
    if (
      !selectedPlacedComponent ||
      isObjectLocked(selectedPlacedComponent) ||
      selectedPlacedComponent.rotation.locked ||
      (mode === "free" &&
        !selectedPlacedComponent.rotation.allowFreeRotation)
    ) {
      return;
    }

    setPlacedComponents((items) =>
      items.map((item) =>
        item.id === selectedPlacedComponent.id
          ? { ...item, rotationMode: mode }
          : item
      )
    );
  }



  /* ================================================= */
  /* DUPLICATE / DELETE                               */
  /* ================================================= */

  function duplicateSelectedComponent() {
    if (
      !selectedPlacedComponent ||
      isObjectLocked(selectedPlacedComponent)
    ) {
      return;
    }

    const clone: PlacedComponent = {
      ...selectedPlacedComponent,

      id:
        selectedPlacedComponent.type +
        "-" +
        Date.now(),

      name:
        selectedPlacedComponent.name,

      xMm:
        selectedPlacedComponent.xMm +
        120,

      yMm:
        selectedPlacedComponent.yMm +
        120,
    };

    const snapped =
      applySnap(
        clone,

        clone.xMm,
        clone.yMm,

        clone.rotationDeg
      );

    const valid =
      isPositionValid(
        clone,

        snapped.x,
        snapped.y,

        clone.rotationDeg
      );

    if (valid) {
      clone.xMm =
        Math.round(
          snapped.x
        );

      clone.yMm =
        Math.round(
          snapped.y
        );
    } else {
      clone.xMm =
        selectedPlacedComponent.xMm;

      clone.yMm =
        selectedPlacedComponent.yMm;
    }

    setPlacedComponents(
      (items) => [
        ...items,
        clone,
      ]
    );

    setSelectedComponentId(
      clone.id
    );
    setSelectedConstructionPartId(null);

    setEditorMessage("");
  }

  function deleteSelectedComponent() {
    if (
      !selectedComponentId ||
      selectedPlacedComponentLocked
    ) {
      return;
    }

    setPlacedComponents(
      (items) =>
        items.filter(
          (item) =>
            item.id !==
            selectedComponentId
        )
    );

    setSelectedComponentId(
      null
    );

    setEditorMessage("");
  }

  function commitSelectedCoordinate(
    axis: "x" | "y",
    valueMm: number,
  ): boolean {
    if (!selectedBooth || !selectedPlacedComponent) {
      return false;
    }

    const move = tryMoveComponent(
      selectedBooth,
      selectedPlacedComponent,
      axis === "x" ? valueMm : selectedPlacedComponent.xMm,
      axis === "y" ? valueMm : selectedPlacedComponent.yMm,
    );

    if (!move.accepted) {
      setEditorMessage(
        move.reason === "locked"
          ? "Objekt je zamčený a jeho pozici nelze změnit."
          : "Neplatná pozice – objekt zůstává na původním místě.",
      );
      return false;
    }

    setPlacedComponents((items) =>
      items.map((item) =>
        item.id === move.component.id ? move.component : item
      )
    );
    setEditorMessage("");

    return true;
  }

  function selectSceneComponent(componentId: string) {
    setSelectedComponentId(componentId);
    setSelectedConstructionPartId(null);
    setEditorMessage("");
  }

  function selectConstructionPart(partId: string) {
    setSelectedComponentId(null);
    setSelectedConstructionPartId(partId);
    setEditorMessage("");
  }

  function toggleComponentLock(componentId: string) {
    setPlacedComponents((items) =>
      items.map((item) =>
        item.id === componentId
          ? toggleUserLock(item)
          : item
      )
    );
  }

  function toggleComponentVisibility(componentId: string) {
    setPlacedComponents((items) =>
      items.map((item) =>
        item.id === componentId
          ? toggleVisibility(item)
          : item
      )
    );
  }

  function updateSelectedComponentNote(
    field: NoteField,
    value: string,
  ) {
    if (!selectedComponentId) {
      return;
    }

    setPlacedComponents((items) =>
      items.map((item) =>
        item.id === selectedComponentId
          ? { ...item, ...updateNotes(item, field, value) }
          : item
      )
    );
  }

  function updateProjectNote(field: NoteField, value: string) {
    setProjectNotes((notes) => updateNotes(notes, field, value));
  }

  function updateSelectedConstructionNote(
    field: NoteField,
    value: string,
  ) {
    if (selectedConstructionPartId === "assembly") {
      setAssemblyNotes((notes) => updateNotes(notes, field, value));
      return;
    }

    if (selectedConstructionPartId) {
      setConstructionNotes((notesById) =>
        updateEntityNotes(
          notesById,
          selectedConstructionPartId,
          field,
          value,
        )
      );
    }
  }

  function toggleConstructionLock(partId: string) {
    if (!selectedBooth) {
      return;
    }

    const lockDefinition =
      partId === "assembly"
        ? selectedBooth
        : selectedBooth.constructionParts.find(
            (part) => part.id === partId
          );

    if (!lockDefinition || lockDefinition.systemLocked) {
      return;
    }

    setConstructionUserLocks((locks) => ({
      ...locks,
      [partId]: !(locks[partId] ?? lockDefinition.userLocked),
    }));
  }

  function toggleConstructionVisibility(partId: string) {
    if (!selectedBooth) {
      return;
    }

    const definition =
      partId === "assembly"
        ? selectedBooth
        : selectedBooth.constructionParts.find(
            (part) => part.id === partId
          );

    if (!definition) {
      return;
    }

    setConstructionVisibility((visibility) => ({
      ...visibility,
      [partId]: !(visibility[partId] ?? definition.visible),
    }));
  }

  function resetConfigurator() {
    setPlacedComponents([]);
    setSelectedComponentId(null);
    setSelectedConstructionPartId(null);
    setConstructionUserLocks({});
    setConstructionVisibility({});
    setAssemblyNotes(createEmptyNotes());
    setConstructionNotes({});

    setEditorMessage("");
  }

  /* ================================================= */
  /* RENDER                                           */
  /* ================================================= */

  return (
    <main
      className={
        isSidebarCollapsed
          ? "shell sidebarCollapsed"
          : "shell"
      }
    >
      {/* ================================================= */}
      {/* SIDEBAR                                         */}
      {/* ================================================= */}

      <AppSidebar
        collapsed={isSidebarCollapsed}
        onToggleCollapsed={() =>
          setIsSidebarCollapsed((collapsed) => !collapsed)
        }
        onStartNewProject={startNewProject}
        activeSection={workspaceSection}
        onNavigate={navigateWorkspace}
      />

      {/* ================================================= */}
      {/* MAIN                                            */}
      {/* ================================================= */}

      <section className="main">
        {/* ================================================= */}
        {/* TOPBAR                                         */}
        {/* ================================================= */}

        <StepHeader
          currentStep={workflowStep}
          onStepSelect={selectWorkflowStep}
          onSave={workspaceSection === "project" ? saveProject : undefined}
          saveStatus={saveStatus}
        />

        {workspaceSection === "projects" && (
          <ProjectsPage
            projects={savedProjects}
            fairName={(id) => adminEvents.find((event) => event.id === id)?.name ?? id}
            boothName={(id) => boothTypes.find((booth) => booth.id === id)?.name ?? ""}
            onOpen={openProject}
            onDelete={deleteProject}
            onNew={startNewProject}
          />
        )}

        {workspaceSection === "booths" && <BoothCatalogPage booths={boothTypes} />}

        {workspaceSection === "components" && (
          <ComponentCatalogPage items={componentCatalogItems} />
        )}

        {workspaceSection === "events" && eventsHydrated && (
          <EventsPage
            events={adminEvents}
            priceLists={adminPriceLists}
            onChange={setAdminEvents}
            onDirtyChange={setEventDirty}
            onSave={async (event) => {
              await eventRepositoryRef.current?.save(event);
              setAdminEvents((events) => events.map((item) => item.id === event.id ? event : item));
            }}
          />
        )}

        {workspaceSection === "priceLists" && (
          <PriceListsPage
            priceLists={adminPriceLists}
            onChange={setAdminPriceLists}
          />
        )}

        {/* ================================================= */}
        {/* STEP 1                                          */}
        {/* ================================================= */}

        {workspaceSection === "project" && step === 1 && (
          <div className="page">
            <div className="pageIntro">
              <div>
                <span className="eyebrow">
                  NOVÝ PROJEKT
                </span>

                <h1>
                  Vytvořit nový stánek
                </h1>

                <p>
                  Zadej základní informace.
                  Veletrh určuje ceník,
                  výchozí měnu a později také
                  logo a další pravidla projektu.
                </p>
              </div>

              <div className="projectNumber">
                <span>
                  PROJEKT
                </span>

                <strong>
                  NEW
                </strong>
              </div>
            </div>

            <div className="contentGrid">
              <section className="card formCard">
                <div className="cardHeader">
                  <div>
                    <span className="cardNumber">
                      01
                    </span>

                    <h2>
                      Informace o projektu
                    </h2>
                  </div>

                  <span className="required">
                    ZÁKLADNÍ ÚDAJE
                  </span>
                </div>

                <div className="form">
                  <label>
                    <span>
                      Veletrh
                    </span>

                    <select
                      value={fairId}
                      onChange={(event) =>
                        handleFairChange(
                          event.target.value
                        )
                      }
                    >
                      <option value="">
                        Vyber veletrh
                      </option>

                      {adminEvents.filter((event) => event.active).map(
                        (fair) => (
                          <option
                            key={
                              fair.id
                            }
                            value={
                              fair.id
                            }
                          >
                            {
                              fair.name
                            }
                          </option>
                        )
                      )}
                    </select>
                  </label>

                  {selectedFair && (
                    <div className="fairInfo">
                      <div>
                        <span>
                          CENÍK
                        </span>

                        <strong>
                          {
                            selectedFair.priceList
                          }
                        </strong>
                      </div>

                      <div>
                        <span>
                          VÝCHOZÍ MĚNA
                        </span>

                        <strong>
                          {
                            selectedFair.defaultCurrency
                          }
                        </strong>
                      </div>

                      <div>
                        <span>
                          LOGO
                        </span>

                        <strong>
                          Přiřazeno k veletrhu
                        </strong>
                      </div>
                    </div>
                  )}

                  {selectedExhibition && (
                    <div className="projectEventCard">
                      <EventLogo event={selectedExhibition} compact />
                      <div>
                        <span>VÝSTAVA / EVENT</span>
                        <strong>{selectedExhibition.name}</strong>
                        <small>
                          {selectedExhibition.venue || "Místo neuvedeno"}
                          {selectedExhibition.eventFrom || selectedExhibition.eventTo
                            ? ` · ${selectedExhibition.eventFrom || "?"}–${selectedExhibition.eventTo || "?"}`
                            : ""}
                        </small>
                        {selectedExhibition.importantInfo && (
                          <p>{selectedExhibition.importantInfo}</p>
                        )}
                      </div>
                    </div>
                  )}

                  <div className="twoColumns">
                    <label>
                      <span>Název projektu</span>
                      <input
                        value={projectName}
                        onChange={(event) => setProjectName(event.target.value)}
                        placeholder="Interní název projektu"
                      />
                    </label>
                    <label>
                      <span>Číslo / označení stánku</span>
                      <input
                        value={boothNumber}
                        onChange={(event) => setBoothNumber(event.target.value)}
                        placeholder="Např. Hala 2 / B14"
                      />
                    </label>
                  </div>

                  <div className="twoColumns">
                    <label>
                      <span>
                        Firma / vystavovatel
                      </span>

                      <input
                        value={company}
                        onChange={(event) =>
                          setCompany(
                            event.target.value
                          )
                        }
                        placeholder="Název společnosti"
                      />
                    </label>

                    <label><span>Kontaktní osoba</span><input value={contactName} onChange={(event) => setContactName(event.target.value)} placeholder="Jméno" /></label>
                  </div>

                  <div className="twoColumns">
                    <label><span>Telefon</span><input type="tel" value={contactPhone} onChange={(event) => setContactPhone(event.target.value)} placeholder="+420…" /></label>
                    <label><span>E-mail</span><input type="email" value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} placeholder="kontakt@firma.cz" /></label>
                  </div>

                  <div className="twoColumns">
                    <label>
                      <span>Režim projektu</span>
                      <select
                        value={projectMode}
                        onChange={(event) => setProjectMode(event.target.value as ProjectMode)}
                      >
                        <option value="proposal">Návrh / kalkulace</option>
                        <option value="order">Objednávka</option>
                        <option value="production">Realizace / hotová zakázka</option>
                      </select>
                    </label>
                    <label>
                      <span>Jazyk komunikace</span>
                      <select
                        value={communicationLanguage}
                        onChange={(event) =>
                          setCommunicationLanguage(
                            event.target.value as CommunicationLanguage,
                          )
                        }
                      >
                        <option value="cs">Čeština</option>
                        <option value="en">English</option>
                      </select>
                    </label>
                  </div>

                  <div className="twoColumns">
                    <label>
                      <span>Stav zakázky</span>
                      <select
                        value={projectStage}
                        onChange={(event) => setProjectStage(event.target.value as ProjectStage)}
                      >
                        <option value="quote">Nabídka / Kalkulace</option>
                        <option value="design">Návrh</option>
                        <option value="approved">Odsouhlaseno</option>
                        <option value="done">Hotovo</option>
                      </select>
                    </label>
                    <label>
                      <span>Měna</span>
                      <select value={currency} onChange={(event) => setCurrency(event.target.value as Currency)}>
                        <option value="CZK">CZK</option>
                        <option value="EUR">EUR</option>
                      </select>
                    </label>
                  </div>

                  <div className="projectFlags">
                    <label><input type="checkbox" checked={waitingForCustomer} onChange={(event) => setWaitingForCustomer(event.target.checked)} /> Čeká na zákazníka</label>
                    <label><input type="checkbox" checked={requiresAction} onChange={(event) => setRequiresAction(event.target.checked)} /> Vyžaduje naši akci</label>
                  </div>

                  <label className="realizationField">
                    <span>Realizačka</span>
                    <select
                      value={realizationProfileId}
                      onChange={(event) =>
                        setRealizationProfileId(event.target.value)
                      }
                    >
                      {realizationProfiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name}
                        </option>
                      ))}
                    </select>
                    <small>
                      Ovlivní pouze budoucí výrobní a exportní rozměry.
                    </small>
                  </label>

                  <div className="projectNotesDisclosure">
                    <button
                      type="button"
                      className="projectNotesToggle"
                      aria-expanded={isProjectNotesOpen}
                      onClick={() => setIsProjectNotesOpen((open) => !open)}
                    >
                      <span>Poznámky k projektu</span>

                      <span className="projectNotesToggleMeta">
                        {hasProjectNotes && (
                          <span className="projectNotesStatus">Vyplněno</span>
                        )}
                        <span
                          className={
                            isProjectNotesOpen
                              ? "projectNotesChevron open"
                              : "projectNotesChevron"
                          }
                          aria-hidden="true"
                        />
                      </span>
                    </button>

                    {isProjectNotesOpen && (
                      <NotesEditor
                        notes={projectNotes}
                        className="projectNotesEditor"
                        onChange={updateProjectNote}
                      />
                    )}
                  </div>

                  <section className="projectFormSection">
                    <span className="fieldTitle">TECHNICKÉ POŽADAVKY</span>
                    <TechnicalRequirementsEditor
                      value={technicalRequirements}
                      onChange={setTechnicalRequirements}
                    />
                  </section>

                  <OrderImportPanel
                    order={importedOrder}
                    onChange={setImportedOrder}
                  />

                  <div className="currencySection">
                    <span className="fieldTitle">
                      Měna projektu
                    </span>

                    <div className="currencyButtons">
                      <button
                        type="button"
                        className={
                          currency ===
                          "CZK"
                            ? "currencyButton selected"
                            : "currencyButton"
                        }
                        onClick={() =>
                          setCurrency(
                            "CZK"
                          )
                        }
                      >
                        <strong>
                          CZK
                        </strong>

                        <span>
                          Kč
                        </span>
                      </button>

                      <button
                        type="button"
                        className={
                          currency ===
                          "EUR"
                            ? "currencyButton selected"
                            : "currencyButton"
                        }
                        onClick={() =>
                          setCurrency(
                            "EUR"
                          )
                        }
                      >
                        <strong>
                          EUR
                        </strong>

                        <span>
                          €
                        </span>
                      </button>
                    </div>

                    <p className="currencyHint">
                      Výchozí měna se nastaví podle veletrhu,
                      ale můžeš ji pro konkrétní projekt změnit.
                    </p>
                  </div>

                  <div className="projectType">
                    <span className="fieldTitle">
                      Typ projektu
                    </span>

                    <div className="typeCards">
                      <button
                        type="button"
                        className={
                          type ===
                          "typovy"
                            ? "projectTypeCard selected"
                            : "projectTypeCard"
                        }
                        onClick={() =>
                          setType(
                            "typovy"
                          )
                        }
                      >
                        <div className="typeVisual">
                          <div className="typePlan">
                            <span className="wall wallTop" />
                            <span className="wall wallLeft" />
                          </div>
                        </div>

                        <div>
                          <strong>
                            Typový stánek
                          </strong>

                          <p>
                            Výběr z připravených
                            rozměrů a variant
                            konstrukce.
                          </p>
                        </div>

                        <span className="radio">
                          {type ===
                            "typovy" && (
                            <span />
                          )}
                        </span>
                      </button>

                      <button
                        type="button"
                        className={
                          type ===
                          "individualni"
                            ? "projectTypeCard selected"
                            : "projectTypeCard"
                        }
                        onClick={() =>
                          setType(
                            "individualni"
                          )
                        }
                      >
                        <div className="typeVisual">
                          <div className="customShape" />
                        </div>

                        <div>
                          <strong>
                            Individuální stánek
                          </strong>

                          <p>
                            Vlastní rozměry,
                            konstrukce a půdorys
                            projektu.
                          </p>
                        </div>

                        <span className="radio">
                          {type ===
                            "individualni" && (
                            <span />
                          )}
                        </span>
                      </button>
                    </div>
                  </div>
                </div>
              </section>

              <aside className="summaryCard">
                <div className="summaryHeader">
                  <span>
                    NÁHLED PROJEKTU
                  </span>

                  <span className="draft">
                    DRAFT
                  </span>
                </div>

                <div className="summaryBody">
                  <div className="emptyPreview">
                    <div className="previewCube">
                      <span className="cubeBack" />
                      <span className="cubeSide" />
                      <span className="cubeFloor" />
                    </div>

                    <strong>
                      {company
                        ? company
                        : "Nový projekt"}
                    </strong>

                    <p>
                      Náhled stánku se zobrazí po
                      výběru konstrukce.
                    </p>
                  </div>
                </div>

                <div className="summaryInfo">
                  <div>
                    <span>
                      VELETRH
                    </span>

                    <strong>
                      {selectedFair
                        ? selectedFair.name
                        : "—"}
                    </strong>
                  </div>

                  <div>
                    <span>
                      FIRMA
                    </span>

                    <strong>
                      {company || "—"}
                    </strong>
                  </div>

                  <div>
                    <span>
                      CENÍK
                    </span>

                    <strong>
                      {selectedFair
                        ? selectedFair.priceList
                        : "—"}
                    </strong>
                  </div>

                  <div>
                    <span>
                      MĚNA
                    </span>

                    <strong>
                      {currency ===
                      "CZK"
                        ? "CZK / Kč"
                        : "EUR / €"}
                    </strong>
                  </div>

                  <div>
                    <span>
                      TYP
                    </span>

                    <strong>
                      {type ===
                      "typovy"
                        ? "Typový"
                        : "Individuální"}
                    </strong>
                  </div>
                </div>
              </aside>
            </div>

            <footer className="pageFooter">
              <span>
                Projekt zatím není uložen.
              </span>

              <button
                className="primaryButton"
                onClick={() =>
                  setStep(2)
                }
              >
                Pokračovat

                <span>
                  →
                </span>
              </button>
            </footer>
          </div>
        )}

        {/* ================================================= */}
        {/* STEP 2                                          */}
        {/* ================================================= */}

        {workspaceSection === "project" && step === 2 && (
          <div className="page">
            <button
              className="back"
              onClick={() =>
                setStep(1)
              }
            >
              ← Zpět na projekt
            </button>

            <div className="pageIntro">
              <div>
                <span className="eyebrow">
                  KROK 02 / ZÁKLAD KONSTRUKCE
                </span>

                <h1>
                  Vyber základ konstrukce
                </h1>

                <p>
                  Nejprve vyber typ stánku.
                  Pokud konstrukce obsahuje více
                  variant, zobrazí se jejich
                  výběr automaticky.
                </p>
              </div>
            </div>

            <div className="projectContext">
              <div>
                <span>
                  VELETRH
                </span>

                <strong>
                  {selectedFair?.name ||
                    "—"}
                </strong>
              </div>

              <div>
                <span>
                  FIRMA
                </span>

                <strong>
                  {company || "—"}
                </strong>
              </div>

              <div>
                <span>
                  CENÍK
                </span>

                <strong>
                  {selectedFair?.priceList ||
                    "—"}
                </strong>
              </div>

              <div>
                <span>
                  MĚNA
                </span>

                <strong>
                  {currency}
                </strong>
              </div>
            </div>

            {type ===
            "typovy" ? (
              <>
                <section className="boothSelectionSection">
                  <div className="selectionTitle">
                    <div>
                      <span>
                        01
                      </span>

                      <div>
                        <small>
                          ZÁKLAD
                        </small>

                        <h2>
                          Konstrukce stánku
                        </h2>
                      </div>
                    </div>

                    <p>
                      Vyber základní typ konstrukce.
                    </p>
                  </div>

                  <div className="boothTypeGrid">
                    {boothTypes.map(
                      (booth) => {
                        const selected =
                          selectedBoothId ===
                          booth.id;

                        return (
                          <button
                            key={
                              booth.id
                            }
                            type="button"
                            className={
                              selected
                                ? "boothTypeCard selected"
                                : "boothTypeCard"
                            }
                            onClick={() =>
                              handleBoothSelect(
                                booth.id
                              )
                            }
                          >
                            <div className="boothCardCode">
                              {
                                booth.code
                              }
                            </div>

                            {!booth.configReady && (
                              <span className="cadPending">
                                CAD ČEKÁ
                              </span>
                            )}

                            <div className="constructionPreview">
                              {booth.thumbnailUrl ? (
                                <img src={booth.thumbnailUrl} alt={`Náhled ${booth.name}`} />
                              ) : (
                                <div className="constructionShape">
                                  <span className="constructionWallTop" />
                                  <span className="constructionWallLeft" />
                                </div>
                              )}
                            </div>

                            <div className="boothTypeContent">
                              <h3>
                                {
                                  booth.name
                                }
                              </h3>

                              <p>
                                {
                                  booth.description
                                }
                              </p>

                              <div className="boothMeta">
                                <span>
                                  {
                                    booth.size
                                  }
                                </span>

                                {booth
                                  .variants
                                  .length >
                                0 ? (
                                  <strong>
                                    {
                                      booth
                                        .variants
                                        .length
                                    }{" "}
                                    varianty
                                  </strong>
                                ) : (
                                  <strong>
                                    Bez variant
                                  </strong>
                                )}
                              </div>
                            </div>

                            {selected && (
                              <span className="boothCheck">
                                ✓
                              </span>
                            )}
                          </button>
                        );
                      }
                    )}
                  </div>
                </section>

                {selectedBooth &&
                  selectedBooth
                    .variants
                    .length >
                    0 && (
                    <section className="variantSection">
                      <div className="selectionTitle">
                        <div>
                          <span>
                            02
                          </span>

                          <div>
                            <small>
                              VARIANTA
                            </small>

                            <h2>
                              {
                                selectedBooth.name
                              }
                            </h2>
                          </div>
                        </div>

                        <p>
                          Vyber konkrétní variantu konstrukce.
                        </p>
                      </div>

                      <div className="variantGrid">
                        {selectedBooth.variants.map(
                          (
                            variant,
                            index
                          ) => {
                            const selected =
                              selectedVariantId ===
                              variant.id;

                            return (
                              <button
                                key={
                                  variant.id
                                }
                                type="button"
                                className={
                                  selected
                                    ? "variantCard selected"
                                    : "variantCard"
                                }
                                onClick={() =>
                                  handleVariantSelect(
                                    variant.id
                                  )
                                }
                              >
                                <div className="variantPreview">
                                  <div
                                    className={`variantShape variantShape${
                                      index +
                                      1
                                    }`}
                                  >
                                    <span className="variantWallA" />
                                    <span className="variantWallB" />
                                  </div>
                                </div>

                                <div className="variantContent">
                                  <span>
                                    {
                                      selectedBooth.code
                                    }{" "}
                                    / V
                                    {index +
                                      1}
                                  </span>

                                  <strong>
                                    {
                                      variant.name
                                    }
                                  </strong>
                                </div>

                                {selected && (
                                  <span className="variantCheck">
                                    ✓
                                  </span>
                                )}
                              </button>
                            );
                          }
                        )}
                      </div>
                    </section>
                  )}

                {selectedBooth &&
                  selectedBooth
                    .variants
                    .length ===
                    0 && (
                    <div className="noVariantInfo">
                      <div className="noVariantIcon">
                        ✓
                      </div>

                      <div>
                        <strong>
                          {
                            selectedBooth.name
                          }
                        </strong>

                        {selectedBooth.configReady ? (
                          <p>
                            Tato konstrukce nemá
                            další varianty. Můžeš
                            pokračovat přímo do
                            konfigurátoru.
                          </p>
                        ) : (
                          <p>
                            Výběr je připravený,
                            ale konfigurátor čeká
                            na přesnou CAD
                            geometrii této
                            konstrukce.
                          </p>
                        )}
                      </div>
                    </div>
                  )}
              </>
            ) : (
              <div className="individualPlaceholder">
                <span>
                  INDIVIDUÁLNÍ PROJEKT
                </span>

                <h2>
                  Editor vlastního půdorysu
                </h2>

                <p>
                  Individuální konstrukce
                  připravíme jako samostatnou
                  část generátoru.
                </p>
              </div>
            )}

            <footer className="pageFooter">
              <button
                className="secondaryButton"
                onClick={() =>
                  setStep(1)
                }
              >
                Zpět
              </button>

              <button
                className="primaryButton"
                disabled={
                  !canOpenConfigurator
                }
                onClick={() => {
                  if (
                    canOpenConfigurator
                  ) {
                    setStep(
                      3
                    );
                  }
                }}
              >
                Otevřít konfigurátor

                <span>
                  →
                </span>
              </button>
            </footer>
          </div>
        )}

        {/* ================================================= */}
        {/* STEP 3                                          */}
        {/* ================================================= */}

        {workspaceSection === "project" && step === 3 &&
          selectedBooth &&
          selectedBooth.widthMm &&
          selectedBooth.depthMm && (
            <div className="configuratorPage">
              {/* HEADER */}

              <div className="configuratorHeader">
                <div>
                  <button
                    className="back"
                    onClick={() =>
                      setStep(2)
                    }
                  >
                    ← Zpět na výběr stánku
                  </button>

                  <span className="eyebrow">
                    KROK 03 / KONFIGURACE
                  </span>

                  <h1>
                    {
                      selectedBooth.name
                    }
                  </h1>
                </div>

                <div className="configuratorHeaderActions">
                  <button
                    className="lightButton"
                    onClick={
                      resetConfigurator
                    }
                  >
                    Reset rozmístění
                  </button>
                </div>
              </div>

              {/* WORKSPACE */}

              <div className="configuratorWorkspace">
                {/* COMPONENT LIBRARY */}

                <ComponentLibrary
                  onAddComponent={addComponent}
                  inventory={orderInventory}
                />

                {/* PLAN */}

                <section className="planWorkspace">
                  <div className="planToolbar">
                    <div>
                      <span>
                        PŮDORYS
                      </span>

                      <strong>
                        {
                          selectedBooth.nominalDimensions?.widthMm ?? selectedBooth.widthMm
                        }{" "}
                        ×{" "}
                        {
                          selectedBooth.nominalDimensions?.depthMm ?? selectedBooth.depthMm
                        }{" "}
                        mm
                      </strong>
                    </div>

                    <div className="planToolbarInfo">
                      <div className="viewSwitch compactViewSwitch">
                        <button
                          type="button"
                          className={editorView === "2d" ? "viewButton active" : "viewButton"}
                          onClick={() => setEditorView("2d")}
                        >
                          2D
                        </button>
                        <button
                          type="button"
                          className={editorView === "3d" ? "viewButton active" : "viewButton"}
                          onClick={() => setEditorView("3d")}
                        >
                          3D
                        </button>
                      </div>
                      <span>
                        GRID 250 mm
                      </span>

                      <span>
                        SNAP 40 mm
                      </span>

                      <span className="collisionOn">
                        KOLIZE ON
                      </span>

                      {editorView === "2d" && <div className="planToolButtons">
                        <button type="button" className={editorTool === "annotation" ? "active" : ""} onClick={() => { const active = editorTool !== "annotation"; setEditorTool(active ? "annotation" : "select"); setPendingMeasurePoint(null); setMeasureHoverPoint(null); setEditorMessage(active ? "Klikněte do plánu pro vložení poznámky" : ""); }}>
                          + Poznámka
                        </button>
                        <button type="button" className={editorTool === "measure" ? "active" : ""} onClick={() => { const active = editorTool !== "measure"; setEditorTool(active ? "measure" : "select"); setPendingMeasurePoint(null); setMeasureHoverPoint(null); setEditorMessage(active ? "Klikněte na první bod" : ""); }}>
                          Změřit vzdálenost
                        </button>
                        {editorTool !== "select" && <button type="button" onClick={() => { setEditorTool("select"); setPendingMeasurePoint(null); setMeasureHoverPoint(null); setEditorMessage(""); }}>Zrušit</button>}
                        <button type="button" className={showPlanDimensions ? "active" : ""} onClick={() => setShowPlanDimensions((visible) => !visible)}>
                          Kóty
                        </button>
                      </div>}

                      <button
                        type="button"
                        className={
                          isHelpOpen
                            ? "helpToggleButton active"
                            : "helpToggleButton"
                        }
                        onClick={() =>
                          setIsHelpOpen((open) => !open)
                        }
                        aria-expanded={isHelpOpen}
                        aria-controls="configurator-help"
                      >
                        ? Ovládání
                      </button>

                      <ViewportToolbar
                        zoomPercent={boothViewport.zoomPercent}
                        onZoomOut={boothViewport.zoomOut}
                        onZoomIn={boothViewport.zoomIn}
                        onFit={() => boothViewport.fitToContent(scenePlanBounds(selectedBooth.widthMm!, selectedBooth.depthMm!, placedComponents))}
                        onReset={boothViewport.resetZoom}
                      />
                    </div>
                  </div>

                  <ConfiguratorHelp
                    open={isHelpOpen}
                    onClose={() => setIsHelpOpen(false)}
                  />

                  {/* OBJECT NAVIGATOR */}

                  <div
                    className={
                      selectedPlacedComponent
                        ? "objectNavigator active"
                        : "objectNavigator"
                    }
                  >
                    {selectedPlacedComponent ? (
                      <>
                        <div className="navigatorObject">
                          <span>
                            VYBRANÝ OBJEKT
                          </span>

                          <strong>
                            {
                              selectedPlacedComponent.name
                            }
                          </strong>
                        </div>

                        <div className="navigatorCoords">
                          <div>
                            <span>
                              X
                            </span>

                            <strong>
                              {Math.round(
                                selectedPlacedComponent.xMm
                              )}{" "}
                              mm
                            </strong>
                          </div>

                          <div>
                            <span>
                              Y
                            </span>

                            <strong>
                              {Math.round(
                                selectedPlacedComponent.yMm
                              )}{" "}
                              mm
                            </strong>
                          </div>
                        </div>

                        <div className="navigatorDivider" />

                        <RotationNavigator
                          component={selectedPlacedComponent}
                          interactionLocked={selectedPlacedComponentLocked}
                          onQuickAngle={setSelectedQuickRotation}
                          onRotationChange={setSelectedRotation}
                          onModeChange={setSelectedRotationMode}
                        />

                        <div className="navigatorDivider" />

                        <div className="navigatorActions">
                          <button
                            disabled={selectedPlacedComponentLocked}
                            onClick={
                              duplicateSelectedComponent
                            }
                          >
                            Duplikovat
                          </button>

                          <button
                            className="deleteNavigatorButton"
                            disabled={selectedPlacedComponentLocked}
                            onClick={
                              deleteSelectedComponent
                            }
                          >
                            Smazat
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="navigatorEmpty">
                        Vyber objekt v půdorysu – zde se zobrazí jeho
                        pozice a ovládání rotace.
                      </div>
                    )}
                  </div>

                  {editorMessage && (
                    <div className="editorMessage">
                      <span>
                        !
                      </span>

                      {
                        editorMessage
                      }
                    </div>
                  )}

                  <div className="canvasArea">
                    <div
                      ref={boothViewport.viewportRef}
                      className={
                        boothViewport.isPanning
                          ? "boothViewport panning"
                          : boothViewport.isSpacePressed
                            ? "boothViewport panReady"
                            : "boothViewport"
                      }
                      onPointerDown={handleViewportPointerDown}
                      onPointerMove={boothViewport.movePan}
                      onPointerUp={boothViewport.endPan}
                      onPointerCancel={boothViewport.endPan}
                    >
                      <div
                        className="viewportStage"
                        style={{
                          width: `${selectedBooth.widthMm * boothViewport.pixelsPerMm}px`,
                          height: `${selectedBooth.depthMm * boothViewport.pixelsPerMm}px`,
                          transform: `translate(${boothViewport.transform.pan.x}px, ${boothViewport.transform.pan.y}px) scale(${boothViewport.transform.zoom})`,
                        }}
                      >
                    {showPlanDimensions && <div className="dimensionTop">
                      <span>
                        {
                          selectedBooth.nominalDimensions?.widthMm ?? selectedBooth.widthMm
                        }{" "}
                        mm
                      </span>
                    </div>}

                    {showPlanDimensions && selectedBooth.nominalDimensions && <div className="dimensionHeight">
                      <span>VÝŠKA {selectedBooth.nominalDimensions.heightMm} mm</span>
                    </div>}

                    {showPlanDimensions && <div className="dimensionLeft">
                      <span>
                        {
                          selectedBooth.nominalDimensions?.depthMm ?? selectedBooth.depthMm
                        }{" "}
                        mm
                      </span>
                    </div>}

                    <div
                      className={
                        ["boothCanvas", "planViewRotated", selectedConstructionPartId === "assembly" ? "constructionSelected" : "", editorTool === "measure" ? "measurementActive" : ""].filter(Boolean).join(" ")
                      }
                      style={{
                        aspectRatio: `${selectedBooth.widthMm} / ${selectedBooth.depthMm}`,
                      }}
                      onPointerDown={handlePlanToolPointerDown}
                      onPointerMove={handlePlanToolPointerMove}
                    >
                      {/* CARPET */}

                      <div
                        className={`carpetLayer ${carpetFinishId === "none" ? "noCarpet" : ""}`}
                        style={carpetFinishId === "none" ? undefined : { backgroundColor: selectedCarpetFinish?.swatchColor }}
                      >
                        <span className="carpetLabel">
                          {carpetFinishId === "none" ? "BEZ KOBERCE" : `KOBEREC · ${selectedCarpetFinish?.name ?? "—"}`}
                        </span>
                      </div>

                      {/* CAD-DERIVED CONSTRUCTION PLAN */}

                      <BoothCadPlanView
                        asset={selectedBoothMasterModel}
                        footprintWidthMm={selectedBooth.widthMm}
                        footprintDepthMm={selectedBooth.depthMm}
                        visible={constructionAssemblyVisible}
                        selected={selectedConstructionPartId !== null}
                        rotateView180
                      />

                      {editorTool === "measure" && measureHoverPoint && (() => {
                        const hover = worldToPlanView180(measureHoverPoint, selectedBooth.widthMm!, selectedBooth.depthMm!);
                        const start = pendingMeasurePoint ? worldToPlanView180(pendingMeasurePoint, selectedBooth.widthMm!, selectedBooth.depthMm!) : null;
                        return <div className="measurementPreview" aria-hidden="true"><svg viewBox={`0 0 ${selectedBooth.widthMm} ${selectedBooth.depthMm}`} preserveAspectRatio="none">{start && <line x1={start.x} y1={start.y} x2={hover.x} y2={hover.y} />}<circle cx={hover.x} cy={hover.y} r="24" />{start && <circle cx={start.x} cy={start.y} r="18" />}</svg></div>;
                      })()}

                      {/* COMPONENTS */}

                      {sortComponentsFor2D(placedComponents).map(
                        (item) => {
                          if (!item.visible || !item.showIn2D) {
                            return null;
                          }

                          const selected =
                            item.id ===
                            selectedComponentId;

                          return (
                            <button
                              key={
                                item.id
                              }
                              type="button"
                              className={[
                                "placedComponent",

                                item.sceneLayer !== "furniture"
                                  ? `technicalComponent ${item.sceneLayer}`
                                  : item.type === "chair"
                                    ? "chairComponent"
                                    : "cabinetComponent",

                                selected
                                  ? "selected"
                                  : "",

                                isObjectLocked(item)
                                  ? "locked"
                                  : "",
                              ]
                                .filter(
                                  Boolean
                                )
                                .join(
                                  " "
                                )}
                              style={{
                                left: `${(worldToPlanView180({ x: item.xMm, y: item.yMm }, selectedBooth.widthMm!, selectedBooth.depthMm!).x / selectedBooth.widthMm!) * 100}%`,

                                top: `${(worldToPlanView180({ x: item.xMm, y: item.yMm }, selectedBooth.widthMm!, selectedBooth.depthMm!).y / selectedBooth.depthMm!) * 100}%`,

                                width: `${
                                  (item.widthMm /
                                    selectedBooth.widthMm!) *
                                  100
                                }%`,

                                height: `${
                                  (item.depthMm /
                                    selectedBooth.depthMm!) *
                                  100
                                }%`,

                                transform: `translate(-50%, -50%) rotate(${worldRotationToPlanView180(item.rotationDeg)}deg)`,
                                zIndex: componentZIndex(item),
                              }}
                              onPointerDown={(
                                event
                              ) =>
                                handleComponentPointerDown(
                                  event,
                                  item.id
                                )
                              }
                              onPointerMove={(
                                event
                              ) =>
                                handleComponentPointerMove(
                                  event,
                                  item.id
                                )
                              }
                              onPointerUp={
                                handleComponentPointerUp
                              }
                            >
                              {item.frontDirectionDeg !== undefined && (
                                <i
                                  className="frontMarker"
                                  style={{
                                    transform: `translateX(-50%) rotate(${item.frontDirectionDeg}deg)`,
                                  }}
                                >
                                  ▲
                                </i>
                              )}

                              <span className="placedComponentName">
                                {item.sceneLayer !== "furniture"
                                  ? componentCatalogItems.find(
                                      (definition) => definition.id === item.definitionId,
                                    )?.footprint2D?.symbol ?? item.name
                                  : item.name}
                              </span>

                              <small>
                                {
                                  item.widthMm
                                }{" "}
                                ×{" "}
                                {
                                  item.depthMm
                                }
                              </small>
                            </button>
                          );
                        }
                      )}

                      {showPlanDimensions && customDimensions.filter((dimension) => dimension.visible).map((dimension) => {
                        const start = worldToPlanView180(dimension.start, selectedBooth.widthMm!, selectedBooth.depthMm!);
                        const end = worldToPlanView180(dimension.end, selectedBooth.widthMm!, selectedBooth.depthMm!);
                        const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
                        return <div className="customDimension" key={dimension.id}>
                          <svg viewBox={`0 0 ${selectedBooth.widthMm} ${selectedBooth.depthMm}`} preserveAspectRatio="none"><line x1={start.x} y1={start.y} x2={end.x} y2={end.y} /><circle cx={start.x} cy={start.y} r="18" /><circle cx={end.x} cy={end.y} r="18" /></svg>
                          <button type="button" className="customDimensionLabel" style={{ left: `${midpoint.x / selectedBooth.widthMm! * 100}%`, top: `${midpoint.y / selectedBooth.depthMm! * 100}%` }} onDoubleClick={() => { const label = window.prompt("Zobrazený text kóty", dimension.displayLabel ?? ""); if (label !== null) setCustomDimensions((items) => items.map((item) => item.id === dimension.id ? { ...item, displayLabel: label || undefined } : item)); }}>
                            {dimensionDisplayLabel(dimension)}
                            <i onClick={(event) => { event.stopPropagation(); setCustomDimensions((items) => items.filter((item) => item.id !== dimension.id)); }}>×</i>
                          </button>
                        </div>;
                      })}

                      {annotations.filter((annotation) => annotation.visible).map((annotation) => {
                        const point = worldToPlanView180(annotation.position, selectedBooth.widthMm!, selectedBooth.depthMm!);
                        return <div
                          key={annotation.id}
                          role="button"
                          tabIndex={0}
                          className={`planAnnotation ${annotation.textSize ?? "medium"}`}
                          style={{ left: `${point.x / selectedBooth.widthMm! * 100}%`, top: `${point.y / selectedBooth.depthMm! * 100}%` }}
                          onPointerDown={(event) => { event.stopPropagation(); setDraggingAnnotationId(annotation.id); event.currentTarget.setPointerCapture(event.pointerId); }}
                          onPointerMove={(event) => handleAnnotationPointerMove(event, annotation.id)}
                          onPointerUp={(event) => { event.currentTarget.releasePointerCapture(event.pointerId); setDraggingAnnotationId(null); }}
                          onDoubleClick={() => { const text = window.prompt("Upravit poznámku", annotation.text); if (text?.trim()) setAnnotations((items) => items.map((item) => item.id === annotation.id ? { ...item, text: text.trim() } : item)); }}
                        >
                          <span>{annotation.text}</span>
                          <button type="button" className="annotationSize" title="Změnit velikost" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); const order = ["small", "medium", "large"] as const; const current = order.indexOf(annotation.textSize ?? "medium"); setAnnotations((items) => items.map((item) => item.id === annotation.id ? { ...item, textSize: order[(current + 1) % order.length] } : item)); }}>A</button>
                          <button type="button" className="annotationDelete" aria-label="Odstranit poznámku" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setAnnotations((items) => items.filter((item) => item.id !== annotation.id)); }}>×</button>
                        </div>;
                      })}
                    </div>
                      </div>
                    </div>

                  </div>

                  {editorView === "3d" && (
                    <div className="cadViewerMode">
                      <BoothCadViewer
                        asset={selectedBoothMasterModel}
                        footprintWidthMm={selectedBooth.widthMm}
                        footprintDepthMm={selectedBooth.depthMm}
                        components={placedComponents}
                        carpetFinish={selectedCarpetFinish}
                        constructionFinish={selectedConstructionFinish}
                        partDefinitions={selectedBooth.partDefinitions}
                        nominalDimensions={selectedBooth.nominalDimensions}
                        printSurfaces={selectedBooth.printSurfaces}
                        showPrintPlaceholder={printSurfaceAssignments.some((assignment) => assignment.selectedForPrint && assignment.artworkStatus === "missing")}
                        measurements={measurements3D}
                        onMeasurementsChange={(items) => setMeasurements3D([...items])}
                        dimensionOffsets={dimensionOffsets3D}
                        onDimensionOffsetsChange={(offsets) => setDimensionOffsets3D({ ...offsets })}
                        printSurfaceAssignments={printSurfaceAssignments}
                        selectedPrintSurfaceId={selectedPrintSurfaceId}
                        onSelectPrintSurface={setSelectedPrintSurfaceId}
                        defaultViews={selectedBooth.defaultViews}
                        savedViews={savedViews}
                        onSaveView={(view) =>
                          setSavedViews((items) => [
                            ...items,
                            saveCameraView({
                              ...view,
                              name: `Vlastní pohled ${items.length + 1}`,
                            }),
                          ])
                        }
                        onDeleteView={(viewId) =>
                          setSavedViews((items) =>
                            items.filter((view) => view.id !== viewId),
                          )
                        }
                      />
                    </div>
                  )}
                </section>

                {/* PROPERTIES */}

                <aside className="propertyPanel">
                  <div className="panelHeader">
                    <span>
                      VLASTNOSTI
                    </span>

                    <strong>
                      Projekt
                    </strong>
                  </div>

                  <div className="propertySection projectInspectorSection">
                    <button
                      type="button"
                      className="projectInspectorToggle"
                      onClick={() => setIsProjectInspectorOpen((open) => !open)}
                      aria-expanded={isProjectInspectorOpen}
                    >
                      <span>{isProjectInspectorOpen ? "▾" : "▸"} PROJEKT</span>
                      <small>{isProjectInspectorOpen ? "Sbalit" : "Detail"}</small>
                    </button>

                    <div className="projectCompactSummary">
                      <div><span>Firma</span><strong>{company || "—"}</strong></div>
                      <div><span>Stánek</span><strong>{selectedBooth.code}{selectedVariant ? ` / ${selectedVariant.name}` : ""}</strong></div>
                      <div><span>Výstava</span><strong>{selectedFair?.name || "—"}</strong></div>
                    </div>

                    {isProjectInspectorOpen && <div className="projectInspectorDetails">

                    <div className="propertyRow">
                      <span>Veletrh</span>
                      <strong>{selectedFair?.name || "—"}</strong>
                    </div>

                    <div className="propertyRow">
                      <span>Firma / vystavovatel</span>
                      <strong>{company || "—"}</strong>
                    </div>

                    <div className="propertyRow">
                      <span>Označení stánku</span>
                      <strong>{boothNumber || "—"}</strong>
                    </div>

                    <div className="propertyRow">
                      <span>Režim projektu</span>
                      <strong>
                        {projectMode === "proposal"
                          ? "Návrh / kalkulace"
                          : projectMode === "order"
                            ? "Objednávka"
                            : "Realizace"}
                      </strong>
                    </div>

                    <div className="propertyRow">
                      <span>Kontakt</span>
                      <strong>{contactName || contactEmail || "—"}</strong>
                    </div>

                    <div className="propertyRow">
                      <span>Stav zakázky</span>
                      <strong>{projectStage === "quote" ? "Nabídka / Kalkulace" : projectStage === "design" ? "Návrh" : projectStage === "approved" ? "Odsouhlaseno" : "Hotovo"}</strong>
                    </div>

                    <div className="propertyRow">
                      <span>Typ stánku</span>
                      <strong>{selectedBooth.name}</strong>
                    </div>

                    {selectedVariant && (
                      <div className="propertyRow">
                        <span>Varianta</span>
                        <strong>{selectedVariant.name}</strong>
                      </div>
                    )}

                    <div className="propertyRow">
                      <span>Ceník</span>
                      <strong>{selectedFair?.priceList || "—"}</strong>
                    </div>

                    <div className="propertyRow">
                      <span>Měna</span>
                      <strong>{currency}</strong>
                    </div>

                    <div className="propertyRow">
                      <span>Realizačka</span>
                      <strong>{selectedRealizationProfile?.name || "—"}</strong>
                    </div>

                    <div className="propertyRow">
                      <span>Jazyk komunikace</span>
                      <strong>{communicationLanguage === "cs" ? "Čeština" : "English"}</strong>
                    </div>

                    <div className="propertyRow">
                      <span>Cena konstrukce</span>
                      <strong>
                        {selectedBooth.pricing.mode === "fixed"
                          ? "Fixní typovka"
                          : "Dle konfigurace"}
                      </strong>
                    </div>

                    <NotesEditor
                      title="Poznámky projektu"
                      notes={projectNotes}
                      className="projectInspectorNotes inspectorNotes"
                      onChange={updateProjectNote}
                    />
                    </div>}
                  </div>

                  <ScenePanel
                    booth={selectedBooth}
                    variant={selectedVariant}
                    components={placedComponents}
                    constructionUserLocks={constructionUserLocks}
                    constructionVisibility={constructionVisibility}
                    selectedComponentId={selectedComponentId}
                    selectedConstructionPartId={selectedConstructionPartId}
                    carpetVariants={selectedBooth.carpetVariants}
                    carpetFinishId={carpetFinishId}
                    onCarpetFinishChange={setCarpetFinishId}
                    onSelectComponent={selectSceneComponent}
                    onSelectConstructionPart={selectConstructionPart}
                    onToggleComponentLock={toggleComponentLock}
                    onToggleConstructionLock={toggleConstructionLock}
                    onToggleComponentVisibility={toggleComponentVisibility}
                    onToggleConstructionVisibility={toggleConstructionVisibility}
                    onMoveComponentDisplayOrder={(componentId, direction) => setPlacedComponents((items) => [...moveComponentDisplayOrder(items, componentId, direction)])}
                  />
                  {effectiveFasciaRequirement(technicalRequirements.fasciaGraphics, selectedBooth).message && <div className="packageOverrideNotice">{effectiveFasciaRequirement(technicalRequirements.fasciaGraphics, selectedBooth).message}</div>}
                  {selectedPrintSurface && selectedPrintAssignment && <section className="printSurfaceInspector">
                    <span className="propertySectionTitle">TISKOVÁ PLOCHA</span>
                    <div className="propertyRow"><span>Název</span><strong>{selectedPrintSurface.name}</strong></div>
                    <div className="propertyRow"><span>Rozměr</span><strong>{selectedPrintSurface.widthMm} × {selectedPrintSurface.heightMm} mm</strong></div>
                    <div className="propertyRow"><span>Pricing unit</span><strong>{selectedPrintSurface.pricingUnit ?? "—"}</strong></div>
                    <div className="propertyRow"><span>Grafika</span><strong>{selectedPrintAssignment.includedInPackage ? "Objednáno – v ceně" : selectedPrintAssignment.selectedForPrint ? "Vybráno pro celopolep" : "Nevybráno"}</strong></div>
                    <div className="propertyRow"><span>Data</span><strong>{selectedPrintAssignment.artworkStatus === "missing" ? "Chybí" : selectedPrintAssignment.artworkStatus === "received" ? "Přijata" : "Ready"}</strong></div>
                    <div className="printSurfaceActions"><button type="button" onClick={() => setPrintSurfaceAssignments((items) => items.map((item) => item.printSurfaceId === selectedPrintSurface.id ? { ...item, selectedForPrint: !item.selectedForPrint, graphicsKind: item.includedInPackage ? "fascia" : "fullWrap" } : item))}>{selectedPrintAssignment.selectedForPrint ? "Odebrat z grafiky" : "Použít pro grafiku"}</button><button type="button" onClick={() => setPrintSurfaceAssignments((items) => items.map((item) => item.printSurfaceId === selectedPrintSurface.id ? { ...item, artworkStatus: item.artworkStatus === "missing" ? "received" : item.artworkStatus === "received" ? "ready" : "missing" } : item))}>Změnit stav dat</button></div>
                  </section>}

                  <div className="finishInspectorControl">
                    <label>
                      <span>Barva konstrukce</span>
                      <select value={constructionFinishId} onChange={(event) => setConstructionFinishId(event.target.value)}>
                        {(selectedBooth.finishVariants ?? constructionFinishVariants).map((finish) => <option key={finish.id} value={finish.id}>{finish.name}</option>)}
                      </select>
                    </label>
                    {!selectedBooth.partDefinitions?.length && <small>MASTER zatím nemá mapované GLB části; volba je uložena, ale model se nepřebarvuje.</small>}
                  </div>

                  <div className="propertySection">
                    <span className="propertySectionTitle">
                      VYBRANÝ OBJEKT
                    </span>

                    {selectedPlacedComponent ? (
                      <>
                        <div className="selectedComponentCard">
                          <span>Mobiliář</span>
                          <strong>{selectedPlacedComponent.name}</strong>
                        </div>

                        <div className="inspectorGroup">
                          <span className="inspectorGroupTitle">Pozice</span>
                          <div className="coordinateGrid">
                            <CoordinateInput
                              axis="X"
                              value={selectedPlacedComponent.xMm}
                              disabled={selectedPlacedComponentLocked}
                              onCommit={(value) =>
                                commitSelectedCoordinate("x", value)
                              }
                            />

                            <CoordinateInput
                              axis="Y"
                              value={selectedPlacedComponent.yMm}
                              disabled={selectedPlacedComponentLocked}
                              onCommit={(value) =>
                                commitSelectedCoordinate("y", value)
                              }
                            />
                          </div>
                        </div>

                        <div className="inspectorGroup">
                          <span className="inspectorGroupTitle">Rotace</span>
                          <div className="inspectorCompactRows">
                            <div>
                              <span>Úhel</span>
                              <strong>{selectedPlacedComponent.rotationDeg}°</strong>
                            </div>
                            <div>
                              <span>Režim</span>
                              <strong>
                                {selectedPlacedComponent.rotation.locked
                                  ? "Zamčená"
                                  : selectedPlacedComponent.rotationMode === "free"
                                    ? "Volná 360°"
                                    : `Rychlé po ${selectedPlacedComponent.rotation.snapStep}°`}
                              </strong>
                            </div>
                          </div>
                        </div>

                        <div className="inspectorGroup">
                          <div className="inspectorGroupHeader">
                            <span className="inspectorGroupTitle">Rozměry</span>
                            <span className="inspectorCapability">
                              {selectedPlacedComponent.resizable
                                ? "Upravitelné"
                                : "Pevné 1:1"}
                            </span>
                          </div>
                          <div className="inspectorDimensionGrid">
                            <div>
                              <span>Šířka</span>
                              <strong>{selectedPlacedComponent.widthMm} mm</strong>
                            </div>
                            <div>
                              <span>Hloubka</span>
                              <strong>{selectedPlacedComponent.depthMm} mm</strong>
                            </div>
                            {selectedPlacedComponent.heightMm !== undefined && (
                              <div>
                                <span>Výška</span>
                                <strong>{selectedPlacedComponent.heightMm} mm</strong>
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="inspectorStatusRow">
                          <span>Zámek</span>
                          <strong>
                            {selectedPlacedComponent.systemLocked
                              ? "Systémový"
                              : selectedPlacedComponent.userLocked
                                ? "Uživatelský"
                                : "Odemčeno"}
                          </strong>
                        </div>

                        <NotesEditor
                          title="Poznámky"
                          notes={selectedPlacedComponent}
                          className="inspectorGroup inspectorNotes"
                          onChange={updateSelectedComponentNote}
                        />

                        <button
                          className="inspectorDelete"
                          disabled={selectedPlacedComponentLocked}
                          onClick={
                            deleteSelectedComponent
                          }
                        >
                          Smazat objekt
                        </button>
                      </>
                    ) : selectedConstructionName ? (
                      <>
                        <div className="selectedComponentCard">
                          <span>{selectedConstructionLayer}</span>
                          <strong>{selectedConstructionName}</strong>
                        </div>

                        <div className="propertyRow">
                          <span>Vrstva</span>
                          <strong>{selectedConstructionLayer}</strong>
                        </div>

                        {selectedConstructionPart && (
                          <div className="propertyRow">
                            <span>2D kolize</span>
                            <strong>
                              {selectedConstructionPart.collision2D
                                ? "Aktivní"
                                : "Bez kolize"}
                            </strong>
                          </div>
                        )}

                        <div className="propertyRow">
                          <span>Zámek</span>
                          <strong>
                            {selectedConstructionLocked
                              ? "Zamčeno"
                              : "Odemčeno"}
                          </strong>
                        </div>

                        {selectedConstructionNotes && (
                          <NotesEditor
                            title="Poznámky"
                            notes={selectedConstructionNotes}
                            className="inspectorGroup inspectorNotes"
                            onChange={updateSelectedConstructionNote}
                          />
                        )}
                      </>
                    ) : (
                      <p className="emptyInspector">
                        Vyber objekt v půdorysu nebo ve Scéně.
                      </p>
                    )}
                  </div>
                </aside>
              </div>

              {/* BOTTOM */}

              <PricingBar booth={selectedBooth} placedItems={placedComponents} currency={currency} />
              <div className="workflowActions configuratorContinue">
                <button className="primaryButton" onClick={() => setStep(4)}>
                  Pokračovat na vizualizaci →
                </button>
              </div>
            </div>
          )}

        {workspaceSection === "project" && step === 4 && (
          <VisualizationStep
            project={workflowProject}
            onSaveView={(view) =>
              setSavedViews((items) => [
                ...items,
                saveCameraView({
                  ...view,
                  name: `Vlastní pohled ${items.length + 1}`,
                }),
              ])
            }
            onDeleteView={(viewId) =>
              setSavedViews((items) => items.filter((view) => view.id !== viewId))
            }
            onAddVisualization={(item) =>
              void addPersistentVisualization(item)
            }
            onAddPlanOutput={(item) => {
              void addPersistentPlanOutput(item);
            }}
            onUpdatePlanOutput={(item) =>
              setGeneratedPlanOutputs((items) => items.map((current) => current.id === item.id ? item : current))
            }
            onDeletePlanOutput={(id) => {
              setGeneratedPlanOutputs((items) => items.filter((item) => item.id !== id));
              setSelectedOutputIds((items) => items.filter((item) => item !== id));
            }}
            onUpdateVisualization={(item) =>
              setVisualizations((items) => items.map((current) => current.id === item.id ? item : current))
            }
            onDeleteVisualization={(id) => {
              setVisualizations((items) => items.filter((item) => item.id !== id));
              setSelectedOutputIds((items) => items.filter((item) => item !== id));
            }}
            onSelectedViewsChange={setSelectedVisualizationViewIds}
            onPurposeChange={setVisualizationPurpose}
            on2DLayersChange={setVisualization2DLayers}
            onContinue={() => setStep(5)}
          />
        )}

        {workspaceSection === "project" && step === 5 && (
          <SummaryStep
            project={workflowProject}
            onAddGraphicsFiles={addPersistentGraphics}
            onRetryGraphics={retryPersistentGraphics}
            graphicsUpload={graphicsUpload}
            onRemoveGraphicsFile={removeTemporaryGraphic}
            onContinue={() => setStep(6)}
          />
        )}

        {workspaceSection === "project" && step === 6 && (
          <ExportStep
            project={workflowProject}
            temporaryGraphicFiles={[...temporaryGraphicFilesRef.current].map(
              ([id, file]) => ({ id, file }),
            )}
            onSelectedOutputIdsChange={setSelectedOutputIds}
            onSelectedEventDocumentIdsChange={setSelectedEventDocumentIds}
            onCalculationOptionsChange={setExportCalculationOptions}
          />
        )}
      </section>
    </main>
  );
}
