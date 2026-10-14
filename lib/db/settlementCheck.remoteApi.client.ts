"use client";

import type { RealizationCompany } from "../../domain/realizationCompany.ts";
import type { PdfTextItem } from "../../domain/technicalReportTableParsing.ts";
import type {
  CatalogItemName,
  CatalogNameType,
  SettlementCatalogItem,
  SettlementCheck,
  SettlementCheckStatus,
  SettlementDecision,
  SettlementDecisionValue,
  SettlementFileFormat,
  SettlementImportFile,
  SettlementMappingStatus,
  SettlementParser,
  SettlementSide,
  SettlementVendorItem,
  SettlementVendorMapping,
} from "../../domain/settlementCheck.ts";
import type { SettlementRule, SettlementRuleInput, SettlementRuleStatus } from "../../domain/settlementRules.ts";
import type { SettlementCheckDetail } from "../../domain/settlementService.ts";

/** A failed call. `code`/`details` are set for a 409 the user can resolve (e.g. `same_name_file`). */
export class SettlementApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly details: unknown;

  constructor(status: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.name = "SettlementApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function parseResponse<T>(response: Response, fallbackMessage: string): Promise<T> {
  if (response.ok) return (await response.json()) as T;
  let body: { error?: string; code?: string; details?: unknown } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // response body wasn't JSON — keep the fallback message
  }
  throw new SettlementApiError(response.status, body.error || fallbackMessage, body.code, body.details);
}

async function postJson<T>(url: string, body: unknown, fallbackMessage: string): Promise<T> {
  return parseResponse<T>(await fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), fallbackMessage);
}

async function getJson<T>(url: string, fallbackMessage: string): Promise<T> {
  return parseResponse<T>(await fetch(url, { method: "GET", credentials: "same-origin" }), fallbackMessage);
}

export type SettlementListResponse = Readonly<{
  checks: readonly SettlementCheck[];
  companies: readonly RealizationCompany[];
  vendorParsers: readonly Readonly<{ id: SettlementParser; label: string; formats: readonly SettlementFileFormat[] }>[];
}>;

export type SettlementDictionary = Readonly<{
  catalogItems: readonly SettlementCatalogItem[];
  catalogNames: readonly CatalogItemName[];
  mappings: readonly SettlementVendorMapping[];
}>;

/** Browser-side client for app/api/settlement-checks/*. Every write is validated again on the server (domain/settlementService.ts). */
export class RemoteApiSettlementClient {
  list(): Promise<SettlementListResponse> {
    return getJson("/api/settlement-checks/list", "Kontroly vyúčtování se nepodařilo načíst.");
  }

  async create(input: Readonly<{ eventId: string; realizationCompanyId: string; note?: string; actorName?: string }>): Promise<SettlementCheck> {
    return (await postJson<{ check: SettlementCheck }>("/api/settlement-checks/create", input, "Kontrolu se nepodařilo vytvořit.")).check;
  }

  get(id: string): Promise<SettlementCheckDetail> {
    return getJson(`/api/settlement-checks/get?id=${encodeURIComponent(id)}`, "Kontrolu se nepodařilo načíst.");
  }

  async update(id: string, patch: Readonly<{ status?: SettlementCheckStatus; note?: string }>): Promise<SettlementCheck> {
    return (await postJson<{ check: SettlementCheck }>("/api/settlement-checks/update", { id, ...patch }, "Kontrolu se nepodařilo uložit.")).check;
  }

  async delete(id: string): Promise<void> {
    await postJson("/api/settlement-checks/delete", { id }, "Kontrolu se nepodařilo smazat.");
  }

  async recompute(id: string): Promise<void> {
    await postJson("/api/settlement-checks/recompute", { id }, "Porovnání se nepodařilo přepočítat.");
  }

  async importFile(input: Readonly<{ checkId: string; side: SettlementSide; file: File; mode?: "replace" | "add"; parser?: SettlementParser; pdfTextItems?: readonly PdfTextItem[]; actorName?: string }>): Promise<SettlementImportFile> {
    const form = new FormData();
    form.set("file", input.file);
    form.set("checkId", input.checkId);
    form.set("side", input.side);
    if (input.mode) form.set("mode", input.mode);
    if (input.parser) form.set("parser", input.parser);
    if (input.pdfTextItems) form.set("pdfTextItems", JSON.stringify(input.pdfTextItems));
    if (input.actorName) form.set("actorName", input.actorName);
    const response = await fetch("/api/settlement-checks/import", { method: "POST", credentials: "same-origin", body: form });
    return (await parseResponse<{ file: SettlementImportFile }>(response, "Soubor se nepodařilo naimportovat.")).file;
  }

  async deleteFile(checkId: string, fileId: string): Promise<void> {
    await postJson("/api/settlement-checks/files/delete", { checkId, fileId }, "Soubor se nepodařilo odebrat.");
  }

  async sourceRows(checkId: string, standId: string): Promise<readonly SettlementVendorItem[]> {
    return (await getJson<{ rows: readonly SettlementVendorItem[] }>(`/api/settlement-checks/source-rows?checkId=${encodeURIComponent(checkId)}&standId=${encodeURIComponent(standId)}`, "Původní řádky se nepodařilo načíst.")).rows;
  }

  async saveDecision(input: Readonly<{ checkId: string; standKey: string; rowKey: string; decision: SettlementDecisionValue | null; note: string; actorName?: string }>): Promise<SettlementDecision> {
    return (await postJson<{ decision: SettlementDecision }>("/api/settlement-checks/decisions", { kind: "row", ...input }, "Rozhodnutí se nepodařilo uložit.")).decision;
  }

  async assignStand(checkId: string, standId: string, standNumber: string): Promise<void> {
    await postJson("/api/settlement-checks/decisions", { kind: "assignStand", checkId, standId, standNumber }, "Přiřazení ke stánku se nepodařilo uložit.");
  }

  dictionary(companyId: string): Promise<SettlementDictionary> {
    return getJson(`/api/settlement-checks/dictionary?companyId=${encodeURIComponent(companyId)}`, "Slovník názvů se nepodařilo načíst.");
  }

  async saveMapping(input: Readonly<{ realizationCompanyId: string; sourceText: string; catalogItemId: string | null; unit: string | null; status: SettlementMappingStatus; recomputeCheckId?: string }>): Promise<SettlementVendorMapping> {
    return (await postJson<{ mapping: SettlementVendorMapping }>("/api/settlement-checks/dictionary", { action: "saveMapping", ...input }, "Mapování se nepodařilo uložit.")).mapping;
  }

  async addCatalogName(input: Readonly<{ catalogItemId: string; nameType: CatalogNameType; name: string; recomputeCheckId?: string }>): Promise<CatalogItemName> {
    return (await postJson<{ name: CatalogItemName }>("/api/settlement-checks/dictionary", { action: "addName", ...input }, "Název se nepodařilo uložit.")).name;
  }

  async deleteCatalogName(id: string, recomputeCheckId?: string): Promise<void> {
    await postJson("/api/settlement-checks/dictionary", { action: "deleteName", id, recomputeCheckId }, "Název se nepodařilo odebrat.");
  }

  async rules(companyId: string): Promise<readonly SettlementRule[]> {
    return (await getJson<{ rules: readonly SettlementRule[] }>(`/api/settlement-checks/rules?companyId=${encodeURIComponent(companyId)}`, "Pravidla se nepodařilo načíst.")).rules;
  }

  async createRule(input: Readonly<{ realizationCompanyId: string; rule: SettlementRuleInput; activate?: boolean; actorName?: string; recomputeCheckId?: string }>): Promise<SettlementRule> {
    return (await postJson<{ rule: SettlementRule }>("/api/settlement-checks/rules", { action: "create", ...input }, "Pravidlo se nepodařilo uložit.")).rule;
  }

  async setRuleStatus(input: Readonly<{ id: string; status: SettlementRuleStatus; actorName?: string; recomputeCheckId?: string }>): Promise<SettlementRule> {
    return (await postJson<{ rule: SettlementRule }>("/api/settlement-checks/rules", { action: "setStatus", ...input }, "Stav pravidla se nepodařilo změnit.")).rule;
  }
}
