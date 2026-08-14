"use client";

import type { PriceList } from "../../domain/organizations.ts";
import type {
  DuplicatePriceListDraft,
  PricingEntryAdmin,
  PricingEntryEdit,
  PricingEntrySaveSummary,
} from "../../domain/pricingAdmin.ts";
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

export type DuplicatePriceListResponse = Readonly<{
  priceList: PriceList;
  copiedCount: number;
  skippedCount: number;
  entriesError?: string;
  linkWarning?: string;
}>;

/**
 * Browser-side counterpart to lib/db/pricingAdmin.supabase.ts. Admin-only — never used by the
 * live project workflow (that stays on RemoteApiCatalogPricingRepository / the customer-safe
 * /api/pricing/entries route). Browser never holds a Supabase client/secret.
 */
export class RemoteApiPricingAdminRepository {
  async listEntries(filter: Readonly<{ catalogItemIds?: readonly string[]; priceListIds?: readonly string[] }>): Promise<readonly PricingEntryAdmin[]> {
    const params = new URLSearchParams();
    if (filter.catalogItemIds?.length) params.set("catalogItemIds", filter.catalogItemIds.join(","));
    if (filter.priceListIds?.length) params.set("priceListIds", filter.priceListIds.join(","));
    const response = await fetch(`/api/pricing-admin/entries?${params.toString()}`, { method: "GET", credentials: "same-origin" });
    if (!response.ok) await throwForFailedResponse(response, "Nepodařilo se načíst ceny.");
    const body = (await response.json()) as { entries: readonly PricingEntryAdmin[] };
    return body.entries;
  }

  async saveEntries(edits: readonly PricingEntryEdit[]): Promise<PricingEntrySaveSummary> {
    const response = await fetch("/api/pricing-admin/entries/save", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edits }),
    });
    if (!response.ok) await throwForFailedResponse(response, "Uložení cen selhalo.");
    return (await response.json()) as PricingEntrySaveSummary;
  }

  async duplicatePriceList(sourcePriceListId: string, priceList: DuplicatePriceListDraft): Promise<DuplicatePriceListResponse> {
    const response = await fetch("/api/pricing-admin/price-lists/duplicate", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourcePriceListId, priceList }),
    });
    if (!response.ok) await throwForFailedResponse(response, "Duplikace ceníku selhala.");
    return (await response.json()) as DuplicatePriceListResponse;
  }
}
