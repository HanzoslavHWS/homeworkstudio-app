import type {
  BoothType,
  ComponentDefinition,
  Currency,
  PlacedComponent,
} from "./models.ts";
import type { Exhibition, PriceList } from "./organizations.ts";
import { resolveEventPriceListForCurrency } from "./organizations.ts";
import type {
  ExportCalculationOptions,
  GeneratedPlanOutput,
  PrintSurfaceAssignment,
  ProjectContact,
  TechnicalRequirements,
  VisualizationItem,
} from "./project.ts";
import { getBasePricingEntry, groupCatalogSceneItems } from "./catalog.ts";
import { calculateNetVatGross } from "./pricing.ts";
import { priceCleaning, priceContainer, priceElectricity, priceGraphics } from "./technicalServices.ts";
import type { StoredAsset } from "./assets.ts";

export type CalculationImageLayout = "one" | "two" | "three" | "four";

export function calculationImageLayout(count: number): CalculationImageLayout {
  if (count <= 1) return "one";
  if (count === 2) return "two";
  if (count === 3) return "three";
  return "four";
}

export function selectCalculationOutputs(
  outputs: readonly (GeneratedPlanOutput | VisualizationItem)[],
  selectedIds: readonly string[],
) {
  const existing = new Map(outputs.map((output) => [output.id, output]));
  const explicit = selectedIds
    .map((id) => existing.get(id))
    .filter((output): output is GeneratedPlanOutput | VisualizationItem => Boolean(output))
    .slice(0, 4);
  if (explicit.length) return explicit;
  return [...outputs]
    .sort((a, b) => Number(b.reviewStatus === "reviewed") - Number(a.reviewStatus === "reviewed"))
    .slice(0, 4);
}

export type CustomerCalculationPriceRow = Readonly<{
  id: string;
  name: string;
  unit: string;
  quantity: number;
  unitPriceNet?: number;
  totalNet?: number;
  customerNotes?: readonly string[];
  includedInPackage?: boolean;
  warning?: string;
}>;

export type CustomerCalculationViewModel = Readonly<{
  documentTitle: string;
  processedAt: string;
  processor?: ProjectContact;
  project: Readonly<{
    company: string;
    exhibitionSize: string;
    eventName: string;
    eventDate: string;
    customerNote?: string;
  }>;
  logoUrl?: string;
  logoAsset?: StoredAsset;
  images: readonly Readonly<{
    id: string;
    name: string;
    imageDataUrl: string;
    reviewed: boolean;
  }>[];
  imageLayout: CalculationImageLayout;
  priceRows: readonly CustomerCalculationPriceRow[];
  warnings: readonly string[];
  totals: Readonly<{
    net: number;
    vat?: number;
    gross?: number;
    vatRatePercent?: number;
  }>;
  options: ExportCalculationOptions;
}>;

export type CustomerCalculationSource = Readonly<{
  company: string;
  customerProjectNote: string;
  processor?: ProjectContact;
  currency: Currency;
  booth?: BoothType;
  event?: Exhibition;
  sceneObjects: readonly PlacedComponent[];
  requirements: TechnicalRequirements;
  printSurfaceAssignments: readonly PrintSurfaceAssignment[];
  generatedPlanOutputs: readonly GeneratedPlanOutput[];
  visualizations: readonly VisualizationItem[];
  options: ExportCalculationOptions;
  catalogItems: readonly ComponentDefinition[];
  /** Needed to resolve the event's PriceList for THIS project's currency (see pricingContext below) — never just event.defaultPriceListId, which is always the CZK list regardless of project currency. */
  priceLists: readonly PriceList[];
  processedAt?: string;
}>;

export function createCustomerCalculationViewModel(
  source: CustomerCalculationSource,
): CustomerCalculationViewModel {
  const outputs = selectCalculationOutputs(
    [...source.generatedPlanOutputs, ...source.visualizations],
    source.options.selectedOutputIds,
  );
  const rows: CustomerCalculationPriceRow[] = [];
  const warnings: string[] = [];
  const boothPrice = getBasePricingEntry(source.booth?.pricingEntries, source.currency);
  if (source.booth && boothPrice?.salePrice !== undefined) {
    rows.push({ id: `booth-${source.booth.id}`, name: source.booth.name, unit: "ks", quantity: 1, unitPriceNet: boothPrice.salePrice, totalNet: boothPrice.salePrice });
  }
  const groupedFurniture = groupCatalogSceneItems(source.sceneObjects, source.catalogItems, source.currency);
  for (const item of groupedFurniture) {
    const notes = source.sceneObjects
      .filter((scene) => scene.definitionId === item.catalogItemId && scene.customerNote.trim())
      .map((scene) => scene.customerNote.trim());
    rows.push({
      id: item.catalogItemId,
      name: item.displayName,
      unit: item.unit,
      quantity: item.quantity,
      unitPriceNet: item.saleUnitNet,
      totalNet: item.saleTotalNet,
      customerNotes: source.options.includeItemNotes ? [...new Set(notes)] : undefined,
    });
  }
  // Section 8: event + project currency -> PriceList, never event.defaultPriceListId (that's
  // always the CZK list regardless of which currency this project actually uses — see
  // resolveEventPriceListForCurrency's own doc for why the two must never be conflated). No
  // fallback to the other currency's list, no conversion — an event with no PriceList yet in
  // this currency correctly yields priceListId: undefined, and every service below then
  // reports "missing"/needs-quote rather than silently pricing against the wrong list.
  const pricingContext = {
    priceListId: source.event ? resolveEventPriceListForCurrency(source.event, source.priceLists, source.currency)?.id : undefined,
    exhibitionId: source.event?.id,
    realizationCompanyId: source.event?.realizationCompanyId,
    currency: source.currency,
  } as const;
  const services = [
    priceCleaning(source.requirements, source.booth, source.catalogItems, pricingContext),
    priceElectricity(source.requirements, source.catalogItems, pricingContext),
    priceContainer(source.requirements, source.currency),
    ...priceGraphics(source.requirements, source.booth, source.printSurfaceAssignments, source.catalogItems, pricingContext),
  ].filter((service): service is NonNullable<typeof service> => Boolean(service));
  for (const service of services) {
    rows.push({ id: service.itemId, name: service.name, unit: service.unit, quantity: service.quantity, unitPriceNet: service.unitPriceNet, totalNet: service.totalNet, includedInPackage: service.includedInPackage, warning: service.warning });
    if (service.warning) warnings.push(service.warning);
  }
  const net = rows.reduce((sum, row) => sum + (row.totalNet ?? 0), 0);
  const vatRate = source.booth?.vatRatePercent ?? 21;
  const tax = calculateNetVatGross(net, vatRate);
  return {
    documentTitle: "Kalkulace / nabídka",
    processedAt: source.processedAt ?? new Date().toISOString(),
    processor: source.options.includeContact ? source.processor : undefined,
    project: {
      company: source.company,
      exhibitionSize: source.booth ? `${source.booth.name} · ${source.booth.size}` : "—",
      eventName: source.event?.name ?? "—",
      eventDate: eventDate(source.event),
      customerNote: source.options.includeProjectNote && source.customerProjectNote.trim() ? source.customerProjectNote.trim() : undefined,
    },
    logoUrl: source.options.includeEventLogo ? source.event?.logoUrl : undefined,
    logoAsset: source.options.includeEventLogo ? source.event?.logoAsset : undefined,
    images: source.options.includeVisuals ? outputs.map((output) => ({ id: output.id, name: output.name, imageDataUrl: output.imageDataUrl, reviewed: output.reviewStatus === "reviewed" })) : [],
    imageLayout: calculationImageLayout(source.options.includeVisuals ? outputs.length : 0),
    priceRows: source.options.includePricingTable ? rows : [],
    warnings,
    totals: source.options.includePricingTable
      ? source.options.includeVatSummary
        ? tax
        : { net }
      : { net: 0 },
    options: source.options,
  };
}

function eventDate(event: Exhibition | undefined): string {
  if (!event?.eventFrom && !event?.eventTo) return "—";
  return [event.eventFrom, event.eventTo].filter(Boolean).join("–");
}
