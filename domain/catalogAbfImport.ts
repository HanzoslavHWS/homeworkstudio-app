/**
 * ABF catalog import from _IMPORT/KODY.xlsm (sheet PRICELIST) — pure planning, no I/O.
 *
 * FIXED RULE: only rows with an ABF code in column A are imported. A row without one is never
 * created, never drafted — it is only counted as "skipped" in the preview.
 *
 * Identity is the ABF code (catalog_items.abf_code), never the name:
 *   1. an existing card with the same abf_code            -> update (import-managed fields only)
 *   2. else an existing card whose internal_code equals the code and has no abf_code yet
 *      (every pre-2026-10 internal code was an ABF code) -> update + set abf_code
 *   3. else an existing card WITHOUT abf_code whose name is identical -> CONFLICT: never
 *      auto-linked, never duplicated; the admin confirms the link explicitly (linkConfirmations)
 *   4. else                                              -> create (internal_code = abf_code)
 *
 * An update only ever touches what the import manages: official_name (the ABF name),
 * document.abfImport (provenance + EN name), abf_code when linking, internal_code / unit only
 * when still empty. display_name, category, kind, item_type, lifecycle, assets, technical and
 * pricing data are never touched. The import never archives anything either — cards missing
 * from the file are only listed for information (see notInFile).
 *
 * Prices in the workbook are deliberately NOT imported here: pricing stays on the existing
 * Event → PriceList → PricingEntry path.
 */
import type { CatalogItemKind, CatalogItemStatus, CatalogItemType } from "./models.ts";
import { detectUnitFromName, type RawSheetRow } from "./priceImport.ts";
import { normalizeAbfCode } from "./catalogItemTypes.ts";
import { normalizeCatalogName } from "./catalog.ts";
import type { AbfImportProvenance, CatalogItemAdminDocument } from "./catalogItemsAdmin.ts";

export const KODY_SOURCE_SHEET = "PRICELIST";
/** The standard ABF code shape (T04, P86, M8A, L02, ...). Other shapes still import, with a warning. */
const STANDARD_ABF_CODE = /^[A-Z][0-9A-Z]{2}$/u;

export type KodyRow = Readonly<{
  sourceRow: number;
  /** Normalized ABF code, or null when column A is empty. */
  abfCode: string | null;
  /** Raw column-A text when it was present but unusable as a code (whitespace etc.). */
  invalidCodeText: string | null;
  nameCz: string;
  nameEn: string | null;
  unit: string | null;
}>;

export class KodyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KodyFormatError";
  }
}

function cellText(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

/**
 * PRICELIST layout: row 1 is a header (A is labelled "kategorie" but actually holds the ABF
 * code), B = Czech name, E = English name. Fully blank rows are spacers (category pictures
 * live in drawings, not cells) and are ignored entirely — they are not "rows without a code".
 */
export function parseKodyPricelist(grid: readonly RawSheetRow[]): readonly KodyRow[] {
  if (grid.length === 0) throw new KodyFormatError(`List ${KODY_SOURCE_SHEET} je prázdný nebo chybí.`);
  const header = grid[0]!;
  if (!/polo[žz]ka/iu.test(cellText(header[1]))) {
    throw new KodyFormatError(`List ${KODY_SOURCE_SHEET} nemá očekávanou hlavičku (sloupec B „položka“).`);
  }
  const rows: KodyRow[] = [];
  for (let index = 1; index < grid.length; index++) {
    const row = grid[index]!;
    const codeText = cellText(row[0]);
    const nameCz = cellText(row[1]);
    if (!codeText && !nameCz) continue;
    const normalized = normalizeAbfCode(codeText);
    rows.push({
      sourceRow: index + 1,
      abfCode: typeof normalized === "string" ? normalized : null,
      invalidCodeText: codeText && typeof normalized !== "string" ? codeText : null,
      nameCz,
      nameEn: cellText(row[4]) || null,
      unit: nameCz ? detectUnitFromName(nameCz).unit : null,
    });
  }
  return rows;
}

// ============================================================================
// TYPE CLASSIFICATION — from the ABF code family only, and only where the family is unambiguous
// in the real data (T = typové stánky, P = kóje, L/I/W/U = technické služby elektro/internet/
// voda/úklid — the exact families of the existing "Typovky"/"Canonical"/"T. služby" cards).
// Everything else (M = mixed furniture/construction/graphics, S = stavba, ...) is kept as a
// PRODUCT with kind "other" and flagged for manual classification ("K zařazení").
// ============================================================================

export type AbfTypeClassification = Readonly<{
  itemType: CatalogItemType;
  kind: CatalogItemKind;
  confident: boolean;
  reason: string;
}>;

export function classifyAbfCodeItemType(abfCode: string): AbfTypeClassification {
  const family = abfCode.charAt(0);
  if (family === "T" || family === "P") {
    return { itemType: "BOOTH", kind: "booth", confident: true, reason: `ABF řada ${family} = typové stánky / kóje` };
  }
  if (family === "L" || family === "I" || family === "W" || family === "U") {
    return { itemType: "SERVICE", kind: "service", confident: true, reason: `ABF řada ${family} = technická služba (elektro/internet/voda/úklid)` };
  }
  return {
    itemType: "PRODUCT",
    kind: "other",
    confident: false,
    reason: `ABF řada ${family} neurčuje typ jednoznačně — položka je založena jako Produkt a označena k ručnímu zařazení`,
  };
}

// ============================================================================
// PLAN
// ============================================================================

export type AbfImportExistingItem = Readonly<{
  id: string;
  internalCode: string | null;
  abfCode: string | null;
  displayName: string;
  officialName: string | null;
  unit: string | null;
  kind: CatalogItemKind;
  itemType: CatalogItemType;
  lifecycleStatus: CatalogItemStatus;
  document: CatalogItemAdminDocument;
  updatedAt: string;
}>;

export type AbfImportFieldChange = Readonly<{ field: "official_name" | "abf_code" | "internal_code" | "unit" | "abf_import"; from: string | null; to: string | null }>;

export type AbfImportConflictReason =
  | "duplicate_in_file"
  | "missing_name"
  | "invalid_code"
  | "internal_code_taken"
  | "possible_duplicate_by_name";

export type AbfImportPlanRow = Readonly<
  | { action: "create"; row: KodyRow; abfCode: string; internalCode: string; classification: AbfTypeClassification; warnings: readonly string[] }
  | { action: "update"; row: KodyRow; abfCode: string; itemId: string; itemLabel: string; linkedVia: "abf_code" | "internal_code" | "confirmed_link"; changes: readonly AbfImportFieldChange[]; warnings: readonly string[] }
  | { action: "unchanged"; row: KodyRow; abfCode: string; itemId: string; itemLabel: string }
  | { action: "conflict"; row: KodyRow; abfCode: string | null; reason: AbfImportConflictReason; message: string; candidateItemId?: string; candidateLabel?: string }
>;

export type AbfImportPlan = Readonly<{
  sourceFile: string;
  rows: readonly AbfImportPlanRow[];
  /** Rows with a name but no ABF code in column A — ignored, never imported. */
  skippedWithoutAbfCode: readonly Readonly<{ sourceRow: number; nameCz: string }>[];
  /** ABF codes present more than once in the file (all their rows are conflicts). */
  duplicateCodes: readonly string[];
  /** Existing cards with an ABF code that is NOT in the file — informational only, never archived by the import. */
  notInFile: readonly Readonly<{ itemId: string; abfCode: string; label: string; lifecycleStatus: CatalogItemStatus }>[];
  summary: Readonly<{
    dataRows: number;
    withAbfCode: number;
    skippedWithoutAbfCode: number;
    create: number;
    update: number;
    unchanged: number;
    conflicts: number;
    duplicateCodes: number;
    createdNeedingTypeReview: number;
  }>;
}>;

function itemLabel(item: Pick<AbfImportExistingItem, "internalCode" | "abfCode" | "displayName">): string {
  const code = item.abfCode ?? item.internalCode;
  return code ? `${code} · ${item.displayName}` : item.displayName;
}

function sameCode(a: string | null | undefined, b: string): boolean {
  return Boolean(a) && a!.trim().toLocaleUpperCase("cs") === b;
}

function existingNames(item: AbfImportExistingItem): readonly string[] {
  const documentName = typeof item.document.name === "string" ? item.document.name : undefined;
  return [item.displayName, item.officialName ?? undefined, documentName].filter((value): value is string => Boolean(value)).map(normalizeCatalogName);
}

export function buildAbfImportProvenance(row: KodyRow, sourceFile: string, importedAt: string): AbfImportProvenance {
  return { sourceFile, sourceSheet: KODY_SOURCE_SHEET, sourceRow: row.sourceRow, abfName: row.nameCz, abfNameEn: row.nameEn, importedAt };
}

/** Provenance equality ignoring importedAt — a re-import of the same file is "unchanged", not an update. */
function sameProvenance(existing: unknown, next: AbfImportProvenance): boolean {
  if (!existing || typeof existing !== "object") return false;
  const candidate = existing as Record<string, unknown>;
  return candidate.sourceFile === next.sourceFile && candidate.sourceSheet === next.sourceSheet && candidate.sourceRow === next.sourceRow && candidate.abfName === next.abfName && (candidate.abfNameEn ?? null) === next.abfNameEn;
}

function planUpdate(
  row: KodyRow,
  abfCode: string,
  item: AbfImportExistingItem,
  linkedVia: "abf_code" | "internal_code" | "confirmed_link",
  sourceFile: string,
  internalCodeTaken: (code: string, exceptId: string) => boolean,
): AbfImportPlanRow {
  const changes: AbfImportFieldChange[] = [];
  const warnings: string[] = [];
  if (!sameCode(item.abfCode, abfCode)) changes.push({ field: "abf_code", from: item.abfCode, to: abfCode });
  if (!item.internalCode) {
    if (internalCodeTaken(abfCode, item.id)) warnings.push(`Interní kód ${abfCode} už má jiná položka — interní kód zůstane prázdný.`);
    else changes.push({ field: "internal_code", from: null, to: abfCode });
  }
  if ((item.officialName ?? null) !== row.nameCz) changes.push({ field: "official_name", from: item.officialName, to: row.nameCz });
  if (!item.unit && row.unit) changes.push({ field: "unit", from: null, to: row.unit });
  const provenance = buildAbfImportProvenance(row, sourceFile, "");
  if (!sameProvenance(item.document.abfImport, provenance)) changes.push({ field: "abf_import", from: null, to: `${sourceFile} · ř. ${row.sourceRow}` });
  if (item.lifecycleStatus === "archived") warnings.push("Položka je archivovaná — import ji aktualizuje, ale neobnoví.");
  if (changes.length === 0) return { action: "unchanged", row, abfCode, itemId: item.id, itemLabel: itemLabel(item) };
  return { action: "update", row, abfCode, itemId: item.id, itemLabel: itemLabel(item), linkedVia, changes, warnings };
}

/**
 * @param linkConfirmations ABF code -> catalog item id the admin explicitly confirmed for a
 *   "possible_duplicate_by_name" conflict. Only honoured when that exact candidate is still the
 *   conflict's candidate — a stale/forged confirmation never links anything else.
 */
export function planAbfImport(
  rows: readonly KodyRow[],
  existing: readonly AbfImportExistingItem[],
  sourceFile: string,
  linkConfirmations: Readonly<Record<string, string>> = {},
): AbfImportPlan {
  const codeCounts = new Map<string, number>();
  for (const row of rows) if (row.abfCode) codeCounts.set(row.abfCode, (codeCounts.get(row.abfCode) ?? 0) + 1);
  const duplicateCodes = [...codeCounts.entries()].filter(([, count]) => count > 1).map(([code]) => code).sort();

  const internalCodeTaken = (code: string, exceptId: string) => existing.some((item) => item.id !== exceptId && sameCode(item.internalCode, code));
  const claimed = new Set<string>();

  const planRows: AbfImportPlanRow[] = [];
  const skippedWithoutAbfCode: { sourceRow: number; nameCz: string }[] = [];

  for (const row of rows) {
    if (row.invalidCodeText) {
      planRows.push({ action: "conflict", row, abfCode: null, reason: "invalid_code", message: `Hodnota „${row.invalidCodeText}“ ve sloupci A není platný ABF kód.` });
      continue;
    }
    if (!row.abfCode) {
      skippedWithoutAbfCode.push({ sourceRow: row.sourceRow, nameCz: row.nameCz });
      continue;
    }
    const abfCode = row.abfCode;
    if ((codeCounts.get(abfCode) ?? 0) > 1) {
      planRows.push({ action: "conflict", row, abfCode, reason: "duplicate_in_file", message: `ABF kód ${abfCode} je v souboru vícekrát — žádný z těchto řádků se neimportuje.` });
      continue;
    }
    if (!row.nameCz) {
      planRows.push({ action: "conflict", row, abfCode, reason: "missing_name", message: `Řádek s ABF kódem ${abfCode} nemá název položky.` });
      continue;
    }

    const byAbf = existing.find((item) => sameCode(item.abfCode, abfCode));
    if (byAbf) {
      claimed.add(byAbf.id);
      planRows.push(planUpdate(row, abfCode, byAbf, "abf_code", sourceFile, internalCodeTaken));
      continue;
    }
    const byInternal = existing.find((item) => sameCode(item.internalCode, abfCode));
    if (byInternal) {
      if (byInternal.abfCode) {
        planRows.push({
          action: "conflict",
          row,
          abfCode,
          reason: "internal_code_taken",
          message: `Interní kód ${abfCode} má položka „${byInternal.displayName}“, která už má jiný ABF kód (${byInternal.abfCode}).`,
          candidateItemId: byInternal.id,
          candidateLabel: itemLabel(byInternal),
        });
        continue;
      }
      claimed.add(byInternal.id);
      planRows.push(planUpdate(row, abfCode, byInternal, "internal_code", sourceFile, internalCodeTaken));
      continue;
    }
    const normalizedName = normalizeCatalogName(row.nameCz);
    const byName = existing.find((item) => !item.abfCode && !claimed.has(item.id) && existingNames(item).includes(normalizedName));
    if (byName) {
      if (linkConfirmations[abfCode] === byName.id) {
        claimed.add(byName.id);
        planRows.push(planUpdate(row, abfCode, byName, "confirmed_link", sourceFile, internalCodeTaken));
      } else {
        planRows.push({
          action: "conflict",
          row,
          abfCode,
          reason: "possible_duplicate_by_name",
          message: `V katalogu už je položka se stejným názvem bez ABF kódu. Potvrďte propojení, jinak se řádek přeskočí (nevznikne duplicita).`,
          candidateItemId: byName.id,
          candidateLabel: itemLabel(byName),
        });
      }
      continue;
    }

    const classification = classifyAbfCodeItemType(abfCode);
    const warnings: string[] = [];
    if (!STANDARD_ABF_CODE.test(abfCode)) warnings.push(`ABF kód ${abfCode} nemá standardní tvar (písmeno + 2 znaky).`);
    if (!classification.confident) warnings.push("Typ karty nelze z dat bezpečně určit — označeno k zařazení.");
    planRows.push({ action: "create", row, abfCode, internalCode: abfCode, classification, warnings });
  }

  const fileCodes = new Set(rows.map((row) => row.abfCode).filter((code): code is string => Boolean(code)));
  const notInFile = existing
    .filter((item) => item.abfCode && !fileCodes.has(item.abfCode.trim().toLocaleUpperCase("cs")) && !claimed.has(item.id))
    .map((item) => ({ itemId: item.id, abfCode: item.abfCode!, label: item.displayName, lifecycleStatus: item.lifecycleStatus }))
    .sort((a, b) => a.abfCode.localeCompare(b.abfCode, "cs", { numeric: true }));

  const count = (action: AbfImportPlanRow["action"]) => planRows.filter((row) => row.action === action).length;
  return {
    sourceFile,
    rows: planRows,
    skippedWithoutAbfCode,
    duplicateCodes,
    notInFile,
    summary: {
      dataRows: rows.length,
      withAbfCode: rows.filter((row) => row.abfCode).length,
      skippedWithoutAbfCode: skippedWithoutAbfCode.length,
      create: count("create"),
      update: count("update"),
      unchanged: count("unchanged"),
      conflicts: count("conflict"),
      duplicateCodes: duplicateCodes.length,
      createdNeedingTypeReview: planRows.filter((row) => row.action === "create" && !row.classification.confident).length,
    },
  };
}

// ============================================================================
// WRITE PAYLOADS — what the repository writes for each planned row. Kept pure so the
// "never touch non-import fields" guarantee is unit-testable without a database.
// ============================================================================

export type AbfImportInsertRow = Readonly<{
  internal_code: string;
  abf_code: string;
  item_type: CatalogItemType;
  kind: CatalogItemKind;
  lifecycle_status: "needs_review";
  display_name: string;
  official_name: string;
  category: null;
  unit: string | null;
  document: CatalogItemAdminDocument;
}>;

export function buildAbfImportInsert(plan: Extract<AbfImportPlanRow, { action: "create" }>, sourceFile: string, importedAt: string): AbfImportInsertRow {
  const document: Record<string, unknown> = {
    displayName: plan.row.nameCz,
    name: plan.row.nameCz,
    catalogItemKind: plan.classification.kind,
    abfImport: buildAbfImportProvenance(plan.row, sourceFile, importedAt),
  };
  if (plan.row.unit) document.unit = plan.row.unit;
  if (!plan.classification.confident) document.itemTypeNeedsReview = true;
  return {
    internal_code: plan.internalCode,
    abf_code: plan.abfCode,
    item_type: plan.classification.itemType,
    kind: plan.classification.kind,
    lifecycle_status: "needs_review",
    display_name: plan.row.nameCz,
    official_name: plan.row.nameCz,
    category: null,
    unit: plan.row.unit,
    document,
  };
}

/**
 * The column patch for an update row — ONLY import-managed columns, plus the document with
 * nothing but `abfImport` (and `unit` when it was empty) changed. Every other document key
 * (assets, technicalRaster, variants, pricingEntries, reviewedAt, ...) passes through untouched.
 */
export function buildAbfImportUpdatePatch(
  plan: Extract<AbfImportPlanRow, { action: "update" }>,
  currentDocument: CatalogItemAdminDocument,
  sourceFile: string,
  importedAt: string,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const document: Record<string, unknown> = { ...currentDocument, abfImport: buildAbfImportProvenance(plan.row, sourceFile, importedAt) };
  for (const change of plan.changes) {
    if (change.field === "abf_code") patch.abf_code = change.to;
    if (change.field === "internal_code") patch.internal_code = change.to;
    if (change.field === "official_name") patch.official_name = change.to;
    if (change.field === "unit") {
      patch.unit = change.to;
      if (!document.unit) document.unit = change.to;
    }
  }
  patch.document = document;
  return patch;
}
