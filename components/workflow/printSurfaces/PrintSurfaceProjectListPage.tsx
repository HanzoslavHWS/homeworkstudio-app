"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  PrintSurfaceProjectRepository,
  PrintSurfaceProjectStatus,
  PrintSurfaceProjectSummary,
} from "../../../domain/printSurfaceProject";
import type { RealizationCompany, RealizationCompanyRepository } from "../../../domain/realizationCompany";
import type { PrintSurfacePreset, PrintSurfacePresetRepository } from "../../../domain/printSurfacePreset";
import type { PrintSurfaceProductionDimension, PrintSurfaceProductionDimensionRepository } from "../../../domain/printSurfaceProductionDimension";
import type { Exhibition } from "../../../domain/organizations";
import { addPrintSurfaceView } from "../../../domain/printSurfaceProject";
import { getAssetDownloadUrl, uploadAsset, readRasterImageDimensions } from "../../../lib/storage/assetClient";
import { PrintSurfaceCatalogImportPanel } from "./PrintSurfaceCatalogImportPanel";

const STATUS_LABELS: Record<PrintSurfaceProjectStatus, string> = {
  draft: "Rozpracováno",
  ready: "Připraveno",
  sent: "Odesláno",
};

export function PrintSurfaceProjectListPage({
  projectRepository,
  companyRepository,
  presetRepository,
  productionDimensionRepository,
  events,
  onOpenProject,
}: {
  projectRepository: PrintSurfaceProjectRepository;
  companyRepository: RealizationCompanyRepository;
  presetRepository: PrintSurfacePresetRepository;
  productionDimensionRepository: PrintSurfaceProductionDimensionRepository;
  events: readonly Exhibition[];
  onOpenProject: (id: string) => void;
}) {
  const [projects, setProjects] = useState<readonly PrintSurfaceProjectSummary[] | null>(null);
  const [listError, setListError] = useState("");
  const [companies, setCompanies] = useState<readonly RealizationCompany[]>([]);
  const [presets, setPresets] = useState<readonly PrintSurfacePreset[]>([]);
  const [productionDimensions, setProductionDimensions] = useState<readonly PrintSurfaceProductionDimension[]>([]);

  const [searchText, setSearchText] = useState("");
  const [eventFilter, setEventFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createCompanyName, setCreateCompanyName] = useState("");
  const [createEventId, setCreateEventId] = useState("");
  const [createRealizationCompanyId, setCreateRealizationCompanyId] = useState("");
  const [createImageFile, setCreateImageFile] = useState<File | undefined>(undefined);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  function reloadProjects() {
    projectRepository.list().then(setProjects).catch((error) => setListError(error instanceof Error ? error.message : "Projekty se nepodařilo načíst."));
  }

  function reloadCatalog() {
    Promise.all([companyRepository.list(), presetRepository.list(), productionDimensionRepository.list()]).then(
      ([loadedCompanies, loadedPresets, loadedDimensions]) => {
        setCompanies(loadedCompanies);
        setPresets(loadedPresets);
        setProductionDimensions(loadedDimensions);
      },
    );
  }

  useEffect(() => { reloadProjects(); }, [projectRepository]);
  useEffect(() => { reloadCatalog(); }, [companyRepository, presetRepository, productionDimensionRepository]);

  const filteredProjects = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    return (projects ?? []).filter((project) => {
      if (eventFilter && project.eventId !== eventFilter) return false;
      if (statusFilter && project.status !== statusFilter) return false;
      if (query && !`${project.name} ${project.companyName}`.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [projects, searchText, eventFilter, statusFilter]);

  /**
   * Quick download without opening the editor — just resolves the already-uploaded latestPdf
   * storageKey and downloads it, never regenerates anything and never makes a freshness decision
   * (the list is not an authoritative source of truth for PDF freshness — see
   * PrintSurfaceProjectSummary.latestPdf's own doc; only an open PrintSurfaceEditorPage is).
   * Passes the logical fileName through so the browser saves it under the human-readable name, not
   * the (often UUID) storageKey.
   */
  async function handleDownloadPdf(storageKey: string, fileName: string) {
    try {
      const url = await getAssetDownloadUrl(storageKey, fileName);
      window.open(url, "_blank");
    } catch {
      setListError("Stažení PDF se nezdařilo.");
    }
  }

  function eventName(id: string | undefined): string {
    return events.find((event) => event.id === id)?.name ?? "—";
  }
  function companyName(id: string | undefined): string {
    return companies.find((company) => company.id === id)?.name ?? "—";
  }

  function openCreateForm() {
    setCreateName("");
    setCreateCompanyName("");
    setCreateEventId("");
    setCreateRealizationCompanyId("");
    setCreateImageFile(undefined);
    setCreateError("");
    setShowCreateForm(true);
  }

  async function handleCreateSubmit() {
    const name = createName.trim();
    if (!name || isCreating) return;
    setIsCreating(true);
    setCreateError("");
    try {
      const project = await projectRepository.create({
        name,
        companyName: createCompanyName.trim(),
        eventId: createEventId || undefined,
        realizationCompanyId: createRealizationCompanyId || undefined,
      });

      let finalProject = project;
      if (createImageFile) {
        const dimensions = await readRasterImageDimensions(createImageFile);
        if (dimensions) {
          const asset = await uploadAsset(createImageFile, { category: "print-surface-image", ownerId: project.id });
          finalProject = await projectRepository.save(addPrintSurfaceView(project, { asset, widthPx: dimensions.widthPx, heightPx: dimensions.heightPx }));
        }
      }

      setShowCreateForm(false);
      onOpenProject(finalProject.id);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Vytvoření projektu se nezdařilo.");
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <div className="workspacePage">
      <div className="workspacePageHeader">
        <div>
          <span className="eyebrow">TISKOVÉ PLOCHY</span>
          <h1>Tiskové plochy</h1>
        </div>
        <button type="button" className="primaryButton" onClick={openCreateForm}>+ Nové tiskové plochy</button>
      </div>

      {showCreateForm && (
        <div className="workflowCard printSurfaceCreateForm">
          <div className="workflowCardHeader">
            <div><span>NOVÝ PROJEKT</span><strong>Vytvořit tiskové plochy</strong></div>
          </div>
          {createError && <p className="uploadError">{createError}</p>}
          <div className="workspaceFormRow">
            <label><span>Název projektu</span><input value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder="např. Stánek XY 2026" /></label>
            <label><span>Firma</span><input value={createCompanyName} onChange={(event) => setCreateCompanyName(event.target.value)} /></label>
            <label>
              <span>Event</span>
              <select value={createEventId} onChange={(event) => setCreateEventId(event.target.value)}>
                <option value="">— Bez eventu —</option>
                {events.map((event) => <option key={event.id} value={event.id}>{event.name}</option>)}
              </select>
            </label>
            <label>
              <span>Realizačka</span>
              <select value={createRealizationCompanyId} onChange={(event) => setCreateRealizationCompanyId(event.target.value)}>
                <option value="">— Bez realizačky —</option>
                {companies.filter((company) => company.isActive).map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
              </select>
            </label>
          </div>
          <label className="filePicker">
            <span>{createImageFile ? createImageFile.name : "Nahrát obrázek"}</span>
            <input type="file" accept="image/png,image/jpeg" onChange={(event) => setCreateImageFile(event.target.files?.[0])} />
          </label>
          <div className="printSurfaceCreateFormActions">
            <button type="button" className="primaryButton" onClick={() => void handleCreateSubmit()} disabled={!createName.trim() || isCreating}>
              {isCreating ? "Vytvářím…" : "Vytvořit a otevřít editor"}
            </button>
            <button type="button" onClick={() => setShowCreateForm(false)} disabled={isCreating}>Zrušit</button>
          </div>
        </div>
      )}

      <div className="workflowCard printSurfaceDataStatusCard">
        <div className="workflowCardHeader">
          <div>
            <span>DATA TISKOVÝCH PLOCH</span>
            <strong>Katalog realizaček a presetů</strong>
          </div>
        </div>
        <p className="fieldHint printSurfaceDataStatus">
          Realizačky: {companies.length} · Presety: {presets.length} · Výrobní rozměry: {productionDimensions.length}
          {presets.length === 0 && " — Rozměry tiskových ploch zatím nejsou importovány."}
        </p>
        <PrintSurfaceCatalogImportPanel
          companyRepository={companyRepository}
          presetRepository={presetRepository}
          productionDimensionRepository={productionDimensionRepository}
          hasExistingData={companies.length > 0 || presets.length > 0}
          onImported={reloadCatalog}
        />
      </div>

      <div className="adminFilters printSurfaceProjectFilters">
        <input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Hledat projekt nebo firmu…" />
        <select value={eventFilter} onChange={(event) => setEventFilter(event.target.value)}>
          <option value="">Všechny eventy</option>
          {events.map((event) => <option key={event.id} value={event.id}>{event.name}</option>)}
        </select>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
          <option value="">Všechny stavy</option>
          <option value="draft">Rozpracováno</option>
          <option value="ready">Připraveno</option>
          <option value="sent">Odesláno</option>
        </select>
      </div>

      {listError && <p className="uploadError">{listError}</p>}
      {!projects && !listError && <p className="workspaceEmpty">Načítám projekty…</p>}
      {projects && projects.length === 0 && <p className="workspaceEmpty">Zatím není vytvořený žádný projekt tiskových ploch.</p>}
      {projects && projects.length > 0 && filteredProjects.length === 0 && <p className="workspaceEmpty">Filtrům neodpovídá žádný projekt.</p>}

      {filteredProjects.length > 0 && (
        <div className="printSurfaceTable printSurfaceProjectTable">
          <div className="printSurfaceProjectRow printSurfaceTableHeader">
            <span>Projekt / firma</span>
            <span>Event</span>
            <span>Realizačka</span>
            <span>Ploch</span>
            <span>Stav</span>
            <span>Odesláno</span>
            <span>Vytvořil</span>
            <span>Poslední změna</span>
            <span>PDF</span>
          </div>
          {filteredProjects.map((project) => (
            <div key={project.id} className="printSurfaceProjectRow" onClick={() => onOpenProject(project.id)}>
              <span><strong>{project.name}</strong><br /><span className="fieldHint">{project.companyName || "—"}</span></span>
              <span>{eventName(project.eventId)}</span>
              <span>{companyName(project.realizationCompanyId)}</span>
              <span>{project.itemCount}</span>
              <span><strong className={`stageBadge ${project.status}`}>{STATUS_LABELS[project.status]}</strong></span>
              <span>{project.sentAt ? new Date(project.sentAt).toLocaleDateString("cs-CZ") : "—"}</span>
              <span>{project.createdBy ?? "—"}</span>
              <span>{new Date(project.updatedAt).toLocaleString("cs-CZ")}</span>
              <span className="printSurfaceProjectPdfCell">
                {project.latestPdf ? (
                  <>
                    <span className="printSurfacePdfBadge neutral">PDF připraveno</span>
                    <button type="button" className="textButton" onClick={(event) => { event.stopPropagation(); void handleDownloadPdf(project.latestPdf!.storageKey, project.latestPdf!.fileName); }}>Stáhnout PDF</button>
                  </>
                ) : (
                  <span className="printSurfacePdfBadge neutral">PDF nevygenerováno</span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
