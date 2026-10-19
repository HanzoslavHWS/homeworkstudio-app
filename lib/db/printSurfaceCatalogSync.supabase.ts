import type { SupabaseClient } from "@supabase/supabase-js";
import type { PrintSurfaceCatalogSyncPayload } from "../../domain/printSurfaceCatalogSync.ts";
import { isMissingSchemaError, RealizationCompaniesNotMigratedError } from "./realizationCompanyRepository.supabase.ts";

export type PrintSurfaceCatalogSyncResult = Readonly<{
  companiesCreated: number;
  presetsWritten: number;
  dimensionsWritten: number;
  companiesDeactivated: number;
  presetsDeactivated: number;
}>;

/** Calls the transactional `sync_print_surface_catalog` function (migration 20261019130000) — the only write path of the print-surface catalog. */
export async function applyPrintSurfaceCatalogSync(client: SupabaseClient, payload: PrintSurfaceCatalogSyncPayload): Promise<PrintSurfaceCatalogSyncResult> {
  const { data, error } = await client.rpc("sync_print_surface_catalog", {
    p_companies: payload.companies,
    p_presets: payload.presets,
    p_dimensions: payload.productionDimensions,
    p_deactivate_company_ids: payload.deactivateCompanyIds,
    p_deactivate_preset_ids: payload.deactivatePresetIds,
  });
  if (error) throw isMissingSchemaError(error) ? new RealizationCompaniesNotMigratedError() : error;
  return data as PrintSurfaceCatalogSyncResult;
}
