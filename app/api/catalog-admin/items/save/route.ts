import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../../lib/db/supabase.server.ts";
import { saveCatalogItemAdmin } from "../../../../../lib/db/catalogItemsAdmin.supabase.ts";
import { ConcurrencyConflictError } from "../../../../../lib/db/concurrency.ts";
import { CatalogItemAdminNotFoundError, parseCatalogItemAdminEdit, type CatalogItemAdmin, type CatalogItemAdminEdit } from "../../../../../domain/catalogItemsAdmin.ts";
import { CatalogReadinessError } from "../../../../../domain/catalogReadiness.ts";

type SaveBody = Readonly<{ id?: unknown; edit?: unknown; expectedUpdatedAt?: unknown }>;

function defaultSave(id: string, edit: CatalogItemAdminEdit, expectedUpdatedAt: string | null): Promise<CatalogItemAdmin> {
  return saveCatalogItemAdmin(createSupabaseServerClient(), id, edit, expectedUpdatedAt);
}

export async function handleCatalogAdminItemsSave(
  request: NextRequest,
  save: (id: string, edit: CatalogItemAdminEdit, expectedUpdatedAt: string | null) => Promise<CatalogItemAdmin> = defaultSave,
): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) return NextResponse.json({ error: "Pro ukládání komponent je vyžadováno přihlášení." }, { status: 401 });
  let body: SaveBody;
  try {
    body = (await request.json()) as SaveBody;
  } catch {
    return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 });
  }
  if (typeof body.id !== "string" || !body.id) return NextResponse.json({ error: "Chybí id katalogové položky." }, { status: 400 });
  const expectedUpdatedAt = typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : null;
  const edit = parseCatalogItemAdminEdit(body.edit);
  try {
    const saved = await save(body.id, edit, expectedUpdatedAt);
    return NextResponse.json({ catalogItem: saved });
  } catch (error) {
    if (error instanceof ConcurrencyConflictError) return NextResponse.json({ error: "Data byla mezitím změněna jinde. Obnovte stránku před uložením." }, { status: 409 });
    if (error instanceof CatalogReadinessError) return NextResponse.json({ error: error.message, issues: error.issues }, { status: 400 });
    if (error instanceof CatalogItemAdminNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Katalogovou položku se nepodařilo uložit do databáze." }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  return handleCatalogAdminItemsSave(request);
}
