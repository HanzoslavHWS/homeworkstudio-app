"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  withoutTechnicalRasterProject,
  type TechnicalRasterProjectRepository,
  type TechnicalRasterProjectSummary,
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

  const [deletingId, setDeletingId] = useState<string | undefined>(undefined);
  const [deleteError, setDeleteError] = useState("");

  // The "⋯" menu (spec batch 6, UI section 35-39). ROOT CAUSE of it being invisible before this
  // batch: this table reuses .printSurfaceTable, which sets `overflow: hidden` (shared with
  // PrintSurfaceProjectListPage.tsx / PrintSurfaceList.tsx — needed there so the table's own
  // rounded corners clip row backgrounds correctly, so it can't just be removed). The menu's
  // popup list was `position: absolute` inside that same clipped container, so it rendered into
  // the DOM but was always visually clipped away — the "⋯" trigger button itself was visible, but
  // clicking it never showed anything. Fixed by rendering the popup through a PORTAL into
  // document.body with `position: fixed`, positioned from the trigger's own getBoundingClientRect()
  // — entirely outside the clipped ancestor, and immune to it regardless of scroll/zoom.
  const [openMenuProjectId, setOpenMenuProjectId] = useState<string | undefined>(undefined);
  const [menuAnchorRect, setMenuAnchorRect] = useState<DOMRect | undefined>(undefined);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const menuListRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!openMenuProjectId) return;
    function handleOutsideClick(event: MouseEvent) {
      const target = event.target as Node;
      if (menuListRef.current?.contains(target) || menuTriggerRef.current?.contains(target)) return;
      setOpenMenuProjectId(undefined);
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpenMenuProjectId(undefined);
    }
    window.addEventListener("mousedown", handleOutsideClick);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("mousedown", handleOutsideClick);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [openMenuProjectId]);

  function handleToggleMenu(event: React.MouseEvent<HTMLButtonElement>, projectId: string) {
    event.stopPropagation();
    if (openMenuProjectId === projectId) { setOpenMenuProjectId(undefined); return; }
    setMenuAnchorRect(event.currentTarget.getBoundingClientRect());
    setOpenMenuProjectId(projectId);
  }

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

  /**
   * Uses the existing, already-tested technical raster project delete() (repository -> /api/
   * technical-rasters/projects/delete -> SupabaseTechnicalRasterProjectRepository) — no new
   * backend path (spec batch 4, UI section 15/21). `deletingId` both drives the "Mazání…" pending
   * label AND guards against a double submit (re-entrant calls bail out immediately below). On
   * success the project is removed from the local list right away (spec section 19: "okamžitě
   * zmizí"); on failure it stays, and reloadProjects() re-syncs with the backend either way so a
   * stale local list (e.g. from another tab) never lingers.
   */
  async function handleDeleteProject(project: TechnicalRasterProjectSummary) {
    if (deletingId) return;
    if (!window.confirm(`Opravdu chcete smazat projekt „${project.name}“?\n\nProjekt a jeho uložená data budou odstraněny.`)) return;
    setOpenMenuProjectId(undefined);
    setDeletingId(project.id);
    setDeleteError("");
    try {
      await projectRepository.delete(project.id);
      setProjects((current) => (current ? withoutTechnicalRasterProject(current, project.id) : current));
      reloadProjects();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Projekt se nepodařilo smazat.");
    } finally {
      setDeletingId(undefined);
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
      {deleteError && <p className="uploadError">{deleteError}</p>}
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
            <span>Nespárované</span>
            <span>Problémové</span>
            <span>Poslední změna</span>
            <span>Akce</span>
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
              <span onClick={(event) => event.stopPropagation()}>
                <button
                  type="button"
                  className="technicalRasterProjectRowMenuTrigger"
                  aria-label={`Další akce – ${project.name}`}
                  ref={(node) => { if (project.id === openMenuProjectId) menuTriggerRef.current = node; }}
                  onClick={(event) => handleToggleMenu(event, project.id)}
                >
                  ⋯
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      {openMenuProjectId && menuAnchorRect && typeof document !== "undefined" && createPortal(
        <div
          ref={menuListRef}
          className="technicalRasterProjectRowMenuList"
          style={{ position: "fixed", top: menuAnchorRect.bottom + 4, left: Math.max(8, menuAnchorRect.right - 150) }}
        >
          {(() => {
            const menuProject = projects?.find((candidate) => candidate.id === openMenuProjectId);
            if (!menuProject) return null;
            return (
              <button type="button" className="dangerText" disabled={deletingId === menuProject.id} onClick={() => void handleDeleteProject(menuProject)}>
                {deletingId === menuProject.id ? "Mazání…" : "Smazat projekt"}
              </button>
            );
          })()}
        </div>,
        document.body,
      )}
    </div>
  );
}
