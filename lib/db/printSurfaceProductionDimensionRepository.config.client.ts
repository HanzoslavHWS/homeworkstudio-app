import type {
  PrintSurfaceProductionDimension,
  PrintSurfaceProductionDimensionRepository,
} from "../../domain/printSurfaceProductionDimension.ts";
import { PRINT_SURFACE_PRODUCTION_DIMENSIONS } from "../../data/printSurfaceProductionDimensions.ts";

/** Static config-backed implementation — see ConfigRealizationCompanyRepository's doc for the swap plan. */
export class ConfigPrintSurfaceProductionDimensionRepository implements PrintSurfaceProductionDimensionRepository {
  async list(): Promise<readonly PrintSurfaceProductionDimension[]> {
    return PRINT_SURFACE_PRODUCTION_DIMENSIONS;
  }
}
