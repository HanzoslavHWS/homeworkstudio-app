import assert from "node:assert/strict";
import test from "node:test";
import {
  addDays,
  applyStatusSideEffects,
  applyTaskFilters,
  buildTaskFilterOptions,
  buildTodayView,
  computeTaskCounts,
  daysBetween,
  describeDue,
  describeHistoryEntry,
  diffTaskFields,
  EMPTY_TASK_FILTERS,
  endOfWeek,
  formatWaitingDays,
  hasActiveTaskFilters,
  historyActionForChanges,
  isIsoDate,
  localIsoDate,
  nextRecurrenceDate,
  normalizeTaskInput,
  resolveDuePreset,
  sortTasks,
  startOfWeek,
  taskDueBucket,
  taskInputFromContext,
  tasksForEvent,
  tasksForStand,
  tasksForTab,
  waitingDays,
  type Task,
  type TaskFields,
} from "../domain/tasks.ts";
import { buildMonthGrid, buildWeekDays, deriveEventMilestones, groupCalendarItems, shiftCalendarAnchor } from "../domain/taskCalendar.ts";
import { buildStandChecklist, resolveChecklistTemplate, resolveStandKey, validateChecklistItems, type StandChecklistTemplate } from "../domain/standChecklist.ts";
import { planAutomaticTasks, technicalRasterUnplacedServicesRule } from "../domain/automaticTasks.ts";
import { assignStandManually, createTechnicalRasterProject, mergeTechnicalRasterImport, placeTechnicalService, type ParsedTechnicalReport } from "../domain/technicalRaster.ts";
import type { StoredAsset } from "../domain/assets.ts";

// Thursday 2026-09-24 — a fixed "today" so every date rule is deterministic.
const TODAY = "2026-09-24";

let counter = 0;
function task(overrides: Partial<Task> = {}): Task {
  counter += 1;
  return {
    id: `t${counter}`,
    title: `Úkol ${counter}`,
    status: "new",
    priority: "normal",
    sourceType: "manual",
    isAutomatic: false,
    createdAt: `2026-09-01T10:00:${String(counter % 60).padStart(2, "0")}.000Z`,
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

// =========================================================================================
// Dates + quick presets
// =========================================================================================

test("DATES: ISO validation, day arithmetic across month/DST boundaries, Monday-first weeks", () => {
  assert.equal(isIsoDate("2026-02-29"), false);
  assert.equal(isIsoDate("2028-02-29"), true);
  assert.equal(isIsoDate("26-9-1"), false);
  assert.equal(addDays("2026-10-24", 2), "2026-10-26", "across the CET/CEST switch");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(daysBetween("2026-09-20", TODAY), 4);
  assert.equal(startOfWeek(TODAY), "2026-09-21");
  assert.equal(endOfWeek(TODAY), "2026-09-27");
  assert.equal(localIsoDate(new Date(2026, 8, 5, 23, 30)), "2026-09-05", "local calendar date, never UTC-shifted");
});

test("PRESETS: Dnes / Zítra / Za 2 dny / Tento týden (Friday) / Příští týden (Monday) / Bez termínu", () => {
  assert.equal(resolveDuePreset("today", TODAY), "2026-09-24");
  assert.equal(resolveDuePreset("tomorrow", TODAY), "2026-09-25");
  assert.equal(resolveDuePreset("in2days", TODAY), "2026-09-26");
  assert.equal(resolveDuePreset("thisWeek", TODAY), "2026-09-25");
  assert.equal(resolveDuePreset("nextWeek", TODAY), "2026-09-28");
  assert.equal(resolveDuePreset("none", TODAY), undefined);
  assert.equal(resolveDuePreset("thisWeek", "2026-09-26"), "2026-09-26", "on Saturday 'this week' is today, never a past Friday");
});

// =========================================================================================
// Validation
// =========================================================================================

test("VALIDATION: title required; text trimmed; stand number normalized; defaults new/normal/manual", () => {
  assert.deepEqual(normalizeTaskInput({ title: "   " }), { ok: false, message: "Zadejte název úkolu." });
  const result = normalizeTaskInput({ title: "  Zkontrolovat grafiku  ", standNumber: " 3 B 24 ", companyName: " Collamedic ", description: "  " });
  if (result.ok === false) assert.fail(result.message);
  assert.equal(result.value.title, "Zkontrolovat grafiku");
  assert.equal(result.value.standNumber, "3B24");
  assert.equal(result.value.companyName, "Collamedic");
  assert.equal(result.value.description, undefined);
  assert.equal(result.value.status, "new");
  assert.equal(result.value.priority, "normal");
  assert.equal(result.value.sourceType, "manual");
});

test("VALIDATION: rejects unknown enums, bad dates, a time without a date; manual source never keeps a source id", () => {
  assert.equal(normalizeTaskInput({ title: "x", status: "bogus" as never }).ok, false);
  assert.equal(normalizeTaskInput({ title: "x", priority: "extreme" as never }).ok, false);
  assert.equal(normalizeTaskInput({ title: "x", dueDate: "2026-02-30" }).ok, false);
  assert.deepEqual(normalizeTaskInput({ title: "x", dueTime: "10:00" }), { ok: false, message: "Čas termínu vyžaduje datum." });
  assert.equal(normalizeTaskInput({ title: "x", dueDate: TODAY, dueTime: "25:00" }).ok, false);
  const withSource = normalizeTaskInput({ title: "x", sourceType: "manual", sourceId: "p1" });
  assert.equal(withSource.ok && withSource.value.sourceId, undefined);
  const timed = normalizeTaskInput({ title: "x", dueDate: TODAY, dueTime: "09:30:00" });
  assert.equal(timed.ok && timed.value.dueTime, "09:30");
});

// =========================================================================================
// Status side effects + history
// =========================================================================================

const BASE_FIELDS: TaskFields = { title: "x", status: "new", priority: "normal", sourceType: "manual" };
const NOW = new Date(2026, 8, 24, 14, 0);

test("STATUS: entering done stamps completedAt, leaving done clears it, other changes leave it alone", () => {
  assert.equal(applyStatusSideEffects({ status: "in_progress" }, { ...BASE_FIELDS, status: "done" }, NOW).completedAt, NOW.toISOString());
  assert.equal(applyStatusSideEffects({ status: "done", completedAt: "x" }, { ...BASE_FIELDS, status: "in_progress" }, NOW).completedAt, null);
  assert.equal(applyStatusSideEffects({ status: "new" }, { ...BASE_FIELDS, status: "in_progress" }, NOW).completedAt, undefined);
});

test("STATUS: entering waiting stamps 'Čekáme od' today unless the user set a date", () => {
  assert.equal(applyStatusSideEffects({ status: "new" }, { ...BASE_FIELDS, status: "waiting" }, NOW).fields.waitingSince, "2026-09-24");
  assert.equal(applyStatusSideEffects({ status: "new" }, { ...BASE_FIELDS, status: "waiting", waitingSince: "2026-09-22" }, NOW).fields.waitingSince, "2026-09-22");
});

test("HISTORY: field diff + action classification + readable Czech lines", () => {
  const before = task({ status: "new", title: "A", dueDate: "2026-09-25" });
  const changes = diffTaskFields(before, { ...BASE_FIELDS, title: "B", status: "in_progress", dueDate: "2026-09-25" });
  assert.deepEqual(changes, [{ field: "title", from: "A", to: "B" }, { field: "status", from: "new", to: "in_progress" }]);
  assert.equal(historyActionForChanges(before, changes), "status_changed");
  assert.equal(historyActionForChanges(before, [{ field: "status", from: "new", to: "done" }]), "completed");
  assert.equal(historyActionForChanges({ status: "done" }, [{ field: "status", from: "done", to: "new" }]), "reopened");
  assert.equal(historyActionForChanges(before, [{ field: "title", from: "A", to: "B" }]), "updated");
  assert.equal(describeHistoryEntry({ id: "h", taskId: "t", action: "status_changed", changes: [{ field: "status", to: "in_progress" }], actorName: "Petr", createdAt: "" }), "Petr změnil stav → Rozpracováno");
  assert.equal(describeHistoryEntry({ id: "h", taskId: "t", action: "created", changes: [], actorName: "Jan", createdAt: "" }), "Jan vytvořil úkol");
  assert.equal(describeHistoryEntry({ id: "h", taskId: "t", action: "completed", changes: [], actorName: "Jan", createdAt: "" }), "Jan označil jako Hotovo");
});

// =========================================================================================
// Buckets, counts, views
// =========================================================================================

test("BUCKETS: overdue / today / upcoming (7 days) / later / no date; closed tasks never count as overdue", () => {
  assert.equal(taskDueBucket(task({ dueDate: "2026-09-23" }), TODAY), "overdue");
  assert.equal(taskDueBucket(task({ dueDate: TODAY }), TODAY), "today");
  assert.equal(taskDueBucket(task({ dueDate: "2026-10-01" }), TODAY), "upcoming");
  assert.equal(taskDueBucket(task({ dueDate: "2026-10-02" }), TODAY), "later");
  assert.equal(taskDueBucket(task({}), TODAY), "noDate");
  assert.equal(taskDueBucket(task({ dueDate: "2026-09-01", status: "done" }), TODAY), "closed");
  assert.equal(taskDueBucket(task({ dueDate: "2026-09-01", status: "cancelled" }), TODAY), "closed");
});

test("COUNTS: dashboard numbers + sidebar badge = overdue + today's open tasks", () => {
  const tasks = [
    task({ dueDate: "2026-09-20" }),
    task({ dueDate: "2026-09-22", status: "done" }),
    task({ dueDate: TODAY }),
    task({ dueDate: TODAY, status: "waiting" }),
    task({ dueDate: "2026-09-27", status: "review" }),
    task({ dueDate: "2026-09-28" }),
  ];
  assert.deepEqual(computeTaskCounts(tasks, TODAY), { today: 2, overdue: 1, thisWeek: 3, waiting: 1, review: 1, attention: 3 });
});

test("DNES view: Po termínu / Dnes / Nadcházející, each in the default order", () => {
  const overdue = task({ dueDate: "2026-09-23", title: "Zkontrolovat grafiku" });
  const todayUrgent = task({ dueDate: TODAY, priority: "urgent" });
  const todayNormal = task({ dueDate: TODAY });
  const soon = task({ dueDate: "2026-09-26" });
  const far = task({ dueDate: "2026-11-01" });
  const view = buildTodayView([far, soon, todayNormal, overdue, todayUrgent], TODAY);
  assert.deepEqual(view.overdue.map((t) => t.id), [overdue.id]);
  assert.deepEqual(view.today.map((t) => t.id), [todayUrgent.id, todayNormal.id]);
  assert.deepEqual(view.upcoming.map((t) => t.id), [soon.id]);
  assert.equal(describeDue(overdue, TODAY), "Včera");
});

test("WAITING: 'Čekáme N dní' with Czech plurals", () => {
  assert.equal(waitingDays({ waitingSince: "2026-09-21" }, TODAY), 3);
  assert.equal(formatWaitingDays(3), "Čekáme 3 dny");
  assert.equal(formatWaitingDays(1), "Čekáme 1 den");
  assert.equal(formatWaitingDays(7), "Čekáme 7 dní");
  assert.equal(formatWaitingDays(0), "Čekáme od dneška");
});

test("TABS: all = open, waiting, review, done = done + cancelled", () => {
  const tasks = [task({ status: "new" }), task({ status: "waiting" }), task({ status: "review" }), task({ status: "done" }), task({ status: "cancelled" })];
  assert.equal(tasksForTab(tasks, "all").length, 3);
  assert.equal(tasksForTab(tasks, "waiting").length, 1);
  assert.equal(tasksForTab(tasks, "review").length, 1);
  assert.equal(tasksForTab(tasks, "done").length, 2);
});

// =========================================================================================
// Filters + sorting
// =========================================================================================

const FILTER_SET = [
  task({ title: "Zkontrolovat grafiku panelů A–F", eventId: "beauty", companyName: "Collamedic", standNumber: "3B24", categoryId: "graphics", priority: "high", assigneeName: "Jan", dueDate: TODAY }),
  task({ title: "Potvrdit zásuvku", eventId: "beauty", companyName: "Manishop", standNumber: "3B10", categoryId: "electricity", status: "waiting", assigneeName: "Petr", realizationCompanyId: "abf" }),
  task({ title: "Logo v křivkách", eventId: "decor", companyName: "Mizon", standNumber: "1A02", categoryId: "graphics", dueDate: "2026-09-20" }),
];

test("FILTERS: every field combines (AND); company/assignee compare case- and diacritics-insensitively", () => {
  const f = (update: Partial<typeof EMPTY_TASK_FILTERS>) => applyTaskFilters(FILTER_SET, { ...EMPTY_TASK_FILTERS, ...update }, TODAY).map((t) => t.title);
  assert.deepEqual(f({ eventId: "beauty", categoryId: "graphics" }), ["Zkontrolovat grafiku panelů A–F"]);
  assert.deepEqual(f({ companyName: "COLLAMEDIC" }), ["Zkontrolovat grafiku panelů A–F"]);
  assert.deepEqual(f({ standNumber: "3 B10" }), ["Potvrdit zásuvku"]);
  assert.deepEqual(f({ realizationCompanyId: "abf" }), ["Potvrdit zásuvku"]);
  assert.deepEqual(f({ assigneeName: "petr" }), ["Potvrdit zásuvku"]);
  assert.deepEqual(f({ priority: "high" }), ["Zkontrolovat grafiku panelů A–F"]);
  assert.deepEqual(f({ status: "waiting" }), ["Potvrdit zásuvku"]);
  assert.deepEqual(f({ due: "overdue" }), ["Logo v křivkách"]);
  assert.deepEqual(f({ due: "today" }), ["Zkontrolovat grafiku panelů A–F"]);
  assert.deepEqual(f({ due: "noDate" }), ["Potvrdit zásuvku"]);
  assert.equal(hasActiveTaskFilters(EMPTY_TASK_FILTERS), false);
  assert.equal(hasActiveTaskFilters({ ...EMPTY_TASK_FILTERS, query: "x" }), true);
});

test("FULLTEXT: 'Hledat úkol, firmu nebo stánek…' matches title, company, stand and event name without diacritics", () => {
  const search = (query: string) => applyTaskFilters(FILTER_SET, { ...EMPTY_TASK_FILTERS, query }, TODAY, (id) => (id === "decor" ? "FOR DECOR 2026" : "FOR BEAUTY 2026")).map((t) => t.title);
  assert.deepEqual(search("panelu"), ["Zkontrolovat grafiku panelů A–F"]);
  assert.deepEqual(search("mizon"), ["Logo v křivkách"]);
  assert.deepEqual(search("3b24"), ["Zkontrolovat grafiku panelů A–F"]);
  assert.deepEqual(search("for decor"), ["Logo v křivkách"]);
});

test("FILTER OPTIONS are derived from the loaded tasks", () => {
  const options = buildTaskFilterOptions(FILTER_SET);
  assert.deepEqual(options.companies, ["Collamedic", "Manishop", "Mizon"]);
  assert.deepEqual(options.standNumbers, ["1A02", "3B10", "3B24"]);
  assert.deepEqual(options.assignees, ["Jan", "Petr"]);
  assert.deepEqual(options.eventIds, ["beauty", "decor"]);
});

test("SORT default: overdue → urgent → today → nearest due → no due date → closed", () => {
  const noDate = task({ title: "bez termínu" });
  const later = task({ title: "později", dueDate: "2026-10-10" });
  const soon = task({ title: "brzy", dueDate: "2026-09-26" });
  const today = task({ title: "dnes", dueDate: TODAY });
  const urgentLater = task({ title: "urgentní", dueDate: "2026-10-20", priority: "urgent" });
  const overdue = task({ title: "po termínu", dueDate: "2026-09-10" });
  const done = task({ title: "hotovo", dueDate: "2026-09-01", status: "done" });
  const sorted = sortTasks([noDate, later, done, soon, today, urgentLater, overdue], "default", TODAY).map((t) => t.title);
  assert.deepEqual(sorted, ["po termínu", "urgentní", "dnes", "brzy", "později", "bez termínu", "hotovo"]);
});

test("SORT options: due, priority, company, stand (natural), created (newest first)", () => {
  const a = task({ title: "a", companyName: "Zeta", standNumber: "1A10", priority: "low", dueDate: "2026-09-30", createdAt: "2026-09-01T00:00:00.000Z" });
  const b = task({ title: "b", companyName: "Alfa", standNumber: "1A9", priority: "urgent", dueDate: "2026-09-25", createdAt: "2026-09-03T00:00:00.000Z" });
  const c = task({ title: "c", priority: "high", createdAt: "2026-09-02T00:00:00.000Z" });
  const ids = (sort: Parameters<typeof sortTasks>[1]) => sortTasks([a, b, c], sort, TODAY).map((t) => t.title);
  assert.deepEqual(ids("due"), ["b", "a", "c"]);
  assert.deepEqual(ids("priority"), ["b", "c", "a"]);
  assert.deepEqual(ids("company"), ["b", "a", "c"]);
  assert.deepEqual(ids("stand"), ["b", "a", "c"]);
  assert.deepEqual(ids("created"), ["b", "c", "a"]);
});

// =========================================================================================
// Links to the generator
// =========================================================================================

test("CONTEXT: '+ Úkol' from a stand pre-fills event, company, stand, realizačka and source", () => {
  const input = taskInputFromContext({ eventId: "beauty", companyName: "Collamedic", standNumber: "3B 24", realizationCompanyId: "abf", sourceType: "booth_project", sourceId: "project-1" });
  assert.deepEqual(input, { title: "", priority: "normal", status: "new", eventId: "beauty", companyName: "Collamedic", standNumber: "3B24", realizationCompanyId: "abf", sourceType: "booth_project", sourceId: "project-1" });
  assert.equal(taskInputFromContext(undefined).sourceType, "manual");
});

test("STAND / EVENT links: a stand's tasks = same source record OR same event + stand number", () => {
  const fromProject = task({ sourceType: "booth_project", sourceId: "p1" });
  const sameStand = task({ eventId: "beauty", standNumber: "3B24" });
  const otherEvent = task({ eventId: "decor", standNumber: "3B24" });
  const unrelated = task({ eventId: "beauty", standNumber: "3B25" });
  const all = [fromProject, sameStand, otherEvent, unrelated];
  assert.deepEqual(tasksForStand(all, { eventId: "beauty", standNumber: "3B 24", sourceType: "booth_project", sourceId: "p1" }).map((t) => t.id), [fromProject.id, sameStand.id]);
  assert.deepEqual(tasksForStand(all, { sourceType: "booth_project", sourceId: "missing" }), [], "no stand identity -> nothing, never 'all tasks'");
  assert.deepEqual(tasksForEvent(all, "beauty").map((t) => t.id), [sameStand.id, unrelated.id]);
});

test("RECURRENCE (model only): daily / weekly / weekdays skip the weekend / custom interval", () => {
  assert.equal(nextRecurrenceDate({ frequency: "daily" }, TODAY), "2026-09-25");
  assert.equal(nextRecurrenceDate({ frequency: "weekly" }, TODAY), "2026-10-01");
  assert.equal(nextRecurrenceDate({ frequency: "weekdays" }, "2026-09-25"), "2026-09-28");
  assert.equal(nextRecurrenceDate({ frequency: "interval_days", intervalDays: 3 }, TODAY), "2026-09-27");
});

// =========================================================================================
// Calendar + milestones
// =========================================================================================

const EVENT = {
  id: "beauty",
  name: "FOR BEAUTY 2026",
  assemblyDate: "2026-10-12",
  eventFrom: "2026-10-15",
  eventTo: "2026-10-17",
  disassemblyDate: "2026-10-18",
  materialDataDeadline: "2026-09-30",
  designApprovalDeadline: "",
  deadlines: [{ id: "d1", name: "Uzávěrka technických objednávek", date: "2026-10-01" }, { id: "d2", name: "Bez data", date: "" }],
};

test("MILESTONES are derived from the existing event dates (never stored twice); empty dates are skipped", () => {
  const milestones = deriveEventMilestones(EVENT);
  assert.deepEqual(milestones.map((m) => [m.date, m.label]), [
    ["2026-09-30", "Deadline dodání materiálů / dat"],
    ["2026-10-01", "Uzávěrka technických objednávek"],
    ["2026-10-12", "Začátek montáže"],
    ["2026-10-15", "Začátek veletrhu"],
    ["2026-10-17", "Konec veletrhu"],
    ["2026-10-18", "Demontáž"],
  ]);
  assert.ok(milestones.every((m) => m.eventId === "beauty"));
});

test("CALENDAR grids: Monday-first month weeks, week days, anchor shifting, items grouped by date", () => {
  const grid = buildMonthGrid(2026, 9);
  assert.equal(grid[0]![0], "2026-08-31");
  assert.equal(grid.at(-1)![6], "2026-10-04");
  assert.ok(grid.every((week) => week.length === 7));
  assert.deepEqual(buildWeekDays(TODAY), ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"]);
  assert.equal(shiftCalendarAnchor("2026-01-31", "month", 1), "2026-02-01");
  assert.equal(shiftCalendarAnchor(TODAY, "week", -1), "2026-09-17");
  const later = task({ dueDate: TODAY, dueTime: "15:00", title: "b" });
  const early = task({ dueDate: TODAY, dueTime: "08:00", title: "a" });
  const grouped = groupCalendarItems([later, early, task({})], deriveEventMilestones(EVENT));
  assert.deepEqual(grouped.get(TODAY)!.tasks.map((t) => t.title), ["a", "b"]);
  assert.equal(grouped.get("2026-10-15")!.milestones[0]!.label, "Začátek veletrhu");
});

// =========================================================================================
// Stand checklist
// =========================================================================================

const DEFAULT_TEMPLATE: StandChecklistTemplate = { id: "default", name: "Výchozí", isDefault: true, items: [{ key: "construction", label: "Konstrukce" }, { key: "graphics", label: "Grafika" }] };
const EVENT_TEMPLATE: StandChecklistTemplate = { id: "beauty", name: "FOR BEAUTY", eventId: "beauty", isDefault: false, items: [{ key: "carpet", label: "Koberec" }] };

test("CHECKLIST: event template wins over the default; stored state is merged in template order; stale keys ignored", () => {
  assert.equal(resolveChecklistTemplate([DEFAULT_TEMPLATE, EVENT_TEMPLATE], "beauty")?.id, "beauty");
  assert.equal(resolveChecklistTemplate([DEFAULT_TEMPLATE, EVENT_TEMPLATE], "decor")?.id, "default");
  const checklist = buildStandChecklist(DEFAULT_TEMPLATE, [
    { eventId: "decor", standNumber: "3B24", itemKey: "graphics", isDone: true, doneBy: "Jan", doneAt: "2026-09-24T10:00:00.000Z" },
    { eventId: "decor", standNumber: "3B24", itemKey: "removed-item", isDone: true },
  ]);
  assert.deepEqual(checklist.items.map((item) => [item.label, item.isDone]), [["Konstrukce", false], ["Grafika", true]]);
  assert.equal(checklist.doneCount, 1);
  assert.equal(checklist.totalCount, 2);
});

test("CHECKLIST: needs event + stand number; template items must have unique keys", () => {
  assert.deepEqual(resolveStandKey("beauty", " 3B 24 "), { eventId: "beauty", standNumber: "3B24" });
  assert.equal(resolveStandKey(undefined, "3B24"), undefined);
  assert.equal(resolveStandKey("beauty", "  "), undefined);
  assert.equal(validateChecklistItems([{ key: "a", label: "A" }, { key: "a", label: "B" }]), "Položka „a“ je v checklistu dvakrát.");
  assert.equal(validateChecklistItems(DEFAULT_TEMPLATE.items), undefined);
});

// =========================================================================================
// Automatic tasks
// =========================================================================================

function makeAsset(id: string): StoredAsset {
  return { id, storageKey: `k/${id}.pdf`, originalFileName: `${id}.pdf`, mimeType: "application/pdf", size: 1, createdAt: "2026-01-01T00:00:00.000Z", category: "technical-raster-import" };
}

test("AUTOMATIC: technical-raster rule proposes 'Umístit …' per matched stand + category with a stable key; the planner never duplicates", () => {
  let project = createTechnicalRasterProject({ name: "Hala 3", eventId: "beauty" }, "raster-1");
  const report: ParsedTechnicalReport = {
    category: "electricity",
    rows: [
      { standNumber: "3B24", companyName: "Collamedic", services: [{ category: "electricity", externalLabel: "Do 3kW 230V", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] },
      { standNumber: "3B25", services: [{ category: "electricity", externalLabel: "Do 3kW 230V", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] },
    ],
    warnings: [],
  };
  project = mergeTechnicalRasterImport(project, { id: "imp", category: "electricity", filename: "el.pdf", asset: makeAsset("el"), importedAt: "2026-01-01T00:00:00.000Z", parserVersion: "v1", parseStatus: "ok", standsFound: 2, servicesFound: 2, warnings: [] }, report, () => ({ status: "unresolved_product" as const }));
  for (const stand of project.stands) project = assignStandManually(project, stand.id, { page: 1, anchorXNormalized: 0.5, anchorYNormalized: 0.5 });
  const placed = project.stands.find((stand) => stand.standNumber === "3B25")!;
  project = placeTechnicalService(project, placed.id, placed.services[0]!.id, { page: 1, xNormalized: 0.1, yNormalized: 0.1 });

  const candidates = technicalRasterUnplacedServicesRule.evaluate(project);
  assert.equal(candidates.length, 1, "3B25 is already placed");
  assert.equal(candidates[0]!.input.title, "Umístit elektrickou přípojku");
  assert.equal(candidates[0]!.input.standNumber, "3B24");
  assert.equal(candidates[0]!.input.companyName, "Collamedic");
  assert.equal(candidates[0]!.input.sourceType, "technical_raster_project");
  assert.equal(candidates[0]!.automationKey, "technical-raster-unplaced-services:raster-1:3B24:electricity");
  assert.deepEqual(planAutomaticTasks([...candidates, ...candidates], new Set()), candidates, "duplicate keys in one run collapse");
  assert.deepEqual(planAutomaticTasks(candidates, new Set([candidates[0]!.automationKey])), [], "an existing key is never recreated");
});
