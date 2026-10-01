import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../../lib/db/supabase.server.ts";
import { CatalogSchemaNotMigratedError, duplicateCatalogItemAdmin } from "../../../../../lib/db/catalogItemsAdmin.supabase.ts";
import { CatalogItemAdminNotFoundError, type CatalogItemAdmin } from "../../../../../domain/catalogItemsAdmin.ts";

function defaultDuplicate(id: string): Promise<CatalogItemAdmin> {
  return duplicateCatalogItemAdmin(createSupabaseServerClient(), id);
}

/** "Duplikovat" — a new needs_review card from an existing one (never its codes/provenance/prices). */
export async function handleCatalogAdminItemsDuplicate(
  request: NextRequest,
  duplicate: (id: string) => Promise<CatalogItemAdmin> = defaultDuplicate,
): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) return NextResponse.json({ error: "Pro duplikaci položky je vyžadováno přihlášení." }, { status: 401 });
  let body: { id?: unknown };
  try {
    body = (await request.json()) as { id?: unknown };
  } catch {
    return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 });
  }
  if (typeof body.id !== "string" || !body.id) return NextResponse.json({ error: "Chybí id katalogové položky." }, { status: 400 });
  try {
    return NextResponse.json({ catalogItem: await duplicate(body.id) });
  } catch (error) {
    if (error instanceof CatalogItemAdminNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
    if (error instanceof CatalogSchemaNotMigratedError) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Položku se nepodařilo duplikovat." }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  return handleCatalogAdminItemsDuplicate(request);
}
