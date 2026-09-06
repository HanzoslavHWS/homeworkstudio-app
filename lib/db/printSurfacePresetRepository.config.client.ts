import type { PrintSurfacePreset, PrintSurfacePresetRepository } from "../../domain/printSurfacePreset.ts";
import { PRINT_SURFACE_PRESETS } from "../../data/printSurfacePresets.ts";

/** Static config-backed implementation — see ConfigRealizationCompanyRepository's doc for the swap plan. */
export class ConfigPrintSurfacePresetRepository implements PrintSurfacePresetRepository {
  async list(): Promise<readonly PrintSurfacePreset[]> {
    return PRINT_SURFACE_PRESETS;
  }
}
