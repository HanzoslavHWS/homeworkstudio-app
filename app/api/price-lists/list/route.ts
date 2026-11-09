import { NextResponse, type NextRequest } from "next/server.js";
import { denyUnless } from "../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../lib/db/supabase.server.ts";
import { SupabasePriceListRepository } from "../../../../lib/db/priceListRepository.supabase.ts";
import type { PriceListRepository } from "../../../../domain/priceListRepository.ts";

function defaultRepositoryFactory(): PriceListRepository {
  return new SupabasePriceListRepository(createSupabaseServerClient());
}

export async function handlePriceListsList(
  request: NextRequest,
  repositoryFactory: () => PriceListRepository = defaultRepositoryFactory,
): Promise<NextResponse> {
  const authDenied = await denyUnless(request, "prices.sale.read");
  if (authDenied) return authDenied;
  try {
    const priceLists = await repositoryFactory().list();
    return NextResponse.json({ priceLists });
  } catch (error) {
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Ceníky se nepodařilo načíst z databáze." }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  return handlePriceListsList(request);
}
