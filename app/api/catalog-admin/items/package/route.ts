import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../../lib/db/supabase.server.ts";
import { CatalogSchemaNotMigratedError, saveCatalogPackageItems } from "../../../../../lib/db/catalogItemsAdmin.supabase.ts";
import { CatalogItemAdminNotFoundError } from "../../../../../domain/catalogItemsAdmin.ts";
import {
  InvalidCatalogPackageError,
  parseCatalogPackageItemsInput,
  type CatalogPackageItem,
  type CatalogPackageItemInput,
} from "../../../../../domain/catalogPackages.ts";

function defaultSavePackage(packageItemId: string, lines: readonly CatalogPackageItemInput[]): Promise<readonly CatalogPackageItem[]> {
  return saveCatalogPackageItems(createSupabaseServerClient(), packageItemId, lines);
}

/** Replaces a BOOTH card's package contents (booth -> item -> quantity -> included_in_package). */
export async function handleCatalogAdminPackageSave(
  request: NextRequest,
  savePackage: (packageItemId: string, lines: readonly CatalogPackageItemInput[]) => Promise<readonly CatalogPackageItem[]> = defaultSavePackage,
): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) return NextResponse.json({ error: "Pro úpravu obsahu stánku je vyžadováno přihlášení." }, { status: 401 });
  let body: { packageItemId?: unknown; items?: unknown };
  try {
    body = (await request.json()) as { packageItemId?: unknown; items?: unknown };
  } catch {
    return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 });
  }
  if (typeof body.packageItemId !== "string" || !body.packageItemId) return NextResponse.json({ error: "Chybí id stánku." }, { status: 400 });
  let lines: readonly CatalogPackageItemInput[];
  try {
    lines = parseCatalogPackageItemsInput(body.items);
  } catch (error) {
    return NextResponse.json({ error: error instanceof InvalidCatalogPackageError ? error.message : "Neplatný obsah balíčku." }, { status: 400 });
  }
  try {
    return NextResponse.json({ packageItems: await savePackage(body.packageItemId, lines) });
  } catch (error) {
    if (error instanceof InvalidCatalogPackageError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof CatalogItemAdminNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
    if (error instanceof CatalogSchemaNotMigratedError) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Obsah stánku se nepodařilo uložit." }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  return handleCatalogAdminPackageSave(request);
}
