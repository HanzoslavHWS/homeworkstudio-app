"use client";

import type { PriceList } from "../../domain/organizations.ts";
import type { PriceListRepository } from "../../domain/priceListRepository.ts";
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
 * Browser-side counterpart to lib/db/priceListRepository.supabase.ts — same rationale as
 * RemoteApiEventRepository. Browser never holds a Supabase client/secret; every call goes
 * through our own authenticated Next.js API routes.
 */
export class RemoteApiPriceListRepository implements PriceListRepository {
  async list(): Promise<readonly PriceList[]> {
    const response = await fetch("/api/price-lists/list", { method: "GET", credentials: "same-origin" });
    if (!response.ok) await throwForFailedResponse(response, "Nepodařilo se načíst ceníky z databáze.");
    const body = (await response.json()) as { priceLists: readonly PriceList[] };
    return body.priceLists;
  }

  async save(priceList: PriceList): Promise<PriceList> {
    const response = await fetch("/api/price-lists/save", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priceList }),
    });
    if (!response.ok) await throwForFailedResponse(response, "Uložení ceníku do databáze selhalo.");
    const body = (await response.json()) as { priceList: PriceList };
    return body.priceList;
  }
}
