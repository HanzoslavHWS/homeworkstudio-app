"use client";

import type { CatalogItemSummary, PricingEntrySummary } from "../../domain/catalogPricing.ts";
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
 * Browser-side counterpart to lib/db/catalogPricing.supabase.ts. Browser never holds a
 * Supabase client/secret — every call goes through our own authenticated Next.js API routes.
 */
export class RemoteApiCatalogPricingRepository {
  async listCatalogItems(): Promise<readonly CatalogItemSummary[]> {
    const response = await fetch("/api/catalog/items", { method: "GET", credentials: "same-origin" });
    if (!response.ok) await throwForFailedResponse(response, "Nepodařilo se načíst katalog z databáze.");
    const body = (await response.json()) as { catalogItems: readonly CatalogItemSummary[] };
    return body.catalogItems;
  }

  async listPricingEntries(priceListId: string): Promise<readonly PricingEntrySummary[]> {
    const response = await fetch(`/api/pricing/entries?priceListId=${encodeURIComponent(priceListId)}`, { method: "GET", credentials: "same-origin" });
    if (!response.ok) await throwForFailedResponse(response, "Nepodařilo se načíst ceny z databáze.");
    const body = (await response.json()) as { pricingEntries: readonly PricingEntrySummary[] };
    return body.pricingEntries;
  }
}
