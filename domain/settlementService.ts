/**
 * Kontrola vyúčtování — application service: every write to a check goes through here
 * (app/api/settlement-checks/* -> this -> SettlementRepository). Pure orchestration over the
 * repository interface, so the whole flow (import, re-import, recompute, manual mappings) is
 * tested against an in-memory repository without a database.
 *
 * Invariants kept here:
 *  - a file is identified by the SHA-256 of its bytes: the same bytes are never imported twice;
 *  - a new file with the name of an already imported one needs an explicit choice (replace/add);
 *  - a replaced file is marked `superseded`, its original rows stay in the database;
 *  - importing never touches the dictionary beyond ADDING missing texts as unresolved suggestions;
 *  - recompute reads only stored data — nothing has to be uploaded again;
 *  - manual decisions are keyed by stand + row key, so they survive every recompute and re-import.
 */
import { isComparableVendorRow } from "./settlementCreativExpoImport.ts";
import {
  compareSettlement,
  type ComparisonCatalogItem,
  type ComparisonRow,
  type StandMatchState,
} from "./settlementComparison.ts";
import { activeOutOfScopeRules, parseSettlementRuleInput, planRuleStatusChange, type SettlementRule, type SettlementRuleInput, type SettlementRuleStatusPatch } from "./settlementRules.ts";
import {
  canonicalUnit,
  CATALOG_NAME_TYPES,
  effectiveStandKey,
  normalizeSettlementText,
  SETTLEMENT_CHECK_STATUSES,
  SETTLEMENT_DECISIONS,
  SETTLEMENT_MAPPING_STATUSES,
  SettlementConflictError,
  SettlementNotFoundError,
  settlementStandKey,
  SettlementValidationError,
  type CatalogItemName,
  type CatalogNameType,
  type ParsedAbfOrders,
  type ParsedVendorBilling,
  type SettlementAbfItem,
  type SettlementCatalogItem,
  type SettlementCheck,
  type SettlementCheckStatus,
  type SettlementDecision,
  type SettlementDecisionValue,
  type SettlementFileFormat,
  type SettlementFileStatus,
  type SettlementFileSummary,
  type SettlementImportFile,
  type SettlementMappingStatus,
  type SettlementOrigin,
  type SettlementParser,
  type SettlementRunSummary,
  type SettlementSide,
  type SettlementStand,
  type SettlementVendorItem,
  type SettlementVendorMapping,
} from "./settlementCheck.ts";

/** One stand of the last comparison run — kept even when the stand has no row at all. */
export type SettlementStandHeader = Readonly<{
  standKey: string;
  displayNumber: string;
  matchState: StandMatchState;
  abfExhibitorName: string | null;
  vendorExhibitorName: string | null;
}>;

export type SettlementResultRow = ComparisonRow & Readonly<{ standKey: string }>;

export type SettlementImportPayload = Readonly<{
  file: Omit<SettlementImportFile, "status" | "importedAt">;
  stands: readonly SettlementStand[];
  abfItems: readonly SettlementAbfItem[];
  vendorItems: readonly SettlementVendorItem[];
}>;

export type SettlementMappingInput = Readonly<{
  realizationCompanyId: string;
  sourceText: string;
  normalizedText: string;
  catalogItemId: string | null;
  unit: string | null;
  status: SettlementMappingStatus;
  origin: SettlementOrigin;
  note: string | null;
}>;

export interface SettlementRepository {
  listChecks(): Promise<readonly SettlementCheck[]>;
  getCheck(id: string): Promise<SettlementCheck | undefined>;
  findCheck(eventId: string, realizationCompanyId: string): Promise<SettlementCheck | undefined>;
  insertCheck(input: Readonly<{ eventId: string; realizationCompanyId: string; realizationCompanyName: string; note: string | null; createdBy: string | null }>): Promise<SettlementCheck>;
  updateCheck(id: string, patch: Readonly<{ status?: SettlementCheckStatus; note?: string | null }>): Promise<SettlementCheck>;
  deleteCheck(id: string): Promise<void>;

  /** Every file of the check, all statuses. */
  listFiles(checkId: string): Promise<readonly SettlementImportFile[]>;
  /** Stores a file with its stands and rows; must leave NOTHING behind when it fails. */
  insertImport(payload: SettlementImportPayload): Promise<SettlementImportFile>;
  setFileStatus(fileId: string, status: SettlementFileStatus): Promise<void>;
  deleteFile(fileId: string): Promise<void>;

  /** Stands / rows of `imported` files only. */
  listStands(checkId: string): Promise<readonly SettlementStand[]>;
  setStandManualKey(standId: string, manualStandKey: string | null): Promise<SettlementStand | undefined>;
  listAbfItems(checkId: string): Promise<readonly SettlementAbfItem[]>;
  listVendorItems(checkId: string, filter: Readonly<{ comparableOnly: boolean; standId?: string }>): Promise<readonly SettlementVendorItem[]>;

  listCatalogItems(): Promise<readonly SettlementCatalogItem[]>;
  listCatalogNames(): Promise<readonly CatalogItemName[]>;
  insertCatalogName(input: Readonly<{ catalogItemId: string; nameType: CatalogNameType; name: string; normalizedName: string }>): Promise<CatalogItemName>;
  deleteCatalogName(id: string): Promise<void>;

  listMappings(realizationCompanyId: string): Promise<readonly SettlementVendorMapping[]>;
  upsertMapping(input: SettlementMappingInput): Promise<SettlementVendorMapping>;
  /** Adds entries whose normalized text is not in the dictionary yet; never updates an existing one. */
  insertMissingMappings(entries: readonly SettlementMappingInput[]): Promise<void>;

  listRules(realizationCompanyId: string): Promise<readonly SettlementRule[]>;
  getRule(id: string): Promise<SettlementRule | undefined>;
  insertRule(input: Required<SettlementRuleInput> & Readonly<{ realizationCompanyId: string; origin: SettlementOrigin; createdBy: string | null }>): Promise<SettlementRule>;
  updateRule(id: string, patch: Partial<Required<SettlementRuleInput>> & Partial<SettlementRuleStatusPatch>): Promise<SettlementRule>;

  /** Stores a new result set, points the check at it, then drops the previous one. */
  replaceResults(checkId: string, run: Readonly<{ summary: SettlementRunSummary; standIndex: readonly SettlementStandHeader[]; rows: readonly SettlementResultRow[] }>): Promise<SettlementCheck>;
  listResults(checkId: string): Promise<readonly SettlementResultRow[]>;
  getStandIndex(checkId: string): Promise<readonly SettlementStandHeader[]>;

  listDecisions(checkId: string): Promise<readonly SettlementDecision[]>;
  upsertDecision(input: Readonly<{ checkId: string; standKey: string; rowKey: string; decision: SettlementDecisionValue | null; note: string | null; createdBy: string | null }>): Promise<SettlementDecision>;
}

export type SettlementActor = Readonly<{ actorName?: string }>;
type IdFactory = () => string;
const defaultIdFactory: IdFactory = () => globalThis.crypto.randomUUID();

async function requireCheck(repository: SettlementRepository, id: unknown): Promise<SettlementCheck> {
  if (typeof id !== "string" || !id) throw new SettlementValidationError("Chybí ID kontroly.");
  const check = await repository.getCheck(id);
  if (!check) throw new SettlementNotFoundError();
  return check;
}

function assertEditable(check: SettlementCheck): void {
  if (check.status === "closed") {
    throw new SettlementValidationError("Kontrola je uzavřená — její data jsou chráněná. Pro změny ji nejdřív vraťte do stavu „Probíhá kontrola“.");
  }
}

// ============================================================================
// Checks
// ============================================================================

export async function createSettlementCheck(
  repository: SettlementRepository,
  input: Readonly<{ eventId?: string; realizationCompanyId?: string; realizationCompanyName?: string; note?: string }>,
  actor: SettlementActor = {},
): Promise<SettlementCheck> {
  if (!input.eventId) throw new SettlementValidationError("Vyberte akci.");
  if (!input.realizationCompanyId || !input.realizationCompanyName) throw new SettlementValidationError("Vyberte realizační firmu.");
  const existing = await repository.findCheck(input.eventId, input.realizationCompanyId);
  if (existing) {
    throw new SettlementConflictError("check_exists", "Pro tuto akci a realizační firmu už kontrola existuje — další soubory (např. druhou halu) nahrajte do ní.", { checkId: existing.id });
  }
  return repository.insertCheck({
    eventId: input.eventId,
    realizationCompanyId: input.realizationCompanyId,
    realizationCompanyName: input.realizationCompanyName,
    note: input.note?.trim() || null,
    createdBy: actor.actorName ?? null,
  });
}

export async function updateSettlementCheck(repository: SettlementRepository, id: unknown, patch: Readonly<{ status?: unknown; note?: unknown }>): Promise<SettlementCheck> {
  const check = await requireCheck(repository, id);
  const next: { status?: SettlementCheckStatus; note?: string | null } = {};
  if (patch.status !== undefined) {
    if (typeof patch.status !== "string" || !(SETTLEMENT_CHECK_STATUSES as readonly string[]).includes(patch.status)) throw new SettlementValidationError("Neplatný stav kontroly.");
    next.status = patch.status as SettlementCheckStatus;
  }
  if (patch.note !== undefined) next.note = typeof patch.note === "string" && patch.note.trim() ? patch.note.trim().slice(0, 2000) : null;
  return repository.updateCheck(check.id, next);
}

export async function deleteSettlementCheck(repository: SettlementRepository, id: unknown): Promise<void> {
  const check = await requireCheck(repository, id);
  if (check.status === "reviewed" || check.status === "closed") {
    throw new SettlementValidationError("Zkontrolovanou nebo uzavřenou kontrolu nelze smazat. Nejdřív jí vraťte stav „Probíhá kontrola“.");
  }
  await repository.deleteCheck(check.id);
}

// ============================================================================
// Import
// ============================================================================

type FileMeta = Readonly<{ checkId: string; format: SettlementFileFormat; fileName: string; fileSize: number; fingerprint: string; createdBy: string | null }>;

export function buildAbfImportPayload(meta: FileMeta, parsed: ParsedAbfOrders, newId: IdFactory = defaultIdFactory): SettlementImportPayload {
  const fileId = newId();
  const stands: SettlementStand[] = [];
  const abfItems: SettlementAbfItem[] = [];
  parsed.stands.forEach((stand, index) => {
    const standId = newId();
    stands.push({
      id: standId,
      checkId: meta.checkId,
      fileId,
      side: "abf",
      label: stand.standNumberRaw,
      standNumberRaw: stand.standNumberRaw,
      standKey: stand.standKey,
      manualStandKey: null,
      unassignedReason: stand.standKey ? null : "Označení není číslo jednoho stánku",
      title: stand.exhibitorDisplayName,
      exhibitorName: stand.exhibitorName,
      documentNumber: stand.documentNumber,
      sourceRow: stand.sourceRow,
      sourcePage: stand.sourcePage,
      sortOrder: index,
    });
    for (const item of stand.items) {
      abfItems.push({
        id: newId(),
        checkId: meta.checkId,
        fileId,
        standId,
        sourceRow: item.sourceRow,
        sourcePage: item.sourcePage,
        rawName: item.rawName,
        normalizedName: normalizeSettlementText(item.rawName),
        abfCode: item.abfCode,
        quantity: item.quantity,
        quantityRaw: item.quantityRaw,
        quantityIssue: item.quantityIssue,
        unitRaw: item.unitRaw,
        unit: canonicalUnit(item.unitRaw),
        note: item.note,
        raw: item.raw,
      });
    }
  });
  const summary: SettlementFileSummary = {
    standCount: stands.filter((stand) => stand.standKey).length,
    unassignedCount: stands.filter((stand) => !stand.standKey).length,
    itemCount: abfItems.length,
    templateRowCount: 0,
    warnings: parsed.warnings,
  };
  return { file: { id: fileId, checkId: meta.checkId, side: "abf", format: meta.format, parser: "abf_orders_v1", fileName: meta.fileName, fileSize: meta.fileSize, fingerprint: meta.fingerprint, summary, createdBy: meta.createdBy }, stands, abfItems, vendorItems: [] };
}

export function buildVendorImportPayload(meta: FileMeta, parsed: ParsedVendorBilling, newId: IdFactory = defaultIdFactory): SettlementImportPayload {
  const fileId = newId();
  const stands: SettlementStand[] = [];
  const vendorItems: SettlementVendorItem[] = [];
  parsed.sheets.forEach((sheet, index) => {
    if (sheet.kind === "summary") return;
    const standId = newId();
    stands.push({
      id: standId,
      checkId: meta.checkId,
      fileId,
      side: "vendor",
      label: sheet.sheetName,
      standNumberRaw: sheet.standNumberRaw,
      standKey: sheet.standKey,
      manualStandKey: null,
      unassignedReason: sheet.unassignedReason,
      title: sheet.title,
      exhibitorName: sheet.exhibitorName,
      documentNumber: null,
      sourceRow: null,
      sourcePage: null,
      sortOrder: index,
    });
    for (const row of sheet.rows) {
      vendorItems.push({
        id: newId(),
        checkId: meta.checkId,
        fileId,
        standId,
        sourceSheet: sheet.sheetName,
        sourceRow: row.sourceRow,
        rawName: row.rawName,
        normalizedName: normalizeSettlementText(row.rawName),
        unitPrice: row.unitPrice,
        quantity: row.quantity,
        quantityRaw: row.quantityRaw,
        quantityIssue: row.quantityIssue,
        lineTotal: row.lineTotal,
        unit: row.unit,
        unitSource: row.unitSource,
        note: row.note,
        rowKind: row.rowKind,
        isBilled: row.isBilled,
        raw: row.raw,
      });
    }
  });
  const comparable = vendorItems.filter(isComparableVendorRow);
  const summary: SettlementFileSummary = {
    standCount: stands.filter((stand) => stand.standKey).length,
    unassignedCount: stands.filter((stand) => !stand.standKey).length,
    itemCount: comparable.length,
    templateRowCount: vendorItems.length - comparable.length,
    warnings: parsed.warnings,
  };
  return { file: { id: fileId, checkId: meta.checkId, side: "vendor", format: meta.format, parser: parsed.parser, fileName: meta.fileName, fileSize: meta.fileSize, fingerprint: meta.fingerprint, summary, createdBy: meta.createdBy }, stands, abfItems: [], vendorItems };
}

export type SettlementImportRequest = Readonly<{
  checkId: unknown;
  side: SettlementSide;
  format: SettlementFileFormat;
  fileName: string;
  fileSize: number;
  fingerprint: string;
  parsed: Readonly<{ side: "abf"; orders: ParsedAbfOrders }> | Readonly<{ side: "vendor"; billing: ParsedVendorBilling }>;
  /** Required only when a file with the same name is already imported on this side. */
  mode?: "replace" | "add";
}>;

export async function importSettlementFile(
  repository: SettlementRepository,
  request: SettlementImportRequest,
  actor: SettlementActor = {},
  newId: IdFactory = defaultIdFactory,
): Promise<Readonly<{ file: SettlementImportFile; check: SettlementCheck; replacedFileIds: readonly string[] }>> {
  const check = await requireCheck(repository, request.checkId);
  assertEditable(check);

  const active = (await repository.listFiles(check.id)).filter((file) => file.side === request.side && file.status === "imported");
  const duplicate = active.find((file) => file.fingerprint === request.fingerprint);
  if (duplicate) {
    throw new SettlementConflictError("duplicate_file", `Soubor „${duplicate.fileName}“ se stejným obsahem už je v této kontrole naimportovaný — nic se nezměnilo.`, { fileId: duplicate.id });
  }
  const sameName = active.filter((file) => file.fileName.toLocaleLowerCase("cs") === request.fileName.toLocaleLowerCase("cs"));
  if (sameName.length > 0 && !request.mode) {
    throw new SettlementConflictError(
      "same_name_file",
      `Soubor se jménem „${request.fileName}“ už v kontrole je, ale má jiný obsah. Zvolte, zda ho novou verzí nahradit, nebo nový soubor přidat vedle něj.`,
      { fileIds: sameName.map((file) => file.id) },
    );
  }

  const meta: FileMeta = { checkId: check.id, format: request.format, fileName: request.fileName, fileSize: request.fileSize, fingerprint: request.fingerprint, createdBy: actor.actorName ?? null };
  const payload = request.parsed.side === "abf" ? buildAbfImportPayload(meta, request.parsed.orders, newId) : buildVendorImportPayload(meta, request.parsed.billing, newId);
  if (payload.stands.length === 0) {
    const reason = payload.file.summary.warnings.find((warning) => warning.severity === "warning")?.message;
    throw new SettlementValidationError(`V souboru „${request.fileName}“ nebyl nalezen žádný stánek — nic se neimportovalo.${reason ? ` ${reason}` : ""}`);
  }

  const file = await repository.insertImport(payload);
  const replacedFileIds = request.mode === "replace" ? sameName.map((existing) => existing.id) : [];
  for (const fileId of replacedFileIds) await repository.setFileStatus(fileId, "superseded");

  if (request.side === "vendor") {
    const seen = new Set<string>();
    const entries: SettlementMappingInput[] = [];
    for (const item of payload.vendorItems) {
      if (!isComparableVendorRow(item) || !item.normalizedName || seen.has(item.normalizedName)) continue;
      seen.add(item.normalizedName);
      entries.push({ realizationCompanyId: check.realizationCompanyId, sourceText: item.rawName, normalizedText: item.normalizedName, catalogItemId: null, unit: null, status: "suggested", origin: "import", note: null });
    }
    if (entries.length > 0) await repository.insertMissingMappings(entries);
  }

  if (check.status === "draft") await repository.updateCheck(check.id, { status: "in_progress" });
  const recomputed = await recomputeSettlementCheck(repository, check.id);
  return { file, check: recomputed, replacedFileIds };
}

export async function removeSettlementFile(repository: SettlementRepository, checkId: unknown, fileId: unknown): Promise<SettlementCheck> {
  const check = await requireCheck(repository, checkId);
  assertEditable(check);
  const file = (await repository.listFiles(check.id)).find((candidate) => candidate.id === fileId);
  if (!file) throw new SettlementNotFoundError("Importovaný soubor nebyl nalezen.");
  await repository.deleteFile(file.id);
  return recomputeSettlementCheck(repository, check.id);
}

// ============================================================================
// Comparison
// ============================================================================

/** Catalog cards + their names -> what the engine matches ABF lines against. Archived cards still resolve (an old order may name them). */
export function toComparisonCatalog(items: readonly SettlementCatalogItem[], names: readonly CatalogItemName[]): readonly ComparisonCatalogItem[] {
  const extra = new Map<string, string[]>();
  for (const name of names) extra.set(name.catalogItemId, [...(extra.get(name.catalogItemId) ?? []), name.name]);
  return items.map((item) => ({
    id: item.id,
    abfCode: item.abfCode,
    displayName: item.displayName,
    abfNames: [item.officialName, ...(extra.get(item.id) ?? [])].filter((name): name is string => Boolean(name?.trim())),
  }));
}

export async function recomputeSettlementCheck(repository: SettlementRepository, checkId: unknown): Promise<SettlementCheck> {
  const check = await requireCheck(repository, checkId);
  const [stands, abfItems, vendorItems, catalogItems, catalogNames, mappings, rules] = await Promise.all([
    repository.listStands(check.id),
    repository.listAbfItems(check.id),
    repository.listVendorItems(check.id, { comparableOnly: true }),
    repository.listCatalogItems(),
    repository.listCatalogNames(),
    repository.listMappings(check.realizationCompanyId),
    repository.listRules(check.realizationCompanyId),
  ]);
  const standById = new Map(stands.map((stand) => [stand.id, stand]));
  const standInfo = (standId: string) => {
    const stand = standById.get(standId);
    return { standKey: stand ? effectiveStandKey(stand) : null, standLabel: stand?.standNumberRaw ?? stand?.label ?? "", exhibitorName: stand?.exhibitorName ?? null };
  };
  const knownStands = (side: SettlementSide) => stands
    .filter((stand) => stand.side === side && effectiveStandKey(stand))
    .map((stand) => ({ standKey: effectiveStandKey(stand)!, label: stand.standNumberRaw ?? stand.manualStandKey ?? stand.label, exhibitorName: stand.exhibitorName }));

  const comparison = compareSettlement({
    catalog: toComparisonCatalog(catalogItems, catalogNames),
    abfLines: abfItems.map((item) => ({ id: item.id, ...standInfo(item.standId), rawName: item.rawName, abfCode: item.abfCode, quantity: item.quantity, quantityIssue: item.quantityIssue, unitRaw: item.unitRaw })),
    vendorLines: vendorItems.map((item) => ({ id: item.id, ...standInfo(item.standId), rawName: item.rawName, quantity: item.quantity, quantityIssue: item.quantityIssue, unit: item.unit })),
    mappings,
    outOfScopeRules: activeOutOfScopeRules(rules, check.eventId),
    abfStandKeys: knownStands("abf"),
    vendorStandKeys: knownStands("vendor"),
  });

  const comparableByStand = new Set(vendorItems.map((item) => item.standId));
  const summary: SettlementRunSummary = {
    ...comparison.summary,
    // Only sheets that actually bill something count as an open "unassigned" problem.
    unassignedVendorSheetCount: stands.filter((stand) => stand.side === "vendor" && !effectiveStandKey(stand) && comparableByStand.has(stand.id)).length,
    unassignedAbfStandCount: stands.filter((stand) => stand.side === "abf" && !effectiveStandKey(stand)).length,
  };
  return repository.replaceResults(check.id, {
    summary,
    standIndex: comparison.stands.map((stand) => ({ standKey: stand.standKey, displayNumber: stand.displayNumber, matchState: stand.matchState, abfExhibitorName: stand.abfExhibitorName, vendorExhibitorName: stand.vendorExhibitorName })),
    rows: comparison.stands.flatMap((stand) => stand.rows.map((row) => ({ ...row, standKey: stand.standKey }))),
  });
}

export type SettlementCheckDetail = Readonly<{
  check: SettlementCheck;
  files: readonly SettlementImportFile[];
  stands: readonly SettlementStand[];
  standIndex: readonly SettlementStandHeader[];
  results: readonly SettlementResultRow[];
  abfItems: readonly SettlementAbfItem[];
  /** Comparable rows only; the full original sheet is loaded on demand (loadSettlementSourceRows). */
  vendorItems: readonly SettlementVendorItem[];
  decisions: readonly SettlementDecision[];
}>;

export async function loadSettlementCheckDetail(repository: SettlementRepository, id: unknown): Promise<SettlementCheckDetail> {
  const check = await requireCheck(repository, id);
  const [files, stands, standIndex, results, abfItems, vendorItems, decisions] = await Promise.all([
    repository.listFiles(check.id),
    repository.listStands(check.id),
    repository.getStandIndex(check.id),
    repository.listResults(check.id),
    repository.listAbfItems(check.id),
    repository.listVendorItems(check.id, { comparableOnly: true }),
    repository.listDecisions(check.id),
  ]);
  return { check, files, stands, standIndex, results, abfItems, vendorItems, decisions };
}

/** The complete original rows of one vendor sheet — including the empty template rows. */
export async function loadSettlementSourceRows(repository: SettlementRepository, checkId: unknown, standId: unknown): Promise<readonly SettlementVendorItem[]> {
  const check = await requireCheck(repository, checkId);
  if (typeof standId !== "string" || !standId) throw new SettlementValidationError("Chybí ID záložky.");
  return repository.listVendorItems(check.id, { comparableOnly: false, standId });
}

// ============================================================================
// Manual decisions
// ============================================================================

/** Files an unassigned sheet/order under a real stand number chosen by the user (or clears it). */
export async function assignSettlementStand(repository: SettlementRepository, checkId: unknown, standId: unknown, standNumber: unknown): Promise<SettlementCheck> {
  const check = await requireCheck(repository, checkId);
  assertEditable(check);
  if (typeof standId !== "string" || !standId) throw new SettlementValidationError("Chybí ID záložky.");
  let manualKey: string | null = null;
  if (typeof standNumber === "string" && standNumber.trim()) {
    manualKey = settlementStandKey(standNumber);
    if (!manualKey) throw new SettlementValidationError(`„${standNumber}“ není číslo stánku (očekáván tvar jako 3A17 nebo 4C7).`);
  }
  const stand = (await repository.listStands(check.id)).find((candidate) => candidate.id === standId);
  if (!stand) throw new SettlementNotFoundError("Záložka nebyla nalezena.");
  await repository.setStandManualKey(stand.id, manualKey);
  return recomputeSettlementCheck(repository, check.id);
}

export async function saveSettlementDecision(
  repository: SettlementRepository,
  input: Readonly<{ checkId: unknown; standKey: unknown; rowKey: unknown; decision: unknown; note: unknown }>,
  actor: SettlementActor = {},
): Promise<SettlementDecision> {
  const check = await requireCheck(repository, input.checkId);
  assertEditable(check);
  if (typeof input.standKey !== "string" || !input.standKey || typeof input.rowKey !== "string" || !input.rowKey) throw new SettlementValidationError("Chybí určení řádku.");
  const decision = input.decision === null || input.decision === undefined || input.decision === "" ? null : input.decision;
  if (decision !== null && !(SETTLEMENT_DECISIONS as readonly unknown[]).includes(decision)) throw new SettlementValidationError("Neplatné rozhodnutí.");
  return repository.upsertDecision({
    checkId: check.id,
    standKey: input.standKey,
    rowKey: input.rowKey,
    decision: decision as SettlementDecisionValue | null,
    note: typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 1000) : null,
    createdBy: actor.actorName ?? null,
  });
}

// ============================================================================
// Dictionary (realization-company names) and catalog ABF names
// ============================================================================

export async function saveSettlementMapping(
  repository: SettlementRepository,
  input: Readonly<{ realizationCompanyId: unknown; sourceText: unknown; catalogItemId: unknown; unit: unknown; status: unknown; note?: unknown }>,
): Promise<SettlementVendorMapping> {
  if (typeof input.realizationCompanyId !== "string" || !input.realizationCompanyId) throw new SettlementValidationError("Chybí realizační firma.");
  const sourceText = typeof input.sourceText === "string" ? input.sourceText.replace(/\s+/gu, " ").trim() : "";
  if (!sourceText) throw new SettlementValidationError("Chybí originální text položky realizačky.");
  if (typeof input.status !== "string" || !(SETTLEMENT_MAPPING_STATUSES as readonly string[]).includes(input.status)) throw new SettlementValidationError("Neplatný stav mapování.");
  const catalogItemId = typeof input.catalogItemId === "string" && input.catalogItemId ? input.catalogItemId : null;
  if (input.status === "confirmed" && !catalogItemId) throw new SettlementValidationError("Potvrdit lze jen mapování s vybranou komponentou.");
  if (catalogItemId && !(await repository.listCatalogItems()).some((item) => item.id === catalogItemId)) throw new SettlementValidationError("Vybraná komponenta v katalogu neexistuje.");
  const unit = typeof input.unit === "string" && input.unit.trim() ? canonicalUnit(input.unit) : null;
  return repository.upsertMapping({
    realizationCompanyId: input.realizationCompanyId,
    sourceText,
    normalizedText: normalizeSettlementText(sourceText),
    catalogItemId,
    unit,
    status: input.status as SettlementMappingStatus,
    origin: "manual",
    note: typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 500) : null,
  });
}

/** Adds an ABF name to a catalog card. Never touches catalog_items itself (codes, names, status). */
export async function addCatalogItemName(
  repository: SettlementRepository,
  input: Readonly<{ catalogItemId: unknown; nameType: unknown; name: unknown }>,
): Promise<CatalogItemName> {
  if (typeof input.catalogItemId !== "string" || !input.catalogItemId) throw new SettlementValidationError("Vyberte komponentu.");
  if (typeof input.nameType !== "string" || !(CATALOG_NAME_TYPES as readonly string[]).includes(input.nameType)) throw new SettlementValidationError("Neplatný typ názvu.");
  const name = typeof input.name === "string" ? input.name.replace(/\s+/gu, " ").trim() : "";
  if (!name) throw new SettlementValidationError("Název nesmí být prázdný.");
  if (name.length > 300 || /[<>]/u.test(name)) throw new SettlementValidationError("Název je příliš dlouhý nebo obsahuje nepovolené znaky.");
  const normalizedName = normalizeSettlementText(name);
  const [items, names] = await Promise.all([repository.listCatalogItems(), repository.listCatalogNames()]);
  const item = items.find((candidate) => candidate.id === input.catalogItemId);
  if (!item) throw new SettlementValidationError("Vybraná komponenta v katalogu neexistuje.");
  const taken = names.find((existing) => existing.normalizedName === normalizedName);
  if (taken && taken.catalogItemId === item.id) return taken;
  const owner = taken ? items.find((candidate) => candidate.id === taken.catalogItemId) : items.find((candidate) => candidate.id !== item.id && normalizeSettlementText(candidate.officialName) === normalizedName);
  if (owner) {
    throw new SettlementConflictError("abf_name_taken", `Název „${name}“ už patří komponentě „${owner.displayName}“${owner.abfCode ? ` (${owner.abfCode})` : ""}. Stejný název ABF nemůže vést na dvě komponenty.`, { catalogItemId: owner.id });
  }
  return repository.insertCatalogName({ catalogItemId: item.id, nameType: input.nameType as CatalogNameType, name, normalizedName });
}

// ============================================================================
// Rules
// ============================================================================

export async function createSettlementRule(repository: SettlementRepository, realizationCompanyId: unknown, raw: unknown, actor: SettlementActor = {}): Promise<SettlementRule> {
  if (typeof realizationCompanyId !== "string" || !realizationCompanyId) throw new SettlementValidationError("Chybí realizační firma.");
  const input = parseSettlementRuleInput(raw);
  // Always a draft: a rule only starts to count after an explicit, named activation.
  return repository.insertRule({ ...input, realizationCompanyId, origin: "manual", createdBy: actor.actorName ?? null });
}

export async function changeSettlementRuleStatus(repository: SettlementRepository, ruleId: unknown, status: unknown, actor: SettlementActor = {}, now: () => string = () => new Date().toISOString()): Promise<SettlementRule> {
  if (typeof ruleId !== "string" || !ruleId) throw new SettlementValidationError("Chybí ID pravidla.");
  const rule = await repository.getRule(ruleId);
  if (!rule) throw new SettlementNotFoundError("Pravidlo nebylo nalezeno.");
  return repository.updateRule(rule.id, planRuleStatusChange(rule, status, actor.actorName, now()));
}
