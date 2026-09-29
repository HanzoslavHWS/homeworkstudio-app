import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { approveTask, createAutomaticTasks, createTask, returnTask, setTaskStatus, TaskValidationError, updateTask } from "../domain/taskService.ts";
import type { Task, TaskCategory, TaskFields, TaskHistoryEntry, TaskHistoryInput, TaskRepository, TaskSystemFields } from "../domain/tasks.ts";
import type { StandChecklistEntry, StandChecklistRepository, StandChecklistTemplate, StandKey } from "../domain/standChecklist.ts";
import { resolveCanonicalEventId } from "../domain/eventIdentity.ts";
import { createSessionToken } from "../lib/auth/session.ts";
import type { TaskApiDependencies } from "../lib/tasks/taskApi.server.ts";
import { handleTaskList } from "../app/api/tasks/list/route.ts";
import { handleTaskSave } from "../app/api/tasks/save/route.ts";
import { handleTaskAction } from "../app/api/tasks/action/route.ts";
import { handleTaskDelete } from "../app/api/tasks/delete/route.ts";
import { handleTaskHistory } from "../app/api/tasks/history/route.ts";
import { handleChecklistGet, handleChecklistToggle } from "../app/api/tasks/checklist/route.ts";

// =========================================================================================
// Úkoly — server-side task service + API routes. In-memory repositories stand in for Supabase
// (same contract as lib/db/taskRepository.supabase.ts); routes run through their real handlers.
// =========================================================================================

function memoryTaskRepository() {
  const tasks = new Map<string, Task>();
  const history: TaskHistoryEntry[] = [];
  let sequence = 0;
  const repository: TaskRepository = {
    async list() { return [...tasks.values()]; },
    async get(id) { return tasks.get(id); },
    async create(fields: TaskFields, system: TaskSystemFields) {
      sequence += 1;
      const now = new Date(Date.UTC(2026, 8, 24, 8, sequence)).toISOString();
      const task: Task = { ...fields, id: `task-${sequence}`, isAutomatic: system.isAutomatic ?? false, automationKey: system.automationKey, createdBy: system.createdBy, completedAt: system.completedAt ?? undefined, createdAt: now, updatedAt: now };
      tasks.set(task.id, task);
      return task;
    },
    async update(id, fields, system) {
      const before = tasks.get(id)!;
      const completedAt = system.completedAt === undefined ? before.completedAt : system.completedAt ?? undefined;
      const task: Task = { ...before, ...fields, completedAt, updatedAt: new Date().toISOString() };
      // A field absent from `fields` means "cleared" — mirror fieldsToRow's null writes.
      for (const key of ["description", "categoryId", "dueDate", "dueTime", "eventId", "companyName", "standNumber", "realizationCompanyId", "assigneeName", "sourceId", "waitingSince"] as const) {
        if (!(key in fields) || fields[key] === undefined) (task as Record<string, unknown>)[key] = undefined;
      }
      tasks.set(id, task);
      return task;
    },
    async delete(id) { tasks.delete(id); },
    async listCategories(): Promise<readonly TaskCategory[]> { return [{ id: "graphics", name: "Grafika", sortOrder: 10, isActive: true }]; },
    async listHistory(taskId) { return history.filter((entry) => entry.taskId === taskId); },
    async appendHistory(entry: TaskHistoryInput) { history.push({ ...entry, id: `h-${history.length + 1}`, createdAt: new Date().toISOString() }); },
    async listAutomationKeys() { return new Set([...tasks.values()].map((task) => task.automationKey).filter((key): key is string => Boolean(key))); },
  };
  return { repository, tasks, history };
}

const ACTOR = { actorName: "Jan", now: new Date(2026, 8, 24, 12, 0) };

// =========================================================================================
// Service
// =========================================================================================

test("SERVICE create: validates, persists as a MANUAL task with the author, writes a 'created' history row", async () => {
  const { repository, history } = memoryTaskRepository();
  const task = await createTask(repository, { title: " Zkontrolovat grafiku panelů A–F ", eventId: "beauty", companyName: "Collamedic", standNumber: "3B24", priority: "high", dueDate: "2026-09-25" }, ACTOR);
  assert.equal(task.title, "Zkontrolovat grafiku panelů A–F");
  assert.equal(task.isAutomatic, false);
  assert.equal(task.createdBy, "Jan");
  assert.deepEqual(history.map((entry) => [entry.action, entry.actorName]), [["created", "Jan"]]);
  await assert.rejects(createTask(repository, { title: "" }, ACTOR), TaskValidationError);
});

test("SERVICE update: records a field diff; an update that changes nothing writes nothing", async () => {
  const { repository, history } = memoryTaskRepository();
  const task = await createTask(repository, { title: "A" }, ACTOR);
  await updateTask(repository, task.id, { title: "A" }, ACTOR);
  assert.equal(history.length, 1, "no-op update -> no history row");
  const updated = await updateTask(repository, task.id, { title: "B", status: "in_progress" }, { actorName: "Petr" });
  assert.equal(updated.title, "B");
  assert.deepEqual(history.at(-1)!.action, "status_changed");
  assert.equal(history.at(-1)!.actorName, "Petr");
  assert.deepEqual(history.at(-1)!.changes.map((change) => change.field), ["title", "status"]);
});

test("SERVICE complete / undo: done stamps completedAt ('completed'); undo clears it ('reopened')", async () => {
  const { repository, history } = memoryTaskRepository();
  const task = await createTask(repository, { title: "A" }, ACTOR);
  const done = await setTaskStatus(repository, task.id, "done", ACTOR);
  assert.equal(done.status, "done");
  assert.equal(done.completedAt, ACTOR.now.toISOString());
  assert.equal(history.at(-1)!.action, "completed");
  const undone = await setTaskStatus(repository, task.id, "new", ACTOR);
  assert.equal(undone.completedAt, undefined);
  assert.equal(history.at(-1)!.action, "reopened");
});

test("SERVICE waiting: entering 'Čekáme' stamps 'Čekáme od' today", async () => {
  const { repository } = memoryTaskRepository();
  const task = await createTask(repository, { title: "Čekáme na logo v křivkách" }, ACTOR);
  assert.equal((await setTaskStatus(repository, task.id, "waiting", ACTOR)).waitingSince, "2026-09-24");
});

test("SERVICE review: Schválit ✓ -> Hotovo ('approved'); Vrátit zpět requires a note -> Rozpracováno ('returned' + note)", async () => {
  const { repository, history } = memoryTaskRepository();
  const task = await createTask(repository, { title: "Připravit tisková data", status: "review" }, ACTOR);
  await assert.rejects(returnTask(repository, task.id, "  ", ACTOR), /Napište, proč/u);
  const returned = await returnTask(repository, task.id, "Chybí spadávka", ACTOR);
  assert.equal(returned.status, "in_progress");
  assert.deepEqual([history.at(-1)!.action, history.at(-1)!.note], ["returned", "Chybí spadávka"]);
  await setTaskStatus(repository, task.id, "review", ACTOR);
  const approved = await approveTask(repository, task.id, ACTOR);
  assert.equal(approved.status, "done");
  assert.ok(approved.completedAt);
  assert.equal(history.at(-1)!.action, "approved");
});

test("SERVICE automatic: candidates become AUTOMATIC tasks with their key; re-running never duplicates", async () => {
  const { repository, tasks } = memoryTaskRepository();
  const candidate = { ruleId: "rule", automationKey: "rule:1", input: { title: "Umístit internet", standNumber: "3B24" } };
  const created = await createAutomaticTasks(repository, [candidate]);
  assert.equal(created.length, 1);
  assert.equal(created[0]!.isAutomatic, true);
  assert.equal(created[0]!.automationKey, "rule:1");
  assert.equal((await createAutomaticTasks(repository, [candidate])).length, 0);
  assert.equal(tasks.size, 1);
});

// =========================================================================================
// API routes
// =========================================================================================

const SECRET = "tasks-api-test-session-secret-32-characters";
(process.env as Record<string, string | undefined>).APP_SESSION_SECRET = SECRET;

function memoryChecklistRepository(): StandChecklistRepository & { entries: StandChecklistEntry[] } {
  const templates: StandChecklistTemplate[] = [{ id: "default", name: "Výchozí", isDefault: true, items: [{ key: "construction", label: "Konstrukce" }, { key: "graphics", label: "Grafika" }] }];
  const entries: StandChecklistEntry[] = [];
  return {
    entries,
    async listTemplates() { return templates; },
    async listEntries(stand: StandKey) { return entries.filter((entry) => entry.eventId === stand.eventId && entry.standNumber === stand.standNumber); },
    async setEntry(stand, itemKey, isDone, doneBy) {
      const index = entries.findIndex((entry) => entry.eventId === stand.eventId && entry.standNumber === stand.standNumber && entry.itemKey === itemKey);
      const entry = { ...stand, itemKey, isDone, doneBy: isDone ? doneBy : undefined };
      if (index >= 0) entries[index] = entry; else entries.push(entry);
      return entry;
    },
  };
}

function dependencies() {
  const tasks = memoryTaskRepository();
  const checklist = memoryChecklistRepository();
  const deps: TaskApiDependencies = {
    taskRepository: () => tasks.repository,
    checklistRepository: () => checklist,
    resolveEventId: () => async (eventId) => {
      if (!eventId?.trim()) return { ok: true, eventId: undefined };
      const canonical = resolveCanonicalEventId(eventId, ["beauty", "decor"]);
      return canonical ? { ok: true, eventId: canonical } : { ok: false, message: "Vybraný veletrh není v databázi." };
    },
  };
  return { deps, tasks, checklist };
}

async function request(url: string, body?: unknown, authenticated = true): Promise<NextRequest> {
  const headers: Record<string, string> = {};
  if (authenticated) headers.Cookie = `homeworkstudio_session=${await createSessionToken(SECRET)}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new NextRequest(`http://localhost${url}`, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

test("API: every task route requires the app session (401) — same auth principle as the other modules", async () => {
  const { deps } = dependencies();
  assert.equal((await handleTaskList(await request("/api/tasks/list", undefined, false), deps)).status, 401);
  assert.equal((await handleTaskSave(await request("/api/tasks/save", { task: { title: "x" } }, false), deps)).status, 401);
  assert.equal((await handleTaskAction(await request("/api/tasks/action", { id: "x" }, false), deps)).status, 401);
  assert.equal((await handleTaskDelete(await request("/api/tasks/delete", { id: "x" }, false), deps)).status, 401);
  assert.equal((await handleTaskHistory(await request("/api/tasks/history?id=x", undefined, false), deps)).status, 401);
  assert.equal((await handleChecklistGet(await request("/api/tasks/checklist?eventId=beauty&standNumber=3B24", undefined, false), deps)).status, 401);
});

test("API save: creates with the actor; a legacy event id is stored canonically; unknown event / invalid input -> 400", async () => {
  const { deps, tasks } = dependencies();
  const created = await handleTaskSave(await request("/api/tasks/save", { task: { title: "Zkontrolovat grafiku", eventId: "for-beauty-autumn-2026", standNumber: "3B24" }, actorName: "Jan" }), deps);
  assert.equal(created.status, 200);
  const { task } = (await created.json()) as { task: Task };
  assert.equal(task.eventId, "beauty");
  assert.equal(task.createdBy, "Jan");
  assert.equal((await handleTaskSave(await request("/api/tasks/save", { task: { title: "x", eventId: "nope" } }), deps)).status, 400);
  assert.equal((await handleTaskSave(await request("/api/tasks/save", { task: { title: "" } }), deps)).status, 400);
  const updated = await handleTaskSave(await request("/api/tasks/save", { id: task.id, task: { title: "Zkontrolovat grafiku panelů A–F", eventId: "beauty" } }), deps);
  assert.equal(((await updated.json()) as { task: Task }).task.title, "Zkontrolovat grafiku panelů A–F");
  assert.equal(tasks.tasks.size, 1, "update never creates a second task");
  assert.equal((await handleTaskSave(await request("/api/tasks/save", { id: "missing", task: { title: "x" } }), deps)).status, 404);
});

test("API action + history + delete: done/undo, return needs a note, history is readable, delete removes the task", async () => {
  const { deps, tasks } = dependencies();
  const task = await createTask(tasks.repository, { title: "A", status: "review" }, ACTOR);
  assert.equal((await handleTaskAction(await request("/api/tasks/action", { id: task.id, action: "return" }), deps)).status, 400);
  assert.equal((await handleTaskAction(await request("/api/tasks/action", { id: task.id, action: "setStatus", status: "bogus" }), deps)).status, 400);
  const approved = await handleTaskAction(await request("/api/tasks/action", { id: task.id, action: "approve", actorName: "Jan" }), deps);
  assert.equal(((await approved.json()) as { task: Task }).task.status, "done");
  const historyResponse = await handleTaskHistory(await request(`/api/tasks/history?id=${task.id}`), deps);
  assert.deepEqual(((await historyResponse.json()) as { history: TaskHistoryEntry[] }).history.map((entry) => entry.action), ["created", "approved"]);
  assert.equal((await handleTaskDelete(await request("/api/tasks/delete", { id: task.id }), deps)).status, 200);
  assert.equal(tasks.tasks.size, 0);
});

test("API checklist: GET resolves the template; POST toggles only template keys and records who", async () => {
  const { deps, checklist } = dependencies();
  assert.equal((await handleChecklistGet(await request("/api/tasks/checklist?eventId=beauty"), deps)).status, 400, "needs a stand number");
  const initial = (await (await handleChecklistGet(await request("/api/tasks/checklist?eventId=beauty&standNumber=3B24"), deps)).json()) as { checklist: { doneCount: number; totalCount: number } };
  assert.deepEqual([initial.checklist.doneCount, initial.checklist.totalCount], [0, 2]);
  assert.equal((await handleChecklistToggle(await request("/api/tasks/checklist", { eventId: "beauty", standNumber: "3B24", itemKey: "unknown", isDone: true }), deps)).status, 400);
  const toggled = (await (await handleChecklistToggle(await request("/api/tasks/checklist", { eventId: "beauty", standNumber: "3B 24", itemKey: "graphics", isDone: true, actorName: "Jan" }), deps)).json()) as { checklist: { doneCount: number } };
  assert.equal(toggled.checklist.doneCount, 1);
  assert.deepEqual(checklist.entries, [{ eventId: "beauty", standNumber: "3B24", itemKey: "graphics", isDone: true, doneBy: "Jan" }]);
});
