"use client";

import type { ProjectRecord } from "../../domain/project.ts";
import type { PersistedProjectRecord, RemoteProjectRepository } from "../../domain/remotePersistence.ts";
import { ConcurrencyConflictError } from "./concurrency.ts";

export class RemoteApiUnavailableError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RemoteApiUnavailableError";
    this.status = status;
  }
}

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

/**
 * Browser-side counterpart to lib/db/projectRepository.supabase.ts. Never touches
 * Supabase directly (no secret key can exist in browser code) — every call goes through
 * our own authenticated Next.js API routes, which hold the server Supabase client.
 * Implements the plain ProjectRepository contract too, so it's a drop-in swap for
 * LocalProjectRepository wherever the app only needs list/get/save/delete.
 */
export class RemoteApiProjectRepository implements RemoteProjectRepository {
  async list(): Promise<readonly ProjectRecord[]> {
    const response = await fetch("/api/projects/list", { method: "GET", credentials: "same-origin" });
    if (!response.ok) await throwForFailedResponse(response, "Nepodařilo se načíst projekty z databáze.");
    const body = (await response.json()) as { projects: readonly PersistedProjectRecord[] };
    return body.projects;
  }

  async get(id: string): Promise<ProjectRecord | undefined> {
    return this.getWithRevision(id);
  }

  async getWithRevision(id: string): Promise<PersistedProjectRecord | undefined> {
    const projects = await this.list();
    return (projects as readonly PersistedProjectRecord[]).find((project) => project.id === id);
  }

  /** Convenience path matching the plain ProjectRepository contract — fetches the current revision first. Prefer saveWithRevision when the caller already holds a known revision. */
  async save(project: ProjectRecord): Promise<ProjectRecord> {
    const existing = await this.getWithRevision(project.id);
    return this.saveWithRevision(project, existing?.revision ?? null);
  }

  async saveWithRevision(project: ProjectRecord, expectedRevision: number | null): Promise<PersistedProjectRecord> {
    const response = await fetch("/api/projects/save", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project, expectedRevision }),
    });
    if (response.status === 409) throw new ConcurrencyConflictError("project", project.id);
    if (!response.ok) await throwForFailedResponse(response, "Uložení projektu do databáze selhalo.");
    const body = (await response.json()) as { project: PersistedProjectRecord };
    return body.project;
  }

  async delete(id: string): Promise<void> {
    const response = await fetch("/api/projects/delete", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!response.ok) await throwForFailedResponse(response, "Smazání projektu z databáze selhalo.");
  }
}
