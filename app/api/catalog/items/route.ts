import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../lib/db/supabase.server.ts";
import { readCatalogItems } from "../../../../lib/db/catalogPricing.supabase.ts";
import type { CatalogItemSummary } from "../../../../domain/catalogPricing.ts";

function defaultReadCatalogItems(): Promise<readonly CatalogItemSummary[]> {
  return readCatalogItems(createSupabaseServerClient());
}

export async function handleCatalogItemsList(
  request: NextRequest,
  readItems: () => Promise<readonly CatalogItemSummary[]> = defaultReadCatalogItems,
): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) return NextResponse.json({ error: "Pro přístup ke katalogu je vyžadováno přihlášení." }, { status: 401 });
  try {
    const catalogItems = await readItems();
    return NextResponse.json({ catalogItems });
  } catch (error) {
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Katalog se nepodařilo načíst z databáze." }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  return handleCatalogItemsList(request);
}
