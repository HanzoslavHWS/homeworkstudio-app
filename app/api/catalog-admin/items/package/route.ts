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

export type SavePackageResult = Readonly<{ packageItems: readonly CatalogPackageItem[]; warnings: readonly string[] }>;

function defaultSavePackage(packageItemId: string, lines: readonly CatalogPackageItemInput[]): Promise<SavePackageResult> {
  return saveCatalogPackageItems(createSupabaseServerClient(), packageItemId, lines);
}

/** Replaces a BOOTH/KIT card's kit content (lines with keys, text lines, variants, substitutes, included graphics). */
export async function handleCatalogAdminPackageSave(
  request: NextRequest,
  savePackage: (packageItemId: string, lines: readonly CatalogPackageItemInput[]) => Promise<SavePackageResult> = defaultSavePackage,
): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) return NextResponse.json({ error: "Pro úpravu obsahu kompletu je vyžadováno přihlášení." }, { status: 401 });
  let body: { packageItemId?: unknown; items?: unknown };
  try {
    body = (await request.json()) as { packageItemId?: unknown; items?: unknown };
  } catch {
    return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 });
  }
  if (typeof body.packageItemId !== "string" || !body.packageItemId) return NextResponse.json({ error: "Chybí id kompletu." }, { status: 400 });
  let lines: readonly CatalogPackageItemInput[];
  try {
    lines = parseCatalogPackageItemsInput(body.items);
  } catch (error) {
    return NextResponse.json({ error: error instanceof InvalidCatalogPackageError ? error.message : "Neplatný obsah kompletu." }, { status: 400 });
  }
  try {
    const { packageItems, warnings } = await savePackage(body.packageItemId, lines);
    return NextResponse.json({ packageItems, warnings });
  } catch (error) {
    if (error instanceof InvalidCatalogPackageError) return NextResponse.json({ error: error.message, issues: error.issues }, { status: 400 });
    if (error instanceof CatalogItemAdminNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
    if (error instanceof CatalogSchemaNotMigratedError) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Obsah kompletu se nepodařilo uložit." }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  return handleCatalogAdminPackageSave(request);
}
