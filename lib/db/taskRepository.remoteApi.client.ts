"use client";

import type { Task, TaskCategory, TaskHistoryEntry, TaskInput, TaskListResult, TaskStatus } from "../../domain/tasks.ts";
import type { StandChecklist, StandKey } from "../../domain/standChecklist.ts";
import { RemoteApiUnavailableError } from "./projectRepository.remoteApi.client.ts";

async function throwForFailedResponse(response: Response, fallbackMessage: string): Promise<never> {
  let message = fallbackMessage;
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) message = body.error;
  } catch {
    // response body wasn't JSON — keep the fallback message
  }
  throw new RemoteApiUnavailableError(response.status, message);
}

async function postJson<T>(url: string, body: unknown, fallbackMessage: string): Promise<T> {
  const response = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) await throwForFailedResponse(response, fallbackMessage);
  return (await response.json()) as T;
}

async function getJson<T>(url: string, fallbackMessage: string): Promise<T> {
  const response = await fetch(url, { method: "GET", credentials: "same-origin" });
  if (!response.ok) await throwForFailedResponse(response, fallbackMessage);
  return (await response.json()) as T;
}

/**
 * Browser-side client for app/api/tasks/*. Every write goes through the server-side task service
 * (domain/taskService.ts), which validates and records history — this client never builds history.
 * `actorName` is the free-text name remembered in this browser (no per-user login exists).
 */
export class RemoteApiTaskClient {
  async list(): Promise<TaskListResult> {
    const body = await getJson<{ tasks: readonly Task[]; categories: readonly TaskCategory[] }>("/api/tasks/list", "Úkoly se nepodařilo načíst.");
    return { tasks: body.tasks, categories: body.categories };
  }

  async create(task: TaskInput, actorName?: string): Promise<Task> {
    return (await postJson<{ task: Task }>("/api/tasks/save", { task, actorName }, "Úkol se nepodařilo vytvořit.")).task;
  }

  async update(id: string, task: TaskInput, actorName?: string): Promise<Task> {
    return (await postJson<{ task: Task }>("/api/tasks/save", { id, task, actorName }, "Úkol se nepodařilo uložit.")).task;
  }

  async setStatus(id: string, status: TaskStatus, actorName?: string): Promise<Task> {
    return (await postJson<{ task: Task }>("/api/tasks/action", { id, action: "setStatus", status, actorName }, "Stav úkolu se nepodařilo změnit.")).task;
  }

  async approve(id: string, actorName?: string, note?: string): Promise<Task> {
    return (await postJson<{ task: Task }>("/api/tasks/action", { id, action: "approve", note, actorName }, "Úkol se nepodařilo schválit.")).task;
  }

  async returnForRework(id: string, note: string, actorName?: string): Promise<Task> {
    return (await postJson<{ task: Task }>("/api/tasks/action", { id, action: "return", note, actorName }, "Úkol se nepodařilo vrátit.")).task;
  }

  async delete(id: string): Promise<void> {
    await postJson<{ ok: true }>("/api/tasks/delete", { id }, "Úkol se nepodařilo smazat.");
  }

  async history(id: string): Promise<readonly TaskHistoryEntry[]> {
    return (await getJson<{ history: readonly TaskHistoryEntry[] }>(`/api/tasks/history?id=${encodeURIComponent(id)}`, "Historii úkolu se nepodařilo načíst.")).history;
  }

  async checklist(stand: StandKey): Promise<StandChecklist | null> {
    const query = `eventId=${encodeURIComponent(stand.eventId)}&standNumber=${encodeURIComponent(stand.standNumber)}`;
    return (await getJson<{ checklist: StandChecklist | null }>(`/api/tasks/checklist?${query}`, "Checklist stánku se nepodařilo načíst.")).checklist;
  }

  async toggleChecklistItem(stand: StandKey, itemKey: string, isDone: boolean, actorName?: string): Promise<StandChecklist | null> {
    return (await postJson<{ checklist: StandChecklist | null }>("/api/tasks/checklist", { ...stand, itemKey, isDone, actorName }, "Checklist stánku se nepodařilo uložit.")).checklist;
  }
}
