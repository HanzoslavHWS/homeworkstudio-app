/**
 * Aliases of catalog items (V1-DATA-03) — the one place for alternative names and codes of a
 * component (`catalog_item_aliases`). Pure, no I/O.
 *
 * An alias is either GENERAL (realizationCompanyId undefined, e.g. another wording of the ABF name)
 * or belongs to ONE realization company from the V1-DATA-02 register (the name or code that firm
 * prints on its bills). Identity of an alias: (company or general, kind, normalized text) — so the
 * same text can lead to different items at different companies, but never to two items at the same
 * company. One item may have any number of names and codes per company.
 *
 * Aliases are deactivated, never deleted (DB trigger). The settlement check reads company name
 * aliases as confirmed vendor mappings (domain/settlementService.ts).
 */

import { normalizeSettlementText } from "./settlementCheck.ts";
import { catalogUnitByCode } from "./catalogUnits.ts";

export type CatalogItemAliasKind = "name" | "code";
export const CATALOG_ITEM_ALIAS_KINDS: readonly CatalogItemAliasKind[] = ["name", "code"];
export type CatalogItemAliasSource = "manual" | "import" | "settlement" | "abf";
export type CatalogItemAliasStatus = "suggested" | "confirmed";

export type CatalogItemAlias = Readonly<{
  id: string;
  catalogItemId: string;
  /** undefined = general alias. */
  realizationCompanyId?: string;
  aliasKind: CatalogItemAliasKind;
  aliasText: string;
  normalizedText: string;
  /** Unit the company bills the item in, when it differs from the card. */
  unitCode?: string;
  source: CatalogItemAliasSource;
  status: CatalogItemAliasStatus;
  note?: string;
  isActive: boolean;
}>;

export type CatalogItemAliasInput = Readonly<{
  /** Present for an existing alias kept on the card. */
  id?: string;
  realizationCompanyId?: string;
  aliasKind: CatalogItemAliasKind;
  aliasText: string;
  unitCode?: string;
  note?: string;
}>;

export const CATALOG_ALIAS_TEXT_MAX = 300;

/** Names: lower-case, no diacritics, single spaces (the settlement comparison key). Codes: upper-case, no whitespace. */
export function normalizeCatalogAliasText(kind: CatalogItemAliasKind, text: string): string {
  if (kind === "code") return text.normalize("NFKC").replace(/\s+/gu, "").toLocaleUpperCase("cs");
  return normalizeSettlementText(text);
}

export function aliasIdentityKey(alias: Pick<CatalogItemAlias, "realizationCompanyId" | "aliasKind" | "normalizedText">): string {
  return `${alias.realizationCompanyId ?? ""}\u0000${alias.aliasKind}\u0000${alias.normalizedText}`;
}

export type CatalogAliasIssue = Readonly<{ index: number; code: "EMPTY" | "TOO_LONG" | "INVALID_CHARACTERS" | "UNKNOWN_COMPANY" | "UNKNOWN_UNIT" | "DUPLICATE_ON_CARD" | "TAKEN" | "UNKNOWN_ALIAS"; message: string; conflictingItemId?: string }>;

export class InvalidCatalogAliasesError extends Error {
  readonly issues: readonly CatalogAliasIssue[];
  constructor(issues: readonly CatalogAliasIssue[]) {
    super(issues[0]?.message ?? "Neplatné aliasy.");
    this.name = "InvalidCatalogAliasesError";
    this.issues = issues;
  }
}

/** Whitelists a raw JSON body into alias inputs (unknown keys dropped). */
export function parseCatalogItemAliasInputs(raw: unknown): readonly CatalogItemAliasInput[] {
  if (!Array.isArray(raw)) throw new InvalidCatalogAliasesError([{ index: -1, code: "EMPTY", message: "Chybí seznam aliasů." }]);
  return raw.map((entry) => {
    const value = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const text = (key: string) => (typeof value[key] === "string" && (value[key] as string).trim() ? (value[key] as string).trim() : undefined);
    return {
      id: text("id"),
      realizationCompanyId: text("realizationCompanyId"),
      aliasKind: value.aliasKind === "code" ? "code" : "name",
      aliasText: typeof value.aliasText === "string" ? value.aliasText.replace(/\s+/gu, " ").trim() : "",
      unitCode: text("unitCode"),
      note: text("note")?.slice(0, 500),
    };
  });
}

/**
 * Validates the complete alias list of ONE item against every other active alias in the catalog.
 * Blank input lines are reported (the UI never sends them); a text already used by another item
 * for the same company (or among general aliases) is a conflict — never silently reassigned.
 */
export function validateCatalogItemAliases(
  catalogItemId: string,
  inputs: readonly CatalogItemAliasInput[],
  context: Readonly<{ aliases: readonly CatalogItemAlias[]; companyIds: ReadonlySet<string>; itemNameById?: ReadonlyMap<string, string> }>,
): readonly CatalogAliasIssue[] {
  const issues: CatalogAliasIssue[] = [];
  const ownIds = new Set(context.aliases.filter((alias) => alias.catalogItemId === catalogItemId).map((alias) => alias.id));
  const others = new Map(
    context.aliases.filter((alias) => alias.isActive && alias.catalogItemId !== catalogItemId).map((alias) => [aliasIdentityKey(alias), alias] as const),
  );
  const seen = new Set<string>();
  inputs.forEach((input, index) => {
    const label = input.aliasKind === "code" ? "Kód" : "Název";
    if (input.id && !ownIds.has(input.id)) return void issues.push({ index, code: "UNKNOWN_ALIAS", message: "Alias nepatří této položce." });
    if (!input.aliasText) return void issues.push({ index, code: "EMPTY", message: `${label} aliasu nesmí být prázdný.` });
    if (input.aliasText.length > CATALOG_ALIAS_TEXT_MAX) return void issues.push({ index, code: "TOO_LONG", message: `${label} „${input.aliasText.slice(0, 40)}…“ je příliš dlouhý.` });
    if (/[<>]/u.test(input.aliasText) || (input.aliasKind === "code" && /["']/u.test(input.aliasText))) {
      return void issues.push({ index, code: "INVALID_CHARACTERS", message: `${label} „${input.aliasText}“ obsahuje nepovolené znaky.` });
    }
    if (input.realizationCompanyId && !context.companyIds.has(input.realizationCompanyId)) {
      return void issues.push({ index, code: "UNKNOWN_COMPANY", message: `Realizační firma ${input.realizationCompanyId} neexistuje.` });
    }
    if (input.unitCode && !catalogUnitByCode(input.unitCode)) return void issues.push({ index, code: "UNKNOWN_UNIT", message: `Jednotka ${input.unitCode} není v číselníku.` });
    const normalizedText = normalizeCatalogAliasText(input.aliasKind, input.aliasText);
    if (!normalizedText) return void issues.push({ index, code: "EMPTY", message: `${label} aliasu nesmí být prázdný.` });
    const key = aliasIdentityKey({ realizationCompanyId: input.realizationCompanyId, aliasKind: input.aliasKind, normalizedText });
    if (seen.has(key)) return void issues.push({ index, code: "DUPLICATE_ON_CARD", message: `${label} „${input.aliasText}“ je na kartě dvakrát pro stejnou firmu.` });
    seen.add(key);
    const taken = others.get(key);
    if (taken) {
      const owner = context.itemNameById?.get(taken.catalogItemId) ?? taken.catalogItemId;
      const scope = input.realizationCompanyId ? "u této realizačky" : "mezi obecnými aliasy";
      issues.push({ index, code: "TAKEN", message: `${label} „${input.aliasText}“ už ${scope} patří položce „${owner}“.`, conflictingItemId: taken.catalogItemId });
    }
  });
  return issues;
}

/**
 * Turns the submitted alias list into inserts and deactivations. A kept alias with identical
 * content stays untouched; an edited one is deactivated and re-inserted (the old spelling stays on
 * record); one missing from the list is deactivated. Nothing is deleted.
 */
export function planCatalogItemAliasChanges(
  catalogItemId: string,
  submitted: readonly CatalogItemAliasInput[],
  existing: readonly CatalogItemAlias[],
): Readonly<{ insert: readonly Omit<CatalogItemAlias, "id">[]; deactivateIds: readonly string[] }> {
  const current = existing.filter((alias) => alias.catalogItemId === catalogItemId && alias.isActive);
  const kept = new Set<string>();
  const insert: Omit<CatalogItemAlias, "id">[] = [];
  for (const input of submitted) {
    const previous = input.id ? current.find((alias) => alias.id === input.id) : undefined;
    const unchanged = previous
      && previous.aliasText === input.aliasText
      && previous.aliasKind === input.aliasKind
      && (previous.realizationCompanyId ?? undefined) === (input.realizationCompanyId ?? undefined)
      && (previous.unitCode ?? undefined) === (input.unitCode ?? undefined)
      && (previous.note ?? undefined) === (input.note ?? undefined);
    if (unchanged) {
      kept.add(previous.id);
      continue;
    }
    insert.push({
      catalogItemId,
      realizationCompanyId: input.realizationCompanyId,
      aliasKind: input.aliasKind,
      aliasText: input.aliasText,
      normalizedText: normalizeCatalogAliasText(input.aliasKind, input.aliasText),
      unitCode: input.unitCode,
      source: previous?.source ?? "manual",
      status: "confirmed",
      note: input.note,
      isActive: true,
    });
  }
  return { insert, deactivateIds: current.filter((alias) => !kept.has(alias.id)).map((alias) => alias.id) };
}

/** Active confirmed name aliases of one company — what the settlement comparison may use for that company. */
export function companyNameAliases(aliases: readonly CatalogItemAlias[], realizationCompanyId: string): readonly CatalogItemAlias[] {
  return aliases.filter((alias) => alias.isActive && alias.status === "confirmed" && alias.aliasKind === "name" && alias.realizationCompanyId === realizationCompanyId);
}
