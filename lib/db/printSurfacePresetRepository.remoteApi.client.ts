"use client";

import type { PrintSurfacePreset, PrintSurfacePresetRepository } from "../../domain/printSurfacePreset.ts";
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

/** Browser-side counterpart to lib/db/printSurfacePresetRepository.supabase.ts — see RemoteApiRealizationCompanyRepository's doc on the shared catalog route. */
export class RemoteApiPrintSurfacePresetRepository implements PrintSurfacePresetRepository {
  async list(): Promise<readonly PrintSurfacePreset[]> {
    const response = await fetch("/api/print-surfaces/catalog", { method: "GET", credentials: "same-origin" });
    if (!response.ok) await throwForFailedResponse(response, "Nepodařilo se načíst presety tiskových ploch z databáze.");
    const body = (await response.json()) as { presets: readonly PrintSurfacePreset[] };
    return body.presets;
  }
}
