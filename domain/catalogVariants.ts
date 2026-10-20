/**
 * Swatch books and their variants (V1-DATA-04, M6) — mirror of catalog_variant_sets /
 * catalog_variants in supabase/migrations/20261021130000_catalog_kits_variants.sql. Pure, no I/O.
 *
 * A variant (e.g. a carpet colour) is billed through `priceItemId` — the catalog card whose
 * meaning in ABF fits it: M01 "Koberec šedý 1 m²", M02 "Koberec jiné barvy 1 m²". On top of that a
 * variant may carry its own surcharge RULE, so two colours that share M02 can still cost
 * differently. Amounts are never stored here: they come from a price resolver today and from the
 * versioned price lists of V1-DATA-05 later, keyed by the variant id.
 */
import { catalogUnitByCode } from "./catalogUnits.ts";

export const VARIANT_SET_KINDS = ["carpet", "finish", "color", "other"] as const;
export type VariantSetKind = (typeof VARIANT_SET_KINDS)[number];

export const VARIANT_SET_KIND_LABELS_CS: Readonly<Record<VariantSetKind, string>> = {
  carpet: "Koberce",
  finish: "Povrchy",
  color: "Barvy",
  other: "Ostatní",
};

/** none | price_difference (price of priceItemId minus the default variant's) | per_unit (own surcharge per unit, e.g. Kč/m²) | fixed (one amount per line). */
export const VARIANT_SURCHARGE_RULES = ["none", "price_difference", "per_unit", "fixed"] as const;
export type VariantSurchargeRule = (typeof VARIANT_SURCHARGE_RULES)[number];

export const VARIANT_SURCHARGE_RULE_LABELS_CS: Readonly<Record<VariantSurchargeRule, string>> = {
  none: "Bez příplatku",
  price_difference: "Rozdíl ceny karty proti výchozí variantě",
  per_unit: "Vlastní příplatek za jednotku",
  fixed: "Pevný příplatek",
};

export type CatalogVariant = Readonly<{
  id: string;
  variantSetId: string;
  code: string;
  name: string;
  nameEn?: string;
  swatchColor?: string;
  priceItemId?: string;
  surchargeRule: VariantSurchargeRule;
  surchargeUnitCode?: string;
  legacyFinishId?: string;
  isActive: boolean;
  sortOrder: number;
  note?: string;
}>;

export type CatalogVariantSet = Readonly<{
  id: string;
  code: string;
  name: string;
  kind: VariantSetKind;
  isActive: boolean;
  note?: string;
  variants: readonly CatalogVariant[];
}>;

/** One variant of a save request. `id` present = existing variant (kept), absent = new. */
export type CatalogVariantInput = Readonly<{
  id?: string;
  code: string;
  name: string;
  nameEn?: string;
  swatchColor?: string;
  priceItemId?: string;
  surchargeRule: VariantSurchargeRule;
  surchargeUnitCode?: string;
  legacyFinishId?: string;
  isActive: boolean;
  note?: string;
}>;

export type CatalogVariantSetInput = Readonly<{
  id?: string;
  code: string;
  name: string;
  kind: VariantSetKind;
  isActive: boolean;
  note?: string;
  variants: readonly CatalogVariantInput[];
}>;

export class InvalidCatalogVariantSetError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(issues[0] ?? "Neplatný vzorník.");
    this.name = "InvalidCatalogVariantSetError";
    this.issues = issues;
  }
}

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]*$/u;
const CODE_MAX = 64;
const TEXT_MAX = 200;
const MAX_VARIANTS = 200;

function text(raw: unknown, max = TEXT_MAX): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, max) : undefined;
}

/** Codes are upper-case identifiers ("KOBERCE-2026", "SEDA"); spaces become dashes, diacritics are dropped. */
export function normalizeVariantCode(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const code = raw
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toUpperCase()
    .replace(/\s+/gu, "-");
  return code || undefined;
}

export function parseCatalogVariantSetInput(raw: unknown): CatalogVariantSetInput {
  if (!raw || typeof raw !== "object") throw new InvalidCatalogVariantSetError(["Neplatný vzorník."]);
  const value = raw as Record<string, unknown>;
  const issues: string[] = [];
  const code = normalizeVariantCode(value.code);
  if (!code || !CODE_PATTERN.test(code) || code.length > CODE_MAX) issues.push("Kód vzorníku smí obsahovat jen velká písmena, číslice, - a _ (např. KOBERCE-2026).");
  const name = text(value.name);
  if (!name) issues.push("Vzorník musí mít název.");
  const kind = (VARIANT_SET_KINDS as readonly unknown[]).includes(value.kind) ? (value.kind as VariantSetKind) : "carpet";
  const rawVariants = Array.isArray(value.variants) ? value.variants : [];
  if (rawVariants.length > MAX_VARIANTS) issues.push(`Vzorník může mít nejvýše ${MAX_VARIANTS} variant.`);
  const variants = rawVariants.map((entry, index): CatalogVariantInput => {
    const variant = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const variantCode = normalizeVariantCode(variant.code);
    const variantName = text(variant.name);
    const label = `Varianta ${index + 1}`;
    if (!variantCode || !CODE_PATTERN.test(variantCode) || variantCode.length > CODE_MAX) issues.push(`${label}: interní kód barvy smí obsahovat jen velká písmena, číslice, - a _.`);
    if (!variantName) issues.push(`${label}: chybí název barvy.`);
    const swatchColor = text(variant.swatchColor, 7);
    if (swatchColor && !/^#[0-9a-fA-F]{6}$/u.test(swatchColor)) issues.push(`${label}: barva náhledu musí být ve tvaru #RRGGBB.`);
    const surchargeRule = (VARIANT_SURCHARGE_RULES as readonly unknown[]).includes(variant.surchargeRule) ? (variant.surchargeRule as VariantSurchargeRule) : "none";
    const surchargeUnitCode = text(variant.surchargeUnitCode, 32);
    if (surchargeRule === "per_unit" && !catalogUnitByCode(surchargeUnitCode)) issues.push(`${label}: příplatek za jednotku potřebuje jednotku (např. m²).`);
    if (surchargeRule === "price_difference" && !text(variant.priceItemId, 64)) issues.push(`${label}: rozdíl ceny potřebuje vazbu na katalogovou položku (např. M02).`);
    return {
      ...(text(variant.id, 64) ? { id: text(variant.id, 64)! } : {}),
      code: variantCode ?? "",
      name: variantName ?? "",
      ...(text(variant.nameEn) ? { nameEn: text(variant.nameEn)! } : {}),
      ...(swatchColor ? { swatchColor } : {}),
      ...(text(variant.priceItemId, 64) ? { priceItemId: text(variant.priceItemId, 64)! } : {}),
      surchargeRule,
      ...(surchargeRule === "per_unit" && surchargeUnitCode ? { surchargeUnitCode } : {}),
      ...(text(variant.legacyFinishId, 64) ? { legacyFinishId: text(variant.legacyFinishId, 64)! } : {}),
      isActive: variant.isActive !== false,
      ...(text(variant.note, 500) ? { note: text(variant.note, 500)! } : {}),
    };
  });
  const seenCodes = new Set<string>();
  const seenLegacy = new Set<string>();
  for (const variant of variants) {
    if (variant.code && seenCodes.has(variant.code)) issues.push(`Kód barvy ${variant.code} je ve vzorníku vícekrát.`);
    seenCodes.add(variant.code);
    if (variant.legacyFinishId && seenLegacy.has(variant.legacyFinishId)) issues.push(`Starší ID barvy ${variant.legacyFinishId} je ve vzorníku vícekrát.`);
    if (variant.legacyFinishId) seenLegacy.add(variant.legacyFinishId);
  }
  if (issues.length > 0) throw new InvalidCatalogVariantSetError(issues);
  return {
    ...(text(value.id, 64) ? { id: text(value.id, 64)! } : {}),
    code: code!,
    name: name!,
    kind,
    isActive: value.isActive !== false,
    ...(text(value.note, 500) ? { note: text(value.note, 500)! } : {}),
    variants,
  };
}

/**
 * Checks a parsed set against stored data: set code free, existing variant ids belong to this set,
 * no stored variant disappears (variants are deactivated, never deleted — older projects and kit
 * lines may point to them), and every priceItemId exists in the catalog.
 */
export function validateCatalogVariantSet(
  input: CatalogVariantSetInput,
  context: Readonly<{ sets: readonly CatalogVariantSet[]; knownItemIds: ReadonlySet<string> }>,
): readonly string[] {
  const issues: string[] = [];
  const stored = input.id ? context.sets.find((set) => set.id === input.id) : undefined;
  if (input.id && !stored) issues.push("Vzorník nebyl nalezen.");
  if (context.sets.some((set) => set.code === input.code && set.id !== input.id)) issues.push(`Kód vzorníku ${input.code} už používá jiný vzorník.`);
  const storedIds = new Set((stored?.variants ?? []).map((variant) => variant.id));
  for (const variant of input.variants) {
    if (variant.id && !storedIds.has(variant.id)) issues.push(`Varianta ${variant.code} nepatří do tohoto vzorníku.`);
    if (variant.priceItemId && !context.knownItemIds.has(variant.priceItemId)) issues.push(`Varianta ${variant.code}: navázaná katalogová položka neexistuje.`);
  }
  const keptIds = new Set(input.variants.flatMap((variant) => (variant.id ? [variant.id] : [])));
  for (const variant of stored?.variants ?? []) {
    if (!keptIds.has(variant.id)) issues.push(`Variantu ${variant.code} nelze odebrat, lze ji jen deaktivovat.`);
  }
  return issues;
}

/** Variant an older project's carpetFinishId points to (FinishVariant.id → legacy_finish_id). */
export function variantForLegacyFinish(sets: readonly CatalogVariantSet[], legacyFinishId: string | null | undefined, variantSetId?: string): CatalogVariant | undefined {
  if (!legacyFinishId) return undefined;
  for (const set of sets) {
    if (variantSetId && set.id !== variantSetId) continue;
    const match = set.variants.find((variant) => variant.legacyFinishId === legacyFinishId);
    if (match) return match;
  }
  return undefined;
}

export function variantById(sets: readonly CatalogVariantSet[], variantId: string | null | undefined): CatalogVariant | undefined {
  if (!variantId) return undefined;
  for (const set of sets) {
    const match = set.variants.find((variant) => variant.id === variantId);
    if (match) return match;
  }
  return undefined;
}

export function activeVariants(set: CatalogVariantSet | undefined): readonly CatalogVariant[] {
  return (set?.variants ?? []).filter((variant) => variant.isActive).slice().sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "cs"));
}
