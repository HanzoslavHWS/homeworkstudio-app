/**
 * Tiskové plochy — config-backed seed for RealizationCompanyRepository (see
 * lib/db/realizationCompanyRepository.config.client.ts). These are the SAME placeholder test
 * companies introduced in phase 1 (data/printSurfaceTestData.ts), now reshaped onto the real
 * RealizationCompany model — no new/real companies invented here. Once the user's real Excel
 * import (or a DB-backed repository) is wired in, this file is simply replaced.
 */
import type { RealizationCompany } from "../domain/realizationCompany.ts";

export const REALIZATION_COMPANIES: readonly RealizationCompany[] = [
  { id: "test-realizacka-1", name: "Realizačka A (testovací)", isActive: true },
  { id: "test-realizacka-2", name: "Realizačka B (testovací)", isActive: true },
  { id: "test-realizacka-3", name: "Realizačka C (testovací)", isActive: true },
];
