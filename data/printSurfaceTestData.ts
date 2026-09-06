/**
 * Tiskové plochy — PLACEHOLDER test values for the "Realizačka" select, standing in until a real
 * Excel import supplies actual realizační firmy and their per-item production dimensions (see
 * domain/printSurfaceProject.ts's reserved widthProductionMm/heightProductionMm fields). No
 * production dimensions are attached here on purpose — this is only an id/name picklist, never a
 * hardcoded size table.
 */

export type RealizationCompanyOption = Readonly<{ id: string; name: string }>;

export const TEST_REALIZATION_COMPANIES: readonly RealizationCompanyOption[] = [
  { id: "test-realizacka-1", name: "Realizačka A (testovací)" },
  { id: "test-realizacka-2", name: "Realizačka B (testovací)" },
  { id: "test-realizacka-3", name: "Realizačka C (testovací)" },
];
