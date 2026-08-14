"use client";

import type { CatalogItemAdmin, CatalogItemAdminEdit } from "../../domain/catalogItemsAdmin.ts";
import { ConcurrencyConflictError } from "./concurrency.ts";
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

/**
 * Browser-side counterpart to lib/db/catalogItemsAdmin.supabase.ts — full admin read/write,
 * unlike RemoteApiCatalogPricingRepository (lib/db/catalogPricing.remoteApi.client.ts), which
 * is a narrow read-only customer-safe summary for technical-service pricing only.
 */
export class RemoteApiCatalogItemsAdminRepository {
  async list(): Promise<readonly CatalogItemAdmin[]> {
    const response = await fetch("/api/catalog-admin/items", { method: "GET", credentials: "same-origin" });
    if (!response.ok) await throwForFailedResponse(response, "Nepodařilo se načíst katalogové položky z databáze.");
    const body = (await response.json()) as { catalogItems: readonly CatalogItemAdmin[] };
    return body.catalogItems;
  }

  async save(id: string, edit: CatalogItemAdminEdit, expectedUpdatedAt: string | null): Promise<CatalogItemAdmin> {
    const response = await fetch("/api/catalog-admin/items/save", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, edit, expectedUpdatedAt }),
    });
    if (response.status === 409) throw new ConcurrencyConflictError("catalog_item", id);
    if (!response.ok) await throwForFailedResponse(response, "Uložení katalogové položky do databáze selhalo.");
    const body = (await response.json()) as { catalogItem: CatalogItemAdmin };
    return body.catalogItem;
  }
}
