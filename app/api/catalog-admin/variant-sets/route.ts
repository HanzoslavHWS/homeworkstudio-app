import { NextResponse, type NextRequest } from "next/server.js";
import { denyUnless } from "../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../lib/db/supabase.server.ts";
import { CatalogSchemaNotMigratedError, readCatalogVariantSets, saveCatalogVariantSet } from "../../../../lib/db/catalogItemsAdmin.supabase.ts";
import { InvalidCatalogVariantSetError, parseCatalogVariantSetInput, type CatalogVariantSet, type CatalogVariantSetInput } from "../../../../domain/catalogVariants.ts";

/**
 * Swatch books (V1-DATA-04). GET returns every set with all variants; POST saves one set
 * (variants inserted or updated, never deleted — deactivate instead). No DELETE route.
 */
export type CatalogVariantSetDependencies = Readonly<{
  readSets: () => Promise<readonly CatalogVariantSet[]>;
  saveSet: (input: CatalogVariantSetInput) => Promise<CatalogVariantSet>;
}>;

const defaultDependencies: CatalogVariantSetDependencies = {
  readSets: () => readCatalogVariantSets(createSupabaseServerClient()),
  saveSet: (input) => saveCatalogVariantSet(createSupabaseServerClient(), input),
};

export async function handleCatalogVariantSetsGet(request: NextRequest, dependencies: CatalogVariantSetDependencies = defaultDependencies): Promise<NextResponse> {
  const authDenied = await denyUnless(request, "catalog.read");
  if (authDenied) return authDenied;
  try {
    return NextResponse.json({ variantSets: await dependencies.readSets() });
  } catch (error) {
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Vzorníky se nepodařilo načíst." }, { status: 502 });
  }
}

export async function handleCatalogVariantSetSave(request: NextRequest, dependencies: CatalogVariantSetDependencies = defaultDependencies): Promise<NextResponse> {
  const authDenied = await denyUnless(request, "catalog.manage");
  if (authDenied) return authDenied;
  let body: { variantSet?: unknown };
  try {
    body = (await request.json()) as { variantSet?: unknown };
  } catch {
    return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 });
  }
  try {
    return NextResponse.json({ variantSet: await dependencies.saveSet(parseCatalogVariantSetInput(body.variantSet)) });
  } catch (error) {
    if (error instanceof InvalidCatalogVariantSetError) return NextResponse.json({ error: error.message, issues: error.issues }, { status: 400 });
    if (error instanceof CatalogSchemaNotMigratedError) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Vzorník se nepodařilo uložit." }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  return handleCatalogVariantSetsGet(request);
}

export async function POST(request: NextRequest) {
  return handleCatalogVariantSetSave(request);
}
