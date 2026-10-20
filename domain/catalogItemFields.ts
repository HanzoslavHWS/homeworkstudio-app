/**
 * Which fields a catalog card of each type has, which are required, and how they are validated
 * (V1-DATA-03). One definition for the admin form today and for the Excel templates of V1-DATA-08
 * (one sheet per item type, technical column keys in the first row). Pure, no I/O.
 *
 * Rule shared with the future Excel import: a blank OPTIONAL value is never an error — it means
 * "no value" on create and "unchanged" on update. Only required fields and invalid values block.
 */

import type { CatalogItemType } from "./models.ts";
import { abfCodeWarning, normalizeAbfCode, normalizeInternalCode } from "./catalogItemTypes.ts";
import { normalizeCatalogUnit } from "./catalogUnits.ts";

export type CatalogFieldKey =
  | "id"
  | "internal_code"
  | "abf_code"
  | "display_name"
  | "official_name"
  | "official_name_en"
  | "item_type"
  | "kind"
  | "category"
  | "unit_code"
  | "width_mm"
  | "depth_mm"
  | "height_mm"
  | "color"
  | "material"
  | "note"
  | "lifecycle_status";

export type CatalogFieldSpec = Readonly<{ key: CatalogFieldKey; labelCs: string; required: boolean }>;

const COMMON_HEAD: readonly CatalogFieldSpec[] = [
  { key: "id", labelCs: "ID (neměnit)", required: false },
  { key: "internal_code", labelCs: "Generátorový kód", required: false },
  { key: "abf_code", labelCs: "ABF kód", required: false },
  { key: "display_name", labelCs: "Interní název HomeworkStudio", required: true },
  { key: "official_name", labelCs: "Oficiální název ABF (CZ)", required: false },
  { key: "official_name_en", labelCs: "Oficiální název ABF (EN)", required: false },
  { key: "kind", labelCs: "Druh", required: false },
  { key: "category", labelCs: "Kategorie", required: true },
  { key: "unit_code", labelCs: "Měrná jednotka", required: false },
];
const DIMENSIONS: readonly CatalogFieldSpec[] = [
  { key: "width_mm", labelCs: "Šířka (mm)", required: false },
  { key: "depth_mm", labelCs: "Hloubka (mm)", required: false },
  { key: "height_mm", labelCs: "Výška (mm)", required: false },
];
const MATERIAL: readonly CatalogFieldSpec[] = [
  { key: "color", labelCs: "Barva", required: false },
  { key: "material", labelCs: "Materiál", required: false },
];
const COMMON_TAIL: readonly CatalogFieldSpec[] = [
  { key: "note", labelCs: "Poznámka", required: false },
  { key: "lifecycle_status", labelCs: "Stav", required: false },
];

/** Fields per item type, in sheet column order. */
export const CATALOG_FIELDS_BY_TYPE: Readonly<Record<CatalogItemType, readonly CatalogFieldSpec[]>> = {
  PRODUCT: [...COMMON_HEAD, ...DIMENSIONS, ...MATERIAL, ...COMMON_TAIL],
  SERVICE: [...COMMON_HEAD, ...COMMON_TAIL],
  BOOTH: [...COMMON_HEAD, ...DIMENSIONS, ...COMMON_TAIL],
  INTERNAL_COMPONENT: [...COMMON_HEAD, ...DIMENSIONS, ...MATERIAL, ...COMMON_TAIL],
  KIT: [...COMMON_HEAD, ...COMMON_TAIL],
};

/** Excel sheet name per item type (V1-DATA-08). */
export const CATALOG_SHEET_BY_TYPE: Readonly<Record<CatalogItemType, string>> = {
  PRODUCT: "Produkty",
  SERVICE: "Sluzby",
  BOOTH: "Stanky",
  INTERNAL_COMPONENT: "InterniKomponenty",
  KIT: "Komplety",
};

export function catalogTypeHasField(itemType: CatalogItemType, key: CatalogFieldKey): boolean {
  return CATALOG_FIELDS_BY_TYPE[itemType].some((field) => field.key === key);
}

export type CatalogFieldIssue = Readonly<{ field: CatalogFieldKey; severity: "error" | "warning"; message: string }>;

export type CatalogIdentityValues = Readonly<{
  internalCode?: string | null;
  abfCode?: string | null;
  displayName?: string | null;
  category?: string | null;
  unitCode?: string | null;
  widthMm?: number | null;
  depthMm?: number | null;
  heightMm?: number | null;
}>;

/**
 * Validates the identity fields of one card (create, edit, future Excel row). `mode: "update"`
 * treats a missing required value as "unchanged" (Excel: blank cell never clears), `mode: "create"`
 * requires it.
 */
export function validateCatalogIdentity(itemType: CatalogItemType, values: CatalogIdentityValues, mode: "create" | "update"): readonly CatalogFieldIssue[] {
  const issues: CatalogFieldIssue[] = [];
  const blank = (value: string | null | undefined) => !value || !value.trim();
  if (mode === "create") {
    for (const field of CATALOG_FIELDS_BY_TYPE[itemType]) {
      if (!field.required) continue;
      const value = field.key === "display_name" ? values.displayName : field.key === "category" ? values.category : undefined;
      if (blank(value)) issues.push({ field: field.key, severity: "error", message: `Pole „${field.labelCs}“ je povinné.` });
    }
  }
  if (!blank(values.internalCode) && !normalizeInternalCode(values.internalCode)) {
    issues.push({ field: "internal_code", severity: "error", message: "Generátorový kód smí obsahovat jen písmena, číslice a . _ / + - (bez mezer), nejvýše 64 znaků." });
  }
  if (!blank(values.abfCode)) {
    const abf = normalizeAbfCode(values.abfCode);
    if (!abf) issues.push({ field: "abf_code", severity: "error", message: "ABF kód smí obsahovat jen písmena, číslice a . _ / + - (bez mezer), nejvýše 32 znaků." });
    else {
      const warning = abfCodeWarning(abf);
      if (warning) issues.push({ field: "abf_code", severity: "warning", message: warning });
    }
  }
  if (!blank(values.unitCode)) {
    const unit = normalizeCatalogUnit(values.unitCode);
    if (unit.status !== "known") issues.push({ field: "unit_code", severity: "error", message: unit.status === "empty" ? "Neplatná jednotka." : unit.message });
  }
  for (const [field, value] of [["width_mm", values.widthMm], ["depth_mm", values.depthMm], ["height_mm", values.heightMm]] as const) {
    if (value === null || value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) issues.push({ field, severity: "error", message: "Rozměr musí být nezáporné číslo v milimetrech." });
  }
  return issues;
}
