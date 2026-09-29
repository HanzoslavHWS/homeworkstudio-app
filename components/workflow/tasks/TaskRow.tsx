"use client";

import type { Exhibition } from "../../../domain/organizations";
import type { RealizationCompany } from "../../../domain/realizationCompany";
import {
  describeDue,
  formatWaitingDays,
  isTaskOpen,
  taskDueBucket,
  TASK_PRIORITY_LABELS,
  TASK_STATUS_LABELS,
  waitingDays,
  type Task,
  type TaskCategory,
} from "../../../domain/tasks";

/** Names for the ids a task stores — resolved from data the generator already loaded. */
export type TaskLookups = Readonly<{
  events: readonly Exhibition[];
  categories: readonly TaskCategory[];
  realizationCompanies: readonly RealizationCompany[];
}>;

export function eventLabel(lookups: TaskLookups, eventId: string | undefined): string | undefined {
  if (!eventId) return undefined;
  const event = lookups.events.find((candidate) => candidate.id === eventId);
  return event ? `${event.name}${event.year && !event.name.includes(String(event.year)) ? ` ${event.year}` : ""}` : eventId;
}

export function categoryLabel(lookups: TaskLookups, categoryId: string | undefined): string | undefined {
  if (!categoryId) return undefined;
  return lookups.categories.find((category) => category.id === categoryId)?.name ?? categoryId;
}

export function realizationLabel(lookups: TaskLookups, id: string | undefined): string | undefined {
  if (!id) return undefined;
  return lookups.realizationCompanies.find((company) => company.id === id)?.name ?? id;
}

/**
 * One compact task line (spec section 13): checkbox, title, stand · company · event, category,
 * due, priority. Colors are used sparingly: red = overdue, orange = high/urgent priority,
 * green = done, grey = waiting — always together with a text label, never color alone.
 */
export function TaskRow({
  task,
  today,
  lookups,
  onToggleDone,
  onOpen,
  busy = false,
}: {
  task: Task;
  today: string;
  lookups: TaskLookups;
  onToggleDone: (task: Task) => void;
  onOpen: (task: Task) => void;
  busy?: boolean;
}) {
  const bucket = taskDueBucket(task, today);
  const done = task.status === "done";
  const context = [task.standNumber, task.companyName].filter(Boolean).join(" · ");
  const event = eventLabel(lookups, task.eventId);
  const category = categoryLabel(lookups, task.categoryId);
  const due = describeDue(task, today);
  const waiting = task.status === "waiting" ? waitingDays(task, today) : undefined;
  const className = [
    "taskRow",
    bucket === "overdue" ? "overdue" : "",
    done ? "done" : "",
    !isTaskOpen(task) ? "closed" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={className} role="listitem">
      <input
        type="checkbox"
        className="taskRowCheckbox"
        checked={done}
        disabled={busy || task.status === "cancelled"}
        aria-label={done ? `Vrátit úkol „${task.title}“ mezi nedokončené` : `Označit úkol „${task.title}“ jako hotový`}
        onChange={() => onToggleDone(task)}
      />
      <button type="button" className="taskRowMain" onClick={() => onOpen(task)}>
        <span className="taskRowTitle">
          {task.title}
          {task.isAutomatic && <span className="taskRowAuto" title="Automatický úkol">AUTO</span>}
        </span>
        <span className="taskRowContext">
          {context && <span>{context}</span>}
          {event && <span className="taskRowEvent">{event}</span>}
        </span>
      </button>
      <span className="taskRowCategory">{category ?? ""}</span>
      <span className={bucket === "overdue" ? "taskRowDue overdue" : "taskRowDue"}>
        {due ? (bucket === "overdue" ? `Po termínu · ${due}` : due) : "Bez termínu"}
      </span>
      <span className={`taskRowPriority priority-${task.priority}`}>{task.priority === "normal" ? "" : TASK_PRIORITY_LABELS[task.priority]}</span>
      <span className={`taskRowStatus status-${task.status}`}>
        {waiting !== undefined ? formatWaitingDays(waiting) : task.status === "new" ? "" : TASK_STATUS_LABELS[task.status]}
      </span>
      <span className="taskRowAssignee">{task.assigneeName ?? ""}</span>
    </div>
  );
}
