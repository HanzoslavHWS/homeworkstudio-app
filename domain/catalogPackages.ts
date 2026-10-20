/**
 * Kit contents shared by BOOTH and KIT cards (decision A1) — table catalog_item_package_items
 * extended in V1-DATA-04 (supabase/migrations/20261021130000_catalog_kits_variants.sql). Pure, no I/O.
 *
 * A kit line is identified by its stable `lineKey` inside the kit, so the same component may sit
 * on several lines (back wall + side wall). A line is either a catalog component or a free text
 * line (A16: own name, quantity, unit and note, never a price of its own). An included line is
 * physically used and counted, but never charged again: its price is the kit's own price. This
 * reuses the existing PricingEntryMode "included" semantics (domain/models.ts).
 *
 * A component line may additionally carry a default variant (carpet colour from a swatch book),
 * allowed substitutes with a surcharge rule (electricity 2 kW → 3 kW / 5 kW), and an included
 * scope of graphics (A17). Kits inside kits are refused (A14). Pricing lives in
 * domain/catalogKitPricing.ts, graphics allocation in domain/catalogKitPrintAllowance.ts.
 */
import type { CatalogItemType, PricingEntryMode } from "./models.ts";
import { catalogUnitByCode } from "./catalogUnits.ts";
import { kitPrintAllowanceIssues, parseKitPrintAllowances, type KitPrintAllowance } from "./catalogKitPrintAllowance.ts";
import type { CatalogVariantSet } from "./catalogVariants.ts";

export const KIT_LINE_KINDS = ["item", "text"] as const;
export type KitLineKind = (typeof KIT_LINE_KINDS)[number];

/** price_difference = price(substitute) − price(original), never below zero (A4); fixed / per_unit amounts come from price lists (V1-DATA-05); none = free. */
export const KIT_SUBSTITUTE_RULES = ["price_difference", "fixed", "per_unit", "none"] as const;
export type KitSubstituteRule = (typeof KIT_SUBSTITUTE_RULES)[number];

export const KIT_SUBSTITUTE_RULE_LABELS_CS: Readonly<Record<KitSubstituteRule, string>> = {
  price_difference: "Rozdíl ceny nové a původní komponenty",
  fixed: "Pevný doplatek",
  per_unit: "Doplatek za jednotku",
  none: "Bez doplatku",
};

export type KitLineSubstitute = Readonly<{
  id?: string;
  substituteItemId: string;
  substituteVariantId?: string;
  surchargeRule: KitSubstituteRule;
  surchargeUnitCode?: string;
  quantityFactor: number;
  isActive?: boolean;
  note?: string;
}>;

export type CatalogPackageItem = Readonly<{
  id: string;
  packageItemId: string;
  /** Stable line id inside the kit. Rows read before the V1-DATA-04 migration get one derived on read. */
  lineKey: string;
  lineKind: KitLineKind;
  /** null for a text line. */
  childItemId: string | null;
  label?: string;
  labelEn?: string;
  quantity: number;
  unitCode?: string;
  includedInPackage: boolean;
  sortOrder: number;
  note: string | null;
  variantSetId?: string;
  defaultVariantId?: string;
  printAllowance?: readonly KitPrintAllowance[];
  substitutes?: readonly KitLineSubstitute[];
}>;

/** One line of an admin "save kit contents" request — the full desired set, in display order. */
export type CatalogPackageItemInput = Readonly<{
  /** Existing line: its key (kept). New line: omitted, assigned by assignKitLineKeys. */
  lineKey?: string;
  lineKind?: KitLineKind;
  childItemId?: string;
  label?: string;
  labelEn?: string;
  quantity: number;
  unitCode?: string;
  includedInPackage: boolean;
  note?: string;
  variantSetId?: string;
  defaultVariantId?: string;
  printAllowance?: readonly KitPrintAllowance[];
  substitutes?: readonly KitLineSubstitute[];
}>;

export type KitLineInput = CatalogPackageItemInput & Readonly<{ lineKey: string; lineKind: KitLineKind }>;

export class InvalidCatalogPackageError extends Error {
  readonly issues: readonly string[];
  constructor(message: string, issues: readonly string[] = [message]) {
    super(message);
    this.name = "InvalidCatalogPackageError";
    this.issues = issues;
  }
}

const MAX_PACKAGE_LINES = 200;
const MAX_SUBSTITUTES = 30;
const NOTE_MAX_LENGTH = 500;
const LABEL_MAX_LENGTH = 300;
const LINE_KEY_MAX = 64;
const LINE_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

export const KIT_OWNER_TYPES: readonly CatalogItemType[] = ["BOOTH", "KIT"];

export function isKitOwnerType(itemType: CatalogItemType): boolean {
  return KIT_OWNER_TYPES.includes(itemType);
}

function optionalText(raw: unknown, max: number): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, max) : undefined;
}

/** "Koberec šedý" → "koberec-sedy"; codes "M01" → "m01". Same rule as the migration backfill. */
export function slugifyLineKey(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 56);
}

function parseSubstitutes(raw: unknown, lineLabel: string): readonly KitLineSubstitute[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new InvalidCatalogPackageError(`${lineLabel}: náhrady musí být seznam.`);
  if (raw.length > MAX_SUBSTITUTES) throw new InvalidCatalogPackageError(`${lineLabel}: nejvýše ${MAX_SUBSTITUTES} náhrad.`);
  return raw.map((entry, index) => {
    const value = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const label = `${lineLabel}, náhrada ${index + 1}`;
    if (typeof value.substituteItemId !== "string" || !value.substituteItemId) throw new InvalidCatalogPackageError(`${label}: vyberte náhradní komponentu.`);
    const surchargeRule = (KIT_SUBSTITUTE_RULES as readonly unknown[]).includes(value.surchargeRule) ? (value.surchargeRule as KitSubstituteRule) : "price_difference";
    const quantityFactor = value.quantityFactor === undefined || value.quantityFactor === null || value.quantityFactor === "" ? 1 : Number(value.quantityFactor);
    if (!Number.isFinite(quantityFactor) || quantityFactor <= 0) throw new InvalidCatalogPackageError(`${label}: přepočet množství musí být kladné číslo.`);
    const surchargeUnitCode = optionalText(value.surchargeUnitCode, 32);
    return {
      ...(optionalText(value.id, 64) ? { id: optionalText(value.id, 64)! } : {}),
      substituteItemId: value.substituteItemId,
      ...(optionalText(value.substituteVariantId, 64) ? { substituteVariantId: optionalText(value.substituteVariantId, 64)! } : {}),
      surchargeRule,
      ...(surchargeRule === "per_unit" && surchargeUnitCode ? { surchargeUnitCode } : {}),
      quantityFactor,
      ...(optionalText(value.note, NOTE_MAX_LENGTH) ? { note: optionalText(value.note, NOTE_MAX_LENGTH)! } : {}),
    };
  });
}

/** Whitelists a raw request body into kit lines. Throws InvalidCatalogPackageError on anything malformed — never silently drops a line the admin meant to save. */
export function parseCatalogPackageItemsInput(raw: unknown): readonly CatalogPackageItemInput[] {
  if (!Array.isArray(raw)) throw new InvalidCatalogPackageError("Obsah kompletu musí být seznam položek.");
  if (raw.length > MAX_PACKAGE_LINES) throw new InvalidCatalogPackageError(`Komplet může mít nejvýše ${MAX_PACKAGE_LINES} položek.`);
  return raw.map((entry, index) => {
    const lineLabel = `Řádek ${index + 1}`;
    if (!entry || typeof entry !== "object") throw new InvalidCatalogPackageError(`${lineLabel}: neplatná položka.`);
    const candidate = entry as Record<string, unknown>;
    const lineKind: KitLineKind = candidate.lineKind === "text" ? "text" : "item";
    if (lineKind === "item" && (typeof candidate.childItemId !== "string" || !candidate.childItemId)) {
      throw new InvalidCatalogPackageError(`${lineLabel}: chybí vybraná katalogová položka.`);
    }
    if (typeof candidate.quantity !== "number" || !Number.isFinite(candidate.quantity) || candidate.quantity <= 0) {
      throw new InvalidCatalogPackageError(`${lineLabel}: množství musí být kladné číslo.`);
    }
    const lineKey = optionalText(candidate.lineKey, LINE_KEY_MAX + 1);
    const label = optionalText(candidate.label, LABEL_MAX_LENGTH);
    if (lineKind === "text" && !label) throw new InvalidCatalogPackageError(`${lineLabel}: textová položka musí mít název.`);
    const note = optionalText(candidate.note, NOTE_MAX_LENGTH);
    const unitCode = optionalText(candidate.unitCode, 32);
    const printAllowance = parseKitPrintAllowances(candidate.printAllowance);
    const substitutes = parseSubstitutes(candidate.substitutes, lineLabel);
    return {
      ...(lineKey ? { lineKey } : {}),
      lineKind,
      ...(lineKind === "item" ? { childItemId: candidate.childItemId as string } : {}),
      ...(label ? { label } : {}),
      ...(optionalText(candidate.labelEn, LABEL_MAX_LENGTH) ? { labelEn: optionalText(candidate.labelEn, LABEL_MAX_LENGTH)! } : {}),
      quantity: candidate.quantity,
      ...(unitCode ? { unitCode } : {}),
      // Default true: the whole point of a kit line is "part of the kit price". A text line always is.
      includedInPackage: lineKind === "text" ? true : candidate.includedInPackage !== false,
      ...(note ? { note } : {}),
      ...(optionalText(candidate.variantSetId, 64) ? { variantSetId: optionalText(candidate.variantSetId, 64)! } : {}),
      ...(optionalText(candidate.defaultVariantId, 64) ? { defaultVariantId: optionalText(candidate.defaultVariantId, 64)! } : {}),
      ...(printAllowance.length ? { printAllowance } : {}),
      ...(substitutes.length ? { substitutes } : {}),
    };
  });
}

/**
 * Gives every new line a key: from the component's ABF / generator code, else its name, else the
 * text label — numbered when taken ("m01", "m01-2"). Lines that already have a key keep it.
 */
export function assignKitLineKeys(
  lines: readonly CatalogPackageItemInput[],
  itemsById: ReadonlyMap<string, Readonly<{ id: string; abfCode?: string | null; internalCode?: string | null; displayName?: string }>>,
): readonly KitLineInput[] {
  const taken = new Set(lines.flatMap((line) => (line.lineKey ? [line.lineKey] : [])));
  return lines.map((line) => {
    const lineKind = line.lineKind ?? "item";
    if (line.lineKey) return { ...line, lineKey: line.lineKey, lineKind };
    const child = line.childItemId ? itemsById.get(line.childItemId) : undefined;
    const base = slugifyLineKey(child?.abfCode ?? child?.internalCode ?? child?.displayName ?? line.label ?? "") || (lineKind === "text" ? "text" : "polozka");
    let key = base;
    for (let n = 2; taken.has(key); n += 1) key = `${base}-${n}`;
    taken.add(key);
    return { ...line, lineKey: key, lineKind };
  });
}

export type KitValidationItem = Readonly<{ id: string; itemType: CatalogItemType; displayName?: string }>;

export type KitValidationContext = Readonly<{
  itemsById: ReadonlyMap<string, KitValidationItem>;
  variantSets: readonly CatalogVariantSet[];
}>;

/**
 * Validates a desired kit content set: the owner is a BOOTH/KIT, keys are unique, component lines
 * point to existing non-kit items (A14), text lines carry no price features (A16), variants belong
 * to their swatch book, substitutes are real alternatives, graphics scopes are well formed.
 * Archived components are allowed — archival never breaks an existing kit. Throws one
 * InvalidCatalogPackageError listing every problem; returns non-blocking warnings.
 */
export function validateKitLines(packageItemId: string, lines: readonly KitLineInput[], context: KitValidationContext): readonly string[] {
  const issues: string[] = [];
  const warnings: string[] = [];
  const owner = context.itemsById.get(packageItemId);
  if (!owner) throw new InvalidCatalogPackageError("Komplet (stánek) nebyl v katalogu nalezen.");
  if (!isKitOwnerType(owner.itemType)) throw new InvalidCatalogPackageError("Obsah lze nastavit jen u karty typu Stánek nebo Komplet.");
  const nameOf = (id: string) => context.itemsById.get(id)?.displayName ?? id;
  const variantSetById = new Map(context.variantSets.map((set) => [set.id, set]));
  const variantSetOf = new Map(context.variantSets.flatMap((set) => set.variants.map((variant) => [variant.id, set.id] as const)));
  const keys = new Set<string>();

  for (const [index, line] of lines.entries()) {
    const label = `Řádek ${index + 1}`;
    if (!LINE_KEY_PATTERN.test(line.lineKey) || line.lineKey.length > LINE_KEY_MAX) issues.push(`${label}: klíč řádku „${line.lineKey}“ smí obsahovat jen malá písmena, číslice a pomlčky.`);
    if (keys.has(line.lineKey)) issues.push(`${label}: klíč řádku „${line.lineKey}“ je v kompletu vícekrát.`);
    keys.add(line.lineKey);
    if (line.unitCode && !catalogUnitByCode(line.unitCode)) issues.push(`${label}: neznámá jednotka „${line.unitCode}“.`);

    if (line.lineKind === "text") {
      if (!line.label?.trim()) issues.push(`${label}: textová položka musí mít název.`);
      if (line.childItemId) issues.push(`${label}: textová položka nemůže odkazovat na komponentu.`);
      if (line.variantSetId || line.defaultVariantId) issues.push(`${label}: textová položka nemůže mít variantu.`);
      if (line.substitutes?.length) issues.push(`${label}: textová položka nemůže mít náhrady ani doplatky.`);
      if (line.printAllowance?.length) issues.push(`${label}: textová položka nemůže zahrnovat grafiku.`);
      continue;
    }

    const childId = line.childItemId ?? "";
    const child = context.itemsById.get(childId);
    if (childId === packageItemId) issues.push(`${label}: komplet nemůže obsahovat sám sebe.`);
    else if (!child) issues.push(`${label}: vybraná položka neexistuje v katalogu.`);
    else if (isKitOwnerType(child.itemType)) issues.push(`${label}: komplet nemůže obsahovat jiný komplet ani stánek (${nameOf(childId)}, rozhodnutí A14).`);

    if (line.defaultVariantId && !line.variantSetId) issues.push(`${label}: výchozí varianta potřebuje vybraný vzorník.`);
    if (line.variantSetId && !variantSetById.has(line.variantSetId)) issues.push(`${label}: vzorník neexistuje.`);
    if (line.defaultVariantId && line.variantSetId && variantSetOf.get(line.defaultVariantId) !== line.variantSetId) issues.push(`${label}: výchozí varianta nepatří do vybraného vzorníku.`);

    const seenSubstitutes = new Set<string>();
    for (const [subIndex, substitute] of (line.substitutes ?? []).entries()) {
      const subLabel = `${label}, náhrada ${subIndex + 1}`;
      const target = context.itemsById.get(substitute.substituteItemId);
      if (!target) issues.push(`${subLabel}: náhradní komponenta neexistuje v katalogu.`);
      else if (isKitOwnerType(target.itemType)) issues.push(`${subLabel}: náhradou nemůže být komplet ani stánek (rozhodnutí A14).`);
      if (substitute.substituteItemId === childId && !substitute.substituteVariantId) issues.push(`${subLabel}: náhrada musí být jiná komponenta nebo jiná varianta.`);
      if (substitute.substituteVariantId && !variantSetOf.has(substitute.substituteVariantId)) issues.push(`${subLabel}: varianta náhrady neexistuje.`);
      if (substitute.surchargeRule === "per_unit" && !catalogUnitByCode(substitute.surchargeUnitCode)) issues.push(`${subLabel}: doplatek za jednotku potřebuje jednotku.`);
      const key = `${substitute.substituteItemId}|${substitute.substituteVariantId ?? ""}`;
      if (seenSubstitutes.has(key)) issues.push(`${subLabel}: stejná náhrada je u řádku vícekrát.`);
      seenSubstitutes.add(key);
    }
    for (const message of kitPrintAllowanceIssues(line.printAllowance ?? [])) issues.push(`${label}: ${message}`);
  }

  // Same component on several lines is allowed when the lines differ in purpose. If they differ
  // only in quantity, one line with the summed quantity is clearer — a warning, not an error.
  const signatures = new Map<string, number[]>();
  for (const [index, line] of lines.entries()) {
    if (line.lineKind !== "item") continue;
    const signature = JSON.stringify([line.childItemId, line.includedInPackage, line.unitCode ?? "", line.variantSetId ?? "", line.defaultVariantId ?? "", line.substitutes ?? [], line.printAllowance ?? []]);
    signatures.set(signature, [...(signatures.get(signature) ?? []), index + 1]);
  }
  for (const [signature, rows] of signatures) {
    if (rows.length < 2) continue;
    const childId = (JSON.parse(signature) as string[])[0]!;
    warnings.push(`Řádky ${rows.join(", ")} (${nameOf(childId)}) se liší jen množstvím nebo poznámkou — zvažte jeden řádek se součtem.`);
  }

  if (issues.length > 0) throw new InvalidCatalogPackageError(issues[0]!, issues);
  return warnings;
}

/**
 * A card type change must not break kit rules: a card that owns lines stays BOOTH/KIT, and a card
 * used inside a kit (as a component or a substitute) never becomes a BOOTH/KIT (A14).
 */
export function kitTypeChangeIssue(
  itemId: string,
  nextType: CatalogItemType,
  links: readonly Pick<CatalogPackageItem, "packageItemId" | "childItemId" | "substitutes">[],
): string | undefined {
  if (!isKitOwnerType(nextType) && links.some((link) => link.packageItemId === itemId)) {
    return "Karta má obsah kompletu — typ lze změnit jen na Stánek nebo Komplet. Nejdřív obsah odeberte.";
  }
  const usedInside = links.some((link) => link.childItemId === itemId || (link.substitutes ?? []).some((substitute) => substitute.substituteItemId === itemId));
  if (isKitOwnerType(nextType) && usedInside) {
    return "Karta je použitá v obsahu jiného kompletu — nemůže se stát stánkem ani kompletem (rozhodnutí A14).";
  }
  return undefined;
}

/** Deterministic display/processing order: sortOrder, then id. */
export function sortPackageItems<T extends Pick<CatalogPackageItem, "sortOrder" | "id">>(items: readonly T[]): readonly T[] {
  return items.slice().sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}

export function packageItemsFor(packageItemId: string, links: readonly CatalogPackageItem[]): readonly CatalogPackageItem[] {
  return sortPackageItems(links.filter((link) => link.packageItemId === packageItemId));
}

/** A stored line back as a save input (editor reload, card duplicate). */
export function packageItemToInput(line: CatalogPackageItem, options: Readonly<{ keepKey?: boolean }> = { keepKey: true }): CatalogPackageItemInput {
  return {
    ...(options.keepKey !== false ? { lineKey: line.lineKey } : {}),
    lineKind: line.lineKind,
    ...(line.childItemId ? { childItemId: line.childItemId } : {}),
    ...(line.label ? { label: line.label } : {}),
    ...(line.labelEn ? { labelEn: line.labelEn } : {}),
    quantity: line.quantity,
    ...(line.unitCode ? { unitCode: line.unitCode } : {}),
    includedInPackage: line.includedInPackage,
    ...(line.note ? { note: line.note } : {}),
    ...(line.variantSetId ? { variantSetId: line.variantSetId } : {}),
    ...(line.defaultVariantId ? { defaultVariantId: line.defaultVariantId } : {}),
    ...(line.printAllowance?.length ? { printAllowance: line.printAllowance } : {}),
    ...(line.substitutes?.length ? { substitutes: line.substitutes.map(({ id: _id, isActive: _active, ...rest }) => rest) } : {}),
  };
}

/** Payload of replace_catalog_kit_lines() (snake_case jsonb), in display order. */
export function buildKitLinesRpcPayload(lines: readonly KitLineInput[]): readonly Record<string, unknown>[] {
  return lines.map((line) => ({
    line_key: line.lineKey,
    line_kind: line.lineKind,
    child_item_id: line.lineKind === "item" ? line.childItemId ?? null : null,
    label: line.label ?? null,
    label_en: line.labelEn ?? null,
    quantity: line.quantity,
    unit_code: line.unitCode ?? null,
    included_in_package: line.lineKind === "text" ? true : line.includedInPackage,
    note: line.note ?? null,
    variant_set_id: line.lineKind === "item" ? line.variantSetId ?? null : null,
    default_variant_id: line.lineKind === "item" ? line.defaultVariantId ?? null : null,
    print_allowance: line.lineKind === "item" && line.printAllowance?.length ? line.printAllowance : null,
    substitutes: line.lineKind === "item"
      ? (line.substitutes ?? []).map((substitute) => ({
          substitute_item_id: substitute.substituteItemId,
          substitute_variant_id: substitute.substituteVariantId ?? null,
          surcharge_rule: substitute.surchargeRule,
          surcharge_unit_code: substitute.surchargeRule === "per_unit" ? substitute.surchargeUnitCode ?? null : null,
          quantity_factor: substitute.quantityFactor,
          note: substitute.note ?? null,
        }))
      : [],
  }));
}

/** True when the lines use nothing but what the pre-V1-DATA-04 table can store (one line per component). */
export function isLegacyCompatibleKit(lines: readonly KitLineInput[]): boolean {
  const children = new Set<string>();
  for (const line of lines) {
    if (line.lineKind !== "item" || !line.childItemId || children.has(line.childItemId)) return false;
    if (line.unitCode || line.variantSetId || line.defaultVariantId || line.printAllowance?.length || line.substitutes?.length || line.label) return false;
    children.add(line.childItemId);
  }
  return true;
}

// ============================================================================
// PRICING (basic) — included lines are counted but never re-charged. Substitutes, variants and
// surcharges: domain/catalogKitPricing.ts.
// ============================================================================

export type PackageUnitPrice = Readonly<{ priceMode: PricingEntryMode; salePrice?: number }> | undefined;

export type PackagePriceLine = Readonly<{
  childItemId: string | null;
  quantity: number;
  includedInPackage: boolean;
  /** "included" for every included line, whatever the child's own catalog price would be. */
  status: "included" | "priced" | "individual" | "missing";
  unitPriceNet: number;
  totalNet: number;
}>;

export type PackagePriceResult = Readonly<{
  lines: readonly PackagePriceLine[];
  /** The package's own price (base) + every NON-included, fixed-priced line. */
  totalNet: number;
  /** True when some non-included line has no fixed price yet (individual/missing) — the total is then incomplete and must be quoted. */
  needsQuote: boolean;
}>;

/**
 * Prices a package: the package price covers every included line (unit price 0, status
 * "included"); only non-included (optional extra) lines are priced through `resolveUnitPrice`,
 * which callers back with the existing Event → PriceList → PricingEntry resolution
 * (domain/catalog.ts selectPricingEntry). Text lines are always included. Quantities are always
 * preserved so the generator can still count/place the physical items.
 */
export function pricePackage(
  packagePriceNet: number,
  lines: readonly (Pick<CatalogPackageItem, "quantity" | "includedInPackage"> & Readonly<{ childItemId?: string | null }>)[],
  resolveUnitPrice: (childItemId: string) => PackageUnitPrice,
): PackagePriceResult {
  let totalNet = packagePriceNet;
  let needsQuote = false;
  const priced = lines.map((line): PackagePriceLine => {
    const childItemId = line.childItemId ?? null;
    if (line.includedInPackage || !childItemId) {
      return { childItemId, quantity: line.quantity, includedInPackage: true, status: "included", unitPriceNet: 0, totalNet: 0 };
    }
    const unit = resolveUnitPrice(childItemId);
    if (unit?.priceMode === "included") {
      return { childItemId, quantity: line.quantity, includedInPackage: false, status: "included", unitPriceNet: 0, totalNet: 0 };
    }
    if (unit?.priceMode === "individual") {
      needsQuote = true;
      return { childItemId, quantity: line.quantity, includedInPackage: false, status: "individual", unitPriceNet: 0, totalNet: 0 };
    }
    if (unit?.salePrice === undefined) {
      needsQuote = true;
      return { childItemId, quantity: line.quantity, includedInPackage: false, status: "missing", unitPriceNet: 0, totalNet: 0 };
    }
    const lineTotal = unit.salePrice * line.quantity;
    totalNet += lineTotal;
    return { childItemId, quantity: line.quantity, includedInPackage: false, status: "priced", unitPriceNet: unit.salePrice, totalNet: lineTotal };
  });
  return { lines: priced, totalNet, needsQuote };
}
