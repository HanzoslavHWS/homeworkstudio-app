import type {
  ComponentDimensions,
  Currency,
  Notes,
  PlacedComponent,
} from "./models.ts";
import {
  getNominalDimensions,
  getProductionDimensions,
} from "./production.ts";

export type ProjectExportSource = Readonly<{
  project: Notes & Readonly<{
    fairId: string;
    company: string;
    contact: string;
    currency: Currency;
    realizationProfileId: string;
  }>;
  booth: Notes & Readonly<{
    id: string;
    name: string;
    variantId?: string;
    constructionParts: readonly (Notes & Readonly<{
      id: string;
      name: string;
    }>)[];
  }>;
  components: readonly PlacedComponent[];
}>;

export type CustomerExportComponent = Readonly<{
  id: string;
  definitionId: string;
  name: string;
  type: string;
  xMm: number;
  yMm: number;
  rotationDeg: number;
  dimensions: ComponentDimensions;
  customerNote: string;
}>;

export function createCustomerExportData(source: ProjectExportSource) {
  return {
    project: {
      fairId: source.project.fairId,
      company: source.project.company,
      contact: source.project.contact,
      currency: source.project.currency,
      customerNote: source.project.customerNote,
    },
    booth: {
      id: source.booth.id,
      name: source.booth.name,
      variantId: source.booth.variantId,
      customerNote: source.booth.customerNote,
      constructionParts: source.booth.constructionParts.map((part) => ({
        id: part.id,
        name: part.name,
        customerNote: part.customerNote,
      })),
    },
    components: source.components.map(
      (component): CustomerExportComponent => ({
        id: component.id,
        definitionId: component.definitionId,
        name: component.name,
        type: component.type,
        xMm: component.xMm,
        yMm: component.yMm,
        rotationDeg: component.rotationDeg,
        dimensions: getNominalDimensions(component),
        customerNote: component.customerNote,
      }),
    ),
  };
}

export function createInternalExportData(source: ProjectExportSource) {
  return {
    project: source.project,
    booth: {
      ...source.booth,
      constructionParts: source.booth.constructionParts.map((part) => ({
        ...part,
      })),
    },
    components: source.components.map((component) => ({
      ...component,
      nominalDimensions: getNominalDimensions(component),
      productionDimensions: getProductionDimensions(
        component,
        source.project.realizationProfileId,
      ),
    })),
  };
}
