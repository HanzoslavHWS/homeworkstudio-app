/**
 * Catalog card types (PRODUCT / SERVICE / BOOTH / INTERNAL_COMPONENT / KIT) and their relation to the
 * existing `kind` readiness profile. Pure, no I/O.
 *
 * item_type is the coarse system property the admin chooses when founding a card; `kind` keeps
 * driving domain/catalogReadiness.ts and the generator pickers exactly as before. A type only
 * narrows which kinds make sense — it never adds a second set of readiness rules.
 */
import { CATALOG_ITEM_TYPES, type CatalogItemKind, type CatalogItemType } from "./models.ts";

export const CATALOG_ITEM_TYPE_LABELS_CS: Readonly<Record<CatalogItemType, string>> = {
  PRODUCT: "Produkt",
  SERVICE: "Služba",
  BOOTH: "Stánek",
  INTERNAL_COMPONENT: "Interní komponenta",
  KIT: "Komplet",
};

export const CATALOG_ITEM_TYPE_HINTS_CS: Readonly<Record<CatalogItemType, string>> = {
  PRODUCT: "Fyzický produkt z nabídky (židle, stůl, pult, vitrína, věšák, lednice…). Může mít ABF kód, jednotku, rozměry a 3D model.",
  SERVICE: "Služba (elektřina, internet, voda, odpad, úklid, grafika…). Nemusí mít 3D objekt; může nést technická metadata pro technický rastr.",
  BOOTH: "Typový stánek / balíček. Může obsahovat další katalogové položky (typovka, pult, židle, světla…), zahrnuté v ceně celku.",
  INTERNAL_COMPONENT: "Interní konstrukční / CAD / 3D prvek pro generátor (panel, sloupek, profil, límec…). Není položkou ABF ceníku, ABF kód není povinný.",
  KIT: "Samostatný komplet bez vlastní geometrie (např. balíček nábytku nebo sada elektro). Obsah, náhrady a doplatky kompletu se doplní ve V1-DATA-04.",
};

/**
 * Compatible kinds per type, default first. Mirrors the migration's kind -> item_type backfill
 * (supabase/migrations/20261001120000_catalog_item_types_abf_codes_packages.sql) in reverse.
 * "construction"/"other" appear under INTERNAL_COMPONENT too: a non-ABF construction element
 * (profil, límec) may legitimately need construction's conditional scene rules rather than
 * booth_component's mandatory GLB+SKP rule.
 */
export const CATALOG_ITEM_KINDS_BY_TYPE: Readonly<Record<CatalogItemType, readonly CatalogItemKind[]>> = {
  PRODUCT: ["furniture", "floor_finish", "construction", "other"],
  SERVICE: ["service", "graphics_service", "technical_point"],
  BOOTH: ["booth"],
  INTERNAL_COMPONENT: ["booth_component", "construction", "other"],
  KIT: ["other"],
};

export function isCatalogItemType(value: unknown): value is CatalogItemType {
  return typeof value === "string" && (CATALOG_ITEM_TYPES as readonly string[]).includes(value);
}

/** The SAME mapping the migration backfill and its insert trigger use — keep the three in sync. */
export function defaultItemTypeForKind(kind: CatalogItemKind): CatalogItemType {
  switch (kind) {
    case "booth":
      return "BOOTH";
    case "booth_component":
      return "INTERNAL_COMPONENT";
    case "service":
    case "graphics_service":
    case "technical_point":
      return "SERVICE";
    default:
      return "PRODUCT";
  }
}

export function defaultKindForItemType(itemType: CatalogItemType): CatalogItemKind {
  return CATALOG_ITEM_KINDS_BY_TYPE[itemType][0]!;
}

export function isKindCompatibleWithItemType(kind: CatalogItemKind, itemType: CatalogItemType): boolean {
  return CATALOG_ITEM_KINDS_BY_TYPE[itemType].includes(kind);
}

/** ABF code is never mandatory — but for INTERNAL_COMPONENT it is explicitly not expected at all (and never generated). */
export function itemTypeExpectsAbfCode(itemType: CatalogItemType): boolean {
  return itemType !== "INTERNAL_COMPONENT";
}

const ABF_CODE_MAX_LENGTH = 32;
const INTERNAL_CODE_MAX_LENGTH = 64;

/**
 * Normalizes a code typed by an admin or read from Excel: trimmed, internal whitespace rejected
 * (a code is an identifier, not a phrase). Returns undefined for blank input and null for an
 * input that is present but not a usable code.
 */
function normalizeCode(raw: unknown, maxLength: number): string | null | undefined {
  if (raw === null || raw === undefined) return undefined;
  const text = String(raw).trim();
  if (!text) return undefined;
  if (text.length > maxLength || !CODE_PATTERN.test(text)) return null;
  return text;
}

/** A code starts with a letter or digit and may contain letters, digits and . _ / + - (no spaces, quotes or brackets). */
const CODE_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._/+-]*$/u;

/** Standard ABF code shape (KODY.xlsm): a family letter + 2 characters (T04, M8A, L02). Other shapes are allowed with a warning. */
export const STANDARD_ABF_CODE_PATTERN = /^[A-Z][0-9A-Z]{2}$/u;

export function abfCodeWarning(abfCode: string | null | undefined): string | undefined {
  if (!abfCode || STANDARD_ABF_CODE_PATTERN.test(abfCode)) return undefined;
  return `ABF kód ${abfCode} nemá standardní tvar (písmeno + 2 znaky). Ověřte ho proti KODY.xlsm.`;
}

export class CrossCodeCollisionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CrossCodeCollisionError";
    this.code = code;
  }
}

/**
 * A generator code may equal its OWN ABF code (decision A8), but never another item's ABF code, and
 * an ABF code never another item's generator code — otherwise one code would name two items.
 */
export function assertNoCrossCodeCollision(
  existingItems: readonly Readonly<{ id: string; internalCode: string | null; abfCode?: string | null; displayName?: string }>[],
  candidate: Readonly<{ internalCode?: string | null; abfCode?: string | null }>,
  exceptId?: string,
): void {
  const key = (value: string | null | undefined) => value?.trim().toLocaleUpperCase("cs") || undefined;
  const internal = key(candidate.internalCode);
  const abf = key(candidate.abfCode);
  for (const item of existingItems) {
    if (item.id === exceptId) continue;
    if (internal && key(item.abfCode) === internal) {
      throw new CrossCodeCollisionError(candidate.internalCode!, `Generátorový kód „${candidate.internalCode}“ je ABF kódem jiné položky („${item.displayName ?? item.id}“).`);
    }
    if (abf && key(item.internalCode) === abf) {
      throw new CrossCodeCollisionError(candidate.abfCode!, `ABF kód „${candidate.abfCode}“ je generátorovým kódem jiné položky („${item.displayName ?? item.id}“).`);
    }
  }
}

/** ABF codes are upper-case identifiers in every ABF source (T04, M8A, L02) — normalized so "m8a" can never create a second card. */
export function normalizeAbfCode(raw: unknown): string | null | undefined {
  const code = normalizeCode(raw, ABF_CODE_MAX_LENGTH);
  return typeof code === "string" ? code.toLocaleUpperCase("cs") : code;
}

/** Internal codes keep the admin's casing (uniqueness is already case-insensitive — assertUniqueInternalCode). */
export function normalizeInternalCode(raw: unknown): string | null | undefined {
  return normalizeCode(raw, INTERNAL_CODE_MAX_LENGTH);
}

export class DuplicateAbfCodeError extends Error {
  readonly abfCode: string;

  constructor(abfCode: string) {
    super(`ABF kód "${abfCode}" už je v katalogu použitý u jiné položky.`);
    this.name = "DuplicateAbfCodeError";
    this.abfCode = abfCode;
  }
}

/** Mirrors the DB's partial unique index catalog_items_abf_code_key. `exceptId` lets an item keep its own code on save. */
export function assertUniqueAbfCode(
  existingItems: readonly Readonly<{ id: string; abfCode: string | null }>[],
  candidate: string | undefined,
  exceptId?: string,
): void {
  if (!candidate) return;
  const normalized = candidate.trim().toLocaleUpperCase("cs");
  const collision = existingItems.some(
    (item) => item.id !== exceptId && item.abfCode && item.abfCode.trim().toLocaleUpperCase("cs") === normalized,
  );
  if (collision) throw new DuplicateAbfCodeError(candidate);
}
