import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../lib/db/supabase.server.ts";
import { SupabaseRealizationCompanyRepository } from "../../../../lib/db/realizationCompanyRepository.supabase.ts";
import { SupabasePrintSurfacePresetRepository } from "../../../../lib/db/printSurfacePresetRepository.supabase.ts";
import { SupabasePrintSurfaceProductionDimensionRepository } from "../../../../lib/db/printSurfaceProductionDimensionRepository.supabase.ts";
import type { RealizationCompany, RealizationCompanyRepository } from "../../../../domain/realizationCompany.ts";
import type { PrintSurfacePreset, PrintSurfacePresetRepository } from "../../../../domain/printSurfacePreset.ts";
import type {
  PrintSurfaceProductionDimension,
  PrintSurfaceProductionDimensionRepository,
} from "../../../../domain/printSurfaceProductionDimension.ts";

/**
 * Realization companies / presets / production dimensions are always imported and replaced
 * together (one Excel import produces all three at once — see domain/printSurfaceExcelImport.ts
 * and PrintSurfaceCatalogImportPanel), so they share this one route rather than three near-
 * identical ones: GET returns the full catalog, POST replaces whichever of
 * companies/presets/productionDimensions is present in the body (each independently — a caller
 * sending only `{ companies }` leaves presets/productionDimensions untouched).
 */
export type PrintSurfaceCatalogRepositories = Readonly<{
  companies: RealizationCompanyRepository;
  presets: PrintSurfacePresetRepository;
  productionDimensions: PrintSurfaceProductionDimensionRepository;
}>;

function defaultRepositoryFactory(): PrintSurfaceCatalogRepositories {
  const client = createSupabaseServerClient();
  return {
    companies: new SupabaseRealizationCompanyRepository(client),
    presets: new SupabasePrintSurfacePresetRepository(client),
    productionDimensions: new SupabasePrintSurfaceProductionDimensionRepository(client),
  };
}

export async function handlePrintSurfaceCatalogGet(
  request: NextRequest,
  repositoryFactory: () => PrintSurfaceCatalogRepositories = defaultRepositoryFactory,
): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) {
    return NextResponse.json({ error: "Pro přístup ke katalogu tiskových ploch je vyžadováno přihlášení." }, { status: 401 });
  }
  try {
    const repositories = repositoryFactory();
    const [companies, presets, productionDimensions] = await Promise.all([
      repositories.companies.list(),
      repositories.presets.list(),
      repositories.productionDimensions.list(),
    ]);
    return NextResponse.json({ companies, presets, productionDimensions });
  } catch (error) {
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Katalog tiskových ploch se nepodařilo načíst z databáze." }, { status: 502 });
  }
}

type CatalogReplaceBody = Readonly<{
  companies?: readonly RealizationCompany[];
  presets?: readonly PrintSurfacePreset[];
  productionDimensions?: readonly PrintSurfaceProductionDimension[];
}>;

export async function handlePrintSurfaceCatalogReplace(
  request: NextRequest,
  repositoryFactory: () => PrintSurfaceCatalogRepositories = defaultRepositoryFactory,
): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) {
    return NextResponse.json({ error: "Pro úpravu katalogu tiskových ploch je vyžadováno přihlášení." }, { status: 401 });
  }
  let body: CatalogReplaceBody;
  try {
    body = (await request.json()) as CatalogReplaceBody;
  } catch {
    return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 });
  }
  try {
    const repositories = repositoryFactory();
    if (body.companies) await repositories.companies.replaceAll(body.companies);
    if (body.presets) await repositories.presets.replaceAll(body.presets);
    if (body.productionDimensions) await repositories.productionDimensions.replaceAll(body.productionDimensions);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Uložení katalogu tiskových ploch selhalo." }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  return handlePrintSurfaceCatalogGet(request);
}

export async function POST(request: NextRequest) {
  return handlePrintSurfaceCatalogReplace(request);
}
