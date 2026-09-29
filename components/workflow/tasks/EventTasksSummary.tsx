"use client";

import { computeTaskCounts, localIsoDate, tasksForEvent, type Task } from "../../../domain/tasks";

/** Small "Úkoly" overview on an event's detail (Po termínu / Dnes / Čekáme / Ke kontrole) + a link to the event's filtered task list. */
export function EventTasksSummary({
  tasks,
  eventId,
  onShowEventTasks,
}: {
  tasks: readonly Task[] | null;
  eventId: string;
  onShowEventTasks: (eventId: string) => void;
}) {
  const counts = computeTaskCounts(tasksForEvent(tasks ?? [], eventId), localIsoDate());
  return (
    <section className="eventTasksSummary" aria-label="Úkoly akce">
      <strong>Úkoly</strong>
      {!tasks ? (
        <span className="fieldHint">Načítám…</span>
      ) : (
        <dl>
          <div className={counts.overdue > 0 ? "danger" : undefined}><dt>Po termínu</dt><dd>{counts.overdue}</dd></div>
          <div><dt>Dnes</dt><dd>{counts.today}</dd></div>
          <div><dt>Čekáme</dt><dd>{counts.waiting}</dd></div>
          <div><dt>Ke kontrole</dt><dd>{counts.review}</dd></div>
        </dl>
      )}
      <button type="button" onClick={() => onShowEventTasks(eventId)}>Zobrazit úkoly akce</button>
    </section>
  );
}
