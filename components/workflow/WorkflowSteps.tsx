import { useEffect, useMemo, useState } from "react";
import {
  carpetFinishVariants,
  constructionFinishVariants,
  selectedFinish,
} from "../../domain/finishes";
import type { BoothType, PlacedComponent } from "../../domain/models";
import { componentCatalogItems } from "../../data/components";
import { calculateNetVatGross } from "../../domain/pricing";
import type { EventDocument, Exhibition } from "../../domain/organizations";
import type { OrderInventoryItem } from "../../domain/order";
import type {
  CommunicationLanguage,
  GeneratedPlanOutput,
  GraphicFileReference,
  ImportedOrder,
  ProjectContact,
  ProjectMode,
  ProjectStage,
  SavedCameraView,
  TechnicalRequirements,
  VisualizationItem,
} from "../../domain/project";
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
  type ExportLanguage,
  type ExportLayer,
} from "../../domain/workflow";
import { createProjectPackage, packageFolderPath } from "../../domain/projectPackage";
import { getMasterReferenceModel } from "../../domain/cad3d";
import { downloadDataUrl, downloadText, renderTechnicalPlanPng, type CadPlanSnapshot } from "../../lib/planExport";
import { createZip, dataUrlZipEntry, textZipEntry, type ZipEntry } from "../../lib/zip";
import { BoothCadPlanView } from "../configurator/BoothCadPlanView";
import { BoothCadViewer } from "../configurator/BoothCadViewer";
import { EventLogo } from "./CatalogManagementPages";
import { requirementStatusLabels } from "./TechnicalRequirementsEditor";

type CommonProject = {
  id?: string;
  name: string;
  fairName: string;
  event?: Exhibition;
  company: string;
  contact: ProjectContact;
  boothNumber: string;
  mode: ProjectMode;
  stage: ProjectStage;
  communicationLanguage: CommunicationLanguage;
  waitingForCustomer: boolean;
  requiresAction: boolean;
  realizationName: string;
  currency: "CZK" | "EUR";
  booth?: BoothType;
  sceneObjects: readonly PlacedComponent[];
  requirements: TechnicalRequirements;
  order?: ImportedOrder;
  inventory: readonly OrderInventoryItem[];
  savedViews: readonly SavedCameraView[];
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
  internalNote?: string;
};

type TemporaryGraphicFile = Readonly<{ id: string; file: File }>;

export function VisualizationStep({ project, onSaveView, onDeleteView, onAddVisualization, onAddPlanOutput, onUpdateVisualization, onDeleteVisualization, onUpdatePlanOutput, onDeletePlanOutput, onSelectedViewsChange, onPurposeChange, on2DLayersChange, onContinue }: {
  project: CommonProject;
  onSaveView: (view: Omit<SavedCameraView, "id" | "createdAt">) => void;
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
  const booth = project.booth;
  const provider = new TechnicalVisualizationProvider();
  if (!booth?.widthMm || !booth.depthMm) return <StepEmpty title="Vizualizace" text="Nejprve vyberte konfigurovatelný stánek." />;
  const views = [...(booth.defaultViews ?? []).map((view) => ({ id: view.id, name: view.name, type: "Výchozí" })), ...project.savedViews.map((view) => ({ id: view.id, name: view.name, type: "Vlastní" }))];
  const toggleView = (id: string) => onSelectedViewsChange(project.selectedVisualizationViewIds.includes(id) ? project.selectedVisualizationViewIds.filter((value) => value !== id) : [...project.selectedVisualizationViewIds, id]);
  const toggleLayer = (layer: ExportLayer) => on2DLayersChange(project.visualization2DLayers.includes(layer) ? project.visualization2DLayers.filter((value) => value !== layer) : [...project.visualization2DLayers, layer]);
  const layers = project.visualization2DLayers as ExportLayer[];

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
    <div className="visualizationStaging">
      <section className="workflowCard visualizationSources"><h2>3D zdroje</h2><div className="viewSelectionList">{views.map((view) => <label key={view.id}><input type="checkbox" checked={project.selectedVisualizationViewIds.includes(view.id)} onChange={() => toggleView(view.id)} /><span><strong>{view.name}</strong><small>{view.type}</small></span></label>)}</div><label className="purposeSelect"><span>Kategorie vizualizace</span><select value={project.visualizationPurpose} onChange={(event) => onPurposeChange(event.target.value as typeof project.visualizationPurpose)}><option value="working">Pracovní návrh</option><option value="presentation">Vizu / prezentační vizualizace</option></select></label><button type="button" disabled>Vytvořit AI vizualizace · budoucí provider</button><p className="workflowMuted">Technický snímek je lokální Three.js capture.</p></section>
      <div className="visualizationWorkspace"><BoothCadViewer asset={getMasterReferenceModel(booth.assets)} footprintWidthMm={booth.widthMm} footprintDepthMm={booth.depthMm} components={project.sceneObjects} defaultViews={booth.defaultViews} savedViews={project.savedViews} nominalDimensions={booth.nominalDimensions} printSurfaces={booth.printSurfaces} showPrintPlaceholder={Boolean(booth.graphicsRequired && !["dataReceived", "ready"].includes(project.requirements.graphics.status))} carpetFinish={selectedFinish(booth.carpetVariants ?? carpetFinishVariants, project.carpetFinishId)} constructionFinish={selectedFinish(booth.finishVariants ?? constructionFinishVariants, project.constructionFinishId)} partDefinitions={booth.partDefinitions} onSaveView={onSaveView} onDeleteView={onDeleteView} onCapture={async ({ imageDataUrl, view }) => onAddVisualization(await provider.create({ name: `Technický vizu ${project.visualizations.length + 1}`, sourceViewId: view.name, technicalRenderDataUrl: imageDataUrl, purpose: project.visualizationPurpose }))} /></div>
    </div>
    <section className="workflowCard visualization2D"><div><h2>2D zdroj</h2><p>Vyberte vrstvy a vytvořte samostatný uložený výstup.</p><div className="layerOptions">{allLayers.map((layer) => <label key={layer}><input type="checkbox" checked={layers.includes(layer)} onChange={() => toggleLayer(layer)} /> {EXPORT_LAYER_LABELS[layer]}</label>)}</div><button className="primaryButton" type="button" onClick={createPlanOutput} disabled={!planPreviewDataUrl}>Vytvořit půdorys</button></div><PlanLayerPreview booth={booth} sceneObjects={project.sceneObjects} layers={layers} annotations={project.annotations} customDimensions={project.customDimensions} onRendered={setPlanPreviewDataUrl} /></section>
    <GeneratedOutputResults visualizations={project.visualizations} plans={project.generatedPlanOutputs} onUpdateVisualization={onUpdateVisualization} onDeleteVisualization={onDeleteVisualization} onUpdatePlan={onUpdatePlanOutput} onDeletePlan={onDeletePlanOutput} />
    <StepActions onContinue={onContinue} />
  </div>;
}

export function SummaryStep({ project, onAddGraphicsFiles, onRemoveGraphicsFile, onContinue }: { project: CommonProject; onAddGraphicsFiles: (files: FileList) => void; onRemoveGraphicsFile: (id: string) => void; onContinue: () => void }) {
  const counts = countScene(project.sceneObjects.filter((item) => item.sceneLayer === "furniture"));
  const unresolved = project.order?.lines.filter((line) => line.mappingStatus === "unresolved") ?? [];
  const mismatches = project.inventory.filter((item) => item.status !== "complete");
  const projectPackage = packageForProject(project);
  const graphicsMissing = Boolean(project.booth?.graphicsRequired && !["dataReceived", "ready"].includes(project.requirements.graphics.status));
  const pricing = projectPricing(project);
  return <div className="workflowStepPage"><StepTitle eyebrow="KROK 4" title="Souhrn" text="Interní kontrola projektu před exportem." />
    {(mismatches.length > 0 || unresolved.length > 0 || project.requiresAction || graphicsMissing) && <div className="workflowWarning">{mismatches.length > 0 && <span>Objednávka a model nejsou v přesné shodě.</span>}{unresolved.length > 0 && <span>Objednávka obsahuje nevyřešené řádky.</span>}{project.requiresAction && <span>Projekt vyžaduje naši akci.</span>}{graphicsMissing && <span>Požadujeme zaslání grafických / tiskových dat pro límec.</span>}</div>}
    <div className="summaryGrid">
      <SummaryCard title="Projekt"><Row label="Firma" value={project.company} /><Row label="Stánek" value={project.booth?.name ?? "—"} /><Row label="Označení" value={project.boothNumber || "—"} /><Row label="Stage" value={stageLabel(project.stage)} /><Row label="Režim" value={modeLabel(project.mode)} /><Row label="Jazyk komunikace" value={project.communicationLanguage === "cs" ? "Čeština" : "English"} /><Row label="Kontakt" value={project.contact.name || "—"} /><Row label="Telefon" value={project.contact.phone || "—"} /><Row label="E-mail" value={project.contact.email || "—"} /><Row label="Realizace" value={project.realizationName} />{project.internalNote && <div className="internalSummaryNote"><span>INTERNÍ POZNÁMKA</span><p>{project.internalNote}</p></div>}</SummaryCard>
      <SummaryCard title="Výstava"><div className="summaryEvent"><EventLogo event={project.event} compact /><div><strong>{project.event?.name ?? project.fairName}</strong><span>{project.event?.venue || "Místo neuvedeno"}</span><span>{eventDate(project.event)}</span></div></div></SummaryCard>
      <SummaryCard title="Mobiliář">{counts.size ? [...counts].map(([name, count]) => <Row key={name} label={name} value={`${count} ks`} />) : <p className="emptyState">Scéna je prázdná.</p>}</SummaryCard>
      <SummaryCard title="Objednávka">{project.order ? <>{project.inventory.map((item) => <Row key={item.catalogItemId} label={item.name} value={item.status === "complete" ? `${item.placed} / ${item.ordered} · OK` : item.status === "over" ? `${item.placed} / ${item.ordered} · navíc ${item.extra}` : `${item.placed} / ${item.ordered} · chybí ${item.remaining}`} />)}{unresolved.map((line) => <Row key={line.id} label={line.sourceName || line.rawText} value="Nevyřešeno" />)}</> : <p className="emptyState">Zatím není importovaná objednávka.</p>}</SummaryCard>
      <SummaryCard title="Technické požadavky">{(["electricity", "water", "waste"] as const).map((key) => <Row key={key} label={{ electricity: "Elektro", water: "Voda", waste: "Odpad" }[key]} value={requirementStatusLabels[project.requirements[key].status]} />)}</SummaryCard>
      <section className="workflowCard summaryWorkflowCard graphicsSummary"><h2>Grafika</h2><Row label="Stav" value={requirementStatusLabels[project.requirements.graphics.status]} /><Row label="Poznámka" value={project.requirements.graphics.note || "—"} /><label className="filePicker"><span>Přidat dočasná grafická data</span><input type="file" multiple accept="image/*,.pdf,.ai,.eps,.svg" onChange={(event) => { if (event.target.files) onAddGraphicsFiles(event.target.files); event.target.value = ""; }} /></label><p className="temporaryNotice">Pouze lokální relace. Nejde o trvalý upload.</p><div className="graphicsFiles">{project.graphicsFiles.map((file) => <div key={file.id}><span><strong>{file.name}</strong><small>{formatBytes(file.size)} · {file.mimeType || "neznámý typ"} · dočasné</small></span><button onClick={() => onRemoveGraphicsFile(file.id)}>Odebrat</button></div>)}</div></section>
      <SummaryCard title="Výstupy"><Row label="2D půdorysy" value={String(project.generatedPlanOutputs.length)} /><Row label="3D technické pohledy" value={String(project.visualizations.length)} /></SummaryCard>
      <SummaryCard title="Cena"><Row label="Cena bez DPH" value={`${pricing.net.toLocaleString("cs-CZ")} ${project.currency}`} /><Row label={`DPH ${pricing.vatRatePercent} %`} value={`${pricing.vat.toLocaleString("cs-CZ")} ${project.currency}`} /><Row label="Celkem s DPH" value={`${pricing.gross.toLocaleString("cs-CZ")} ${project.currency}`} /></SummaryCard>
      <SummaryCard title="Project package"><PackageTree projectPackage={projectPackage} /></SummaryCard>
    </div><StepActions onContinue={onContinue} /></div>;
}

export function ExportStep({ project, temporaryGraphicFiles, onSelectedOutputIdsChange, onSelectedEventDocumentIdsChange }: { project: CommonProject; temporaryGraphicFiles: readonly TemporaryGraphicFile[]; onSelectedOutputIdsChange: (ids: string[]) => void; onSelectedEventDocumentIdsChange: (ids: string[]) => void }) {
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
  const summary = summaryText(project, language);
  const activeDocuments = project.event?.documents.filter((document) => document.active) ?? [];
  const outputAttachments = useMemo<EmailAttachmentReference[]>(() => [
    { id: "summary", name: language === "cs" ? "Souhrn projektu" : "Project summary", source: "summary", selected: emailAttachmentIds.includes("summary") },
    ...project.generatedPlanOutputs.map((item) => ({ id: item.id, name: item.name, source: "plan" as const, selected: emailAttachmentIds.includes(item.id) })),
    ...project.visualizations.map((item) => ({ id: item.id, name: item.name, source: "visualization" as const, selected: emailAttachmentIds.includes(item.id) })),
    ...activeDocuments.map((item) => ({ id: item.id, name: item.title, source: "event-document" as const, selected: emailAttachmentIds.includes(item.id) })),
  ], [activeDocuments, emailAttachmentIds, language, project.generatedPlanOutputs, project.visualizations]);
  const projectPackage = packageForProject(project);
  const toggleLayer = (layer: ExportLayer) => setLayers((current) => current.includes(layer) ? current.filter((item) => item !== layer) : [...current, layer]);
  const toggleOutput = (id: string) => onSelectedOutputIdsChange(project.selectedOutputIds.includes(id) ? project.selectedOutputIds.filter((value) => value !== id) : [...project.selectedOutputIds, id]);
  const toggleDocument = (id: string) => onSelectedEventDocumentIdsChange(project.selectedEventDocumentIds.includes(id) ? project.selectedEventDocumentIds.filter((value) => value !== id) : [...project.selectedEventDocumentIds, id]);
  const toggleTopic = (id: EmailTopicId) => setEmailTopics((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);

  function exportPlan() { if (booth && planPreviewDataUrl) downloadDataUrl(planPreviewDataUrl, `${safeName(project.name)}-pudorys.png`); }
  async function downloadPackage() {
    if (!booth) return;
    const entries: ZipEntry[] = [textZipEntry(`${packageFolderPath(projectPackage, "project")}/souhrn-${language}.txt`, summary)];
    if (planPreviewDataUrl) entries.push(dataUrlZipEntry(`${packageFolderPath(projectPackage, "plans-technical")}/pudorys.png`, planPreviewDataUrl));
    project.generatedPlanOutputs.filter((item) => project.selectedOutputIds.includes(item.id)).forEach((item) => entries.push(dataUrlZipEntry(`${packageFolderPath(projectPackage, "plans-complete")}/${safeName(item.name)}.png`, item.imageDataUrl)));
    project.visualizations.filter((item) => project.selectedOutputIds.includes(item.id)).forEach((item, index) => entries.push(dataUrlZipEntry(`${packageFolderPath(projectPackage, item.purpose === "presentation" ? "visualizations-final" : "visualizations-working")}/${String(index + 1).padStart(2, "0")}-${safeName(item.name)}.png`, item.imageDataUrl)));
    for (const temporary of temporaryGraphicFiles) entries.push({ path: `${packageFolderPath(projectPackage, "graphics-input")}/${temporary.file.name}`, data: new Uint8Array(await temporary.file.arrayBuffer()) });
    for (const document of activeDocuments.filter((item) => project.selectedEventDocumentIds.includes(item.id) && item.assetUrl)) {
      try { const data = new Uint8Array(await (await fetch(document.assetUrl!)).arrayBuffer()); entries.push({ path: `${packageFolderPath(projectPackage, "event-documents")}/${document.fileName}`, data }); } catch { /* unavailable temporary binary is intentionally omitted */ }
    }
    const url = URL.createObjectURL(createZip(entries)); downloadDataUrl(url, `${projectPackage.rootName}.zip`); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function prepareEmail() {
    const provider = new RuleBasedEmailDraftProvider();
    setEmailDraft(await provider.create({ summary, language, purpose: "project", attachments: outputAttachments, recipient: project.contact.email, company: project.company, projectName: project.name, mode: project.mode, stage: project.stage, requirements: project.requirements, selectedTopics: emailTopics, deadlines: [project.event?.materialDataDeadline ?? "", project.event?.designApprovalDeadline ?? ""] }));
  }

  return <div className="workflowStepPage"><StepTitle eyebrow="KROK 5" title="Export" text="Vyberte konkrétní výstupy, přílohy a témata pro kontrolovaný e-mailový draft." />
    <div className="exportSettings"><label><span>Jazyk výstupu</span><select value={language} onChange={(event) => setLanguage(event.target.value as ExportLanguage)}><option value="cs">Čeština</option><option value="en">English</option></select><small>Výchozí: {project.communicationLanguage === "cs" ? "Čeština" : "English"}; změna neovlivní projekt.</small></label><label className="checkLabel"><input type="checkbox" checked={includeFurniturePhotos} onChange={(event) => setIncludeFurniturePhotos(event.target.checked)} /> Zahrnout fotografie mobiliáře</label></div>
    <div className="exportGrid">
      <section className="workflowCard"><div className="workflowCardHeader"><div><span>2D EXPORT</span><strong>Technický půdorys PNG</strong></div></div><div className="exportPresets">{EXPORT_PRESETS.map((preset) => <button key={preset.id} onClick={() => setLayers([...preset.options.layers])}>{preset.name}</button>)}</div><div className="layerOptions">{allLayers.map((layer) => <label key={layer}><input type="checkbox" checked={layers.includes(layer)} onChange={() => toggleLayer(layer)} /> {EXPORT_LAYER_LABELS[layer]}</label>)}</div>{booth?.widthMm && booth.depthMm && <PlanLayerPreview booth={booth} sceneObjects={project.sceneObjects} layers={layers} annotations={project.annotations} customDimensions={project.customDimensions} onRendered={setPlanPreviewDataUrl} compact />}<button className="primaryButton" onClick={exportPlan} disabled={!booth || !planPreviewDataUrl}>Stáhnout 2D PNG</button></section>
      <section className="workflowCard"><div className="workflowCardHeader"><div><span>ULOŽENÉ VÝSTUPY</span><strong>Výběr pro balíček</strong></div></div><OutputSelection project={project} toggleOutput={toggleOutput} /></section>
      <section className="workflowCard"><div className="workflowCardHeader"><div><span>PŘÍLOHY EVENTU</span><strong>Dokumenty</strong></div></div>{activeDocuments.length ? activeDocuments.map((document) => <label className="outputSelectionRow" key={document.id}><input type="checkbox" checked={project.selectedEventDocumentIds.includes(document.id)} onChange={() => toggleDocument(document.id)} /><span><strong>{document.title}</strong><small>{document.fileName} · {document.availability === "temporary-session" ? "dočasné" : "uložené"}</small></span></label>) : <p className="emptyState">Event nemá dostupné dokumenty.</p>}</section>
      <section className="workflowCard packageExport"><div className="workflowCardHeader"><div><span>PROJECT PACKAGE</span><strong>Celý projekt</strong></div></div><PackageTree projectPackage={projectPackage} /><button className="primaryButton" onClick={downloadPackage} disabled={!booth}>Stáhnout celý projekt jako ZIP</button><p className="workflowMuted">ZIP obsahuje jen skutečně dostupné a vybrané soubory.</p></section>
    </div>
    <section className="workflowCard emailDraftSection"><div className="workflowCardHeader"><div><span>PŘÍPRAVA E-MAILU</span><strong>Pracovní prostor</strong></div></div><div className="emailPreparationGrid"><div><h3>A · Přílohy</h3>{outputAttachments.map((attachment) => <label className="outputSelectionRow" key={attachment.id}><input type="checkbox" checked={emailDraft?.attachments.find((item) => item.id === attachment.id)?.selected ?? emailAttachmentIds.includes(attachment.id)} onChange={() => { setEmailAttachmentIds((ids) => ids.includes(attachment.id) ? ids.filter((id) => id !== attachment.id) : [...ids, attachment.id]); if (emailDraft) setEmailDraft({ ...emailDraft, attachments: emailDraft.attachments.map((item) => item.id === attachment.id ? { ...item, selected: !item.selected } : item) }); }} /><span>{attachment.name}</span></label>)}</div><div><h3>B · Co zahrnout do e-mailu</h3>{EMAIL_TOPICS.map((topic) => <label className="outputSelectionRow" key={topic.id}><input type="checkbox" checked={emailTopics.includes(topic.id)} onChange={() => toggleTopic(topic.id)} /><span>{topic.label}</span></label>)}</div><div><h3>C · Jazyk</h3><strong>{language === "cs" ? "Čeština" : "English"}</strong><p className="workflowMuted">Draft respektuje tento exportní override.</p></div></div><button className="primaryButton" onClick={prepareEmail}>Vytvořit text e-mailu</button>{emailDraft ? <EmailDraftEditor draft={emailDraft} onChange={setEmailDraft} /> : <p className="workspaceEmpty">RuleBasedEmailDraftProvider sestaví text ze skutečného stavu projektu. Nic se automaticky neodesílá.</p>}</section>
  </div>;
}

const allLayers: readonly ExportLayer[] = ["booth", "furniture", "electrical", "water", "waste", "annotations", "dimensions"];

function PlanLayerPreview({ booth, sceneObjects, layers, annotations, customDimensions, onRendered, compact = false }: { booth: BoothType; sceneObjects: readonly PlacedComponent[]; layers: readonly ExportLayer[]; annotations: readonly ProjectAnnotation[]; customDimensions: readonly CustomDimension[]; onRendered: (dataUrl: string) => void; compact?: boolean }) {
  const [cadSnapshot, setCadSnapshot] = useState<CadPlanSnapshot>();
  const [rendered, setRendered] = useState("");
  const width = booth.widthMm;
  const depth = booth.depthMm;
  useEffect(() => {
    if (!width || !depth || (layers.includes("booth") && !cadSnapshot)) return;
    let active = true;
    renderTechnicalPlanPng({ booth, sceneObjects, layers, annotations, customDimensions, cadSnapshot }).then((dataUrl) => {
      if (!active) return;
      setRendered(dataUrl);
      onRendered(dataUrl);
    }).catch(() => {
      if (active) { setRendered(""); onRendered(""); }
    });
    return () => { active = false; };
  }, [annotations, booth, cadSnapshot, customDimensions, depth, layers, onRendered, sceneObjects, width]);
  if (!width || !depth) return null;
  return <div className={`planLayerPreview ${compact ? "compact" : ""}`}><div className="planLayerStage"><BoothCadPlanView asset={getMasterReferenceModel(booth.assets)} footprintWidthMm={width} footprintDepthMm={depth} visible={layers.includes("booth") && !rendered} selected={false} rotateView180 onSnapshot={setCadSnapshot} />{rendered ? <img className="planRenderedPreview" src={rendered} alt="Náhled technického půdorysu" /> : <span className="planRenderLoading">Připravuji CAD půdorys…</span>}</div></div>;
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

function packageForProject(project: CommonProject) {
  const documents = project.event?.documents ?? [];
  return createProjectPackage(project.id ?? "unsaved", safeName(project.name), [
    { id: "summary", name: "souhrn.txt", folderId: "project", sourceType: "generated", mimeType: "text/plain", includeInZip: true },
    ...project.generatedPlanOutputs.map((item) => ({ id: item.id, name: `${safeName(item.name)}.png`, folderId: "plans-complete", sourceType: "generated" as const, mimeType: "image/png", includeInZip: project.selectedOutputIds.includes(item.id), dataReference: item.imageDataUrl })),
    ...project.visualizations.map((item) => ({ id: item.id, name: `${safeName(item.name)}.png`, folderId: item.purpose === "presentation" ? "visualizations-final" : "visualizations-working", sourceType: "generated" as const, mimeType: "image/png", includeInZip: project.selectedOutputIds.includes(item.id), dataReference: item.imageDataUrl })),
    ...project.graphicsFiles.map((file) => ({ id: file.id, name: file.name, folderId: "graphics-input", sourceType: "uploaded" as const, mimeType: file.mimeType, includeInZip: file.availability === "temporary-session" })),
    ...documents.map((file) => ({ id: file.id, name: file.fileName, folderId: "event-documents", sourceType: "uploaded" as const, mimeType: file.mimeType, includeInZip: project.selectedEventDocumentIds.includes(file.id), dataReference: file.assetUrl })),
  ]);
}

function PackageTree({ projectPackage }: { projectPackage: ReturnType<typeof createProjectPackage> }) { return <div className="packageTree"><strong>{projectPackage.rootName}</strong>{projectPackage.folders.map((folder) => <div key={folder.id} className="packageFolder"><span style={{ paddingLeft: folder.parentId ? 18 : 0 }}>{folder.parentId ? "└─" : "├─"} {folder.name}</span>{projectPackage.files.filter((file) => file.folderId === folder.id && file.includeInZip).map((file) => <small key={file.id} style={{ paddingLeft: folder.parentId ? 38 : 20 }}>└─ {file.name}</small>)}</div>)}</div>; }
function summaryText(project: CommonProject, language: ExportLanguage): string { const en = language === "en"; const pricing = projectPricing(project); return [en ? `Project: ${project.name}` : `Projekt: ${project.name}`, `${en ? "Exhibition" : "Výstava"}: ${project.fairName}`, `${en ? "Company" : "Firma"}: ${project.company}`, `${en ? "Contact" : "Kontakt"}: ${project.contact.name} · ${project.contact.phone} · ${project.contact.email}`, `${en ? "Booth" : "Stánek"}: ${project.booth?.name ?? "—"}`, `${en ? "Stage" : "Stav"}: ${stageLabel(project.stage)}`, "", en ? "Scene:" : "Scéna:", ...project.sceneObjects.map((item) => `- ${item.name}: X ${item.xMm} mm, Y ${item.yMm} mm, ${item.rotationDeg}°`), "", en ? "Technical requirements:" : "Technické požadavky:", `- ${en ? "Electricity" : "Elektro"}: ${requirementStatusLabels[project.requirements.electricity.status]}`, `- ${en ? "Water" : "Voda"}: ${requirementStatusLabels[project.requirements.water.status]}`, `- ${en ? "Waste" : "Odpad"}: ${requirementStatusLabels[project.requirements.waste.status]}`, "", `${en ? "Total net" : "Celkem bez DPH"}: ${pricing.net} ${project.currency}`, `${en ? `VAT ${pricing.vatRatePercent}%` : `DPH ${pricing.vatRatePercent} %`}: ${pricing.vat} ${project.currency}`, `${en ? "Total gross" : "Celkem s DPH"}: ${pricing.gross} ${project.currency}`].join("\n"); }
function countScene(items: readonly PlacedComponent[]) { const counts = new Map<string, number>(); items.forEach((item) => counts.set(item.name, (counts.get(item.name) ?? 0) + 1)); return counts; }
function modeLabel(mode: ProjectMode) { return mode === "proposal" ? "Návrh / kalkulace" : mode === "order" ? "Objednávka" : "Realizace"; }
function stageLabel(stage: ProjectStage) { return stage === "quote" ? "Nabídka / Kalkulace" : stage === "design" ? "Návrh" : stage === "approved" ? "Odsouhlaseno" : "Hotovo"; }
function eventDate(event?: Exhibition) { return event?.eventFrom || event?.eventTo ? `${event.eventFrom || "?"}–${event.eventTo || "?"}` : "Termín neuveden"; }
function safeName(value: string) { return (value || "Projekt").trim().replace(/[^a-zA-Z0-9ěščřžýáíéúůĚŠČŘŽÝÁÍÉÚŮ_-]+/g, "_"); }
function formatBytes(size: number) { return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${Math.round(size / 1024)} kB` : `${(size / 1024 / 1024).toFixed(1)} MB`; }
function projectPricing(project: CommonProject) { const boothNet = project.booth?.pricingEntries?.find((entry) => entry.currency === project.currency && !entry.exhibitionId && !entry.priceListId)?.salePrice ?? 0; const furnitureNet = project.sceneObjects.reduce((sum, item) => { const definition = componentCatalogItems.find((candidate) => candidate.id === item.definitionId); return sum + (definition?.pricingEntries?.find((entry) => entry.currency === project.currency && !entry.exhibitionId && !entry.priceListId)?.salePrice ?? 0); }, 0); return calculateNetVatGross(boothNet + furnitureNet); }
function StepTitle({ eyebrow, title, text }: { eyebrow: string; title: string; text: string }) { return <div className="workspacePageHeader"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{text}</p></div></div>; }
function StepActions({ onContinue }: { onContinue: () => void }) { return <div className="workflowActions"><button className="primaryButton" onClick={onContinue}>Pokračovat</button></div>; }
function StepEmpty({ title, text }: { title: string; text: string }) { return <div className="workflowStepPage"><StepTitle eyebrow="WORKFLOW" title={title} text={text} /></div>; }
function SummaryCard({ title, children }: { title: string; children: React.ReactNode }) { return <section className="workflowCard summaryWorkflowCard"><h2>{title}</h2>{children}</section>; }
function Row({ label, value }: { label: string; value: string }) { return <div className="summaryWorkflowRow"><span>{label}</span><strong>{value || "—"}</strong></div>; }
