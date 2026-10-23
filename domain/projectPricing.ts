/**
 * Project pricing — ONE result for the editor price bar, the customer calculation (preview, PDF
 * print), the project summary, the ZIP package and the e-mail draft (V1-DATA-07, step 07-B1).
 * Pure, no I/O.
 *
 * 07-B1 deliberately keeps the LEGACY business rules and amounts exactly as the customer
 * calculation computed them before (domain/calculationExport.ts up to ff1e358):
 *   - booth: its own base price entry in the project currency (document.pricingEntries);
 *   - placed scene objects: grouped per definition, base price entry of the catalog card;
 *   - services: cleaning, electricity, container, graphics through the event's legacy price list
 *     for the project currency (domain/technicalServices.ts, unchanged).
 * What changes is only how a line is REPORTED: a missing price is "missing" ("K nacenění") and
 * never a silent 0; a real price of 0 stays "priced"; a line covered by the booth package is
 * "included"; a technical marker (electricity / water / waste point) is "not_billed" because its
 * price is the matching technical service. Totals are the sum of priced + included lines, i.e. the
 * same numbers as before.
 *
 * Prepared for the next steps (not implemented here): the price track CZK / EUR_SK / EUR_WORLD and a
 * pinned price list version (07-B2) replace `source.model`; a manual price (07-B3) becomes status
 * "manual" on the same line key; kit lines, substitutes and graphics overflow (07-C) become further
 * line kinds; a snapshot (07-D) stores this result as it is.
 */
import type { BoothType, ComponentDefinition, Currency, PlacedComponent, SceneLayer } from "./models.ts";
import type { Exhibition, PriceList } from "./organizations.ts";
import { resolveEventPriceListForCurrency } from "./organizations.ts";
import type { PrintSurfaceAssignment, TechnicalRequirements } from "./project.ts";
import { catalogDisplayName, getBasePricingEntry } from "./catalog.ts";
import { calculateNetVatGross, DEFAULT_CZ_VAT_RATE_PERCENT } from "./pricing.ts";
import { priceCleaning, priceContainer, priceElectricity, priceGraphics, type ServicePriceResult } from "./technicalServices.ts";

/**
 * priced     — a price exists (it may be 0) and is charged;
 * included   — covered by the booth package, shown as "V ceně", adds 0;
 * missing    — no price in the current source: "K nacenění", adds nothing, never presented as 0;
 * not_billed — a technical marker placed in the scene whose price is the technical service line;
 * manual     — reserved for 07-B3 (a project-specific price set by hand); never produced yet.
 */
export type ProjectPriceLineStatus = "priced" | "included" | "missing" | "not_billed" | "manual";

export type ProjectPriceLineKind = "booth" | "scene_item" | "service";

/** Why a line has no price — shown next to "K nacenění". */
export type ProjectPriceMissingReason = "no_price" | "individual_price" | "service_needs_quote";

export type ProjectPriceSource = Readonly<{
  /** 07-B1: always the legacy model. 07-B2 adds the versioned price lists with a pinned version. */
  model: "legacy";
  /** booth_base / catalog_base = the card's base price entry; event_price_list = the event's legacy list for the currency; package = covered by the booth package; individual = a price entered on the project (container). */
  detail: "booth_base" | "catalog_base" | "event_price_list" | "package" | "individual" | "technical_service";
  priceListId?: string;
}>;

export type ProjectPriceLine = Readonly<{
  /** Stable identity of the line inside the project (future manual prices and snapshots key on it). */
  key: string;
  kind: ProjectPriceLineKind;
  itemId: string;
  internalCode?: string;
  name: string;
  unit: string;
  quantity: number;
  status: ProjectPriceLineStatus;
  /** Present for priced / included lines only. */
  unitPriceNet?: number;
  totalNet?: number;
  source: ProjectPriceSource;
  sceneLayer?: SceneLayer;
  missingReason?: ProjectPriceMissingReason;
  warning?: string;
}>;

export type ProjectPricingTotals = Readonly<{ net: number; vat: number; gross: number; vatRatePercent: number }>;

export type ProjectPricingResult = Readonly<{
  currency: Currency;
  lines: readonly ProjectPriceLine[];
  totals: ProjectPricingTotals;
  /** Lines with status "missing" — when > 0 the total is NOT the full price. */
  missingCount: number;
  warnings: readonly string[];
}>;

export type ProjectPricingSource = Readonly<{
  currency: Currency;
  booth?: BoothType;
  event?: Exhibition;
  priceLists: readonly PriceList[];
  sceneObjects: readonly PlacedComponent[];
  requirements: TechnicalRequirements;
  printSurfaceAssignments: readonly PrintSurfaceAssignment[];
  /** Production-dimension profile for the full-wrap quantity (unchanged legacy behaviour). */
  realizationProfileId: string;
  /** Catalog cards used to price scene objects and services — see legacyPricingCatalogItems. */
  catalogItems: readonly ComponentDefinition[];
}>;

/** Technical markers whose price is a technical service, never the marker itself. */
const TECHNICAL_MARKER_LAYERS: readonly SceneLayer[] = ["electrical", "water", "waste", "annotations"];

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * The catalog cards every pricing caller must pass, in this order: DB technical items first (their
 * pricing entries come from the database), static seeds second. A first-match lookup must never
 * let a seed without prices shadow the database card with the same identity.
 */
export function legacyPricingCatalogItems(
  technicalCatalogItems: readonly ComponentDefinition[],
  seedCatalogItems: readonly ComponentDefinition[],
): readonly ComponentDefinition[] {
  return [...technicalCatalogItems, ...seedCatalogItems];
}

/**
 * Event + project currency -> the event's legacy price list (never another currency, never a
 * conversion). Unchanged from domain/calculationExport.ts so the graphics export keeps resolving
 * against the exact same context.
 */
export function resolvePricingContext(source: Readonly<{ event?: Exhibition; priceLists: readonly PriceList[]; currency: Currency }>) {
  return {
    priceListId: source.event ? resolveEventPriceListForCurrency(source.event, source.priceLists, source.currency)?.id : undefined,
    exhibitionId: source.event?.id,
    realizationCompanyId: source.event?.realizationCompanyId,
    currency: source.currency,
  } as const;
}

function boothLine(booth: BoothType, currency: Currency): ProjectPriceLine {
  const entry = getBasePricingEntry(booth.pricingEntries, currency);
  const common = { key: `booth:${booth.id}`, kind: "booth" as const, itemId: booth.id, ...(booth.internalCode ? { internalCode: booth.internalCode } : {}), name: booth.name, unit: "ks", quantity: 1, source: { model: "legacy" as const, detail: "booth_base" as const } };
  // "included" may carry no amount at all (pricing_entries_included_sale_price allows NULL) — still 0, never missing.
  if (entry?.priceMode === "included") return { ...common, status: "included", unitPriceNet: 0, totalNet: 0 };
  if (entry?.salePrice !== undefined && entry.priceMode !== "individual") return { ...common, status: "priced", unitPriceNet: entry.salePrice, totalNet: entry.salePrice };
  return { ...common, status: "missing", missingReason: entry?.priceMode === "individual" ? "individual_price" : "no_price" };
}

function sceneLines(sceneObjects: readonly PlacedComponent[], catalogItems: readonly ComponentDefinition[], currency: Currency): readonly ProjectPriceLine[] {
  const groups = new Map<string, { objects: PlacedComponent[]; definition?: ComponentDefinition }>();
  for (const sceneObject of sceneObjects) {
    const group = groups.get(sceneObject.definitionId) ?? { objects: [], definition: catalogItems.find((candidate) => candidate.id === sceneObject.definitionId) };
    group.objects.push(sceneObject);
    groups.set(sceneObject.definitionId, group);
  }
  return [...groups.entries()].map(([definitionId, group]): ProjectPriceLine => {
    const { definition } = group;
    const first = group.objects[0]!;
    const quantity = group.objects.length;
    const sceneLayer = first.sceneLayer ?? definition?.sceneLayer;
    const entry = getBasePricingEntry(definition?.pricingEntries, currency);
    const common = {
      key: `scene:${definitionId}`,
      kind: "scene_item" as const,
      itemId: definitionId,
      ...(definition?.internalCode ?? first.internalCode ? { internalCode: definition?.internalCode ?? first.internalCode } : {}),
      name: definition ? catalogDisplayName(definition) : first.name,
      unit: definition?.unit ?? "ks",
      quantity,
      ...(sceneLayer ? { sceneLayer } : {}),
      source: { model: "legacy" as const, detail: "catalog_base" as const },
    };
    if (entry?.priceMode === "included") return { ...common, status: "included", unitPriceNet: 0, totalNet: 0 };
    if (entry?.salePrice !== undefined && entry.priceMode !== "individual") {
      return { ...common, status: "priced", unitPriceNet: entry.salePrice, totalNet: round2(entry.salePrice * quantity) };
    }
    if (sceneLayer && TECHNICAL_MARKER_LAYERS.includes(sceneLayer)) {
      return { ...common, status: "not_billed", source: { model: "legacy", detail: "technical_service" } };
    }
    return { ...common, status: "missing", missingReason: entry?.priceMode === "individual" ? "individual_price" : "no_price" };
  });
}

function serviceLine(service: ServicePriceResult, priceListId: string | undefined): ProjectPriceLine {
  const individual = service.itemId === "service-container";
  const common = {
    key: `service:${service.itemId}`,
    kind: "service" as const,
    itemId: service.itemId,
    name: service.name,
    unit: service.unit,
    quantity: service.quantity,
    ...(service.warning ? { warning: service.warning } : {}),
  };
  if (service.status === "priced" && service.includedInPackage) {
    return { ...common, status: "included", unitPriceNet: 0, totalNet: 0, source: { model: "legacy", detail: "package" } };
  }
  if (service.status === "priced" && service.totalNet !== undefined) {
    return { ...common, status: "priced", unitPriceNet: service.unitPriceNet, totalNet: service.totalNet, source: individual ? { model: "legacy", detail: "individual" } : { model: "legacy", detail: "event_price_list", ...(priceListId ? { priceListId } : {}) } };
  }
  return { ...common, status: "missing", missingReason: "service_needs_quote", source: { model: "legacy", detail: individual ? "individual" : "event_price_list", ...(priceListId && !individual ? { priceListId } : {}) } };
}

/** The legacy project price — same lines and totals as the customer calculation always produced. */
export function priceProjectLegacy(source: ProjectPricingSource): ProjectPricingResult {
  const lines: ProjectPriceLine[] = [];
  // The Individual-mode booth is only the editor's workspace scaffold (domain/individualBooth.ts): it is priced by
  // its components, never as a booth line — otherwise it would show up as one more "K nacenění".
  if (source.booth && source.booth.projectType !== "individualni") lines.push(boothLine(source.booth, source.currency));
  lines.push(...sceneLines(source.sceneObjects, source.catalogItems, source.currency));
  const context = resolvePricingContext(source);
  const services = [
    priceCleaning(source.requirements, source.booth, source.catalogItems, context),
    priceElectricity(source.requirements, source.catalogItems, context),
    priceContainer(source.requirements, source.currency),
    ...priceGraphics(source.requirements, source.booth, source.printSurfaceAssignments, source.realizationProfileId, source.catalogItems, context),
  ].filter((service): service is ServicePriceResult => Boolean(service));
  lines.push(...services.map((service) => serviceLine(service, context.priceListId)));

  const net = round2(lines.reduce((sum, line) => sum + (line.status === "priced" || line.status === "included" ? line.totalNet ?? 0 : 0), 0));
  const tax = calculateNetVatGross(net, source.booth?.vatRatePercent ?? DEFAULT_CZ_VAT_RATE_PERCENT);
  const missingCount = lines.filter((line) => line.status === "missing").length;
  const warnings = [
    ...lines.flatMap((line) => (line.warning ? [line.warning] : [])),
    ...(missingCount ? [`${missingCount} ${missingCount === 1 ? "položka je" : missingCount < 5 ? "položky jsou" : "položek je"} k nacenění — celková cena není úplná.`] : []),
  ];
  return { currency: source.currency, lines, totals: { net, vat: tax.vat, gross: tax.gross, vatRatePercent: tax.vatRatePercent }, missingCount, warnings };
}

/** Lines of one area (used by the price bar and the summary). */
export function sumProjectLines(lines: readonly ProjectPriceLine[], predicate: (line: ProjectPriceLine) => boolean): Readonly<{ net: number; count: number; missing: number }> {
  const selected = lines.filter(predicate);
  return {
    net: round2(selected.reduce((sum, line) => sum + (line.status === "priced" || line.status === "included" ? line.totalNet ?? 0 : 0), 0)),
    count: selected.reduce((sum, line) => sum + line.quantity, 0),
    missing: selected.filter((line) => line.status === "missing").length,
  };
}

export const PROJECT_PRICE_STATUS_LABELS_CS: Readonly<Record<ProjectPriceLineStatus, string>> = {
  priced: "Ceníková cena",
  included: "V ceně stánku",
  missing: "K nacenění",
  not_billed: "Účtuje se v technických službách",
  manual: "Ruční cena",
};
