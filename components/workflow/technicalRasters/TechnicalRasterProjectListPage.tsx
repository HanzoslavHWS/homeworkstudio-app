"use client";

import { useEffect, useState } from "react";
import type {
  TechnicalRasterProjectRepository,
  TechnicalRasterProjectSummary,
} from "../../../domain/technicalRaster";
import type { Exhibition } from "../../../domain/organizations";

export function TechnicalRasterProjectListPage({
  projectRepository,
  events,
  onOpenProject,
}: {
  projectRepository: TechnicalRasterProjectRepository;
  events: readonly Exhibition[];
  onOpenProject: (id: string) => void;
}) {
  const [projects, setProjects] = useState<readonly TechnicalRasterProjectSummary[] | null>(null);
  const [listError, setListError] = useState("");

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createHall, setCreateHall] = useState("");
  const [createEventId, setCreateEventId] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  function reloadProjects() {
    projectRepository.list().then(setProjects).catch((error) => setListError(error instanceof Error ? error.message : "Projekty se nepodařilo načíst."));
  }

  useEffect(() => { reloadProjects(); }, [projectRepository]);

  function eventName(id: string | undefined): string {
    return events.find((event) => event.id === id)?.name ?? "—";
  }

  function openCreateForm() {
    setCreateName("");
    setCreateHall("");
    setCreateEventId("");
    setCreateError("");
    setShowCreateForm(true);
  }

  async function handleCreateSubmit() {
    const name = createName.trim();
    if (!name || isCreating) return;
    setIsCreating(true);
    setCreateError("");
    try {
      const project = await projectRepository.create({ name, hall: createHall.trim() || undefined, eventId: createEventId || undefined });
      setShowCreateForm(false);
      onOpenProject(project.id);
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
          <span className="eyebrow">TECHNICKÉ RASTRY</span>
          <h1>Technické rastry</h1>
        </div>
        <button type="button" className="primaryButton" onClick={openCreateForm}>+ Nový projekt</button>
      </div>

      {showCreateForm && (
        <div className="workflowCard printSurfaceCreateForm">
          <div className="workflowCardHeader">
            <div><span>NOVÝ PROJEKT</span><strong>Vytvořit technický rastr</strong></div>
          </div>
          {createError && <p className="uploadError">{createError}</p>}
          <div className="workspaceFormRow">
            <label><span>Název projektu</span><input value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder="např. FOR DECOR 2026 — Hala 1" /></label>
            <label><span>Hala</span><input value={createHall} onChange={(event) => setCreateHall(event.target.value)} placeholder="např. Hala 1" /></label>
            <label>
              <span>Veletrh</span>
              <select value={createEventId} onChange={(event) => setCreateEventId(event.target.value)}>
                <option value="">— Bez veletrhu —</option>
                {events.map((event) => <option key={event.id} value={event.id}>{event.name}</option>)}
              </select>
            </label>
          </div>
          <div className="printSurfaceCreateFormActions">
            <button type="button" className="primaryButton" onClick={() => void handleCreateSubmit()} disabled={!createName.trim() || isCreating}>
              {isCreating ? "Vytvářím…" : "Vytvořit a otevřít"}
            </button>
            <button type="button" onClick={() => setShowCreateForm(false)} disabled={isCreating}>Zrušit</button>
          </div>
        </div>
      )}

      {listError && <p className="uploadError">{listError}</p>}
      {!projects && !listError && <p className="workspaceEmpty">Načítám projekty…</p>}
      {projects && projects.length === 0 && <p className="workspaceEmpty">Zatím není vytvořený žádný projekt technického rastru.</p>}

      {projects && projects.length > 0 && (
        <div className="printSurfaceTable technicalRasterProjectTable">
          <div className="printSurfaceProjectRow printSurfaceTableHeader">
            <span>Projekt</span>
            <span>Hala</span>
            <span>Veletrh</span>
            <span>Rastr</span>
            <span>Stánků</span>
            <span>Nepřiřazené</span>
            <span>Problematické</span>
            <span>Poslední změna</span>
          </div>
          {projects.map((project) => (
            <div key={project.id} className="printSurfaceProjectRow" onClick={() => onOpenProject(project.id)}>
              <span><strong>{project.name}</strong></span>
              <span>{project.hall ?? "—"}</span>
              <span>{eventName(project.eventId)}</span>
              <span>{project.hasRaster ? "Nahraný" : "Chybí"}</span>
              <span>{project.standCount}</span>
              <span>{project.unassignedCount}</span>
              <span className={project.ambiguousCount > 0 ? "technicalStandBufferAmbiguousCount" : undefined}>{project.ambiguousCount}</span>
              <span>{new Date(project.updatedAt).toLocaleString("cs-CZ")}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
