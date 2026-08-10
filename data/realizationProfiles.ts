import type { RealizationProfile } from "../domain/models.ts";

export const DEFAULT_REALIZATION_PROFILE_ID = "default";

/** Placeholder names are intentionally centralized here for later replacement. */
export const realizationProfiles = [
  { id: DEFAULT_REALIZATION_PROFILE_ID, name: "Default" },
  { id: "realization-2", name: "Realizačka 2" },
  { id: "realization-3", name: "Realizačka 3" },
  { id: "realization-4", name: "Realizačka 4" },
] as const satisfies readonly RealizationProfile[];
