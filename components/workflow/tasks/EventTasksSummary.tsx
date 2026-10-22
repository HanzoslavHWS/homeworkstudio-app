"use client";

import { eventTaskOverview, localIsoDate, TASK_STATUS_LABELS, type Task } from "../../../domain/tasks";

function formatDue(task: Task): string {
  if (!task.dueDate) return "bez termínu";
  const [year, month, day] = task.dueDate.split("-");
  return `${Number(day)}. ${Number(month)}. ${year}`;
}

/**
 * "Úkoly" overview on an event's detail: ALL open tasks of the event (manual or automatic, any due
 * date or none), the date buckets (Po termínu / Dnes / Tento týden) and the waiting/review states,
 * the nearest open tasks, and a link to the event's filtered task list. Tasks of other events never
 * appear (filtered by eventId).
 */
export function EventTasksSummary({
  tasks,
  eventId,
  onShowEventTasks,
  onOpenTask,
}: {
  tasks: readonly Task[] | null;
  eventId: string;
  onShowEventTasks: (eventId: string) => void;
  /** Opens a task's detail; without it the list is read-only. */
  onOpenTask?: (taskId: string) => void;
}) {
  const overview = eventTaskOverview(tasks ?? [], eventId, localIsoDate());
  const { counts } = overview;
  return (
    <section className="eventTasksSummary" aria-label="Úkoly akce">
      <strong>Úkoly</strong>
      {!tasks ? (
        <span className="fieldHint">Načítám…</span>
      ) : (
        <dl>
          <div><dt>Nesplněné</dt><dd>{overview.openCount}</dd></div>
          <div className={counts.overdue > 0 ? "danger" : undefined}><dt>Po termínu</dt><dd>{counts.overdue}</dd></div>
          <div><dt>Dnes</dt><dd>{counts.today}</dd></div>
          <div><dt>Tento týden</dt><dd>{counts.thisWeek}</dd></div>
          <div><dt>Čekáme</dt><dd>{counts.waiting}</dd></div>
          <div><dt>Ke kontrole</dt><dd>{counts.review}</dd></div>
        </dl>
      )}
      <button type="button" onClick={() => onShowEventTasks(eventId)}>Zobrazit úkoly akce</button>
      {tasks && (
        <div className="eventTasksList">
          <small className="fieldHint">Všechny nesplněné úkoly této akce — ruční i automatické, s termínem i bez něj (nejbližší nahoře).</small>
          {overview.nextOpen.length === 0 ? (
            <span className="fieldHint">Žádné nesplněné úkoly.</span>
          ) : (
            <ul>
              {overview.nextOpen.map((task) => (
                <li key={task.id}>
                  {onOpenTask ? <button type="button" className="linkButton" onClick={() => onOpenTask(task.id)}>{task.title}</button> : <span>{task.title}</span>}
                  <small> · {formatDue(task)} · {TASK_STATUS_LABELS[task.status]}{task.standNumber ? ` · stánek ${task.standNumber}` : ""}</small>
                </li>
              ))}
            </ul>
          )}
          {overview.openCount > overview.nextOpen.length && <small className="fieldHint">a další {overview.openCount - overview.nextOpen.length} — „Zobrazit úkoly akce“</small>}
        </div>
      )}
    </section>
  );
}
