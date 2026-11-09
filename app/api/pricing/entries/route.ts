import { NextResponse, type NextRequest } from "next/server.js";
import { denyUnless } from "../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../lib/db/supabase.server.ts";
import { readPricingEntriesForPriceList } from "../../../../lib/db/catalogPricing.supabase.ts";
import type { PricingEntrySummary } from "../../../../domain/catalogPricing.ts";

function defaultReadPricingEntries(priceListId: string): Promise<readonly PricingEntrySummary[]> {
  return readPricingEntriesForPriceList(createSupabaseServerClient(), priceListId);
}

export async function handlePricingEntriesList(
  request: NextRequest,
  readEntries: (priceListId: string) => Promise<readonly PricingEntrySummary[]> = defaultReadPricingEntries,
): Promise<NextResponse> {
  const authDenied = await denyUnless(request, "prices.sale.read");
  if (authDenied) return authDenied;
  const priceListId = request.nextUrl.searchParams.get("priceListId");
  if (!priceListId) return NextResponse.json({ error: "Chybí parametr priceListId." }, { status: 400 });
  try {
    const pricingEntries = await readEntries(priceListId);
    return NextResponse.json({ pricingEntries });
  } catch (error) {
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Ceny se nepodařilo načíst z databáze." }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  return handlePricingEntriesList(request);
}
