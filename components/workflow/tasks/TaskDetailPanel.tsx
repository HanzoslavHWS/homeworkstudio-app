"use client";

import { useEffect, useState } from "react";
import {
  describeDue,
  describeHistoryEntry,
  formatShortDate,
  formatWaitingDays,
  localIsoDate,
  TASK_PRIORITY_LABELS,
  TASK_SOURCE_OPEN_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  waitingDays,
  type Task,
  type TaskHistoryEntry,
  type TaskStatus,
} from "../../../domain/tasks";
import type { TaskStore } from "./useTaskStore";
import { categoryLabel, eventLabel, realizationLabel, type TaskLookups } from "./TaskRow";

/**
 * Task detail as a right-hand side panel (not a modal) so the list stays visible. Status can be
 * changed in place; "Ke kontrole" tasks get Schválit ✓ / Vrátit zpět (with a required note).
 * History is loaded fresh from the server each time the panel opens or the task changes.
 */
export function TaskDetailPanel({
  task,
  store,
  lookups,
  onClose,
  onEdit,
  onOpenSource,
}: {
  task: Task;
  store: TaskStore;
  lookups: TaskLookups;
  onClose: () => void;
  onEdit: (task: Task) => void;
  onOpenSource?: (task: Task) => void;
}) {
  const [history, setHistory] = useState<readonly TaskHistoryEntry[] | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [returnNote, setReturnNote] = useState("");
  const [showReturn, setShowReturn] = useState(false);
  const today = localIsoDate();

  useEffect(() => {
    let cancelled = false;
    setHistory(null);
    setHistoryError("");
    store.client.history(task.id)
      .then((entries) => { if (!cancelled) setHistory(entries); })
      .catch((loadError) => { if (!cancelled) setHistoryError(loadError instanceof Error ? loadError.message : "Historii se nepodařilo načíst."); });
    return () => { cancelled = true; };
  }, [store.client, task.id, task.updatedAt]);

  useEffect(() => {
    setShowReturn(false);
    setReturnNote("");
    setError("");
  }, [task.id]);

  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Akce se nezdařila.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Opravdu smazat úkol „${task.title}“?`)) return;
    await run(async () => { await store.remove(task.id); onClose(); });
  }

  const waiting = task.status === "waiting" ? waitingDays(task, today) : undefined;
  const linked = [eventLabel(lookups, task.eventId), task.standNumber, task.companyName, realizationLabel(lookups, task.realizationCompanyId)].filter(Boolean);

  return (
    <aside className="taskDetailPanel" aria-label={`Detail úkolu ${task.title}`} onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
      <div className="taskDetailHeader">
        <span className="taskDetailKind">{task.isAutomatic ? "AUTOMATICKÝ ÚKOL" : "MANUÁLNÍ ÚKOL"}</span>
        <button type="button" className="taskDetailClose" onClick={onClose} aria-label="Zavřít detail úkolu">×</button>
      </div>
      <h2 className="taskDetailTitle">{task.title}</h2>
      {task.description && <p className="taskDetailDescription">{task.description}</p>}

      <dl className="taskDetailFields">
        <dt>Stav</dt>
        <dd>
          <select value={task.status} disabled={busy} aria-label="Stav úkolu" onChange={(event) => void run(() => store.setStatus(task.id, event.target.value as TaskStatus))}>
            {TASK_STATUSES.map((status) => <option key={status} value={status}>{TASK_STATUS_LABELS[status]}</option>)}
          </select>
        </dd>
        <dt>Termín</dt>
        <dd>{describeDue(task, today) ?? "Bez termínu"}</dd>
        <dt>Priorita</dt>
        <dd className={`priority-${task.priority}`}>{TASK_PRIORITY_LABELS[task.priority]}</dd>
        <dt>Kategorie</dt>
        <dd>{categoryLabel(lookups, task.categoryId) ?? "—"}</dd>
        <dt>Odpovědná osoba</dt>
        <dd>{task.assigneeName ?? "—"}</dd>
        {task.status === "waiting" && (
          <>
            <dt>Čekáme od</dt>
            <dd>{task.waitingSince ? `${formatShortDate(task.waitingSince, today)} · ${formatWaitingDays(waiting ?? 0)}` : "—"}</dd>
          </>
        )}
        <dt>Vytvořeno</dt>
        <dd>{new Date(task.createdAt).toLocaleString("cs-CZ")}{task.createdBy ? ` · ${task.createdBy}` : ""}</dd>
        {task.completedAt && (
          <>
            <dt>Dokončeno</dt>
            <dd>{new Date(task.completedAt).toLocaleString("cs-CZ")}</dd>
          </>
        )}
      </dl>

      {(linked.length > 0 || (task.sourceType !== "manual" && task.sourceId)) && (
        <div className="taskDetailSection">
          <h3>NAVÁZÁNO NA</h3>
          {linked.map((line) => <p key={line}>{line}</p>)}
          {task.sourceType !== "manual" && task.sourceId && onOpenSource && (
            <button type="button" onClick={() => onOpenSource(task)}>{TASK_SOURCE_OPEN_LABELS[task.sourceType]}</button>
          )}
        </div>
      )}

      {task.status === "review" && (
        <div className="taskDetailSection taskDetailReview">
          <h3>KE KONTROLE</h3>
          <div className="taskDetailActions">
            <button type="button" className="primaryButton" disabled={busy} onClick={() => void run(() => store.approve(task.id))}>Schválit ✓</button>
            <button type="button" disabled={busy} onClick={() => setShowReturn((value) => !value)}>Vrátit zpět</button>
          </div>
          {showReturn && (
            <form className="taskDetailReturn" onSubmit={(event) => { event.preventDefault(); void run(async () => { await store.returnForRework(task.id, returnNote); setShowReturn(false); setReturnNote(""); }); }}>
              <label>
                <span>Co je potřeba opravit</span>
                <textarea rows={2} value={returnNote} onChange={(event) => setReturnNote(event.target.value)} disabled={busy} />
              </label>
              <button type="submit" disabled={busy || !returnNote.trim()}>Vrátit s poznámkou</button>
            </form>
          )}
        </div>
      )}

      {error && <p className="uploadError" role="alert">{error}</p>}

      <div className="taskDetailActions">
        <button type="button" onClick={() => onEdit(task)} disabled={busy}>Upravit</button>
        <button type="button" className="dangerText" onClick={() => void handleDelete()} disabled={busy}>Smazat</button>
      </div>

      <div className="taskDetailSection">
        <h3>HISTORIE ZMĚN</h3>
        {historyError && <p className="uploadError">{historyError}</p>}
        {!history && !historyError && <p className="fieldHint">Načítám…</p>}
        {history && history.length === 0 && <p className="fieldHint">Zatím bez historie.</p>}
        {history && history.length > 0 && (
          <ol className="taskHistory">
            {history.map((entry) => (
              <li key={entry.id}>
                <span>{formatShortDate(localIsoDate(new Date(entry.createdAt)), today)}</span>
                <span>
                  {describeHistoryEntry(entry)}
                  {entry.note && <em> — {entry.note}</em>}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </aside>
  );
}
