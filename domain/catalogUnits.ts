/**
 * Shared unit register (V1-DATA-03) — mirror of the `catalog_units` seed in
 * supabase/migrations/20261021120000_catalog_identity.sql (tests/catalogIdentity.test.ts keeps the
 * two in sync). Pure, no I/O.
 *
 * Normalization is deliberately conservative: only spellings that unambiguously mean the same unit
 * map to it ("m2" = "m²", "ks" = "kus"). A combined unit ("ks/d", "m2/ak", "m²/den") is never
 * merged with its base unit — that needs a combined unit in the register with an approved
 * conversion rule. Anything else (m, mm, free text) is reported as unknown, never guessed.
 */

export type CatalogUnitQuantityKind = "count" | "area" | "length" | "volume" | "time" | "flat";

export type CatalogUnit = Readonly<{
  code: string;
  symbol: string;
  nameCs: string;
  nameEn: string;
  quantityKind: CatalogUnitQuantityKind;
  isCombined: boolean;
  /** Normalized spellings (normalizeUnitText) that mean exactly this unit. */
  aliases: readonly string[];
}>;

export const CATALOG_UNITS: readonly CatalogUnit[] = [
  { code: "ks", symbol: "ks", nameCs: "kus", nameEn: "piece", quantityKind: "count", isCombined: false, aliases: ["ks", "kus", "kusy", "kusu", "pc", "pcs"] },
  { code: "m2", symbol: "m²", nameCs: "metr čtvereční", nameEn: "square metre", quantityKind: "area", isCombined: false, aliases: ["m2", "metrctverecni"] },
  { code: "bm", symbol: "bm", nameCs: "běžný metr", nameEn: "running metre", quantityKind: "length", isCombined: false, aliases: ["bm", "beznymetr"] },
  { code: "m3", symbol: "m³", nameCs: "metr krychlový", nameEn: "cubic metre", quantityKind: "volume", isCombined: false, aliases: ["m3", "metrkrychlovy"] },
  { code: "den", symbol: "den", nameCs: "den", nameEn: "day", quantityKind: "time", isCombined: false, aliases: ["den", "dny", "dni", "dnu", "day", "days"] },
  { code: "pausal", symbol: "paušál", nameCs: "paušál", nameEn: "flat rate", quantityKind: "flat", isCombined: false, aliases: ["pausal", "paus", "flat"] },
];

export function catalogUnitByCode(code: string | null | undefined, units: readonly CatalogUnit[] = CATALOG_UNITS): CatalogUnit | undefined {
  return code ? units.find((unit) => unit.code === code) : undefined;
}

/** "m²" -> "m2", "Kusy." -> "kusy", "b. m." -> "bm", "ks / den" -> "ks/den". */
export function normalizeUnitText(raw: string): string {
  return raw
    .normalize("NFKC")
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[\s.]+/gu, "");
}

export type UnitNormalization =
  | Readonly<{ status: "empty" }>
  | Readonly<{ status: "known"; code: string; unit: CatalogUnit }>
  | Readonly<{ status: "combined"; raw: string; message: string }>
  | Readonly<{ status: "unknown"; raw: string; message: string }>;

export function normalizeCatalogUnit(raw: string | null | undefined, units: readonly CatalogUnit[] = CATALOG_UNITS): UnitNormalization {
  const text = raw?.trim() ?? "";
  if (!text) return { status: "empty" };
  const key = normalizeUnitText(text);
  const byCode = units.find((unit) => unit.code === key);
  const match = byCode ?? units.find((unit) => unit.aliases.includes(key));
  if (match) return { status: "known", code: match.code, unit: match };
  if (key.includes("/")) {
    return { status: "combined", raw: text, message: `Kombinovaná jednotka „${text}“ se neslučuje se základní jednotkou — chybí schválené převodní pravidlo.` };
  }
  return { status: "unknown", raw: text, message: `Jednotka „${text}“ není v číselníku jednotek.` };
}

/** Display label for a card: the register symbol, or the legacy free text when no code is set. */
export function catalogUnitLabel(unitCode: string | null | undefined, legacyUnit: string | null | undefined): string {
  return catalogUnitByCode(unitCode)?.symbol ?? legacyUnit?.trim() ?? "";
}
