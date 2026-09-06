"use client";

import { useEffect, useState } from "react";
import {
  addPrintSurfaceItem,
  createPrintSurfaceProject,
  findPrintSurfaceItem,
  movePrintSurfaceItem,
  removePrintSurfaceItem,
  updatePrintSurfaceItem,
  updatePrintSurfaceItemType,
  withImage,
  withItems,
  withProjectFields,
  type PrintSurfaceProject,
  type PrintSurfaceProjectImage,
} from "../../domain/printSurfaceProject";
import { PRINT_SURFACE_TYPES, type PrintSurfaceTypeId } from "../../domain/printSurfaceTypeCatalog";
import { resolvePrintSurfaceProductionDimension, type PrintSurfaceProductionDimension } from "../../domain/printSurfaceProductionDimension";
import type { PrintSurfacePreset } from "../../domain/printSurfacePreset";
import type { RealizationCompany } from "../../domain/realizationCompany";
import type { PrintSurfaceProjectRepository } from "../../lib/db/printSurfaceProjectRepository";
import type { RealizationCompanyRepository } from "../../domain/realizationCompany";
import type { PrintSurfacePresetRepository } from "../../domain/printSurfacePreset";
import type { PrintSurfaceProductionDimensionRepository } from "../../domain/printSurfaceProductionDimension";
import type { Exhibition } from "../../domain/organizations";
import { PrintSurfaceCanvas } from "./printSurfaces/PrintSurfaceCanvas";
import { PrintSurfaceInspector } from "./printSurfaces/PrintSurfaceInspector";
import { PrintSurfaceList } from "./printSurfaces/PrintSurfaceList";

/**
 * "Tiskové plochy" — standalone MVP workflow (spec: click an image to drop lettered markers,
 * tag each with a print-surface type). Deliberately independent of BoothGenerator's own project
 * state, same as EmailsPage: it owns 100% of its local state and only receives cross-cutting
 * data (events) + its repositories as props. `selectedItemId` here is the SINGLE source of truth
 * shared by both PrintSurfaceCanvas and PrintSurfaceList (section 8) — neither owns its own copy.
 *
 * Phase 2 (realizačky/presety/produkční rozměry): a marker's actual production SIZE is NEVER
 * stored on the item — it's always resolved fresh from (project.realizationCompanyId,
 * item.presetId) via resolvePrintSurfaceProductionDimension, so changing the project's realizačka
 * automatically updates every displayed dimension without touching any marker data.
 */
export function PrintSurfacesPage({
  repository,
  companyRepository,
  presetRepository,
  productionDimensionRepository,
  events,
}: {
  repository: PrintSurfaceProjectRepository;
  companyRepository: RealizationCompanyRepository;
  presetRepository: PrintSurfacePresetRepository;
  productionDimensionRepository: PrintSurfaceProductionDimensionRepository;
  events: readonly Exhibition[];
}) {
  const [project, setProject] = useState<PrintSurfaceProject | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | undefined>(undefined);
  const [activeTool, setActiveTool] = useState<"select" | PrintSurfaceTypeId>("select");
  const [uploadError, setUploadError] = useState("");
  const [persistError, setPersistError] = useState("");
  const [companies, setCompanies] = useState<readonly RealizationCompany[]>([]);
  const [presets, setPresets] = useState<readonly PrintSurfacePreset[]>([]);
  const [productionDimensions, setProductionDimensions] = useState<readonly PrintSurfaceProductionDimension[]>([]);

  useEffect(() => {
    let cancelled = false;
    repository.load().then((loaded) => {
      if (cancelled) return;
      setProject(loaded ?? createPrintSurfaceProject({ name: "", companyName: "" }));
    });
    return () => { cancelled = true; };
  }, [repository]);

  useEffect(() => {
    let cancelled = false;
    companyRepository.list().then((loaded) => { if (!cancelled) setCompanies(loaded); });
    return () => { cancelled = true; };
  }, [companyRepository]);

  useEffect(() => {
    let cancelled = false;
    presetRepository.list().then((loaded) => { if (!cancelled) setPresets(loaded); });
    return () => { cancelled = true; };
  }, [presetRepository]);

  useEffect(() => {
    let cancelled = false;
    productionDimensionRepository.list().then((loaded) => { if (!cancelled) setProductionDimensions(loaded); });
    return () => { cancelled = true; };
  }, [productionDimensionRepository]);

  useEffect(() => {
    if (!project) return;
    const timeout = window.setTimeout(() => {
      repository.save(project).catch((error) => {
        setPersistError(error instanceof Error ? error.message : "Uložení se nezdařilo.");
      });
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [project, repository]);

  if (!project) {
    return (
      <div className="workspacePage">
        <p className="workspaceEmpty">Načítám…</p>
      </div>
    );
  }

  const selectedItem = findPrintSurfaceItem(project.items, selectedItemId);
  const selectedItemResolution = resolvePrintSurfaceProductionDimension(
    { realizationCompanyId: project.realizationCompanyId, presetId: selectedItem?.presetId },
    productionDimensions,
  );
  const activeCompanies = companies.filter((company) => company.isActive);

  function updateProjectFields(fields: Parameters<typeof withProjectFields>[1]) {
    setProject((current) => (current ? withProjectFields(current, fields) : current));
  }

  function handleUploadImage(image: PrintSurfaceProjectImage) {
    setProject((current) => (current ? withImage(current, image) : current));
  }

  function handleCreateItemAt(xNormalized: number, yNormalized: number) {
    if (activeTool === "select") return;
    setProject((current) => {
      if (!current) return current;
      const { project: nextProject, item } = addPrintSurfaceItem(current, { typeId: activeTool, xNormalized, yNormalized });
      setSelectedItemId(item.id);
      return nextProject;
    });
  }

  function handleMoveItem(id: string, xNormalized: number, yNormalized: number) {
    setProject((current) => (current ? withItems(current, movePrintSurfaceItem(current.items, id, xNormalized, yNormalized)) : current));
  }

  function handleSelectItem(id: string | undefined) {
    setSelectedItemId(id);
  }

  function handleDeleteItem(id: string) {
    setProject((current) => (current ? withItems(current, removePrintSurfaceItem(current.items, id)) : current));
    setSelectedItemId((current) => (current === id ? undefined : current));
  }

  function handleChangeSelectedLabel(label: string) {
    if (!selectedItem) return;
    setProject((current) => (current ? withItems(current, updatePrintSurfaceItem(current.items, selectedItem.id, { label })) : current));
  }

  function handleChangeSelectedType(typeId: PrintSurfaceTypeId) {
    if (!selectedItem) return;
    setProject((current) => (current ? withItems(current, updatePrintSurfaceItemType(current.items, selectedItem.id, typeId, presets)) : current));
  }

  function handleChangeSelectedPreset(presetId: string | undefined) {
    if (!selectedItem) return;
    setProject((current) => (current ? withItems(current, updatePrintSurfaceItem(current.items, selectedItem.id, { presetId })) : current));
  }

  function handleChangeSelectedNote(note: string) {
    if (!selectedItem) return;
    setProject((current) => (current ? withItems(current, updatePrintSurfaceItem(current.items, selectedItem.id, { note })) : current));
  }

  return (
    <div className="workspacePage">
      <div className="workspacePageHeader">
        <div>
          <span className="eyebrow">TISKOVÉ PLOCHY</span>
          <h1>Tiskové plochy</h1>
        </div>
      </div>

      {persistError && <p className="uploadError persistenceBanner">{persistError}</p>}

      <div className="workspaceFormRow">
        <label>
          <span>Název projektu</span>
          <input value={project.name} onChange={(event) => updateProjectFields({ name: event.target.value })} placeholder="např. Stánek XY 2026" />
        </label>
        <label>
          <span>Firma / zákazník</span>
          <input value={project.companyName} onChange={(event) => updateProjectFields({ companyName: event.target.value })} />
        </label>
        <label>
          <span>Veletrh</span>
          <select value={project.eventId ?? ""} onChange={(event) => updateProjectFields({ eventId: event.target.value || undefined })}>
            <option value="">— Bez veletrhu —</option>
            {events.map((event) => (
              <option key={event.id} value={event.id}>{event.name}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Realizačka</span>
          <select value={project.realizationCompanyId ?? ""} onChange={(event) => updateProjectFields({ realizationCompanyId: event.target.value || undefined })}>
            <option value="">— Bez realizačky —</option>
            {activeCompanies.map((company) => (
              <option key={company.id} value={company.id}>{company.name}</option>
            ))}
          </select>
        </label>
      </div>

      <p className="fieldHint printSurfaceDataStatus">
        Realizačky: {companies.length} · Tiskové plochy (presety): {presets.length} · Výrobní rozměry: {productionDimensions.length}
        {productionDimensions.length === 0 && " — Rozměry tiskových ploch zatím nejsou importovány."}
      </p>

      <div className="adminCategoryTabs printSurfaceToolbar">
        <button type="button" className={activeTool === "select" ? "active" : ""} onClick={() => setActiveTool("select")}>
          Výběr
        </button>
        {PRINT_SURFACE_TYPES.map((type) => (
          <button key={type.id} type="button" className={activeTool === type.id ? "active" : ""} onClick={() => setActiveTool(type.id)}>
            {type.labelCz}
          </button>
        ))}
      </div>

      <div className="printSurfacesWorkspace">
        <PrintSurfaceCanvas
          image={project.image}
          items={project.items}
          selectedItemId={selectedItemId}
          activeTool={activeTool}
          uploadError={uploadError}
          onSelectItem={handleSelectItem}
          onCreateItemAt={handleCreateItemAt}
          onMoveItem={handleMoveItem}
          onUploadImage={handleUploadImage}
          onUploadError={setUploadError}
        />
        <PrintSurfaceInspector
          item={selectedItem}
          presets={presets}
          productionDimensionResolution={selectedItemResolution}
          onChangeLabel={handleChangeSelectedLabel}
          onChangeType={handleChangeSelectedType}
          onChangePreset={handleChangeSelectedPreset}
          onChangeNote={handleChangeSelectedNote}
          onDelete={() => selectedItem && handleDeleteItem(selectedItem.id)}
        />
      </div>

      <PrintSurfaceList
        items={project.items}
        selectedItemId={selectedItemId}
        presets={presets}
        productionDimensions={productionDimensions}
        realizationCompanyId={project.realizationCompanyId}
        onSelectItem={handleSelectItem}
        onDeleteItem={handleDeleteItem}
      />
    </div>
  );
}
