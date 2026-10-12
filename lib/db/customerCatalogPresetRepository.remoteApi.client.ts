"use client";

import type { CustomerCatalogPreset, CustomerCatalogPresetInput, CustomerCatalogPresetRepository } from "../../domain/customerCatalog.ts";
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

/** Browser-side counterpart to lib/db/customerCatalogPresetRepository.supabase.ts. */
export class RemoteApiCustomerCatalogPresetRepository implements CustomerCatalogPresetRepository {
  async list(): Promise<readonly CustomerCatalogPreset[]> {
    const response = await fetch("/api/customer-catalog/presets", { method: "GET", credentials: "same-origin" });
    if (!response.ok) await throwForFailedResponse(response, "Nepodařilo se načíst uložené konfigurace katalogu.");
    const body = (await response.json()) as { presets: readonly CustomerCatalogPreset[] };
    return body.presets;
  }

  async save(input: CustomerCatalogPresetInput): Promise<CustomerCatalogPreset> {
    const response = await fetch("/api/customer-catalog/presets", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) await throwForFailedResponse(response, "Uložení konfigurace katalogu selhalo.");
    const body = (await response.json()) as { preset: CustomerCatalogPreset };
    return body.preset;
  }

  async delete(id: string): Promise<void> {
    const response = await fetch(`/api/customer-catalog/presets?id=${encodeURIComponent(id)}`, { method: "DELETE", credentials: "same-origin" });
    if (!response.ok) await throwForFailedResponse(response, "Smazání konfigurace katalogu selhalo.");
  }
}
