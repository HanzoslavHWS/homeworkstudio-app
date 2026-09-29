"use client";

import { useCallback, useEffect, useState } from "react";
import type { Task, TaskCategory, TaskInput, TaskStatus } from "../../../domain/tasks";
import type { RemoteApiTaskClient } from "../../../lib/db/taskRepository.remoteApi.client";

const ACTOR_NAME_STORAGE_KEY = "homeworkstudio.tasks.actorName";

function readStoredActorName(): string {
  try {
    return window.localStorage.getItem(ACTOR_NAME_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * The ONE loaded copy of all tasks, shared by the Úkoly page, the sidebar badge, the stand and
 * event panels and the global "+ Úkol" dialog. Every mutation goes through the API (which
 * validates and writes history) and then patches this list with the server's result — the list is
 * never edited optimistically before the server confirmed a change.
 *
 * `actorName` is the free-text "who am I" used for history/authorship, remembered per browser
 * (the app has one shared login and no users table).
 */
export function useTaskStore(client: RemoteApiTaskClient) {
  const [tasks, setTasks] = useState<readonly Task[] | null>(null);
  const [categories, setCategories] = useState<readonly TaskCategory[]>([]);
  const [loadError, setLoadError] = useState("");
  const [actorName, setActorNameState] = useState("");

  useEffect(() => { setActorNameState(readStoredActorName()); }, []);

  const setActorName = useCallback((value: string) => {
    setActorNameState(value);
    try { window.localStorage.setItem(ACTOR_NAME_STORAGE_KEY, value); } catch { /* storage unavailable — keep it for this session only */ }
  }, []);

  const reload = useCallback(() => {
    return client.list()
      .then((result) => { setTasks(result.tasks); setCategories(result.categories); setLoadError(""); })
      .catch((error) => setLoadError(error instanceof Error ? error.message : "Úkoly se nepodařilo načíst."));
  }, [client]);

  useEffect(() => { void reload(); }, [reload]);

  const upsert = useCallback((task: Task) => {
    setTasks((current) => {
      if (!current) return [task];
      return current.some((candidate) => candidate.id === task.id) ? current.map((candidate) => (candidate.id === task.id ? task : candidate)) : [task, ...current];
    });
    return task;
  }, []);

  const actor = actorName.trim() || undefined;

  return {
    client,
    tasks,
    categories,
    loadError,
    actorName,
    setActorName,
    reload,
    create: async (input: TaskInput) => upsert(await client.create(input, actor)),
    update: async (id: string, input: TaskInput) => upsert(await client.update(id, input, actor)),
    setStatus: async (id: string, status: TaskStatus) => upsert(await client.setStatus(id, status, actor)),
    approve: async (id: string, note?: string) => upsert(await client.approve(id, actor, note)),
    returnForRework: async (id: string, note: string) => upsert(await client.returnForRework(id, note, actor)),
    remove: async (id: string) => {
      await client.delete(id);
      setTasks((current) => (current ? current.filter((task) => task.id !== id) : current));
    },
  };
}

export type TaskStore = ReturnType<typeof useTaskStore>;
