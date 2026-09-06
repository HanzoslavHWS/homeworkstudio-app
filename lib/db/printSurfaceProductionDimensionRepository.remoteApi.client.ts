"use client";

import type {
  PrintSurfaceProductionDimension,
  PrintSurfaceProductionDimensionRepository,
} from "../../domain/printSurfaceProductionDimension.ts";
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

/** Browser-side counterpart to lib/db/printSurfaceProductionDimensionRepository.supabase.ts — see RemoteApiRealizationCompanyRepository's doc on the shared catalog route. */
export class RemoteApiPrintSurfaceProductionDimensionRepository implements PrintSurfaceProductionDimensionRepository {
  async list(): Promise<readonly PrintSurfaceProductionDimension[]> {
    const response = await fetch("/api/print-surfaces/catalog", { method: "GET", credentials: "same-origin" });
    if (!response.ok) await throwForFailedResponse(response, "Nepodařilo se načíst výrobní rozměry z databáze.");
    const body = (await response.json()) as { productionDimensions: readonly PrintSurfaceProductionDimension[] };
    return body.productionDimensions;
  }

  async replaceAll(dimensions: readonly PrintSurfaceProductionDimension[]): Promise<void> {
    const response = await fetch("/api/print-surfaces/catalog", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productionDimensions: dimensions }),
    });
    if (!response.ok) await throwForFailedResponse(response, "Uložení výrobních rozměrů selhalo.");
  }
}
