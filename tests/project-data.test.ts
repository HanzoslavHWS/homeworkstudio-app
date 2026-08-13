import assert from "node:assert/strict";
import test from "node:test";

import { boothTypes } from "../data/booths.ts";
import { componentCatalog, placeComponent } from "../data/components.ts";
import {
  DEFAULT_REALIZATION_PROFILE_ID,
  realizationProfiles,
} from "../data/realizationProfiles.ts";
import {
  createCustomerExportData,
  createInternalExportData,
  type ProjectExportSource,
} from "../domain/exports.ts";
import { getProductionDimensions } from "../domain/production.ts";
import { createEmptyNotes } from "../domain/notes.ts";
import { isPlacementValid } from "../geometry/placement.ts";

const booth = boothTypes.find((item) => item.id === "koje-2x2");

if (!booth) {
  throw new Error("Testovací definice Koje 2 × 2 nebyla nalezena.");
}

test("nový projekt používá Default realizačku", () => {
  assert.equal(DEFAULT_REALIZATION_PROFILE_ID, "default");
  assert.equal(realizationProfiles[0]?.id, DEFAULT_REALIZATION_PROFILE_ID);
  assert.equal(realizationProfiles[0]?.name, "Default");
});

test("změna realizačky nemění world geometrii komponenty", () => {
  const component = placeComponent(
    componentCatalog.cabinet,
    "cabinet-production-geometry",
    1100,
    1400,
  );
  const geometryBefore = {
    xMm: component.xMm,
    yMm: component.yMm,
    widthMm: component.widthMm,
    depthMm: component.depthMm,
    rotationDeg: component.rotationDeg,
  };

  getProductionDimensions(component, "realization-3");

  assert.deepEqual(
    {
      xMm: component.xMm,
      yMm: component.yMm,
      widthMm: component.widthMm,
      depthMm: component.depthMm,
      rotationDeg: component.rotationDeg,
    },
    geometryBefore,
  );
});

test("změna realizačky nemění collision geometrii", () => {
  const component = placeComponent(
    componentCatalog.chair,
    "chair-production-collision",
    1000,
    1500,
  );
  const placement = {
    x: component.xMm,
    y: component.yMm,
    rotationDeg: component.rotationDeg,
  };
  const before = isPlacementValid(booth, component, placement);

  getProductionDimensions(component, "realization-4");

  assert.equal(isPlacementValid(booth, component, placement), before);
});

test("bez production override se použije nominální rozměr", () => {
  const component = placeComponent(
    componentCatalog.cabinet,
    "cabinet-production-fallback",
    1100,
    1400,
  );
  const dimensions = getProductionDimensions(component, "realization-2");

  assert.equal(dimensions.widthMm, component.widthMm);
  assert.equal(dimensions.depthMm, component.depthMm);
  assert.equal(dimensions.heightMm, component.heightMm);
});

test("production override vrátí realizačně specifický exportní rozměr", () => {
  const definitionWithOverride = {
    ...componentCatalog.cabinet,
    productionProfiles: {
      "realization-2": {
        exportWidthMm: 790,
        exportDepthMm: 390,
        exportHeightMm: 2100,
      },
    },
  };
  const component = placeComponent(
    definitionWithOverride,
    "cabinet-production-override",
    1100,
    1400,
  );
  const dimensions = getProductionDimensions(component, "realization-2");

  assert.deepEqual(dimensions, {
    widthMm: 790,
    depthMm: 390,
    heightMm: 2100,
  });
  assert.equal(component.widthMm, componentCatalog.cabinet.widthMm);
  assert.equal(component.depthMm, componentCatalog.cabinet.depthMm);
});

function exportSource(component = placeComponent(
  componentCatalog.chair,
  "chair-export",
  1000,
  1500,
)): ProjectExportSource {
  return {
    project: {
      ...createEmptyNotes(),
      fairId: "for-beauty-autumn-2026",
      company: "Studio",
      contact: "kontakt@example.test",
      currency: "CZK",
      realizationProfileId: "realization-2",
    },
    booth: {
      ...createEmptyNotes(),
      id: booth.id,
      name: booth.name,
      constructionParts: booth.constructionParts.map((part) => ({
        ...createEmptyNotes(),
        id: part.id,
        name: part.name,
      })),
    },
    components: [component],
  };
}

test("customer export data neobsahují internalNote", () => {
  const component = {
    ...placeComponent(componentCatalog.chair, "chair-customer-export", 1000, 1500),
    internalNote: "Interní výrobní informace",
    customerNote: "Text pro zákazníka",
  };
  const exported = createCustomerExportData(exportSource(component));

  assert.equal("internalNote" in exported.components[0]!, false);
  assert.equal(exported.components[0]?.customerNote, "Text pro zákazníka");
  assert.equal(JSON.stringify(exported).includes("purchasePrice"), false);
  assert.equal(JSON.stringify(exported).includes("170"), false);
});

test("internal export data mohou obsahovat internalNote", () => {
  const component = {
    ...placeComponent(componentCatalog.chair, "chair-internal-export", 1000, 1500),
    internalNote: "Interní výrobní informace",
    customerNote: "Text pro zákazníka",
  };
  const exported = createInternalExportData(exportSource(component));

  assert.equal(
    exported.components[0]?.internalNote,
    "Interní výrobní informace",
  );
  assert.equal(exported.project.realizationProfileId, "realization-2");
});

test("poznámky jsou uložené na konkrétní instanci PlacedComponent", () => {
  const firstChair = {
    ...placeComponent(componentCatalog.chair, "chair-note-1", 800, 1500),
    internalNote: "První kus",
    customerNote: "Vlevo",
  };
  const secondChair = {
    ...placeComponent(componentCatalog.chair, "chair-note-2", 1300, 1500),
    internalNote: "Druhý kus",
    customerNote: "Vpravo",
  };

  assert.notEqual(firstChair.internalNote, secondChair.internalNote);
  assert.notEqual(firstChair.customerNote, secondChair.customerNote);
  assert.equal(firstChair.definitionId, secondChair.definitionId);
});
