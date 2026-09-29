"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyTaskFilters,
  buildTaskFilterOptions,
  buildTodayView,
  computeTaskCounts,
  EMPTY_TASK_FILTERS,
  hasActiveTaskFilters,
  localIsoDate,
  sortTasks,
  tasksForTab,
  taskToInput,
  TASK_DUE_FILTER_LABELS,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  TASK_SORT_OPTIONS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  TASK_TABS,
  type Task,
  type TaskDueFilter,
  type TaskFilters,
  type TaskSort,
  type TaskStatus,
  type TaskTab,
} from "../../../domain/tasks";
import { deriveAllMilestones, type EventMilestone } from "../../../domain/taskCalendar";
import type { TaskStore } from "./useTaskStore";
import { eventLabel, TaskRow, type TaskLookups } from "./TaskRow";
import { TaskCalendar } from "./TaskCalendar";

const UNDO_WINDOW_MS = 6000;

type UndoState = Readonly<{ task: Task; previousStatus: TaskStatus }>;

/** Initial state when the page is opened from elsewhere (e.g. "Zobrazit úkoly akce"). */
export type TasksPageIntent = Readonly<{ tab?: TaskTab; filters?: Partial<TaskFilters> }>;

/**
 * Úkoly — dashboard counts (clickable filters), tabs, filters + fulltext, sorting, the "Dnes" view
 * (Po termínu / Dnes / Nadcházející) and the calendar. Detail and the create/edit dialog are
 * hosted by the generator shell (onOpenTask / onCreateTask), so the same dialog is used everywhere.
 */
export function TasksPage({
  store,
  lookups,
  intent,
  onOpenTask,
  onCreateTask,
  onOpenMilestone,
}: {
  store: TaskStore;
  lookups: TaskLookups;
  intent?: TasksPageIntent;
  onOpenTask: (task: Task) => void;
  onCreateTask: () => void;
  onOpenMilestone?: (milestone: EventMilestone) => void;
}) {
  const [tab, setTab] = useState<TaskTab>(intent ? intent.tab ?? "all" : "today");
  const [filters, setFilters] = useState<TaskFilters>({ ...EMPTY_TASK_FILTERS, ...intent?.filters });
  const [sort, setSort] = useState<TaskSort>("default");
  const [busyTaskId, setBusyTaskId] = useState<string | undefined>(undefined);
  const [actionError, setActionError] = useState("");
  const [undo, setUndo] = useState<UndoState | undefined>(undefined);
  const undoTimerRef = useRef<number | undefined>(undefined);
  const today = localIsoDate();

  useEffect(() => {
    if (!intent) return;
    setTab(intent.tab ?? "all");
    setFilters({ ...EMPTY_TASK_FILTERS, ...intent.filters });
  }, [intent]);

  useEffect(() => () => window.clearTimeout(undoTimerRef.current), []);

  const tasks = store.tasks ?? [];
  const counts = computeTaskCounts(tasks, today);
  const options = useMemo(() => buildTaskFilterOptions(tasks), [tasks]);
  const milestones = useMemo(() => deriveAllMilestones(lookups.events), [lookups.events]);
  const eventName = (id: string) => eventLabel(lookups, id);
  const filtered = applyTaskFilters(tasksForTab(tasks, tab), filters, today, eventName);

  function patchFilters(update: Partial<TaskFilters>) {
    setFilters((current) => ({ ...current, ...update }));
  }

  function openCount(nextTab: TaskTab, due: TaskDueFilter = "") {
    setTab(nextTab);
    setFilters((current) => ({ ...current, due }));
  }

  async function handleToggleDone(task: Task) {
    if (busyTaskId) return;
    const nextStatus: TaskStatus = task.status === "done" ? "new" : "done";
    setBusyTaskId(task.id);
    setActionError("");
    try {
      await store.setStatus(task.id, nextStatus);
      if (nextStatus === "done") {
        window.clearTimeout(undoTimerRef.current);
        setUndo({ task, previousStatus: task.status });
        undoTimerRef.current = window.setTimeout(() => setUndo(undefined), UNDO_WINDOW_MS);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Úkol se nepodařilo změnit.");
    } finally {
      setBusyTaskId(undefined);
    }
  }

  async function handleUndo() {
    if (!undo) return;
    window.clearTimeout(undoTimerRef.current);
    const { task, previousStatus } = undo;
    setUndo(undefined);
    try {
      await store.setStatus(task.id, previousStatus);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Vrácení se nezdařilo.");
    }
  }

  async function handleMoveTask(task: Task, dueDate: string) {
    setActionError("");
    try {
      await store.update(task.id, { ...taskToInput(task), dueDate });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Termín se nepodařilo změnit.");
    }
  }

  function renderList(list: readonly Task[], emptyText: string) {
    if (list.length === 0) return <p className="workspaceEmpty">{emptyText}</p>;
    return (
      <div className="taskList" role="list">
        {list.map((task) => (
          <TaskRow key={task.id} task={task} today={today} lookups={lookups} onToggleDone={(item) => void handleToggleDone(item)} onOpen={onOpenTask} busy={busyTaskId === task.id} />
        ))}
      </div>
    );
  }

  const countTiles: readonly Readonly<{ label: string; value: number; onClick: () => void; tone?: string; active: boolean }>[] = [
    { label: "Dnes", value: counts.today, onClick: () => openCount("today"), active: tab === "today" },
    { label: "Po termínu", value: counts.overdue, onClick: () => openCount("all", "overdue"), tone: counts.overdue > 0 ? "danger" : undefined, active: tab === "all" && filters.due === "overdue" },
    { label: "Tento týden", value: counts.thisWeek, onClick: () => openCount("all", "thisWeek"), active: tab === "all" && filters.due === "thisWeek" },
    { label: "Čekáme na klienta", value: counts.waiting, onClick: () => openCount("waiting"), active: tab === "waiting" },
    { label: "Ke kontrole", value: counts.review, onClick: () => openCount("review"), active: tab === "review" },
  ];

  const filterBar = (
    <div className="taskFilters">
      <input className="taskSearch" type="search" value={filters.query} onChange={(event) => patchFilters({ query: event.target.value })} placeholder="Hledat úkol, firmu nebo stánek…" aria-label="Hledat úkol, firmu nebo stánek" />
      <select aria-label="Akce" value={filters.eventId} onChange={(event) => patchFilters({ eventId: event.target.value })}>
        <option value="">Akce: všechny</option>
        {options.eventIds.map((id) => <option key={id} value={id}>{eventLabel(lookups, id)}</option>)}
      </select>
      <select aria-label="Firma" value={filters.companyName} onChange={(event) => patchFilters({ companyName: event.target.value })}>
        <option value="">Firma: všechny</option>
        {options.companies.map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
      <select aria-label="Číslo stánku" value={filters.standNumber} onChange={(event) => patchFilters({ standNumber: event.target.value })}>
        <option value="">Stánek: všechny</option>
        {options.standNumbers.map((stand) => <option key={stand} value={stand}>{stand}</option>)}
      </select>
      <select aria-label="Realizačka" value={filters.realizationCompanyId} onChange={(event) => patchFilters({ realizationCompanyId: event.target.value })}>
        <option value="">Realizačka: všechny</option>
        {options.realizationCompanyIds.map((id) => <option key={id} value={id}>{lookups.realizationCompanies.find((company) => company.id === id)?.name ?? id}</option>)}
      </select>
      <select aria-label="Odpovědná osoba" value={filters.assigneeName} onChange={(event) => patchFilters({ assigneeName: event.target.value })}>
        <option value="">Osoba: všechny</option>
        {options.assignees.map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
      <select aria-label="Kategorie" value={filters.categoryId} onChange={(event) => patchFilters({ categoryId: event.target.value })}>
        <option value="">Kategorie: všechny</option>
        {lookups.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
      </select>
      <select aria-label="Priorita" value={filters.priority} onChange={(event) => patchFilters({ priority: event.target.value })}>
        <option value="">Priorita: všechny</option>
        {TASK_PRIORITIES.map((priority) => <option key={priority} value={priority}>{TASK_PRIORITY_LABELS[priority]}</option>)}
      </select>
      <select aria-label="Stav" value={filters.status} onChange={(event) => patchFilters({ status: event.target.value })}>
        <option value="">Stav: všechny</option>
        {TASK_STATUSES.map((status) => <option key={status} value={status}>{TASK_STATUS_LABELS[status]}</option>)}
      </select>
      <select aria-label="Termín" value={filters.due} onChange={(event) => patchFilters({ due: event.target.value as TaskDueFilter })}>
        <option value="">Termín: všechny</option>
        {(Object.keys(TASK_DUE_FILTER_LABELS) as Exclude<TaskDueFilter, "">[]).map((due) => <option key={due} value={due}>{TASK_DUE_FILTER_LABELS[due]}</option>)}
      </select>
      {tab !== "calendar" && tab !== "today" && (
        <select aria-label="Řazení" value={sort} onChange={(event) => setSort(event.target.value as TaskSort)}>
          {TASK_SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>Řazení: {option.label}</option>)}
        </select>
      )}
      {hasActiveTaskFilters(filters) && <button type="button" className="textButton" onClick={() => setFilters(EMPTY_TASK_FILTERS)}>Vymazat filtry</button>}
    </div>
  );

  const todayView = tab === "today" ? buildTodayView(filtered, today) : undefined;

  return (
    <div className="workspacePage tasksPage">
      <div className="workspacePageHeader">
        <div>
          <span className="eyebrow">ÚKOLY</span>
          <h1>Úkoly</h1>
        </div>
        <button type="button" className="primaryButton" onClick={onCreateTask}>+ Úkol</button>
      </div>

      <div className="taskCounts">
        {countTiles.map((tile) => (
          <button key={tile.label} type="button" className={["taskCount", tile.tone ?? "", tile.active ? "active" : ""].filter(Boolean).join(" ")} onClick={tile.onClick} aria-pressed={tile.active}>
            <span>{tile.label}</span>
            <strong>{tile.value}</strong>
          </button>
        ))}
      </div>

      <div className="taskTabs" role="tablist" aria-label="Pohledy úkolů">
        {TASK_TABS.map((entry) => (
          <button key={entry.id} type="button" role="tab" aria-selected={tab === entry.id} className={tab === entry.id ? "taskTab active" : "taskTab"} onClick={() => setTab(entry.id)}>
            {entry.label}
          </button>
        ))}
      </div>

      {filterBar}

      {store.loadError && <p className="uploadError">{store.loadError}</p>}
      {actionError && <p className="uploadError" role="alert">{actionError}</p>}
      {!store.tasks && !store.loadError && <p className="workspaceEmpty">Načítám úkoly…</p>}

      {store.tasks && todayView && (
        <div className="taskTodayView">
          <section className="taskSection overdue">
            <h2>Po termínu <span>{todayView.overdue.length}</span></h2>
            {renderList(todayView.overdue, "Nic není po termínu.")}
          </section>
          <section className="taskSection">
            <h2>Dnes <span>{todayView.today.length}</span></h2>
            {renderList(todayView.today, "Na dnešek nic nezbývá.")}
          </section>
          <section className="taskSection">
            <h2>Nadcházející <span>{todayView.upcoming.length}</span></h2>
            {renderList(todayView.upcoming, "V příštích 7 dnech nic.")}
          </section>
        </div>
      )}

      {store.tasks && tab === "calendar" && (
        <TaskCalendar tasks={filtered} milestones={filters.eventId ? milestones.filter((milestone) => milestone.eventId === filters.eventId) : milestones} today={today} onOpenTask={onOpenTask} onOpenMilestone={onOpenMilestone} onMoveTask={(task, date) => void handleMoveTask(task, date)} />
      )}

      {store.tasks && tab !== "today" && tab !== "calendar" && (
        <>
          <p className="taskListSummary">{filtered.length} {filtered.length === 1 ? "úkol" : filtered.length < 5 && filtered.length > 0 ? "úkoly" : "úkolů"}</p>
          {renderList(
            sortTasks(filtered, sort, today),
            tasks.length === 0 ? "Zatím tu nejsou žádné úkoly. Vytvořte první tlačítkem + Úkol." : hasActiveTaskFilters(filters) ? "Žádný úkol neodpovídá filtrům." : "V tomto pohledu nejsou žádné úkoly.",
          )}
        </>
      )}

      {undo && (
        <div className="taskUndoToast" role="status">
          <span>Hotovo ✓ — {undo.task.title}</span>
          <button type="button" onClick={() => void handleUndo()}>Vrátit zpět</button>
        </div>
      )}
    </div>
  );
}
