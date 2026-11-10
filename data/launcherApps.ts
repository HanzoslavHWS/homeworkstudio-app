import type { HwsAppKey } from "../domain/hwsApps";

/**
 * Presentation of the launcher cards (logo, version, call to action) per application key. Which
 * cards an account sees, their names, addresses and availability come from the application registry
 * and the account's memberships (domain/hwsApps.ts launcherEntries, V1-AUTH-02) — never from here.
 */
export type LauncherPresentation = Readonly<{ logo: string; version?: string; cta?: string }>;

export const launcherPresentation: Readonly<Record<HwsAppKey, LauncherPresentation>> = {
  "hws-easy": { logo: "/logo/hws_easy_logo.png", version: "v1.0" },
  abf: { logo: "/logo/abf_generator_logo.png", cta: "Vstoupit do generátoru" },
};
