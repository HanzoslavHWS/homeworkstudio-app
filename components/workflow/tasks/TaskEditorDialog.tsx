"use client";

import { useState } from "react";
import {
  buildTaskFilterOptions,
  DUE_PRESETS,
  DUE_PRESET_LABELS,
  localIsoDate,
  normalizeTaskInput,
  resolveDuePreset,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  TASK_SOURCE_OPEN_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  type Task,
  type TaskInput,
  type TaskPriority,
  type TaskStatus,
} from "../../../domain/tasks";
import type { TaskStore } from "./useTaskStore";
import { eventLabel, type TaskLookups } from "./TaskRow";

/**
 * "+ Úkol" / "Upravit úkol" — one compact modal (reuses .adminModalOverlay/.adminModalCard).
 * Pre-filled from the context it was opened from (event, company, stand, realizačka, source), so a
 * task created from a stand only needs a title and a due date. Enter saves, Escape closes.
 */
export function TaskEditorDialog({
  store,
  lookups,
  initial,
  taskId,
  onClose,
  onSaved,
}: {
  store: TaskStore;
  lookups: TaskLookups;
  initial: TaskInput;
  /** Set when editing an existing task. */
  taskId?: string;
  onClose: () => void;
  onSaved?: (task: Task) => void;
}) {
  const [draft, setDraft] = useState<TaskInput>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const today = localIsoDate();
  const options = buildTaskFilterOptions(store.tasks ?? []);
  const activeCategories = lookups.categories.filter((category) => category.isActive || category.id === draft.categoryId);

  function patch(update: Partial<TaskInput>) {
    setDraft((current) => ({ ...current, ...update }));
  }

  async function handleSubmit() {
    if (saving) return;
    const validation = normalizeTaskInput(draft);
    if (validation.ok === false) { setError(validation.message); return; }
    setSaving(true);
    setError("");
    try {
      const saved = taskId ? await store.update(taskId, draft) : await store.create(draft);
      onSaved?.(saved);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Úkol se nepodařilo uložit.");
    } finally {
      setSaving(false);
    }
  }

  const sourceLabel = draft.sourceType && draft.sourceType !== "manual" ? TASK_SOURCE_OPEN_LABELS[draft.sourceType].replace("Otevřít ", "") : undefined;

  return (
    <div
      className="adminModalOverlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="taskEditorTitle"
      onClick={() => { if (!saving) onClose(); }}
      onKeyDown={(event) => { if (event.key === "Escape" && !saving) onClose(); }}
    >
      <form
        className="adminModalCard taskEditorDialog"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => { event.preventDefault(); void handleSubmit(); }}
      >
        <h2 id="taskEditorTitle">{taskId ? "Upravit úkol" : "Nový úkol"}</h2>
        {(draft.eventId || draft.companyName || draft.standNumber || sourceLabel) && (
          <p className="taskEditorContext">
            Navázáno na: {[eventLabel(lookups, draft.eventId), draft.standNumber, draft.companyName, sourceLabel].filter(Boolean).join(" · ")}
          </p>
        )}

        <label className="taskEditorTitleField">
          <span>Název</span>
          <input autoFocus value={draft.title} onChange={(event) => patch({ title: event.target.value })} placeholder="např. Zkontrolovat grafiku panelů A–F" disabled={saving} />
        </label>

        <div className="taskEditorDue">
          <span className="taskEditorLabel">Termín</span>
          <div className="taskEditorPresets" role="group" aria-label="Rychlý termín">
            {DUE_PRESETS.map((preset) => {
              const value = resolveDuePreset(preset, today);
              const active = (draft.dueDate ?? undefined) === value;
              return (
                <button key={preset} type="button" className={active ? "active" : undefined} aria-pressed={active} onClick={() => patch({ dueDate: value, dueTime: value ? draft.dueTime : undefined })} disabled={saving}>
                  {DUE_PRESET_LABELS[preset]}
                </button>
              );
            })}
          </div>
          <div className="taskEditorDueInputs">
            <input type="date" aria-label="Datum termínu" value={draft.dueDate ?? ""} onChange={(event) => patch({ dueDate: event.target.value || undefined, dueTime: event.target.value ? draft.dueTime : undefined })} disabled={saving} />
            <input type="time" aria-label="Čas termínu (volitelně)" value={draft.dueTime ?? ""} onChange={(event) => patch({ dueTime: event.target.value || undefined })} disabled={saving || !draft.dueDate} />
          </div>
        </div>

        <div className="taskEditorPriority">
          <span className="taskEditorLabel">Priorita</span>
          <div className="taskEditorPresets" role="radiogroup" aria-label="Priorita">
            {TASK_PRIORITIES.map((priority) => (
              <button key={priority} type="button" role="radio" aria-checked={(draft.priority ?? "normal") === priority} className={(draft.priority ?? "normal") === priority ? `active priority-${priority}` : undefined} onClick={() => patch({ priority: priority as TaskPriority })} disabled={saving}>
                {TASK_PRIORITY_LABELS[priority]}
              </button>
            ))}
          </div>
        </div>

        <div className="taskEditorGrid">
          <label>
            <span>Stav</span>
            <select value={draft.status ?? "new"} onChange={(event) => patch({ status: event.target.value as TaskStatus })} disabled={saving}>
              {TASK_STATUSES.map((status) => <option key={status} value={status}>{TASK_STATUS_LABELS[status]}</option>)}
            </select>
          </label>
          <label>
            <span>Kategorie</span>
            <select value={draft.categoryId ?? ""} onChange={(event) => patch({ categoryId: event.target.value || undefined })} disabled={saving}>
              <option value="">— Bez kategorie —</option>
              {activeCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
            </select>
          </label>
          <label>
            <span>Odpovědná osoba</span>
            <input list="taskAssigneeOptions" value={draft.assigneeName ?? ""} onChange={(event) => patch({ assigneeName: event.target.value })} placeholder="Jméno" disabled={saving} />
            <datalist id="taskAssigneeOptions">{options.assignees.map((name) => <option key={name} value={name} />)}</datalist>
          </label>
          {draft.status === "waiting" && (
            <label>
              <span>Čekáme od</span>
              <input type="date" value={draft.waitingSince ?? ""} onChange={(event) => patch({ waitingSince: event.target.value || undefined })} disabled={saving} />
            </label>
          )}
          <label>
            <span>Akce / veletrh</span>
            <select value={draft.eventId ?? ""} onChange={(event) => patch({ eventId: event.target.value || undefined })} disabled={saving}>
              <option value="">— Bez akce —</option>
              {lookups.events.map((event) => <option key={event.id} value={event.id}>{eventLabel(lookups, event.id)}</option>)}
              {draft.eventId && !lookups.events.some((event) => event.id === draft.eventId) && <option value={draft.eventId}>{draft.eventId}</option>}
            </select>
          </label>
          <label>
            <span>Firma</span>
            <input list="taskCompanyOptions" value={draft.companyName ?? ""} onChange={(event) => patch({ companyName: event.target.value })} disabled={saving} />
            <datalist id="taskCompanyOptions">{options.companies.map((name) => <option key={name} value={name} />)}</datalist>
          </label>
          <label>
            <span>Číslo stánku</span>
            <input value={draft.standNumber ?? ""} onChange={(event) => patch({ standNumber: event.target.value })} placeholder="např. 3B24" disabled={saving} />
          </label>
          <label>
            <span>Realizačka</span>
            <select value={draft.realizationCompanyId ?? ""} onChange={(event) => patch({ realizationCompanyId: event.target.value || undefined })} disabled={saving}>
              <option value="">— Bez realizačky —</option>
              {lookups.realizationCompanies.filter((company) => company.isActive || company.id === draft.realizationCompanyId).map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
            </select>
          </label>
        </div>

        <label>
          <span>Poznámka</span>
          <textarea className="taskEditorDescription" rows={3} value={draft.description ?? ""} onChange={(event) => patch({ description: event.target.value })} disabled={saving} />
        </label>

        {error && <div className="adminModalError" role="alert">{error}</div>}
        <div className="adminModalActions taskEditorActions">
          <label className="taskActorField">
            <span>Zapisuje</span>
            <input value={store.actorName} onChange={(event) => store.setActorName(event.target.value)} placeholder="Vaše jméno" disabled={saving} />
          </label>
          <button type="button" onClick={onClose} disabled={saving}>Zrušit</button>
          <button type="submit" className="primaryButton" disabled={saving || !draft.title.trim()}>{saving ? "Ukládám…" : taskId ? "Uložit" : "Vytvořit úkol"}</button>
        </div>
      </form>
    </div>
  );
}
