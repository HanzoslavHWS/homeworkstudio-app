import { useEffect, useMemo, useRef, useState } from "react";
import {
  carpetFinishVariants,
  constructionFinishVariants,
  selectedFinish,
} from "../../domain/finishes";
import type { BoothType, ComponentDefinition, PlacedComponent } from "../../domain/models";
import { componentCatalogItems } from "../../data/components";
import { calculateNetVatGross } from "../../domain/pricing";
import {
  getBasePricingEntry,
  groupCatalogSceneItems,
  loadCatalogPhoto,
} from "../../domain/catalog";
import type { EventDocument, Exhibition, PriceList } from "../../domain/organizations";
import type { OrderInventoryItem } from "../../domain/order";
import type {
  CommunicationLanguage,
  GeneratedPlanOutput,
  ExportCalculationOptions,
  GraphicFileReference,
  ImportedOrder,
  ProjectContact,
  ProjectMode,
  ProjectStage,
  PrintSurfaceAssignment,
  VisualizationView,
  TechnicalRequirements,
  VisualizationItem,
} from "../../domain/project";
import {
  createCustomerCalculationViewModel,
  resolvePricingContext,
  type CustomerCalculationViewModel,
} from "../../domain/calculationExport";
import { effectiveFasciaRequirement } from "../../domain/technicalServices";
import { getAssetDownloadUrl, type UploadProgress } from "../../lib/storage/assetClient";
import { useAssetUrl } from "../../hooks/useAssetUrl";
import type {
  CustomDimension,
  ProjectAnnotation,
} from "../../domain/spatialAnnotations";
import {
  EMAIL_TOPICS,
  RuleBasedEmailDraftProvider,
  type EmailAttachmentReference,
  type EmailDraft,
  type EmailTopicId,
} from "../../domain/communication";
import {
  EXPORT_LAYER_LABELS,
  EXPORT_PRESETS,
  TechnicalVisualizationProvider,
  createCustomerVisualizationRender,
  type ExportLanguage,
  type ExportLayer,
} from "../../domain/workflow";
import { createProjectPackage, packageFolderPath } from "../../domain/projectPackage";
import { getMasterReferenceModel } from "../../domain/cad3d";
import { createVisualizationCameraPresets } from "../../domain/visualization";
import {
  buildVisualizationPackageName,
  buildVisualizationRenderFileName,
  buildVisualizationRenderFingerprint,
  CUSTOMER_CAPTURE_RESOLUTIONS,
  deduplicateRenderFileNames,
  evaluateRenderStaleness,
  isBackgroundModeAllowed,
  latestCustomerRendersByView,
  latestPresentableRendersByView,
  type CustomerCaptureResolutionPreset,
  type CustomerRenderBackgroundMode,
  type CustomerRenderFormat,
} from "../../domain/visualizationRender";
import { renderVisualizationBatch, type VisualizationRenderBatchProgress } from "../../lib/visualizationRenderBatch";
import { assembleVisualizationZipEntries } from "../../lib/visualizationRenderDownloads";
import { buildPresentationPdf, type PresentationPdfRenderPage } from "../../lib/presentationPdf";
import type { GraphicsProductionPreparedBy } from "../../domain/graphicsProduction";
import { downloadDataUrl, downloadText, printDocument, renderTechnicalPlanPng } from "../../lib/planExport";
import { createZip, dataUrlZipEntry, textZipEntry, type ZipEntry } from "../../lib/zip";
import {
  BoothCadViewer,
  type BoothCadCameraControls,
  type BoothCadCameraSnapshot,
} from "../configurator/BoothCadViewer";
import { EventLogo } from "./CatalogManagementPages";
import { requirementStatusLabels } from "./TechnicalRequirementsEditor";
import { GraphicsExportPanel } from "./GraphicsExportPanel";
import { AiVisualizationPanel } from "./AiVisualizationPanel";
import { ControlPassDebugViewer } from "../configurator/ControlPassDebugViewer";

export type CommonProject = {
  id?: string;
  name: string;
  fairName: string;
  event?: Exhibition;
  /** Raw identity strings (distinct from the resolved `booth` object below) — Visualization v2's content fingerprint needs these to detect a booth/variant switch. */
  boothId: string;
  variantId: string;
  company: string;
  contact: ProjectContact;
  boothNumber: string;
  mode: ProjectMode;
  stage: ProjectStage;
  communicationLanguage: CommunicationLanguage;
  waitingForCustomer: boolean;
  requiresAction: boolean;
  realizationName: string;
  /** Raw id (report Graphics Export v1): resolveProductionPrintSurface needs the id, never the display name — realizationName above stays display-only. */
  realizationProfileId: string;
  currency: "CZK" | "EUR";
  booth?: BoothType;
  sceneObjects: readonly PlacedComponent[];
  requirements: TechnicalRequirements;
  order?: ImportedOrder;
  inventory: readonly OrderInventoryItem[];
  visualizationViews: readonly VisualizationView[];
  visualizations: readonly VisualizationItem[];
  generatedPlanOutputs: readonly GeneratedPlanOutput[];
  selectedOutputIds: readonly string[];
  selectedEventDocumentIds: readonly string[];
  selectedVisualizationViewIds: readonly string[];
  visualizationPurpose: "working" | "presentation";
  visualization2DLayers: readonly string[];
  graphicsFiles: readonly GraphicFileReference[];
  annotations: readonly ProjectAnnotation[];
  customDimensions: readonly CustomDimension[];
  carpetFinishId: string;
  constructionFinishId: string;
  constructionVisibility: Readonly<Record<string, boolean>>;
  internalNote?: string;
  customerNote: string;
  printSurfaceAssignments: readonly PrintSurfaceAssignment[];
  exportCalculationOptions: ExportCalculationOptions;
  /** All PriceLists (needed to resolve the event's list for THIS project's currency — see domain/organizations.ts resolveEventPriceListForCurrency). */
  priceLists: readonly PriceList[];
  /** DB-backed technical-service catalog items (Batch #2A: M57/L02/22 technical services) — pricing-only, never merged into ComponentLibrary/scene placement. Merge with componentCatalogItems at call sites that price technical services. */
  technicalCatalogItems: readonly ComponentDefinition[];
};

type TemporaryGraphicFile = Readonly<{ id: string; file: File }>;

export function VisualizationStep({ project, onSaveView, onRenameView, onMoveView, onDeleteView, onAddVisualization, onAddPlanOutput, onUpdateVisualization, onDeleteVisualization, onUpdatePlanOutput, onDeletePlanOutput, onSelectedViewsChange, onPurposeChange, on2DLayersChange, onContinue }: {
  project: CommonProject;
  onSaveView: (view: BoothCadCameraSnapshot) => void;
  onRenameView: (id: string, name: string) => void;
  onMoveView: (id: string, direction: -1 | 1) => void;
  onDeleteView: (id: string) => void;
  onAddVisualization: (item: VisualizationItem) => void;
  onAddPlanOutput: (item: GeneratedPlanOutput) => void;
  onUpdateVisualization: (item: VisualizationItem) => void;
  onDeleteVisualization: (id: string) => void;
  onUpdatePlanOutput: (item: GeneratedPlanOutput) => void;
  onDeletePlanOutput: (id: string) => void;
  onSelectedViewsChange: (ids: string[]) => void;
  onPurposeChange: (purpose: "working" | "presentation") => void;
  on2DLayersChange: (layers: string[]) => void;
  onContinue: () => void;
}) {
  const [planPreviewDataUrl, setPlanPreviewDataUrl] = useState("");
  const visualizationCameraControlsRef = useRef<BoothCadCameraControls | null>(null);
  const booth = project.booth;
  const provider = new TechnicalVisualizationProvider();
  const cameraPresets = useMemo(
    () => booth?.widthMm && booth.depthMm
      ? createVisualizationCameraPresets({
          widthMm: booth.widthMm,
          depthMm: booth.depthMm,
          heightMm: booth.heightMm ?? booth.nominalDimensions?.heightMm ?? 2500,
          originConvention: booth.boothAsset?.originConvention,
        })
      : [],
    [booth?.boothAsset?.originConvention, booth?.depthMm, booth?.heightMm, booth?.nominalDimensions?.heightMm, booth?.widthMm],
  );
  const views = useMemo(
    () => [...project.visualizationViews].sort((left, right) => left.order - right.order),
    [project.visualizationViews],
  );

  // Visualization v2 — customer render options (export-session UI state only, never persisted).
  const [resolutionPreset, setResolutionPreset] = useState<CustomerCaptureResolutionPreset>("fullhd");
  const [renderFormat, setRenderFormat] = useState<CustomerRenderFormat>("jpeg");
  const [backgroundMode, setBackgroundMode] = useState<CustomerRenderBackgroundMode>("light-neutral");
  const [renderErrors, setRenderErrors] = useState<Readonly<Record<string, string>>>({});
  const [batchProgress, setBatchProgress] = useState<VisualizationRenderBatchProgress | null>(null);
  const [lightboxViewId, setLightboxViewId] = useState<string | null>(null);
  const eventName = project.event?.name ?? project.fairName;
  const latestRenders = useMemo(() => latestCustomerRendersByView(project.visualizations), [project.visualizations]);
  const currentFingerprint = useMemo(
    () => buildVisualizationRenderFingerprint(project),
    [project.boothId, project.variantId, project.carpetFinishId, project.constructionFinishId, project.constructionVisibility, project.sceneObjects, project.printSurfaceAssignments, project.graphicsFiles],
  );

  if (!booth?.widthMm || !booth.depthMm) return <StepEmpty title="Vizualizace" text="Nejprve vyberte konfigurovatelný stánek." />;
  const toggleView = (id: string) => onSelectedViewsChange(project.selectedVisualizationViewIds.includes(id) ? project.selectedVisualizationViewIds.filter((value) => value !== id) : [...project.selectedVisualizationViewIds, id]);
  const toggleLayer = (layer: ExportLayer) => on2DLayersChange(project.visualization2DLayers.includes(layer) ? project.visualization2DLayers.filter((value) => value !== layer) : [...project.visualization2DLayers, layer]);
  const layers = project.visualization2DLayers as ExportLayer[];

  const captureOptions = { widthPx: CUSTOMER_CAPTURE_RESOLUTIONS[resolutionPreset].widthPx, heightPx: CUSTOMER_CAPTURE_RESOLUTIONS[resolutionPreset].heightPx, format: renderFormat, backgroundMode };
  const captureBlocked = backgroundMode === "transparent" && renderFormat !== "png";

  function renderCustomerItem(view: VisualizationView): VisualizationItem | undefined {
    visualizationCameraControlsRef.current?.applyView(view);
    const result = visualizationCameraControlsRef.current?.renderCustomerCapture(captureOptions);
    if (!result || result.ok !== true) {
      const reason = result?.ok === false ? result.reason : "capture-failed";
      setRenderErrors((current) => ({ ...current, [view.id]: reason === "print-tool-active" ? "Přepněte nástroj zpět na Výběr před vyrenderováním." : "Vyrenderování se nezdařilo." }));
      return undefined;
    }
    setRenderErrors((current) => { const { [view.id]: _dropped, ...rest } = current; return rest; });
    return createCustomerVisualizationRender({
      name: view.name,
      viewId: view.id,
      imageDataUrl: result.dataUrl,
      widthPx: result.widthPx,
      heightPx: result.heightPx,
      format: renderFormat,
      backgroundMode,
      contentFingerprint: currentFingerprint,
      purpose: project.visualizationPurpose,
    });
  }

  function renderSingleView(view: VisualizationView) {
    const item = renderCustomerItem(view);
    if (item) onAddVisualization(item);
  }

  async function renderAllViews() {
    setBatchProgress({ completed: 0, total: views.length });
    await renderVisualizationBatch(
      views.map((view) => ({ viewId: view.id, viewName: view.name })),
      {
        captureAndUploadOne: async (target) => {
          const view = views.find((candidate) => candidate.id === target.viewId)!;
          const item = renderCustomerItem(view);
          if (!item) return { ok: false, viewName: view.name, reason: renderErrors[view.id] ?? "Vyrenderování se nezdařilo." };
          onAddVisualization(item);
          return { ok: true, item };
        },
        onProgress: setBatchProgress,
      },
    );
    setBatchProgress(null);
  }

  function renderFileName(view: VisualizationView, render: VisualizationItem): string {
    return buildVisualizationRenderFileName({ eventName, projectName: project.name, viewName: view.name, extension: render.format === "png" ? "png" : "jpg" });
  }

  function downloadSingleRender(view: VisualizationView) {
    const render = latestRenders.get(view.id);
    if (!render) return;
    downloadDataUrl(render.imageDataUrl, renderFileName(view, render));
  }

  const lightboxView = lightboxViewId ? views.find((view) => view.id === lightboxViewId) : undefined;
  const lightboxRender = lightboxView ? latestRenders.get(lightboxView.id) : undefined;

  function createPlanOutput() {
    if (!planPreviewDataUrl) return;
    const number = project.generatedPlanOutputs.length + 1;
    onAddPlanOutput({
      id: `plan-output-${Date.now()}`,
      name: `Půdorys ${String(number).padStart(2, "0")}`,
      type: "plan2d",
      layers: [...layers],
      imageDataUrl: planPreviewDataUrl,
      createdAt: new Date().toISOString(),
      reviewStatus: "unreviewed",
    });
  }

  return <div className="workflowStepPage">
    <StepTitle eyebrow="KROK 3" title="Vizualizace" text="Připravte a uložte konkrétní 3D pohledy i 2D půdorysy. AI se nespouští automaticky." />
    <div className="visualizationWorkspace">
      <BoothCadViewer
        asset={getMasterReferenceModel(booth.assets)}
        boothAsset={booth.boothAsset}
        constructionVisibility={project.constructionVisibility}
        boothVisible={project.constructionVisibility.assembly ?? booth.visible}
        footprintWidthMm={booth.widthMm}
        footprintDepthMm={booth.depthMm}
        components={project.sceneObjects}
        defaultViews={cameraPresets}
        cameraControlsRef={visualizationCameraControlsRef}
        nominalDimensions={booth.nominalDimensions}
        printSurfaces={booth.printSurfaces}
        printSurfaceAssignments={project.printSurfaceAssignments}
        graphicsFiles={project.graphicsFiles}
        showPrintPlaceholder={project.printSurfaceAssignments.some((assignment) => assignment.selectedForPrint && assignment.artworkStatus === "missing")}
        carpetFinish={selectedFinish(booth.carpetVariants ?? carpetFinishVariants, project.carpetFinishId)}
        constructionFinish={selectedFinish(booth.finishVariants ?? constructionFinishVariants, project.constructionFinishId)}
        partDefinitions={booth.partDefinitions}
        onSaveView={onSaveView}
        onCapture={async ({ imageDataUrl, view }) => onAddVisualization(await provider.create({ name: `Technický vizu ${project.visualizations.length + 1}`, sourceViewId: view.name, technicalRenderDataUrl: imageDataUrl, purpose: project.visualizationPurpose }))}
      />
    </div>
    <section className="workflowCard visualizationSources">
      <div className="renderOptionsBar">
        <span className="renderOptionsLabel">Render</span>
        <select value={resolutionPreset} onChange={(event) => setResolutionPreset(event.target.value as CustomerCaptureResolutionPreset)}>{(Object.keys(CUSTOMER_CAPTURE_RESOLUTIONS) as CustomerCaptureResolutionPreset[]).map((preset) => <option key={preset} value={preset}>{CUSTOMER_CAPTURE_RESOLUTIONS[preset].label}</option>)}</select>
        <select value={renderFormat} onChange={(event) => { const format = event.target.value as CustomerRenderFormat; setRenderFormat(format); if (!isBackgroundModeAllowed(format, backgroundMode)) setBackgroundMode("white"); }}><option value="jpeg">JPG</option><option value="png">PNG</option></select>
        <select value={backgroundMode} onChange={(event) => setBackgroundMode(event.target.value as CustomerRenderBackgroundMode)}><option value="light-neutral">Světlé</option><option value="white">Bílé</option><option value="transparent" disabled={!isBackgroundModeAllowed(renderFormat, "transparent")}>Transparentní</option></select>
      </div>
      <h2>Pohledy</h2>
      <div className="visualizationCardGrid">
        {views.length === 0 && <p className="emptyState">Zatím není uložen žádný pohled.</p>}
        {views.map((view, index) => {
          const render = latestRenders.get(view.id);
          const staleness = render ? evaluateRenderStaleness(render, currentFingerprint) : undefined;
          return (
            <ViewRenderCard
              key={view.id}
              view={view}
              render={render}
              staleness={staleness}
              error={renderErrors[view.id]}
              selected={project.selectedVisualizationViewIds.includes(view.id)}
              canMoveUp={index > 0}
              canMoveDown={index < views.length - 1}
              renderBlocked={captureBlocked}
              onOpenThumbnail={() => setLightboxViewId(view.id)}
              onOpenCamera={() => visualizationCameraControlsRef.current?.applyView(view)}
              onRender={() => renderSingleView(view)}
              onDownload={() => downloadSingleRender(view)}
              onRename={() => { const name = window.prompt("Název pohledu", view.name); if (name !== null) onRenameView(view.id, name); }}
              onMoveUp={() => onMoveView(view.id, -1)}
              onMoveDown={() => onMoveView(view.id, 1)}
              onDelete={() => onDeleteView(view.id)}
              onToggleSelected={() => toggleView(view.id)}
            />
          );
        })}
      </div>
      {views.length > 0 && (
        <button type="button" className="primaryButton" onClick={() => void renderAllViews()} disabled={captureBlocked || batchProgress !== null}>
          {batchProgress ? `Generuji vizualizace… ${batchProgress.completed} / ${batchProgress.total}${batchProgress.currentViewName ? ` (${batchProgress.currentViewName})` : ""}` : "Vyrenderovat všechny"}
        </button>
      )}
      <label className="purposeSelect"><span>Kategorie vizualizace</span><select value={project.visualizationPurpose} onChange={(event) => onPurposeChange(event.target.value as typeof project.visualizationPurpose)}><option value="working">Pracovní návrh</option><option value="presentation">Vizu / prezentační vizualizace</option></select></label>
      <p className="workflowMuted">Pohled ukládá pouze kameru; scéna zůstává živá. Technický snímek je lokální Three.js capture.</p>
    </section>
    <section className="workflowCard">
      <AiVisualizationPanel
        project={project}
        views={views}
        cameraControlsRef={visualizationCameraControlsRef}
        latestCustomerRenders={latestRenders}
        currentFingerprint={currentFingerprint}
        onAddVisualization={onAddVisualization}
        onDeleteVisualization={onDeleteVisualization}
        onUpdateVisualization={onUpdateVisualization}
        selectedVisualizationViewIds={project.selectedVisualizationViewIds}
        onToggleView={toggleView}
      />
    </section>
    <ControlPassDebugViewer
      cameraControlsRef={visualizationCameraControlsRef}
      widthPx={captureOptions.widthPx}
      heightPx={captureOptions.heightPx}
      backgroundMode={captureOptions.backgroundMode}
    />
    {lightboxView && lightboxRender && (
      <RenderLightbox
        viewName={lightboxView.name}
        render={lightboxRender}
        onClose={() => setLightboxViewId(null)}
        onDownload={() => downloadDataUrl(lightboxRender.imageDataUrl, renderFileName(lightboxView, lightboxRender))}
      />
    )}
    <section className="workflowCard visualization2D"><div><h2>2D zdroj</h2><p>Vyberte vrstvy a vytvořte samostatný uložený výstup.</p><div className="layerOptions">{allLayers.map((layer) => <label key={layer}><input type="checkbox" checked={layers.includes(layer)} onChange={() => toggleLayer(layer)} /> {EXPORT_LAYER_LABELS[layer]}</label>)}</div><button className="primaryButton" type="button" onClick={createPlanOutput} disabled={!planPreviewDataUrl}>Vytvořit půdorys</button></div><PlanLayerPreview booth={booth} sceneObjects={project.sceneObjects} layers={layers} constructionVisibility={project.constructionVisibility} annotations={project.annotations} customDimensions={project.customDimensions} onRendered={setPlanPreviewDataUrl} /></section>
    <PresentationExportPanel project={project} views={views} />
    <GeneratedOutputResults visualizations={project.visualizations} plans={project.generatedPlanOutputs} onUpdateVisualization={onUpdateVisualization} onDeleteVisualization={onDeleteVisualization} onUpdatePlan={onUpdatePlanOutput} onDeletePlan={onDeletePlanOutput} />
    <StepActions onContinue={onContinue} />
  </div>;
}

/**
 * Visualization v2.1 — compact per-view card. Two states: a real render exists (thumbnail,
 * status badge, primary "Stáhnout" action) or not yet ("Bez náhledu" placeholder, primary
 * "Vyrenderovat" action). Secondary actions (Otevřít/Přejmenovat/reorder/Smazat/re-render) live
 * in a native <details> disclosure menu — no new dropdown dependency. Purely presentational:
 * every callback is owned by VisualizationStep, no render/capture logic here.
 */
export function ViewRenderCard({
  view, render, staleness, error, selected, canMoveUp, canMoveDown, renderBlocked,
  onOpenThumbnail, onOpenCamera, onRender, onDownload, onRename, onMoveUp, onMoveDown, onDelete, onToggleSelected,
}: {
  view: VisualizationView;
  render: VisualizationItem | undefined;
  staleness: "current" | "possibly-outdated" | "unknown" | undefined;
  error: string | undefined;
  selected: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  renderBlocked: boolean;
  onOpenThumbnail: () => void;
  onOpenCamera: () => void;
  onRender: () => void;
  onDownload: () => void;
  onRename: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  onToggleSelected: () => void;
}) {
  return (
    <article className="visualizationRenderCard">
      {render ? (
        <button type="button" className="visualizationRenderCardThumb" onClick={onOpenThumbnail} aria-label={`Zobrazit render – ${view.name} – na celou obrazovku`}>
          <img src={render.imageDataUrl} alt={`Náhled – ${view.name}`} />
        </button>
      ) : (
        <div className="visualizationRenderCardThumb visualizationRenderCardThumb--empty"><span>Bez náhledu</span></div>
      )}
      <div className="visualizationRenderCardBody">
        <strong>{view.name}</strong>
        {render && (staleness === "possibly-outdated"
          ? <small className="visualizationStatusBadge visualizationStatusBadge--stale">Může být zastaralý</small>
          : <small className="visualizationStatusBadge visualizationStatusBadge--current">Aktuální</small>)}
        {error && <small className="visualizationRenderError">{error}</small>}
        <div className="visualizationRenderCardActions">
          {render
            ? <button type="button" onClick={onDownload}>Stáhnout</button>
            : <button type="button" onClick={onRender} disabled={renderBlocked}>Vyrenderovat</button>}
          <details className="visualizationCardMenu">
            <summary aria-label={`Další akce – ${view.name}`}>⋯</summary>
            <div className="visualizationCardMenuList">
              <button type="button" onClick={onOpenCamera}>Otevřít</button>
              {render && <button type="button" onClick={onRender} disabled={renderBlocked}>Přerenderovat</button>}
              <button type="button" onClick={onRename}>Přejmenovat</button>
              <button type="button" disabled={!canMoveUp} onClick={onMoveUp}>Posunout nahoru</button>
              <button type="button" disabled={!canMoveDown} onClick={onMoveDown}>Posunout dolů</button>
              <label><input type="checkbox" checked={selected} onChange={onToggleSelected} /> Vybráno pro export</label>
              <button type="button" onClick={onDelete}>Smazat</button>
            </div>
          </details>
        </div>
      </div>
    </article>
  );
}

/**
 * Visualization v2.1 — full-size render preview. Reuses the app's existing overlay+stopPropagation
 * modal pattern (see PricingAdminPages.tsx's .adminModalOverlay/.adminModalCard) rather than a new
 * dialog dependency; only the sizing is render-specific (.visualizationLightbox*).
 */
export function RenderLightbox({ viewName, render, onClose, onDownload }: {
  viewName: string;
  render: VisualizationItem;
  onClose: () => void;
  onDownload: () => void;
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="visualizationLightboxOverlay" role="dialog" aria-modal="true" aria-label={`Render – ${viewName}`} onClick={onClose}>
      <div className="visualizationLightboxCard" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="visualizationLightboxClose" aria-label="Zavřít náhled" onClick={onClose}>×</button>
        <img src={render.imageDataUrl} alt={`Render – ${viewName}`} />
        <div className="visualizationLightboxFooter">
          <span>{viewName}</span>
          <button type="button" className="primaryButton" onClick={onDownload}>Stáhnout {render.format === "png" ? "PNG" : "JPG"}</button>
        </div>
      </div>
    </div>
  );
}

type PresentationBuildState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "building" }>
  | Readonly<{ status: "error"; message: string }>
  | Readonly<{ status: "success" }>;

/**
 * Visualization v2 (report sections 15-22) — customer presentation export. Only shown once at
 * least one saved view has a customer OR AI render (Visualization v3: latestPresentableRendersByView
 * admits both, picking whichever is most recent per view — the customer chooses the exact render,
 * this only decides which one is offered by default). All state here (selection order, branding,
 * preparedBy, build progress) is export-session-only — never written to ProjectRecord, matching
 * GraphicsExportPanel.tsx's existing precedent from Graphics Production Package v1.
 */
function PresentationExportPanel({ project, views }: { project: CommonProject; views: readonly VisualizationView[] }) {
  const latestRenders = useMemo(() => latestPresentableRendersByView(project.visualizations), [project.visualizations]);
  const renderableViews = useMemo(() => views.filter((view) => latestRenders.has(view.id)), [views, latestRenders]);
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [companyBrand, setCompanyBrand] = useState("");
  const [preparedByName, setPreparedByName] = useState("");
  const [preparedByEmail, setPreparedByEmail] = useState("");
  const [preparedByPhone, setPreparedByPhone] = useState("");
  const [buildState, setBuildState] = useState<PresentationBuildState>({ status: "idle" });
  const eventName = project.event?.name ?? project.fairName;

  function toggleSelected(viewId: string) {
    setSelectedIds((current) => current.includes(viewId) ? current.filter((id) => id !== viewId) : [...current, viewId]);
  }

  function preparedByInput(): GraphicsProductionPreparedBy | undefined {
    return preparedByName.trim()
      ? { name: preparedByName.trim(), email: preparedByEmail.trim() || undefined, phone: preparedByPhone.trim() || undefined }
      : undefined;
  }

  async function createPresentationPdf() {
    setBuildState({ status: "building" });
    try {
      const pages: PresentationPdfRenderPage[] = selectedIds.flatMap((viewId) => {
        const view = renderableViews.find((candidate) => candidate.id === viewId);
        const render = latestRenders.get(viewId);
        if (!view || !render) return [];
        return [{ visualizationId: render.id, name: view.name, imageDataUrl: render.imageDataUrl, widthPx: render.widthPx ?? 1920, heightPx: render.heightPx ?? 1080, format: render.format ?? "jpeg" }];
      });
      const bytes = await buildPresentationPdf(pages, {
        project: { name: project.name, company: project.company },
        event: { name: eventName, venue: project.event?.venue },
        booth: { name: project.booth?.name ?? "—", boothNumber: project.boothNumber || undefined },
        branding: companyBrand.trim() ? { companyBrand: companyBrand.trim() } : undefined,
        preparedBy: preparedByInput(),
        generatedAt: new Date().toISOString(),
      });
      const packageName = buildVisualizationPackageName({ eventName, projectName: project.name });
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
      downloadDataUrl(url, `${packageName}.pdf`);
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setBuildState({ status: "success" });
    } catch {
      setBuildState({ status: "error", message: "Prezentační PDF se nepodařilo vytvořit." });
    }
  }

  async function downloadAllRenders() {
    setBuildState({ status: "building" });
    try {
      const packageName = buildVisualizationPackageName({ eventName, projectName: project.name });
      const namedFiles = deduplicateRenderFileNames(renderableViews.map((view) => ({
        viewId: view.id,
        fileName: buildVisualizationRenderFileName({ eventName, projectName: project.name, viewName: view.name, extension: latestRenders.get(view.id)?.format === "png" ? "png" : "jpg" }),
      })));
      const entries = namedFiles.map((file) => ({ fileName: file.fileName, dataUrl: latestRenders.get(file.viewId)?.imageDataUrl }));
      const result = assembleVisualizationZipEntries(packageName, entries);
      if (result.ok !== true) {
        setBuildState({ status: "error", message: `Stažení selhalo u: ${result.failedFiles.join(", ")}` });
        return;
      }
      const url = URL.createObjectURL(createZip(result.entries));
      downloadDataUrl(url, `${packageName}.zip`);
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setBuildState({ status: "success" });
    } catch {
      setBuildState({ status: "error", message: "Stažení balíčku se nezdařilo." });
    }
  }

  if (renderableViews.length === 0) return null;

  return <section className="workflowCard presentationExportPanel">
    <div className="workflowCardHeader"><div><span>PREZENTAČNÍ VÝSTUP</span><strong>Zákaznický dokument</strong></div></div>
    <div className="presentationSelectionList">
      {renderableViews.map((view) => <label className="outputSelectionRow" key={view.id}><input type="checkbox" checked={selectedIds.includes(view.id)} onChange={() => toggleSelected(view.id)} /><span>{view.name}</span></label>)}
    </div>
    <div className="presentationMeta">
      <label><span>Firemní branding (nepovinné)</span><input type="text" value={companyBrand} onChange={(event) => setCompanyBrand(event.target.value)} placeholder="HOMEWORK STUDIO" /></label>
      <label><span>Zpracoval (jméno)</span><input type="text" value={preparedByName} onChange={(event) => setPreparedByName(event.target.value)} /></label>
      <label><span>E-mail</span><input type="email" value={preparedByEmail} onChange={(event) => setPreparedByEmail(event.target.value)} /></label>
      <label><span>Telefon</span><input type="tel" value={preparedByPhone} onChange={(event) => setPreparedByPhone(event.target.value)} /></label>
    </div>
    {buildState.status === "error" && <p className="workflowWarning">{buildState.message}</p>}
    {buildState.status === "success" && <p className="workflowMuted">Hotovo.</p>}
    <div className="presentationActions">
      <button type="button" className="primaryButton" onClick={() => void createPresentationPdf()} disabled={selectedIds.length === 0 || buildState.status === "building"}>Prezentační PDF</button>
      <button type="button" onClick={() => void downloadAllRenders()} disabled={buildState.status === "building"}>Stáhnout všechny rendery (ZIP)</button>
    </div>
  </section>;
}

export function SummaryStep({ project, onAddGraphicsFiles, onRetryGraphics, onRemoveGraphicsFile, graphicsUpload, onContinue }: { project: CommonProject; onAddGraphicsFiles: (files: FileList) => Promise<void>; onRetryGraphics: () => Promise<void>; onRemoveGraphicsFile: (id: string) => void; graphicsUpload?: UploadProgress; onContinue: () => void }) {
  const furnitureSummary = groupCatalogSceneItems(
    project.sceneObjects.filter((item) => item.sceneLayer === "furniture"),
    componentCatalogItems,
    project.currency,
  );
  const unresolved = project.order?.lines.filter((line) => line.mappingStatus === "unresolved") ?? [];
  const mismatches = project.inventory.filter((item) => item.status !== "complete");
  const projectPackage = packageForProject(project);
  const graphicsMissing = Boolean(project.booth?.graphicsRequired && !["dataReceived", "ready"].includes(project.requirements.fasciaGraphics.status) && !effectiveFasciaRequirement(project.requirements.fasciaGraphics, project.booth).includedInPackage);
  const pricing = projectPricing(project);
  return <div className="workflowStepPage"><StepTitle eyebrow="KROK 4" title="Souhrn" text="Interní kontrola projektu před exportem." />
    {(mismatches.length > 0 || unresolved.length > 0 || project.requiresAction || graphicsMissing || pricing.warnings.length > 0) && <div className="workflowWarning">{mismatches.length > 0 && <span>Objednávka a model nejsou v přesné shodě.</span>}{unresolved.length > 0 && <span>Objednávka obsahuje nevyřešené řádky.</span>}{project.requiresAction && <span>Projekt vyžaduje naši akci.</span>}{graphicsMissing && <span>Požadujeme zaslání grafických / tiskových dat pro límec.</span>}{pricing.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div>}
    <div className="summaryGrid">
      <SummaryCard title="Projekt"><Row label="Firma" value={project.company} /><Row label="Stánek" value={project.booth?.name ?? "—"} /><Row label="Označení" value={project.boothNumber || "—"} /><Row label="Stage" value={stageLabel(project.stage)} /><Row label="Režim" value={modeLabel(project.mode)} /><Row label="Jazyk komunikace" value={project.communicationLanguage === "cs" ? "Čeština" : "English"} /><Row label="Kontakt" value={project.contact.name || "—"} /><Row label="Telefon" value={project.contact.phone || "—"} /><Row label="E-mail" value={project.contact.email || "—"} /><Row label="Realizace" value={project.realizationName} />{project.internalNote && <div className="internalSummaryNote"><span>INTERNÍ POZNÁMKA</span><p>{project.internalNote}</p></div>}</SummaryCard>
      <SummaryCard title="Výstava"><div className="summaryEvent"><EventLogo event={project.event} compact /><div><strong>{project.event?.name ?? project.fairName}</strong><span>{project.event?.venue || "Místo neuvedeno"}</span><span>{eventDate(project.event)}</span></div></div></SummaryCard>
      <SummaryCard title="Mobiliář">{furnitureSummary.length ? furnitureSummary.map((item) => <Row key={item.catalogItemId} label={`${item.quantity}× ${item.displayName}`} value={item.saleUnitNet ? `${item.quantity} × ${formatMoney(item.saleUnitNet, project.currency)} = ${formatMoney(item.saleTotalNet, project.currency)} bez DPH` : `${item.quantity} ${item.unit}`} />) : <p className="emptyState">Scéna je prázdná.</p>}</SummaryCard>
      <SummaryCard title="Objednávka">{project.order ? <>{project.inventory.map((item) => <Row key={item.catalogItemId} label={item.name} value={item.status === "complete" ? `${item.placed} / ${item.ordered} · OK` : item.status === "over" ? `${item.placed} / ${item.ordered} · navíc ${item.extra}` : `${item.placed} / ${item.ordered} · chybí ${item.remaining}`} />)}{unresolved.map((line) => <Row key={line.id} label={line.sourceName || line.rawText} value="Nevyřešeno" />)}</> : <p className="emptyState">Zatím není importovaná objednávka.</p>}</SummaryCard>
      <SummaryCard title="Technické požadavky">{(["electricity", "water", "waste"] as const).map((key) => <Row key={key} label={{ electricity: "Elektro", water: "Voda", waste: "Odpad" }[key]} value={requirementStatusLabels[project.requirements[key].status]} />)}</SummaryCard>
      <section className="workflowCard summaryWorkflowCard graphicsSummary"><h2>Grafika</h2><Row label="Límec" value={effectiveFasciaRequirement(project.requirements.fasciaGraphics, project.booth).includedInPackage ? "Objednáno – v ceně stánku" : requirementStatusLabels[project.requirements.fasciaGraphics.status]} /><Row label="Celopolep" value={requirementStatusLabels[project.requirements.fullWrapGraphics.status]} /><Row label="Poznámka límec" value={project.requirements.fasciaGraphics.note || "—"} /><label className="filePicker"><span>Přidat grafická data do R2</span><input type="file" multiple accept="image/*,.pdf,.ai,.eps,.svg" onChange={(event) => { if (event.target.files) void onAddGraphicsFiles(event.target.files); event.target.value = ""; }} /></label>{graphicsUpload && <div className={`assetUploadState ${graphicsUpload.state}`}><progress max="100" value={graphicsUpload.percent} /><span>{graphicsUpload.state === "uploading" ? `Nahrávám ${graphicsUpload.percent} %` : graphicsUpload.state === "success" ? "Nahráno do R2" : graphicsUpload.message}</span>{graphicsUpload.state === "error" && <button type="button" onClick={() => void onRetryGraphics()}>Zkusit znovu</button>}</div>}<p className="temporaryNotice">Ukládá se stabilní storageKey; podpisová URL se vytváří až při otevření nebo exportu.</p><div className="graphicsFiles">{project.graphicsFiles.map((file) => <div key={file.id}><span><strong>{file.name}</strong><small>{formatBytes(file.size)} · {file.mimeType || "neznámý typ"} · {file.storageKey ? "R2" : "legacy/dočasné"}</small></span><button onClick={() => onRemoveGraphicsFile(file.id)}>Odebrat metadata</button></div>)}</div></section>
      <SummaryCard title="Výstupy"><Row label="2D půdorysy" value={String(project.generatedPlanOutputs.length)} /><Row label="3D technické pohledy" value={String(project.visualizations.length)} /></SummaryCard>
      <SummaryCard title="Cena"><Row label="Cena bez DPH" value={`${pricing.net.toLocaleString("cs-CZ")} ${project.currency}`} /><Row label={`DPH ${pricing.vatRatePercent} %`} value={`${pricing.vat.toLocaleString("cs-CZ")} ${project.currency}`} /><Row label="Celkem s DPH" value={`${pricing.gross.toLocaleString("cs-CZ")} ${project.currency}`} /></SummaryCard>
      <SummaryCard title="Project package"><PackageTree projectPackage={projectPackage} /></SummaryCard>
    </div><StepActions onContinue={onContinue} /></div>;
}

export function ExportStep({ project, temporaryGraphicFiles, onSelectedOutputIdsChange, onSelectedEventDocumentIdsChange, onCalculationOptionsChange }: { project: CommonProject; temporaryGraphicFiles: readonly TemporaryGraphicFile[]; onSelectedOutputIdsChange: (ids: string[]) => void; onSelectedEventDocumentIdsChange: (ids: string[]) => void; onCalculationOptionsChange: (options: ExportCalculationOptions) => void }) {
  const [layers, setLayers] = useState<ExportLayer[]>(["booth", "furniture"]);
  const [language, setLanguage] = useState<ExportLanguage>(project.communicationLanguage);
  const [includeFurniturePhotos, setIncludeFurniturePhotos] = useState(false);
  const [emailTopics, setEmailTopics] = useState<EmailTopicId[]>(["graphics", "approval", "deadlines"]);
  const [emailAttachmentIds, setEmailAttachmentIds] = useState<string[]>([
    "summary",
    ...project.selectedOutputIds,
    ...project.selectedEventDocumentIds,
  ]);
  const [emailDraft, setEmailDraft] = useState<EmailDraft | null>(null);
  const [planPreviewDataUrl, setPlanPreviewDataUrl] = useState("");
  const booth = project.booth;
  // Shared with GraphicsExportPanel below — one catalog/pricing-context resolution, never a
  // second implementation (report Graphics Export v1.1, section 19).
  // DB-backed items MUST come first: componentCatalogItems' graphics seed entries
  // (fasciaGraphicsService/fullWrapGraphicsService) carry the SAME internalCode
  // (GRAPHICS-FASCIA/GRAPHICS-FULL-WRAP) as the real catalog_items rows, but with
  // pricingEntries: []. findCatalogItemByIdentity's internalCode lookup is a first-match
  // .find() — putting the static seed first shadowed every DB-backed PricingEntry and
  // forced needs-quote even when the live PriceList had a real rate.
  const graphicsCatalogItems = [...project.technicalCatalogItems, ...componentCatalogItems];
  const graphicsPricingContext = resolvePricingContext(project);
  const calculation = createCustomerCalculationViewModel({
    company: project.company,
    customerProjectNote: project.customerNote,
    currency: project.currency,
    booth: project.booth,
    event: project.event,
    sceneObjects: project.sceneObjects,
    requirements: project.requirements,
    printSurfaceAssignments: project.printSurfaceAssignments,
    realizationProfileId: project.realizationProfileId,
    generatedPlanOutputs: project.generatedPlanOutputs,
    visualizations: project.visualizations,
    options: project.exportCalculationOptions,
    catalogItems: graphicsCatalogItems,
    priceLists: project.priceLists,
  });
  const summary = summaryText(project, language);
  const activeDocuments = project.event?.documents.filter((document) => document.active) ?? [];
  const outputAttachments = useMemo<EmailAttachmentReference[]>(() => [
    { id: "summary", name: language === "cs" ? "Souhrn projektu" : "Project summary", source: "summary", selected: emailAttachmentIds.includes("summary") },
    ...project.generatedPlanOutputs.map((item) => ({ id: item.id, name: item.name, source: "plan" as const, selected: emailAttachmentIds.includes(item.id) })),
    ...project.visualizations.map((item) => ({ id: item.id, name: item.name, source: "visualization" as const, selected: emailAttachmentIds.includes(item.id) })),
    ...activeDocuments.map((item) => ({ id: item.id, name: item.title, source: "event-document" as const, selected: emailAttachmentIds.includes(item.id) })),
  ], [activeDocuments, emailAttachmentIds, language, project.generatedPlanOutputs, project.visualizations]);
  const projectPackage = packageForProject(project, includeFurniturePhotos);
  const toggleLayer = (layer: ExportLayer) => setLayers((current) => current.includes(layer) ? current.filter((item) => item !== layer) : [...current, layer]);
  const toggleOutput = (id: string) => onSelectedOutputIdsChange(project.selectedOutputIds.includes(id) ? project.selectedOutputIds.filter((value) => value !== id) : [...project.selectedOutputIds, id]);
  const toggleDocument = (id: string) => onSelectedEventDocumentIdsChange(project.selectedEventDocumentIds.includes(id) ? project.selectedEventDocumentIds.filter((value) => value !== id) : [...project.selectedEventDocumentIds, id]);
  const toggleTopic = (id: EmailTopicId) => setEmailTopics((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);

  function exportPlan() { if (booth && planPreviewDataUrl) downloadDataUrl(planPreviewDataUrl, `${safeName(project.name)}-pudorys.png`); }
  async function downloadPackage() {
    if (!booth) return;
    const entries: ZipEntry[] = [textZipEntry(`${packageFolderPath(projectPackage, "project")}/souhrn-${language}.txt`, summary)];
    if (planPreviewDataUrl) entries.push(dataUrlZipEntry(`${packageFolderPath(projectPackage, "plans-technical")}/pudorys.png`, planPreviewDataUrl));
    for (const item of project.generatedPlanOutputs.filter((output) => project.selectedOutputIds.includes(output.id))) {
      try {
        const source = item.asset?.storageKey ? await getAssetDownloadUrl(item.asset.storageKey) : item.imageDataUrl;
        const data = new Uint8Array(await (await fetch(source)).arrayBuffer());
        entries.push({ path: `${packageFolderPath(projectPackage, "plans-complete")}/${safeName(item.name)}.png`, data });
      } catch { /* unavailable persistent output falls back only when its legacy data URL is usable */ }
    }
    for (const [index, item] of project.visualizations.filter((output) => project.selectedOutputIds.includes(output.id)).entries()) {
      try {
        const source = item.asset?.storageKey ? await getAssetDownloadUrl(item.asset.storageKey) : item.imageDataUrl;
        const data = new Uint8Array(await (await fetch(source)).arrayBuffer());
        entries.push({ path: `${packageFolderPath(projectPackage, item.purpose === "presentation" ? "visualizations-final" : "visualizations-working")}/${String(index + 1).padStart(2, "0")}-${safeName(item.name)}.png`, data });
      } catch { /* unavailable output is intentionally omitted */ }
    }
    if (includeFurniturePhotos) {
      const furniture = groupCatalogSceneItems(project.sceneObjects, componentCatalogItems, project.currency);
      for (const item of furniture) {
        if (!item.photoUrl) continue;
        const data = await loadCatalogPhoto(item.photoUrl, (url) => fetch(url));
        if (!data) continue;
        entries.push({ path: `${packageFolderPath(projectPackage, "furniture-photos")}/${safeName(item.internalCode ?? item.displayName)}.${photoExtension(item.photoUrl)}`, data });
      }
    }
    for (const temporary of temporaryGraphicFiles) entries.push({ path: `${packageFolderPath(projectPackage, "graphics-input")}/${temporary.file.name}`, data: new Uint8Array(await temporary.file.arrayBuffer()) });
    for (const graphic of project.graphicsFiles.filter((item) => item.storageKey)) {
      try { const data = new Uint8Array(await (await fetch(await getAssetDownloadUrl(graphic.storageKey!))).arrayBuffer()); entries.push({ path: `${packageFolderPath(projectPackage, "graphics-input")}/${graphic.name}`, data }); } catch { /* unavailable private asset is intentionally omitted */ }
    }
    for (const document of activeDocuments.filter((item) => project.selectedEventDocumentIds.includes(item.id) && (item.storageKey || item.assetUrl))) {
      try { const source = document.storageKey ? await getAssetDownloadUrl(document.storageKey) : document.assetUrl!; const data = new Uint8Array(await (await fetch(source)).arrayBuffer()); entries.push({ path: `${packageFolderPath(projectPackage, "event-documents")}/${document.fileName}`, data }); } catch { /* unavailable private or legacy binary is intentionally omitted */ }
    }
    const url = URL.createObjectURL(createZip(entries)); downloadDataUrl(url, `${projectPackage.rootName}.zip`); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function prepareEmail() {
    const provider = new RuleBasedEmailDraftProvider();
    setEmailDraft(await provider.create({ summary, language, purpose: "project", attachments: outputAttachments, recipient: project.contact.email, company: project.company, projectName: project.name, mode: project.mode, stage: project.stage, requirements: project.requirements, selectedTopics: emailTopics, deadlines: [project.event?.materialDataDeadline ?? "", project.event?.designApprovalDeadline ?? ""] }));
  }

  return <div className="workflowStepPage"><StepTitle eyebrow="KROK 5" title="Export" text="Vyberte konkrétní výstupy, přílohy a témata pro kontrolovaný e-mailový draft." />
    <section className="calculationWorkspace">
      <aside className="workflowCard calculationOptions"><div className="workflowCardHeader"><div><span>ZÁKAZNICKÝ EXPORT</span><strong>Kalkulace / nabídka</strong></div></div>
        <CalculationOptions options={project.exportCalculationOptions} outputs={[...project.generatedPlanOutputs, ...project.visualizations]} onChange={onCalculationOptionsChange} />
        <button type="button" className="primaryButton" onClick={() => printDocument("customer-calculation")}>Vytisknout / uložit jako PDF</button>
      </aside>
      <CalculationPreview calculation={calculation} currency={project.currency} />
    </section>
    <div className="exportSettings"><label><span>Jazyk výstupu</span><select value={language} onChange={(event) => setLanguage(event.target.value as ExportLanguage)}><option value="cs">Čeština</option><option value="en">English</option></select><small>Výchozí: {project.communicationLanguage === "cs" ? "Čeština" : "English"}; změna neovlivní projekt.</small></label><label className="checkLabel"><input type="checkbox" checked={includeFurniturePhotos} onChange={(event) => setIncludeFurniturePhotos(event.target.checked)} /> Zahrnout fotografie mobiliáře</label></div>
    <div className="exportGrid">
      <section className="workflowCard"><div className="workflowCardHeader"><div><span>2D EXPORT</span><strong>Technický půdorys PNG</strong></div></div><div className="exportPresets">{EXPORT_PRESETS.map((preset) => <button key={preset.id} onClick={() => setLayers([...preset.options.layers])}>{preset.name}</button>)}</div><div className="layerOptions">{allLayers.map((layer) => <label key={layer}><input type="checkbox" checked={layers.includes(layer)} onChange={() => toggleLayer(layer)} /> {EXPORT_LAYER_LABELS[layer]}</label>)}</div>{booth?.widthMm && booth.depthMm && <PlanLayerPreview booth={booth} sceneObjects={project.sceneObjects} layers={layers} constructionVisibility={project.constructionVisibility} annotations={project.annotations} customDimensions={project.customDimensions} onRendered={setPlanPreviewDataUrl} compact />}<button className="primaryButton" onClick={exportPlan} disabled={!booth || !planPreviewDataUrl}>Stáhnout 2D PNG</button></section>
      <section className="workflowCard"><div className="workflowCardHeader"><div><span>ULOŽENÉ VÝSTUPY</span><strong>Výběr pro balíček</strong></div></div><OutputSelection project={project} toggleOutput={toggleOutput} /></section>
      <section className="workflowCard"><div className="workflowCardHeader"><div><span>PŘÍLOHY EVENTU</span><strong>Dokumenty</strong></div></div>{activeDocuments.length ? activeDocuments.map((document) => <label className="outputSelectionRow" key={document.id}><input type="checkbox" checked={project.selectedEventDocumentIds.includes(document.id)} onChange={() => toggleDocument(document.id)} /><span><strong>{document.title}</strong><small>{document.fileName} · {document.availability === "temporary-session" ? "dočasné" : "uložené"}</small></span></label>) : <p className="emptyState">Event nemá dostupné dokumenty.</p>}</section>
      <section className="workflowCard packageExport"><div className="workflowCardHeader"><div><span>PROJECT PACKAGE</span><strong>Celý projekt</strong></div></div><PackageTree projectPackage={projectPackage} /><button className="primaryButton" onClick={downloadPackage} disabled={!booth}>Stáhnout celý projekt jako ZIP</button><p className="workflowMuted">ZIP obsahuje jen skutečně dostupné a vybrané soubory.</p></section>
    </div>
    <GraphicsExportPanel
      booth={booth}
      printSurfaceAssignments={project.printSurfaceAssignments}
      graphicsFiles={project.graphicsFiles}
      realizationProfileId={project.realizationProfileId}
      realizationLabel={project.realizationName}
      projectName={project.name}
      company={project.company}
      eventName={project.event?.name ?? ""}
      catalogItems={graphicsCatalogItems}
      pricingContext={graphicsPricingContext}
    />
    <section className="workflowCard emailDraftSection"><div className="workflowCardHeader"><div><span>PŘÍPRAVA E-MAILU</span><strong>Pracovní prostor</strong></div></div><div className="emailPreparationGrid"><div><h3>A · Přílohy</h3>{outputAttachments.map((attachment) => <label className="outputSelectionRow" key={attachment.id}><input type="checkbox" checked={emailDraft?.attachments.find((item) => item.id === attachment.id)?.selected ?? emailAttachmentIds.includes(attachment.id)} onChange={() => { setEmailAttachmentIds((ids) => ids.includes(attachment.id) ? ids.filter((id) => id !== attachment.id) : [...ids, attachment.id]); if (emailDraft) setEmailDraft({ ...emailDraft, attachments: emailDraft.attachments.map((item) => item.id === attachment.id ? { ...item, selected: !item.selected } : item) }); }} /><span>{attachment.name}</span></label>)}</div><div><h3>B · Co zahrnout do e-mailu</h3>{EMAIL_TOPICS.map((topic) => <label className="outputSelectionRow" key={topic.id}><input type="checkbox" checked={emailTopics.includes(topic.id)} onChange={() => toggleTopic(topic.id)} /><span>{topic.label}</span></label>)}</div><div><h3>C · Jazyk</h3><strong>{language === "cs" ? "Čeština" : "English"}</strong><p className="workflowMuted">Draft respektuje tento exportní override.</p></div></div><button className="primaryButton" onClick={prepareEmail}>Vytvořit text e-mailu</button>{emailDraft ? <EmailDraftEditor draft={emailDraft} onChange={setEmailDraft} /> : <p className="workspaceEmpty">RuleBasedEmailDraftProvider sestaví text ze skutečného stavu projektu. Nic se automaticky neodesílá.</p>}</section>
  </div>;
}

function CalculationOptions({ options, outputs, onChange }: { options: ExportCalculationOptions; outputs: readonly (GeneratedPlanOutput | VisualizationItem)[]; onChange: (options: ExportCalculationOptions) => void }) {
  const toggle = (key: Exclude<keyof ExportCalculationOptions, "selectedOutputIds">) => onChange({ ...options, [key]: !options[key] });
  const toggleOutput = (id: string) => {
    const selected = options.selectedOutputIds.includes(id);
    if (!selected && options.selectedOutputIds.length >= 4) return;
    onChange({ ...options, selectedOutputIds: selected ? options.selectedOutputIds.filter((value) => value !== id) : [...options.selectedOutputIds, id] });
  };
  return <div className="calculationOptionList">
    {([['includeVisuals','Vizuály / půdorysy'],['includePricingTable','Cenová tabulka'],['includeVatSummary','DPH / souhrn cen'],['includeProjectNote','Poznámka k projektu'],['includeItemNotes','Poznámky k položkám'],['includeContact','Kontaktní údaje'],['includeEventLogo','Logo akce']] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={options[key]} onChange={() => toggle(key)} /> {label}</label>)}
    {options.includeVisuals && <div className="calculationOutputPicker"><strong>Vizuály · max. 4</strong>{[...outputs].sort((a, b) => Number(b.reviewStatus === "reviewed") - Number(a.reviewStatus === "reviewed")).map((output) => <label key={output.id} className={output.reviewStatus === "unreviewed" ? "unreviewed" : ""}><input type="checkbox" checked={options.selectedOutputIds.includes(output.id)} disabled={!options.selectedOutputIds.includes(output.id) && options.selectedOutputIds.length >= 4} onChange={() => toggleOutput(output.id)} /><span>{output.name}<small>{output.reviewStatus === "reviewed" ? "Zkontrolováno" : "Nezkontrolováno – ověřte před exportem"}</small></span></label>)}</div>}
  </div>;
}

function CalculationPreview({ calculation, currency }: { calculation: CustomerCalculationViewModel; currency: CommonProject["currency"] }) {
  const logo = useAssetUrl(calculation.logoAsset, calculation.logoUrl);
  return <article className="calculationPreview" id="customer-calculation">
    <header><div>{logo.url && <img src={logo.url} alt="Logo akce" onError={(event) => { event.currentTarget.style.display = "none"; }} />}<span>ZÁKAZNICKÁ KALKULACE</span><h2>{calculation.documentTitle}</h2></div><dl><div><dt>Datum zpracování</dt><dd>{new Date(calculation.processedAt).toLocaleDateString("cs-CZ")}</dd></div>{calculation.processor && <><div><dt>Zpracoval</dt><dd>{calculation.processor.name || "—"}</dd></div><div><dt>E-mail</dt><dd>{calculation.processor.email || "—"}</dd></div><div><dt>Telefon</dt><dd>{calculation.processor.phone || "—"}</dd></div></>}</dl></header>
    <section className="calculationProject"><div><span>Název společnosti</span><strong>{calculation.project.company || "—"}</strong></div><div><span>Expozice / velikost</span><strong>{calculation.project.exhibitionSize}</strong></div><div><span>Akce</span><strong>{calculation.project.eventName}</strong></div><div><span>Termín konání</span><strong>{calculation.project.eventDate}</strong></div></section>
    {calculation.images.length > 0 && <section><h3>Vizuály a půdorysy</h3><div className={`calculationImages ${calculation.imageLayout}`}>{calculation.images.map((image) => <figure key={image.id}><img src={image.imageDataUrl} alt={image.name} /><figcaption>{image.name}{!image.reviewed && <em>Nezkontrolováno</em>}</figcaption></figure>)}</div></section>}
    {calculation.priceRows.length > 0 && <section><h3>Cenová tabulka</h3><table><thead><tr><th>Položka</th><th>MJ</th><th>Množství</th><th>Cena za MJ</th><th>Celkem</th></tr></thead><tbody>{calculation.priceRows.map((row) => <tr key={row.id}><td><strong>{row.name}</strong>{row.includedInPackage && <small>Součást balíčku</small>}{row.customerNotes?.map((note) => <small key={note}>{note}</small>)}{row.warning && <small className="calculationWarning">{row.warning}</small>}</td><td>{row.unit}</td><td>{row.quantity.toLocaleString("cs-CZ")}</td><td>{row.unitPriceNet === undefined ? "Individuálně" : row.includedInPackage ? "V ceně" : `${row.unitPriceNet.toLocaleString("cs-CZ")} ${currency}`}</td><td>{row.totalNet === undefined ? "Nutno nacenit" : row.includedInPackage ? "0" : `${row.totalNet.toLocaleString("cs-CZ")} ${currency}`}</td></tr>)}</tbody></table><div className="calculationTotals"><span>Celkem bez DPH <strong>{calculation.totals.net.toLocaleString("cs-CZ")} {currency}</strong></span>{calculation.totals.vat !== undefined && <><span>DPH {calculation.totals.vatRatePercent} % <strong>{calculation.totals.vat.toLocaleString("cs-CZ")} {currency}</strong></span><span>Celkem s DPH <strong>{calculation.totals.gross?.toLocaleString("cs-CZ")} {currency}</strong></span></>}</div></section>}
    {calculation.project.customerNote && <section className="calculationNote"><h3>Poznámka k projektu</h3><p>{calculation.project.customerNote}</p></section>}
  </article>;
}

const allLayers: readonly ExportLayer[] = ["booth", "furniture", "electrical", "water", "waste", "annotations", "dimensions"];

function PlanLayerPreview({ booth, sceneObjects, layers, constructionVisibility, annotations, customDimensions, onRendered, compact = false }: { booth: BoothType; sceneObjects: readonly PlacedComponent[]; layers: readonly ExportLayer[]; constructionVisibility: Readonly<Record<string, boolean>>; annotations: readonly ProjectAnnotation[]; customDimensions: readonly CustomDimension[]; onRendered: (dataUrl: string) => void; compact?: boolean }) {
  const [rendered, setRendered] = useState("");
  const width = booth.widthMm;
  const depth = booth.depthMm;
  useEffect(() => {
    if (!width || !depth) return;
    let active = true;
    renderTechnicalPlanPng({ booth, sceneObjects, layers, constructionVisibility, annotations, customDimensions }).then((dataUrl) => {
      if (!active) return;
      setRendered(dataUrl);
      onRendered(dataUrl);
    }).catch(() => {
      if (active) { setRendered(""); onRendered(""); }
    });
    return () => { active = false; };
  }, [annotations, booth, constructionVisibility, customDimensions, depth, layers, onRendered, sceneObjects, width]);
  if (!width || !depth) return null;
  return <div className={`planLayerPreview ${compact ? "compact" : ""}`}><div className="planLayerStage">{rendered ? <img className="planRenderedPreview" src={rendered} alt="Náhled technického půdorysu" /> : <span className="planRenderLoading">Připravuji půdorys…</span>}</div></div>;
}

function GeneratedOutputResults({ visualizations, plans, onUpdateVisualization, onDeleteVisualization, onUpdatePlan, onDeletePlan }: { visualizations: readonly VisualizationItem[]; plans: readonly GeneratedPlanOutput[]; onUpdateVisualization: (item: VisualizationItem) => void; onDeleteVisualization: (id: string) => void; onUpdatePlan: (item: GeneratedPlanOutput) => void; onDeletePlan: (id: string) => void }) {
  const [preview, setPreview] = useState<{ name: string; image: string } | null>(null);
  const count = visualizations.length + plans.length;
  const sections = ["unreviewed", "reviewed"] as const;
  return <section className="workflowCard"><div className="workflowCardHeader"><div><span>ULOŽENÉ VÝSTUPY</span><strong>{count}</strong></div></div>{count ? sections.map((status) => {
    const statusPlans = plans.filter((item) => (item.reviewStatus ?? "unreviewed") === status);
    const statusVisuals = visualizations.filter((item) => (item.reviewStatus ?? "unreviewed") === status);
    if (!statusPlans.length && !statusVisuals.length) return null;
    return <div className="generatedOutputSection" key={status}><h3>{status === "reviewed" ? "ZKONTROLOVÁNO" : "KE KONTROLE"}</h3><div className="visualizationGrid">{statusPlans.map((item) => <OutputFigure key={item.id} name={item.name} image={item.imageDataUrl} meta={item.layers.map((layer) => EXPORT_LAYER_LABELS[layer]).join(" · ")} reviewed={status === "reviewed"} onPreview={() => setPreview({ name: item.name, image: item.imageDataUrl })} onRename={(name) => onUpdatePlan({ ...item, name })} onReview={() => onUpdatePlan({ ...item, reviewStatus: status === "reviewed" ? "unreviewed" : "reviewed" })} onDelete={() => onDeletePlan(item.id)} />)}{statusVisuals.map((item) => <OutputFigure key={item.id} name={item.name} image={item.imageDataUrl} meta={item.purpose === "presentation" ? "3D · Prezentace" : "3D · Pracovní"} reviewed={status === "reviewed"} onPreview={() => setPreview({ name: item.name, image: item.imageDataUrl })} onRename={(name) => onUpdateVisualization({ ...item, name })} onReview={() => onUpdateVisualization({ ...item, reviewStatus: status === "reviewed" ? "unreviewed" : "reviewed" })} onDelete={() => onDeleteVisualization(item.id)} />)}</div></div>;
  }) : <p className="workspaceEmpty">Zatím není uložený žádný výstup.</p>}{preview && <div className="outputLightbox" role="dialog" aria-modal="true" onClick={() => setPreview(null)}><div onClick={(event) => event.stopPropagation()}><button type="button" onClick={() => setPreview(null)} aria-label="Zavřít">×</button><img src={preview.image} alt={preview.name} /><strong>{preview.name}</strong></div></div>}</section>;
}

function OutputFigure({ name, image, meta, reviewed, onPreview, onRename, onReview, onDelete }: { name: string; image: string; meta: string; reviewed: boolean; onPreview: () => void; onRename: (name: string) => void; onReview: () => void; onDelete: () => void }) { return <figure className="generatedOutputFigure"><button type="button" className="outputPreviewButton" onClick={onPreview}><img src={image} alt={name} /></button><figcaption><span><strong>{name}</strong><small>{meta}</small></span><div className="outputActions"><button type="button" onClick={() => { const next = window.prompt("Název výstupu", name); if (next?.trim()) onRename(next.trim()); }}>Přejmenovat</button><button type="button" onClick={onReview}>{reviewed ? "Vrátit ke kontrole" : "Zkontrolováno / OK"}</button><button type="button" onClick={() => { if (window.confirm(`Smazat výstup „${name}“?`)) onDelete(); }}>Smazat</button><button type="button" onClick={() => downloadDataUrl(image, `${name}.png`)}>Stáhnout PNG</button></div></figcaption></figure>; }

function OutputSelection({ project, toggleOutput }: { project: CommonProject; toggleOutput: (id: string) => void }) { const outputs = [...project.generatedPlanOutputs.map((item) => ({ id: item.id, name: item.name, type: "2D půdorys", image: item.imageDataUrl })), ...project.visualizations.map((item) => ({ id: item.id, name: item.name, type: item.type === "ai" ? "AI vizualizace" : "3D technický pohled", image: item.imageDataUrl }))]; return outputs.length ? outputs.map((item) => <div className="outputSelectionRow outputSelectionWithAction" key={item.id}><input type="checkbox" checked={project.selectedOutputIds.includes(item.id)} onChange={() => toggleOutput(item.id)} /><span><strong>{item.name}</strong><small>{item.type}</small></span><button type="button" onClick={() => downloadDataUrl(item.image, `${safeName(item.name)}.png`)}>Stáhnout</button></div>) : <p className="emptyState">Bez uložených výstupů.</p>; }

function EmailDraftEditor({ draft, onChange }: { draft: EmailDraft; onChange: (draft: EmailDraft) => void }) { return <div className="emailDraftForm"><label><span>Komu</span><input value={draft.to} onChange={(event) => onChange({ ...draft, to: event.target.value })} /></label><label><span>Kopie</span><input value={draft.cc ?? ""} onChange={(event) => onChange({ ...draft, cc: event.target.value })} /></label><label><span>Předmět</span><input value={draft.subject} onChange={(event) => onChange({ ...draft, subject: event.target.value })} /></label><label><span>Text</span><textarea value={draft.body} onChange={(event) => onChange({ ...draft, body: event.target.value })} /></label><div className="emailAttachments"><strong>Vybrané přílohy</strong>{draft.attachments.map((attachment) => <label key={attachment.id}><input type="checkbox" checked={attachment.selected} onChange={(event) => onChange({ ...draft, attachments: draft.attachments.map((item) => item.id === attachment.id ? { ...item, selected: event.target.checked } : item) })} /> {attachment.name}</label>)}</div><div className="futureAccess"><strong>Outlook Drafts</strong><span>Budoucí Microsoft Graph provider · žádný e-mail se nyní neposílá.</span><button disabled>Vytvořit koncept v Outlooku</button></div></div>; }

function packageForProject(project: CommonProject, includeFurniturePhotos = false) {
  const furniturePhotos = groupCatalogSceneItems(project.sceneObjects, componentCatalogItems, project.currency)
    .filter((item) => item.photoUrl)
    .map((item) => ({ id: `photo-${item.catalogItemId}`, name: `${safeName(item.internalCode ?? item.displayName)}.${photoExtension(item.photoUrl!)}`, folderId: "furniture-photos", sourceType: "generated" as const, mimeType: "image/jpeg", includeInZip: includeFurniturePhotos, dataReference: item.photoUrl }));
  const documents = project.event?.documents ?? [];
  return createProjectPackage(project.id ?? "unsaved", safeName(project.name), [
    { id: "summary", name: "souhrn.txt", folderId: "project", sourceType: "generated", mimeType: "text/plain", includeInZip: true },
    ...project.generatedPlanOutputs.map((item) => ({ id: item.id, name: `${safeName(item.name)}.png`, folderId: "plans-complete", sourceType: "generated" as const, mimeType: "image/png", includeInZip: project.selectedOutputIds.includes(item.id), dataReference: item.asset?.storageKey ?? item.imageDataUrl })),
    ...project.visualizations.map((item) => ({ id: item.id, name: `${safeName(item.name)}.png`, folderId: item.purpose === "presentation" ? "visualizations-final" : "visualizations-working", sourceType: "generated" as const, mimeType: "image/png", includeInZip: project.selectedOutputIds.includes(item.id), dataReference: item.asset?.storageKey ?? item.imageDataUrl })),
    ...project.graphicsFiles.map((file) => ({ id: file.id, name: file.name, folderId: "graphics-input", sourceType: "uploaded" as const, mimeType: file.mimeType, includeInZip: Boolean(file.storageKey) || file.availability === "temporary-session", dataReference: file.storageKey ?? file.storageUrl })),
    ...documents.map((file) => ({ id: file.id, name: file.fileName, folderId: "event-documents", sourceType: "uploaded" as const, mimeType: file.mimeType, includeInZip: project.selectedEventDocumentIds.includes(file.id), dataReference: file.storageKey ?? file.assetUrl })),
    ...furniturePhotos,
  ]);
}

function PackageTree({ projectPackage }: { projectPackage: ReturnType<typeof createProjectPackage> }) { return <div className="packageTree"><strong>{projectPackage.rootName}</strong>{projectPackage.folders.map((folder) => <div key={folder.id} className="packageFolder"><span style={{ paddingLeft: folder.parentId ? 18 : 0 }}>{folder.parentId ? "└─" : "├─"} {folder.name}</span>{projectPackage.files.filter((file) => file.folderId === folder.id && file.includeInZip).map((file) => <small key={file.id} style={{ paddingLeft: folder.parentId ? 38 : 20 }}>└─ {file.name}</small>)}</div>)}</div>; }
function summaryText(project: CommonProject, language: ExportLanguage): string { const en = language === "en"; const pricing = projectPricing(project); const furniture = groupCatalogSceneItems(project.sceneObjects.filter((item) => item.sceneLayer === "furniture"), componentCatalogItems, project.currency); return [en ? `Project: ${project.name}` : `Projekt: ${project.name}`, `${en ? "Exhibition" : "Výstava"}: ${project.fairName}`, `${en ? "Company" : "Firma"}: ${project.company}`, `${en ? "Contact" : "Kontakt"}: ${project.contact.name} · ${project.contact.phone} · ${project.contact.email}`, `${en ? "Booth" : "Stánek"}: ${project.booth?.name ?? "—"}`, `${en ? "Stage" : "Stav"}: ${stageLabel(project.stage)}`, "", en ? "Furniture:" : "Mobiliář:", ...(furniture.length ? furniture.map((item) => `- ${item.quantity}× ${item.displayName}: ${item.saleTotalNet} ${project.currency} ${en ? "net" : "bez DPH"}`) : [en ? "- Empty" : "- Bez položek"]), "", en ? "Technical requirements:" : "Technické požadavky:", `- ${en ? "Electricity" : "Elektro"}: ${requirementStatusLabels[project.requirements.electricity.status]}`, `- ${en ? "Water" : "Voda"}: ${requirementStatusLabels[project.requirements.water.status]}`, `- ${en ? "Waste" : "Odpad"}: ${requirementStatusLabels[project.requirements.waste.status]}`, "", `${en ? "Total net" : "Celkem bez DPH"}: ${pricing.net} ${project.currency}`, `${en ? `VAT ${pricing.vatRatePercent}%` : `DPH ${pricing.vatRatePercent} %`}: ${pricing.vat} ${project.currency}`, `${en ? "Total gross" : "Celkem s DPH"}: ${pricing.gross} ${project.currency}`].join("\n"); }
function modeLabel(mode: ProjectMode) { return mode === "proposal" ? "Návrh / kalkulace" : mode === "order" ? "Objednávka" : "Realizace"; }
function stageLabel(stage: ProjectStage) { return stage === "quote" ? "Nabídka / Kalkulace" : stage === "design" ? "Návrh" : stage === "approved" ? "Odsouhlaseno" : "Hotovo"; }
function eventDate(event?: Exhibition) { return event?.eventFrom || event?.eventTo ? `${event.eventFrom || "?"}–${event.eventTo || "?"}` : "Termín neuveden"; }
function safeName(value: string) { return (value || "Projekt").trim().replace(/[^a-zA-Z0-9ěščřžýáíéúůĚŠČŘŽÝÁÍÉÚŮ_-]+/g, "_"); }
function formatBytes(size: number) { return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${Math.round(size / 1024)} kB` : `${(size / 1024 / 1024).toFixed(1)} MB`; }
function projectPricing(project: CommonProject) { const calculation = createCustomerCalculationViewModel({ company: project.company, customerProjectNote: project.customerNote, currency: project.currency, booth: project.booth, event: project.event, sceneObjects: project.sceneObjects, requirements: project.requirements, printSurfaceAssignments: project.printSurfaceAssignments, realizationProfileId: project.realizationProfileId, generatedPlanOutputs: [], visualizations: [], options: { ...project.exportCalculationOptions, includePricingTable: true, includeVatSummary: true, includeVisuals: false }, catalogItems: [...project.technicalCatalogItems, ...componentCatalogItems], priceLists: project.priceLists }); return { net: calculation.totals.net, vat: calculation.totals.vat ?? 0, gross: calculation.totals.gross ?? calculation.totals.net, vatRatePercent: calculation.totals.vatRatePercent ?? 21, warnings: calculation.warnings }; }
function formatMoney(value: number, currency: CommonProject["currency"]) { return `${value.toLocaleString("cs-CZ")} ${currency}`; }
function photoExtension(url: string) { const extension = url.split(/[?#]/, 1)[0]?.split(".").pop()?.toLowerCase(); return extension && ["jpg", "jpeg", "png", "webp"].includes(extension) ? extension : "jpg"; }
function StepTitle({ eyebrow, title, text }: { eyebrow: string; title: string; text: string }) { return <div className="workspacePageHeader"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{text}</p></div></div>; }
function StepActions({ onContinue }: { onContinue: () => void }) { return <div className="workflowActions"><button className="primaryButton" onClick={onContinue}>Pokračovat</button></div>; }
function StepEmpty({ title, text }: { title: string; text: string }) { return <div className="workflowStepPage"><StepTitle eyebrow="WORKFLOW" title={title} text={text} /></div>; }
function SummaryCard({ title, children }: { title: string; children: React.ReactNode }) { return <section className="workflowCard summaryWorkflowCard"><h2>{title}</h2>{children}</section>; }
function Row({ label, value }: { label: string; value: string }) { return <div className="summaryWorkflowRow"><span>{label}</span><strong>{value || "—"}</strong></div>; }
