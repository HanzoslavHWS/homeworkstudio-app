import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../../../../lib/auth/requestAuth.ts";
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
  if (!(await isSessionRequestAuthorized(request))) return NextResponse.json({ error: "Pro administraci komponent je vyžadováno přihlášení." }, { status: 401 });
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
