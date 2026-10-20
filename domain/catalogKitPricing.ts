/**
 * Kit pricing with substitutes and variants (V1-DATA-04). Pure, no I/O.
 *
 * Every price comes from the caller's resolver: today a test or the legacy price lists, from
 * V1-DATA-05 on the versioned base / electricity price list of the event. Nothing here knows a
 * real amount.
 *
 * Rules:
 *   - One result line per kit line. A chosen substitute REPLACES the line's component (2 kW → 5 kW
 *     is still one connection, never a second one).
 *   - Included line: no price of its own; only a surcharge for the chosen substitute or variant.
 *   - Optional (not included) line: full price of the effective component × quantity.
 *   - price_difference = price(new) − price(original); never below zero (A4). A cheaper choice
 *     costs 0 and the line says why ("floor_zero"); discounts are a separate, deliberate decision.
 *   - per_unit = surcharge amount × line quantity, only when the line is in the surcharge unit.
 *   - fixed = one surcharge amount per line. none = free.
 *   - Variant (e.g. carpet colour) chosen instead of the line's default: the variant's own rule.
 *     Colours sharing one ABF card (M02) can therefore still cost differently (per_unit).
 *   - With a substitute chosen, the substitute's rule applies and its variant (if any) is used.
 *   - A missing price never invents an amount: the line is "missing" and the kit needs a quote.
 */
import type { CatalogPackageItem, KitSubstituteRule, PackageUnitPrice } from "./catalogPackages.ts";
import { variantById, type CatalogVariant, type CatalogVariantSet, type VariantSurchargeRule } from "./catalogVariants.ts";

export type KitLineSelection = Readonly<{
  lineKey: string;
  /** Chosen allowed substitute (its component). */
  substituteItemId?: string;
  substituteVariantId?: string;
  /** Chosen variant of the line's swatch book (no substitute). */
  variantId?: string;
}>;

export type KitSurchargeRef =
  | Readonly<{ kind: "variant"; variantId: string; lineKey: string }>
  | Readonly<{ kind: "substitute"; lineKey: string; substituteItemId: string; substituteVariantId?: string; substituteId?: string }>;

export type KitPriceResolver = Readonly<{
  /** Unit price of a catalog card (same shape as pricePackage's resolver). */
  unitPrice: (itemId: string) => PackageUnitPrice;
  /** Amount of a fixed / per-unit surcharge. Undefined = not priced yet. */
  surchargeAmount?: (ref: KitSurchargeRef) => number | undefined;
}>;

export type KitSurcharge = Readonly<{
  source: "substitute" | "variant";
  rule: KitSubstituteRule | VariantSurchargeRule;
  amountNet: number;
  /** floor_zero = cheaper choice, no credit (A4); missing_price / unit_mismatch = not priceable. */
  reason?: "floor_zero" | "missing_price" | "unit_mismatch";
}>;

export type KitPricedLine = Readonly<{
  lineKey: string;
  lineKind: CatalogPackageItem["lineKind"];
  label?: string;
  originalItemId: string | null;
  effectiveItemId: string | null;
  variantId?: string;
  substituted: boolean;
  quantity: number;
  unitCode?: string;
  includedInPackage: boolean;
  status: "included" | "priced" | "individual" | "missing";
  /** Price of an optional line (0 for an included one). */
  baseNet: number;
  surcharge?: KitSurcharge;
  totalNet: number;
}>;

export type KitPriceResult = Readonly<{
  lines: readonly KitPricedLine[];
  totalNet: number;
  needsQuote: boolean;
  /** Selections that could not be applied (not allowed, unknown line) — reported, never silently used. */
  issues: readonly string[];
}>;

const round2 = (value: number) => Math.round(value * 100) / 100;

function fixedPrice(unit: PackageUnitPrice): number | undefined {
  if (unit?.priceMode === "included") return 0;
  if (unit?.priceMode === "individual") return undefined;
  return unit?.salePrice;
}

function differenceSurcharge(source: KitSurcharge["source"], newUnit: number | undefined, originalUnit: number | undefined, newQuantity: number, originalQuantity: number): KitSurcharge {
  if (newUnit === undefined || originalUnit === undefined) return { source, rule: "price_difference", amountNet: 0, reason: "missing_price" };
  const difference = round2(newUnit * newQuantity - originalUnit * originalQuantity);
  return difference < 0 ? { source, rule: "price_difference", amountNet: 0, reason: "floor_zero" } : { source, rule: "price_difference", amountNet: difference };
}

function amountSurcharge(
  source: KitSurcharge["source"],
  rule: "fixed" | "per_unit",
  amount: number | undefined,
  quantity: number,
  lineUnit: string | undefined,
  surchargeUnit: string | undefined,
): KitSurcharge {
  if (rule === "per_unit" && lineUnit && surchargeUnit && lineUnit !== surchargeUnit) return { source, rule, amountNet: 0, reason: "unit_mismatch" };
  if (amount === undefined) return { source, rule, amountNet: 0, reason: "missing_price" };
  return { source, rule, amountNet: round2(rule === "per_unit" ? amount * quantity : amount) };
}

export function priceKit(input: Readonly<{
  kitPriceNet: number;
  lines: readonly CatalogPackageItem[];
  variantSets?: readonly CatalogVariantSet[];
  selections?: readonly KitLineSelection[];
  resolver: KitPriceResolver;
}>): KitPriceResult {
  const issues: string[] = [];
  const selectionByKey = new Map<string, KitLineSelection>();
  for (const selection of input.selections ?? []) {
    if (!input.lines.some((line) => line.lineKey === selection.lineKey)) issues.push(`Volba pro neznámý řádek „${selection.lineKey}“ byla ignorována.`);
    else selectionByKey.set(selection.lineKey, selection);
  }
  const sets = input.variantSets ?? [];
  const priceOf = (itemId: string | undefined) => (itemId ? fixedPrice(input.resolver.unitPrice(itemId)) : undefined);
  let totalNet = input.kitPriceNet;
  let needsQuote = false;

  const lines = input.lines.map((line): KitPricedLine => {
    const common = { lineKey: line.lineKey, lineKind: line.lineKind, ...(line.label ? { label: line.label } : {}), originalItemId: line.childItemId, quantity: line.quantity, ...(line.unitCode ? { unitCode: line.unitCode } : {}) };
    if (line.lineKind === "text" || !line.childItemId) {
      return { ...common, effectiveItemId: null, substituted: false, includedInPackage: true, status: "included", baseNet: 0, totalNet: 0 };
    }
    const selection = selectionByKey.get(line.lineKey);
    const substitute = selection?.substituteItemId
      ? (line.substitutes ?? []).find((candidate) => candidate.isActive !== false && candidate.substituteItemId === selection.substituteItemId && (candidate.substituteVariantId ?? undefined) === (selection.substituteVariantId ?? undefined))
      : undefined;
    if (selection?.substituteItemId && !substitute) issues.push(`Řádek „${line.lineKey}“: zvolená náhrada není povolená, použita původní komponenta.`);

    let variant: CatalogVariant | undefined;
    if (!substitute && selection?.variantId) {
      const candidate = variantById(sets, selection.variantId);
      if (candidate && candidate.variantSetId === line.variantSetId && candidate.isActive) variant = candidate;
      else issues.push(`Řádek „${line.lineKey}“: varianta nepatří do vzorníku řádku, použita výchozí.`);
    }
    const defaultVariant = variantById(sets, line.defaultVariantId);
    const effectiveItemId = substitute?.substituteItemId ?? line.childItemId;
    const effectiveVariantId = substitute ? substitute.substituteVariantId : (variant ?? defaultVariant)?.id;
    const effectiveQuantity = substitute ? line.quantity * substitute.quantityFactor : line.quantity;

    let surcharge: KitSurcharge | undefined;
    if (substitute) {
      if (!line.includedInPackage) surcharge = undefined; // an optional line simply costs its new component
      else if (substitute.surchargeRule === "price_difference") surcharge = differenceSurcharge("substitute", priceOf(substitute.substituteItemId), priceOf(line.childItemId), effectiveQuantity, line.quantity);
      else if (substitute.surchargeRule === "none") surcharge = { source: "substitute", rule: "none", amountNet: 0 };
      else {
        const amount = input.resolver.surchargeAmount?.({ kind: "substitute", lineKey: line.lineKey, substituteItemId: substitute.substituteItemId, ...(substitute.substituteVariantId ? { substituteVariantId: substitute.substituteVariantId } : {}), ...(substitute.id ? { substituteId: substitute.id } : {}) });
        surcharge = amountSurcharge("substitute", substitute.surchargeRule, amount, effectiveQuantity, line.unitCode, substitute.surchargeUnitCode);
      }
    } else if (variant && variant.id !== defaultVariant?.id) {
      if (variant.surchargeRule === "price_difference") surcharge = differenceSurcharge("variant", priceOf(variant.priceItemId), priceOf(defaultVariant?.priceItemId ?? line.childItemId), line.quantity, line.quantity);
      else if (variant.surchargeRule === "none") surcharge = { source: "variant", rule: "none", amountNet: 0 };
      else surcharge = amountSurcharge("variant", variant.surchargeRule, input.resolver.surchargeAmount?.({ kind: "variant", variantId: variant.id, lineKey: line.lineKey }), line.quantity, line.unitCode, variant.surchargeUnitCode);
    }

    let status: KitPricedLine["status"] = "included";
    let baseNet = 0;
    if (!line.includedInPackage) {
      const unit = input.resolver.unitPrice(effectiveItemId);
      if (unit?.priceMode === "individual") status = "individual";
      else if (unit?.priceMode !== "included" && unit?.salePrice === undefined) status = "missing";
      else if (unit?.priceMode === "included") status = "included";
      else {
        status = "priced";
        baseNet = round2(unit!.salePrice! * effectiveQuantity);
      }
    }
    if (surcharge?.reason === "missing_price" || surcharge?.reason === "unit_mismatch") status = "missing";
    if (status === "missing" || status === "individual") needsQuote = true;
    const lineTotal = round2(baseNet + (surcharge?.amountNet ?? 0));
    totalNet = round2(totalNet + lineTotal);
    return {
      ...common,
      effectiveItemId,
      ...(effectiveVariantId ? { variantId: effectiveVariantId } : {}),
      substituted: Boolean(substitute),
      quantity: effectiveQuantity,
      includedInPackage: line.includedInPackage,
      status,
      baseNet,
      ...(surcharge ? { surcharge } : {}),
      totalNet: lineTotal,
    };
  });
  return { lines, totalNet, needsQuote, issues };
}

/** Production / ordering view: quantity per effective component + variant, text lines left out. */
export function summarizeKitComponents(lines: readonly KitPricedLine[]): readonly Readonly<{ itemId: string; variantId?: string; quantity: number; lineKeys: readonly string[] }>[] {
  const byKey = new Map<string, { itemId: string; variantId?: string; quantity: number; lineKeys: string[] }>();
  for (const line of lines) {
    if (!line.effectiveItemId) continue;
    const key = `${line.effectiveItemId}|${line.variantId ?? ""}`;
    const current = byKey.get(key) ?? { itemId: line.effectiveItemId, ...(line.variantId ? { variantId: line.variantId } : {}), quantity: 0, lineKeys: [] };
    current.quantity = Math.round((current.quantity + line.quantity) * 10_000) / 10_000;
    current.lineKeys.push(line.lineKey);
    byKey.set(key, current);
  }
  return [...byKey.values()];
}
