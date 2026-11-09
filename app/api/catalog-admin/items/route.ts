import { NextResponse, type NextRequest } from "next/server.js";
import { denyUnless } from "../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../lib/db/supabase.server.ts";
import { readCatalogItemsAdmin } from "../../../../lib/db/catalogItemsAdmin.supabase.ts";
import type { CatalogItemAdmin } from "../../../../domain/catalogItemsAdmin.ts";

function defaultReadCatalogItemsAdmin(): Promise<readonly CatalogItemAdmin[]> {
  return readCatalogItemsAdmin(createSupabaseServerClient());
}

export async function handleCatalogAdminItemsList(
  request: NextRequest,
  readItems: () => Promise<readonly CatalogItemAdmin[]> = defaultReadCatalogItemsAdmin,
): Promise<NextResponse> {
  const authDenied = await denyUnless(request, "catalog.read");
  if (authDenied) return authDenied;
  try {
    const catalogItems = await readItems();
    return NextResponse.json({ catalogItems });
  } catch (error) {
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Katalogové položky se nepodařilo načíst z databáze." }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  return handleCatalogAdminItemsList(request);
}
