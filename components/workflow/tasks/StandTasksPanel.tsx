"use client";

import { useEffect, useState } from "react";
import { isTaskOpen, localIsoDate, sortTasks, tasksForStand, type Task, type TaskContext } from "../../../domain/tasks";
import { resolveStandKey, type StandChecklist } from "../../../domain/standChecklist";
import type { TaskStore } from "./useTaskStore";
import { TaskRow, type TaskLookups } from "./TaskRow";

const RECENT_DONE_LIMIT = 3;

/**
 * "Úkoly N" + the readiness checklist on a stand's detail. A stand's tasks are the ones created from
 * this exact record OR linked to the same event + stand number. The checklist needs both the event
 * and the stand number (the cross-module stand identity) — without them it explains what's missing.
 */
export function StandTasksPanel({
  store,
  lookups,
  context,
  onCreateTask,
  onOpenTask,
}: {
  store: TaskStore;
  lookups: TaskLookups;
  context: TaskContext;
  onCreateTask: (context: TaskContext) => void;
  onOpenTask: (task: Task) => void;
}) {
  const [checklist, setChecklist] = useState<StandChecklist | null | undefined>(undefined);
  const [checklistError, setChecklistError] = useState("");
  const [busyKey, setBusyKey] = useState<string | undefined>(undefined);
  const [taskError, setTaskError] = useState("");
  const today = localIsoDate();
  const standKey = resolveStandKey(context.eventId, context.standNumber);
  const standKeyId = standKey ? `${standKey.eventId}|${standKey.standNumber}` : "";

  useEffect(() => {
    if (!standKey) { setChecklist(undefined); return; }
    let cancelled = false;
    setChecklistError("");
    store.client.checklist(standKey)
      .then((result) => { if (!cancelled) setChecklist(result); })
      .catch((error) => { if (!cancelled) setChecklistError(error instanceof Error ? error.message : "Checklist se nepodařilo načíst."); });
    return () => { cancelled = true; };
    // standKeyId is the stable identity of standKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.client, standKeyId]);

  const standTasks = tasksForStand(store.tasks ?? [], context);
  const open = sortTasks(standTasks.filter(isTaskOpen), "default", today);
  const recentDone = [...standTasks.filter((task) => task.status === "done")].sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? "")).slice(0, RECENT_DONE_LIMIT);

  async function toggleTask(task: Task) {
    setTaskError("");
    try {
      await store.setStatus(task.id, task.status === "done" ? "new" : "done");
    } catch (error) {
      setTaskError(error instanceof Error ? error.message : "Úkol se nepodařilo změnit.");
    }
  }

  async function toggleChecklistItem(itemKey: string, isDone: boolean) {
    if (!standKey || busyKey) return;
    setBusyKey(itemKey);
    setChecklistError("");
    try {
      setChecklist(await store.client.toggleChecklistItem(standKey, itemKey, isDone, store.actorName.trim() || undefined));
    } catch (error) {
      setChecklistError(error instanceof Error ? error.message : "Checklist se nepodařilo uložit.");
    } finally {
      setBusyKey(undefined);
    }
  }

  return (
    <section className="workflowCard standTasksPanel">
      <div className="workflowCardHeader">
        <div>
          <span>STÁNEK{context.standNumber ? ` ${context.standNumber}` : ""}</span>
          <strong>Úkoly {open.length}</strong>
        </div>
        <button type="button" onClick={() => onCreateTask(context)}>+ Přidat úkol</button>
      </div>

      {store.loadError && <p className="uploadError">{store.loadError}</p>}
      {taskError && <p className="uploadError" role="alert">{taskError}</p>}
      {store.tasks && open.length === 0 && recentDone.length === 0 && <p className="fieldHint">Ke stánku zatím nejsou žádné úkoly.</p>}
      {(open.length > 0 || recentDone.length > 0) && (
        <div className="taskList compact" role="list">
          {[...open, ...recentDone].map((task) => (
            <TaskRow key={task.id} task={task} today={today} lookups={lookups} onToggleDone={(item) => void toggleTask(item)} onOpen={onOpenTask} />
          ))}
        </div>
      )}

      <div className="standChecklist">
        <h3>
          CHECKLIST PŘIPRAVENOSTI
          {checklist && <span>{checklist.doneCount} / {checklist.totalCount}</span>}
        </h3>
        {!standKey && <p className="fieldHint">Checklist se zobrazí po vyplnění veletrhu a čísla stánku.</p>}
        {checklistError && <p className="uploadError">{checklistError}</p>}
        {standKey && checklist === undefined && !checklistError && <p className="fieldHint">Načítám…</p>}
        {standKey && checklist === null && <p className="fieldHint">Pro tuto akci není nastavená šablona checklistu.</p>}
        {checklist && (
          <ul>
            {checklist.items.map((item) => (
              <li key={item.key}>
                <label className={item.isDone ? "done" : undefined}>
                  <input type="checkbox" checked={item.isDone} disabled={busyKey === item.key} onChange={(event) => void toggleChecklistItem(item.key, event.target.checked)} />
                  <span>{item.label}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
