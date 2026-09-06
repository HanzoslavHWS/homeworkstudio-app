import type { RealizationCompany, RealizationCompanyRepository } from "../../domain/realizationCompany.ts";
import { REALIZATION_COMPANIES } from "../../data/realizationCompanies.ts";

/**
 * Static config-backed implementation — same architectural slot as
 * lib/db/printSurfaceProjectRepository.localStorage.client.ts, but for reference/catalog data
 * rather than a user's own project. Swappable later for an Excel-import-backed or DB-backed
 * repository without touching any caller (PrintSurfacesPage only depends on the interface).
 */
export class ConfigRealizationCompanyRepository implements RealizationCompanyRepository {
  async list(): Promise<readonly RealizationCompany[]> {
    return REALIZATION_COMPANIES;
  }
}
