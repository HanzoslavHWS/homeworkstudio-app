"use client";

import type {
  TechnicalRasterProject,
  TechnicalRasterProjectCreateInput,
  TechnicalRasterProjectRepository,
  TechnicalRasterProjectSummary,
} from "../../domain/technicalRaster.ts";
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

/** Browser-side counterpart to lib/db/technicalRasterProjectRepository.supabase.ts. */
export class RemoteApiTechnicalRasterProjectRepository implements TechnicalRasterProjectRepository {
  async list(): Promise<readonly TechnicalRasterProjectSummary[]> {
    const response = await fetch("/api/technical-rasters/projects/list", { method: "GET", credentials: "same-origin" });
    if (!response.ok) await throwForFailedResponse(response, "Nepodařilo se načíst seznam projektů technických rastrů.");
    const body = (await response.json()) as { projects: readonly TechnicalRasterProjectSummary[] };
    return body.projects;
  }

  async get(id: string): Promise<TechnicalRasterProject | undefined> {
    const response = await fetch(`/api/technical-rasters/projects/get?id=${encodeURIComponent(id)}`, { method: "GET", credentials: "same-origin" });
    if (response.status === 404) return undefined;
    if (!response.ok) await throwForFailedResponse(response, "Nepodařilo se načíst projekt technického rastru.");
    const body = (await response.json()) as { project: TechnicalRasterProject };
    return body.project;
  }

  async create(input: TechnicalRasterProjectCreateInput): Promise<TechnicalRasterProject> {
    const response = await fetch("/api/technical-rasters/projects/save", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ create: input }),
    });
    if (!response.ok) await throwForFailedResponse(response, "Vytvoření projektu technického rastru selhalo.");
    const body = (await response.json()) as { project: TechnicalRasterProject };
    return body.project;
  }

  async save(project: TechnicalRasterProject): Promise<TechnicalRasterProject> {
    const response = await fetch("/api/technical-rasters/projects/save", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project }),
    });
    if (!response.ok) await throwForFailedResponse(response, "Uložení projektu technického rastru selhalo.");
    const body = (await response.json()) as { project: TechnicalRasterProject };
    return body.project;
  }

  async delete(id: string): Promise<void> {
    const response = await fetch("/api/technical-rasters/projects/delete", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!response.ok) await throwForFailedResponse(response, "Smazání projektu technického rastru selhalo.");
  }
}
