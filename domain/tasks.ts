/**
 * Úkoly / Kalendář — a simple internal task list linked to the generator's existing data
 * (events, companies, stand numbers, realizačky, and the module/record a task came from).
 * Pure and framework-free; the DB shape is supabase/migrations/20260925120000_tasks.sql.
 *
 * Dates are plain local calendar dates ("YYYY-MM-DD") everywhere in this module — every function
 * that needs "today" takes it as an argument (see localIsoDate), so the rules are deterministic
 * and testable. People (assignee, author, history actor) are free-text names: the app has no
 * users table and a single shared login.
 */
import { normalizeStandNumber, compareStandNumbersNatural } from "./technicalStandNumber.ts";

// ============================================================================
// Model
// ============================================================================

export const TASK_STATUSES = ["new", "in_progress", "waiting", "review", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABELS: Readonly<Record<TaskStatus, string>> = {
  new: "Nový",
  in_progress: "Rozpracováno",
  waiting: "Čekáme",
  review: "Ke kontrole",
  done: "Hotovo",
  cancelled: "Zrušeno",
};

export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_PRIORITY_LABELS: Readonly<Record<TaskPriority, string>> = {
  low: "Nízká",
  normal: "Normální",
  high: "Vysoká",
  urgent: "Urgentní",
};

const PRIORITY_RANK: Readonly<Record<TaskPriority, number>> = { urgent: 0, high: 1, normal: 2, low: 3 };

export const TASK_SOURCE_TYPES = ["manual", "booth_project", "print_surface_project", "technical_raster_project", "event"] as const;
export type TaskSourceType = (typeof TASK_SOURCE_TYPES)[number];

/** Label of the "open the source record" action in the task detail. */
export const TASK_SOURCE_OPEN_LABELS: Readonly<Record<Exclude<TaskSourceType, "manual">, string>> = {
  booth_project: "Otevřít stánek",
  print_surface_project: "Otevřít tiskové plochy",
  technical_raster_project: "Otevřít technický rastr",
  event: "Otevřít akci",
};

export type TaskCategory = Readonly<{ id: string; name: string; sortOrder: number; isActive: boolean }>;

export type Task = Readonly<{
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  categoryId?: string;
  dueDate?: string;
  /** "HH:MM" — only with a dueDate. */
  dueTime?: string;
  eventId?: string;
  companyName?: string;
  standNumber?: string;
  realizationCompanyId?: string;
  assigneeName?: string;
  createdBy?: string;
  sourceType: TaskSourceType;
  sourceId?: string;
  isAutomatic: boolean;
  automationKey?: string;
  waitingSince?: string;
  recurringRuleId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}>;

/** Everything a user can edit. Absent optional fields mean "empty". */
export type TaskInput = Readonly<{
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  categoryId?: string;
  dueDate?: string;
  dueTime?: string;
  eventId?: string;
  companyName?: string;
  standNumber?: string;
  realizationCompanyId?: string;
  assigneeName?: string;
  sourceType?: TaskSourceType;
  sourceId?: string;
  waitingSince?: string;
}>;

/** A validated, normalized TaskInput — what the repository persists. */
export type TaskFields = Readonly<{
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  categoryId?: string;
  dueDate?: string;
  dueTime?: string;
  eventId?: string;
  companyName?: string;
  standNumber?: string;
  realizationCompanyId?: string;
  assigneeName?: string;
  sourceType: TaskSourceType;
  sourceId?: string;
  waitingSince?: string;
}>;

/** Fields the task service sets itself on create/transition, never taken from a form. */
export type TaskSystemFields = Readonly<{
  createdBy?: string;
  isAutomatic?: boolean;
  automationKey?: string;
  completedAt?: string | null;
}>;

export type TaskChange = Readonly<{ field: string; from?: string; to?: string }>;

export const TASK_HISTORY_ACTIONS = ["created", "updated", "status_changed", "completed", "reopened", "approved", "returned"] as const;
export type TaskHistoryAction = (typeof TASK_HISTORY_ACTIONS)[number];

export type TaskHistoryEntry = Readonly<{
  id: string;
  taskId: string;
  action: TaskHistoryAction;
  changes: readonly TaskChange[];
  note?: string;
  actorName?: string;
  createdAt: string;
}>;

export type TaskHistoryInput = Omit<TaskHistoryEntry, "id" | "createdAt">;

// ============================================================================
// Recurrence (schema + type only — nothing generates recurring tasks yet)
// ============================================================================

export type TaskRecurrenceFrequency = "daily" | "weekly" | "weekdays" | "interval_days";

export type TaskRecurrenceRule = Readonly<{
  id: string;
  frequency: TaskRecurrenceFrequency;
  intervalDays?: number;
  nextDueDate?: string;
  endsOn?: string;
  isActive: boolean;
}>;

/** The due date after `fromDate` for a rule — ready for a future generator; not used by the UI yet. */
export function nextRecurrenceDate(rule: Pick<TaskRecurrenceRule, "frequency" | "intervalDays">, fromDate: string): string {
  switch (rule.frequency) {
    case "daily": return addDays(fromDate, 1);
    case "weekly": return addDays(fromDate, 7);
    case "interval_days": return addDays(fromDate, Math.max(1, rule.intervalDays ?? 1));
    case "weekdays": {
      let next = addDays(fromDate, 1);
      while (isoWeekday(next) > 5) next = addDays(next, 1);
      return next;
    }
  }
}

// ============================================================================
// Dates ("YYYY-MM-DD", calendar arithmetic in UTC so DST never shifts a day)
// ============================================================================

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/u;

export function isIsoDate(value: string | undefined): value is string {
  if (!value || !ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}

/** The browser's/server's LOCAL calendar date — the only place "now" becomes a date. */
export function localIsoDate(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function toUtc(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!));
}

function fromUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const date = toUtc(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return fromUtc(date);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((toUtc(toIso).getTime() - toUtc(fromIso).getTime()) / 86_400_000);
}

/** 1 = Monday … 7 = Sunday. */
export function isoWeekday(iso: string): number {
  const day = toUtc(iso).getUTCDay();
  return day === 0 ? 7 : day;
}

export function startOfWeek(iso: string): string {
  return addDays(iso, 1 - isoWeekday(iso));
}

export function endOfWeek(iso: string): string {
  return addDays(startOfWeek(iso), 6);
}

/** "25. 9." or "25. 9. 2027" when the year differs from `today`'s. */
export function formatShortDate(iso: string, today?: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  const sameYear = today ? today.slice(0, 4) === iso.slice(0, 4) : true;
  return sameYear ? `${day}. ${month}.` : `${day}. ${month}. ${year}`;
}

// ============================================================================
// Quick due-date presets
// ============================================================================

export const DUE_PRESETS = ["today", "tomorrow", "in2days", "thisWeek", "nextWeek", "none"] as const;
export type DuePreset = (typeof DUE_PRESETS)[number];

export const DUE_PRESET_LABELS: Readonly<Record<DuePreset, string>> = {
  today: "Dnes",
  tomorrow: "Zítra",
  in2days: "Za 2 dny",
  thisWeek: "Tento týden",
  nextWeek: "Příští týden",
  none: "Bez termínu",
};

/**
 * "Tento týden" = Friday of the current week (or today when it's already the weekend);
 * "Příští týden" = Monday of next week. undefined = no due date.
 */
export function resolveDuePreset(preset: DuePreset, today: string): string | undefined {
  switch (preset) {
    case "today": return today;
    case "tomorrow": return addDays(today, 1);
    case "in2days": return addDays(today, 2);
    case "thisWeek": {
      const friday = addDays(startOfWeek(today), 4);
      return friday < today ? today : friday;
    }
    case "nextWeek": return addDays(startOfWeek(today), 7);
    case "none": return undefined;
  }
}

// ============================================================================
// Validation / normalization
// ============================================================================

export type TaskValidation =
  | { readonly ok: true; readonly value: TaskFields }
  | { readonly ok: false; readonly message: string };

function clean(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Trims text, normalizes the stand number, and rejects inconsistent values. Unknown enum values are rejected, never guessed. */
export function normalizeTaskInput(input: TaskInput): TaskValidation {
  const title = clean(input.title);
  if (!title) return { ok: false, message: "Zadejte název úkolu." };
  const status = input.status ?? "new";
  if (!TASK_STATUSES.includes(status)) return { ok: false, message: "Neplatný stav úkolu." };
  const priority = input.priority ?? "normal";
  if (!TASK_PRIORITIES.includes(priority)) return { ok: false, message: "Neplatná priorita úkolu." };
  const sourceType = input.sourceType ?? "manual";
  if (!TASK_SOURCE_TYPES.includes(sourceType)) return { ok: false, message: "Neplatný zdroj úkolu." };
  const dueDate = clean(input.dueDate);
  if (dueDate && !isIsoDate(dueDate)) return { ok: false, message: "Neplatné datum termínu." };
  const dueTime = clean(input.dueTime);
  if (dueTime && !TIME.test(dueTime)) return { ok: false, message: "Neplatný čas termínu." };
  if (dueTime && !dueDate) return { ok: false, message: "Čas termínu vyžaduje datum." };
  const waitingSince = clean(input.waitingSince);
  if (waitingSince && !isIsoDate(waitingSince)) return { ok: false, message: "Neplatné datum „Čekáme od“." };
  const standNumber = clean(input.standNumber);
  return {
    ok: true,
    value: {
      title,
      description: clean(input.description),
      status,
      priority,
      categoryId: clean(input.categoryId),
      dueDate,
      dueTime: dueTime?.slice(0, 5),
      eventId: clean(input.eventId),
      companyName: clean(input.companyName),
      standNumber: standNumber ? normalizeStandNumber(standNumber) : undefined,
      realizationCompanyId: clean(input.realizationCompanyId),
      assigneeName: clean(input.assigneeName),
      sourceType,
      sourceId: sourceType === "manual" ? undefined : clean(input.sourceId),
      waitingSince,
    },
  };
}

export function taskToInput(task: Task): TaskInput {
  return {
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    categoryId: task.categoryId,
    dueDate: task.dueDate,
    dueTime: task.dueTime,
    eventId: task.eventId,
    companyName: task.companyName,
    standNumber: task.standNumber,
    realizationCompanyId: task.realizationCompanyId,
    assigneeName: task.assigneeName,
    sourceType: task.sourceType,
    sourceId: task.sourceId,
    waitingSince: task.waitingSince,
  };
}

// ============================================================================
// Status transitions + history
// ============================================================================

export function isTaskOpen(task: Pick<Task, "status">): boolean {
  return task.status !== "done" && task.status !== "cancelled";
}

/**
 * System fields that follow a status change: entering "done" stamps completedAt, leaving it
 * clears it; entering "waiting" stamps waitingSince (unless the user already set one).
 */
export function applyStatusSideEffects(
  previous: Pick<Task, "status" | "completedAt"> | undefined,
  fields: TaskFields,
  now: Date,
): Readonly<{ fields: TaskFields; completedAt: string | null | undefined }> {
  let completedAt: string | null | undefined;
  if (fields.status === "done" && previous?.status !== "done") completedAt = now.toISOString();
  else if (fields.status !== "done" && previous?.status === "done") completedAt = null;
  const waitingSince = fields.status === "waiting" && !fields.waitingSince ? localIsoDate(now) : fields.waitingSince;
  return { fields: { ...fields, waitingSince }, completedAt };
}

const HISTORY_FIELDS: readonly (keyof TaskFields)[] = [
  "title", "description", "status", "priority", "categoryId", "dueDate", "dueTime", "eventId",
  "companyName", "standNumber", "realizationCompanyId", "assigneeName", "waitingSince",
];

/** Field-level diff between the stored task and the new fields — what task_history.changes records. */
export function diffTaskFields(before: Task, after: TaskFields): readonly TaskChange[] {
  const changes: TaskChange[] = [];
  for (const field of HISTORY_FIELDS) {
    const from = before[field as keyof Task] as string | undefined;
    const to = after[field] as string | undefined;
    if ((from ?? "") !== (to ?? "")) changes.push({ field, from, to });
  }
  return changes;
}

/** The single history action that best describes a change set. */
export function historyActionForChanges(before: Pick<Task, "status">, changes: readonly TaskChange[]): TaskHistoryAction {
  const statusChange = changes.find((change) => change.field === "status");
  if (!statusChange) return "updated";
  if (statusChange.to === "done") return "completed";
  if (before.status === "done" || before.status === "cancelled") return "reopened";
  return "status_changed";
}

export const TASK_FIELD_LABELS: Readonly<Record<string, string>> = {
  title: "název",
  description: "poznámka",
  status: "stav",
  priority: "priorita",
  categoryId: "kategorie",
  dueDate: "termín",
  dueTime: "čas",
  eventId: "akce",
  companyName: "firma",
  standNumber: "stánek",
  realizationCompanyId: "realizačka",
  assigneeName: "odpovědná osoba",
  waitingSince: "čekáme od",
};

/** "Jan změnil stav → Rozpracováno" style line for the detail's history list. */
export function describeHistoryEntry(entry: TaskHistoryEntry): string {
  const actor = entry.actorName ?? "Někdo";
  switch (entry.action) {
    case "created": return `${actor} vytvořil úkol`;
    case "completed": return `${actor} označil jako Hotovo`;
    case "approved": return `${actor} schválil úkol`;
    case "returned": return `${actor} vrátil úkol k přepracování`;
    case "reopened": return `${actor} znovu otevřel úkol`;
    case "status_changed": {
      const status = entry.changes.find((change) => change.field === "status")?.to as TaskStatus | undefined;
      return `${actor} změnil stav → ${status ? TASK_STATUS_LABELS[status] : "?"}`;
    }
    case "updated": {
      const fields = entry.changes.map((change) => TASK_FIELD_LABELS[change.field] ?? change.field);
      return `${actor} upravil ${fields.join(", ") || "úkol"}`;
    }
  }
}

// ============================================================================
// Due buckets, counts, views
// ============================================================================

export type TaskDueBucket = "overdue" | "today" | "upcoming" | "later" | "noDate" | "closed";

export function taskDueBucket(task: Pick<Task, "status" | "dueDate">, today: string, upcomingDays = 7): TaskDueBucket {
  if (!isTaskOpen(task)) return "closed";
  if (!task.dueDate) return "noDate";
  if (task.dueDate < today) return "overdue";
  if (task.dueDate === today) return "today";
  return task.dueDate <= addDays(today, upcomingDays) ? "upcoming" : "later";
}

export type TaskCounts = Readonly<{
  today: number;
  overdue: number;
  thisWeek: number;
  waiting: number;
  review: number;
  /** Sidebar badge: overdue + today's open tasks. */
  attention: number;
}>;

/** Dashboard numbers. "Tento týden" = open tasks due today … Sunday of this week (overdue excluded — it has its own number). */
export function computeTaskCounts(tasks: readonly Task[], today: string): TaskCounts {
  const weekEnd = endOfWeek(today);
  let todayCount = 0, overdue = 0, thisWeek = 0, waiting = 0, review = 0;
  for (const task of tasks) {
    const bucket = taskDueBucket(task, today);
    if (bucket === "today") todayCount += 1;
    if (bucket === "overdue") overdue += 1;
    if (isTaskOpen(task) && task.dueDate && task.dueDate >= today && task.dueDate <= weekEnd) thisWeek += 1;
    if (task.status === "waiting") waiting += 1;
    if (task.status === "review") review += 1;
  }
  return { today: todayCount, overdue, thisWeek, waiting, review, attention: overdue + todayCount };
}

export type TodayView = Readonly<{ overdue: readonly Task[]; today: readonly Task[]; upcoming: readonly Task[] }>;

/** "Dnes" tab: overdue, due today, and the next `upcomingDays` days — each sorted by the default order. */
export function buildTodayView(tasks: readonly Task[], today: string, upcomingDays = 7): TodayView {
  const overdue: Task[] = [], dueToday: Task[] = [], upcoming: Task[] = [];
  for (const task of tasks) {
    const bucket = taskDueBucket(task, today, upcomingDays);
    if (bucket === "overdue") overdue.push(task);
    else if (bucket === "today") dueToday.push(task);
    else if (bucket === "upcoming") upcoming.push(task);
  }
  const sort = (list: Task[]) => sortTasks(list, "default", today);
  return { overdue: sort(overdue), today: sort(dueToday), upcoming: sort(upcoming) };
}

export function waitingDays(task: Pick<Task, "waitingSince">, today: string): number | undefined {
  return task.waitingSince ? Math.max(0, daysBetween(task.waitingSince, today)) : undefined;
}

/** "Čekáme 3 dny" (Czech plural forms). */
export function formatWaitingDays(days: number): string {
  if (days === 0) return "Čekáme od dneška";
  if (days === 1) return "Čekáme 1 den";
  if (days < 5) return `Čekáme ${days} dny`;
  return `Čekáme ${days} dní`;
}

/** "Termín včera" / "Termín dnes" / "Termín zítra" / "Termín 25. 9." */
export function describeDue(task: Pick<Task, "dueDate" | "dueTime">, today: string): string | undefined {
  if (!task.dueDate) return undefined;
  const offset = daysBetween(today, task.dueDate);
  const time = task.dueTime ? ` ${task.dueTime}` : "";
  if (offset === 0) return `Dnes${time}`;
  if (offset === -1) return `Včera${time}`;
  if (offset === 1) return `Zítra${time}`;
  if (offset < 0) return `${formatShortDate(task.dueDate, today)}${time} (před ${-offset} dny)`;
  return `${formatShortDate(task.dueDate, today)}${time}`;
}

// ============================================================================
// Tabs, filters, sorting
// ============================================================================

export type TaskTab = "today" | "all" | "calendar" | "waiting" | "review" | "done";

export const TASK_TABS: readonly Readonly<{ id: TaskTab; label: string }>[] = [
  { id: "today", label: "Dnes" },
  { id: "all", label: "Všechny úkoly" },
  { id: "calendar", label: "Kalendář" },
  { id: "waiting", label: "Čekáme na klienta" },
  { id: "review", label: "Ke kontrole" },
  { id: "done", label: "Dokončené" },
];

/** The list each tab shows before filters: "all" = open tasks; "done" = done + cancelled. */
export function tasksForTab(tasks: readonly Task[], tab: TaskTab): readonly Task[] {
  switch (tab) {
    case "waiting": return tasks.filter((task) => task.status === "waiting");
    case "review": return tasks.filter((task) => task.status === "review");
    case "done": return tasks.filter((task) => !isTaskOpen(task));
    default: return tasks.filter(isTaskOpen);
  }
}

export type TaskDueFilter = "" | "overdue" | "today" | "thisWeek" | "noDate";

export const TASK_DUE_FILTER_LABELS: Readonly<Record<Exclude<TaskDueFilter, "">, string>> = {
  overdue: "Po termínu",
  today: "Dnes",
  thisWeek: "Tento týden",
  noDate: "Bez termínu",
};

export type TaskFilters = Readonly<{
  eventId: string;
  companyName: string;
  standNumber: string;
  realizationCompanyId: string;
  assigneeName: string;
  categoryId: string;
  priority: string;
  status: string;
  due: TaskDueFilter;
  query: string;
}>;

export const EMPTY_TASK_FILTERS: TaskFilters = {
  eventId: "", companyName: "", standNumber: "", realizationCompanyId: "", assigneeName: "",
  categoryId: "", priority: "", status: "", due: "", query: "",
};

export function hasActiveTaskFilters(filters: TaskFilters): boolean {
  return Object.values(filters).some((value) => value !== "");
}

function foldText(value: string | undefined): string {
  return (value ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("cs");
}

/**
 * Every non-empty filter must match (AND). Company/assignee compare case- and diacritics-
 * insensitively; the stand compares normalized stand numbers; the fulltext searches title,
 * description, company, stand and the event name (via `eventName`).
 */
export function applyTaskFilters(
  tasks: readonly Task[],
  filters: TaskFilters,
  today: string,
  eventName: (eventId: string) => string | undefined = () => undefined,
): readonly Task[] {
  const query = foldText(filters.query.trim());
  const stand = filters.standNumber ? normalizeStandNumber(filters.standNumber) : "";
  const weekEnd = endOfWeek(today);
  return tasks.filter((task) => {
    if (filters.eventId && task.eventId !== filters.eventId) return false;
    if (filters.companyName && foldText(task.companyName) !== foldText(filters.companyName)) return false;
    if (stand && task.standNumber !== stand) return false;
    if (filters.realizationCompanyId && task.realizationCompanyId !== filters.realizationCompanyId) return false;
    if (filters.assigneeName && foldText(task.assigneeName) !== foldText(filters.assigneeName)) return false;
    if (filters.categoryId && task.categoryId !== filters.categoryId) return false;
    if (filters.priority && task.priority !== filters.priority) return false;
    if (filters.status && task.status !== filters.status) return false;
    if (filters.due) {
      const bucket = taskDueBucket(task, today);
      if (filters.due === "overdue" && bucket !== "overdue") return false;
      if (filters.due === "today" && bucket !== "today") return false;
      if (filters.due === "noDate" && !(isTaskOpen(task) && !task.dueDate)) return false;
      if (filters.due === "thisWeek" && !(isTaskOpen(task) && task.dueDate && task.dueDate >= today && task.dueDate <= weekEnd)) return false;
    }
    if (query) {
      const haystack = foldText([task.title, task.description, task.companyName, task.standNumber, task.eventId ? eventName(task.eventId) : undefined].filter(Boolean).join(" "));
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

export type TaskFilterOptions = Readonly<{
  companies: readonly string[];
  standNumbers: readonly string[];
  assignees: readonly string[];
  eventIds: readonly string[];
  realizationCompanyIds: readonly string[];
}>;

/** Filter choices derived from the loaded tasks (first-seen spelling, Czech/natural sort). */
export function buildTaskFilterOptions(tasks: readonly Task[]): TaskFilterOptions {
  const unique = (values: readonly (string | undefined)[], fold = true) => {
    const seen = new Map<string, string>();
    for (const value of values) if (value) { const key = fold ? foldText(value) : value; if (!seen.has(key)) seen.set(key, value); }
    return [...seen.values()];
  };
  const byCzech = (a: string, b: string) => a.localeCompare(b, "cs", { sensitivity: "base", numeric: true });
  return {
    companies: unique(tasks.map((task) => task.companyName)).sort(byCzech),
    standNumbers: unique(tasks.map((task) => task.standNumber), false).sort(compareStandNumbersNatural),
    assignees: unique(tasks.map((task) => task.assigneeName)).sort(byCzech),
    eventIds: unique(tasks.map((task) => task.eventId), false),
    realizationCompanyIds: unique(tasks.map((task) => task.realizationCompanyId), false),
  };
}

export type TaskSort = "default" | "due" | "priority" | "company" | "stand" | "created";

export const TASK_SORT_OPTIONS: readonly Readonly<{ value: TaskSort; label: string }>[] = [
  { value: "default", label: "Výchozí" },
  { value: "due", label: "Podle termínu" },
  { value: "priority", label: "Podle priority" },
  { value: "company", label: "Podle firmy" },
  { value: "stand", label: "Podle stánku" },
  { value: "created", label: "Podle vytvoření" },
];

/** Default order: 1) overdue, 2) urgent, 3) today, 4) nearest due date, 5) no due date; closed tasks last. */
function defaultRank(task: Task, today: string): number {
  const bucket = taskDueBucket(task, today);
  if (bucket === "closed") return 5;
  if (bucket === "overdue") return 0;
  if (task.priority === "urgent") return 1;
  if (bucket === "today") return 2;
  if (bucket === "noDate") return 4;
  return 3;
}

function compareDue(a: Task, b: Task): number {
  if (a.dueDate !== b.dueDate) {
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  return (a.dueTime ?? "99:99").localeCompare(b.dueTime ?? "99:99");
}

function compareText(a: string | undefined, b: string | undefined): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b, "cs", { sensitivity: "base", numeric: true });
}

/** Stable sort; ties always fall back to due date, then priority, then title. */
export function sortTasks(tasks: readonly Task[], sort: TaskSort, today: string): Task[] {
  const tieBreak = (a: Task, b: Task) => compareDue(a, b) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || compareText(a.title, b.title);
  const compare = (a: Task, b: Task): number => {
    switch (sort) {
      case "default": return defaultRank(a, today) - defaultRank(b, today) || tieBreak(a, b);
      case "due": return tieBreak(a, b);
      case "priority": return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || tieBreak(a, b);
      case "company": return compareText(a.companyName, b.companyName) || tieBreak(a, b);
      case "stand": {
        if (!a.standNumber || !b.standNumber) return compareText(a.standNumber, b.standNumber) || tieBreak(a, b);
        return compareStandNumbersNatural(a.standNumber, b.standNumber) || tieBreak(a, b);
      }
      case "created": return b.createdAt.localeCompare(a.createdAt) || tieBreak(a, b);
    }
  };
  return [...tasks].sort(compare);
}

// ============================================================================
// Links to the rest of the generator
// ============================================================================

/** Where a new task comes from — pre-fills the form (spec: "+ Úkol" from a stand/event/project). */
export type TaskContext = Readonly<{
  eventId?: string;
  companyName?: string;
  standNumber?: string;
  realizationCompanyId?: string;
  sourceType?: TaskSourceType;
  sourceId?: string;
}>;

export function taskInputFromContext(context: TaskContext | undefined, defaults: Partial<TaskInput> = {}): TaskInput {
  return {
    title: "",
    priority: "normal",
    status: "new",
    ...defaults,
    eventId: context?.eventId,
    companyName: context?.companyName,
    standNumber: context?.standNumber ? normalizeStandNumber(context.standNumber) : undefined,
    realizationCompanyId: context?.realizationCompanyId,
    sourceType: context?.sourceType ?? "manual",
    sourceId: context?.sourceId,
  };
}

/** A stand's tasks: created from that exact source record, or linked to the same event + stand number. */
export function tasksForStand(tasks: readonly Task[], stand: Readonly<{ eventId?: string; standNumber?: string; sourceType?: TaskSourceType; sourceId?: string }>): readonly Task[] {
  const standNumber = stand.standNumber ? normalizeStandNumber(stand.standNumber) : "";
  return tasks.filter((task) => {
    if (stand.sourceId && task.sourceType === stand.sourceType && task.sourceId === stand.sourceId) return true;
    return Boolean(stand.eventId && standNumber && task.eventId === stand.eventId && task.standNumber === standNumber);
  });
}

export function tasksForEvent(tasks: readonly Task[], eventId: string): readonly Task[] {
  return tasks.filter((task) => task.eventId === eventId);
}

// ============================================================================
// Persistence contract
// ============================================================================

export type TaskListResult = Readonly<{ tasks: readonly Task[]; categories: readonly TaskCategory[] }>;

export interface TaskRepository {
  list(): Promise<readonly Task[]>;
  get(id: string): Promise<Task | undefined>;
  create(fields: TaskFields, system: TaskSystemFields): Promise<Task>;
  update(id: string, fields: TaskFields, system: TaskSystemFields): Promise<Task>;
  delete(id: string): Promise<void>;
  listCategories(): Promise<readonly TaskCategory[]>;
  listHistory(taskId: string): Promise<readonly TaskHistoryEntry[]>;
  appendHistory(entry: TaskHistoryInput): Promise<void>;
  /** Existing automation keys — used by planAutomaticTasks to never create the same automatic task twice. */
  listAutomationKeys(): Promise<ReadonlySet<string>>;
}
