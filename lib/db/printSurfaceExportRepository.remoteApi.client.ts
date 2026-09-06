"use client";

import type {
  PrintSurfaceExportCreateInput,
  PrintSurfaceExportRecord,
  PrintSurfaceExportRepository,
} from "../../domain/printSurfaceExport.ts";
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

/** Browser-side counterpart to lib/db/printSurfaceExportRepository.supabase.ts. */
export class RemoteApiPrintSurfaceExportRepository implements PrintSurfaceExportRepository {
  async list(projectId: string): Promise<readonly PrintSurfaceExportRecord[]> {
    const response = await fetch(`/api/print-surfaces/exports/list?projectId=${encodeURIComponent(projectId)}`, { method: "GET", credentials: "same-origin" });
    if (!response.ok) await throwForFailedResponse(response, "Nepodařilo se načíst historii exportů.");
    const body = (await response.json()) as { exports: readonly PrintSurfaceExportRecord[] };
    return body.exports;
  }

  async create(input: PrintSurfaceExportCreateInput): Promise<PrintSurfaceExportRecord> {
    const response = await fetch("/api/print-surfaces/exports/create", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) await throwForFailedResponse(response, "Vytvoření záznamu exportu selhalo.");
    const body = (await response.json()) as { export: PrintSurfaceExportRecord };
    return body.export;
  }
}
