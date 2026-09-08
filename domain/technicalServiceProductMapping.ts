/**
 * Technické rastry — external report label -> internal catalog product code. Deliberately NEVER
 * a blind guess (spec section 11: "konkrétní mapping NESMÍ být slepě hardcoded podle domněnky") —
 * this starter config is intentionally EMPTY. A technical-report column label (e.g. "Do 2 kW
 * 230V") only resolves to a real product once someone on the technical team has actually verified
 * which domain/catalogPricing.ts CatalogItemSummary it corresponds to and added an entry here (or
 * to a future DB-backed mapping table — this module's shape doesn't change either way). Until
 * then every such label reports status "unresolved_product" — the raw label/quantity are NEVER
 * discarded (see domain/technicalRaster.ts's TechnicalService).
 *
 * Reuses the app's ONE existing product/service catalog (domain/catalogPricing.ts's
 * CatalogItemSummary, already the source of truth for the main generator's pricing) — this module
 * never invents a second catalog. A configured mapping is only ever honored if the target
 * internalCode ACTUALLY exists in the live catalog passed in at resolve time; if the catalog and
 * this config have drifted (code renamed/removed), that's surfaced as "unresolved_product" too,
 * never silently trusted.
 */
import type { CatalogItemSummary } from "./catalogPricing.ts";

/** category id (see technicalServiceCatalog.ts) -> normalized external label -> internal catalog code. */
export type TechnicalServiceProductMappingConfig = Readonly<Record<string, Readonly<Record<string, string>>>>;

/**
 * Intentionally empty (see module doc). Populate via addTechnicalServiceProductMapping()-shaped
 * entries once the technical team has verified a real correspondence — never pre-guessed here.
 */
export const DEFAULT_TECHNICAL_SERVICE_PRODUCT_MAPPING: TechnicalServiceProductMappingConfig = {};

function normalizeLabelKey(label: string): string {
  return label.trim().toLocaleLowerCase("cs").replace(/\s+/gu, " ");
}

export type ProductMappingResolution =
  | Readonly<{ status: "resolved"; internalProductId: string; internalProductCode: string }>
  | Readonly<{ status: "unresolved_product" }>;

/**
 * Looks up `category`+`externalLabel` in `mapping`, then confirms the resulting internalCode is
 * really present in `catalogItems` (the live catalog) before ever calling it "resolved". No
 * fuzzy matching, no partial credit — spec section 11/29.
 */
export function resolveTechnicalServiceProduct(
  category: string,
  externalLabel: string,
  catalogItems: readonly Pick<CatalogItemSummary, "id" | "internalCode">[],
  mapping: TechnicalServiceProductMappingConfig = DEFAULT_TECHNICAL_SERVICE_PRODUCT_MAPPING,
): ProductMappingResolution {
  const configuredCode = mapping[category]?.[normalizeLabelKey(externalLabel)];
  if (!configuredCode) return { status: "unresolved_product" };
  const catalogItem = catalogItems.find((item) => item.internalCode === configuredCode);
  if (!catalogItem) return { status: "unresolved_product" };
  return { status: "resolved", internalProductId: catalogItem.id, internalProductCode: configuredCode };
}
