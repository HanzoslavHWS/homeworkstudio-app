import type {
  BoothType,
  ComponentDefinition,
  Currency,
  PricingEntry,
  PrintSurface,
} from "./models.ts";
import type {
  PrintSurfaceAssignment,
  TechnicalRequirement,
  TechnicalRequirements,
} from "./project.ts";
import { nominalAreaSquareMeters } from "./finishes.ts";
import { selectPricingEntry, type PricingContext } from "./catalog.ts";

export const TECHNICAL_SERVICE_IDS = {
  cleaningOneTime: "service-cleaning-one-time",
  cleaningDaily: "service-cleaning-daily",
  fasciaGraphics: "service-graphics-fascia",
  fullWrapGraphics: "service-graphics-full-wrap",
} as const;

export type EffectiveRequirement = Readonly<{
  requested: TechnicalRequirement["status"];
  effective: TechnicalRequirement["status"] | "included";
  includedInPackage: boolean;
  message?: string;
}>;

export function boothIncludesPrintSurface(
  booth: BoothType | undefined,
  printSurfaceId: string,
): boolean {
  return Boolean(
    booth?.packageContents?.some(
      (item) =>
        item.kind === "print-allowance" &&
        item.printSurfaceId === printSurfaceId &&
        item.includedInBasePrice,
    ),
  );
}

export function effectiveFasciaRequirement(
  requirement: TechnicalRequirement,
  booth: BoothType | undefined,
): EffectiveRequirement {
  const fascia = booth?.printSurfaces?.find(
    (surface) =>
      surface.active &&
      (surface.pricingUnit === "bm" || surface.allowanceLinearMeters !== undefined),
  );
  const included = Boolean(
    fascia && boothIncludesPrintSurface(booth, fascia.id),
  );
  return included
    ? {
        requested: requirement.status,
        effective: "included",
        includedInPackage: true,
        message: `Grafika límce je součástí vybraného stánku ${booth?.internalCode ?? booth?.code}. Stav je Objednáno – v ceně stánku.`,
      }
    : {
        requested: requirement.status,
        effective: requirement.status,
        includedInPackage: false,
      };
}

export type ServicePriceResult = Readonly<{
  status: "priced" | "not-requested" | "needs-quote";
  itemId: string;
  name: string;
  unit: string;
  quantity: number;
  unitPriceNet?: number;
  totalNet?: number;
  warning?: string;
  includedInPackage?: boolean;
}>;

function priceFor(
  definition: ComponentDefinition | undefined,
  context: PricingContext,
): PricingEntry | undefined {
  return definition
    ? selectPricingEntry(definition.pricingEntries ?? [], context)
    : undefined;
}

export function priceCleaning(
  requirements: TechnicalRequirements,
  booth: BoothType | undefined,
  catalogItems: readonly ComponentDefinition[],
  context: PricingContext,
): ServicePriceResult | undefined {
  const request = requirements.cleaning;
  if (["unspecified", "notWanted"].includes(request.status)) return undefined;
  const itemId = request.status === "daily"
    ? TECHNICAL_SERVICE_IDS.cleaningDaily
    : TECHNICAL_SERVICE_IDS.cleaningOneTime;
  const definition = catalogItems.find((item) => item.id === itemId);
  const area = booth?.nominalDimensions
    ? nominalAreaSquareMeters(booth.nominalDimensions)
    : booth?.widthMm && booth.depthMm
      ? nominalAreaSquareMeters({ widthMm: booth.widthMm, depthMm: booth.depthMm })
      : 0;
  if (request.status === "inquire") {
    return { status: "needs-quote", itemId, name: "Úklid", unit: "m²", quantity: area, warning: "Úklid – nutno nacenit podle aktivního ceníku" };
  }
  const entry = priceFor(definition, context);
  const multiplier = request.status === "daily" ? request.dayCount : 1;
  if (entry?.salePrice === undefined || !area || !multiplier) {
    return {
      status: "needs-quote",
      itemId,
      name: definition?.name ?? "Úklid",
      unit: request.status === "daily" ? "m²/den" : "m²",
      quantity: area,
      warning: request.status === "daily" && !request.dayCount
        ? "Denní úklid – chybí počet dnů / multiplier z ceníku"
        : "Úklid – chybí sazba v aktivním ceníku",
    };
  }
  return {
    status: "priced",
    itemId,
    name: definition?.name ?? "Úklid",
    unit: request.status === "daily" ? "m²/den" : "m²",
    quantity: area * multiplier,
    unitPriceNet: entry.salePrice,
    totalNet: area * multiplier * entry.salePrice,
  };
}

export function priceContainer(
  requirements: TechnicalRequirements,
  currency: Currency,
): ServicePriceResult | undefined {
  const request = requirements.container;
  if (["unspecified", "notWanted"].includes(request.status)) return undefined;
  if (request.individualPriceNet === undefined) {
    return { status: "needs-quote", itemId: "service-container", name: "Kontejner", unit: "ks", quantity: 1, warning: "Kontejner – nutno nacenit individuálně" };
  }
  return { status: "priced", itemId: "service-container", name: `Kontejner${request.volumeSize ? ` · ${request.volumeSize}` : ""}`, unit: "ks", quantity: 1, unitPriceNet: request.individualPriceNet, totalNet: request.individualPriceNet };
}

export function fasciaQuantityBm(surfaces: readonly PrintSurface[]): number {
  return surfaces
    .filter((surface) => surface.active && (surface.pricingUnit === "bm" || surface.allowanceLinearMeters !== undefined))
    .reduce((sum, surface) => sum + (surface.allowanceLinearMeters ?? surface.widthMm / 1000), 0);
}

export function fullWrapQuantitySquareMeters(
  assignments: readonly PrintSurfaceAssignment[],
): number {
  return assignments
    .filter((assignment) => assignment.graphicsKind === "fullWrap" && assignment.selectedForPrint)
    .reduce((sum, assignment) => sum + assignment.canonicalWidthMm * assignment.canonicalHeightMm / 1_000_000, 0);
}

export function priceGraphics(
  requirements: TechnicalRequirements,
  booth: BoothType | undefined,
  assignments: readonly PrintSurfaceAssignment[],
  catalogItems: readonly ComponentDefinition[],
  context: PricingContext,
): readonly ServicePriceResult[] {
  const results: ServicePriceResult[] = [];
  const effectiveFascia = effectiveFasciaRequirement(requirements.fasciaGraphics, booth);
  if (effectiveFascia.includedInPackage) {
    results.push({ status: "priced", itemId: TECHNICAL_SERVICE_IDS.fasciaGraphics, name: "Grafika – límec", unit: "bm", quantity: fasciaQuantityBm(booth?.printSurfaces ?? []), unitPriceNet: 0, totalNet: 0, includedInPackage: true });
  } else if (!["unspecified", "notWanted"].includes(requirements.fasciaGraphics.status)) {
    const quantity = fasciaQuantityBm(booth?.printSurfaces ?? []);
    const definition = catalogItems.find((item) => item.id === TECHNICAL_SERVICE_IDS.fasciaGraphics);
    const entry = priceFor(definition, context);
    results.push(entry?.salePrice !== undefined && quantity > 0
      ? { status: "priced", itemId: definition!.id, name: definition!.name, unit: "bm", quantity, unitPriceNet: entry.salePrice, totalNet: quantity * entry.salePrice }
      : { status: "needs-quote", itemId: TECHNICAL_SERVICE_IDS.fasciaGraphics, name: "Grafika – límec", unit: "bm", quantity, warning: quantity ? "Grafika límce – chybí sazba v aktivním ceníku" : "Vybraný stánek nemá tiskovou plochu límce" });
  }
  if (!["unspecified", "notWanted"].includes(requirements.fullWrapGraphics.status)) {
    const quantity = fullWrapQuantitySquareMeters(assignments);
    const definition = catalogItems.find((item) => item.id === TECHNICAL_SERVICE_IDS.fullWrapGraphics);
    const entry = priceFor(definition, context);
    results.push(entry?.salePrice !== undefined && quantity > 0
      ? { status: "priced", itemId: definition!.id, name: definition!.name, unit: "m²", quantity, unitPriceNet: entry.salePrice, totalNet: quantity * entry.salePrice }
      : { status: "needs-quote", itemId: TECHNICAL_SERVICE_IDS.fullWrapGraphics, name: "Grafika – celopolep", unit: "m²", quantity, warning: quantity ? "Celopolep – chybí sazba v aktivním ceníku" : "Celopolep – nejsou vybrané žádné tiskové plochy" });
  }
  return results;
}

export function productionPrintSurfaceDimensions(
  surface: PrintSurface,
  realizationProfileId: string,
) {
  const override = surface.productionProfiles?.[realizationProfileId];
  return {
    widthMm: override?.widthMm ?? surface.widthMm,
    heightMm: override?.heightMm ?? surface.heightMm,
  };
}

export function printSurfaceProductionStatus(
  requirement: TechnicalRequirement["status"],
  artworkStatus: PrintSurfaceAssignment["artworkStatus"],
): "not-ready" | "waiting-for-data" | "data-received" | "ready" {
  if (["unspecified", "notWanted", "inquire"].includes(requirement)) return "not-ready";
  if (requirement === "ready" || artworkStatus === "ready") return "ready";
  if (requirement === "dataReceived" || artworkStatus === "received") return "data-received";
  return "waiting-for-data";
}

export type PrintSurfaceExportRow = Readonly<{
  order: number;
  printSurfaceId: string;
  name: string;
  canonicalDimensions: string;
  productionDimensions: string;
  unit: string;
  orientation: string;
  artworkStatus: string;
  artworkFileId?: string;
  includedInPackage: boolean;
  pricedSeparately: boolean;
  pricingBasis: "bm" | "m²";
}>;

export function createPrintSurfaceExportRows(
  surfaces: readonly PrintSurface[],
  assignments: readonly PrintSurfaceAssignment[],
): readonly PrintSurfaceExportRow[] {
  return assignments
    .filter((assignment) => assignment.selectedForPrint)
    .map((assignment, index) => {
      const surface = surfaces.find((item) => item.id === assignment.printSurfaceId);
      return {
        order: index + 1,
        printSurfaceId: assignment.printSurfaceId,
        name: surface?.name ?? assignment.printSurfaceId,
        canonicalDimensions: `${assignment.canonicalWidthMm} × ${assignment.canonicalHeightMm} mm`,
        productionDimensions: `${assignment.productionWidthMm} × ${assignment.productionHeightMm} mm`,
        unit: surface?.pricingUnit ?? (assignment.graphicsKind === "fascia" ? "bm" : "m²"),
        orientation: surface?.orientation ?? "custom",
        artworkStatus: assignment.artworkStatus,
        artworkFileId: assignment.artworkFileId,
        includedInPackage: assignment.includedInPackage,
        pricedSeparately: assignment.pricedSeparately,
        pricingBasis: assignment.graphicsKind === "fascia" ? "bm" : "m²",
      };
    });
}
