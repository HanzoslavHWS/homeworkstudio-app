import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Task,
  TaskCategory,
  TaskChange,
  TaskFields,
  TaskHistoryAction,
  TaskHistoryEntry,
  TaskHistoryInput,
  TaskPriority,
  TaskRepository,
  TaskSourceType,
  TaskStatus,
  TaskSystemFields,
} from "../../domain/tasks.ts";

type TaskRow = Readonly<{
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  category_id: string | null;
  due_date: string | null;
  due_time: string | null;
  event_id: string | null;
  company_name: string | null;
  stand_number: string | null;
  realization_company_id: string | null;
  assignee_name: string | null;
  created_by: string | null;
  source_type: string;
  source_id: string | null;
  is_automatic: boolean;
  automation_key: string | null;
  waiting_since: string | null;
  recurring_rule_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}>;

type TaskHistoryRow = Readonly<{
  id: string;
  task_id: string;
  action: string;
  changes: unknown;
  note: string | null;
  actor_name: string | null;
  created_at: string;
}>;

type TaskCategoryRow = Readonly<{ id: string; name: string; sort_order: number; is_active: boolean }>;

export function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    categoryId: row.category_id ?? undefined,
    dueDate: row.due_date ?? undefined,
    // Postgres `time` comes back as "HH:MM:SS" — the app works with "HH:MM".
    dueTime: row.due_time ? row.due_time.slice(0, 5) : undefined,
    eventId: row.event_id ?? undefined,
    companyName: row.company_name ?? undefined,
    standNumber: row.stand_number ?? undefined,
    realizationCompanyId: row.realization_company_id ?? undefined,
    assigneeName: row.assignee_name ?? undefined,
    createdBy: row.created_by ?? undefined,
    sourceType: row.source_type as TaskSourceType,
    sourceId: row.source_id ?? undefined,
    isAutomatic: row.is_automatic,
    automationKey: row.automation_key ?? undefined,
    waitingSince: row.waiting_since ?? undefined,
    recurringRuleId: row.recurring_rule_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function fieldsToRow(fields: TaskFields) {
  return {
    title: fields.title,
    description: fields.description ?? null,
    status: fields.status,
    priority: fields.priority,
    category_id: fields.categoryId ?? null,
    due_date: fields.dueDate ?? null,
    due_time: fields.dueTime ?? null,
    event_id: fields.eventId ?? null,
    company_name: fields.companyName ?? null,
    stand_number: fields.standNumber ?? null,
    realization_company_id: fields.realizationCompanyId ?? null,
    assignee_name: fields.assigneeName ?? null,
    source_type: fields.sourceType,
    source_id: fields.sourceId ?? null,
    waiting_since: fields.waitingSince ?? null,
  };
}

function rowToHistory(row: TaskHistoryRow): TaskHistoryEntry {
  return {
    id: row.id,
    taskId: row.task_id,
    action: row.action as TaskHistoryAction,
    changes: Array.isArray(row.changes) ? (row.changes as TaskChange[]) : [],
    note: row.note ?? undefined,
    actorName: row.actor_name ?? undefined,
    createdAt: row.created_at,
  };
}

export class SupabaseTaskRepository implements TaskRepository {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async list(): Promise<readonly Task[]> {
    const { data, error } = await this.client.from("tasks").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    return ((data ?? []) as TaskRow[]).map(rowToTask);
  }

  async get(id: string): Promise<Task | undefined> {
    const { data, error } = await this.client.from("tasks").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return data ? rowToTask(data as TaskRow) : undefined;
  }

  async create(fields: TaskFields, system: TaskSystemFields): Promise<Task> {
    const { data, error } = await this.client
      .from("tasks")
      .insert({
        ...fieldsToRow(fields),
        created_by: system.createdBy ?? null,
        is_automatic: system.isAutomatic ?? false,
        automation_key: system.automationKey ?? null,
        completed_at: system.completedAt ?? null,
      })
      .select()
      .single();
    if (error) throw error;
    return rowToTask(data as TaskRow);
  }

  async update(id: string, fields: TaskFields, system: TaskSystemFields): Promise<Task> {
    const patch: Record<string, unknown> = fieldsToRow(fields);
    // undefined = leave completed_at as it is; null = clear it; a string = set it.
    if (system.completedAt !== undefined) patch.completed_at = system.completedAt;
    const { data, error } = await this.client.from("tasks").update(patch).eq("id", id).select().single();
    if (error) throw error;
    return rowToTask(data as TaskRow);
  }

  async delete(id: string): Promise<void> {
    const { error } = await this.client.from("tasks").delete().eq("id", id);
    if (error) throw error;
  }

  async listCategories(): Promise<readonly TaskCategory[]> {
    const { data, error } = await this.client.from("task_categories").select("*").order("sort_order", { ascending: true });
    if (error) throw error;
    return ((data ?? []) as TaskCategoryRow[]).map((row) => ({ id: row.id, name: row.name, sortOrder: row.sort_order, isActive: row.is_active }));
  }

  async listHistory(taskId: string): Promise<readonly TaskHistoryEntry[]> {
    const { data, error } = await this.client.from("task_history").select("*").eq("task_id", taskId).order("created_at", { ascending: true });
    if (error) throw error;
    return ((data ?? []) as TaskHistoryRow[]).map(rowToHistory);
  }

  async appendHistory(entry: TaskHistoryInput): Promise<void> {
    const { error } = await this.client.from("task_history").insert({
      task_id: entry.taskId,
      action: entry.action,
      changes: entry.changes,
      note: entry.note ?? null,
      actor_name: entry.actorName ?? null,
    });
    if (error) throw error;
  }

  async listAutomationKeys(): Promise<ReadonlySet<string>> {
    const { data, error } = await this.client.from("tasks").select("automation_key").not("automation_key", "is", null);
    if (error) throw error;
    return new Set(((data ?? []) as { automation_key: string }[]).map((row) => row.automation_key));
  }
}
