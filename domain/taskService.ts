/**
 * Úkoly — the ONE place tasks are created/changed. Runs server-side (app/api/tasks/*), so every
 * change goes through validation, status side effects (completedAt / waitingSince) and writes a
 * task_history row — the browser never writes history itself.
 */
import {
  applyStatusSideEffects,
  diffTaskFields,
  historyActionForChanges,
  normalizeTaskInput,
  taskToInput,
  type Task,
  type TaskHistoryAction,
  type TaskInput,
  type TaskRepository,
  type TaskStatus,
} from "./tasks.ts";
import { planAutomaticTasks, type AutomaticTaskCandidate } from "./automaticTasks.ts";

export class TaskValidationError extends Error {}
export class TaskNotFoundError extends Error {
  constructor() { super("Úkol nebyl nalezen."); }
}

export type TaskActor = Readonly<{ actorName?: string; now?: Date }>;

function actorName(actor: TaskActor): string | undefined {
  return actor.actorName?.trim() || undefined;
}

export async function createTask(repository: TaskRepository, input: TaskInput, actor: TaskActor = {}): Promise<Task> {
  const validation = normalizeTaskInput(input);
  if (validation.ok === false) throw new TaskValidationError(validation.message);
  const now = actor.now ?? new Date();
  const { fields, completedAt } = applyStatusSideEffects(undefined, validation.value, now);
  const task = await repository.create(fields, { createdBy: actorName(actor), isAutomatic: false, completedAt: completedAt ?? undefined });
  await repository.appendHistory({ taskId: task.id, action: "created", changes: [], actorName: actorName(actor) });
  return task;
}

/**
 * Full update from the edit form. `action` overrides the inferred history action (approve/return);
 * a change set that changes nothing is a no-op (no write, no history row) unless a note is given.
 */
export async function updateTask(
  repository: TaskRepository,
  id: string,
  input: TaskInput,
  actor: TaskActor = {},
  options: Readonly<{ action?: TaskHistoryAction; note?: string }> = {},
): Promise<Task> {
  const before = await repository.get(id);
  if (!before) throw new TaskNotFoundError();
  const validation = normalizeTaskInput(input);
  if (validation.ok === false) throw new TaskValidationError(validation.message);
  const now = actor.now ?? new Date();
  const { fields, completedAt } = applyStatusSideEffects(before, validation.value, now);
  const changes = diffTaskFields(before, fields);
  const note = options.note?.trim() || undefined;
  if (changes.length === 0 && !note) return before;
  const task = changes.length > 0 ? await repository.update(id, fields, { completedAt }) : before;
  await repository.appendHistory({ taskId: id, action: options.action ?? historyActionForChanges(before, changes), changes, note, actorName: actorName(actor) });
  return task;
}

/** Quick status change (checkbox, undo, "Schválit ✓"). */
export async function setTaskStatus(repository: TaskRepository, id: string, status: TaskStatus, actor: TaskActor = {}, options: Readonly<{ action?: TaskHistoryAction; note?: string }> = {}): Promise<Task> {
  const before = await repository.get(id);
  if (!before) throw new TaskNotFoundError();
  return updateTask(repository, id, { ...taskToInput(before), status }, actor, options);
}

/** "Ke kontrole" → Schválit ✓ (becomes Hotovo). */
export async function approveTask(repository: TaskRepository, id: string, actor: TaskActor = {}, note?: string): Promise<Task> {
  return setTaskStatus(repository, id, "done", actor, { action: "approved", note });
}

/** "Ke kontrole" → Vrátit zpět (back to Rozpracováno) — a note explaining why is required. */
export async function returnTask(repository: TaskRepository, id: string, note: string, actor: TaskActor = {}): Promise<Task> {
  if (!note.trim()) throw new TaskValidationError("Napište, proč se úkol vrací.");
  return setTaskStatus(repository, id, "in_progress", actor, { action: "returned", note });
}

export async function deleteTask(repository: TaskRepository, id: string): Promise<void> {
  await repository.delete(id);
}

/**
 * Creates the automatic tasks that don't exist yet (dedupe by automation key). Automatic tasks are
 * flagged is_automatic = true and keep their automation_key, so a rule re-running never duplicates them.
 */
export async function createAutomaticTasks(repository: TaskRepository, candidates: readonly AutomaticTaskCandidate[], actor: TaskActor = {}): Promise<readonly Task[]> {
  const toCreate = planAutomaticTasks(candidates, await repository.listAutomationKeys());
  const created: Task[] = [];
  for (const candidate of toCreate) {
    const validation = normalizeTaskInput(candidate.input);
    if (validation.ok === false) continue;
    const task = await repository.create(validation.value, { createdBy: actorName(actor) ?? "Automaticky", isAutomatic: true, automationKey: candidate.automationKey });
    await repository.appendHistory({ taskId: task.id, action: "created", changes: [], note: `Automatické pravidlo: ${candidate.ruleId}`, actorName: actorName(actor) ?? "Automaticky" });
    created.push(task);
  }
  return created;
}
