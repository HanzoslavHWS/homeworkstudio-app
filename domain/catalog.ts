import type {
  ComponentDefinition,
  Currency,
  PlacedComponent,
  PricingEntry,
} from "./models.ts";
import type { StoredAsset } from "./assets.ts";
export type { AssetStorageProvider } from "./assets.ts";

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

/**
 * "missing" here means no PricingEntry resolved at all for the context (selectPricingEntry
 * returned undefined) — never confuse with "fixed" salePrice of 0, which is a real price.
 * A CatalogItem being "active"/ready is independent of this: readiness is about the item
 * being well-formed, pricing availability is about whether *this* project/event has a
 * number to charge right now. See domain/catalogReadiness.ts for the readiness side.
 */
export type PricingAvailability = "fixed" | "individual" | "included" | "missing";

export function derivePricingAvailability(entry: PricingEntry | undefined): PricingAvailability {
  if (!entry) return "missing";
  if (entry.priceMode === "individual") return "individual";
  if (entry.priceMode === "included") return "included";
  return entry.salePrice !== undefined ? "fixed" : "missing";
}

/**
 * Section 10's priority, made explicit: selectPricingEntry already prefers the most
 * specific event/realization/price-list override over a base (all-undefined) entry —
 * this just resolves the result into the 4-way availability a pricing UI needs to show
 * ("missing price / nutno nacenit" rather than silently falling back to 0).
 */
export function resolvePricingAvailability(
  item: Pick<ComponentDefinition, "pricingEntries">,
  context: PricingContext,
): PricingAvailability {
  return derivePricingAvailability(selectPricingEntry(item.pricingEntries ?? [], context));
}

export interface CatalogImportProvider {
  readonly id: string;
  importCatalog(file: File): Promise<{
    items: readonly ComponentDefinition[];
    prices: readonly PricingEntry[];
    warnings: readonly string[];
  }>;
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

export function catalogDisplayName(
  item: Pick<ComponentDefinition, "displayName" | "name">,
): string {
  return item.displayName ?? item.name;
}

export function getBasePricingEntry(
  entries: readonly PricingEntry[] | undefined,
  currency?: Currency,
): PricingEntry | undefined {
  return entries?.find(
    (entry) =>
      (!currency || entry.currency === currency) &&
      !entry.exhibitionId &&
      !entry.realizationCompanyId &&
      !entry.priceListId,
  );
}

export function catalogImageCandidates(
  item: Pick<ComponentDefinition, "thumbnailUrl" | "photoUrl">,
): readonly string[] {
  return [...new Set([item.thumbnailUrl, item.photoUrl].filter((url): url is string => Boolean(url)))];
}

export function catalogImageAsset(
  item: Pick<ComponentDefinition, "thumbnailAsset" | "photoAsset">,
): StoredAsset | undefined {
  return item.thumbnailAsset ?? item.photoAsset;
}

export function catalogImageUrl(
  item: Pick<ComponentDefinition, "thumbnailUrl" | "photoUrl">,
  unavailableUrls: readonly string[] = [],
): string | undefined {
  const unavailable = new Set(unavailableUrls);
  return catalogImageCandidates(item).find((url) => !unavailable.has(url));
}

export type CatalogSceneSummaryItem = Readonly<{
  catalogItemId: string;
  internalCode?: string;
  displayName: string;
  quantity: number;
  unit: string;
  saleUnitNet: number;
  saleTotalNet: number;
  photoUrl?: string;
  photoAsset?: StoredAsset;
}>;

export function groupCatalogSceneItems(
  sceneObjects: readonly Pick<PlacedComponent, "definitionId" | "name">[],
  catalogItems: readonly ComponentDefinition[],
  currency: Currency,
): readonly CatalogSceneSummaryItem[] {
  const grouped = new Map<string, CatalogSceneSummaryItem>();
  for (const sceneObject of sceneObjects) {
    const definition = catalogItems.find(
      (candidate) => candidate.id === sceneObject.definitionId,
    );
    const current = grouped.get(sceneObject.definitionId);
    const saleUnitNet = getBasePricingEntry(
      definition?.pricingEntries,
      currency,
    )?.salePrice ?? 0;
    grouped.set(sceneObject.definitionId, {
      catalogItemId: sceneObject.definitionId,
      internalCode: definition?.internalCode,
      displayName: definition
        ? catalogDisplayName(definition)
        : sceneObject.name,
      quantity: (current?.quantity ?? 0) + 1,
      unit: definition?.unit ?? "ks",
      saleUnitNet,
      saleTotalNet: (current?.saleTotalNet ?? 0) + saleUnitNet,
      photoUrl: definition?.photoUrl,
      photoAsset: definition?.photoAsset,
    });
  }
  return [...grouped.values()];
}

type CatalogPhotoResponse = Readonly<{
  ok: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export async function loadCatalogPhoto(
  photoUrl: string,
  fetchPhoto: (url: string) => Promise<CatalogPhotoResponse>,
): Promise<Uint8Array | undefined> {
  try {
    const response = await fetchPhoto(photoUrl);
    return response.ok
      ? new Uint8Array(await response.arrayBuffer())
      : undefined;
  } catch {
    return undefined;
  }
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
        [item.displayName, item.name, item.officialName].some(
          (candidate) => normalizeCatalogName(candidate) === name,
        ),
      )
    : undefined;
}
