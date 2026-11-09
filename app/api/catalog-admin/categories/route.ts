import { NextResponse, type NextRequest } from "next/server.js";
import { denyUnless } from "../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../lib/db/supabase.server.ts";
import { CatalogCategoriesNotMigratedError, readCatalogCategoryRegister, saveCatalogCategory, type CatalogCategoryRegister } from "../../../../lib/db/catalogCategories.supabase.ts";
import { InvalidCatalogCategoryError, parseCatalogCategoryInput, type CatalogCategoryDef } from "../../../../domain/catalogClassification.ts";

/**
 * Katalog → kategorie (V1-CATALOG). GET returns the register (persisted=false while the migration is
 * not applied: built-in list, read-only); POST adds or edits one category. No DELETE — deactivate.
 * Same permission as the rest of the catalog administration (a valid session).
 */
export type CatalogCategoryDependencies = Readonly<{
  readRegister: () => Promise<CatalogCategoryRegister>;
  saveCategory: (category: CatalogCategoryDef, isNew: boolean) => Promise<CatalogCategoryDef>;
}>;

const defaultDependencies: CatalogCategoryDependencies = {
  readRegister: () => readCatalogCategoryRegister(createSupabaseServerClient()),
  saveCategory: (category, isNew) => saveCatalogCategory(createSupabaseServerClient(), category, isNew),
};

export async function handleCatalogCategoriesGet(request: NextRequest, dependencies: CatalogCategoryDependencies = defaultDependencies): Promise<NextResponse> {
  const authDenied = await denyUnless(request, "catalog.read");
  if (authDenied) return authDenied;
  try {
    return NextResponse.json(await dependencies.readRegister());
  } catch (error) {
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Kategorie se nepodařilo načíst." }, { status: 502 });
  }
}

export async function handleCatalogCategorySave(request: NextRequest, dependencies: CatalogCategoryDependencies = defaultDependencies): Promise<NextResponse> {
  const authDenied = await denyUnless(request, "catalog.manage");
  if (authDenied) return authDenied;
  let body: { category?: unknown; isNew?: unknown };
  try {
    body = (await request.json()) as { category?: unknown; isNew?: unknown };
  } catch {
    return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 });
  }
  try {
    return NextResponse.json({ category: await dependencies.saveCategory(parseCatalogCategoryInput(body.category), body.isNew === true) });
  } catch (error) {
    if (error instanceof InvalidCatalogCategoryError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof CatalogCategoriesNotMigratedError) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Kategorii se nepodařilo uložit." }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  return handleCatalogCategoriesGet(request);
}

export async function POST(request: NextRequest) {
  return handleCatalogCategorySave(request);
}
