import { NextResponse, type NextRequest } from "next/server.js";
import { denyUnless } from "../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../lib/db/supabase.server.ts";
import { SupabaseRealizationCompanyRepository } from "../../../../lib/db/realizationCompanyRepository.supabase.ts";
import { SupabasePrintSurfacePresetRepository } from "../../../../lib/db/printSurfacePresetRepository.supabase.ts";
import { SupabasePrintSurfaceProductionDimensionRepository } from "../../../../lib/db/printSurfaceProductionDimensionRepository.supabase.ts";
import type { RealizationCompanyRepository } from "../../../../domain/realizationCompany.ts";
import type { PrintSurfacePresetRepository } from "../../../../domain/printSurfacePreset.ts";
import type { PrintSurfaceProductionDimensionRepository } from "../../../../domain/printSurfaceProductionDimension.ts";

/**
 * Read side of the print-surface catalog (realization companies / presets / production
 * dimensions) — GET returns all three at once. Writing goes only through the non-destructive,
 * transactional sync in app/api/print-surfaces/catalog/sync/route.ts (V1-DATA-02, B1); the old
 * POST that deleted and re-inserted the whole catalog is gone. Firm cards are edited in
 * app/api/realization-companies.
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
  const authDenied = await denyUnless(request, "printSurfaces.use");
  if (authDenied) return authDenied;
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

export async function GET(request: NextRequest) {
  return handlePrintSurfaceCatalogGet(request);
}
