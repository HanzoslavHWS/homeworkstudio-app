"use client";

import type { RealizationCompany, RealizationCompanyRepository } from "../../domain/realizationCompany.ts";
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

/** Browser-side counterpart to lib/db/realizationCompanyRepository.supabase.ts. Companies/presets/production dimensions are always imported and replaced together, so all three share app/api/print-surfaces/catalog/route.ts. */
export class RemoteApiRealizationCompanyRepository implements RealizationCompanyRepository {
  async list(): Promise<readonly RealizationCompany[]> {
    const response = await fetch("/api/print-surfaces/catalog", { method: "GET", credentials: "same-origin" });
    if (!response.ok) await throwForFailedResponse(response, "Nepodařilo se načíst realizační společnosti z databáze.");
    const body = (await response.json()) as { companies: readonly RealizationCompany[] };
    return body.companies;
  }

  async replaceAll(companies: readonly RealizationCompany[]): Promise<void> {
    const response = await fetch("/api/print-surfaces/catalog", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companies }),
    });
    if (!response.ok) await throwForFailedResponse(response, "Uložení realizačních společností selhalo.");
  }
}
