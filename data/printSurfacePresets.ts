/**
 * Tiskové plochy — config-backed seed for PrintSurfacePresetRepository (see
 * lib/db/printSurfacePresetRepository.config.client.ts). Intentionally EMPTY — the real preset
 * catalog (concrete names like "Panel standard", "Panel nad dveřmi", "Límec", ...) comes from the
 * user's Excel import; inventing placeholder presets here would risk being mistaken for real data.
 * Until then, the "Preset" dropdown in the inspector legitimately has nothing to offer, and the
 * "Tiskové plochy" data-status count is 0 — see components/workflow/PrintSurfacesPage.tsx.
 */
import type { PrintSurfacePreset } from "../domain/printSurfacePreset.ts";

export const PRINT_SURFACE_PRESETS: readonly PrintSurfacePreset[] = [];
