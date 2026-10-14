/**
 * Kontrola vyúčtování realizaček — shared model + the ONE place settlement text, stand numbers,
 * units and quantities are normalized. Pure, no I/O.
 *
 * One check = one event + one realization company. It compares what ABF ordered (per stand) with
 * what the realization company billed (per stand). Batch 1 compares QUANTITIES only — prices are
 * imported and kept as original data, never compared.
 *
 * Links reuse existing entities (same convention as supabase/migrations/20260925120000_tasks.sql):
 * event -> events.id, realizačka -> print_surface_realization_companies.id, component ->
 * catalog_items.id. Stand identity is event + normalized stand number.
 */
import { normalizeStandNumber } from "./technicalStandNumber.ts";

export const SETTLEMENT_CHECK_STATUSES = ["draft", "in_progress", "reviewed", "closed"] as const;
export type SettlementCheckStatus = (typeof SETTLEMENT_CHECK_STATUSES)[number];

export const SETTLEMENT_CHECK_STATUS_LABELS_CS: Readonly<Record<SettlementCheckStatus, string>> = {
  draft: "Nová",
  in_progress: "Probíhá kontrola",
  reviewed: "Zkontrolováno",
  closed: "Uzavřeno",
};

export const SETTLEMENT_SIDES = ["abf", "vendor"] as const;
export type SettlementSide = (typeof SETTLEMENT_SIDES)[number];

export const SETTLEMENT_FILE_FORMATS = ["xlsx", "pdf"] as const;
export type SettlementFileFormat = (typeof SETTLEMENT_FILE_FORMATS)[number];

/** `importing` rows are never read by the comparison; `superseded` keeps a replaced file's original data. */
export const SETTLEMENT_FILE_STATUSES = ["importing", "imported", "superseded"] as const;
export type SettlementFileStatus = (typeof SETTLEMENT_FILE_STATUSES)[number];

export const SETTLEMENT_PARSERS = ["abf_orders_v1", "creativ_expo_v1"] as const;
export type SettlementParser = (typeof SETTLEMENT_PARSERS)[number];

/** Vendor billing parsers offered in the UI. Adding MAC = adding a parser + an entry here. */
export const SETTLEMENT_VENDOR_PARSERS: readonly Readonly<{ id: SettlementParser; label: string; formats: readonly SettlementFileFormat[] }>[] = [
  { id: "creativ_expo_v1", label: "Creativ Expo — XLSX šablona (záložka na stánek)", formats: ["xlsx"] },
];

export const SETTLEMENT_RESULT_STATUSES = ["match", "difference", "only_abf", "only_vendor", "unclear", "requires_rule", "out_of_scope"] as const;
export type SettlementResultStatus = (typeof SETTLEMENT_RESULT_STATUSES)[number];

export const SETTLEMENT_RESULT_STATUS_LABELS_CS: Readonly<Record<SettlementResultStatus, string>> = {
  match: "Shoda",
  difference: "Rozdíl",
  only_abf: "Pouze ABF",
  only_vendor: "Pouze realizačka",
  unclear: "Nejasné",
  requires_rule: "Vyžaduje pravidlo",
  out_of_scope: "Mimo rozsah",
};

/** Statuses that count as an open problem on a stand. `match` and `out_of_scope` never do. */
export const SETTLEMENT_PROBLEM_STATUSES: readonly SettlementResultStatus[] = ["difference", "only_abf", "only_vendor", "unclear", "requires_rule"];

export const SETTLEMENT_MAPPING_STATUSES = ["suggested", "confirmed", "unclear"] as const;
export type SettlementMappingStatus = (typeof SETTLEMENT_MAPPING_STATUSES)[number];

export const SETTLEMENT_MAPPING_STATUS_LABELS_CS: Readonly<Record<SettlementMappingStatus, string>> = {
  suggested: "Návrh",
  confirmed: "Potvrzeno",
  unclear: "Nejasné",
};

/** Who produced a mapping/rule. `ai_suggestion` is reserved — nothing writes it in batch 1. */
export const SETTLEMENT_ORIGINS = ["manual", "import", "ai_suggestion"] as const;
export type SettlementOrigin = (typeof SETTLEMENT_ORIGINS)[number];

export const CATALOG_NAME_TYPES = ["abf_original", "abf_alternative"] as const;
export type CatalogNameType = (typeof CATALOG_NAME_TYPES)[number];

export const CATALOG_NAME_TYPE_LABELS_CS: Readonly<Record<CatalogNameType, string>> = {
  abf_original: "Originální název ABF",
  abf_alternative: "Alternativní název ABF",
};

export const SETTLEMENT_DECISIONS = ["accepted", "disputed"] as const;
export type SettlementDecisionValue = (typeof SETTLEMENT_DECISIONS)[number];

export const SETTLEMENT_DECISION_LABELS_CS: Readonly<Record<SettlementDecisionValue, string>> = {
  accepted: "Zkontrolováno — v pořádku",
  disputed: "K řešení s realizačkou",
};

// ============================================================================
// Normalization
// ============================================================================

/** Lower-case, diacritics stripped, whitespace collapsed. The comparison key for every item name. */
export function normalizeSettlementText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("cs")
    .replace(/[ \s]+/gu, " ")
    .trim();
}

const STAND_KEY_PATTERN = /^(\d{1,2})([A-Za-z])0*(\d{1,3})([A-Za-z]?)$/u;

/**
 * Matching key of a stand number: "4C07" and "4C7" and "4c7" are the same stand, "3A38a" keeps
 * its suffix. Returns null for anything that is not ONE hall+aisle+number stand ("13", "ostatní",
 * "4C1-2") — such a value is never guessed into a stand; the caller files it as unassigned.
 */
export function settlementStandKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = STAND_KEY_PATTERN.exec(normalizeStandNumber(String(raw)));
  if (!match) return null;
  return `${Number(match[1])}${match[2]!.toUpperCase()}${Number(match[3])}${match[4]!.toLowerCase()}`;
}

const UNIT_BASES: Readonly<Record<string, string>> = {
  ks: "ks", kus: "ks", kusy: "ks", kusu: "ks", pc: "ks", pcs: "ks",
  m2: "m2",
  bm: "bm", mb: "bm",
  m: "m",
  den: "den", dny: "den", dni: "den", d: "den",
  hod: "hod", h: "hod",
};

/**
 * Canonical unit for comparison: "KS" -> "ks", "m²" -> "m2", "m2/ak" -> "m2" (per-event suffix
 * carries no quantity meaning), "ks/d" -> "ks/den". Unknown units are kept (lower-cased) so two
 * identical unknown units still compare; blank is null = "unit unknown".
 */
export function canonicalUnit(raw: string | null | undefined): string | null {
  const text = normalizeSettlementText(raw).replace(/²/gu, "2").replace(/\s+/gu, "").replace(/\.+$/u, "");
  if (!text) return null;
  const [basePart, ...suffixParts] = text.split("/");
  const base = UNIT_BASES[basePart ?? ""] ?? basePart ?? "";
  if (!base) return null;
  const suffix = suffixParts.map((part) => UNIT_BASES[part] ?? part).filter((part) => part !== "ak" && part !== "akce" && part !== "akci");
  return suffix.length > 0 ? `${base}/${suffix.join("/")}` : base;
}

export type ParsedQuantity = Readonly<{ value: number | null; raw: string; issue: string | null }>;

/**
 * Reads a quantity cell. Blank -> null without an issue (a template row). A value that is present
 * but not a number ("2x", "dle dohody") -> null WITH an issue, so the row is surfaced, never
 * silently treated as not billed.
 */
export function parseSettlementQuantity(raw: unknown): ParsedQuantity {
  if (raw === null || raw === undefined) return { value: null, raw: "", issue: null };
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? { value: raw, raw: String(raw), issue: null } : { value: null, raw: String(raw), issue: "Množství není číslo." };
  }
  const text = String(raw).trim();
  if (!text) return { value: null, raw: "", issue: null };
  const match = /^(-?\d+(?:[.,]\d+)?)\s*(ks|kus|kusy|m2|m²|bm|m)?\.?$/iu.exec(text.replace(/ /gu, " "));
  if (!match) return { value: null, raw: text, issue: `Množství „${text}“ se nepodařilo přečíst jako číslo.` };
  return { value: Number(match[1]!.replace(",", ".")), raw: text, issue: null };
}

/** Sums/differences of decimal quantities (4,5 + 4,5) without binary float noise. */
export function roundQuantity(value: number): number {
  return Math.round(value * 10000) / 10000;
}

// ============================================================================
// Parsed import shapes (parser output, before persistence)
// ============================================================================

export type SettlementImportWarning = Readonly<{
  code: string;
  message: string;
  severity: "info" | "warning";
  sheet?: string;
  row?: number;
  page?: number;
}>;

export type ParsedAbfItem = Readonly<{
  sourceRow: number | null;
  sourcePage: number | null;
  rawName: string;
  /** "T18" from "T18 - TYPOVÝ STÁNEK 6X3 m (STAVBA)" — the only place an ABF order line carries a code. */
  abfCode: string | null;
  quantity: number | null;
  quantityRaw: string;
  quantityIssue: string | null;
  unitRaw: string | null;
  note: string | null;
  raw: unknown;
}>;

export type ParsedAbfStand = Readonly<{
  standNumberRaw: string;
  standKey: string | null;
  documentNumber: string | null;
  exhibitorName: string | null;
  exhibitorDisplayName: string | null;
  dimensionsText: string | null;
  sourceRow: number | null;
  sourcePage: number | null;
  items: readonly ParsedAbfItem[];
}>;

export type ParsedAbfOrders = Readonly<{
  title: string | null;
  orderLabel: string | null;
  companyLabel: string | null;
  stands: readonly ParsedAbfStand[];
  warnings: readonly SettlementImportWarning[];
}>;

export type VendorRowKind = "item" | "surcharge" | "total";

export type ParsedVendorRow = Readonly<{
  sourceRow: number;
  rawName: string;
  unitPrice: number | null;
  quantity: number | null;
  quantityRaw: string;
  quantityIssue: string | null;
  lineTotal: number | null;
  unit: string | null;
  /** "name" = read from the item text ("Kč/1m2"), "default" = no unit in the text, pieces assumed. */
  unitSource: "name" | "default";
  note: string | null;
  rowKind: VendorRowKind;
  /** True only for a row with a real non-zero quantity. Template rows stay false and never reach the comparison. */
  isBilled: boolean;
  raw: unknown;
}>;

export type VendorSheetKind = "stand" | "unassigned" | "summary";

export type ParsedVendorSheet = Readonly<{
  sheetName: string;
  kind: VendorSheetKind;
  /** Why a sheet could not be filed under a stand — shown in "Nepřiřazené / Ostatní". */
  unassignedReason: string | null;
  title: string | null;
  standNumberRaw: string | null;
  standKey: string | null;
  exhibitorName: string | null;
  rows: readonly ParsedVendorRow[];
  billedCount: number;
}>;

export type ParsedVendorBilling = Readonly<{
  parser: SettlementParser;
  eventLabel: string | null;
  sheets: readonly ParsedVendorSheet[];
  summaryEntries: readonly Readonly<{ label: string; amount: number | null }>[];
  warnings: readonly SettlementImportWarning[];
}>;

// ============================================================================
// Persisted entities
// ============================================================================

export type SettlementCheck = Readonly<{
  id: string;
  eventId: string;
  realizationCompanyId: string;
  /** Snapshot of the company name at creation — the company catalog can be re-imported wholesale. */
  realizationCompanyName: string;
  status: SettlementCheckStatus;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastComparedAt: string | null;
  currentRunId: string | null;
  /** Counts from the last comparison run (stands / rows per status). Null before the first run. */
  summary: SettlementRunSummary | null;
}>;

export type SettlementImportFile = Readonly<{
  id: string;
  checkId: string;
  side: SettlementSide;
  format: SettlementFileFormat;
  parser: SettlementParser;
  fileName: string;
  fileSize: number;
  /** SHA-256 of the file bytes — a second upload of the same bytes is recognized, never duplicated. */
  fingerprint: string;
  status: SettlementFileStatus;
  summary: SettlementFileSummary;
  createdBy: string | null;
  importedAt: string;
}>;

export type SettlementFileSummary = Readonly<{
  standCount: number;
  unassignedCount: number;
  itemCount: number;
  /** Vendor side only: rows kept as original data that are not billed (empty template rows). */
  templateRowCount: number;
  warnings: readonly SettlementImportWarning[];
}>;

export type SettlementStand = Readonly<{
  id: string;
  checkId: string;
  fileId: string;
  side: SettlementSide;
  /** Sheet name (vendor) or the stand cell (ABF), exactly as imported. */
  label: string;
  standNumberRaw: string | null;
  standKey: string | null;
  /** Set by the user for a sheet the import could not file under a stand. Never guessed. */
  manualStandKey: string | null;
  unassignedReason: string | null;
  title: string | null;
  exhibitorName: string | null;
  documentNumber: string | null;
  sourceRow: number | null;
  sourcePage: number | null;
  sortOrder: number;
}>;

/** The stand a row is compared under: the user's assignment wins over the imported key. */
export function effectiveStandKey(stand: Pick<SettlementStand, "standKey" | "manualStandKey">): string | null {
  return stand.manualStandKey ?? stand.standKey;
}

export type SettlementAbfItem = Readonly<{
  id: string;
  checkId: string;
  fileId: string;
  standId: string;
  sourceRow: number | null;
  sourcePage: number | null;
  rawName: string;
  normalizedName: string;
  abfCode: string | null;
  quantity: number | null;
  quantityRaw: string;
  quantityIssue: string | null;
  unitRaw: string | null;
  unit: string | null;
  note: string | null;
  raw: unknown;
}>;

export type SettlementVendorItem = Readonly<{
  id: string;
  checkId: string;
  fileId: string;
  standId: string;
  sourceSheet: string;
  sourceRow: number;
  rawName: string;
  normalizedName: string;
  unitPrice: number | null;
  quantity: number | null;
  quantityRaw: string;
  quantityIssue: string | null;
  lineTotal: number | null;
  unit: string | null;
  unitSource: "name" | "default";
  note: string | null;
  rowKind: VendorRowKind;
  isBilled: boolean;
  raw: unknown;
}>;

/** Dictionary entry: one realization company's own item text -> our catalog component. */
export type SettlementVendorMapping = Readonly<{
  id: string;
  realizationCompanyId: string;
  sourceText: string;
  normalizedText: string;
  /** null = not recognized yet. */
  catalogItemId: string | null;
  /** Overrides the unit read from the item text when set. */
  unit: string | null;
  status: SettlementMappingStatus;
  origin: SettlementOrigin;
  note: string | null;
  updatedAt: string;
}>;

export type CatalogItemName = Readonly<{
  id: string;
  catalogItemId: string;
  nameType: CatalogNameType;
  name: string;
  normalizedName: string;
  createdAt: string;
}>;

/** Catalog card as the settlement module needs it — read-only, never written from here. */
export type SettlementCatalogItem = Readonly<{
  id: string;
  abfCode: string | null;
  internalCode: string | null;
  displayName: string;
  /** catalog_items.official_name — the ABF name the KODY import manages. */
  officialName: string | null;
  unit: string | null;
  lifecycleStatus: string;
}>;

export type SettlementDecision = Readonly<{
  id: string;
  checkId: string;
  standKey: string;
  rowKey: string;
  decision: SettlementDecisionValue | null;
  note: string | null;
  createdBy: string | null;
  updatedAt: string;
}>;

export type SettlementRunSummary = Readonly<{
  standCount: number;
  matchedStandCount: number;
  abfOnlyStandCount: number;
  vendorOnlyStandCount: number;
  unassignedVendorSheetCount: number;
  unassignedAbfStandCount: number;
  rowCounts: Readonly<Record<SettlementResultStatus, number>>;
}>;

export function emptyRowCounts(): Record<SettlementResultStatus, number> {
  return { match: 0, difference: 0, only_abf: 0, only_vendor: 0, unclear: 0, requires_rule: 0, out_of_scope: 0 };
}

export function countProblems(counts: Readonly<Record<SettlementResultStatus, number>>): number {
  return SETTLEMENT_PROBLEM_STATUSES.reduce((sum, status) => sum + counts[status], 0);
}

// ============================================================================
// Validation errors (mapped to 400/404/409 by lib/settlement/settlementApi.server.ts)
// ============================================================================

export class SettlementValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementValidationError";
  }
}

export class SettlementNotFoundError extends Error {
  constructor(message = "Kontrola vyúčtování nebyla nalezena.") {
    super(message);
    this.name = "SettlementNotFoundError";
  }
}

/** A conflict the user can resolve by choosing how to continue (e.g. replace vs. add a file). */
export class SettlementConflictError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "SettlementConflictError";
    this.code = code;
    this.details = details;
  }
}
