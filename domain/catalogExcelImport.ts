/**
 * Catalog Excel import — workbook "Generator_ABF_Katalog" (docs/CATALOG_IMPORT_TEMPLATE_SPEC.md).
 * Pure: parses sheet grids and plans the changes against the current catalog; never writes.
 * Supported sheets, planned together in ONE plan: `Produkty` (cards of type PRODUCT) and `Sluzby`
 * (type SERVICE — technical services, graphics, technical points).
 *
 * Sheet layout: row 1 = technical column keys (the only thing the import reads), row 2 = Czech
 * labels (free to rename), data from row 3. Fully blank rows are ignored.
 *
 * Cell semantics (decision A6):
 *   - empty cell        = unchanged on update, "no value" on create — never clears;
 *   - 0 / NE            = real values (0 mm, 0 kW, false);
 *   - #SMAZAT           = clear the value, only for optional fields that may be cleared.
 * Text is compared exactly (case-sensitive: "Wifi" → "WIFI" is a change); only the outer
 * whitespace is normalized (official names: all whitespace runs, as the admin stores them).
 *
 * Row identity: id → generator code → ABF code, across both sheets. A row whose identities point to
 * different cards, a key used by two rows, a code change of an existing card or a card of another
 * type is a CONFLICT — nothing is ever merged automatically. Only fields of the row's sheet are
 * touched: files, prices, attachments, aliases, kit contents and the lifecycle of an existing card
 * are left alone; a new card is "K doplnění". Dimensions are millimetres; a value that looks like
 * centimetres is refused, never converted.
 *
 * The plan carries the exact create input / edit the admin API accepts (catalogItemCreateInput /
 * catalogItemEdit), so the write applies precisely what the preview showed.
 */
import {
  CATALOG_PUBLICATION_DESCRIPTION_MAX,
  CATALOG_PUBLICATION_NAME_MAX,
  CATALOG_PUBLICATION_SORT_ORDER_MAX,
  applyCatalogItemEdit,
  documentAttributes,
  documentCatalogPublication,
  documentNote,
  documentServiceTechnical,
  documentUsageAgreement,
  documentVariantOptions,
  itemTypeOf,
  normalizeOfficialNameText,
  NOTE_MAX_LENGTH,
  OFFICIAL_NAME_MAX,
  type CatalogItemAdmin,
  type CatalogItemAdminCreateInput,
  type CatalogItemAdminEdit,
} from "./catalogItemsAdmin.ts";
import { assertNoCrossCodeCollision, normalizeAbfCode, normalizeInternalCode } from "./catalogItemTypes.ts";
import { classificationIssue, classificationTarget, type CatalogCategoryDef, type ComponentGroup } from "./catalogClassification.ts";
import { catalogUnitByCode, normalizeCatalogUnit } from "./catalogUnits.ts";
import { CARD_VARIANT_SCOPES, type CardVariantScope, type CatalogVariantSet } from "./catalogVariants.ts";
import { EXCEL_DELETE_MARKER } from "./priceVersionExcel.ts";
import type { CatalogItemKind, CatalogItemType, ComponentDefinition } from "./models.ts";
import { evaluateCatalogReadiness, withColumnInternalCode } from "./catalogReadiness.ts";

export const CATALOG_TEMPLATE_FORMAT = "catalog-template/1";
export { EXCEL_DELETE_MARKER };

/** A workbook cell as read by extractStrictSheetGrid: Excel booleans and error values are kept, never read as empty. */
export type RawCell = string | number | boolean | Readonly<{ excelError: string }> | null | undefined;
export type SheetGrid = readonly (readonly RawCell[])[];
export type WorkbookSheetInput = Readonly<{ name: string; grid: SheetGrid }>;

/** Helper sheets of the template — never data. */
export const CATALOG_HELPER_SHEETS = ["Navod", "Vzory", "Ciselniky", "_meta"] as const;
/** Data sheets of the template (docs spec 6.1). Only SUPPORTED ones are imported today. */
export const CATALOG_DATA_SHEETS = ["Produkty", "Sluzby", "InterniKomponenty", "Stanky", "Komplety", "ObsahKompletu", "Nahrady", "Vzorniky", "Barvy", "Aliasy", "Parametry"] as const;
export const CATALOG_SUPPORTED_SHEETS = ["Produkty", "Sluzby"] as const;
export type CatalogImportSheet = (typeof CATALOG_SUPPORTED_SHEETS)[number];

// ---------------------------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------------------------
type FieldType = "uuid" | "generatorCode" | "abfCode" | "text" | "officialText" | "category" | "unit" | "number" | "dimension" | "bool" | "sortOrder" | "variantSet" | "variantScope" | "readOnly";
type FieldSpec = Readonly<{ key: string; labelCs: string; type: FieldType; deletable: boolean; max?: number }>;

const ATTRIBUTE_TEXT_MAX = 200;
const USAGE_AGREEMENT_PAYER_MAX = 80;

const F = {
  id: { key: "id", labelCs: "ID", type: "uuid", deletable: false },
  generator_code: { key: "generator_code", labelCs: "Generátorový kód", type: "generatorCode", deletable: false },
  abf_code: { key: "abf_code", labelCs: "ABF kód", type: "abfCode", deletable: false },
  display_name: { key: "display_name", labelCs: "Interní název HomeworkStudio", type: "text", deletable: false },
  official_name: { key: "official_name", labelCs: "Oficiální název ABF (CZ)", type: "officialText", deletable: true, max: OFFICIAL_NAME_MAX },
  official_name_en: { key: "official_name_en", labelCs: "Oficiální název ABF (EN)", type: "officialText", deletable: true, max: OFFICIAL_NAME_MAX },
  category: { key: "category", labelCs: "Kategorie", type: "category", deletable: false },
  unit_code: { key: "unit_code", labelCs: "Měrná jednotka", type: "unit", deletable: true },
  width_mm: { key: "width_mm", labelCs: "Šířka (mm)", type: "dimension", deletable: false },
  depth_mm: { key: "depth_mm", labelCs: "Hloubka (mm)", type: "dimension", deletable: false },
  height_mm: { key: "height_mm", labelCs: "Výška (mm)", type: "dimension", deletable: false },
  color: { key: "color", labelCs: "Barva", type: "text", deletable: true, max: ATTRIBUTE_TEXT_MAX },
  material: { key: "material", labelCs: "Materiál", type: "text", deletable: true, max: ATTRIBUTE_TEXT_MAX },
  power_kw: { key: "power_kw", labelCs: "Výkon (kW)", type: "number", deletable: true },
  show_2d: { key: "show_2d", labelCs: "2D v generátoru", type: "bool", deletable: false },
  show_3d: { key: "show_3d", labelCs: "3D v generátoru", type: "bool", deletable: false },
  variant_set: { key: "variant_set", labelCs: "Vzorník barev", type: "variantSet", deletable: true },
  variant_scope: { key: "variant_scope", labelCs: "Rozsah barev", type: "variantScope", deletable: false },
  usage_agreement_payer: { key: "usage_agreement_payer", labelCs: "Jen na dohodu — náklady nese", type: "text", deletable: true, max: USAGE_AGREEMENT_PAYER_MAX },
  catalog_visible: { key: "catalog_visible", labelCs: "Zobrazit v katalogu", type: "bool", deletable: false },
  catalog_name: { key: "catalog_name", labelCs: "Název v katalogu", type: "text", deletable: true, max: CATALOG_PUBLICATION_NAME_MAX },
  catalog_description: { key: "catalog_description", labelCs: "Krátký popis v katalogu", type: "text", deletable: true, max: CATALOG_PUBLICATION_DESCRIPTION_MAX },
  catalog_sort: { key: "catalog_sort", labelCs: "Pořadí v katalogu", type: "sortOrder", deletable: true },
  note: { key: "note", labelCs: "Poznámka", type: "text", deletable: true, max: NOTE_MAX_LENGTH },
  lifecycle_status: { key: "lifecycle_status", labelCs: "Stav", type: "readOnly", deletable: false },
} as const satisfies Record<string, FieldSpec>;

type SheetSpec = Readonly<{ name: CatalogImportSheet; itemType: CatalogItemType; groups: readonly ComponentGroup[]; fields: readonly FieldSpec[] }>;

export const SHEET_SPECS: Readonly<Record<CatalogImportSheet, SheetSpec>> = {
  Produkty: {
    name: "Produkty",
    itemType: "PRODUCT",
    groups: ["product"],
    fields: [F.id, F.generator_code, F.abf_code, F.display_name, F.official_name, F.official_name_en, F.category, F.unit_code, F.width_mm, F.depth_mm, F.height_mm, F.color, F.material, F.show_2d, F.show_3d, F.variant_set, F.variant_scope, F.usage_agreement_payer, F.catalog_visible, F.catalog_name, F.catalog_description, F.catalog_sort, F.note, F.lifecycle_status],
  },
  Sluzby: {
    name: "Sluzby",
    itemType: "SERVICE",
    groups: ["graphics", "technical_service", "technical_point"],
    fields: [F.id, F.generator_code, F.abf_code, F.display_name, F.official_name, F.official_name_en, F.category, F.unit_code, F.power_kw, F.show_2d, F.show_3d, F.catalog_visible, F.catalog_name, F.catalog_description, F.catalog_sort, F.note, F.lifecycle_status],
  },
};
export const SERVICE_SHEET_FIELDS = SHEET_SPECS.Sluzby.fields;
export const PRODUCT_SHEET_FIELDS = SHEET_SPECS.Produkty.fields;
const IDENTITY_KEYS: readonly string[] = ["id", "generator_code", "abf_code", "lifecycle_status"];
const contentFields = (spec: SheetSpec) => spec.fields.filter((field) => !IDENTITY_KEYS.includes(field.key));
const fieldLabel = (key: string) => (F as Record<string, FieldSpec>)[key]?.labelCs ?? key;

/** "Rozsah barev" — the template offers the Czech labels; the ids are accepted too. */
const VARIANT_SCOPE_LABELS: Readonly<Record<CardVariantScope, string>> = { billed_by_card: "Barvy účtované touto kartou", all_variants: "Všechny barvy vzorníku" };

export type ImportValue = string | number | boolean | null;
/** A parsed cell: unchanged, cleared (#SMAZAT) or a typed value. */
export type ParsedCell = Readonly<{ state: "empty" }> | Readonly<{ state: "delete" }> | Readonly<{ state: "value"; value: ImportValue }>;
export type ImportIssue = Readonly<{ severity: "error" | "warning"; field?: string; message: string }>;

export type ParsedSheetRow = Readonly<{ sheet: CatalogImportSheet; rowNumber: number; cells: Readonly<Record<string, ParsedCell>>; issues: readonly ImportIssue[] }>;
/** @deprecated name kept for the first (Sluzby-only) callers */
export type ParsedServiceRow = ParsedSheetRow;

export type FieldChange = Readonly<{ field: string; labelCs: string; before: ImportValue; after: ImportValue }>;
export type PlanAction = "create" | "update" | "unchanged" | "conflict";

export type CatalogRowPlan = Readonly<{
  sheet: CatalogImportSheet;
  rowNumber: number;
  /** Generator code, else ABF code, else id — how the row is shown. */
  label: string;
  action: PlanAction;
  itemId?: string;
  changes: readonly FieldChange[];
  issues: readonly ImportIssue[];
  /** create: the exact admin create input — one insert, every imported field included. */
  createInput?: CatalogItemAdminCreateInput;
  /** update: the exact admin edit, saved only if the card's updated_at is still this one. */
  edit?: CatalogItemAdminEdit;
  expectedUpdatedAt?: string;
}>;
export type ServiceRowPlan = CatalogRowPlan;

export type SheetReport = Readonly<{ name: string; status: "imported" | "helper" | "empty" | "unsupported_with_data" | "unknown_with_data"; dataRows: number }>;
export type PlanCounts = Readonly<{ create: number; update: number; unchanged: number; conflict: number }>;

export type CatalogImportPlan = Readonly<{
  templateFormat: string | null;
  environment: string | null;
  sheets: readonly SheetReport[];
  issues: readonly ImportIssue[];
  rows: readonly CatalogRowPlan[];
  summary: PlanCounts & Readonly<{ warnings: number }>;
  bySheet: Readonly<Partial<Record<CatalogImportSheet, PlanCounts>>>;
}>;

export type CatalogImportContext = Readonly<{
  items: readonly CatalogItemAdmin[];
  categories: readonly CatalogCategoryDef[];
  /** Swatch books, for `variant_set` (by code). Absent = none known. */
  variantSets?: readonly CatalogVariantSet[];
  /** Target environment label (e.g. "DEV") — compared with _meta.environment. */
  targetEnvironment?: string;
}>;

// ---------------------------------------------------------------------------------------------
// Cell parsing
// ---------------------------------------------------------------------------------------------
const plain = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLocaleLowerCase("cs").replace(/\s+/gu, " ");
const isBlank = (value: RawCell) => value === null || value === undefined || (typeof value === "string" && value.trim() === "");
const isDeleteMarker = (value: RawCell) => typeof value === "string" && value.trim().toUpperCase() === EXCEL_DELETE_MARKER;

export function isBlankRow(row: readonly RawCell[]): boolean {
  return row.every(isBlank);
}

/** Excel number or Czech decimal text ("0,5", "1 200"). */
function parseNumber(value: RawCell): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.trim().replace(/\s/gu, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBool(value: RawCell): boolean | undefined {
  if (typeof value === "boolean") return value;
  const text = typeof value === "string" ? plain(value) : typeof value === "number" ? String(value) : "";
  if (text === "ano") return true;
  if (text === "ne") return false;
  return undefined;
}

export type CategoryResolution = Readonly<{ category?: CatalogCategoryDef; message?: string }>;

/** Category by register id, else by its Czech name (case and diacritics ignored). Ambiguous names are refused. */
export function resolveCategory(text: string, categories: readonly CatalogCategoryDef[]): CategoryResolution {
  const byId = categories.find((category) => category.id === text.trim());
  if (byId) return { category: byId };
  const matches = categories.filter((category) => plain(category.name) === plain(text));
  if (matches.length === 1) return { category: matches[0]! };
  if (matches.length > 1) return { message: `Kategorie „${text}“ je v registru vícekrát (${matches.map((category) => category.id).join(", ")}) — zadejte identifikátor.` };
  return { message: `Kategorie „${text}“ není v registru kategorií.` };
}

type CellContext = Readonly<{ categories: readonly CatalogCategoryDef[]; variantSets: readonly CatalogVariantSet[] }>;

function parseCell(field: FieldSpec, raw: RawCell, context: CellContext): Readonly<{ cell: ParsedCell; issue?: ImportIssue }> {
  if (isBlank(raw)) return { cell: { state: "empty" } };
  const error = (message: string) => ({ cell: { state: "empty" } as ParsedCell, issue: { severity: "error" as const, field: field.key, message: `${field.labelCs}: ${message}` } });
  if (isDeleteMarker(raw)) {
    return field.deletable ? { cell: { state: "delete" } } : error(`hodnotu nelze smazat značkou ${EXCEL_DELETE_MARKER}.`);
  }
  if (typeof raw === "object") return error(`buňka obsahuje chybu Excelu ${raw.excelError} — opravte vzorec nebo zadejte hodnotu.`);
  // Excel logical value (TRUE/FALSE, PRAVDA/NEPRAVDA): accepted only where a yes/no is expected.
  if (typeof raw === "boolean" && field.type !== "bool") return error(`logická hodnota ${raw ? "PRAVDA" : "NEPRAVDA"} sem nepatří — zadejte text nebo číslo.`);
  const text = String(raw).trim();
  switch (field.type) {
    case "uuid":
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(text) ? { cell: { state: "value", value: text.toLowerCase() } } : error("neplatné ID (exportovaný identifikátor, neměnit).");
    case "generatorCode": {
      const code = normalizeInternalCode(text);
      return code ? { cell: { state: "value", value: code } } : error("smí obsahovat jen písmena, číslice a . _ / + - (bez mezer), nejvýše 64 znaků.");
    }
    case "abfCode": {
      const code = normalizeAbfCode(text);
      return code ? { cell: { state: "value", value: code } } : error("smí obsahovat jen písmena, číslice a . _ / + - (bez mezer), nejvýše 32 znaků.");
    }
    case "text":
      if (field.max && text.length > field.max) return error(`je delší než ${field.max} znaků.`);
      if (/[<>]/u.test(text)) return error("nesmí obsahovat znaky < a >.");
      return { cell: { state: "value", value: text } };
    case "officialText": {
      const normalized = normalizeOfficialNameText(text);
      if (normalized.length > (field.max ?? OFFICIAL_NAME_MAX) || /[<>]/u.test(normalized)) return error("je příliš dlouhý nebo obsahuje nepovolené znaky.");
      return { cell: { state: "value", value: normalized } };
    }
    case "category": {
      const resolved = resolveCategory(text, context.categories);
      return resolved.category ? { cell: { state: "value", value: resolved.category.id } } : error(resolved.message!);
    }
    case "unit": {
      const unit = normalizeCatalogUnit(text);
      return unit.status === "known" ? { cell: { state: "value", value: unit.code } } : error(unit.status === "empty" ? "neplatná jednotka." : unit.message);
    }
    case "number":
    case "dimension": {
      const value = parseNumber(raw);
      return value !== undefined && value >= 0 ? { cell: { state: "value", value } } : error("musí být nezáporné číslo.");
    }
    case "sortOrder": {
      const value = parseNumber(raw);
      return value !== undefined && Number.isInteger(value) && value >= 0 && value <= CATALOG_PUBLICATION_SORT_ORDER_MAX ? { cell: { state: "value", value } } : error(`musí být celé číslo 0–${CATALOG_PUBLICATION_SORT_ORDER_MAX}.`);
    }
    case "bool": {
      const value = parseBool(raw);
      return value !== undefined ? { cell: { state: "value", value } } : error("povolené hodnoty jsou ANO nebo NE.");
    }
    case "variantSet": {
      const set = context.variantSets.find((candidate) => candidate.code.toLocaleUpperCase("cs") === text.toLocaleUpperCase("cs") || candidate.id === text);
      return set ? { cell: { state: "value", value: set.id } } : error(`vzorník „${text}“ neexistuje.`);
    }
    case "variantScope": {
      const scope = CARD_VARIANT_SCOPES.find((candidate) => candidate === text || plain(VARIANT_SCOPE_LABELS[candidate]) === plain(text));
      return scope ? { cell: { state: "value", value: scope } } : error(`povolené hodnoty jsou „${VARIANT_SCOPE_LABELS.billed_by_card}“ nebo „${VARIANT_SCOPE_LABELS.all_variants}“.`);
    }
    case "readOnly":
      return { cell: { state: "value", value: text } };
  }
}

export type ParsedSheet = Readonly<{ rows: readonly ParsedSheetRow[]; issues: readonly ImportIssue[] }>;

/** Row 1 keys → typed cells for every non-blank data row (from row 3). */
export function parseCatalogSheet(sheet: CatalogImportSheet, grid: SheetGrid, context: Readonly<{ categories: readonly CatalogCategoryDef[]; variantSets?: readonly CatalogVariantSet[] }>): ParsedSheet {
  const spec = SHEET_SPECS[sheet];
  const cellContext: CellContext = { categories: context.categories, variantSets: context.variantSets ?? [] };
  const fieldByKey = new Map(spec.fields.map((field) => [field.key, field]));
  const issues: ImportIssue[] = [];
  const header = (grid[0] ?? []).map((cell) => (typeof cell === "string" ? cell.trim() : typeof cell === "number" || typeof cell === "boolean" ? String(cell) : ""));
  const columnOf = new Map<string, number>();
  header.forEach((key, index) => {
    if (!key) return;
    if (!fieldByKey.has(key)) issues.push({ severity: "warning", message: `Sloupec „${key}“ (sloupec ${index + 1}) list ${sheet} nezná — ignoruje se.` });
    else if (columnOf.has(key)) issues.push({ severity: "error", message: `Sloupec „${key}“ je v záhlaví vícekrát.` });
    else columnOf.set(key, index);
  });
  for (const required of ["display_name", "category"]) {
    if (!columnOf.has(required)) issues.push({ severity: "error", message: `Chybí povinný sloupec „${required}“ (řádek 1).` });
  }
  if (!columnOf.has("generator_code") && !columnOf.has("abf_code") && !columnOf.has("id")) issues.push({ severity: "error", message: "Chybí sloupec identity (id, generator_code nebo abf_code)." });
  if (issues.some((issue) => issue.severity === "error")) return { rows: [], issues };

  const rows: ParsedSheetRow[] = [];
  for (let index = 2; index < grid.length; index += 1) {
    const raw = grid[index] ?? [];
    if (isBlankRow(raw)) continue;
    const cells: Record<string, ParsedCell> = {};
    const rowIssues: ImportIssue[] = [];
    for (const field of spec.fields) {
      const column = columnOf.get(field.key);
      const parsed = column === undefined ? { cell: { state: "empty" } as ParsedCell } : parseCell(field, raw[column], cellContext);
      cells[field.key] = parsed.cell;
      if (parsed.issue) rowIssues.push(parsed.issue);
    }
    rows.push({ sheet, rowNumber: index + 1, cells, issues: [...rowIssues, ...centimetreIssues(cells)] });
  }
  return { rows, issues };
}

/** Sluzby only (first callers and tests). */
export function parseServiceSheet(grid: SheetGrid, categories: readonly CatalogCategoryDef[]): ParsedSheet {
  return parseCatalogSheet("Sluzby", grid, { categories });
}

/**
 * Dimensions are millimetres and are never converted. A documented unit contradiction — the row's
 * own name states the size in cm ("50X50X110 cm") and the cell holds the cm figure instead of its
 * ×10 — is an error (conflict). A value below 100 mm alone is only a warning: small components can
 * legitimately be that small.
 */
function centimetreIssues(cells: Readonly<Record<string, ParsedCell>>): readonly ImportIssue[] {
  const names = ["official_name", "official_name_en", "display_name"].map((key) => cells[key]).flatMap((cell) => (cell?.state === "value" && typeof cell.value === "string" ? [cell.value] : []));
  const cm = new Set<number>();
  const quoted: string[] = [];
  for (const name of names) {
    for (const match of name.matchAll(/(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)(?:\s*[x×]\s*(\d+(?:[.,]\d+)?))?\s*cm/giu)) {
      quoted.push(match[0]);
      for (const part of match.slice(1)) if (part) cm.add(Number(part.replace(",", ".")));
    }
  }
  const mm = new Set([...cm].map((value) => Math.round(value * 10)));
  const issues: ImportIssue[] = [];
  for (const key of ["width_mm", "depth_mm", "height_mm"]) {
    const cell = cells[key];
    if (cell?.state !== "value" || typeof cell.value !== "number" || cell.value === 0) continue;
    const value = cell.value;
    const byName = cm.has(value) && !mm.has(value);
    if (byName) {
      issues.push({ severity: "error", field: key, message: `${fieldLabel(key)} = ${value} — podle názvu („${quoted[0]}“) jde o centimetry (${value * 10} mm). Rozměry se zadávají v mm; import je nepřepočítává — opravte buňku.` });
    } else if (value < 100) {
      issues.push({ severity: "warning", field: key, message: `${fieldLabel(key)} = ${value} mm — méně než 100 mm. U malé komponenty je to v pořádku; jinak zkontrolujte, že nejde o centimetry (import nic nepřepočítává).` });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------------------------
// Current values of a card (the same fields, same representation)
// ---------------------------------------------------------------------------------------------
export function currentCardValues(item: CatalogItemAdmin): Readonly<Record<string, ImportValue>> {
  const document = item.document;
  const publication = documentCatalogPublication(document);
  const attributes = documentAttributes(document);
  const variantOptions = documentVariantOptions(document);
  const unit = item.unitCode ?? (() => { const legacy = normalizeCatalogUnit(item.unit); return legacy.status === "known" ? legacy.code : null; })();
  const dimension = (key: string) => (typeof document[key] === "number" && Number.isFinite(document[key]) ? (document[key] as number) : null);
  return {
    display_name: item.displayName,
    official_name: item.officialName ?? null,
    official_name_en: item.officialNameEn ?? null,
    category: item.category ?? null,
    unit_code: unit,
    width_mm: dimension("widthMm"),
    depth_mm: dimension("depthMm"),
    height_mm: dimension("heightMm"),
    color: attributes.color ?? null,
    material: attributes.material ?? null,
    power_kw: documentServiceTechnical(document)?.powerKw ?? null,
    show_2d: typeof document.showIn2D === "boolean" ? document.showIn2D : null,
    show_3d: typeof document.showIn3D === "boolean" ? document.showIn3D : null,
    variant_set: variantOptions?.variantSetId ?? null,
    variant_scope: variantOptions?.scope ?? null,
    usage_agreement_payer: documentUsageAgreement(document)?.payerLabel ?? null,
    catalog_visible: publication.visible,
    catalog_name: publication.name ?? null,
    catalog_description: publication.shortDescription ?? null,
    catalog_sort: publication.sortOrder ?? null,
    note: documentNote(document) || null,
  };
}
/** @deprecated name kept for the first (Sluzby-only) callers */
export const currentServiceValues = currentCardValues;

/** Exact comparison — text is case-sensitive ("Wifi" ≠ "WIFI"); numbers with a float tolerance. */
const sameValue = (a: ImportValue, b: ImportValue) => (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-9 : a === b);

// ---------------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------------
function readMeta(sheets: readonly WorkbookSheetInput[]): Readonly<{ templateFormat: string | null; environment: string | null }> {
  const meta = sheets.find((sheet) => sheet.name === "_meta");
  const value = (key: string) => {
    const row = meta?.grid.find((cells) => typeof cells[0] === "string" && cells[0].trim() === key);
    const cell = row?.[1];
    return typeof cell === "string" || typeof cell === "number" ? String(cell).trim() || null : null;
  };
  return { templateFormat: value("template_format"), environment: value("environment") };
}

const upper = (value: string | null | undefined) => value?.trim().toLocaleUpperCase("cs") || undefined;
const valueOf = (cell: ParsedCell | undefined) => (cell?.state === "value" ? cell.value : undefined);
const rowRef = (row: Readonly<{ sheet: string; rowNumber: number }>) => `${row.sheet} ř. ${row.rowNumber}`;
const countsOf = (rows: readonly CatalogRowPlan[]): PlanCounts => ({
  create: rows.filter((row) => row.action === "create").length,
  update: rows.filter((row) => row.action === "update").length,
  unchanged: rows.filter((row) => row.action === "unchanged").length,
  conflict: rows.filter((row) => row.action === "conflict").length,
});

export function planCatalogWorkbookImport(sheets: readonly WorkbookSheetInput[], context: CatalogImportContext): CatalogImportPlan {
  const issues: ImportIssue[] = [];
  const meta = readMeta(sheets);
  if (!meta.templateFormat) issues.push({ severity: "warning", message: "Sešit nemá list _meta s verzí šablony — předpokládá se catalog-template/1." });
  else if (meta.templateFormat !== CATALOG_TEMPLATE_FORMAT) {
    issues.push({ severity: "error", message: `Nepodporovaná verze šablony „${meta.templateFormat}“ (očekává se ${CATALOG_TEMPLATE_FORMAT}).` });
  }
  if (meta.environment && context.targetEnvironment && meta.environment.toUpperCase() !== context.targetEnvironment.toUpperCase()) {
    issues.push({ severity: "warning", message: `Šablona byla připravena pro prostředí ${meta.environment}, import míří do ${context.targetEnvironment}.` });
  }

  const reports: SheetReport[] = [];
  const parsedRows: ParsedSheetRow[] = [];
  const importedSheets: CatalogImportSheet[] = [];
  for (const sheet of sheets) {
    const dataRows = sheet.grid.slice(2).filter((row) => !isBlankRow(row)).length;
    if ((CATALOG_HELPER_SHEETS as readonly string[]).includes(sheet.name)) { reports.push({ name: sheet.name, status: "helper", dataRows }); continue; }
    if ((CATALOG_SUPPORTED_SHEETS as readonly string[]).includes(sheet.name)) {
      const name = sheet.name as CatalogImportSheet;
      if (dataRows === 0) { reports.push({ name: sheet.name, status: "empty", dataRows }); continue; }
      const parsed = parseCatalogSheet(name, sheet.grid, context);
      issues.push(...parsed.issues.map((issue) => ({ ...issue, message: `List ${name}: ${issue.message}` })));
      parsedRows.push(...parsed.rows);
      importedSheets.push(name);
      reports.push({ name: sheet.name, status: "imported", dataRows });
      continue;
    }
    if (dataRows === 0) { reports.push({ name: sheet.name, status: "empty", dataRows }); continue; }
    const known = (CATALOG_DATA_SHEETS as readonly string[]).includes(sheet.name);
    reports.push({ name: sheet.name, status: known ? "unsupported_with_data" : "unknown_with_data", dataRows });
    issues.push({ severity: "error", message: known ? `List ${sheet.name} obsahuje ${dataRows} řádků dat, ale import ho zatím nepodporuje — nic z něj se nenačte.` : `Neznámý list „${sheet.name}“ obsahuje ${dataRows} řádků dat — nic z něj se nenačte.` });
  }

  const rows = planRows(parsedRows, context);
  const bySheet = Object.fromEntries(importedSheets.map((sheet) => [sheet, countsOf(rows.filter((row) => row.sheet === sheet))]));
  const summary = {
    ...countsOf(rows),
    warnings: rows.reduce((sum, row) => sum + row.issues.filter((issue) => issue.severity === "warning").length, 0) + issues.filter((issue) => issue.severity === "warning").length,
  };
  return { templateFormat: meta.templateFormat, environment: meta.environment, sheets: reports, issues, rows, summary, bySheet };
}

function planRows(rows: readonly ParsedSheetRow[], context: CatalogImportContext): readonly CatalogRowPlan[] {
  // Keys used by more than one row of the file (both sheets) — every such row is a conflict. A new
  // card without a generator code takes its ABF code as generator code, so that is its key too.
  const keyRows = new Map<string, ParsedSheetRow[]>();
  const add = (key: string, row: ParsedSheetRow) => keyRows.set(key, [...(keyRows.get(key) ?? []).filter((entry) => entry !== row), row]);
  const generatorOf = (row: ParsedSheetRow) => (valueOf(row.cells.generator_code) ?? (valueOf(row.cells.id) ? undefined : valueOf(row.cells.abf_code))) as string | undefined;
  for (const row of rows) {
    const id = valueOf(row.cells.id);
    const generator = generatorOf(row);
    const abf = valueOf(row.cells.abf_code);
    if (typeof id === "string") add(`ID ${id}`, row);
    if (typeof generator === "string") add(`Generátorový kód ${generator.toLocaleUpperCase("cs")}`, row);
    if (typeof abf === "string") add(`ABF kód ${abf.toLocaleUpperCase("cs")}`, row);
  }
  // A generator code of one row equal to the ABF code of ANOTHER row — the cross-code rule inside the file.
  const crossOf = (row: ParsedSheetRow): string[] => {
    const generator = generatorOf(row)?.toLocaleUpperCase("cs");
    const abf = (valueOf(row.cells.abf_code) as string | undefined)?.toLocaleUpperCase("cs");
    return rows.filter((other) => other !== row).flatMap((other) => {
      const otherGenerator = generatorOf(other)?.toLocaleUpperCase("cs");
      const otherAbf = (valueOf(other.cells.abf_code) as string | undefined)?.toLocaleUpperCase("cs");
      if (generator && otherAbf === generator && otherGenerator !== generator) return [`Generátorový kód ${generator} je v souboru ABF kódem jiného řádku (${rowRef(other)}).`];
      if (abf && otherGenerator === abf && generator !== abf) return [`ABF kód ${abf} je v souboru generátorovým kódem jiného řádku (${rowRef(other)}).`];
      return [];
    });
  };
  const duplicateOf = (row: ParsedSheetRow) => [
    ...[...keyRows].filter(([, entries]) => entries.length > 1 && entries.includes(row)).map(([key, entries]) => `${key} je v souboru na řádcích ${entries.map(rowRef).join(", ")}`),
    ...crossOf(row),
  ];

  const planned = rows.map((row) => planRow(row, duplicateOf(row), context));
  // Two rows resolving to the same existing card (through different keys) — both are conflicts.
  const byItem = new Map<string, CatalogRowPlan[]>();
  for (const plan of planned) if (plan.itemId && plan.action !== "conflict") byItem.set(plan.itemId, [...(byItem.get(plan.itemId) ?? []), plan]);
  return planned.map((plan) => {
    const shared = plan.itemId ? byItem.get(plan.itemId) : undefined;
    if (!shared || shared.length < 2) return plan;
    return conflict(plan, [`Řádky ${shared.map(rowRef).join(", ")} míří na stejnou kartu — žádné automatické sloučení.`], plan.issues, plan.itemId);
  });
}

type RowHead = Readonly<{ sheet: CatalogImportSheet; rowNumber: number; label: string }>;

function conflict(head: RowHead, reasons: readonly string[], issues: readonly ImportIssue[] = [], itemId?: string): CatalogRowPlan {
  return { sheet: head.sheet, rowNumber: head.rowNumber, label: head.label, action: "conflict", ...(itemId ? { itemId } : {}), changes: [], issues: [...issues, ...reasons.map((message) => ({ severity: "error" as const, message }))] };
}

function planRow(row: ParsedSheetRow, duplicates: readonly string[], context: CatalogImportContext): CatalogRowPlan {
  const spec = SHEET_SPECS[row.sheet];
  const id = valueOf(row.cells.id) as string | undefined;
  const generatorCode = valueOf(row.cells.generator_code) as string | undefined;
  const abfCode = valueOf(row.cells.abf_code) as string | undefined;
  const head: RowHead = { sheet: row.sheet, rowNumber: row.rowNumber, label: generatorCode ?? abfCode ?? id ?? `řádek ${row.rowNumber}` };
  const issues: ImportIssue[] = [...row.issues];
  if (issues.some((issue) => issue.severity === "error")) return conflict(head, [], issues);
  if (duplicates.length) return conflict(head, duplicates, issues);

  // ---- identity: id → generator code → ABF code ----
  const items = context.items;
  const byGenerator = generatorCode ? items.filter((item) => upper(item.internalCode) === upper(generatorCode)) : [];
  const byAbf = abfCode ? items.filter((item) => upper(item.abfCode) === upper(abfCode)) : [];
  if (byGenerator.length > 1) return conflict(head, [`Generátorový kód ${generatorCode} má v katalogu ${byGenerator.length} karet.`], issues);
  if (byAbf.length > 1) return conflict(head, [`ABF kód ${abfCode} má v katalogu ${byAbf.length} karet.`], issues);
  let target: CatalogItemAdmin | undefined;
  if (id) {
    target = items.find((item) => item.id === id);
    if (!target) return conflict(head, [`ID ${id} v katalogu neexistuje.`], issues);
  }
  for (const candidate of [byGenerator[0], byAbf[0]]) {
    if (!candidate) continue;
    if (target && candidate.id !== target.id) return conflict(head, [`Rozporná identita: ${id ? `ID ukazuje na „${target.displayName}“` : `generátorový kód ${generatorCode} ukazuje na „${target.displayName}“`}, ${candidate === byAbf[0] ? `ABF kód ${abfCode}` : `generátorový kód ${generatorCode}`} na „${candidate.displayName}“.`], issues, target.id);
    target = candidate;
  }

  const values = Object.fromEntries(contentFields(spec).map((field) => [field.key, row.cells[field.key] ?? { state: "empty" }])) as Record<string, ParsedCell>;
  const lifecycle = valueOf(row.cells.lifecycle_status);
  if (!target) return planCreate(head, spec, { generatorCode, abfCode }, values, issues, lifecycle, context);
  return planUpdate(head, spec, target, { generatorCode, abfCode }, values, issues, lifecycle, context);
}

function categoryProblem(spec: SheetSpec, categoryId: string, kind: CatalogItemKind | undefined, context: CatalogImportContext, mustBeActive: boolean): Readonly<{ problem?: string; kind?: CatalogItemKind }> {
  const category = context.categories.find((candidate) => candidate.id === categoryId);
  if (!category) return { problem: `Kategorie „${categoryId}“ není v registru.` };
  if (!spec.groups.includes(category.group)) return { problem: `Kategorie „${category.name}“ nepatří na list ${spec.name} (patří k jinému druhu komponenty).` };
  const target = classificationTarget(category, kind ?? category.kinds[0]!);
  const issue = classificationIssue(context.categories, { itemType: target.itemType, kind: target.kind, category: category.id }, { requireActive: mustBeActive });
  return issue ? { problem: issue } : { kind: target.kind };
}

/** Rozsah barev belongs to a swatch book: required with one, meaningless without one. */
function variantProblem(values: Record<string, ParsedCell>, current: Readonly<Record<string, ImportValue>> | undefined): string | undefined {
  const set = values.variant_set;
  const scope = values.variant_scope;
  const resultingSet = set?.state === "value" ? set.value : set?.state === "delete" ? null : current?.variant_set ?? null;
  const resultingScope = scope?.state === "value" ? scope.value : current?.variant_scope ?? null;
  if (set?.state === "delete" && scope?.state === "value") return "Rozsah barev bez vzorníku — vzorník se maže, rozsah nechte prázdný.";
  if (resultingSet && !resultingScope) return "Rozsah barev je povinný, je-li vyplněn vzorník.";
  if (!resultingSet && scope?.state === "value") return "Rozsah barev bez vzorníku — vyplňte i Vzorník barev.";
  return undefined;
}

function planCreate(head: RowHead, spec: SheetSpec, codes: Readonly<{ generatorCode?: string; abfCode?: string }>, values: Record<string, ParsedCell>, issues: ImportIssue[], lifecycle: ImportValue | undefined, context: CatalogImportContext): CatalogRowPlan {
  const reasons: string[] = [];
  const displayName = valueOf(values.display_name) as string | undefined;
  const categoryId = valueOf(values.category) as string | undefined;
  if (!displayName) reasons.push("Nová karta potřebuje Interní název HomeworkStudio.");
  if (!categoryId) reasons.push("Nová karta potřebuje kategorii.");
  if (!codes.generatorCode && !codes.abfCode) reasons.push("Nová karta potřebuje generátorový nebo ABF kód (stabilní identita pro opakovaný import).");
  let kind: CatalogItemKind | undefined;
  if (categoryId) {
    const checked = categoryProblem(spec, categoryId, undefined, context, true);
    if (checked.problem) reasons.push(checked.problem);
    kind = checked.kind;
  }
  // Generator code: the ABF code by the existing default when the cell is empty — only without a collision.
  const internalCode = codes.generatorCode ?? codes.abfCode;
  try {
    assertNoCrossCodeCollision(context.items.map((item) => ({ id: item.id, internalCode: item.internalCode, abfCode: item.abfCode ?? null, displayName: item.displayName })), { internalCode: internalCode ?? null, abfCode: codes.abfCode ?? null });
  } catch (error) {
    reasons.push(error instanceof Error ? error.message : String(error));
  }
  const variant = variantProblem(Object.fromEntries(Object.entries(values).map(([key, cell]) => [key, cell.state === "delete" ? { state: "empty" } : cell])) as Record<string, ParsedCell>, undefined);
  if (variant) reasons.push(variant);
  if (reasons.length) return conflict(head, reasons, issues);
  for (const [key, cell] of Object.entries(values)) if (cell.state === "delete") issues.push({ severity: "warning", field: key, message: `${fieldLabel(key)}: nová karta nemá co mazat — značka ${EXCEL_DELETE_MARKER} se ignoruje.` });
  if (typeof lifecycle === "string" && plain(lifecycle) && !["k doplneni", "needs_review"].includes(plain(lifecycle))) issues.push({ severity: "warning", field: "lifecycle_status", message: "Stav se importem nemění — nová karta vzniká jako „K doplnění“." });

  const after = (key: string) => valueOf(values[key]);
  const text = (key: string) => (typeof after(key) === "string" ? (after(key) as string) : undefined);
  const number = (key: string) => (typeof after(key) === "number" ? (after(key) as number) : undefined);
  const bool = (key: string) => (typeof after(key) === "boolean" ? (after(key) as boolean) : undefined);
  const changes: FieldChange[] = [
    ...(internalCode ? [{ field: "generator_code", labelCs: fieldLabel("generator_code"), before: null, after: internalCode }] : []),
    ...(codes.abfCode ? [{ field: "abf_code", labelCs: fieldLabel("abf_code"), before: null, after: codes.abfCode }] : []),
    ...contentFields(spec).flatMap((field) => { const value = after(field.key); return value === undefined ? [] : [{ field: field.key, labelCs: field.labelCs, before: null, after: value }]; }),
  ];
  const publication = newPublication(values);
  const unitCode = text("unit_code");
  const color = text("color");
  const material = text("material");
  const variantSetId = text("variant_set");
  const payer = text("usage_agreement_payer");
  const createInput: CatalogItemAdminCreateInput = {
    itemType: spec.itemType,
    kind: kind!,
    displayName: displayName!,
    category: categoryId!,
    ...(internalCode ? { internalCode } : {}),
    ...(codes.abfCode ? { abfCode: codes.abfCode } : {}),
    ...(unitCode ? { unitCode, unit: catalogUnitByCode(unitCode)?.symbol ?? unitCode } : {}),
    ...(text("official_name") ? { officialName: text("official_name") } : {}),
    ...(text("official_name_en") ? { officialNameEn: text("official_name_en") } : {}),
    ...(text("note") ? { note: text("note") } : {}),
    ...(number("width_mm") !== undefined ? { widthMm: number("width_mm") } : {}),
    ...(number("depth_mm") !== undefined ? { depthMm: number("depth_mm") } : {}),
    ...(number("height_mm") !== undefined ? { heightMm: number("height_mm") } : {}),
    ...(color || material ? { attributes: { ...(color ? { color } : {}), ...(material ? { material } : {}) } } : {}),
    ...(bool("show_2d") !== undefined ? { showIn2D: bool("show_2d") } : {}),
    // 3D = ANO without a GLB is stored as the requirement; the card stays "K doplnění" until a model is uploaded.
    ...(bool("show_3d") !== undefined ? { showIn3D: bool("show_3d") } : {}),
    ...(number("power_kw") !== undefined ? { powerKw: number("power_kw") } : {}),
    // Only an explicitly filled swatch book — an empty cell never assigns one (no carpet default).
    ...(variantSetId ? { variantOptions: { variantSetId, scope: after("variant_scope") as CardVariantScope } } : {}),
    ...(payer ? { usageAgreement: { payerLabel: payer } } : {}),
    ...(publication ? { catalogPublication: publication } : {}),
  };
  return { sheet: head.sheet, rowNumber: head.rowNumber, label: head.label, action: "create", changes, issues, createInput };
}

/** The publication section of a new card: absent visibility = not published. */
function newPublication(values: Record<string, ParsedCell>): CatalogItemAdminCreateInput["catalogPublication"] {
  const value = (key: string) => valueOf(values[key]);
  const visible = value("catalog_visible");
  const name = value("catalog_name");
  const shortDescription = value("catalog_description");
  const sortOrder = value("catalog_sort");
  if (visible === undefined && name === undefined && shortDescription === undefined && sortOrder === undefined) return undefined;
  return {
    visible: visible === true,
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof shortDescription === "string" ? { shortDescription } : {}),
    ...(typeof sortOrder === "number" ? { sortOrder } : {}),
  };
}

/** catalogPublication merge patch from the sheet: omitted = unchanged, #SMAZAT = null. */
function publicationPatch(values: Record<string, ParsedCell>, current: Readonly<Record<string, ImportValue>>): CatalogItemAdminEdit["catalogPublication"] | undefined {
  const patch: Record<string, unknown> = {};
  const map = [["catalog_visible", "visible"], ["catalog_name", "name"], ["catalog_description", "shortDescription"], ["catalog_sort", "sortOrder"]] as const;
  for (const [key, target] of map) {
    const cell = values[key];
    if (!cell || cell.state === "empty") continue;
    const next = cell.state === "delete" ? null : cell.value;
    if (sameValue(current[key] ?? null, next)) continue;
    patch[target] = next;
  }
  return Object.keys(patch).length ? (patch as CatalogItemAdminEdit["catalogPublication"]) : undefined;
}

function planUpdate(head: RowHead, spec: SheetSpec, target: CatalogItemAdmin, codes: Readonly<{ generatorCode?: string; abfCode?: string }>, values: Record<string, ParsedCell>, issues: ImportIssue[], lifecycle: ImportValue | undefined, context: CatalogImportContext): CatalogRowPlan {
  const reasons: string[] = [];
  if (itemTypeOf(target) !== spec.itemType) reasons.push(`Karta „${target.displayName}“ je typu ${itemTypeOf(target)} — na list ${spec.name} nepatří.`);
  const edit: { -readonly [K in keyof CatalogItemAdminEdit]?: CatalogItemAdminEdit[K] } = {};
  const changes: FieldChange[] = [];
  // Codes: an existing code is never changed by the import (that is an explicit admin action with
  // a project-usage check); a missing one may be filled.
  if (codes.generatorCode && upper(target.internalCode) !== upper(codes.generatorCode)) {
    if (target.internalCode) reasons.push(`Karta má generátorový kód ${target.internalCode}, soubor uvádí ${codes.generatorCode} — změnu kódu import neprovádí (Administrace → karta).`);
    else { edit.fillInternalCode = codes.generatorCode; changes.push({ field: "generator_code", labelCs: fieldLabel("generator_code"), before: null, after: codes.generatorCode }); }
  }
  if (codes.abfCode && upper(target.abfCode) !== upper(codes.abfCode)) {
    if (target.abfCode) reasons.push(`Karta má ABF kód ${target.abfCode}, soubor uvádí ${codes.abfCode} — změnu ABF kódu import neprovádí.`);
    else if (context.items.some((item) => item.id !== target.id && upper(item.abfCode) === upper(codes.abfCode))) reasons.push(`ABF kód ${codes.abfCode} už má jiná karta.`);
    else { edit.abfCode = codes.abfCode; changes.push({ field: "abf_code", labelCs: fieldLabel("abf_code"), before: null, after: codes.abfCode }); }
  }
  if (edit.fillInternalCode || edit.abfCode) {
    try {
      assertNoCrossCodeCollision(context.items.map((item) => ({ id: item.id, internalCode: item.internalCode, abfCode: item.abfCode ?? null, displayName: item.displayName })), { internalCode: edit.fillInternalCode ?? null, abfCode: edit.abfCode ?? null }, target.id);
    } catch (error) {
      reasons.push(error instanceof Error ? error.message : String(error));
    }
  }

  const current = currentCardValues(target);
  const variant = variantProblem(values, current);
  if (variant) reasons.push(variant);
  const alreadyEmpty: string[] = [];
  for (const field of contentFields(spec)) {
    const cell = values[field.key]!;
    if (cell.state === "empty") continue;
    const before = current[field.key] ?? null;
    const after = cell.state === "delete" ? null : cell.value;
    if (cell.state === "delete" && before === null) { alreadyEmpty.push(field.labelCs); continue; }
    if (sameValue(before, after)) continue;
    changes.push({ field: field.key, labelCs: field.labelCs, before, after });
  }
  if (alreadyEmpty.length) issues.push({ severity: "warning", message: `${alreadyEmpty.join(", ")}: hodnota už je prázdná — ${EXCEL_DELETE_MARKER} nic nemění.` });

  const changed = new Map(changes.map((change) => [change.field, change.after]));
  if (changed.has("category")) {
    const checked = categoryProblem(spec, changed.get("category") as string, target.kind, context, true);
    if (checked.problem) reasons.push(checked.problem);
    else if (checked.kind !== target.kind) { if (target.lifecycleStatus === "active") reasons.push(`Změna kategorie by změnila druh aktivní karty (${target.kind} → ${checked.kind}) — nejdřív ji převeďte do stavu K doplnění.`); else edit.kind = checked.kind; }
    edit.category = changed.get("category") as string;
  }
  if (reasons.length) return conflict(head, reasons, issues, target.id);
  if (typeof lifecycle === "string" && plain(lifecycle) && plain(lifecycle) !== plain(target.lifecycleStatus) && plain(lifecycle) !== plain(lifecycleLabel(target.lifecycleStatus))) issues.push({ severity: "warning", field: "lifecycle_status", message: `Stav se importem nemění (zůstává ${lifecycleLabel(target.lifecycleStatus)}).` });

  // Every field from its own cell only — e.g. Interní název and Název v katalogu are never synchronized.
  if (changed.has("display_name")) edit.displayName = changed.get("display_name") as string;
  if (changed.has("official_name")) edit.officialName = changed.get("official_name") as string | null;
  if (changed.has("official_name_en")) edit.officialNameEn = changed.get("official_name_en") as string | null;
  if (changed.has("unit_code")) edit.unitCode = changed.get("unit_code") as string | null;
  if (changed.has("width_mm")) edit.widthMm = changed.get("width_mm") as number;
  if (changed.has("depth_mm")) edit.depthMm = changed.get("depth_mm") as number;
  if (changed.has("height_mm")) edit.heightMm = changed.get("height_mm") as number;
  if (changed.has("color") || changed.has("material")) {
    // attributes are replaced whole: keep the further parameters (extra) and the untouched one of colour/material.
    const { color: _color, material: _material, ...rest } = documentAttributes(target.document);
    const color = changed.has("color") ? changed.get("color") : current.color;
    const material = changed.has("material") ? changed.get("material") : current.material;
    const next = { ...rest, ...(typeof color === "string" ? { color } : {}), ...(typeof material === "string" ? { material } : {}) };
    edit.attributes = Object.keys(next).length ? next : null;
  }
  if (changed.has("show_2d")) edit.showIn2D = changed.get("show_2d") as boolean;
  if (changed.has("show_3d")) edit.showIn3D = changed.get("show_3d") as boolean;
  if (changed.has("note")) edit.note = (changed.get("note") as string | null) ?? "";
  if (changed.has("power_kw")) {
    const technical = documentServiceTechnical(target.document) ?? {};
    const { powerKw: _previous, ...rest } = technical;
    const powerKw = changed.get("power_kw");
    edit.serviceTechnical = { ...rest, ...(typeof powerKw === "number" ? { powerKw } : {}) };
  }
  if (changed.has("variant_set") || changed.has("variant_scope")) {
    const variantSetId = changed.has("variant_set") ? changed.get("variant_set") : current.variant_set;
    const scope = changed.has("variant_scope") ? changed.get("variant_scope") : current.variant_scope;
    edit.variantOptions = typeof variantSetId === "string" ? { variantSetId, scope: scope as CardVariantScope } : null;
  }
  if (changed.has("usage_agreement_payer")) {
    const payerLabel = changed.get("usage_agreement_payer");
    const note = documentUsageAgreement(target.document)?.note;
    edit.usageAgreement = typeof payerLabel === "string" ? { payerLabel, ...(note ? { note } : {}) } : null;
  }
  const publication = publicationPatch(values, current);
  if (publication) edit.catalogPublication = publication;

  if (changes.length === 0) return { sheet: head.sheet, rowNumber: head.rowNumber, label: head.label, action: "unchanged", itemId: target.id, changes, issues };
  // Lifecycle of existing cards is kept. The save downgrades an active card whose 2D/3D change
  // breaks readiness, and no change may leave an active card un-ready — either is a conflict here,
  // never a silent status change (an already-imperfect active card may still get other fields).
  if (target.lifecycleStatus === "active") {
    const readinessOf = (document: CatalogItemAdmin["document"]) => evaluateCatalogReadiness({ ...withColumnInternalCode(document as Partial<ComponentDefinition>, target.internalCode), lifecycleStatus: "active" } as ComponentDefinition, edit.kind ?? target.kind, { itemType: itemTypeOf(target) });
    const before = readinessOf(target.document);
    const after = readinessOf(applyCatalogItemEdit(target.document, edit));
    const touchesScene = edit.showIn2D !== undefined || edit.showIn3D !== undefined;
    if (!after.ready && (touchesScene || before.ready)) return conflict(head, [`Změna by aktivní kartu vrátila do stavu K doplnění (${after.issues.join(", ")}) — import stav existujících karet nemění.`], issues, target.id);
  }
  return { sheet: head.sheet, rowNumber: head.rowNumber, label: head.label, action: "update", itemId: target.id, changes, issues, edit, expectedUpdatedAt: target.updatedAt };
}

const LIFECYCLE_LABELS: Readonly<Record<string, string>> = { draft: "Koncept", needs_review: "K doplnění", active: "Aktivní", inactive: "Neaktivní", archived: "Archivováno" };
const lifecycleLabel = (status: string) => LIFECYCLE_LABELS[status] ?? status;
