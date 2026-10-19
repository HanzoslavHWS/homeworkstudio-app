/**
 * Realizační firmy — identity rules (V1-DATA-02): name normalization, duplicate detection, stable
 * ids for manually created firms, alias bookkeeping and the old placeholder identifiers.
 *
 * Duplicate evidence of one real firm is the failure this module exists to prevent. Every firm owns
 * a set of IDENTITY KEYS (normalized working name, legal name, ABRA name and active aliases); a key
 * may belong to one firm only. The match is exact on the normalized form — never fuzzy, because a
 * fuzzy match silently merges two unrelated firms (decision A21: "Macík" and "MAC Praha" stay
 * separate until the user says otherwise).
 *
 * "Ostatní / neurčeno" is deliberately NOT a firm row: it is the absence of a firm (NULL
 * `realization_company_id`). A pseudo-firm row would be counted as a real contractor by settlement
 * checks, get production dimensions in the print-surface catalog, and could be deactivated by an
 * Excel sync. See UNSPECIFIED_REALIZATION_COMPANY_LABEL and resolveRealizationReference.
 */

import type {
  RealizationCompany,
  RealizationCompanyAlias,
  RealizationCompanyAliasInput,
  RealizationCompanyCardInput,
  RealizationCompanyContact,
  RealizationLegacyId,
} from "./realizationCompany.ts";

export const UNSPECIFIED_REALIZATION_COMPANY_LABEL = "Ostatní / neurčeno";

/** Never usable as a firm id: the old placeholders plus words that would read as "no firm". */
export const RESERVED_REALIZATION_COMPANY_IDS: readonly string[] = [
  "default",
  "realization-2",
  "realization-3",
  "realization-4",
  "ostatni",
  "neurceno",
  "ostatni-neurceno",
  "unspecified",
  "other",
];

/**
 * Strips diacritics, legal-form suffixes, punctuation and whitespace, so "CREATIV EXPO, s.r.o." and
 * "Creativ Expo" compare equal. Shared with domain/technicalRasterRealization.ts (same function,
 * moved here so both modules normalize identically).
 */
export function normalizeCompanyName(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/\bs\.?\s*r\.?\s*o\.?\b/gu, "")
    .replace(/\bspol\.?\b/gu, "")
    .replace(/[^a-z0-9]+/gu, "");
}

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

/** Slug for a manually created firm: "MAC Praha, spol. s r.o." → "mac-praha-spol-s-r-o". */
export function slugifyRealizationCompanyId(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

/** A new, never-reused id: the slug, or slug-2, slug-3… when taken by any firm (active or not) or reserved. */
export function createRealizationCompanyId(name: string, existingIds: Iterable<string>, legacyIds: Iterable<string> = []): string {
  const base = slugifyRealizationCompanyId(name) || "firma";
  const taken = new Set<string>([...existingIds, ...legacyIds, ...RESERVED_REALIZATION_COMPANY_IDS]);
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** IČO: digits only after removing spaces. Czech IČO has 8 digits; shorter historical ones are left-padded. */
export function normalizeIco(raw: string | undefined): string | undefined {
  const text = trimmed(raw)?.replace(/\s+/gu, "");
  if (!text) return undefined;
  return /^\d{1,8}$/u.test(text) ? text.padStart(8, "0") : text;
}

export function isValidIco(ico: string): boolean {
  return /^\d{8}$/u.test(ico);
}

/** DIČ: country prefix + 2–13 characters, uppercase, no spaces ("CZ12345678", "SK2020123456"). */
export function normalizeDic(raw: string | undefined): string | undefined {
  const text = trimmed(raw)?.replace(/\s+/gu, "").toUpperCase();
  return text || undefined;
}

export function isValidDic(dic: string): boolean {
  return /^[A-Z]{2}[0-9A-Z]{2,13}$/u.test(dic);
}

/** Every normalized name a firm is known under: working, legal and ABRA name plus its ACTIVE aliases. */
export function companyIdentityKeys(company: RealizationCompany, aliases: readonly RealizationCompanyAlias[]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const name of [company.name, company.legalName, company.abraName]) {
    const key = name ? normalizeCompanyName(name) : "";
    if (key) keys.add(key);
  }
  for (const alias of aliases) {
    if (alias.realizationCompanyId === company.id && alias.isActive && alias.normalizedAlias) keys.add(alias.normalizedAlias);
  }
  return keys;
}

export type CompanyNameMatch =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "one"; company: RealizationCompany }>
  | Readonly<{ kind: "ambiguous"; companies: readonly RealizationCompany[] }>;

/** Exact match on the normalized name against every firm's identity keys (inactive firms included — a deactivated firm is still the same firm). */
export function findCompanyByName(
  name: string,
  companies: readonly RealizationCompany[],
  aliases: readonly RealizationCompanyAlias[],
): CompanyNameMatch {
  const key = normalizeCompanyName(name);
  if (!key) return { kind: "none" };
  const matches = companies.filter((company) => companyIdentityKeys(company, aliases).has(key));
  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1) return { kind: "one", company: matches[0]! };
  return { kind: "ambiguous", companies: matches };
}

// ---------------------------------------------------------------------------
// card validation
// ---------------------------------------------------------------------------

export type RealizationCompanyIssueCode =
  | "EMPTY_NAME"
  | "INVALID_ICO"
  | "INVALID_DIC"
  | "DUPLICATE_ICO"
  | "NAME_CONFLICT"
  | "EMPTY_ALIAS"
  | "DUPLICATE_ALIAS"
  | "ALIAS_CONFLICT"
  | "UNKNOWN_ALIAS";

export type RealizationCompanyIssue = Readonly<{ code: RealizationCompanyIssueCode; message: string; conflictingCompanyId?: string }>;

export type ValidatedRealizationCompanyCard =
  | Readonly<{ ok: true; card: RealizationCompanyCardInput; aliases: readonly RealizationCompanyAliasInput[] }>
  | Readonly<{ ok: false; issues: readonly RealizationCompanyIssue[] }>;

function cleanContacts(contacts: readonly RealizationCompanyContact[] | undefined): readonly RealizationCompanyContact[] {
  return (contacts ?? [])
    .map((contact) => ({
      id: contact.id,
      name: trimmed(contact.name),
      role: trimmed(contact.role),
      email: trimmed(contact.email),
      phone: trimmed(contact.phone),
      note: trimmed(contact.note),
    }))
    .filter((contact) => contact.name || contact.role || contact.email || contact.phone || contact.note);
}

/**
 * Normalizes the card and checks it against every OTHER firm: working/legal/ABRA names and aliases
 * must not resolve to another firm's identity key, and IČO must be unique. `companyId` is the firm
 * being edited (undefined while creating).
 */
export function validateRealizationCompanyCard(
  input: RealizationCompanyCardInput,
  aliasInputs: readonly RealizationCompanyAliasInput[],
  context: Readonly<{ companyId?: string; companies: readonly RealizationCompany[]; aliases: readonly RealizationCompanyAlias[] }>,
): ValidatedRealizationCompanyCard {
  const issues: RealizationCompanyIssue[] = [];
  const name = trimmed(input.name);
  if (!name || !normalizeCompanyName(name)) issues.push({ code: "EMPTY_NAME", message: "Pracovní název firmy je povinný." });

  const ico = normalizeIco(input.ico);
  if (ico && !isValidIco(ico)) issues.push({ code: "INVALID_ICO", message: `IČO „${input.ico}“ musí mít 8 číslic.` });
  const dic = normalizeDic(input.dic);
  if (dic && !isValidDic(dic)) issues.push({ code: "INVALID_DIC", message: `DIČ „${input.dic}“ musí začínat kódem země (např. CZ12345678).` });

  const others = context.companies.filter((company) => company.id !== context.companyId);
  if (ico) {
    const sameIco = others.find((company) => normalizeIco(company.ico) === ico);
    if (sameIco) issues.push({ code: "DUPLICATE_ICO", message: `IČO ${ico} už má firma „${sameIco.name}“.`, conflictingCompanyId: sameIco.id });
  }

  const ownKeys = new Map<string, string>();
  for (const [label, value] of [["Pracovní název", name], ["Právní název", trimmed(input.legalName)], ["Název v ABRA", trimmed(input.abraName)]] as const) {
    const key = value ? normalizeCompanyName(value) : "";
    if (!key) continue;
    ownKeys.set(key, label);
    const match = findCompanyByName(value!, others, context.aliases);
    if (match.kind !== "none") {
      const conflict = match.kind === "one" ? match.company : match.companies[0]!;
      issues.push({ code: "NAME_CONFLICT", message: `${label} „${value}“ už patří firmě „${conflict.name}“.`, conflictingCompanyId: conflict.id });
    }
  }

  const aliases: RealizationCompanyAliasInput[] = [];
  const seenAliasKeys = new Set<string>();
  const ownAliasIds = new Set(context.aliases.filter((alias) => alias.realizationCompanyId === context.companyId).map((alias) => alias.id));
  for (const aliasInput of aliasInputs) {
    const alias = trimmed(aliasInput.alias);
    const key = alias ? normalizeCompanyName(alias) : "";
    if (aliasInput.id && !ownAliasIds.has(aliasInput.id)) {
      issues.push({ code: "UNKNOWN_ALIAS", message: `Alternativní název „${aliasInput.alias}“ nepatří této firmě.` });
      continue;
    }
    if (!key) {
      issues.push({ code: "EMPTY_ALIAS", message: "Alternativní název nesmí být prázdný." });
      continue;
    }
    if (seenAliasKeys.has(key)) {
      issues.push({ code: "DUPLICATE_ALIAS", message: `Alternativní název „${alias}“ je na kartě dvakrát.` });
      continue;
    }
    seenAliasKeys.add(key);
    const match = findCompanyByName(alias!, others, context.aliases);
    if (match.kind !== "none") {
      const conflict = match.kind === "one" ? match.company : match.companies[0]!;
      issues.push({ code: "ALIAS_CONFLICT", message: `Alternativní název „${alias}“ už patří firmě „${conflict.name}“.`, conflictingCompanyId: conflict.id });
      continue;
    }
    aliases.push({ id: aliasInput.id, alias: alias!, kind: aliasInput.kind, note: trimmed(aliasInput.note) });
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    card: {
      name: name!,
      legalName: trimmed(input.legalName),
      abraName: trimmed(input.abraName),
      ico,
      dic,
      contacts: cleanContacts(input.contacts),
      note: trimmed(input.note),
      isActive: input.isActive,
    },
    aliases,
  };
}

/**
 * Turns the alias list submitted with a card into inserts and deactivations. An existing alias kept
 * on the card stays as is; one removed from the card is deactivated (never deleted); an edited text
 * becomes a deactivation of the old row plus a new row, so the old spelling remains on record.
 */
export function planAliasChanges(
  companyId: string,
  submitted: readonly RealizationCompanyAliasInput[],
  existing: readonly RealizationCompanyAlias[],
): Readonly<{ insert: readonly Omit<RealizationCompanyAlias, "id">[]; deactivateIds: readonly string[] }> {
  const current = existing.filter((alias) => alias.realizationCompanyId === companyId && alias.isActive);
  const keptIds = new Set<string>();
  const insert: Omit<RealizationCompanyAlias, "id">[] = [];
  for (const alias of submitted) {
    const previous = alias.id ? current.find((row) => row.id === alias.id) : undefined;
    if (previous && previous.alias === alias.alias && previous.kind === alias.kind && (previous.note ?? undefined) === (alias.note ?? undefined)) {
      keptIds.add(previous.id);
      continue;
    }
    insert.push({ realizationCompanyId: companyId, alias: alias.alias, normalizedAlias: normalizeCompanyName(alias.alias), kind: alias.kind, note: alias.note, isActive: true });
  }
  const deactivateIds = current.filter((row) => !keptIds.has(row.id)).map((row) => row.id);
  return { insert, deactivateIds };
}

// ---------------------------------------------------------------------------
// references (projects, events, price lists, production profiles)
// ---------------------------------------------------------------------------

export type RealizationReference =
  | Readonly<{ kind: "unspecified" }>
  | Readonly<{ kind: "company"; company: RealizationCompany; viaLegacyId?: string }>
  | Readonly<{ kind: "system_no_override"; legacyId: string }>
  | Readonly<{ kind: "unresolved_legacy"; legacyId: string }>
  | Readonly<{ kind: "unknown"; id: string }>;

/**
 * What a stored realization id means. Read-only: it never rewrites the stored value, so project
 * documents keep `default` / `realization-N` untouched and production-size lookups (which still use
 * the raw id as a `productionProfiles` key) behave exactly as before.
 */
export function resolveRealizationReference(
  id: string | undefined | null,
  companies: readonly RealizationCompany[],
  legacyIds: readonly RealizationLegacyId[],
): RealizationReference {
  const value = id?.trim();
  if (!value) return { kind: "unspecified" };
  const company = companies.find((candidate) => candidate.id === value);
  if (company) return { kind: "company", company };
  const legacy = legacyIds.find((candidate) => candidate.legacyId === value);
  if (legacy?.kind === "system_no_override") return { kind: "system_no_override", legacyId: value };
  if (legacy?.kind === "mapped" && legacy.realizationCompanyId) {
    const mapped = companies.find((candidate) => candidate.id === legacy.realizationCompanyId);
    if (mapped) return { kind: "company", company: mapped, viaLegacyId: value };
  }
  if (legacy) return { kind: "unresolved_legacy", legacyId: value };
  return { kind: "unknown", id: value };
}

export function realizationReferenceLabel(reference: RealizationReference): string {
  switch (reference.kind) {
    case "unspecified":
      return UNSPECIFIED_REALIZATION_COMPANY_LABEL;
    case "company":
      return reference.company.isActive ? reference.company.name : `${reference.company.name} (neaktivní)`;
    case "system_no_override":
      return "Bez přepisu výrobních rozměrů (systémový režim)";
    case "unresolved_legacy":
      return `Nevyřešený historický identifikátor ${reference.legacyId}`;
    case "unknown":
      return `Neznámá firma (${reference.id})`;
  }
}
