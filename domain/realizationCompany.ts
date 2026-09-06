/**
 * Tiskové plochy — realizační společnost (the physical print/production vendor a booth's print
 * surfaces get manufactured by). A stable, language-neutral catalog entry — never referenced by
 * name in logic; see domain/printSurfaceProductionDimension.ts for how a company's ACTUAL
 * production sizes are looked up (never hardcoded per-company if/else here or anywhere else).
 */
export type RealizationCompany = Readonly<{
  id: string;
  name: string;
  isActive: boolean;
  note?: string;
}>;

export interface RealizationCompanyRepository {
  list(): Promise<readonly RealizationCompany[]>;
}
