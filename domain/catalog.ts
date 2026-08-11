import type {
  ComponentDefinition,
  Currency,
  PricingEntry,
} from "./models.ts";

export type PricingContext = Readonly<{
  exhibitionId?: string;
  realizationCompanyId?: string;
  priceListId?: string;
  currency: Currency;
  at?: string;
}>;

export function selectPricingEntry(
  entries: readonly PricingEntry[],
  context: PricingContext,
): PricingEntry | undefined {
  const at = context.at ?? new Date().toISOString();
  return entries
    .filter((entry) => {
      if (entry.currency !== context.currency) return false;
      if (entry.validFrom && entry.validFrom > at) return false;
      if (entry.validTo && entry.validTo < at) return false;
      if (entry.exhibitionId && entry.exhibitionId !== context.exhibitionId)
        return false;
      if (
        entry.realizationCompanyId &&
        entry.realizationCompanyId !== context.realizationCompanyId
      )
        return false;
      if (entry.priceListId && entry.priceListId !== context.priceListId)
        return false;
      return true;
    })
    .sort((a, b) => pricingSpecificity(b) - pricingSpecificity(a))[0];
}

function pricingSpecificity(entry: PricingEntry): number {
  return Number(Boolean(entry.exhibitionId)) * 4 +
    Number(Boolean(entry.realizationCompanyId)) * 2 +
    Number(Boolean(entry.priceListId));
}

export interface CatalogImportProvider {
  readonly id: string;
  importCatalog(file: File): Promise<{
    items: readonly ComponentDefinition[];
    prices: readonly PricingEntry[];
    warnings: readonly string[];
  }>;
}

export interface AssetStorageProvider {
  readonly id: string;
  store(file: File): Promise<{ url: string }>;
}

export function normalizeCatalogCode(value: string | undefined): string {
  return (value ?? "").trim().toLocaleUpperCase("cs");
}

export function normalizeCatalogName(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("cs");
}

export function matchCatalogItem(
  items: readonly ComponentDefinition[],
  input: Readonly<{ internalCode?: string; name?: string }>,
): ComponentDefinition | undefined {
  const code = normalizeCatalogCode(input.internalCode);
  if (code) {
    const byCode = items.find(
      (item) => normalizeCatalogCode(item.internalCode) === code,
    );
    if (byCode) return byCode;
  }
  const name = normalizeCatalogName(input.name);
  return name
    ? items.find((item) =>
        [item.name, item.officialName].some(
          (candidate) => normalizeCatalogName(candidate) === name,
        ),
      )
    : undefined;
}
