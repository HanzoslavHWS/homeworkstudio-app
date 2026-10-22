/**
 * Excel template of a sale price version — column definitions and row mapping prepared for
 * V1-DATA-08 (docs/V1_DATA_ARCHITECTURE.md section 6, workbook "Ceník", sheet "Ceny"). Pure, no I/O;
 * the bulk import itself (dry run -> preview -> transactional apply into a DRAFT) is not implemented
 * yet.
 *
 * Every row carries all three sale prices side by side: CZK, EUR_SK and EUR_WORLD (decision 8.1).
 * EUR_SK is exported both as the effective value (read-only, recomputed from CZK and the version
 * rate) and as an optional manual override; the import only reads the override, so editing CZK or
 * the rate never touches EUR_WORLD.
 *
 * Import rules (decision A6): an empty optional cell = unchanged; the value #SMAZAT clears it.
 * Row identity = (version, card, variant); card is found by generator code, then ABF code.
 */
import { eurSkOf, eurWorldOf, parseSaleEntryInput, type EurRule, type SaleEntryInput, type SalePriceEntry, type SalePriceMode } from "./priceVersions.ts";

export const EXCEL_DELETE_MARKER = "#SMAZAT";

export type PriceVersionExcelColumnKey =
  | "generator_code"
  | "abf_code"
  | "item_name"
  | "variant_code"
  | "price_mode"
  | "price_czk"
  | "price_eur_sk"
  | "price_eur_sk_manual"
  | "price_eur_world"
  | "unit_code"
  | "note";

export type PriceVersionExcelColumn = Readonly<{
  key: PriceVersionExcelColumnKey;
  labelCs: string;
  /** Read back on import. Read-only columns are exported for information only. */
  importable: boolean;
}>;

/** Row 1 of the sheet = technical keys, row 2 = Czech labels (labels may be renamed safely). */
export const PRICE_VERSION_EXCEL_COLUMNS: readonly PriceVersionExcelColumn[] = [
  { key: "generator_code", labelCs: "Generátorový kód", importable: true },
  { key: "abf_code", labelCs: "ABF kód", importable: true },
  { key: "item_name", labelCs: "Název (jen pro čtení)", importable: false },
  { key: "variant_code", labelCs: "Varianta (kód)", importable: true },
  { key: "price_mode", labelCs: "Režim ceny (fixed / individual / included)", importable: true },
  { key: "price_czk", labelCs: "Cena CZK bez DPH", importable: true },
  { key: "price_eur_sk", labelCs: "EUR SK – platná cena (jen pro čtení, z CZK a kurzu)", importable: false },
  { key: "price_eur_sk_manual", labelCs: "EUR SK – ruční cena (prázdné = přepočet)", importable: true },
  { key: "price_eur_world", labelCs: "EUR WORLD bez DPH", importable: true },
  { key: "unit_code", labelCs: "Jednotka", importable: true },
  { key: "note", labelCs: "Poznámka", importable: true },
];

export type PriceVersionExcelRow = Readonly<Partial<Record<PriceVersionExcelColumnKey, string | number | null>>>;

/** Export of one sale row with its three prices. */
export function saleEntryToExcelRow(
  entry: SalePriceEntry,
  context: Readonly<{ rule: EurRule; generatorCode?: string; abfCode?: string; itemName: string; variantCode?: string }>,
): PriceVersionExcelRow {
  const fixed = entry.priceMode === "fixed";
  const sk = fixed ? eurSkOf({ czk: entry.saleCzk, eurMode: entry.eurMode, eur: entry.saleEur }, context.rule) : undefined;
  const world = fixed ? eurWorldOf({ czk: entry.saleCzk, eurMode: entry.eurMode, eur: entry.saleEur, eurWorld: entry.saleEurWorld }) : undefined;
  return {
    generator_code: context.generatorCode ?? null,
    abf_code: context.abfCode ?? null,
    item_name: context.itemName,
    variant_code: context.variantCode ?? null,
    price_mode: entry.priceMode,
    price_czk: entry.saleCzk ?? null,
    price_eur_sk: sk?.amount ?? null,
    price_eur_sk_manual: sk?.manual ? sk.amount ?? null : null,
    price_eur_world: world ?? null,
    unit_code: entry.unitCode ?? null,
    note: entry.note ?? null,
  };
}

type CellChange<T> = Readonly<{ kind: "keep" } | { kind: "clear" } | { kind: "set"; value: T }>;

function cell(value: string | number | null | undefined): CellChange<string> {
  if (value === undefined || value === null) return { kind: "keep" };
  const text = String(value).trim();
  if (!text) return { kind: "keep" };
  if (text.toUpperCase() === EXCEL_DELETE_MARKER) return { kind: "clear" };
  return { kind: "set", value: text };
}

function merged<T>(change: CellChange<string>, current: T | undefined): string | T | undefined {
  if (change.kind === "keep") return current;
  if (change.kind === "clear") return undefined;
  return change.value;
}

/**
 * Applies one imported row onto the current draft row (undefined = new row) and validates it like an
 * editor save. Identity columns (codes, variant) are resolved by the importer, not here.
 */
export function applyExcelRowToSaleEntry(current: SaleEntryInput | undefined, row: PriceVersionExcelRow, identity: Readonly<{ catalogItemId: string; variantId?: string }>): SaleEntryInput {
  const priceModeCell = cell(row.price_mode);
  const priceMode = (priceModeCell.kind === "set" ? priceModeCell.value : current?.priceMode ?? "fixed") as SalePriceMode;
  const manualCell = cell(row.price_eur_sk_manual);
  const manualEur = merged(manualCell, current?.eurMode === "manual" ? current.saleEur : undefined);
  return parseSaleEntryInput(
    {
      catalogItemId: identity.catalogItemId,
      variantId: identity.variantId,
      priceMode,
      saleCzk: priceMode === "fixed" ? merged(cell(row.price_czk), current?.saleCzk) : undefined,
      eurMode: manualEur === undefined ? "derived" : "manual",
      saleEur: priceMode === "fixed" ? manualEur : undefined,
      saleEurWorld: priceMode === "fixed" ? merged(cell(row.price_eur_world), current?.saleEurWorld) : undefined,
      unitCode: merged(cell(row.unit_code), current?.unitCode),
      note: merged(cell(row.note), current?.note),
    },
    0,
  );
}
