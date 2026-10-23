import type {
  BoothType,
  ComponentDefinition,
  Currency,
  PlacedComponent,
} from "./models.ts";
import type { Exhibition, PriceList } from "./organizations.ts";
import type {
  ExportCalculationOptions,
  GeneratedPlanOutput,
  PrintSurfaceAssignment,
  ProjectContact,
  TechnicalRequirements,
  VisualizationItem,
} from "./project.ts";
import { priceProjectLegacy, resolvePricingContext, type ProjectPriceLine, type ProjectPriceLineStatus, type ProjectPricingResult } from "./projectPricing.ts";
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
  /** priced / included / missing ("K nacenění", amounts undefined) / not_billed (technical marker, priced as a service). */
  status: ProjectPriceLineStatus;
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
  /** Lines without a price in the current source ("K nacenění"); > 0 means the total is not complete. */
  missingCount: number;
  /** The shared project pricing result (domain/projectPricing.ts) — the same one the editor price bar shows. */
  pricing: ProjectPricingResult;
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
  /** Report Graphics Export v1.1: priceGraphics needs this for resolveProductionPrintSurface (full-wrap quantity) — distinct from pricingContext.realizationCompanyId below, which is a pricing-lookup dimension, not the production-dimension profile. */
  realizationProfileId: string;
  processedAt?: string;
}>;

/** Event + project currency -> legacy PriceList context; moved to domain/projectPricing.ts (re-exported for existing callers such as the graphics export). */
export { resolvePricingContext };

function priceRowOf(line: ProjectPriceLine, source: CustomerCalculationSource): CustomerCalculationPriceRow {
  const notes = line.kind === "scene_item" && source.options.includeItemNotes
    ? [...new Set(source.sceneObjects.filter((scene) => scene.definitionId === line.itemId && scene.customerNote.trim()).map((scene) => scene.customerNote.trim()))]
    : undefined;
  return {
    // Same row ids as before 07-B1 (booth-<id>, catalog item id, service id).
    id: line.kind === "booth" ? `booth-${line.itemId}` : line.itemId,
    name: line.name,
    unit: line.unit,
    quantity: line.quantity,
    status: line.status,
    ...(line.status === "priced" || line.status === "included" ? { unitPriceNet: line.unitPriceNet, totalNet: line.totalNet } : {}),
    ...(line.status === "included" ? { includedInPackage: true } : {}),
    ...(notes ? { customerNotes: notes } : {}),
    ...(line.warning ? { warning: line.warning } : {}),
  };
}

export function createCustomerCalculationViewModel(
  source: CustomerCalculationSource,
): CustomerCalculationViewModel {
  const outputs = selectCalculationOutputs(
    [...source.generatedPlanOutputs, ...source.visualizations],
    source.options.selectedOutputIds,
  );
  // 07-B1: the rows and totals come from the shared project pricing (same legacy rules and amounts
  // as before; a missing price is now reported as "K nacenění" instead of a silent 0).
  const pricing = priceProjectLegacy(source);
  const rows = pricing.lines.map((line) => priceRowOf(line, source));
  const warnings = pricing.warnings;
  const net = pricing.totals.net;
  const tax = pricing.totals;
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
    missingCount: pricing.missingCount,
    pricing,
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
