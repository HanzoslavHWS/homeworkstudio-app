import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../../lib/db/supabase.server.ts";
import { CatalogSchemaNotMigratedError, readCatalogItemAliases, saveCatalogItemAliases } from "../../../../../lib/db/catalogItemsAdmin.supabase.ts";
import { SupabaseRealizationCompanyRepository } from "../../../../../lib/db/realizationCompanyRepository.supabase.ts";
import { CatalogItemAdminNotFoundError } from "../../../../../domain/catalogItemsAdmin.ts";
import { InvalidCatalogAliasesError, parseCatalogItemAliasInputs, type CatalogItemAlias, type CatalogItemAliasInput } from "../../../../../domain/catalogItemAliases.ts";
import { CATALOG_UNITS, type CatalogUnit } from "../../../../../domain/catalogUnits.ts";
import type { RealizationCompany } from "../../../../../domain/realizationCompany.ts";

/**
 * Aliases of catalog items (V1-DATA-03). GET returns every alias plus what the alias editor needs
 * (unit register, realization companies from the V1-DATA-02 register — never a second list of
 * firms). POST replaces one item's alias list: new ones inserted, removed ones deactivated.
 */
export type CatalogAliasDependencies = Readonly<{
  readAliases: () => Promise<readonly CatalogItemAlias[]>;
  listCompanies: () => Promise<readonly RealizationCompany[]>;
  saveAliases: (catalogItemId: string, inputs: readonly CatalogItemAliasInput[]) => Promise<readonly CatalogItemAlias[]>;
}>;

const defaultDependencies: CatalogAliasDependencies = {
  readAliases: () => readCatalogItemAliases(createSupabaseServerClient()),
  listCompanies: () => new SupabaseRealizationCompanyRepository(createSupabaseServerClient()).list(),
  saveAliases: (catalogItemId, inputs) => saveCatalogItemAliases(createSupabaseServerClient(), catalogItemId, inputs),
};

export async function handleCatalogAliasesGet(request: NextRequest, dependencies: CatalogAliasDependencies = defaultDependencies): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) return NextResponse.json({ error: "Pro administraci komponent je vyžadováno přihlášení." }, { status: 401 });
  try {
    const [aliases, companies] = await Promise.all([dependencies.readAliases(), dependencies.listCompanies()]);
    return NextResponse.json({ aliases, companies, units: CATALOG_UNITS satisfies readonly CatalogUnit[] });
  } catch (error) {
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Aliasy katalogových položek se nepodařilo načíst." }, { status: 502 });
  }
}

export async function handleCatalogAliasesSave(request: NextRequest, dependencies: CatalogAliasDependencies = defaultDependencies): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) return NextResponse.json({ error: "Pro úpravu aliasů je vyžadováno přihlášení." }, { status: 401 });
  let body: { catalogItemId?: unknown; aliases?: unknown };
  try {
    body = (await request.json()) as { catalogItemId?: unknown; aliases?: unknown };
  } catch {
    return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 });
  }
  if (typeof body.catalogItemId !== "string" || !body.catalogItemId) return NextResponse.json({ error: "Chybí id katalogové položky." }, { status: 400 });
  try {
    const aliases = await dependencies.saveAliases(body.catalogItemId, parseCatalogItemAliasInputs(body.aliases));
    return NextResponse.json({ aliases });
  } catch (error) {
    if (error instanceof InvalidCatalogAliasesError) return NextResponse.json({ error: error.message, issues: error.issues }, { status: error.issues.some((issue) => issue.code === "TAKEN") ? 409 : 400 });
    if (error instanceof CatalogItemAdminNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
    if (error instanceof CatalogSchemaNotMigratedError) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Aliasy se nepodařilo uložit." }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  return handleCatalogAliasesGet(request);
}

export async function POST(request: NextRequest) {
  return handleCatalogAliasesSave(request);
}
