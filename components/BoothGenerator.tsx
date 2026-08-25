"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { componentCatalogItems, placeComponent } from "../data/components";
import { fairs } from "../data/fairs";
import { exhibitions, priceLists } from "../data/organizations";
import {
  DEFAULT_REALIZATION_PROFILE_ID,
  realizationProfiles,
} from "../data/realizationProfiles";
import type {
  BoothType,
  BoothVariant,
  Currency,
  ComponentDefinition,
  Notes,
  PlacedComponent,
  ProjectType,
  RotationControlMode,
} from "../domain/models";
import type {
  ArtworkPlacement,
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
  VisualizationView,
  TechnicalRequirements,
  VisualizationItem,
} from "../domain/project";
import { updatePrintSurfaceArtworkPlacement } from "../domain/artworkPlacement";
import {
  createDefaultExportCalculationOptions,
  createDefaultTechnicalRequirements,
  createProjectRecord,
} from "../domain/project";
import { calculateOrderInventory } from "../domain/order";
import { LocalProjectRepository, type ProjectRepository } from "../domain/repository";
import { LocalEventRepository, type EventRepository } from "../domain/eventRepository";
import { LocalPriceListRepository, type PriceListRepository } from "../domain/priceListRepository";
import { RemoteApiProjectRepository } from "../lib/db/projectRepository.remoteApi.client";
import { RemoteApiEventRepository } from "../lib/db/eventRepository.remoteApi.client";
import { RemoteApiPriceListRepository } from "../lib/db/priceListRepository.remoteApi.client";
import { RemoteApiCatalogPricingRepository } from "../lib/db/catalogPricing.remoteApi.client";
import { resolvePersistenceProbe } from "../lib/db/persistenceMode.client";
import { ConcurrencyConflictError } from "../lib/db/concurrency";
import { saveCameraView } from "../domain/workflow";
import {
  moveVisualizationView,
  renameVisualizationView,
} from "../domain/visualization";
import type { Exhibition, PriceList } from "../domain/organizations";
import { resolveEventPriceListForCurrency } from "../domain/organizations";
import type { CatalogItemSummary, PricingEntrySummary } from "../domain/catalogPricing";
import { buildTechnicalCatalogItems } from "../domain/catalogPricing";
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
  planViewToWorld,
  worldRotationToPlanView,
  worldToPlanView,
} from "../domain/planView";
import { getBounds } from "../geometry/polygons";
import { getMasterReferenceModel, isVariantAvailable, resolveBoothModelSource } from "../domain/cad3d";
import { resolveGeneratorBooth, resolveGeneratorVariant, selectGeneratorBooths } from "../domain/generatorBooths";
import { selectGeneratorBoothComponents } from "../domain/generatorBoothComponents";
import { createIndividualBooth } from "../domain/individualBooth";
import {
  canConfirmPlot,
  createCenteredRectanglePlotPolygon,
  createRectanglePlotPolygon,
  DEFAULT_INDIVIDUAL_WORKSPACE,
  findComponentAnchorsOutsidePlot,
  isPlacementValidOnPlot,
  isPlotConfirmed,
  isPolygonWithinWorkspace,
  plotAreaSquareMeters,
  resolveDefaultAnchorOnPlot,
  resolveIndividualPlotPolygon,
  resolvePlotStatus,
  tryMoveComponentOnPlot,
  type IndividualWorkspace,
  type PlotPolygon,
  type PlotStatus,
} from "../domain/plot";
import {
  createRectanglePrimitive,
  duplicatePrimitive,
  mergePrimitivesToPolygon,
  rectanglePrimitivePolygon,
  rotatePrimitive90,
  type RectanglePrimitive,
} from "../domain/rectanglePrimitives";
import {
  confirmFloorZone,
  createFloorZone,
  findFloorZonesOutsidePlot,
  findOverlappingFloorZonePairs,
  FLOOR_ZONE_BASES,
  FLOOR_ZONE_BASE_LABELS_CS,
  FLOOR_ZONE_CONFIRM_ISSUE_LABELS_CS,
  FLOOR_ZONE_FINISHES,
  FLOOR_ZONE_FINISH_LABELS_CS,
  freeFloorAreaRegions,
  isFloorZoneConfirmed,
  totalFloorAreaByFinish,
  uncoveredFloorAreaSquareMeters,
  unlockFloorZone,
  validateFloorZoneForConfirm,
  type FloorZone,
} from "../domain/floorZones";
import { useAssetUrl } from "../hooks/useAssetUrl";
import {
  componentZIndex,
  isTechnicalPointLayer,
  moveComponentDisplayOrder,
  scenePlanBounds,
  sortComponentsFor2D,
} from "../domain/displayOrder";
import {
  assignArtworkToPrintSurface,
  computePrintSurfaceAssignments,
  effectiveFasciaRequirement,
  removeArtworkFromPrintSurface,
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
  createComponentDragOffset,
  INDIVIDUAL_GRID_MM,
  isPlacementValid,
  resolveDraggedComponentCenter,
  roundToGridMm,
  tryMoveComponent,
} from "../geometry/placement";
import { quickRotation, rotationForMode } from "../geometry/rotation";
import { useBoothViewport } from "../hooks/useBoothViewport";
import { AppSidebar } from "./AppSidebar";
import { StepHeader } from "./StepHeader";
import { ComponentLibrary } from "./configurator/ComponentLibrary";
import { BoothComponentLibrary } from "./configurator/BoothComponentLibrary";
import { PlotSizeInput } from "./configurator/PlotSizeInput";
import { PlotPolygonEditor } from "./configurator/PlotPolygonEditor";
import { BoothCadViewer, type BoothCadCameraControls } from "./configurator/BoothCadViewer";
import { GraphicsSurfacePanel } from "./configurator/GraphicsSurfacePanel";
import { BoothConstructionPlanView } from "./configurator/BoothConstructionPlanView";
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
  ProjectsPage,
} from "./workflow/AdminPages";
import { ComponentAdminPage } from "./workflow/ComponentAdminPage";
import { BoothAdminPage } from "./workflow/BoothAdminPage";
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
import {
  dataUrlToFile,
  readRasterImageDimensions,
  uploadAsset,
  type UploadProgress,
} from "../lib/storage/assetClient";
import { PricingAdminPage } from "./workflow/PricingAdminPages";
import { RemoteApiPricingAdminRepository } from "../lib/db/pricingAdmin.remoteApi.client";
import { RemoteApiCatalogItemsAdminRepository } from "../lib/db/catalogItemsAdmin.remoteApi.client";

/** Individual-booth plot size defaults (mode=individualni, before the user has entered anything) — a neutral starting point on the 250 mm layout grid, never a fabricated real-world footprint. */
const INDIVIDUAL_DEFAULT_WIDTH_MM = 3000;
const INDIVIDUAL_DEFAULT_DEPTH_MM = 2000;

/**
 * Individual mode's 4 persistent work steps (report section 3) — Plocha/Podlaha/Konstrukce/
 * Mobiliář are tabs over ONE shared ProjectRecord, never a destructive wizard: switching tabs
 * never clears sceneObjects/polygon/floor zones. "mobiliar" reuses the exact SAME
 * ComponentLibrary/configurator experience typovka already uses (report section 28) — no second
 * furniture editor.
 */
const INDIVIDUAL_SUB_STEPS = ["plocha", "podlaha", "konstrukce", "mobiliar"] as const;
type IndividualSubStep = (typeof INDIVIDUAL_SUB_STEPS)[number];
const INDIVIDUAL_SUB_STEP_LABELS_CS: Readonly<Record<IndividualSubStep, string>> = {
  plocha: "Plocha",
  podlaha: "Podlaha",
  konstrukce: "Konstrukce",
  mobiliar: "Mobiliář",
};

/**
 * Booth-selection card thumbnail — a real uploaded photoAsset (R2, resolved to a signed URL)
 * always wins over the legacy static thumbnailUrl; the placeholder construction-outline shape is
 * the last resort when neither is set. Never fabricates a photo. Extracted into its own component
 * because useAssetUrl is a hook and boothTypes.map(...) renders one card per booth.
 */
function BoothTypeCardThumbnail({ booth }: { booth: Pick<BoothType, "name" | "photoAsset" | "thumbnailUrl"> }) {
  const resolved = useAssetUrl(booth.photoAsset, booth.thumbnailUrl);
  if (resolved.url) {
    return <img src={resolved.url} alt={`Náhled ${booth.name}`} />;
  }
  return (
    <div className="constructionShape">
      <span className="constructionWallTop" />
      <span className="constructionWallLeft" />
    </div>
  );
}

/**
 * Variant-card thumbnail — fallback chain: the variant's OWN photoAsset, then the parent booth's
 * photoAsset (the type-booth line's main photo), then the same placeholder shape used for a
 * booth with no photo at all. Never fabricates a photo, never a broken <img>.
 */
function VariantCardThumbnail({ variant, parentPhotoAsset, label }: { variant: Pick<BoothVariant, "photoAsset">; parentPhotoAsset: BoothType["photoAsset"]; label: string }) {
  const asset = variant.photoAsset ?? parentPhotoAsset;
  const resolved = useAssetUrl(asset, undefined);
  if (resolved.url) {
    return <img src={resolved.url} alt={`Náhled ${label}`} />;
  }
  return (
    <div className="constructionShape">
      <span className="constructionWallTop" />
      <span className="constructionWallLeft" />
    </div>
  );
}

export default function BoothGenerator() {
  const repositoryRef = useRef<ProjectRepository | null>(null);
  const eventRepositoryRef = useRef<EventRepository | null>(null);
  const priceListRepositoryRef = useRef<PriceListRepository | null>(null);
  const pricingAdminRepositoryRef = useRef(new RemoteApiPricingAdminRepository());
  const catalogItemsAdminRepositoryRef = useRef(new RemoteApiCatalogItemsAdminRepository());
  const [pricingAdminPreselect, setPricingAdminPreselect] = useState<string | undefined>(undefined);
  const [workspaceSection, setWorkspaceSection] = useState<
    "project" | "projects" | "booths" | "components" | "events" | "priceLists" | "pricingAdmin"
  >("project");
  const [adminEvents, setAdminEvents] = useState<Exhibition[]>([...exhibitions]);
  const [eventsHydrated, setEventsHydrated] = useState(false);
  const [eventDirty, setEventDirty] = useState(false);
  const [adminPriceLists, setAdminPriceLists] = useState<PriceList[]>([...priceLists]);
  const [priceListsHydrated, setPriceListsHydrated] = useState(false);
  // Section 3/4: DB catalog_items for TECHNICAL-SERVICE PRICING ONLY (Batch #2A) — never
  // merged into ComponentLibrary/scene placement, which stays on data/components.ts.
  const [dbCatalogItems, setDbCatalogItems] = useState<CatalogItemSummary[]>([]);
  const [dbPricingEntries, setDbPricingEntries] = useState<PricingEntrySummary[]>([]);
  // Generator booth picker (section "GENERÁTOR TYPOVÝCH STÁNKŮ Z DB", 2026-08-19): DB catalog_items
  // (kind=booth) is now the single source of truth for THIS picker — data/booths.ts's static list
  // is no longer read here at all. null = still loading; [] + boothsError = a real fetch failure
  // (never silently fall back to stale static demo data); [] + no error = genuinely zero
  // active+ready+generatorEligible booths right now.
  const [dbBoothTypes, setDbBoothTypes] = useState<readonly BoothType[] | null>(null);
  const [boothsError, setBoothsError] = useState("");
  const boothTypes = dbBoothTypes ?? [];
  // Individual-mode Phase 1 picker (kind=booth_component only) — same DB catalog_items list as
  // dbBoothTypes above (one fetch, two filters), never a second/parallel catalog. null = still
  // loading; [] + boothComponentsError = a real fetch failure; [] + no error = genuinely zero
  // active+ready+generatorEligible+placeable booth components right now.
  const [dbBoothComponents, setDbBoothComponents] = useState<readonly ComponentDefinition[] | null>(null);
  const [boothComponentsError, setBoothComponentsError] = useState("");
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
  const [visualizationViews, setVisualizationViews] = useState<VisualizationView[]>([]);
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
  const [saveError, setSaveError] = useState("");
  const [persistenceMode, setPersistenceMode] = useState<"checking" | "db" | "local-fallback" | "unavailable">("checking");

  const [isSidebarCollapsed, setIsSidebarCollapsed] =
    useState(false);

  const [isHelpOpen, setIsHelpOpen] =
    useState(false);
  const [isProjectInspectorOpen, setIsProjectInspectorOpen] = useState(false);

  const [editorView, setEditorView] =
    useState<"2d" | "3d">("2d");
  const booth3DCameraControlsRef = useRef<BoothCadCameraControls | null>(null);
  const [booth3DZoomPercent, setBooth3DZoomPercent] = useState(100);
  const [readyBoothPlanVisualKey, setReadyBoothPlanVisualKey] =
    useState<string | null>(null);

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

  // Step 2's quick-rectangle draft inputs — a convenience starting point only (report section
  // 10); the real, possibly non-rectangular plot lives in individualPlotPolygon below and is
  // drawn/edited in the "Plocha" tab inside the configurator (step 3).
  const [individualWidthMm, setIndividualWidthMm] = useState(INDIVIDUAL_DEFAULT_WIDTH_MM);
  const [individualDepthMm, setIndividualDepthMm] = useState(INDIVIDUAL_DEFAULT_DEPTH_MM);

  const [individualSubStep, setIndividualSubStep] = useState<IndividualSubStep>("plocha");
  const [individualWorkspaceWidthMm, setIndividualWorkspaceWidthMm] = useState(DEFAULT_INDIVIDUAL_WORKSPACE.widthMm);
  const [individualWorkspaceDepthMm, setIndividualWorkspaceDepthMm] = useState(DEFAULT_INDIVIDUAL_WORKSPACE.depthMm);
  // Report section 4: set only when a requested workspace resize was REJECTED (would have left
  // part of the drawn plot outside the new canvas) — the resize itself never silently clips the
  // polygon, it just doesn't happen.
  const [individualWorkspaceSizeError, setIndividualWorkspaceSizeError] = useState<string | null>(null);
  const [individualPlotPolygon, setIndividualPlotPolygon] = useState<PlotPolygon | undefined>(undefined);
  // Report sections 1/2: draft vs confirmed/locked for the plot polygon itself — mirrors each
  // FloorZone's own `status` field (domain/floorZones.ts). Absent/"draft" means the "Plocha"
  // editor stays fully editable; "confirmed" locks it read-only until "Upravit plochu".
  const [individualPlotStatus, setIndividualPlotStatus] = useState<PlotStatus>("draft");
  const [individualFloorZones, setIndividualFloorZones] = useState<FloorZone[]>([]);
  const [editingFloorZoneId, setEditingFloorZoneId] = useState<string | null>(null);
  // Report sections 5-11: rectangle-primitive authoring helper — an alternative, purely-rectangular
  // way to build up the plot polygon (e.g. 5x5 + 2x3 -> L) next to point-by-point drawing, which
  // stays fully available and unchanged. Never the booth's own source of truth (see the type's own
  // doc comment) — "Sloučit do plochy stánku" is what actually sets individualPlotPolygon.
  const [individualPlotPrimitives, setIndividualPlotPrimitives] = useState<RectanglePrimitive[]>([]);
  const [primitiveMergeError, setPrimitiveMergeError] = useState<string | null>(null);

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
    editorMessage,
    setEditorMessage,
  ] = useState("");
  const componentDragSessionRef = useRef<{
    componentId: string;
    pointerId: number;
    offset: ReturnType<typeof createComponentDragOffset>;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;

    function useLocalFallback(warn: boolean) {
      if (warn) console.warn("[HomeworkStudio] Databázové úložiště není nakonfigurované — dočasně se používá localStorage (jen pro vývoj).");
      const repository = new LocalProjectRepository(window.localStorage);
      repositoryRef.current = repository;
      repository.list().then((projects) => !cancelled && setSavedProjects([...projects]));
      const eventRepository = new LocalEventRepository(window.localStorage, exhibitions);
      eventRepositoryRef.current = eventRepository;
      eventRepository.list().then((events) => {
        if (cancelled) return;
        setAdminEvents([...events]);
        setEventsHydrated(true);
      });
      const priceListRepository = new LocalPriceListRepository(window.localStorage, priceLists);
      priceListRepositoryRef.current = priceListRepository;
      priceListRepository.list().then((lists) => {
        if (cancelled) return;
        setAdminPriceLists([...lists]);
        setPriceListsHydrated(true);
      });
    }

    async function init() {
      // DB is primary persistence when configured (section 6). Local*Repository stays as
      // fallback: silent+warned in development, never in production (section 7) — a
      // production deploy with missing Supabase config must show "unavailable", not
      // quietly pretend localStorage is cloud storage.
      const remoteProjects = new RemoteApiProjectRepository();
      const probe = await resolvePersistenceProbe(() => remoteProjects.list());
      if (cancelled) return;

      if (probe.mode === "db") {
        const remoteEvents = new RemoteApiEventRepository();
        const remotePriceLists = new RemoteApiPriceListRepository();
        repositoryRef.current = remoteProjects;
        eventRepositoryRef.current = remoteEvents;
        priceListRepositoryRef.current = remotePriceLists;
        setSavedProjects([...probe.value]);
        const events = await remoteEvents.list();
        if (cancelled) return;
        setAdminEvents([...events]);
        setEventsHydrated(true);
        const lists = await remotePriceLists.list();
        if (cancelled) return;
        setAdminPriceLists([...lists]);
        setPriceListsHydrated(true);
        setPersistenceMode("db");
        // Section 3: DB catalog identity for technical-service pricing. Loaded once — the
        // catalog_items list itself (unlike pricing_entries) doesn't depend on which event/
        // currency is selected. Failure here is non-fatal: technicalCatalogItems just stays
        // empty and technical services keep reporting "missing" price, same as before this
        // step existed — never a hard blocker for the rest of the app.
        try {
          const remoteCatalogPricing = new RemoteApiCatalogPricingRepository();
          const items = await remoteCatalogPricing.listCatalogItems();
          if (cancelled) return;
          setDbCatalogItems([...items]);
        } catch (error) {
          console.warn("[HomeworkStudio] Nepodařilo se načíst katalog technických služeb z DB.", error);
        }
        // Generator booth picker: UNLIKE technical-service pricing above, a failure here must
        // stay VISIBLE (boothsError), never silently leave the picker empty/stale — see section
        // "API FAILURE": production must never quietly show static demo data as if it were live.
        try {
          const catalogItems = await catalogItemsAdminRepositoryRef.current.list();
          if (cancelled) return;
          setDbBoothTypes(selectGeneratorBooths(catalogItems));
          setBoothsError("");
          // Same fetched list, same failure-visibility rule as the booth picker above — a
          // dedicated try/catch so a booth-component adapt error can never silently blank the
          // (already-succeeded) booth picker or vice versa.
          setDbBoothComponents(selectGeneratorBoothComponents(catalogItems));
          setBoothComponentsError("");
        } catch (error) {
          if (cancelled) return;
          setBoothsError(error instanceof Error ? error.message : "Typové stánky se nepodařilo načíst.");
          setDbBoothTypes([]);
          setBoothComponentsError(error instanceof Error ? error.message : "Komponenty stánku se nepodařilo načíst.");
          setDbBoothComponents([]);
        }
        return;
      }

      if (probe.mode === "local-fallback") {
        useLocalFallback(true);
        setPersistenceMode("local-fallback");
        // No DB in this mode — the picker must show a real error/empty state, never fall back to
        // static demo data as if it were production truth.
        setBoothsError("Typové stánky vyžadují databázové připojení.");
        setDbBoothTypes([]);
        setBoothComponentsError("Komponenty stánku vyžadují databázové připojení.");
        setDbBoothComponents([]);
        return;
      }

      // "unavailable": repositoryRef/eventRepositoryRef stay null. Existing `if (!repository)
      // return;` guards in saveProject/deleteProject already no-op safely; the banner below
      // and saveProject's explicit check make sure the UI never claims a save succeeded.
      setPersistenceMode("unavailable");
      setBoothsError("Typové stánky vyžadují databázové připojení.");
      setDbBoothTypes([]);
      setBoothComponentsError("Komponenty stánku vyžadují databázové připojení.");
      setDbBoothComponents([]);
    }

    init();
    return () => {
      cancelled = true;
    };
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

  function navigateWorkspace(section: typeof workspaceSection, payload?: { catalogItemId?: string }) {
    if (workspaceSection === "events" && section !== "events" && !confirmLeaveEvent()) return;
    if (workspaceSection === "events" && section !== "events" && eventDirty) {
      eventRepositoryRef.current?.list().then((events) => setAdminEvents([...events]));
      setEventDirty(false);
    }
    setWorkspaceSection(section);
    setPricingAdminPreselect(section === "pricingAdmin" ? payload?.catalogItemId : undefined);
    if (section === "projects") {
      repositoryRef.current?.list().then((projects) => setSavedProjects([...projects]));
    }
  }

  /* ================================================= */
  /* DERIVED                                          */
  /* ================================================= */

  const selectedExhibition = adminEvents.find((event) => event.id === fairId);
  // Section 1 (Batch #2A fix): the PriceList shown/used must follow the PROJECT's chosen
  // currency, never the event's defaultPriceListId — defaultPriceListId is only a preference
  // for which currency to suggest when a fair is first picked (see handleFairChange), it must
  // never override an already-chosen EUR project back onto a CZK list. No fallback to the
  // other currency, no conversion — resolveEventPriceListForCurrency returns undefined when
  // this event genuinely has no PriceList in the requested currency yet.
  const resolvedEventPriceList = selectedExhibition
    ? resolveEventPriceListForCurrency(selectedExhibition, adminPriceLists, currency)
    : undefined;
  // Section 3/8: technical-service pricing entries are only ever loaded for the ONE PriceList
  // this project's event+currency actually resolved to — no cross-currency/cross-event
  // prefetching, so there is no risk of a stale EUR entry ever being visible while CZK is
  // selected. Re-fetches whenever the resolved PriceList changes (event or currency switch).
  const resolvedEventPriceListId = resolvedEventPriceList?.id;
  useEffect(() => {
    if (persistenceMode !== "db" || !resolvedEventPriceListId) {
      setDbPricingEntries([]);
      return;
    }
    let cancelled = false;
    const remoteCatalogPricing = new RemoteApiCatalogPricingRepository();
    remoteCatalogPricing
      .listPricingEntries(resolvedEventPriceListId)
      .then((entries) => {
        if (!cancelled) setDbPricingEntries([...entries]);
      })
      .catch((error) => {
        console.warn("[HomeworkStudio] Nepodařilo se načíst ceny technických služeb z DB.", error);
        if (!cancelled) setDbPricingEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [persistenceMode, resolvedEventPriceListId]);
  // Section 3: DB catalog rows mapped into the same ComponentDefinition shape the existing
  // pricing functions already understand — pricing-only, never merged into componentCatalogItems/
  // ComponentLibrary (see workflowProject.technicalCatalogItems usage below).
  const technicalCatalogItems = buildTechnicalCatalogItems(dbCatalogItems, dbPricingEntries);
  const selectedFair =
    fairs.find((fair) => fair.id === fairId) ??
    (selectedExhibition
      ? {
          id: selectedExhibition.id,
          name: selectedExhibition.name,
          priceList: resolvedEventPriceList?.name ?? "Ceník pro zvolenou měnu není dostupný.",
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

  // See domain/individualBooth.ts for why this scaffold is enough for every existing
  // selectedBooth-driven read below to work for Individual mode with no separate code path.
  //
  // MUST be referentially stable across renders that don't actually change the plot size —
  // an inline `createIndividualBooth(...)` object literal here is a NEW object identity on
  // EVERY render, and selectedBooth below is a dependency of the printSurfaceAssignments
  // useEffect further down. A fresh identity each render makes that effect fire every render;
  // its setState always produces a new (even if empty) array, which React never bails out of
  // (a new [] is never Object.is-equal to the previous one) — render → effect → setState →
  // render, forever ("Maximum update depth exceeded"). useMemo keyed on the actual plot inputs
  // is the real fix; see that effect for the second, independent no-op guard.
  // widthMm/depthMm on this scaffold are the WORKSPACE canvas (report section 4) — never the
  // real plot; the real, possibly non-rectangular plot is individualPlotPolygon, carried
  // separately and validated/rendered with dedicated polygon-aware logic (domain/plot.ts).
  const individualWorkspace: IndividualWorkspace = useMemo(
    () => ({ widthMm: individualWorkspaceWidthMm, depthMm: individualWorkspaceDepthMm }),
    [individualWorkspaceWidthMm, individualWorkspaceDepthMm],
  );
  const individualBooth: BoothType | undefined = useMemo(
    () => (type === "individualni" ? createIndividualBooth(individualWorkspace, individualPlotPolygon) : undefined),
    [type, individualWorkspace, individualPlotPolygon],
  );

  // resolveGeneratorBooth (not a plain .find) so an OLDER saved project resolves correctly even
  // if it stored an internalCode instead of the booth's own id — never a guess, undefined when
  // truly nothing matches (e.g. the booth was archived since the project was saved).
  const selectedBooth =
    type === "individualni" ? individualBooth : resolveGeneratorBooth(boothTypes, selectedBoothId);

  // Section "GENERÁTOR TYPOVEK" (2026-08-19): a booth with declared variants (T04..T25) NEVER
  // falls back to its own parent GLB — resolveBoothModelSource requires the SELECTED variant's
  // own modelAsset (or a demo/test fixture's explicit assetSourceBoothId), never a single shared
  // parent model for every variant. P86 (no variants) is completely unaffected — same
  // getMasterReferenceModel(selectedBooth?.assets) path as always.
  const selectedBoothModelSource = selectedBooth
    ? resolveBoothModelSource(selectedBooth, boothTypes, selectedVariantId)
    : undefined;
  const selectedBoothStoredModelAsset = selectedBoothModelSource?.kind === "stored" ? selectedBoothModelSource.asset : undefined;
  const resolvedStoredModelUrl = useAssetUrl(selectedBoothStoredModelAsset, undefined);
  const selectedBoothMasterModel =
    selectedBoothModelSource?.kind === "legacy"
      ? selectedBoothModelSource.asset
      : selectedBoothModelSource?.kind === "stored" && resolvedStoredModelUrl.url
        ? ({
            id: selectedBoothStoredModelAsset!.id,
            url: resolvedStoredModelUrl.url,
            role: "master-reference",
            unit: "mm",
            axisSystem: "x-right-y-depth-z-up",
          } as const)
        : undefined;
  const selectedBoothPlanVisualKey = selectedBooth
    ? `${selectedBooth.id}:${selectedBoothMasterModel?.id ?? "fallback"}:${selectedBoothMasterModel?.url ?? "canonical"}`
    : null;
  const handleBoothPlanVisualReadyChange = useCallback(
    (ready: boolean) => {
      setReadyBoothPlanVisualKey(
        ready ? selectedBoothPlanVisualKey : null,
      );
    },
    [selectedBoothPlanVisualKey],
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
      computePrintSurfaceAssignments(selectedBooth, realizationProfileId, current),
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

  // Section 5/22: for Individual mode, the relevant thing to auto-fit/Fit-button to is the REAL
  // plot polygon — never the full 10×10 m workspace canvas selectedBooth.widthMm/depthMm
  // represents here. Bounds MUST go through worldToPlanView first (matching every other
  // consumer of these mm coordinates on this canvas, e.g. the placed-component position style
  // below) — fitBoundsToViewport has no idea about the plan's own Y-flip, so feeding it raw
  // world coordinates for anything less than the FULL workspace would frame the wrong region
  // (this was the exact bug in components/configurator/PlotPolygonEditor.tsx before the fix —
  // see the foundation report). Typovka is untouched: individualPlotFitBounds is always
  // undefined for it, so useBoothViewport falls back to its original worldWidthMm/worldHeightMm
  // behavior exactly as before.
  const individualPlotFitBounds =
    type === "individualni" && individualPlotPolygon && selectedBooth?.widthMm && selectedBooth?.depthMm
      ? getBounds(individualPlotPolygon.map((point) => worldToPlanView(point, selectedBooth.widthMm!, selectedBooth.depthMm!)))
      : undefined;

  const boothViewport = useBoothViewport({
    worldWidthMm: selectedBooth?.widthMm ?? 2000,
    worldHeightMm: selectedBooth?.depthMm ?? 2000,
    enabled: step === 3 && Boolean(selectedBooth),
    fitBounds: individualPlotFitBounds,
    // Forces a fresh auto-fit whenever Individual mode switches INTO Konstrukce/Mobiliář (report
    // section 4 — "when I open 2D Konstrukce/Mobiliář, auto-fit") — this shared hook instance
    // never unmounts between substep switches, so without this the transform would otherwise
    // silently stay stuck at whatever it was (or its un-fit default) from before. Typovka keys
    // the one-shot fit by the selected booth visual: booth/asset changes get one fresh fit,
    // ordinary rerenders and later manual zoom do not.
    fitKey:
      type === "individualni"
        ? individualSubStep
        : (selectedBoothPlanVisualKey ?? "typovka"),
    initialFitReady:
      selectedBoothPlanVisualKey !== null &&
      readyBoothPlanVisualKey === selectedBoothPlanVisualKey,
  });

  const canOpenConfigurator =
    Boolean(
      selectedBooth &&
        selectedBooth.configReady &&
        (
          selectedBooth.variants.length ===
            0 ||
          (selectedVariantId !== "" && selectedBoothModelSource !== undefined)
        )
    );

  const orderInventory = calculateOrderInventory(
    importedOrder,
    placedComponents,
  );

  // Section 30/32: components/zones that fell outside the CURRENT plot polygon (e.g. after the
  // user edited it smaller) — surfaced as a conflict, NEVER auto-deleted/auto-clipped.
  const constructionOutsidePlotIds = individualPlotPolygon
    ? findComponentAnchorsOutsidePlot(
        placedComponents
          .filter((component) => component.sceneLayer === "booth")
          .map((component) => ({ id: component.id, x: component.xMm, y: component.yMm })),
        individualPlotPolygon,
      )
    : [];
  const floorZonesOutsidePlot = individualPlotPolygon
    ? findFloorZonesOutsidePlot(individualFloorZones, individualPlotPolygon)
    : [];
  const overlappingFloorZonePairs = findOverlappingFloorZonePairs(individualFloorZones);
  const floorZoneConflicts = Array.from(
    new Set([...floorZonesOutsidePlot, ...overlappingFloorZonePairs.flat()]),
  );
  // Report sections 3/17/24: "Plocha" is done only once the plot is BOTH confirmed/locked and
  // still geometrically valid (confirming already required validity, but this stays defensive —
  // e.g. against future code paths that might set the status without re-validating). "Podlaha" is
  // done once every zone is individually confirmed — zero zones is itself a valid, complete state
  // (section 16/17), a lone unconfirmed draft zone is not.
  const isIndividualPlotConfirmed = isPlotConfirmed(individualPlotStatus);
  const isIndividualPlotStepComplete = isIndividualPlotConfirmed && canConfirmPlot(individualPlotPolygon);
  const hasUnconfirmedFloorZone = individualFloorZones.some((zone) => !isFloorZoneConfirmed(zone));
  const isIndividualFloorStepComplete = isIndividualPlotStepComplete && !hasUnconfirmedFloorZone;
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
    visualizationViews,
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
    constructionVisibility,
    internalNote: projectNotes.internalNote,
    customerNote: projectNotes.customerNote,
    printSurfaceAssignments,
    exportCalculationOptions,
    priceLists: adminPriceLists,
    technicalCatalogItems,
  };

  function ensureProjectStorageId(): string {
    if (projectId) return projectId;
    const id = `project-${crypto.randomUUID()}`;
    setProjectId(id);
    setProjectCreatedAt((current) => current || new Date().toISOString());
    return id;
  }

  async function addPersistentGraphics(
    files: FileList | readonly File[],
    printSurfaceId?: string,
  ): Promise<void> {
    const ownerId = ensureProjectStorageId();
    const batch = Array.from(files);
    const results = await Promise.allSettled(batch.map(async (file) => {
      const [asset, dimensions] = await Promise.all([
        uploadAsset(file, { category: "project-graphics", ownerId }, setGraphicsUpload),
        readRasterImageDimensions(file),
      ]);
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
        printSurfaceId: printSurfaceId ?? selectedPrintSurfaceId ?? undefined,
        widthPx: dimensions?.widthPx,
        heightPx: dimensions?.heightPx,
        createdAt: asset.createdAt,
      };
    }));
    const additions = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (additions.length) setGraphicsFiles((current) => [...current, ...additions]);
    if (printSurfaceId && additions[0] && selectedBooth) {
      setPrintSurfaceAssignments((current) => [...assignArtworkToPrintSurface(
        selectedBooth,
        realizationProfileId,
        current,
        printSurfaceId,
        additions[0]!.id,
      )]);
    }
    batch.forEach((file, index) => {
      if (results[index]?.status === "rejected") temporaryGraphicFilesRef.current.set(`retry-${Date.now()}-${index}`, file);
    });
  }

  function assignExistingArtwork(printSurfaceId: string, artworkFileId: string) {
    if (!selectedBooth) return;
    setPrintSurfaceAssignments((current) => [...assignArtworkToPrintSurface(
      selectedBooth,
      realizationProfileId,
      current,
      printSurfaceId,
      artworkFileId,
    )]);
  }

  function removeSurfaceArtwork(printSurfaceId: string) {
    setPrintSurfaceAssignments((current) => [...removeArtworkFromPrintSurface(current, printSurfaceId)]);
  }

  function updateSurfaceArtworkPlacement(printSurfaceId: string, placement: ArtworkPlacement) {
    setPrintSurfaceAssignments((current) => [
      ...updatePrintSurfaceArtworkPlacement(current, printSurfaceId, placement),
    ]);
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
    const world = planViewToWorld(display, selectedBooth.widthMm, selectedBooth.depthMm);
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
    setPrintSurfaceAssignments(
      booth
        ? computePrintSurfaceAssignments(booth, realizationProfileId, [])
        : [],
    );

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
    setVisualizationViews([]);
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
    setIndividualWidthMm(INDIVIDUAL_DEFAULT_WIDTH_MM);
    setIndividualDepthMm(INDIVIDUAL_DEFAULT_DEPTH_MM);
    setIndividualWorkspaceWidthMm(DEFAULT_INDIVIDUAL_WORKSPACE.widthMm);
    setIndividualWorkspaceDepthMm(DEFAULT_INDIVIDUAL_WORKSPACE.depthMm);
    setIndividualPlotPolygon(undefined);
    setIndividualPlotStatus("draft");
    setIndividualFloorZones([]);
    setIndividualPlotPrimitives([]);
    setPrimitiveMergeError(null);
    setIndividualSubStep("plocha");
    setEditingFloorZoneId(null);

    setPlacedComponents([]);
    setSelectedComponentId(null);
    setSelectedConstructionPartId(null);
    setConstructionUserLocks({});
    setConstructionVisibility({});

    componentDragSessionRef.current = null;

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
      // individualWidthMm/individualDepthMm are the LEGACY foundation fields (domain/plot.ts's
      // resolveIndividualPlotPolygon) — a project saved after the polygon foundation writes
      // ONLY individualPlotPolygon/workspace below, never these, so the polygon is unambiguously
      // the source of truth going forward. Not destructive: the rectangle they described is
      // already fully represented as individualPlotPolygon once one exists.
      individualWorkspaceWidthMm: type === "individualni" ? individualWorkspaceWidthMm : undefined,
      individualWorkspaceDepthMm: type === "individualni" ? individualWorkspaceDepthMm : undefined,
      individualPlotPolygon: type === "individualni" ? individualPlotPolygon : undefined,
      individualPlotStatus: type === "individualni" ? individualPlotStatus : undefined,
      individualFloorZones: type === "individualni" ? individualFloorZones : undefined,
      individualPlotPrimitives: type === "individualni" ? individualPlotPrimitives : undefined,
      notes: projectNotes,
      assemblyNotes,
      constructionNotes,
      constructionUserLocks,
      constructionVisibility,
      technicalRequirements,
      importedOrder,
      sceneObjects: placedComponents,
      visualizationViews,
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
    if (!repository) {
      setSaveError(persistenceMode === "unavailable" ? "Databázové úložiště není dostupné. Projekt nebyl uložen." : "Úložiště zatím není připravené, zkuste to prosím znovu za chvíli.");
      return;
    }
    const snapshot = projectSnapshot();
    setProjectId(snapshot.id);
    setProjectCreatedAt(snapshot.createdAt);
    setSaveStatus("Ukládání…");
    setSaveError("");
    try {
      await repository.save(snapshot);
      setSavedProjects([...(await repository.list())]);
      setSaveStatus("Uloženo");
      window.setTimeout(() => setSaveStatus(""), 1400);
    } catch (error) {
      setSaveStatus("");
      setSaveError(error instanceof ConcurrencyConflictError ? "Data byla mezitím změněna jinde. Obnovte stránku před uložením." : "Uložení projektu se nezdařilo.");
    }
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
    // Legacy quick-rectangle draft inputs (step 2's convenience form) — not authoritative once a
    // real polygon exists; still seeded from the legacy fields when present so an OLD project's
    // "size" keeps showing sensibly if the user revisits step 2.
    setIndividualWidthMm(project.individualWidthMm ?? INDIVIDUAL_DEFAULT_WIDTH_MM);
    setIndividualDepthMm(project.individualDepthMm ?? INDIVIDUAL_DEFAULT_DEPTH_MM);
    setIndividualWorkspaceWidthMm(project.individualWorkspaceWidthMm ?? DEFAULT_INDIVIDUAL_WORKSPACE.widthMm);
    setIndividualWorkspaceDepthMm(project.individualWorkspaceDepthMm ?? DEFAULT_INDIVIDUAL_WORKSPACE.depthMm);
    // resolveIndividualPlotPolygon prefers the real polygon and only derives a rectangle from
    // legacy individualWidthMm/individualDepthMm when no polygon was ever saved — see domain/
    // plot.ts. Never rewritten back into the project document by this read; only an actual save
    // persists the derived polygon as the new source of truth.
    setIndividualPlotPolygon(resolveIndividualPlotPolygon(project));
    // resolvePlotStatus defaults a project saved before locking existed to "draft" — never
    // silently treated as already-confirmed (domain/plot.ts).
    setIndividualPlotStatus(resolvePlotStatus(project.individualPlotStatus));
    setIndividualFloorZones([...(project.individualFloorZones ?? [])]);
    setIndividualPlotPrimitives([...(project.individualPlotPrimitives ?? [])]);
    setPrimitiveMergeError(null);
    setIndividualSubStep("plocha");
    setEditingFloorZoneId(null);
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
    setVisualizationViews([...project.visualizationViews]);
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
    setStep(
      project.projectType === "individualni"
        ? resolveIndividualPlotPolygon(project)
          ? 3
          : 1
        : project.boothId
          ? 3
          : 1,
    );
  }

  async function deleteProject(projectToDeleteId: string) {
    const repository = repositoryRef.current;
    if (!repository) return;
    try {
      await repository.delete(projectToDeleteId);
      setSavedProjects([...(await repository.list())]);
    } catch {
      setSaveError("Smazání projektu se nezdařilo.");
    }
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
    if (type === "individualni") {
      // Section 19: the ANCHOR (center) must be inside/on the plot polygon — never a
      // full-footprint-bounding-box-inside-polygon rule (see domain/plot.ts's
      // isAnchorInsidePlot doc comment for why).
      return individualPlotPolygon ? isPlacementValidOnPlot(individualPlotPolygon, centerX, centerY) : false;
    }
    return selectedBooth
      ? isPlacementValid(
          selectedBooth,
          component,
          {
            x: centerX,
            y: centerY,
            rotationDeg,
          },
          constructionVisibility,
        )
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
    if (!selectedBooth) {
      return { x: centerX, y: centerY };
    }

    // Individual mode snaps to the 250 mm nominal layout grid only — validity (whether the
    // snapped anchor is actually inside the plot) is a SEPARATE check (isPositionValid/
    // tryMoveComponentOnPlot above), never a rectangular clamp against the workspace canvas.
    // Typovka keeps its existing construction-edge snap completely untouched.
    return type === "individualni"
      ? { x: roundToGridMm(centerX), y: roundToGridMm(centerY) }
      : snapPlacement(
          selectedBooth,
          component,
          centerX,
          centerY,
          rotationDeg,
          constructionVisibility,
        );
  }

  /* ================================================= */
  /* ADD COMPONENTS                                   */
  /* ================================================= */

  function addComponent(definition: ComponentDefinition) {
    // Report section 28/31: for Individual mode, the default insert point must be a position
    // that's ALWAYS valid on the real (possibly relocated/non-rectangular) plot polygon — a fixed
    // world point could land far outside the plot (and outside whatever the Fit-scoped viewport
    // is currently showing), which read as "the component vanished after insert" even though it
    // was really just off-screen. Typovka is completely unaffected (no plot polygon exists there,
    // so it always takes the original (1000, 1500) default it always used).
    const insertPoint =
      type === "individualni" && individualPlotPolygon
        ? resolveDefaultAnchorOnPlot(individualPlotPolygon)
        : { x: 1000, y: 1500 };
    const component = placeComponent(
      definition,
      // crypto.randomUUID() (same convention as projectSnapshot's own id generation below) —
      // never Date.now()-only, which can collide across two rapid inserts of the same definition
      // type (report section 12/30's id-uniqueness audit).
      `${definition.type}-${crypto.randomUUID()}`,
      insertPoint.x,
      insertPoint.y
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
      componentDragSessionRef.current = null;
      setEditorMessage("");
      return;
    }

    const displayPointer = boothViewport.clientToWorld(
      event.clientX,
      event.clientY,
    );
    if (!displayPointer || !selectedBooth?.widthMm || !selectedBooth.depthMm) {
      componentDragSessionRef.current = null;
      return;
    }
    const pointerWorld = planViewToWorld(
      displayPointer,
      selectedBooth.widthMm,
      selectedBooth.depthMm,
    );
    componentDragSessionRef.current = {
      componentId,
      pointerId: event.pointerId,
      offset: createComponentDragOffset(component, pointerWorld),
    };

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
      componentDragSessionRef.current?.componentId !== componentId ||
      componentDragSessionRef.current.pointerId !== event.pointerId ||
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
      componentDragSessionRef.current = null;
      return;
    }

    const displayPointer = boothViewport.clientToWorld(
      event.clientX,
      event.clientY
    );

    if (!displayPointer) {
      return;
    }

    const pointer = planViewToWorld(
      displayPointer,
      selectedBooth.widthMm,
      selectedBooth.depthMm,
    );
    const requestedCenter = resolveDraggedComponentCenter(
      pointer,
      componentDragSessionRef.current.offset,
    );

    const snapped =
      applySnap(
        component,

        requestedCenter.x,
        requestedCenter.y,

        component.rotationDeg
      );

    const moveComponent = (movedComponent: PlacedComponent) => {
      setPlacedComponents((items) =>
        items.map((item) =>
          item.id === componentId ? movedComponent : item
        )
      );
    };

    if (type === "individualni") {
      // Polygon-aware move — no X-only/Y-only slide fallback (report section 26: a plot
      // boundary is a soft layout boundary, not a rigid wall obstacle to slide along).
      if (!individualPlotPolygon) {
        setEditorMessage("Nejdřív nakresli plochu stánku v kroku Plocha.");
        return;
      }
      const moveResult = tryMoveComponentOnPlot(
        individualPlotPolygon,
        component,
        Math.round(snapped.x),
        Math.round(snapped.y),
      );
      if (moveResult.accepted) {
        moveComponent(moveResult.component);
        setEditorMessage("");
      } else if (moveResult.reason !== "locked") {
        setEditorMessage("Mimo plochu stánku.");
      }
      return;
    }

    const directMove = tryMoveComponent(
      selectedBooth,
      component,
      snapped.x,
      snapped.y,
      constructionVisibility,
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
      snapped.x,
      component.yMm,
      constructionVisibility,
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
      snapped.y,
      constructionVisibility,
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
    if (componentDragSessionRef.current?.pointerId === event.pointerId) {
      componentDragSessionRef.current = null;
    }
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
      constructionVisibility,
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
  /* INDIVIDUAL: PLOCHA / PODLAHA PANELS              */
  /* ================================================= */

  // Report sections 2-4: the workspace is a user-resizable DRAWING CANVAS, never the booth area
  // itself (individualWorkspace stays a completely separate concept from individualPlotPolygon —
  // see domain/plot.ts). A shrink that would leave part of the ALREADY-DRAWN plot outside the new
  // canvas is rejected outright (never a silent clip/delete of the polygon) — the user must either
  // pick a larger workspace or edit/shrink the plot itself first.
  function resizeIndividualWorkspace(widthMm: number, depthMm: number) {
    const nextWorkspace: IndividualWorkspace = { widthMm, depthMm };
    if (individualPlotPolygon && !isPolygonWithinWorkspace(individualPlotPolygon, nextWorkspace)) {
      setIndividualWorkspaceSizeError("Nová pracovní plocha je menší, než nakreslená plocha stánku — zvětši ji, nebo nejdřív uprav (zmenši) plochu stánku.");
      return;
    }
    setIndividualWorkspaceSizeError(null);
    setIndividualWorkspaceWidthMm(widthMm);
    setIndividualWorkspaceDepthMm(depthMm);
  }

  // Report sections 5-11: rectangle-primitive authoring — insert/select(via row)/move-by-250mm/
  // rotate-90/delete/duplicate, plus the union action that actually produces a real PlotPolygon.
  function addPrimitive() {
    const anchor = individualPlotPolygon
      ? resolveDefaultAnchorOnPlot(individualPlotPolygon)
      : { x: individualWorkspace.widthMm / 2, y: individualWorkspace.depthMm / 2 };
    const primitive = createRectanglePrimitive({ id: crypto.randomUUID(), xMm: anchor.x, yMm: anchor.y });
    setIndividualPlotPrimitives((items) => [...items, primitive]);
    setPrimitiveMergeError(null);
  }

  function updatePrimitive(id: string, patch: Partial<Pick<RectanglePrimitive, "xMm" | "yMm" | "widthMm" | "depthMm">>) {
    setIndividualPlotPrimitives((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  function movePrimitiveByGrid(id: string, dxMm: number, dyMm: number) {
    setIndividualPlotPrimitives((items) => items.map((item) => (item.id === id ? { ...item, xMm: item.xMm + dxMm, yMm: item.yMm + dyMm } : item)));
  }

  function rotatePrimitiveById(id: string) {
    setIndividualPlotPrimitives((items) => items.map((item) => (item.id === id ? rotatePrimitive90(item) : item)));
  }

  function duplicatePrimitiveById(id: string) {
    setIndividualPlotPrimitives((items) => {
      const source = items.find((item) => item.id === id);
      return source ? [...items, duplicatePrimitive(source, crypto.randomUUID())] : items;
    });
  }

  function deletePrimitive(id: string) {
    setIndividualPlotPrimitives((items) => items.filter((item) => item.id !== id));
  }

  function mergePrimitivesIntoPlot() {
    const result = mergePrimitivesToPolygon(individualPlotPrimitives);
    if (result.status === "merged") {
      setPrimitiveMergeError(null);
      setIndividualPlotPolygon(result.polygon);
      return;
    }
    setPrimitiveMergeError(
      result.status === "no-primitives"
        ? "Nejdřív vlož alespoň jeden obdélník."
        : `Obdélníky netvoří jednu souvislou plochu (${result.regionCount} oddělené části) — posuň je tak, aby se dotýkaly nebo překrývaly.`,
    );
  }

  function addFloorZone() {
    // Report section 12 root cause (1/2): `Date.now()`-based ids can collide on two rapid
    // consecutive adds — crypto.randomUUID() (same convention as addComponent/projectSnapshot)
    // is collision-safe.
    const id = crypto.randomUUID();
    // Report section 12 root cause (2/2): a default rectangle ALWAYS anchored at world (0,0) meant
    // two freshly-added zones (before either was moved) were geometrically IDENTICAL — indistinguishable
    // on screen, which is exactly what read as "duplicate zones". Centering the default on the plot's
    // own safe interior anchor fixes the common case; "Vyplnit volnou plochu" (below) is the real
    // production answer for adding a second/third zone without manual repositioning.
    const anchor = individualPlotPolygon ? resolveDefaultAnchorOnPlot(individualPlotPolygon) : { x: 500, y: 500 };
    const polygon = createRectanglePlotPolygon(1000, 1000).map((vertex) => ({ x: vertex.x + anchor.x - 500, y: vertex.y + anchor.y - 500 }));
    const zone = createFloorZone({ id, polygon });
    setIndividualFloorZones((zones) => [...zones, zone]);
    setEditingFloorZoneId(id);
  }

  // Report sections 16-18: fills the currently-edited zone's polygon with the real remaining free
  // area (plot minus other CONFIRMED zones). When the free area is split into more than one
  // disconnected region (see domain/floorZones.ts's freeFloorAreaRegions doc comment for why),
  // the LARGEST region is used and the caller is told the fill was partial — never a fake
  // connecting edge between the pieces, never silently dropping the rest.
  function fillFreeFloorArea(zoneId: string) {
    if (!individualPlotPolygon) return;
    const regions = freeFloorAreaRegions(individualPlotPolygon, individualFloorZones);
    if (regions.length === 0) {
      setEditorMessage("Volná plocha už je 0 m² — celý booth je pokrytý potvrzenými zónami.");
      return;
    }
    const largest = regions.reduce((best, region) => (plotAreaSquareMeters(region) > plotAreaSquareMeters(best) ? region : best));
    updateFloorZone(zoneId, { polygon: largest });
    setEditorMessage(
      regions.length > 1
        ? `Vyplněna pouze největší volná oblast (${plotAreaSquareMeters(largest).toFixed(2)} m²) — volná plocha je rozdělená na ${regions.length} samostatné části.`
        : "",
    );
  }

  function updateFloorZone(id: string, patch: Partial<Pick<FloorZone, "base" | "finish" | "label" | "colorLabel" | "polygon">>) {
    setIndividualFloorZones((zones) => zones.map((zone) => (zone.id === id ? { ...zone, ...patch } : zone)));
  }

  function deleteFloorZone(id: string) {
    setIndividualFloorZones((zones) => zones.filter((zone) => zone.id !== id));
    if (editingFloorZoneId === id) setEditingFloorZoneId(null);
  }

  // Report sections 1/8: confirm/unlock — the same draft<->confirmed pattern applied to both the
  // plot itself and each floor zone. Confirming is HARD-gated on validity (never "save now, warn
  // later"); unlocking is always allowed (it only ever loosens a constraint).
  function confirmIndividualPlot() {
    if (canConfirmPlot(individualPlotPolygon)) setIndividualPlotStatus("confirmed");
  }

  function unlockIndividualPlot() {
    setIndividualPlotStatus("draft");
  }

  function confirmFloorZoneById(id: string) {
    if (!individualPlotPolygon) return;
    const zone = individualFloorZones.find((candidate) => candidate.id === id);
    if (!zone) return;
    const result = validateFloorZoneForConfirm(zone, individualPlotPolygon, individualFloorZones);
    if (!result.valid) return;
    setIndividualFloorZones((zones) => zones.map((candidate) => (candidate.id === id ? confirmFloorZone(candidate) : candidate)));
  }

  function unlockFloorZoneById(id: string) {
    setIndividualFloorZones((zones) => zones.map((candidate) => (candidate.id === id ? unlockFloorZone(candidate) : candidate)));
  }

  // Report section 14: the summary — like uncoveredFloorAreaSquareMeters, only CONFIRMED zones
  // count toward "explicit zones" / "bez krytiny" so the two numbers stay mutually consistent; a
  // zone still being drawn/edited isn't reserved yet.
  const confirmedFloorZones = individualFloorZones.filter(isFloorZoneConfirmed);
  const floorAreaTotals = totalFloorAreaByFinish(confirmedFloorZones);
  const confirmedFloorZonesAreaM2 = confirmedFloorZones.reduce((sum, zone) => sum + plotAreaSquareMeters(zone.polygon), 0);
  const uncoveredFloorAreaM2 = individualPlotPolygon ? uncoveredFloorAreaSquareMeters(individualPlotPolygon, individualFloorZones) : 0;
  const editingFloorZone = individualFloorZones.find((zone) => zone.id === editingFloorZoneId);
  const editingFloorZoneConfirmed = editingFloorZone ? isFloorZoneConfirmed(editingFloorZone) : false;
  const editingFloorZoneConfirmResult =
    editingFloorZone && individualPlotPolygon
      ? validateFloorZoneForConfirm(editingFloorZone, individualPlotPolygon, individualFloorZones)
      : null;

  const individualPlotSubStepPanel =
    type !== "individualni" ? null : individualSubStep === "plocha" ? (
      <section className="individualSubStepPanel">
        {constructionOutsidePlotIds.length > 0 && (
          <p className="uploadError persistenceBanner">
            {constructionOutsidePlotIds.length} {constructionOutsidePlotIds.length === 1 ? "prvek konstrukce je" : "prvky/prvků konstrukce jsou"} mimo aktuální plochu stánku — přesuň je, smaž je, nebo uprav plochu zpět.
          </p>
        )}
        {/* Report section 2-4: workspace = drawing canvas only, NEVER the booth area (that's
            individualPlotPolygon, drawn below) — user-resizable, shrink is rejected (not
            silently clipped) if it would leave the already-drawn plot outside the new canvas. */}
        <div className="individualWorkspaceSizeBar">
          <span className="individualWorkspaceSizeLabel">PRACOVNÍ PLOCHA (jen canvas, ne plocha stánku)</span>
          <PlotSizeInput label="ŠÍŘKA" value={individualWorkspaceWidthMm} onCommit={(width) => resizeIndividualWorkspace(width, individualWorkspaceDepthMm)} />
          <PlotSizeInput label="HLOUBKA" value={individualWorkspaceDepthMm} onCommit={(depth) => resizeIndividualWorkspace(individualWorkspaceWidthMm, depth)} />
        </div>
        {individualWorkspaceSizeError && <p className="uploadError persistenceBanner">{individualWorkspaceSizeError}</p>}

        {/* Report sections 5-11: rectangle-primitive authoring — an ALTERNATIVE to point-by-point
            polygon drawing (below), never a replacement for it. "Sloučit do plochy stánku" is the
            only action that actually writes individualPlotPolygon; the primitive list itself is
            just an authoring helper. */}
        {!isIndividualPlotConfirmed && (
          <div className="primitiveBuilder">
            <span className="individualWorkspaceSizeLabel">OBDÉLNÍKOVÉ PRIMITIVY (rychlé skládání plochy)</span>
            {individualPlotPrimitives.length === 0 && <p className="libraryHint">Zatím žádné primitivy — buď kresli plochu ručně výše, nebo vlož obdélníky a slouč je do plochy.</p>}
            <div className="primitiveList">
              {individualPlotPrimitives.map((primitive, index) => (
                <div key={primitive.id} className="primitiveRow">
                  <span className="primitiveRowLabel">#{index + 1}</span>
                  <PlotSizeInput label="Š" value={primitive.widthMm} onCommit={(width) => updatePrimitive(primitive.id, { widthMm: width })} />
                  <PlotSizeInput label="H" value={primitive.depthMm} onCommit={(depth) => updatePrimitive(primitive.id, { depthMm: depth })} />
                  <span className="primitiveMoveGroup">
                    <button type="button" className="lightButton" title="Posunout doleva o 250mm" onClick={() => movePrimitiveByGrid(primitive.id, -INDIVIDUAL_GRID_MM, 0)}>←</button>
                    <button type="button" className="lightButton" title="Posunout doprava o 250mm" onClick={() => movePrimitiveByGrid(primitive.id, INDIVIDUAL_GRID_MM, 0)}>→</button>
                    <button type="button" className="lightButton" title="Posunout nahoru o 250mm" onClick={() => movePrimitiveByGrid(primitive.id, 0, -INDIVIDUAL_GRID_MM)}>↑</button>
                    <button type="button" className="lightButton" title="Posunout dolů o 250mm" onClick={() => movePrimitiveByGrid(primitive.id, 0, INDIVIDUAL_GRID_MM)}>↓</button>
                  </span>
                  <button type="button" className="lightButton" title="Otočit o 90°" onClick={() => rotatePrimitiveById(primitive.id)}>⟳ {primitive.rotationDeg}°</button>
                  <button type="button" className="lightButton" onClick={() => duplicatePrimitiveById(primitive.id)}>Duplikovat</button>
                  <button type="button" className="lightButton" onClick={() => deletePrimitive(primitive.id)}>Smazat</button>
                </div>
              ))}
            </div>
            <div className="primitiveActionsBar">
              <button type="button" className="lightButton" onClick={addPrimitive}>+ Přidat obdélník</button>
              <button type="button" className="primaryButton" disabled={individualPlotPrimitives.length === 0} onClick={mergePrimitivesIntoPlot}>
                Sloučit do plochy stánku
              </button>
            </div>
            {primitiveMergeError && <p className="uploadError persistenceBanner">{primitiveMergeError}</p>}
          </div>
        )}

        <PlotPolygonEditor
          workspace={individualWorkspace}
          polygon={individualPlotPolygon}
          onPolygonChange={setIndividualPlotPolygon}
          quickRectangleDefaultWidthMm={individualWidthMm}
          quickRectangleDefaultDepthMm={individualDepthMm}
          readOnly={isIndividualPlotConfirmed}
          referenceShapes={individualPlotPrimitives.map((primitive) => ({ id: primitive.id, polygon: rectanglePrimitivePolygon(primitive), className: "plotPrimitiveShape" }))}
        />
        <div className="individualPlotLockBar">
          {isIndividualPlotConfirmed ? (
            <>
              <span className="individualStepStatusConfirmed">✓ Plocha potvrzena a zamčena.</span>
              <button type="button" className="lightButton" onClick={unlockIndividualPlot}>Upravit plochu</button>
            </>
          ) : (
            <button
              type="button"
              className="primaryButton"
              disabled={!canConfirmPlot(individualPlotPolygon)}
              onClick={confirmIndividualPlot}
            >
              Potvrdit plochu / Zamknout plochu stánku
            </button>
          )}
          <button
            type="button"
            className="primaryButton"
            disabled={!isIndividualPlotStepComplete}
            onClick={() => setIndividualSubStep("podlaha")}
          >
            Další – Podlaha
          </button>
        </div>
      </section>
    ) : individualSubStep === "podlaha" ? (
      <section className="individualSubStepPanel">
        {!isIndividualPlotConfirmed && (
          <p className="temporaryNotice persistenceBanner">Plocha stánku ještě není potvrzená — nejdřív ji potvrď v kroku "Plocha".</p>
        )}
        {floorZoneConflicts.length > 0 && (
          <p className="uploadError persistenceBanner">
            {floorZonesOutsidePlot.length > 0 && `${floorZonesOutsidePlot.length} podlahová zóna mimo plochu. `}
            {overlappingFloorZonePairs.length > 0 && `${overlappingFloorZonePairs.length} překryv zón.`}
          </p>
        )}
        <div className="floorZoneSummary">
          <span>Celková plocha stánku: <strong>{individualPlotPolygon ? plotAreaSquareMeters(individualPlotPolygon).toFixed(2) : "0.00"} m²</strong></span>
          <span>Explicitní zóny: <strong>{confirmedFloorZonesAreaM2.toFixed(2)} m²</strong></span>
          <span>Bez krytiny: <strong>{uncoveredFloorAreaM2.toFixed(2)} m²</strong></span>
          {FLOOR_ZONE_FINISHES.filter((finish) => finish !== "none").map((finish) => floorAreaTotals[finish] > 0 && (
            <span key={finish}>{FLOOR_ZONE_FINISH_LABELS_CS[finish]}: <strong>{floorAreaTotals[finish].toFixed(2)} m²</strong></span>
          ))}
        </div>
        <div className="floorZoneList">
          {individualFloorZones.length === 0 && <p className="libraryHint">Zatím žádné zóny — celá plocha je "Bez krytiny".</p>}
          {individualFloorZones.map((zone) => {
            const zoneConfirmed = isFloorZoneConfirmed(zone);
            return (
              <div key={zone.id} className={editingFloorZoneId === zone.id ? "floorZoneRow active" : "floorZoneRow"}>
                <button type="button" className="lightButton" onClick={() => setEditingFloorZoneId(zone.id)}>
                  {zoneConfirmed ? "✓ " : ""}{zone.label || "Zóna"} · {plotAreaSquareMeters(zone.polygon).toFixed(2)} m²
                </button>
                <select disabled={zoneConfirmed} value={zone.base} onChange={(event) => updateFloorZone(zone.id, { base: event.target.value as FloorZone["base"] })}>
                  {FLOOR_ZONE_BASES.map((base) => <option key={base} value={base}>{FLOOR_ZONE_BASE_LABELS_CS[base]}</option>)}
                </select>
                <select disabled={zoneConfirmed} value={zone.finish} onChange={(event) => updateFloorZone(zone.id, { finish: event.target.value as FloorZone["finish"] })}>
                  {FLOOR_ZONE_FINISHES.map((finish) => <option key={finish} value={finish}>{FLOOR_ZONE_FINISH_LABELS_CS[finish]}</option>)}
                </select>
                <input
                  type="text"
                  className="floorZoneColorInput"
                  placeholder="Barva / dekor (např. Černý)"
                  disabled={zoneConfirmed}
                  value={zone.colorLabel ?? ""}
                  onChange={(event) => updateFloorZone(zone.id, { colorLabel: event.target.value || undefined })}
                />
                {zoneConfirmed ? (
                  <button type="button" className="lightButton" onClick={() => unlockFloorZoneById(zone.id)}>Upravit zónu</button>
                ) : (
                  <button
                    type="button"
                    className="lightButton"
                    disabled={!individualPlotPolygon || !validateFloorZoneForConfirm(zone, individualPlotPolygon, individualFloorZones).valid}
                    onClick={() => confirmFloorZoneById(zone.id)}
                  >
                    Potvrdit zónu
                  </button>
                )}
                <button type="button" className="lightButton" onClick={() => deleteFloorZone(zone.id)}>Smazat</button>
              </div>
            );
          })}
          <button type="button" className="lightButton" onClick={addFloorZone}>+ Přidat zónu</button>
        </div>
        {editingFloorZoneConfirmResult && !editingFloorZoneConfirmResult.valid && (
          <p className="uploadError persistenceBanner">
            {editingFloorZoneConfirmResult.issues.map((issue) => FLOOR_ZONE_CONFIRM_ISSUE_LABELS_CS[issue] ?? issue).join(" ")}
          </p>
        )}
        {editingFloorZone && !editingFloorZoneConfirmed && (
          <div className="individualPlotLockBar">
            <button type="button" className="lightButton" onClick={() => fillFreeFloorArea(editingFloorZone.id)}>
              Vyplnit volnou plochu
            </button>
          </div>
        )}
        {individualPlotPolygon && (
          <PlotPolygonEditor
            // Remounts (fresh viewport fit + fresh draw state) whenever the user switches which
            // zone they're editing — a shared instance would otherwise carry over stale
            // draft/isDrawing state and viewport transform from whatever zone was open before.
            // "no-zone-selected" is its own remount identity too, so the plot-boundary preview
            // (report section 2) always starts from a clean, freshly-fit state.
            key={editingFloorZone?.id ?? "no-zone-selected"}
            workspace={individualWorkspace}
            polygon={editingFloorZone?.polygon}
            onPolygonChange={(polygon) => editingFloorZone && updateFloorZone(editingFloorZone.id, { polygon })}
            readOnly={!editingFloorZone || editingFloorZoneConfirmed}
            boundaryPolygon={individualPlotPolygon}
            referenceShapes={[
              { id: "plot", polygon: individualPlotPolygon, className: "plotReferenceShape" },
              ...individualFloorZones.filter((zone) => zone.id !== editingFloorZone?.id).map((zone) => ({ id: zone.id, polygon: zone.polygon })),
            ]}
          />
        )}
        <div className="individualPlotLockBar">
          <button
            type="button"
            className="primaryButton"
            disabled={!isIndividualFloorStepComplete}
            onClick={() => setIndividualSubStep("konstrukce")}
          >
            Další – Konstrukce
          </button>
        </div>
      </section>
    ) : null;

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
          saveError={saveError}
        />

        {persistenceMode === "local-fallback" && (
          <p className="temporaryNotice persistenceBanner">Databázové úložiště není nakonfigurované — projekty, eventy a ceníky se dočasně ukládají jen do tohoto prohlížeče (localStorage). Toto hlášení se zobrazuje jen ve vývoji.</p>
        )}
        {persistenceMode === "unavailable" && (
          <p className="uploadError persistenceBanner">Databázové úložiště není dostupné. Ukládání projektů, eventů a ceníků je dočasně vypnuté — kontaktujte administrátora.</p>
        )}

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

        {workspaceSection === "booths" && (
          <BoothAdminPage
            repository={catalogItemsAdminRepositoryRef.current}
            onOpenPricing={(catalogItemId) => navigateWorkspace("pricingAdmin", { catalogItemId })}
          />
        )}

        {workspaceSection === "components" && (
          <ComponentAdminPage
            repository={catalogItemsAdminRepositoryRef.current}
            onOpenPricing={(catalogItemId) => navigateWorkspace("pricingAdmin", { catalogItemId })}
          />
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

        {workspaceSection === "priceLists" && priceListsHydrated && (
          <PriceListsPage
            priceLists={adminPriceLists}
            events={adminEvents}
            catalogItems={dbCatalogItems}
            pricingAdminRepository={pricingAdminRepositoryRef.current}
            onChange={setAdminPriceLists}
            onSave={async (priceList) => {
              if (!priceListRepositoryRef.current) throw new Error("Databázové úložiště není dostupné. Ceník nebyl uložen.");
              const saved = await priceListRepositoryRef.current.save(priceList);
              setAdminPriceLists((lists) => lists.map((item) => item.id === priceList.id ? saved : item));
              return saved;
            }}
          />
        )}

        {workspaceSection === "pricingAdmin" && (
          <PricingAdminPage
            catalogItems={dbCatalogItems}
            priceLists={adminPriceLists}
            events={adminEvents}
            repository={pricingAdminRepositoryRef.current}
            initialCatalogItemId={pricingAdminPreselect}
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
                  {type === "individualni" ? "Zadej velikost plochy" : "Vyber základ konstrukce"}
                </h1>

                <p>
                  {type === "individualni" ? (
                    "Zadej šířku a hloubku plochy stánku. Konstrukci pak poskládáš z komponent v konfigurátoru."
                  ) : (
                    <>
                      Nejprve vyber typ stánku.
                      Pokud konstrukce obsahuje více
                      variant, zobrazí se jejich
                      výběr automaticky.
                    </>
                  )}
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

                  {dbBoothTypes === null && (
                    <p className="workspaceEmpty">Načítám typové stánky…</p>
                  )}
                  {dbBoothTypes !== null && boothsError && (
                    <p className="uploadError persistenceBanner">Typové stánky se nepodařilo načíst: {boothsError}</p>
                  )}
                  {dbBoothTypes !== null && !boothsError && dbBoothTypes.length === 0 && (
                    <p className="workspaceEmpty">Pro tento výběr nejsou dostupné žádné aktivní stánky.</p>
                  )}
                  {dbBoothTypes !== null && !boothsError && dbBoothTypes.length > 0 && (
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
                              <BoothTypeCardThumbnail booth={booth} />
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
                  )}
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
                            // Section "GENERÁTOR TYPOVEK": a variant with no resolvable asset
                            // source (neither its own modelAsset nor a legacy
                            // assetSourceBoothId) must never present as a ready, pickable
                            // option — see domain/cad3d.ts's isVariantAvailable.
                            const available = isVariantAvailable(variant, boothTypes);

                            return (
                              <button
                                key={
                                  variant.id
                                }
                                type="button"
                                disabled={!available}
                                title={available ? undefined : "Tato varianta zatím nemá nahraný 3D model."}
                                className={
                                  [
                                    "variantCard",
                                    selected ? "selected" : "",
                                    available ? "" : "variantUnavailable",
                                  ].filter(Boolean).join(" ")
                                }
                                onClick={() =>
                                  handleVariantSelect(
                                    variant.id
                                  )
                                }
                              >
                                <div className="variantPreview">
                                  <VariantCardThumbnail variant={variant} parentPhotoAsset={selectedBooth.photoAsset} label={variant.name} />
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
              <section className="boothSelectionSection individualPlotSection">
                <div className="selectionTitle">
                  <div>
                    <span>01</span>

                    <div>
                      <small>PLOCHA</small>

                      <h2>{individualPlotPolygon ? "Plocha stánku" : "Rychlý start"}</h2>
                    </div>
                  </div>

                  <p>
                    {individualPlotPolygon
                      ? "Reálný tvar plochy nakreslíš nebo upravíš v konfigurátoru, v kroku Plocha."
                      : "Zadej rychlý obdélníkový základ. Skutečný (i nepravoúhlý) tvar plochy nakreslíš v konfigurátoru, v kroku Plocha — 45° hrany a L/U tvary jsou podporované."}
                  </p>
                </div>

                {!individualPlotPolygon && (
                  <div className="individualPlotForm">
                    <PlotSizeInput
                      label="ŠÍŘKA"
                      value={individualWidthMm}
                      onCommit={setIndividualWidthMm}
                    />
                    <PlotSizeInput
                      label="HLOUBKA"
                      value={individualDepthMm}
                      onCommit={setIndividualDepthMm}
                    />
                  </div>
                )}

                <div className="noVariantInfo">
                  <div className="noVariantIcon">✓</div>

                  <div>
                    <strong>
                      {individualPlotPolygon
                        ? individualBooth?.size
                        : `${individualWidthMm / 1000} × ${individualDepthMm / 1000} m`}
                      {" "}
                      ({individualPlotPolygon ? individualBooth?.area : `${Math.round((individualWidthMm * individualDepthMm) / 1_000_000)} m²`})
                    </strong>

                    <p>
                      Vytvoří se prázdná plocha stánku bez konstrukce.
                      Komponenty stánku (sloupky, panely, dveře, …) vložíš
                      v kroku Konstrukce, mobiliář až v kroku Mobiliář.
                    </p>
                  </div>
                </div>
              </section>
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
                    if (type === "individualni" && !individualPlotPolygon) {
                      setIndividualPlotPolygon(createCenteredRectanglePlotPolygon(individualWorkspace, individualWidthMm, individualDepthMm));
                    }
                    if (type === "individualni") {
                      setIndividualSubStep("plocha");
                    }
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
                    {type === "individualni" ? "← Zpět na velikost plochy" : "← Zpět na výběr stánku"}
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

              {/* INDIVIDUAL SUB-STEP NAVIGATION — persistent tabs over ONE ProjectRecord
                  (report section 2): switching tabs never clears sceneObjects/polygon/floor
                  zones, unlike the old destructive-wizard step model. */}
              {type === "individualni" && (
                <nav className="individualSubStepNav" aria-label="Kroky individuálního stánku">
                  {INDIVIDUAL_SUB_STEPS.map((subStep, index) => (
                    <button
                      key={subStep}
                      type="button"
                      className={individualSubStep === subStep ? "individualSubStepTab active" : "individualSubStepTab"}
                      onClick={() => setIndividualSubStep(subStep)}
                    >
                      <span>{index + 1}</span>
                      {INDIVIDUAL_SUB_STEP_LABELS_CS[subStep]}
                      {subStep === "plocha" && isIndividualPlotStepComplete && <em className="subStepDone">✓</em>}
                      {subStep === "podlaha" && isIndividualFloorStepComplete && <em className="subStepDone">✓</em>}
                      {subStep === "konstrukce" && constructionOutsidePlotIds.length > 0 && <em className="subStepWarning">⚠</em>}
                      {subStep === "podlaha" && floorZoneConflicts.length > 0 && <em className="subStepWarning">⚠</em>}
                    </button>
                  ))}
                </nav>
              )}

              {individualPlotSubStepPanel}

              {type === "individualni" && individualSubStep === "konstrukce" && (
                <div className="individualPlotLockBar">
                  <button type="button" className="primaryButton" onClick={() => setIndividualSubStep("mobiliar")}>
                    Další – Mobiliář
                  </button>
                </div>
              )}

              {/* WORKSPACE */}

              {(type !== "individualni" || individualSubStep === "konstrukce" || individualSubStep === "mobiliar") && (
              <div className="configuratorWorkspace">
                {/* COMPONENT LIBRARY */}

                {/* Report section 39-41: Konstrukce and Mobiliář are two DIFFERENT catalog
                    sources sharing one scene — booth_component (DB-backed) for Konstrukce, the
                    SAME production furniture/service catalog typovka already uses for Mobiliář.
                    type === "individualni" alone used to always render BoothComponentLibrary,
                    even on the "mobiliar" sub-step — a real switch on individualSubStep, not just
                    a renamed tab, and never a second ComponentLibrary/furniture catalog. */}
                {type === "individualni" && individualSubStep === "konstrukce" ? (
                  <BoothComponentLibrary
                    items={dbBoothComponents}
                    error={boothComponentsError}
                    onAddComponent={addComponent}
                  />
                ) : (
                  <ComponentLibrary
                    onAddComponent={addComponent}
                    inventory={orderInventory}
                  />
                )}

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
                        {type === "individualni" ? "SNAP 250 mm" : "SNAP 40 mm"}
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
                        zoomPercent={editorView === "3d" ? booth3DZoomPercent : boothViewport.zoomPercent}
                        onZoomOut={editorView === "3d" ? () => booth3DCameraControlsRef.current?.zoomOut() : boothViewport.zoomOut}
                        onZoomIn={editorView === "3d" ? () => booth3DCameraControlsRef.current?.zoomIn() : boothViewport.zoomIn}
                        onFit={editorView === "3d" ? () => booth3DCameraControlsRef.current?.fit() : () => boothViewport.fitToContent(individualPlotFitBounds ?? scenePlanBounds(selectedBooth.widthMm!, selectedBooth.depthMm!, placedComponents))}
                        onReset={editorView === "3d" ? () => booth3DCameraControlsRef.current?.reset() : boothViewport.resetZoom}
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
                        // The old whole-canvas-180°-rotation marker class was removed 2026-08-19
                        // along with its orphaned CSS text counter-rotation — this canvas itself
                        // was never actually rotated by any rule still active in globals.css.
                        ["boothCanvas", selectedConstructionPartId === "assembly" ? "constructionSelected" : "", editorTool === "measure" ? "measurementActive" : ""].filter(Boolean).join(" ")
                      }
                      style={{
                        aspectRatio: `${selectedBooth.widthMm} / ${selectedBooth.depthMm}`,
                      }}
                      onPointerDown={handlePlanToolPointerDown}
                      onPointerMove={handlePlanToolPointerMove}
                    >
                      {/* CARPET — typovka only. Report section 22/24: for Individual this whole-
                          canvas rect used to fill the ENTIRE boothCanvas (workspace size, not the
                          real plot) with a solid grey/colored block regardless of the booth's real
                          shape — the "grey workspace" bug. Individual flooring is exclusively the
                          Podlaha step's floorZones (see the plotOutlineOverlay block below, and
                          ScenePanel's own showFloorControl gate for the legacy carpet CONTROL). */}

                      {type !== "individualni" && (
                        <div
                          className={`carpetLayer ${carpetFinishId === "none" ? "noCarpet" : ""}`}
                          style={carpetFinishId === "none" ? undefined : { backgroundColor: selectedCarpetFinish?.swatchColor }}
                        >
                          <span className="carpetLabel">
                            {carpetFinishId === "none" ? "BEZ KOBERCE" : `KOBEREC · ${selectedCarpetFinish?.name ?? "—"}`}
                          </span>
                        </div>
                      )}

                      {/* CANONICAL NOMINAL-MM CONSTRUCTION PLAN */}

                      <BoothConstructionPlanView
                        key={selectedBoothPlanVisualKey}
                        booth={selectedBooth}
                        asset={selectedBoothMasterModel}
                        constructionVisibility={constructionVisibility}
                        visible={constructionAssemblyVisible}
                        selected={selectedConstructionPartId !== null}
                        onVisualReadyChange={handleBoothPlanVisualReadyChange}
                      />

                      {/* INDIVIDUAL PLOT + FLOOR ZONES — same worldToPlanView convention as
                          everything else on this canvas (report section 22-25). Outside the real
                          (possibly L/U/triangle) plot boundary is dimmed (same evenodd-mask
                          technique as PlotPolygonEditor's boundaryPolygon — reused polygon
                          geometry, never a second coordinate system); the plot itself gets a
                          neutral "uncovered" technical fill (never material-styled — that's
                          reserved for confirmed zones); each CONFIRMED zone is its own separately
                          filled region drawn on top (never "whole workspace grey + one zone") —
                          the layering alone makes the visible remainder correct with no polygon
                          difference needed for rendering. Draft/unconfirmed zones stay outline-
                          only, matching the existing (unchanged) pre-lock visual. */}
                      {type === "individualni" && individualPlotPolygon && (
                        <div className="plotOutlineOverlay" aria-hidden="true">
                          <svg viewBox={`0 0 ${selectedBooth.widthMm} ${selectedBooth.depthMm}`} preserveAspectRatio="none">
                            <path
                              className="plotOutsideMask"
                              fillRule="evenodd"
                              d={`M0,0 L${selectedBooth.widthMm},0 L${selectedBooth.widthMm},${selectedBooth.depthMm} L0,${selectedBooth.depthMm} Z ${individualPlotPolygon.map((point, index) => { const p = worldToPlanView(point, selectedBooth.widthMm!, selectedBooth.depthMm!); return `${index === 0 ? "M" : "L"}${p.x},${p.y}`; }).join(" ")} Z`}
                            />
                            <polygon
                              className="plotUncoveredFill"
                              points={individualPlotPolygon.map((point) => { const p = worldToPlanView(point, selectedBooth.widthMm!, selectedBooth.depthMm!); return `${p.x},${p.y}`; }).join(" ")}
                            />
                            <polygon
                              className="plotOutlineShape"
                              points={individualPlotPolygon.map((point) => { const p = worldToPlanView(point, selectedBooth.widthMm!, selectedBooth.depthMm!); return `${p.x},${p.y}`; }).join(" ")}
                            />
                            {individualFloorZones.map((zone) => (
                              <polygon
                                key={zone.id}
                                className={isFloorZoneConfirmed(zone) ? `plotOutlineFloorZone plotFloorZoneFill-${zone.finish}` : "plotOutlineFloorZone"}
                                points={zone.polygon.map((point) => { const p = worldToPlanView(point, selectedBooth.widthMm!, selectedBooth.depthMm!); return `${p.x},${p.y}`; }).join(" ")}
                              />
                            ))}
                          </svg>
                        </div>
                      )}

                      {editorTool === "measure" && measureHoverPoint && (() => {
                        const hover = worldToPlanView(measureHoverPoint, selectedBooth.widthMm!, selectedBooth.depthMm!);
                        const start = pendingMeasurePoint ? worldToPlanView(pendingMeasurePoint, selectedBooth.widthMm!, selectedBooth.depthMm!) : null;
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

                                item.sceneLayer === "booth"
                                  ? "constructionComponent"
                                  : isTechnicalPointLayer(item.sceneLayer)
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
                                left: `${(worldToPlanView({ x: item.xMm, y: item.yMm }, selectedBooth.widthMm!, selectedBooth.depthMm!).x / selectedBooth.widthMm!) * 100}%`,

                                top: `${(worldToPlanView({ x: item.xMm, y: item.yMm }, selectedBooth.widthMm!, selectedBooth.depthMm!).y / selectedBooth.depthMm!) * 100}%`,

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

                                transform: `translate(-50%, -50%) rotate(${worldRotationToPlanView(item.rotationDeg)}deg)`,
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
                              onPointerCancel={handleComponentPointerUp}
                            >
                              {item.frontDirectionDeg !== undefined && (
                                // ▼ (not ▲) to match .frontMarker's bottom-anchored baseline —
                                // at frontDirectionDeg=0 it points straight toward the front/open
                                // side (Y=0, plan-bottom), same "back at top" convention as
                                // worldToPlanView. item.frontDirectionDeg itself is untouched —
                                // this is purely which way the glyph points at its own zero.
                                <i
                                  className="frontMarker"
                                  style={{
                                    transform: `translateX(-50%) rotate(${item.frontDirectionDeg}deg)`,
                                  }}
                                >
                                  ▼
                                </i>
                              )}

                              <span className="placedComponentName">
                                {isTechnicalPointLayer(item.sceneLayer)
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
                        const start = worldToPlanView(dimension.start, selectedBooth.widthMm!, selectedBooth.depthMm!);
                        const end = worldToPlanView(dimension.end, selectedBooth.widthMm!, selectedBooth.depthMm!);
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
                        const point = worldToPlanView(annotation.position, selectedBooth.widthMm!, selectedBooth.depthMm!);
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
                        boothAsset={selectedBooth.boothAsset}
                        constructionVisibility={constructionVisibility}
                        boothVisible={constructionAssemblyVisible}
                        cameraControlsRef={booth3DCameraControlsRef}
                        onCameraZoomPercentChange={setBooth3DZoomPercent}
                        footprintWidthMm={selectedBooth.widthMm}
                        footprintDepthMm={selectedBooth.depthMm}
                        components={placedComponents}
                        carpetFinish={selectedCarpetFinish}
                        constructionFinish={selectedConstructionFinish}
                        partDefinitions={selectedBooth.partDefinitions}
                        nominalDimensions={selectedBooth.nominalDimensions}
                        printSurfaces={selectedBooth.printSurfaces}
                        floorPolygon={type === "individualni" ? individualPlotPolygon : undefined}
                        showPrintPlaceholder={printSurfaceAssignments.some((assignment) => assignment.selectedForPrint && assignment.artworkStatus === "missing")}
                        measurements={measurements3D}
                        onMeasurementsChange={(items) => setMeasurements3D([...items])}
                        dimensionOffsets={dimensionOffsets3D}
                        onDimensionOffsetsChange={(offsets) => setDimensionOffsets3D({ ...offsets })}
                        printSurfaceAssignments={printSurfaceAssignments}
                        graphicsFiles={graphicsFiles}
                        selectedPrintSurfaceId={selectedPrintSurfaceId}
                        onSelectPrintSurface={setSelectedPrintSurfaceId}
                        defaultViews={selectedBooth.defaultViews}
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
                    showFloorControl={type !== "individualni"}
                    onSelectComponent={selectSceneComponent}
                    onSelectConstructionPart={selectConstructionPart}
                    onToggleComponentLock={toggleComponentLock}
                    onToggleConstructionLock={toggleConstructionLock}
                    onToggleComponentVisibility={toggleComponentVisibility}
                    onToggleConstructionVisibility={toggleConstructionVisibility}
                    onMoveComponentDisplayOrder={(componentId, direction) => setPlacedComponents((items) => [...moveComponentDisplayOrder(items, componentId, direction)])}
                  />
                  {effectiveFasciaRequirement(technicalRequirements.fasciaGraphics, selectedBooth).message && <div className="packageOverrideNotice">{effectiveFasciaRequirement(technicalRequirements.fasciaGraphics, selectedBooth).message}</div>}
                  <GraphicsSurfacePanel
                    printSurfaces={selectedBooth.printSurfaces ?? []}
                    assignments={printSurfaceAssignments}
                    graphicsFiles={graphicsFiles}
                    selectedSurfaceId={selectedPrintSurfaceId}
                    upload={graphicsUpload}
                    realizationProfileId={realizationProfileId}
                    onSelectSurface={setSelectedPrintSurfaceId}
                    onUpload={async (surfaceId, file) => { await addPersistentGraphics([file], surfaceId); }}
                    onAssignExisting={assignExistingArtwork}
                    onRemove={removeSurfaceArtwork}
                    onPlacementChange={updateSurfaceArtworkPlacement}
                  />
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
              )}

              {/* BOTTOM */}

              {type === "individualni" && individualSubStep === "konstrukce" ? (
                <div className="workflowActions configuratorContinue">
                  <button className="primaryButton" onClick={() => setIndividualSubStep("mobiliar")}>
                    Pokračovat na mobiliář →
                  </button>
                </div>
              ) : type === "individualni" && (individualSubStep === "plocha" || individualSubStep === "podlaha") ? null : (
                <>
                  <PricingBar booth={selectedBooth} placedItems={placedComponents} currency={currency} projectType={type} />
                  <div className="workflowActions configuratorContinue">
                    <button className="primaryButton" onClick={() => setStep(4)}>
                      Pokračovat na vizualizaci →
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

        {workspaceSection === "project" && step === 4 && (
          <VisualizationStep
            project={workflowProject}
            onSaveView={(view) =>
              setVisualizationViews((items) => [
                ...items,
                saveCameraView({
                  ...view,
                  name: `Pohled ${items.length + 1}`,
                  order: items.length,
                }),
              ])
            }
            onRenameView={(viewId, name) =>
              setVisualizationViews((items) => items.map((view) =>
                view.id === viewId ? renameVisualizationView(view, name) : view,
              ))
            }
            onMoveView={(viewId, direction) =>
              setVisualizationViews((items) => [
                ...moveVisualizationView(items, viewId, direction),
              ])
            }
            onDeleteView={(viewId) => {
              setVisualizationViews((items) => items
                .filter((view) => view.id !== viewId)
                .map((view, order) => ({ ...view, order })));
              setSelectedVisualizationViewIds((items) => items.filter((id) => id !== viewId));
            }}
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
