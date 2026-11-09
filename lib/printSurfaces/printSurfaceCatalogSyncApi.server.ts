import { NextResponse, type NextRequest } from "next/server.js";
import { denyUnless } from "../auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../db/supabase.server.ts";
import { RealizationCompaniesNotMigratedError, SupabaseRealizationCompanyRepository } from "../db/realizationCompanyRepository.supabase.ts";
import { SupabasePrintSurfacePresetRepository } from "../db/printSurfacePresetRepository.supabase.ts";
import { SupabasePrintSurfaceProductionDimensionRepository } from "../db/printSurfaceProductionDimensionRepository.supabase.ts";
import { applyPrintSurfaceCatalogSync, type PrintSurfaceCatalogSyncResult } from "../db/printSurfaceCatalogSync.supabase.ts";
import {
  planPrintSurfaceCatalogSync,
  type PrintSurfaceCatalogSnapshot,
  type PrintSurfaceCatalogSyncPayload,
  type PrintSurfaceCatalogSyncPlan,
} from "../../domain/printSurfaceCatalogSync.ts";
import type { PrintSurfaceExcelImportResult } from "../../domain/printSurfaceExcelImport.ts";

/**
 * POST /api/print-surfaces/catalog/sync — `{ mode: "preview" | "apply", imported, options }`.
 * The plan is always recomputed here from the CURRENT database state (never trusted from the
 * browser), so "apply" writes exactly what a fresh preview would show. Writing goes through the
 * transactional database function only (B1).
 */
export type PrintSurfaceCatalogSyncDependencies = Readonly<{
  loadSnapshot: () => Promise<PrintSurfaceCatalogSnapshot>;
  apply: (payload: PrintSurfaceCatalogSyncPayload) => Promise<PrintSurfaceCatalogSyncResult>;
}>;

export const defaultPrintSurfaceCatalogSyncDependencies: PrintSurfaceCatalogSyncDependencies = {
  loadSnapshot: async () => {
    const client = createSupabaseServerClient();
    const companyRepository = new SupabaseRealizationCompanyRepository(client);
    const [companies, aliases, legacyIds, presets, productionDimensions] = await Promise.all([
      companyRepository.list(),
      companyRepository.listAliases(),
      companyRepository.listLegacyIds(),
      new SupabasePrintSurfacePresetRepository(client).list(),
      new SupabasePrintSurfaceProductionDimensionRepository(client).list(),
    ]);
    return { companies, aliases, legacyIds, presets, productionDimensions };
  },
  apply: (payload) => applyPrintSurfaceCatalogSync(createSupabaseServerClient(), payload),
};

function isImportResult(value: unknown): value is PrintSurfaceExcelImportResult {
  const candidate = value as Partial<PrintSurfaceExcelImportResult> | null;
  return Boolean(candidate)
    && Array.isArray(candidate!.companies)
    && Array.isArray(candidate!.presets)
    && Array.isArray(candidate!.productionDimensions)
    && typeof candidate!.counts?.errors === "number";
}

function errorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof SupabaseConfigurationError || error instanceof RealizationCompaniesNotMigratedError) {
    return NextResponse.json({ error: error.message }, { status: 503 });
  }
  return NextResponse.json({ error: fallback }, { status: 502 });
}

export async function handlePrintSurfaceCatalogSync(
  request: NextRequest,
  dependencies: PrintSurfaceCatalogSyncDependencies = defaultPrintSurfaceCatalogSyncDependencies,
): Promise<NextResponse> {
  const authDenied = await denyUnless(request, "printSurfaces.catalogSync");
  if (authDenied) return authDenied;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 });
  }
  const mode = body.mode;
  if (mode !== "preview" && mode !== "apply") return NextResponse.json({ error: "Neznámý režim synchronizace." }, { status: 400 });
  if (!isImportResult(body.imported)) return NextResponse.json({ error: "Chybí výsledek načtení Excelu." }, { status: 400 });
  const rawOptions = (body.options ?? {}) as Record<string, unknown>;
  const options = { deactivateMissingPresets: rawOptions.deactivateMissingPresets === true, deactivateMissingCompanies: rawOptions.deactivateMissingCompanies === true };

  let plan: PrintSurfaceCatalogSyncPlan;
  try {
    plan = planPrintSurfaceCatalogSync(body.imported, await dependencies.loadSnapshot(), options);
  } catch (error) {
    return errorResponse(error, "Katalog tiskových ploch se nepodařilo načíst z databáze.");
  }
  if (mode === "preview") return NextResponse.json({ plan });
  if (!plan.canApply) return NextResponse.json({ error: "Synchronizace obsahuje blokující chyby.", plan }, { status: 409 });

  try {
    const result = await dependencies.apply(plan.payload);
    return NextResponse.json({ plan, result });
  } catch (error) {
    return errorResponse(error, "Synchronizace katalogu tiskových ploch selhala, nic nebylo změněno.");
  }
}
