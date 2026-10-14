import { isComparableVendorRow } from "../../domain/settlementCreativExpoImport.ts";
import type {
  CatalogItemName,
  SettlementAbfItem,
  SettlementCatalogItem,
  SettlementCheck,
  SettlementDecision,
  SettlementImportFile,
  SettlementStand,
  SettlementVendorItem,
  SettlementVendorMapping,
} from "../../domain/settlementCheck.ts";
import type { SettlementRule } from "../../domain/settlementRules.ts";
import type { SettlementRepository, SettlementResultRow, SettlementStandHeader } from "../../domain/settlementService.ts";

/**
 * In-memory SettlementRepository with the same contract as lib/db/settlementRepository.supabase.ts
 * (imported-only reads, never-overwriting insertMissingMappings, atomic-looking insertImport),
 * so the service flow can be tested without a database. `failNextImport` simulates a write that
 * breaks half-way: nothing of that import may remain.
 */
export class MemorySettlementRepository implements SettlementRepository {
  checks: SettlementCheck[] = [];
  files: SettlementImportFile[] = [];
  stands: SettlementStand[] = [];
  abfItems: SettlementAbfItem[] = [];
  vendorItems: SettlementVendorItem[] = [];
  catalogItems: SettlementCatalogItem[] = [];
  catalogNames: CatalogItemName[] = [];
  mappings: SettlementVendorMapping[] = [];
  rules: SettlementRule[] = [];
  results = new Map<string, readonly SettlementResultRow[]>();
  standIndex = new Map<string, readonly SettlementStandHeader[]>();
  decisions: SettlementDecision[] = [];
  failNextImport = false;
  private sequence = 0;
  private clock = 0;

  private id(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  private now(): string {
    this.clock += 1;
    return new Date(Date.UTC(2026, 9, 13, 8, 0, this.clock)).toISOString();
  }

  private importedFileIds(checkId: string): Set<string> {
    return new Set(this.files.filter((file) => file.checkId === checkId && file.status === "imported").map((file) => file.id));
  }

  async listChecks() { return this.checks; }
  async getCheck(id: string) { return this.checks.find((check) => check.id === id); }
  async findCheck(eventId: string, realizationCompanyId: string) { return this.checks.find((check) => check.eventId === eventId && check.realizationCompanyId === realizationCompanyId); }

  async insertCheck(input: Parameters<SettlementRepository["insertCheck"]>[0]) {
    const now = this.now();
    const check: SettlementCheck = { id: this.id("check"), ...input, status: "draft", createdAt: now, updatedAt: now, lastComparedAt: null, currentRunId: null, summary: null };
    this.checks.push(check);
    return check;
  }

  async updateCheck(id: string, patch: Parameters<SettlementRepository["updateCheck"]>[1]) {
    const current = this.checks.find((check) => check.id === id)!;
    const next: SettlementCheck = { ...current, ...(patch.status !== undefined ? { status: patch.status } : {}), ...(patch.note !== undefined ? { note: patch.note } : {}), updatedAt: this.now() };
    this.checks = this.checks.map((check) => (check.id === id ? next : check));
    return next;
  }

  async deleteCheck(id: string) {
    this.checks = this.checks.filter((check) => check.id !== id);
    for (const file of this.files.filter((candidate) => candidate.checkId === id)) await this.deleteFile(file.id);
    this.decisions = this.decisions.filter((decision) => decision.checkId !== id);
    this.results.delete(id);
  }

  async listFiles(checkId: string) { return this.files.filter((file) => file.checkId === checkId); }

  async insertImport(payload: Parameters<SettlementRepository["insertImport"]>[0]) {
    if (this.failNextImport) {
      this.failNextImport = false;
      throw new Error("simulated database failure during import");
    }
    const file: SettlementImportFile = { ...payload.file, status: "imported", importedAt: this.now() };
    this.files.push(file);
    this.stands.push(...payload.stands);
    this.abfItems.push(...payload.abfItems);
    this.vendorItems.push(...payload.vendorItems);
    return file;
  }

  async setFileStatus(fileId: string, status: SettlementImportFile["status"]) {
    this.files = this.files.map((file) => (file.id === fileId ? { ...file, status } : file));
  }

  async deleteFile(fileId: string) {
    this.files = this.files.filter((file) => file.id !== fileId);
    this.stands = this.stands.filter((stand) => stand.fileId !== fileId);
    this.abfItems = this.abfItems.filter((item) => item.fileId !== fileId);
    this.vendorItems = this.vendorItems.filter((item) => item.fileId !== fileId);
  }

  async listStands(checkId: string) {
    const fileIds = this.importedFileIds(checkId);
    return this.stands.filter((stand) => fileIds.has(stand.fileId));
  }

  async setStandManualKey(standId: string, manualStandKey: string | null) {
    this.stands = this.stands.map((stand) => (stand.id === standId ? { ...stand, manualStandKey } : stand));
    return this.stands.find((stand) => stand.id === standId);
  }

  async listAbfItems(checkId: string) {
    const fileIds = this.importedFileIds(checkId);
    return this.abfItems.filter((item) => fileIds.has(item.fileId));
  }

  async listVendorItems(checkId: string, filter: Readonly<{ comparableOnly: boolean; standId?: string }>) {
    const fileIds = this.importedFileIds(checkId);
    return this.vendorItems.filter((item) => fileIds.has(item.fileId) && (!filter.standId || item.standId === filter.standId) && (!filter.comparableOnly || isComparableVendorRow(item)));
  }

  async listCatalogItems() { return this.catalogItems; }
  async listCatalogNames() { return this.catalogNames; }

  async insertCatalogName(input: Parameters<SettlementRepository["insertCatalogName"]>[0]) {
    const name: CatalogItemName = { id: this.id("name"), ...input, createdAt: this.now() };
    this.catalogNames.push(name);
    return name;
  }

  async deleteCatalogName(id: string) { this.catalogNames = this.catalogNames.filter((name) => name.id !== id); }

  async listMappings(realizationCompanyId: string) { return this.mappings.filter((mapping) => mapping.realizationCompanyId === realizationCompanyId); }

  async upsertMapping(input: Parameters<SettlementRepository["upsertMapping"]>[0]) {
    const existing = this.mappings.find((mapping) => mapping.realizationCompanyId === input.realizationCompanyId && mapping.normalizedText === input.normalizedText);
    const next: SettlementVendorMapping = { id: existing?.id ?? this.id("mapping"), ...input, updatedAt: this.now() };
    this.mappings = existing ? this.mappings.map((mapping) => (mapping.id === existing.id ? next : mapping)) : [...this.mappings, next];
    return next;
  }

  async insertMissingMappings(entries: Parameters<SettlementRepository["insertMissingMappings"]>[0]) {
    for (const entry of entries) {
      if (this.mappings.some((mapping) => mapping.realizationCompanyId === entry.realizationCompanyId && mapping.normalizedText === entry.normalizedText)) continue;
      this.mappings.push({ id: this.id("mapping"), ...entry, updatedAt: this.now() });
    }
  }

  async listRules(realizationCompanyId: string) { return this.rules.filter((rule) => rule.realizationCompanyId === realizationCompanyId); }
  async getRule(id: string) { return this.rules.find((rule) => rule.id === id); }

  async insertRule(input: Parameters<SettlementRepository["insertRule"]>[0]) {
    const now = this.now();
    const rule: SettlementRule = { id: this.id("rule"), ...input, status: "draft", verifiedAt: null, verifiedBy: null, createdAt: now, updatedAt: now };
    this.rules.push(rule);
    return rule;
  }

  async updateRule(id: string, patch: Parameters<SettlementRepository["updateRule"]>[1]) {
    const next = { ...this.rules.find((rule) => rule.id === id)!, ...patch, updatedAt: this.now() } as SettlementRule;
    this.rules = this.rules.map((rule) => (rule.id === id ? next : rule));
    return next;
  }

  async replaceResults(checkId: string, run: Parameters<SettlementRepository["replaceResults"]>[1]) {
    this.results.set(checkId, run.rows);
    this.standIndex.set(checkId, run.standIndex);
    const now = this.now();
    const next: SettlementCheck = { ...this.checks.find((check) => check.id === checkId)!, summary: run.summary, currentRunId: this.id("run"), lastComparedAt: now, updatedAt: now };
    this.checks = this.checks.map((check) => (check.id === checkId ? next : check));
    return next;
  }

  async listResults(checkId: string) { return this.results.get(checkId) ?? []; }
  async getStandIndex(checkId: string) { return this.standIndex.get(checkId) ?? []; }
  async listDecisions(checkId: string) { return this.decisions.filter((decision) => decision.checkId === checkId); }

  async upsertDecision(input: Parameters<SettlementRepository["upsertDecision"]>[0]) {
    const existing = this.decisions.find((decision) => decision.checkId === input.checkId && decision.standKey === input.standKey && decision.rowKey === input.rowKey);
    const next: SettlementDecision = { id: existing?.id ?? this.id("decision"), ...input, updatedAt: this.now() };
    this.decisions = existing ? this.decisions.map((decision) => (decision.id === existing.id ? next : decision)) : [...this.decisions, next];
    return next;
  }
}
