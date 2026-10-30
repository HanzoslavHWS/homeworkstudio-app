/**
 * Technické rastry — the registry of KNOWN technical service categories (electricity, internet,
 * water, waste, cleaning, ...). Deliberately a small array + lookup, NOT a closed TypeScript union
 * threaded through every function signature — adding a category later (spec section 8: "další
 * typy později bez refactoru") means adding one entry here plus one parser
 * (domain/technicalReportParsers/), never touching the stand/service/import types themselves,
 * which all store `category` as a plain string.
 */

export type TechnicalServiceCategory = Readonly<{
  id: string;
  labelCz: string;
}>;

export const TECHNICAL_SERVICE_CATEGORIES: readonly TechnicalServiceCategory[] = [
  { id: "electricity", labelCz: "Elektrická energie" },
  { id: "internet", labelCz: "Internet / WiFi" },
  { id: "water", labelCz: "Voda" },
  { id: "waste", labelCz: "Odpad" },
  { id: "cleaning", labelCz: "Úklid" },
  { id: "other", labelCz: "Jiný / budoucí" },
];

/**
 * Import SOURCES that are not a single service category: the ABRA order form holds services of every
 * category in one import (domain/abraOrderTechnicalImport.ts). Deliberately kept out of
 * TECHNICAL_SERVICE_CATEGORIES, which drives the marker filters, legend and export checkboxes.
 */
export const TECHNICAL_IMPORT_SOURCES: readonly TechnicalServiceCategory[] = [
  { id: "abra-orders", labelCz: "Formulář objednávek ABRA (všechny technické služby)" },
];

export function technicalServiceCategoryLabel(categoryId: string): string {
  return TECHNICAL_SERVICE_CATEGORIES.find((category) => category.id === categoryId)?.labelCz
    ?? TECHNICAL_IMPORT_SOURCES.find((source) => source.id === categoryId)?.labelCz
    ?? categoryId;
}

export function isKnownTechnicalServiceCategory(categoryId: string): boolean {
  return TECHNICAL_SERVICE_CATEGORIES.some((category) => category.id === categoryId);
}
