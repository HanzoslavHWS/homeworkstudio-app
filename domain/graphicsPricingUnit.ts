/**
 * Pricing unit of a graphics card (V1-GRAPHICS-01). Pure, no I/O.
 *
 * The admin never enters a pricing unit twice: it is DERIVED from the card's classification and
 * its measuring unit. The graphics categories fix how they are priced —
 *
 *   graphics-fascia     Límec        → bm (running metre)
 *   graphics-full-wrap  Celopolep    → m²
 *   graphics-counter    Polep pultu  → m²
 *
 * — matching the generator's own rule (domain/printSurfacePricing.ts pricingModeForTypeId: fascia =
 * running metre, every other surface = area). Other graphics categories (graphics-other or a new
 * one) take the card's own register unit (bm, m², ks, …).
 *
 * ComponentDefinition.pricingUnit stays the internal structured field: when a document carries it
 * (legacy imports), it must agree with the derived unit. bm and m² are never converted into each
 * other — a disagreement is reported, never silently resolved.
 */
import { normalizeCatalogUnit } from "./catalogUnits.ts";
import type { ComponentDefinition } from "./models.ts";

export type PricingUnit = NonNullable<ComponentDefinition["pricingUnit"]>;
export type GraphicsPricingUnit = Extract<PricingUnit, "linear-meter" | "square-meter">;

export const PRICING_UNIT_SYMBOLS: Readonly<Record<PricingUnit, string>> = {
  "linear-meter": "bm",
  "square-meter": "m²",
  piece: "ks",
  day: "den",
  "cubic-meter": "m³",
};

/** Built-in graphics categories (supabase/migrations/20261023120000_catalog_categories.sql) whose pricing unit is fixed. */
export const GRAPHICS_CATEGORY_PRICING_UNITS: Readonly<Record<string, GraphicsPricingUnit>> = {
  "graphics-fascia": "linear-meter",
  "graphics-full-wrap": "square-meter",
  "graphics-counter": "square-meter",
};

/** Register unit code (domain/catalogUnits.ts) → pricing unit. "paušál" has no pricing-unit counterpart. */
const UNIT_CODE_PRICING_UNITS: Readonly<Record<string, PricingUnit>> = { bm: "linear-meter", m2: "square-meter", ks: "piece", den: "day", m3: "cubic-meter" };

export type GraphicsPricingUnitResolution =
  | Readonly<{ status: "resolved"; pricingUnit: PricingUnit; source: "category" | "unit" | "explicit" }>
  | Readonly<{ status: "missing"; message: string }>
  | Readonly<{ status: "mismatch"; expected: PricingUnit; message: string }>;

export function resolveGraphicsPricingUnit(item: Pick<ComponentDefinition, "category" | "unit" | "pricingUnit">): GraphicsPricingUnitResolution {
  const byCategory = item.category ? GRAPHICS_CATEGORY_PRICING_UNITS[item.category.trim()] : undefined;
  const unit = normalizeCatalogUnit(item.unit);
  const byUnit = unit.status === "known" ? UNIT_CODE_PRICING_UNITS[unit.code] : undefined;
  const explicit = item.pricingUnit;

  if (byCategory) {
    const expected = PRICING_UNIT_SYMBOLS[byCategory];
    if (unit.status !== "empty" && byUnit !== byCategory) {
      const actual = unit.status === "known" ? unit.unit.symbol : item.unit?.trim();
      return { status: "mismatch", expected: byCategory, message: `Kategorie se oceňuje v ${expected}, karta má jednotku ${actual}. Jednotky bm a m² se nepřevádějí — opravte jednotku karty nebo její kategorii.` };
    }
    if (explicit && explicit !== byCategory) {
      return { status: "mismatch", expected: byCategory, message: `Uložená cenová jednotka (${PRICING_UNIT_SYMBOLS[explicit]}) neodpovídá kategorii, která se oceňuje v ${expected}.` };
    }
    return { status: "resolved", pricingUnit: byCategory, source: "category" };
  }

  if (byUnit) {
    if (explicit && explicit !== byUnit) {
      return { status: "mismatch", expected: byUnit, message: `Uložená cenová jednotka (${PRICING_UNIT_SYMBOLS[explicit]}) neodpovídá jednotce karty (${PRICING_UNIT_SYMBOLS[byUnit]}).` };
    }
    return { status: "resolved", pricingUnit: byUnit, source: "unit" };
  }

  if (explicit) return { status: "resolved", pricingUnit: explicit, source: "explicit" };
  return { status: "missing", message: "Zvolte jednotku karty (Límec = bm, Celopolep a Polep pultu = m²)." };
}
