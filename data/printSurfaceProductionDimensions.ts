/**
 * Tiskové plochy — config-backed seed for PrintSurfaceProductionDimensionRepository (see
 * lib/db/printSurfaceProductionDimensionRepository.config.client.ts). Intentionally EMPTY — real
 * production sizes must come from the user's Excel import, never guessed or invented here (spec:
 * "NEVYMÝŠLEJ žádné skutečné výrobní rozměry"). Until then, resolvePrintSurfaceProductionDimension
 * correctly reports "not_found" for every marker, which the UI shows as "Rozměr není definován" —
 * an expected state, not an error.
 */
import type { PrintSurfaceProductionDimension } from "../domain/printSurfaceProductionDimension.ts";

export const PRINT_SURFACE_PRODUCTION_DIMENSIONS: readonly PrintSurfaceProductionDimension[] = [];
