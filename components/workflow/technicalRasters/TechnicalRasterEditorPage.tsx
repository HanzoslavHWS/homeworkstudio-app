"use client";

import { useEffect, useRef, useState } from "react";
import {
  assignStandManually,
  clearStandAssignment,
  mergeTechnicalRasterImport,
  nextUnassignedStand,
  withLayerVisibility,
  withRasterLayers,
  withRasterStandLabels,
  withRasterViewMode,
  withSourceRasterAsset,
  withWorkModeHiddenLayers,
  effectiveHiddenLayerIds,
  type RasterSettings,
  type TechnicalRasterImport,
  type TechnicalRasterProject,
  type TechnicalRasterProjectRepository,
} from "../../../domain/technicalRaster";
import { resolveTechnicalServiceProduct } from "../../../domain/technicalServiceProductMapping";
import { technicalServiceCategoryLabel } from "../../../domain/technicalServiceCatalog";
import type { CatalogItemSummary } from "../../../domain/catalogPricing";
import type { RemoteApiCatalogPricingRepository } from "../../../lib/db/catalogPricing.remoteApi.client";
import { getAssetDownloadUrl, uploadAsset } from "../../../lib/storage/assetClient";
import { loadPdfDocument } from "../../../lib/pdf/pdfDocumentLoader";
import { extractPdfTextItems, getPdfPageSizes } from "../../../lib/pdf/pdfTextExtraction";
import { listPdfLayers } from "../../../lib/pdf/pdfLayers";
import { detectRasterStandLabels } from "../../../lib/pdf/rasterStandLabelDetection";
import { resolveWhiteModeAvailability } from "../../../lib/pdf/technicalRasterWhiteRender";
import { TechnicalRasterCanvas, type RasterCanvasMarker } from "./TechnicalRasterCanvas";
import { TechnicalRasterLayerPanel } from "./TechnicalRasterLayerPanel";
import { TechnicalServiceImportPanel, type PendingTechnicalImport } from "./TechnicalServiceImportPanel";
import { TechnicalStandBuffer } from "./TechnicalStandBuffer";
import { TechnicalStandDetailPanel } from "./TechnicalStandDetailPanel";
import { TechnicalRasterOutputsPanel } from "./TechnicalRasterOutputsPanel";

type TechnicalRasterStep = "raster" | "services" | "assignment" | "outputs";
const STEPS: readonly Readonly<{ id: TechnicalRasterStep; label: string }>[] = [
  { id: "raster", label: "Rastr" },
  { id: "services", label: "Technické služby" },
  { id: "assignment", label: "Přiřazení" },
  { id: "outputs", label: "Výstupy" },
];

/**
 * A single opened Technické rastry project — loaded by id, autosaved (debounced) + an explicit
 * Uložit button, same discipline as PrintSurfaceEditorPage.tsx (a DIFFERENT module's editor —
 * this file shares no state/logic with it, only the established persistence pattern).
 */
export function TechnicalRasterEditorPage({
  projectId,
  projectRepository,
  catalogPricingRepository,
  onBackToList,
}: {
  projectId: string;
  projectRepository: TechnicalRasterProjectRepository;
  catalogPricingRepository: RemoteApiCatalogPricingRepository;
  onBackToList: () => void;
}) {
  const [project, setProject] = useState<TechnicalRasterProject | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [step, setStep] = useState<TechnicalRasterStep>("raster");
  const [catalogItems, setCatalogItems] = useState<readonly CatalogItemSummary[]>([]);
  const [rasterUrl, setRasterUrl] = useState<string | undefined>(undefined);
  const [activePage, setActivePage] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [selectedStandId, setSelectedStandId] = useState<string | undefined>(undefined);
  const [assignmentActiveStandId, setAssignmentActiveStandId] = useState<string | undefined>(undefined);
  const [pendingImport, setPendingImport] = useState<PendingTechnicalImport | undefined>(undefined);
  const [isProcessingRaster, setIsProcessingRaster] = useState(false);
  const [rasterError, setRasterError] = useState("");
  const [renderKey, setRenderKey] = useState(0);
  const [whiteModeUnsupportedReason, setWhiteModeUnsupportedReason] = useState("");

  const skipNextAutosaveRef = useRef(true);
  const pendingSaveTimeoutRef = useRef<number | undefined>(undefined);
  const projectRef = useRef<TechnicalRasterProject | null>(null);
  projectRef.current = project;

  useEffect(() => {
    skipNextAutosaveRef.current = true;
    let cancelled = false;
    projectRepository.get(projectId).then((loaded) => {
      if (cancelled) return;
      if (!loaded) { setLoadError("Projekt nebyl nalezen."); return; }
      setProject(loaded);
    }).catch((error) => { if (!cancelled) setLoadError(error instanceof Error ? error.message : "Projekt se nepodařilo načíst."); });
    return () => { cancelled = true; };
  }, [projectId, projectRepository]);

  useEffect(() => {
    let cancelled = false;
    catalogPricingRepository.listCatalogItems().then((items) => { if (!cancelled) setCatalogItems(items); });
    return () => { cancelled = true; };
  }, [catalogPricingRepository]);

  useEffect(() => {
    let cancelled = false;
    if (!project?.sourceRasterAsset) { setRasterUrl(undefined); return; }
    getAssetDownloadUrl(project.sourceRasterAsset.storageKey).then((url) => { if (!cancelled) setRasterUrl(url); }).catch(() => { if (!cancelled) setRasterUrl(undefined); });
    return () => { cancelled = true; };
  }, [project?.sourceRasterAsset]);

  async function persistNow(target: TechnicalRasterProject): Promise<boolean> {
    if (pendingSaveTimeoutRef.current !== undefined) {
      window.clearTimeout(pendingSaveTimeoutRef.current);
      pendingSaveTimeoutRef.current = undefined;
    }
    setSaveStatus("saving");
    try {
      await projectRepository.save(target);
      setSaveStatus("saved");
      return true;
    } catch (error) {
      console.error("Technical raster project save failed", error);
      setSaveStatus("error");
      return false;
    }
  }

  useEffect(() => {
    if (!project) return;
    if (skipNextAutosaveRef.current) { skipNextAutosaveRef.current = false; return; }
    setSaveStatus("saving");
    const timeout = window.setTimeout(() => {
      pendingSaveTimeoutRef.current = undefined;
      projectRepository.save(project).then(() => setSaveStatus("saved")).catch((error) => {
        console.error("Technical raster project autosave failed", error);
        setSaveStatus("error");
      });
    }, 600);
    pendingSaveTimeoutRef.current = timeout;
    return () => window.clearTimeout(timeout);
  }, [project, projectRepository]);

  function handleManualSave() {
    if (projectRef.current) void persistNow(projectRef.current);
  }

  function updateProject(next: TechnicalRasterProject) {
    setProject(next);
  }

  if (loadError) {
    return (
      <div className="workspacePage">
        <p className="uploadError">{loadError}</p>
        <button type="button" className="textButton" onClick={onBackToList}>← Zpět na seznam projektů</button>
      </div>
    );
  }
  if (!project) {
    return <div className="workspacePage"><p className="workspaceEmpty">Načítám…</p></div>;
  }

  // ============================================================================
  // Step 1: Raster
  // ============================================================================

  async function handleRasterFileSelected(file: File) {
    const current = projectRef.current;
    if (!current) return;
    setRasterError("");
    setIsProcessingRaster(true);
    try {
      const buffer = await file.arrayBuffer();
      const asset = await uploadAsset(file, { category: "technical-raster-source", ownerId: current.id, displayName: file.name });
      const document = await loadPdfDocument({ data: buffer.slice(0) });
      let items, pageSizes, layers;
      try {
        [items, pageSizes, layers] = await Promise.all([
          extractPdfTextItems(document),
          getPdfPageSizes(document),
          listPdfLayers(document),
        ]);
      } finally {
        // This is a short-lived document used only for one-time extraction (a SEPARATE instance
        // from the one TechnicalRasterCanvas.tsx keeps for on-screen rendering) — never stored,
        // so it must be destroyed here or its worker/WASM resources leak (spec batch 2.5 section 21).
        void document.destroy();
      }
      const labels = detectRasterStandLabels(items, pageSizes);

      let next = withSourceRasterAsset(current, asset);
      next = withRasterLayers(next, layers);
      next = withRasterStandLabels(next, labels);
      updateProject(next);
      setActivePage(1);
    } catch (error) {
      setRasterError(error instanceof Error ? error.message : "Rastr se nepodařilo zpracovat.");
    } finally {
      setIsProcessingRaster(false);
    }
  }

  function handleToggleLayer(layerId: string, visible: boolean) {
    setProject((current) => (current ? withLayerVisibility(current, layerId, visible) : current));
    setRenderKey((key) => key + 1);
  }
  function handleSetViewMode(mode: RasterSettings["viewMode"]) {
    setProject((current) => (current ? withRasterViewMode(current, mode) : current));
    setRenderKey((key) => key + 1);
  }
  function handleSetWorkModeHiddenLayers(layerIds: readonly string[]) {
    setProject((current) => (current ? withWorkModeHiddenLayers(current, layerIds) : current));
    setRenderKey((key) => key + 1);
  }

  // ============================================================================
  // Step 2: Technical services import
  // ============================================================================

  const existingImportsByCategory = new Map<string, TechnicalRasterImport>();
  for (const importRecord of project.imports) {
    if (!importRecord.supersededByImportId) existingImportsByCategory.set(importRecord.category, importRecord);
  }

  async function handleConfirmImport() {
    const current = projectRef.current;
    if (!current || !pendingImport) return;
    const { category, file, report, replaceImportId } = pendingImport;
    try {
      const asset = await uploadAsset(file, { category: "technical-raster-import", ownerId: current.id, displayName: file.name });
      const standsFound = new Set(report.rows.map((row) => row.standNumber)).size;
      const servicesFound = report.rows.reduce((sum, row) => sum + row.services.length, 0);
      const importRecord: TechnicalRasterImport = {
        id: crypto.randomUUID(),
        category,
        filename: file.name,
        asset,
        importedAt: new Date().toISOString(),
        parserVersion: "v1",
        parseStatus: report.warnings.length > 0 ? "ok_with_warnings" : "ok",
        standsFound,
        servicesFound,
        warnings: report.warnings.map((warning) => ({ ...warning, id: crypto.randomUUID() })),
      };
      const next = mergeTechnicalRasterImport(
        current,
        importRecord,
        report,
        (serviceCategory, externalLabel) => {
          const resolution = resolveTechnicalServiceProduct(serviceCategory, externalLabel, catalogItems);
          return resolution.status === "resolved"
            ? { internalProductId: resolution.internalProductId, internalProductCode: resolution.internalProductCode, status: "resolved" }
            : { status: "unresolved_product" };
        },
        replaceImportId,
      );
      updateProject(next);
      setPendingImport(undefined);
    } catch (error) {
      setRasterError(error instanceof Error ? error.message : "Import se nepodařilo uložit.");
    }
  }

  // ============================================================================
  // Step 3: Assignment
  // ============================================================================

  function handleStartAssignment(standId: string) {
    setAssignmentActiveStandId(standId);
    setSelectedStandId(standId);
    setStep("assignment");
  }

  function handleCanvasClick(page: number, xNormalized: number, yNormalized: number) {
    const current = projectRef.current;
    if (!current || !assignmentActiveStandId) return;
    const assigned = assignStandManually(current, assignmentActiveStandId, { page, anchorXNormalized: xNormalized, anchorYNormalized: yNormalized });
    updateProject(assigned);
    const next = nextUnassignedStand(assigned, assignmentActiveStandId);
    setAssignmentActiveStandId(next?.id);
    setSelectedStandId(next?.id ?? assignmentActiveStandId);
  }

  function handleClearAssignment(standId: string) {
    setProject((current) => (current ? clearStandAssignment(current, standId) : current));
  }

  const selectedStand = project.stands.find((stand) => stand.id === selectedStandId);
  const activeAssignmentStand = project.stands.find((stand) => stand.id === assignmentActiveStandId);

  const markers: RasterCanvasMarker[] = [];
  if (selectedStand?.placement.anchorXNormalized !== undefined && selectedStand.placement.anchorYNormalized !== undefined && selectedStand.placement.rasterPage !== undefined) {
    const label = project.rasterStandLabels.find((candidate) => candidate.id === selectedStand.placement.matchedLabelId);
    markers.push({
      id: `selected-${selectedStand.id}`,
      page: selectedStand.placement.rasterPage,
      xNormalized: label?.xNormalized ?? selectedStand.placement.anchorXNormalized,
      yNormalized: label?.yNormalized ?? selectedStand.placement.anchorYNormalized,
      widthNormalized: label?.widthNormalized,
      heightNormalized: label?.heightNormalized,
      label: selectedStand.standNumber,
      kind: "selected",
    });
  }

  const hiddenLayerIds = effectiveHiddenLayerIds(project);
  const hiddenLayerIdsKey = [...hiddenLayerIds].sort().join(",");
  const whiteModeAvailability = resolveWhiteModeAvailability(project.rasterLayers);
  const whiteModeStandLayerId =
    project.rasterSettings.viewMode === "work" && whiteModeAvailability.status === "available" ? whiteModeAvailability.standLayerId : undefined;

  return (
    <div className="workspacePage technicalRasterEditorPage">
      <div className="workspacePageHeader">
        <div>
          <button type="button" className="textButton printSurfaceBackButton" onClick={onBackToList}>← Technické rastry</button>
          <span className="eyebrow">TECHNICKÉ RASTRY</span>
          <h1>{project.name || "Bez názvu"}</h1>
        </div>
        <div className="printSurfaceEditorHeaderActions">
          <span className={`printSurfaceSaveStatus status-${saveStatus}`}>
            {saveStatus === "saving" && "Ukládám…"}
            {saveStatus === "saved" && "Uloženo"}
            {saveStatus === "error" && "Chyba ukládání"}
          </span>
          <button type="button" onClick={handleManualSave} disabled={saveStatus === "saving"}>Uložit</button>
        </div>
      </div>

      <nav className="technicalRasterStepTabs">
        {STEPS.map((entry) => (
          <button key={entry.id} type="button" className={step === entry.id ? "technicalRasterStepTab active" : "technicalRasterStepTab"} onClick={() => setStep(entry.id)}>
            {entry.label}
          </button>
        ))}
      </nav>

      {step === "raster" && (
        <div className="technicalRasterWorkspace">
          <TechnicalRasterCanvas
            pdfUrl={rasterUrl}
            hiddenLayerIds={hiddenLayerIds}
            activePage={activePage}
            onPageCountChange={setPageCount}
            markers={[]}
            assignMode={false}
            renderKey={`${renderKey}-${hiddenLayerIdsKey}`}
            whiteModeStandLayerId={whiteModeStandLayerId}
            onWhiteModeUnsupported={setWhiteModeUnsupportedReason}
          />
          <div className="technicalRasterSidebar">
            {!project.sourceRasterAsset && (
              <div className="workflowCard">
                <div className="workflowCardHeader"><div><span>RASTR</span><strong>Nahrát PDF vyměřovacího rastru</strong></div></div>
                <label className="filePicker">
                  <span>{isProcessingRaster ? "Zpracovávám…" : "Nahrát PDF"}</span>
                  <input type="file" accept="application/pdf" disabled={isProcessingRaster} onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void handleRasterFileSelected(file);
                    event.target.value = "";
                  }} />
                </label>
                {rasterError && <p className="uploadError">{rasterError}</p>}
              </div>
            )}
            {project.sourceRasterAsset && (
              <>
                <div className="workflowCard">
                  <p className="fieldHint">Zdrojový soubor: {project.sourceRasterAsset.originalFileName}</p>
                  <p className="fieldHint">Stran: {pageCount} · Rozpoznaných čísel stánků: {project.rasterStandLabels.length}</p>
                  <label className="filePicker compact">
                    <span>{isProcessingRaster ? "Zpracovávám…" : "Nahradit rastr"}</span>
                    <input type="file" accept="application/pdf" disabled={isProcessingRaster} onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void handleRasterFileSelected(file);
                      event.target.value = "";
                    }} />
                  </label>
                  {rasterError && <p className="uploadError">{rasterError}</p>}
                  {pageCount > 1 && (
                    <div className="technicalRasterPageSwitcher">
                      {Array.from({ length: pageCount }, (_, index) => index + 1).map((page) => (
                        <button key={page} type="button" className={page === activePage ? "textButton active" : "textButton"} onClick={() => setActivePage(page)}>{page}</button>
                      ))}
                    </div>
                  )}
                </div>
                <TechnicalRasterLayerPanel
                  layers={project.rasterLayers}
                  settings={project.rasterSettings}
                  whiteModeAvailability={whiteModeAvailability}
                  onToggleLayer={handleToggleLayer}
                  onSetViewMode={handleSetViewMode}
                  onSetWorkModeHiddenLayers={handleSetWorkModeHiddenLayers}
                />
                {whiteModeUnsupportedReason && (
                  <p className="uploadError">U tohoto PDF nelze bezpečně změnit pouze výplně stánků — {whiteModeUnsupportedReason}</p>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {step === "services" && (
        <div className="technicalRasterServicesStep">
          <TechnicalServiceImportPanel existingImportsByCategory={existingImportsByCategory} onPendingImportReady={setPendingImport} />

          {pendingImport && (
            <div className="workflowCard technicalImportPreview">
              <div className="workflowCardHeader"><div><span>NÁHLED IMPORTU</span><strong>{technicalServiceCategoryLabel(pendingImport.category)} — {pendingImport.file.name}</strong></div></div>
              <p>Nalezeno stánků: <strong>{new Set(pendingImport.report.rows.map((row) => row.standNumber)).size}</strong></p>
              <p>Načteno služeb: <strong>{pendingImport.report.rows.reduce((sum, row) => sum + row.services.length, 0)}</strong></p>
              {pendingImport.report.warnings.length > 0 && (
                <div className="technicalImportWarnings">
                  <strong>Upozornění ({pendingImport.report.warnings.length}):</strong>
                  <ul>
                    {pendingImport.report.warnings.map((warning, index) => (
                      <li key={index}>{warning.message}{warning.page ? ` (strana ${warning.page})` : ""}{warning.rawText ? ` — „${warning.rawText}“` : ""}</li>
                    ))}
                  </ul>
                </div>
              )}
              {pendingImport.replaceImportId && <p className="uploadError">Pro tuto kategorii už existuje import — potvrzením nahradíte jeho data (původní záznam zůstane v historii).</p>}
              <div className="printSurfaceCreateFormActions">
                <button type="button" className="primaryButton" onClick={() => void handleConfirmImport()}>{pendingImport.replaceImportId ? "Nahradit předchozí data" : "Potvrdit import"}</button>
                <button type="button" onClick={() => setPendingImport(undefined)}>Zrušit</button>
              </div>
            </div>
          )}

          <div className="workflowCard">
            <div className="workflowCardHeader"><div><span>HISTORIE IMPORTŮ</span></div></div>
            {project.imports.length === 0 && <p className="workspaceEmpty">Zatím nebyl nahrán žádný technický výjezd.</p>}
            {project.imports.length > 0 && (
              <div className="technicalRasterImportHistory">
                {[...project.imports].reverse().map((importRecord) => (
                  <div key={importRecord.id} className={importRecord.supersededByImportId ? "technicalRasterImportRow superseded" : "technicalRasterImportRow"}>
                    <strong>{technicalServiceCategoryLabel(importRecord.category)}</strong>
                    <span>{importRecord.filename}</span>
                    <span className="fieldHint">{new Date(importRecord.importedAt).toLocaleString("cs-CZ")}</span>
                    <span>{importRecord.standsFound} stánků · {importRecord.servicesFound} služeb</span>
                    {importRecord.warnings.length > 0 && <span className="uploadError">{importRecord.warnings.length} upozornění</span>}
                    {importRecord.supersededByImportId && <span className="fieldHint">nahrazeno novějším importem</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {step === "assignment" && (
        <div className="technicalRasterWorkspace">
          <TechnicalRasterCanvas
            pdfUrl={rasterUrl}
            hiddenLayerIds={hiddenLayerIds}
            activePage={activePage}
            onPageCountChange={setPageCount}
            markers={markers}
            assignMode={Boolean(assignmentActiveStandId)}
            onCanvasClick={handleCanvasClick}
            renderKey={`${renderKey}-${hiddenLayerIdsKey}`}
            whiteModeStandLayerId={whiteModeStandLayerId}
            onWhiteModeUnsupported={setWhiteModeUnsupportedReason}
          />
          <div className="technicalRasterSidebar">
            {assignmentActiveStandId && activeAssignmentStand && (
              <p className="technicalRasterAssignHint">Přiřaďte stánek <strong>{activeAssignmentStand.standNumber}</strong> kliknutím do rastru.</p>
            )}
            <TechnicalStandBuffer stands={project.stands} selectedStandId={selectedStandId} activeAssignmentStandId={assignmentActiveStandId} onSelectStand={setSelectedStandId} />
            <TechnicalStandDetailPanel stand={selectedStand} imports={project.imports} onAssign={handleStartAssignment} onClearAssignment={handleClearAssignment} />
          </div>
        </div>
      )}

      {step === "outputs" && <TechnicalRasterOutputsPanel stands={project.stands} />}
    </div>
  );
}
