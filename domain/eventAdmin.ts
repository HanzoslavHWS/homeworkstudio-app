/**
 * Event administration (V1-DATA-06). Pure, no I/O. Mirror of
 * supabase/migrations/20261022150000_events_admin.sql.
 *
 *   - ONE list of realization firms per event (real register from V1-DATA-02) with at most one
 *     default. The firm realizing a stand also does its graphics and in-stand electrical work (the
 *     main power supply belongs to the venue), so there are no roles. The default is only a
 *     suggestion (a new task is pre-filled with it); it never re-assigns stands or confirmed tasks.
 *   - The legacy Exhibition.realizationCompanyId ('default', 'realization-2..4') is kept untouched for
 *     the old price calculations and shown separately; 'default' means "not specified" (A2) and is
 *     never mapped to a firm automatically.
 *   - Optional stable short code (BEAUTY-2026-P), separate from the name and from disk paths.
 *   - Deadlines keep their free-form shape and gain an optional kind and audience; every deadline
 *     has a stable reference for future automatic tasks (not implemented here).
 *   - Folder paths (Organizer spec section 1): an event root plus subfolders, either the approved
 *     HomeworkStudio standard (00_DOKUMENTY … 08_VYUCTOVANI) or custom values (relative, absolute,
 *     UNC; an empty subfolder = the root itself). Metadata only; nothing here touches a file system.
 */
import type { EventDeadline, Exhibition } from "./organizations.ts";

// ============================================================================
// Realization firms (one list per event)
// ============================================================================

/** One firm of the event's list. Stored with role 'construction' (see migration 20261022160000). */
export type EventRealizationLink = Readonly<{
  realizationCompanyId: string;
  isDefault: boolean;
  note?: string;
}>;

export type RealizationCompanyOption = Readonly<{ id: string; name: string; isActive: boolean }>;

/** Problems of the list; errors block saving, warnings do not. */
export function validateRealizationLinks(
  links: readonly EventRealizationLink[],
  companies: readonly RealizationCompanyOption[],
): Readonly<{ errors: readonly string[]; warnings: readonly string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const companyById = new Map(companies.map((company) => [company.id, company]));
  const seen = new Set<string>();
  for (const link of links) {
    const company = companyById.get(link.realizationCompanyId);
    if (!company) errors.push(`Firma „${link.realizationCompanyId}“ není v evidenci realizačních firem.`);
    else if (!company.isActive) warnings.push(`Firma ${company.name} je v evidenci neaktivní.`);
    if (seen.has(link.realizationCompanyId)) errors.push(`Firma ${company?.name ?? link.realizationCompanyId} je v seznamu dvakrát.`);
    seen.add(link.realizationCompanyId);
  }
  if (links.filter((link) => link.isDefault).length > 1) errors.push("Výchozí smí být jen jedna realizačka.");
  return { errors, warnings };
}

/** The suggested firm (e.g. to pre-fill a new task). Undefined = no default set. */
export function defaultRealizationCompany(links: readonly EventRealizationLink[]): string | undefined {
  return links.find((link) => link.isDefault)?.realizationCompanyId;
}

/**
 * Pre-filled firm of a NEW task created from a booth project: the event's default firm, otherwise the
 * legacy event value when it is a real firm. Never applied to an existing task.
 */
export function suggestedTaskRealizationCompany(
  links: readonly EventRealizationLink[],
  legacyRealizationCompanyId: string | undefined,
  companies: readonly Pick<RealizationCompanyOption, "id">[],
): string | undefined {
  const fromList = defaultRealizationCompany(links);
  if (fromList) return fromList;
  return legacyRealizationCompanyId && companies.some((company) => company.id === legacyRealizationCompanyId) ? legacyRealizationCompanyId : undefined;
}

const LEGACY_PLACEHOLDER_LABELS: Readonly<Record<string, string>> = {
  default: "Neurčeno (historická hodnota „default“)",
  "realization-2": "Nepřiřazeno (zástupná hodnota „realization-2“)",
  "realization-3": "Nepřiřazeno (zástupná hodnota „realization-3“)",
  "realization-4": "Nepřiřazeno (zástupná hodnota „realization-4“)",
};

/** Read-only label of the legacy field — never translated into a real firm. */
export function legacyRealizationLabel(legacyId: string | undefined, companies: readonly RealizationCompanyOption[]): string {
  if (!legacyId) return "Nevyplněno";
  return LEGACY_PLACEHOLDER_LABELS[legacyId] ?? companies.find((company) => company.id === legacyId)?.name ?? `Neznámá hodnota „${legacyId}“`;
}

// ============================================================================
// Short code
// ============================================================================

export const EVENT_SHORT_CODE_PATTERN = /^[A-Z0-9]+(-[A-Z0-9]+)*$/u;
export const EVENT_SHORT_CODE_EXAMPLE = "BEAUTY-2026-P";

/** Upper-case, trimmed; empty -> undefined. */
export function normalizeEventShortCode(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toUpperCase();
  return value || undefined;
}

export function eventShortCodeIssue(code: string | undefined): string | undefined {
  if (!code) return undefined;
  if (code.length > 32) return "Kód veletrhu může mít nejvýš 32 znaků.";
  if (!EVENT_SHORT_CODE_PATTERN.test(code)) return `Kód smí obsahovat jen velká písmena bez diakritiky, číslice a pomlčky mezi nimi, např. ${EVENT_SHORT_CODE_EXAMPLE}.`;
  return undefined;
}

/** A saved code is fixed: it may only be set once. */
export function eventShortCodeChangeIssue(savedCode: string | undefined, nextCode: string | undefined): string | undefined {
  if (savedCode && nextCode !== savedCode) return `Kód veletrhu ${savedCode} je po uložení neměnný. Změna je možná jen řízeným postupem.`;
  return undefined;
}

// ============================================================================
// Deadlines
// ============================================================================

export const EVENT_DEADLINE_KINDS = ["orders", "design", "graphics", "technical", "other"] as const;
export type EventDeadlineKind = (typeof EVENT_DEADLINE_KINDS)[number];

export const EVENT_DEADLINE_KIND_LABELS_CS: Readonly<Record<EventDeadlineKind, string>> = {
  orders: "Objednávky",
  design: "Návrhy / schválení",
  graphics: "Grafika",
  technical: "Elektro / technické služby",
  other: "Ostatní",
};

export const EVENT_DEADLINE_AUDIENCES = ["internal", "customer"] as const;
export type EventDeadlineAudience = (typeof EVENT_DEADLINE_AUDIENCES)[number];

export const EVENT_DEADLINE_AUDIENCE_LABELS_CS: Readonly<Record<EventDeadlineAudience, string>> = {
  internal: "Interní",
  customer: "Zákaznická",
};

/**
 * One deadline of an event with a stable reference. `ref` is what future automatic tasks will link to:
 * builtin:materialData, builtin:designApproval, deadline:<id> (same keys as domain/taskCalendar.ts).
 */
export type EventDeadlineEntry = Readonly<{
  ref: string;
  name: string;
  date: string;
  kind?: EventDeadlineKind;
  audience?: EventDeadlineAudience;
  builtIn: boolean;
}>;

export function eventDeadlineEntries(event: Pick<Exhibition, "materialDataDeadline" | "designApprovalDeadline" | "deadlines">): readonly EventDeadlineEntry[] {
  const entries: EventDeadlineEntry[] = [];
  if (event.materialDataDeadline) entries.push({ ref: "builtin:materialData", name: "Dodání materiálů / dat", date: event.materialDataDeadline, kind: "graphics", audience: "customer", builtIn: true });
  if (event.designApprovalDeadline) entries.push({ ref: "builtin:designApproval", name: "Odsouhlasení návrhu stavby", date: event.designApprovalDeadline, kind: "design", audience: "customer", builtIn: true });
  for (const deadline of event.deadlines ?? []) {
    if (!deadline.date) continue;
    entries.push({ ref: `deadline:${deadline.id}`, name: deadline.name.trim() || "Deadline", date: deadline.date, ...(deadline.kind ? { kind: deadline.kind } : {}), ...(deadline.audience ? { audience: deadline.audience } : {}), builtIn: false });
  }
  return entries.sort((a, b) => a.date.localeCompare(b.date));
}

/** Keeps unknown kinds/audiences out of stored documents (older or hand-edited data stays readable). */
export function normalizeEventDeadline(deadline: Partial<EventDeadline> & Pick<EventDeadline, "id">): EventDeadline {
  const kind = (EVENT_DEADLINE_KINDS as readonly string[]).includes(deadline.kind ?? "") ? deadline.kind : undefined;
  const audience = (EVENT_DEADLINE_AUDIENCES as readonly string[]).includes(deadline.audience ?? "") ? deadline.audience : undefined;
  return { id: deadline.id, name: deadline.name ?? "", date: deadline.date ?? "", ...(kind ? { kind } : {}), ...(audience ? { audience } : {}) };
}

/** Order of the event dates (assembly ≤ from ≤ to ≤ disassembly) — a warning only. */
export function eventDateWarnings(event: Pick<Exhibition, "assemblyDate" | "eventFrom" | "eventTo" | "disassemblyDate">): readonly string[] {
  const sequence: [string, string | undefined][] = [["Montáž", event.assemblyDate], ["Začátek", event.eventFrom], ["Konec", event.eventTo], ["Demontáž", event.disassemblyDate]];
  const warnings: string[] = [];
  const filled = sequence.filter((entry): entry is [string, string] => Boolean(entry[1]));
  for (let index = 1; index < filled.length; index += 1) {
    const [previousLabel, previous] = filled[index - 1]!;
    const [label, value] = filled[index]!;
    if (value < previous) warnings.push(`${label} (${value}) je dříve než ${previousLabel.toLocaleLowerCase("cs")} (${previous}).`);
  }
  return warnings;
}

// ============================================================================
// Folder paths (Organizer spec section 1)
// ============================================================================

/** Event root first, then the subfolders in the order of the HomeworkStudio standard. */
export const EVENT_PATH_ROLES = [
  "event_root",
  "documents",
  "working_stands",
  "event_graphics",
  "contractor_outputs",
  "technical_rasters",
  "event_carpet",
  "abra_imports",
  "issued_orders",
  "settlements",
] as const;
export type EventPathRole = (typeof EVENT_PATH_ROLES)[number];
export type EventSubfolderRole = Exclude<EventPathRole, "event_root">;
export const EVENT_SUBFOLDER_ROLES = EVENT_PATH_ROLES.filter((role): role is EventSubfolderRole => role !== "event_root");

export const EVENT_PATH_ROLE_LABELS_CS: Readonly<Record<EventPathRole, string>> = {
  event_root: "Kořenová složka veletrhu",
  documents: "Dokumenty",
  working_stands: "Stavby / pracovní projekty",
  event_graphics: "Grafika akce",
  contractor_outputs: "Podklady realizačkám",
  technical_rasters: "Rastry",
  event_carpet: "Koberce akce",
  abra_imports: "Sjetiny ABRA",
  issued_orders: "Vydané objednávky",
  settlements: "Vyúčtování",
};

/** Approved HomeworkStudio folder standard (2026-10-22) — relative to the event root. */
export const STANDARD_EVENT_FOLDERS: Readonly<Record<EventSubfolderRole, string>> = {
  documents: "00_DOKUMENTY",
  working_stands: "01_STAVBY",
  event_graphics: "02_GRAFIKA_AKCE",
  contractor_outputs: "03_PODKLADY_REALIZACEK",
  technical_rasters: "04_RASTRY",
  event_carpet: "05_KOBERCE_AKCE",
  abra_imports: "06_SJETINY",
  issued_orders: "07_VYDANA_OBJEDNAVKA",
  settlements: "08_VYUCTOVANI",
};

export type EventPathMode = "standard" | "custom";

export const EVENT_PATH_MODE_LABELS_CS: Readonly<Record<EventPathMode, string>> = {
  standard: "Standard HomeworkStudio",
  custom: "Vlastní nastavení",
};

export type EventPathMapping = Readonly<{ role: EventPathRole; path: string; note?: string }>;

// Plain object members (not Readonly<…>) so narrowing on `ok` works — see lib/db/eventIdValidation.server.ts.
export type ParsedEventPath =
  | { readonly ok: true; readonly kind: "drive" | "unc" | "relative"; readonly path: string }
  | { readonly ok: false; readonly message: string };

const WINDOWS_FORBIDDEN = /[<>:"|?*\u0000-\u001f]/u;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/iu;

/**
 * Normalizes and checks one configured path. Accepts P:\…, \\server\share\… and relative paths
 * (also with forward slashes). Existing names (spaces, diacritics, 301-Technická realizace) are kept
 * exactly; only separators are unified and trailing separators dropped. Refuses .., Windows-forbidden
 * characters, reserved device names and segments ending with a space or a dot.
 */
export function parseEventPath(raw: string): ParsedEventPath {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, message: "Cesta je prázdná." };
  if (trimmed.length > 1024) return { ok: false, message: "Cesta je delší než 1024 znaků." };
  if (trimmed.includes("..")) return { ok: false, message: "Cesta nesmí obsahovat „..“." };
  let unified = trimmed.replace(/\//gu, "\\");
  let kind: "drive" | "unc" | "relative";
  let prefix = "";
  let rest: string;
  const drive = /^([a-zA-Z]):(\\|$)/u.exec(unified);
  if (unified.startsWith("\\\\")) {
    kind = "unc";
    rest = unified.slice(2);
    prefix = "\\\\";
    const parts = rest.split("\\").filter(Boolean);
    if (parts.length < 2) return { ok: false, message: "Síťová cesta musí mít tvar \\\\server\\sdílení\\…" };
  } else if (drive) {
    kind = "drive";
    prefix = `${drive[1]!.toUpperCase()}:\\`;
    rest = unified.slice(drive[0].length);
  } else if (unified.startsWith("\\")) {
    return { ok: false, message: "Cesta začíná lomítkem bez písmene disku. Použijte P:\\… , \\\\server\\… nebo cestu relativní k hlavní složce." };
  } else {
    kind = "relative";
    rest = unified;
  }
  const segments = rest.split("\\").filter((segment) => segment.length > 0);
  for (const segment of segments) {
    if (segment === ".." || segment === ".") return { ok: false, message: "Cesta nesmí obsahovat „.“ ani „..“." };
    if (WINDOWS_FORBIDDEN.test(segment)) return { ok: false, message: `Část „${segment}“ obsahuje znak, který Windows v názvu složky nepovoluje (< > : " | ? *).` };
    if (WINDOWS_RESERVED.test(segment)) return { ok: false, message: `„${segment}“ je ve Windows rezervovaný název.` };
    if (/[ .]$/u.test(segment)) return { ok: false, message: `Část „${segment}“ končí mezerou nebo tečkou, což Windows nepovoluje.` };
  }
  if (kind === "relative" && segments.length === 0) return { ok: false, message: "Cesta je prázdná." };
  unified = prefix + segments.join("\\");
  return { ok: true, kind, path: unified };
}

/**
 * Errors per role. Nothing can be set without the event root (an empty root = not configured); the
 * root must be absolute (C:\…, P:\…) or UNC. Subfolders may be relative to the root or absolute.
 */
export function validateEventPaths(mappings: readonly EventPathMapping[]): Readonly<Record<string, string>> {
  const issues: Record<string, string> = {};
  const seen = new Set<string>();
  for (const mapping of mappings) {
    if (seen.has(mapping.role)) issues[mapping.role] = "Role je uvedena dvakrát.";
    seen.add(mapping.role);
    const parsed = parseEventPath(mapping.path);
    if (parsed.ok === false) issues[mapping.role] = parsed.message;
    else if (mapping.role === "event_root" && parsed.kind === "relative") issues[mapping.role] = "Kořenová složka musí být úplná cesta (např. C:\\…, P:\\… nebo \\\\server\\…).";
  }
  if (!mappings.some((mapping) => mapping.role === "event_root")) {
    for (const mapping of mappings) issues[mapping.role] ??= "Nejdřív vyplňte kořenovou složku veletrhu.";
  }
  return issues;
}

/**
 * Full path of a role for display and for the future Organizer. A subfolder without a stored value
 * is the event root itself; a relative value is joined to the root. Undefined = not configured
 * (no valid root).
 */
export function resolveEventPath(role: EventPathRole, mappings: readonly EventPathMapping[]): string | undefined {
  const root = mappings.find((candidate) => candidate.role === "event_root");
  const rootParsed = root ? parseEventPath(root.path) : undefined;
  const rootPath = rootParsed?.ok && rootParsed.kind !== "relative" ? rootParsed.path : undefined;
  if (role === "event_root") return rootPath;
  const mapping = mappings.find((candidate) => candidate.role === role);
  if (!mapping || !mapping.path.trim()) return rootPath;
  const parsed = parseEventPath(mapping.path);
  if (parsed.ok === false) return undefined;
  if (parsed.kind !== "relative") return parsed.path;
  return rootPath ? `${rootPath.replace(/\\$/u, "")}\\${parsed.path}` : undefined;
}

/** Saved shape: normalized paths only; empty subfolders are not stored (= the root). */
export function normalizeEventPaths(mappings: readonly EventPathMapping[]): readonly EventPathMapping[] {
  return mappings
    .filter((mapping) => mapping.path.trim())
    .map((mapping) => {
      const parsed = parseEventPath(mapping.path);
      return { role: mapping.role, path: parsed.ok ? parsed.path : mapping.path.trim(), ...(mapping.note?.trim() ? { note: mapping.note.trim() } : {}) };
    });
}

/** The standard configuration for a root: the root plus all nine standard relative subfolders. */
export function buildStandardEventPaths(root: string): readonly EventPathMapping[] {
  if (!root.trim()) return [];
  return [{ role: "event_root", path: root }, ...EVENT_SUBFOLDER_ROLES.map((role) => ({ role, path: STANDARD_EVENT_FOLDERS[role] }))];
}

/**
 * Mode shown for a stored configuration: standard only when all nine subfolders hold exactly the
 * standard names; anything else is custom (so an existing configuration is shown as it is stored).
 * Nothing stored yet -> standard, the convenient default for a new setup.
 */
export function inferEventPathMode(mappings: readonly EventPathMapping[]): EventPathMode {
  const subfolders = mappings.filter((mapping) => mapping.role !== "event_root");
  if (subfolders.length === 0 && !mappings.some((mapping) => mapping.role === "event_root")) return "standard";
  return EVENT_SUBFOLDER_ROLES.every((role) => subfolders.find((mapping) => mapping.role === role)?.path === STANDARD_EVENT_FOLDERS[role]) && subfolders.length === EVENT_SUBFOLDER_ROLES.length
    ? "standard"
    : "custom";
}

/** Custom values that switching to the standard would replace (empty values and standard names do not count). */
export function customValuesLostByStandard(subfolders: Readonly<Partial<Record<EventSubfolderRole, string>>>): readonly EventSubfolderRole[] {
  return EVENT_SUBFOLDER_ROLES.filter((role) => {
    const value = subfolders[role]?.trim();
    return Boolean(value) && value !== STANDARD_EVENT_FOLDERS[role];
  });
}

export function isEventPathRole(value: unknown): value is EventPathRole {
  return typeof value === "string" && (EVENT_PATH_ROLES as readonly string[]).includes(value);
}
