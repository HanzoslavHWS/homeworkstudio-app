"use client";

import type {
  PrintSurfaceProject,
  PrintSurfaceProjectCreateInput,
  PrintSurfaceProjectRepository,
  PrintSurfaceProjectSummary,
} from "../../domain/printSurfaceProject.ts";
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

/** Browser-side counterpart to lib/db/printSurfaceProjectRepository.supabase.ts. */
export class RemoteApiPrintSurfaceProjectRepository implements PrintSurfaceProjectRepository {
  async list(): Promise<readonly PrintSurfaceProjectSummary[]> {
    const response = await fetch("/api/print-surfaces/projects/list", { method: "GET", credentials: "same-origin" });
    if (!response.ok) await throwForFailedResponse(response, "Nepodařilo se načíst seznam projektů tiskových ploch.");
    const body = (await response.json()) as { projects: readonly PrintSurfaceProjectSummary[] };
    return body.projects;
  }

  async get(id: string): Promise<PrintSurfaceProject | undefined> {
    const response = await fetch(`/api/print-surfaces/projects/get?id=${encodeURIComponent(id)}`, { method: "GET", credentials: "same-origin" });
    if (response.status === 404) return undefined;
    if (!response.ok) await throwForFailedResponse(response, "Nepodařilo se načíst projekt tiskových ploch.");
    const body = (await response.json()) as { project: PrintSurfaceProject };
    return body.project;
  }

  async create(input: PrintSurfaceProjectCreateInput): Promise<PrintSurfaceProject> {
    const response = await fetch("/api/print-surfaces/projects/save", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ create: input }),
    });
    if (!response.ok) await throwForFailedResponse(response, "Vytvoření projektu tiskových ploch selhalo.");
    const body = (await response.json()) as { project: PrintSurfaceProject };
    return body.project;
  }

  async save(project: PrintSurfaceProject): Promise<PrintSurfaceProject> {
    const response = await fetch("/api/print-surfaces/projects/save", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project }),
    });
    if (!response.ok) await throwForFailedResponse(response, "Uložení projektu tiskových ploch selhalo.");
    const body = (await response.json()) as { project: PrintSurfaceProject };
    return body.project;
  }

  async delete(id: string): Promise<void> {
    const response = await fetch("/api/print-surfaces/projects/delete", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!response.ok) await throwForFailedResponse(response, "Smazání projektu tiskových ploch selhalo.");
  }
}
