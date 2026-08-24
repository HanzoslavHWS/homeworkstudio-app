import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { componentCatalog, componentCatalogItems, placeComponent } from "../data/components.ts";
import {
  catalogImageUrl,
  getBasePricingEntry,
  groupCatalogSceneItems,
  loadCatalogPhoto,
  matchCatalogItem,
  normalizeCatalogCode,
  selectPricingEntry,
} from "../domain/catalog.ts";
import { calculateOrderInventory, reconcileOrderLines } from "../domain/order.ts";
import {
  createDefaultTechnicalRequirements,
  createProjectRecord,
  normalizeProjectRecord,
  deleteGeneratedOutput,
  renameGeneratedOutput,
  setGeneratedOutputReview,
  CURRENT_PROJECT_SCHEMA_VERSION,
  type ImportedOrder,
} from "../domain/project.ts";
import {
  LocalProjectRepository,
  type KeyValueStorage,
} from "../domain/repository.ts";
import { saveCameraView, sceneObjectsForLayers } from "../domain/workflow.ts";
import {
  EXPORT_PRESETS,
  type ExportOptions,
} from "../domain/workflow.ts";
import { exhibitions, priceLists } from "../data/organizations.ts";
import {
  PROJECT_PACKAGE_FOLDERS,
  createProjectPackage,
  packageFolderPath,
} from "../domain/projectPackage.ts";
import type {
  ComponentDefinition,
  PartDefinition,
  PrintSurface,
} from "../domain/models.ts";
import {
  filterProjects,
  matchesBoothSearch,
  matchesCatalogSearch,
} from "../domain/search.ts";
import {
  planViewToWorld,
  worldToPlanView,
} from "../domain/planView.ts";
import { boothTypes } from "../data/booths.ts";
import { createZip, textZipEntry } from "../lib/zip.ts";
import {
  categoryOptions,
  filterCatalogCategory,
} from "../domain/catalogCategories.ts";
import {
  carpetFinishVariants,
  constructionFinishVariants,
  NO_CARPET_FINISH_ID,
  nominalAreaSquareMeters,
} from "../domain/finishes.ts";
import {
  createCustomDimension,
  dimensionDisplayLabel,
  measuredDistanceMm,
} from "../domain/spatialAnnotations.ts";
import {
  EMAIL_TOPICS,
  RuleBasedEmailDraftProvider,
} from "../domain/communication.ts";
import { EXPORT_LAYER_LABELS } from "../domain/workflow.ts";
import { constructionMaterialOverrides } from "../domain/materialOverrides.ts";
import { calculateMarginDelta, calculateNetVatGross } from "../domain/pricing.ts";
import { LocalEventRepository } from "../domain/eventRepository.ts";
import { LocalPriceListRepository } from "../domain/priceListRepository.ts";
import { createEventDocumentsFromFiles, eventHasUnsavedChanges } from "../domain/organizations.ts";
import { cancelMeasurement, measurementClick, startMeasurement, updateMeasurementHover } from "../domain/spatialAnnotations.ts";
import {
  resolveBoothPlanGeometry,
  resolveBoothPlanPresentation,
  resolveBoothPlanVisualMode,
  shouldRenderBoothCollisionOverlay,
} from "../domain/boothPlan.ts";
import { collisionObstacleToPlanRect } from "../geometry/construction.ts";
import {
  createPlanRenderLayout,
  PLAN_RENDER_CONFIG,
  resolveTechnicalPlanContent,
} from "../lib/planExport.ts";

test("nový project model obsahuje stabilní výchozí údaje", () => {
  const project = createProjectRecord(
    { id: "project-1", name: "Test" },
    "2026-08-11T10:00:00.000Z",
  );
  assert.equal(project.id, "project-1");
  assert.equal(project.mode, "proposal");
  assert.equal(project.status, "draft");
  assert.equal(project.stage, "quote");
  assert.deepEqual(project.contact, { name: "", phone: "", email: "" });
  assert.equal(project.realizationProfileId, "default");
  assert.equal(project.createdAt, "2026-08-11T10:00:00.000Z");
  assert.deepEqual(project.sceneObjects, []);
});

test("project lifecycle stage je oddělený od projectMode a kontakt je strukturovaný", () => {
  const project = createProjectRecord({
    id: "lifecycle",
    mode: "production",
    stage: "approved",
    contact: {
      name: "Jana Nováková",
      phone: "+420 123 456 789",
      email: "jana@example.test",
    },
  });
  assert.equal(project.mode, "production");
  assert.equal(project.stage, "approved");
  assert.equal(project.contact.name, "Jana Nováková");
  assert.equal(project.contact.phone, "+420 123 456 789");
  assert.equal(project.contact.email, "jana@example.test");
});

test("technické požadavky používají jednotný status a elektro variantu", () => {
  const requirements = createDefaultTechnicalRequirements();
  assert.equal(requirements.electricity.status, "unspecified");
  assert.equal(requirements.electricity.powerOption, "");
  assert.equal(requirements.water.status, "unspecified");
  assert.equal(requirements.waste.status, "unspecified");
  assert.equal(requirements.graphics.status, "unspecified");
});

test("zásobník počítá objednáno, vloženo a zbývá bez paralelní scény", () => {
  const order: ImportedOrder = {
    id: "order-1",
    fileName: "order.xlsx",
    mimeType: "application/xlsx",
    importedAt: "2026-08-11T10:00:00.000Z",
    parserId: "test",
    status: "parsed",
    lines: [
      {
        id: "line-1",
        sourceCode: "M57",
        sourceName: "Židle kovová čalouněná",
        quantity: 4,
        unit: "ks",
        rawText: "M57 Židle kovová čalouněná 4 ks",
        mappedCatalogItemId: componentCatalog.chair.id,
        mappingStatus: "matched",
        itemType: "furniture",
      },
    ],
  };
  const scene = [
    placeComponent(componentCatalog.chair, "chair-1", 700, 1400),
    placeComponent(componentCatalog.chair, "chair-2", 1300, 1400),
    placeComponent(componentCatalog.electrical, "electro-1", 1000, 1000),
  ];
  assert.deepEqual(calculateOrderInventory(order, scene), [
    {
      catalogItemId: componentCatalog.chair.id,
      name: "Židle kovová čalouněná",
      ordered: 4,
      placed: 2,
      remaining: 2,
      extra: 0,
      difference: -2,
      status: "remaining",
    },
  ]);
});

test("pricing vybere nejkonkrétnější kontext a jinak base fallback", () => {
  const entries = [
    { id: "base", itemId: "chair", currency: "CZK" as const, salePrice: 100 },
    {
      id: "fair",
      itemId: "chair",
      exhibitionId: "fair-1",
      currency: "CZK" as const,
      salePrice: 120,
    },
    {
      id: "exact",
      itemId: "chair",
      exhibitionId: "fair-1",
      realizationCompanyId: "company-1",
      currency: "CZK" as const,
      salePrice: 130,
    },
  ];
  assert.equal(
    selectPricingEntry(entries, {
      exhibitionId: "fair-1",
      realizationCompanyId: "company-1",
      currency: "CZK",
    })?.id,
    "exact",
  );
  assert.equal(
    selectPricingEntry(entries, { exhibitionId: "fair-2", currency: "CZK" })?.id,
    "base",
  );
});

test("2D-only technický bod je ve scéně, ale není určený pro 3D", () => {
  const electrical = placeComponent(
    componentCatalog.electrical,
    "electrical-1",
    1000,
    1200,
  );
  assert.equal(electrical.showIn2D, true);
  assert.equal(electrical.showIn3D, false);
  assert.equal(electrical.sceneLayer, "electrical");
  assert.deepEqual(sceneObjectsForLayers([electrical], ["booth", "furniture"]), []);
  assert.deepEqual(sceneObjectsForLayers([electrical], ["electrical"]), [electrical]);
});

test("uložený pohled zachová kameru, target a FOV", () => {
  const view = saveCameraView(
    {
      name: "Hlavní",
      position: [4, 3, 4],
      target: [1, 1, -1],
      fov: 38,
    },
    "2026-08-11T10:00:00.000Z",
  );
  assert.deepEqual(view.position, [4, 3, 4]);
  assert.deepEqual(view.target, [1, 1, -1]);
  assert.equal(view.fov, 38);
  assert.equal(view.createdAt, "2026-08-11T10:00:00.000Z");
});

class MemoryStorage implements KeyValueStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

test("LocalProjectRepository umí CRUD a řadí podle poslední změny", async () => {
  const repository = new LocalProjectRepository(new MemoryStorage());
  const first = createProjectRecord(
    { id: "first", modifiedAt: "2026-01-01T00:00:00.000Z" },
    "2026-01-01T00:00:00.000Z",
  );
  const second = createProjectRecord(
    { id: "second", modifiedAt: "2026-02-01T00:00:00.000Z" },
    "2026-02-01T00:00:00.000Z",
  );
  await repository.save(first);
  await repository.save(second);
  assert.deepEqual((await repository.list()).map((project) => project.id), ["second", "first"]);
  assert.equal((await repository.get("first"))?.id, "first");
  await repository.save({ ...first, company: "Updated" });
  assert.equal((await repository.get("first"))?.company, "Updated");
  await repository.delete("first");
  assert.equal(await repository.get("first"), undefined);
});

test("event model odkazuje na samostatné ceníky", () => {
  const event = exhibitions[0]!;
  assert.equal(event.slug, "for-beauty-podzim-2026");
  assert.equal(event.logoUrl, "/events/for-beauty-podzim-2026/logo.png");
  assert.equal(event.active, true);
  assert.ok(event.priceListIds.length > 0);
  assert.ok(event.priceListIds.every((id) => priceLists.some((list) => list.id === id)));
  assert.equal(priceLists[0]?.currency, "CZK");
});

test("project package má stabilní číslovaný strom a vnořené cesty", () => {
  const projectPackage = createProjectPackage("project-1", "Projekt_Test");
  assert.equal(PROJECT_PACKAGE_FOLDERS[0]?.name, "01_Projekt");
  assert.equal(
    packageFolderPath(projectPackage, "graphics-input"),
    "Projekt_Test/04_Grafika/dodana_data",
  );
  assert.equal(
    packageFolderPath(projectPackage, "export-internal"),
    "Projekt_Test/06_Export/interni",
  );
});

test("export podporuje jazyk a rozšířené layer presety", () => {
  const options: ExportOptions = {
    layers: ["booth", "electrical"],
    background: "white",
    language: "en",
    includeFurniturePhotos: true,
  };
  assert.equal(options.language, "en");
  assert.equal(options.includeFurniturePhotos, true);
  assert.deepEqual(
    EXPORT_PRESETS.find((preset) => preset.id === "electrical-clean")?.options.layers,
    ["booth", "electrical"],
  );
});

test("print surface a GLB part role jsou explicitní metadata", () => {
  const surface: PrintSurface = {
    id: "surface-1",
    name: "Grafický panel",
    widthMm: 950,
    heightMm: 2340,
    nodeName: "print_surface",
    materialRole: "PRINT_SURFACE",
    orientation: "portrait",
    active: true,
  };
  const frame: PartDefinition = {
    id: "frame-1",
    nodeName: "frame",
    role: "frame",
    printable: false,
    materialRole: "OCTANORM_WHITE",
  };
  assert.equal(surface.materialRole, "PRINT_SURFACE");
  assert.equal(frame.printable, false);
  assert.equal(frame.materialRole, "OCTANORM_WHITE");
});

test("katalog podporuje oddělené thumbnail/photo/GLB/SKP reference", () => {
  const item = {
    ...componentCatalog.chair,
    thumbnailUrl: "/thumb.png",
    photoUrl: "/photo.jpg",
    modelUrl: "/model.glb",
    sketchupUrl: "/model.skp",
  };
  assert.equal(item.thumbnailUrl, "/thumb.png");
  assert.equal(item.photoUrl, "/photo.jpg");
  assert.equal(item.modelUrl, "/model.glb");
  assert.equal(item.sketchupUrl, "/model.skp");
});

test("search helpery filtrují projekty, stánky a katalog bez diakritiky", () => {
  const project = createProjectRecord({
    id: "search-project",
    company: "Žlutá firma",
    fairId: "event-1",
    boothId: "koje-2x2",
    stage: "design",
    requiresAction: true,
    contact: { name: "Petr Černý", phone: "", email: "" },
  });
  assert.equal(filterProjects([project], { query: "zluta", stage: "design", requiresAction: "yes" }).length, 1);
  assert.equal(filterProjects([project], { stage: "done" }).length, 0);
  assert.equal(matchesBoothSearch(boothTypes[0]!, "P86"), true);
  assert.equal(matchesCatalogSearch(componentCatalog.chair, "m57"), true);
});

test("2D plan-view transform (back wall at top) is a reversible, X-preserving view transformation", () => {
  const world = { x: 250, y: 1600 };
  const display = worldToPlanView(world, 2000, 2000);
  assert.deepEqual(display, { x: 250, y: 400 }, "X must be unchanged — only Y (depth-vs-screen-top) is flipped");
  assert.deepEqual(planViewToWorld(display, 2000, 2000), world);
  assert.deepEqual(world, { x: 250, y: 1600 });
});

test("T4 má čtyři samostatné varianty nad jediným assetem Koje 2×2", () => {
  const t4 = boothTypes.find((booth) => booth.id === "t4")!;
  const koje = boothTypes.find((booth) => booth.id === "koje-2x2")!;
  assert.equal(t4.variants.length, 4);
  assert.equal(t4.configReady, true);
  assert.ok(t4.variants.every((variant) => variant.configurationBoothId === koje.id));
  assert.equal(t4.assets, koje.assets);
});

test("starší local project se string kontaktem se bezpečně migruje", () => {
  const project = normalizeProjectRecord({
    id: "legacy",
    contact: "legacy@example.test",
  });
  assert.deepEqual(project.contact, {
    name: "",
    phone: "",
    email: "legacy@example.test",
  });
  assert.equal(project.stage, "quote");
});

test("lokální ZIP writer vytvoří skutečný ZIP pouze z předaných souborů", async () => {
  const zip = createZip([textZipEntry("Projekt/01_Projekt/souhrn.txt", "Obsah")]);
  const bytes = new Uint8Array(await zip.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  assert.equal(zip.type, "application/zip");
});

test("kategorie filtrují pouze fyzický katalog a zůstávají rozšiřitelné", () => {
  const categories = categoryOptions([
    componentCatalog.chair,
    componentCatalog.cabinet,
    componentCatalog.electrical,
  ]);
  assert.ok(categories.some((category) => category.id === "chairs"));
  assert.ok(categories.some((category) => category.id === "furniture"));
  assert.ok(categories.some((category) => category.id === "services"));
  assert.deepEqual(
    filterCatalogCategory(
      [componentCatalog.chair, componentCatalog.electrical],
      "chairs",
    ).map((item) => item.id),
    [componentCatalog.chair.id],
  );
});

test("order reconciliation rozlišuje deficit, shodu i položky navíc", () => {
  const order: ImportedOrder = {
    id: "reconcile",
    fileName: "order.csv",
    mimeType: "text/csv",
    importedAt: "2026-08-11T10:00:00.000Z",
    parserId: "test",
    status: "parsed",
    lines: [{
      id: "chairs",
      sourceCode: "M57",
      sourceName: "Židle kovová čalouněná",
      quantity: 2,
      unit: "ks",
      rawText: "M57 Židle kovová čalouněná 2",
      mappedCatalogItemId: componentCatalog.chair.id,
      mappingStatus: "matched",
      itemType: "furniture",
    }],
  };
  const chair = (id: string) => placeComponent(componentCatalog.chair, id, 500, 1500);
  assert.equal(calculateOrderInventory(order, [chair("1")])[0]?.status, "remaining");
  assert.equal(calculateOrderInventory(order, [chair("1"), chair("2")])[0]?.status, "complete");
  const extra = calculateOrderInventory(order, [chair("1"), chair("2"), chair("3")])[0]!;
  assert.equal(extra.status, "over");
  assert.equal(extra.extra, 1);
});

test("objednávku lze importovat až po vytvoření scény", () => {
  const scene = [
    placeComponent(componentCatalog.chair, "existing-1", 500, 1500),
    placeComponent(componentCatalog.chair, "existing-2", 1000, 1500),
  ];
  const order: ImportedOrder = {
    id: "late-order",
    fileName: "late.csv",
    mimeType: "text/csv",
    importedAt: "2026-08-11T10:00:00.000Z",
    parserId: "test",
    status: "parsed",
    lines: [{ id: "line", sourceCode: "M57", sourceName: "Židle kovová čalouněná", quantity: 2, unit: "ks", rawText: "M57 Židle kovová čalouněná 2", mappedCatalogItemId: componentCatalog.chair.id, mappingStatus: "matched", itemType: "furniture" }],
  };
  assert.equal(calculateOrderInventory(order, scene)[0]?.status, "complete");
});

test("project communicationLanguage má výchozí češtinu a lze jej změnit", () => {
  assert.equal(createProjectRecord({ id: "language-default" }).communicationLanguage, "cs");
  assert.equal(createProjectRecord({ id: "language-en", communicationLanguage: "en" }).communicationLanguage, "en");
});

test("T4 varianty mají významové názvy", () => {
  const t4 = boothTypes.find((booth) => booth.id === "t4")!;
  assert.deepEqual(t4.variants.map((variant) => variant.name), [
    "Rohový – levá stěna",
    "Rohový – pravá stěna",
    "Řadový – zázemí vlevo",
    "Řadový – zázemí vpravo",
  ]);
});

test("Event má fixed deadlines, media, realization a defaultní ceník", () => {
  const event = exhibitions[0]!;
  assert.ok("materialDataDeadline" in event);
  assert.ok("designApprovalDeadline" in event);
  assert.equal(event.realizationCompanyId, "default");
  assert.ok(event.defaultPriceListId);
  assert.ok(event.priceListIds.includes(event.defaultPriceListId!));
  assert.equal(event.coverImageUrl, "/events/for-beauty-podzim-2026/cover.png");
  assert.deepEqual(event.documents, []);
});

test("ceníky mají ročník a historické záznamy se nemažou", () => {
  assert.ok(priceLists.every((list) => Number.isInteger(list.year)));
  assert.ok(priceLists.some((list) => list.year === 2027 && !list.active));
});

test("EventDocument rozlišuje dočasný a persistentní asset", () => {
  const document = {
    id: "doc-1",
    title: "Technické podmínky",
    category: "technical",
    fileName: "podminky.pdf",
    assetUrl: "blob:test",
    mimeType: "application/pdf",
    active: true,
    availability: "temporary-session" as const,
  };
  assert.equal(document.availability, "temporary-session");
  assert.equal(document.category, "technical");
});

test("FinishVariant podporuje koberec none/barvu i ceny", () => {
  assert.equal(carpetFinishVariants[0]?.id, NO_CARPET_FINISH_ID);
  assert.ok(carpetFinishVariants.some((finish) => finish.swatchColor));
  assert.deepEqual(carpetFinishVariants.find((finish) => finish.id === "carpet-grey")?.pricingEntries, []);
  assert.equal(carpetFinishVariants.find((finish) => finish.id === "carpet-grey")?.pricingUnit, "square-meter");
  assert.equal(nominalAreaSquareMeters({ widthMm: 2000, depthMm: 2000 }), 4);
  assert.deepEqual(constructionFinishVariants.map((finish) => finish.name), ["Bílá", "Černá"]);
});

test("černý finish se aplikuje jen na explicitně mapované GLB části", () => {
  const black = constructionFinishVariants.find((finish) => finish.id === "construction-black");
  assert.deepEqual(constructionMaterialOverrides([], black), []);
  assert.equal(constructionMaterialOverrides([{ id: "frame", nodeName: "Frame_01", role: "frame", printable: false, materialRole: "OCTANORM_WHITE" }], black)[0]?.nodeName, "Frame_01");
});

test("Koje má explicitní nominální rozměry nezávislé na CAD bounding boxu", () => {
  const koje = boothTypes.find((booth) => booth.id === "koje-2x2")!;
  assert.deepEqual(koje.nominalDimensions, { widthMm: 2000, depthMm: 2000, heightMm: 2500 });
  assert.equal(koje.cadDimensions?.widthMm, 2020);
});

test("dimensions layer má samostatný český label", () => {
  assert.equal(EXPORT_LAYER_LABELS.dimensions, "Kóty");
});

test("custom measurement odděluje naměřenou hodnotu a display label", () => {
  assert.equal(measuredDistanceMm({ x: 0, y: 0 }, { x: 1200, y: 1600 }), 2000);
  const dimension = createCustomDimension("dimension", { x: 0, y: 0 }, { x: 2020, y: 0 }, "2026-08-11T10:00:00.000Z");
  const overridden = { ...dimension, displayLabel: "2000 mm" };
  assert.equal(overridden.measuredValueMm, 2020);
  assert.equal(dimensionDisplayLabel(overridden), "2000 mm");
});

test("projekt ukládá annotations, dimensions a více 2D outputs", () => {
  const project = createProjectRecord({
    id: "outputs",
    annotations: [{ id: "note", text: "Bez koberce", position: { x: 500, y: 500 }, visible: true, createdAt: "2026-08-11T10:00:00.000Z" }],
    customDimensions: [createCustomDimension("dimension", { x: 0, y: 0 }, { x: 1000, y: 0 })],
    generatedPlanOutputs: [
      { id: "plan-1", name: "Půdorys 01", type: "plan2d", layers: ["booth", "furniture"], imageDataUrl: "data:image/png;base64,AA==", createdAt: "2026-08-11T10:00:00.000Z", reviewStatus: "unreviewed" },
      { id: "plan-2", name: "Půdorys 02", type: "plan2d", layers: ["booth", "electrical"], imageDataUrl: "data:image/png;base64,AA==", createdAt: "2026-08-11T10:01:00.000Z", reviewStatus: "unreviewed" },
    ],
  });
  assert.equal(project.annotations[0]?.text, "Bez koberce");
  assert.equal(project.customDimensions[0]?.measuredValueMm, 1000);
  assert.equal(project.generatedPlanOutputs.length, 2);
  assert.deepEqual(project.generatedPlanOutputs[1]?.layers, ["booth", "electrical"]);
});

test("email témata jsou explicitní a rule-based draft čte status i lifecycle", async () => {
  assert.ok(EMAIL_TOPICS.some((topic) => topic.id === "graphics"));
  const requirements = createDefaultTechnicalRequirements();
  const provider = new RuleBasedEmailDraftProvider();
  const draft = await provider.create({
    summary: "",
    language: "cs",
    purpose: "project",
    attachments: [],
    projectName: "Test",
    stage: "design",
    mode: "proposal",
    requirements: { ...requirements, graphics: { status: "inquire", note: "" } },
    selectedTopics: ["graphics", "approval"],
  });
  assert.match(draft.subject, /odsouhlasení/i);
  assert.match(draft.body, /zaslání nebo potvrzení/i);
  assert.deepEqual(draft.selectedTopics, ["graphics", "approval"]);
});

test("rule-based email umí anglický customer-facing draft", async () => {
  const draft = await new RuleBasedEmailDraftProvider().create({
    summary: "",
    language: "en",
    purpose: "project",
    attachments: [],
    projectName: "Expo",
    stage: "done",
    selectedTopics: ["missing-data"],
  });
  assert.match(draft.subject, /Final project materials/);
  assert.match(draft.body, /Please provide/);
});

test("ProjectPackage přijme 2D output i event dokument do stabilních složek", () => {
  const projectPackage = createProjectPackage("project", "Project", [
    { id: "plan", name: "plan.png", folderId: "plans-complete", sourceType: "generated", mimeType: "image/png", includeInZip: true },
    { id: "event-doc", name: "manual.pdf", folderId: "event-documents", sourceType: "uploaded", mimeType: "application/pdf", includeInZip: true },
  ]);
  assert.equal(packageFolderPath(projectPackage, "plans-complete"), "Project/03_Pudorysy/kompletni");
  assert.equal(packageFolderPath(projectPackage, "event-documents"), "Project/07_Zdrojova_data/event_dokumenty");
});

test("EventDocument batch vytvoří samostatný záznam pro každý soubor", () => {
  const files = [
    { name: "manual.pdf", type: "application/pdf" },
    { name: "rules.pdf", type: "application/pdf" },
  ];
  const documents = createEventDocumentsFromFiles(files, { category: "manual", language: "cs" }, (file) => `blob:${file.name}`, "2026-08-11T10:00:00.000Z");
  assert.equal(documents.length, 2);
  assert.deepEqual(documents.map((item) => item.title), ["manual", "rules"]);
  assert.ok(documents.every((item) => item.category === "manual" && item.language === "cs"));
});

test("Event repository uloží metadata a nepředstírá persistentní temporary binary", async () => {
  const storage = new MemoryStorage();
  const repository = new LocalEventRepository(storage, exhibitions);
  const event = { ...exhibitions[0]!, importantInfo: "Uloženo", documents: [{ id: "temporary", title: "Manuál", category: "manual", fileName: "manual.pdf", mimeType: "application/pdf", active: true, availability: "temporary-session" as const, assetUrl: "blob:manual" }] };
  assert.equal(eventHasUnsavedChanges(exhibitions[0], event), true);
  await repository.save(event);
  const loaded = (await repository.list()).find((item) => item.id === event.id)!;
  assert.equal(loaded.importantInfo, "Uloženo");
  assert.equal(loaded.documents[0]?.fileName, "manual.pdf");
  assert.equal(loaded.documents[0]?.assetUrl, undefined);
  assert.equal(eventHasUnsavedChanges(loaded, loaded), false);
});

test("PriceList repository (dev/local fallback): prázdné úložiště padá zpět na statický seed, uložení persistuje beze ztráty měny/roku", async () => {
  const storage = new MemoryStorage();
  const repository = new LocalPriceListRepository(storage, priceLists);
  const seeded = await repository.list();
  assert.deepEqual(seeded.map((p) => p.id), priceLists.map((p) => p.id), "prázdné localStorage musí padnout zpět na statický seed (dev fallback), ne na prázdný seznam");

  const edited = { ...seeded[0]!, name: "Přejmenovaný ceník" };
  await repository.save(edited);
  const reloaded = await repository.list();
  const found = reloaded.find((p) => p.id === edited.id)!;
  assert.equal(found.name, "Přejmenovaný ceník");
  assert.equal(found.currency, seeded[0]!.currency);
  assert.equal(found.year, seeded[0]!.year);
  assert.equal(reloaded.length, priceLists.length, "uložení jedné položky nesmí duplikovat zbytek seedu");
});

test("starší minimální ProjectRecord se v repository centrálně migruje", async () => {
  const storage = new MemoryStorage();
  storage.setItem(LocalProjectRepository.storageKey, JSON.stringify([{ id: "legacy-minimal", name: "Legacy", contact: "legacy@example.test" }]));
  const loaded = (await new LocalProjectRepository(storage).get("legacy-minimal"))!;
  assert.equal(loaded.schemaVersion, CURRENT_PROJECT_SCHEMA_VERSION);
  assert.deepEqual(loaded.annotations, []);
  assert.deepEqual(loaded.customDimensions, []);
  assert.deepEqual(loaded.generatedPlanOutputs, []);
  assert.deepEqual(loaded.visualizations, []);
  assert.deepEqual(loaded.selectedEventDocumentIds, []);
  assert.doesNotThrow(() => [...loaded.generatedPlanOutputs, ...loaded.visualizations].map((item) => item.name));
});

test("review, rename a delete výstupu zachovají konzistentní project selection", () => {
  const output = { id: "plan", name: "Půdorys 01", type: "plan2d" as const, layers: ["booth"] as const, imageDataUrl: "data:image/png;base64,AA==", createdAt: "2026-08-11T10:00:00.000Z", reviewStatus: "unreviewed" as const };
  assert.equal(renameGeneratedOutput(output, "Půdorys elektro").name, "Půdorys elektro");
  assert.equal(setGeneratedOutputReview(output, "reviewed").reviewStatus, "reviewed");
  const project = createProjectRecord({ id: "delete-output", generatedPlanOutputs: [output], selectedOutputIds: [output.id] });
  const deleted = deleteGeneratedOutput(project, output.id);
  assert.deepEqual(deleted.generatedPlanOutputs, []);
  assert.deepEqual(deleted.selectedOutputIds, []);
});

test("measurement state machine vede první bod, preview, druhý bod a cancel", () => {
  const started = startMeasurement();
  const first = measurementClick(started, { x: 0, y: 0 }, "measure");
  const preview = updateMeasurementHover(first.state, { x: 300, y: 400 });
  const finished = measurementClick(preview, { x: 300, y: 400 }, "measure");
  assert.deepEqual(preview.hover, { x: 300, y: 400 });
  assert.equal(finished.dimension?.measuredValueMm, 500);
  assert.equal(finished.state.active, false);
  assert.equal(cancelMeasurement().active, false);
});

test("shared 2D render layout drží orientaci, fit a kóty vně geometrie", () => {
  const layout = createPlanRenderLayout(2000, 2000);
  assert.ok(layout.scale > 0);
  assert.ok(layout.originY - layout.dimensionOffsetPx > 0);
  assert.equal(layout.dimensionOffsetPx, PLAN_RENDER_CONFIG.dimensionOffsetPx);
  assert.ok(PLAN_RENDER_CONFIG.dimensionFontPx >= 30);
});

test("Visualization 2D keeps P86 booth logic and furniture independently selectable beneath the GLB visual path", () => {
  const booth = boothTypes.find((item) => item.internalCode === "P86")!;
  const chair = placeComponent(componentCatalog.chair, "m57-plan", 1000, 1000);

  const both = resolveTechnicalPlanContent({
    booth,
    sceneObjects: [chair],
    layers: ["booth", "furniture"],
  });
  assert.deepEqual(
    both.boothPlan.constructionAreas
      .map((item) => item.constructionPartId),
    ["back-wall", "left-wall", "right-wall"],
  );
  assert.deepEqual(both.boothPlan.collisionLines, []);
  assert.deepEqual(both.sceneObjects.map((item) => item.id), [chair.id]);

  const furnitureOnly = resolveTechnicalPlanContent({
    booth,
    sceneObjects: [chair],
    layers: ["furniture"],
  });
  assert.deepEqual(furnitureOnly.boothPlan, {
    constructionAreas: [],
    constructionProfiles: [],
    collisionLines: [],
  });
  assert.deepEqual(furnitureOnly.sceneObjects.map((item) => item.id), [chair.id]);

  const boothOnly = resolveTechnicalPlanContent({
    booth,
    sceneObjects: [chair],
    layers: ["booth"],
  });
  assert.equal(boothOnly.boothPlan.constructionAreas.length, 3);
  assert.equal(boothOnly.boothPlan.constructionProfiles.length, 5);
  assert.deepEqual(boothOnly.sceneObjects, []);
});

test("hard collision has no dashed presentation overlay in Editor, Visualization or export", () => {
  const booth = boothTypes.find((item) => item.internalCode === "P86")!;
  const generatorSource = readFileSync(
    new URL("../components/BoothGenerator.tsx", import.meta.url),
    "utf8",
  );

  assert.equal(
    shouldRenderBoothCollisionOverlay("editor", { editorEnabled: true }),
    false,
  );
  assert.equal(
    shouldRenderBoothCollisionOverlay("editor", { editorEnabled: false }),
    false,
  );
  assert.equal(shouldRenderBoothCollisionOverlay("visualization"), false);
  assert.equal(shouldRenderBoothCollisionOverlay("export"), false);
  assert.equal(
    shouldRenderBoothCollisionOverlay("export", { includeInExport: true }),
    false,
  );
  assert.doesNotMatch(generatorSource, /showCollisionOverlay|KOLIZE|collisionOn/u);

  const standard = resolveTechnicalPlanContent({
    booth,
    sceneObjects: [],
    layers: ["booth"],
  });
  const explicitlyIncluded = resolveTechnicalPlanContent({
    booth,
    sceneObjects: [],
    layers: ["booth"],
    includeCollisionOverlay: true,
  });

  assert.deepEqual(standard.boothPlan.collisionLines, []);
  assert.deepEqual(explicitlyIncluded.boothPlan.collisionLines, []);
});

test("P86 canonical fallback retains wall footprints and profiles when its GLB is unavailable", () => {
  const booth = boothTypes.find((item) => item.internalCode === "P86")!;
  const plan = resolveBoothPlanPresentation(booth);
  assert.equal(resolveBoothPlanVisualMode(booth, undefined), "canonical-fallback");

  assert.deepEqual(
    plan.constructionAreas.map(({ constructionPartId, rect }) => ({
      constructionPartId,
      rect,
    })),
    booth.collisionObstacles.map((obstacle) => ({
      constructionPartId: obstacle.id,
      rect: collisionObstacleToPlanRect(obstacle, booth.depthMm ?? 0),
    })),
  );
  assert.equal("constructionLines" in plan, false, "konstrukce nesmí být jen tři center-lines");
  assert.deepEqual(
    plan.constructionProfiles.map(({ rect }) => [rect.x, rect.y, rect.width, rect.height]),
    [
      [0, 0, 80, 80],
      [960, 0, 80, 80],
      [1920, 0, 80, 80],
      [0, 960, 80, 80],
      [1920, 960, 80, 80],
    ],
  );
  assert.deepEqual(
    plan.collisionLines.map(({ constructionPartId, x1, y1, x2, y2 }) => ({
      constructionPartId,
      x1,
      y1,
      x2,
      y2,
    })),
    [
      { constructionPartId: "back-wall", x1: 0, y1: 30, x2: 2000, y2: 30 },
      { constructionPartId: "left-wall", x1: 30, y1: 0, x2: 30, y2: 1000 },
      { constructionPartId: "right-wall", x1: 1970, y1: 0, x2: 1970, y2: 1000 },
    ],
  );
  assert.equal("collisionAreas" in plan, false, "no-placement overlay nesmí být block/teeth geometrie");
  assert.equal(
    plan.constructionAreas.some(({ rect }) => rect.y + rect.height > 1000),
    false,
    "přední 1 m musí zůstat otevřený",
  );

  const rawGroundGeometry = resolveBoothPlanGeometry(booth)
    .filter((item) => item.viewType === "ground")
    .map((item) => item.rect);
  assert.deepEqual(
    rawGroundGeometry,
    booth.collisionObstacles.map((obstacle) =>
      collisionObstacleToPlanRect(obstacle, booth.depthMm ?? 0),
    ),
  );
  assert.equal(resolveBoothPlanGeometry(booth).length, 5, "detail límce a rastru zůstává v canonical datech");

  const componentSource = readFileSync(
    new URL("../components/configurator/BoothConstructionPlanView.tsx", import.meta.url),
    "utf8",
  );
  const cssSource = readFileSync(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(componentSource, /<line|canonicalBoothCollision|renderCollisionOverlay/u);
  assert.match(componentSource, /<BoothCadPlanView/u);
  assert.match(componentSource, /showCanonicalConstruction/u);
  assert.match(componentSource, /canonicalBoothConstructionArea/u);
  assert.match(componentSource, /canonicalBoothConstructionProfile/u);
  assert.match(cssSource, /\.canonicalBoothConstructionArea\s*\{[\s\S]*?fill:\s*#24272a[\s\S]*?\}/u);
  assert.match(cssSource, /\.canonicalBoothConstructionProfile\s*\{[\s\S]*?fill:\s*#111315[\s\S]*?\}/u);
  assert.doesNotMatch(cssSource, /canonicalBoothCollisionLine/u);
});

test("P86 2D visibility odebere konstrukční symbol i jeho kolizní overlay", () => {
  const booth = boothTypes.find((item) => item.internalCode === "P86")!;
  const assemblyKeys = [
    ["HWS_ASM_BACK_WALL", "back-wall"],
    ["HWS_ASM_LEFT_WALL", "left-wall"],
    ["HWS_ASM_RIGHT_WALL", "right-wall"],
  ] as const;

  for (const [assemblyKey, constructionPartId] of assemblyKeys) {
    const plan = resolveBoothPlanPresentation(booth, { [assemblyKey]: false });
    assert.equal(
      plan.constructionAreas.some((item) => item.constructionPartId === constructionPartId),
      false,
    );
    assert.equal(
      plan.collisionLines.some((item) => item.constructionPartId === constructionPartId),
      false,
    );
    assert.equal(
      plan.constructionProfiles.some((item) => item.constructionPartId === constructionPartId),
      false,
    );
  }

  const content = resolveTechnicalPlanContent({
    booth,
    sceneObjects: [],
    layers: ["booth"],
    constructionVisibility: { HWS_ASM_LEFT_WALL: false },
  });

  assert.equal(
    content.boothPlan.constructionAreas.some(
      (item) => item.constructionPartId === "left-wall",
    ),
    false,
  );
  assert.equal(
    content.boothPlan.collisionLines.some(
      (item) => item.constructionPartId === "left-wall",
    ),
    false,
  );
  assert.equal(booth.nominalDimensions?.widthMm, 2000);
  assert.equal(booth.nominalDimensions?.depthMm, 2000);
  assert.equal(
    Math.max(...content.boothPlan.constructionAreas.map(({ rect }) => rect.x + rect.width)),
    2000,
  );
  assert.equal(
    Math.max(...content.boothPlan.constructionAreas.map(({ rect }) => rect.y + rect.height)),
    1000,
  );

  const exportSource = readFileSync(
    new URL("../lib/planExport.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(exportSource, /cadSnapshot|querySelector|cadPlanCanvas|onSnapshot/u);
  assert.match(exportSource, /renderBoothPlanGlbToCanvas/u);
  assert.match(exportSource, /if \(layers\.includes\("booth"\) && !renderedBoothGlb\)/u);
  assert.match(exportSource, /resolveBoothPlanPresentation/u);
});

test("M57 používá kompletní canonical katalogová data", () => {
  const m57: ComponentDefinition = componentCatalog.chair;
  const basePrice = getBasePricingEntry(m57.pricingEntries, "CZK");
  assert.equal(m57.internalCode, "M57");
  assert.equal(m57.officialName, "ŽIDLE KOVOVÁ ČALOUNĚNÁ");
  assert.equal(m57.displayName, "Židle kovová čalouněná");
  assert.equal(m57.name, m57.displayName);
  assert.equal(m57.category, "chairs");
  assert.equal(m57.unit, "ks");
  assert.deepEqual([m57.widthMm, m57.depthMm, m57.heightMm], [535, 592, 795]);
  assert.equal(basePrice?.salePrice, 300);
  assert.equal(basePrice?.purchasePrice, 170);
  assert.equal(m57.vatRatePercent, 21);
  assert.equal(m57.active, true);
  assert.equal(m57.showIn2D, true);
  assert.equal(m57.showIn3D, true);
  assert.equal(m57.printable, false);
  assert.equal(m57.photoUrl, "/models/chairs/M57/photo.jpg");
  assert.equal(m57.thumbnailUrl, undefined);
  assert.equal(m57.sketchupUrl, undefined);
  assert.equal(m57.modelUrl, undefined);
});

test("M57 matching normalizuje velikost a mezery, název je pouze fallback", () => {
  for (const internalCode of ["M57", "m57", " M57", "m57 "]) {
    assert.equal(normalizeCatalogCode(internalCode), "M57");
    assert.equal(matchCatalogItem(componentCatalogItems, { internalCode })?.id, componentCatalog.chair.id);
  }
  assert.equal(matchCatalogItem(componentCatalogItems, { internalCode: "unknown", name: componentCatalog.chair.officialName })?.id, componentCatalog.chair.id);
});

test("order reconciliation mapuje varianty kódu primárně na M57", () => {
  const lines = ["M57", "m57", " M57", "m57 "].map((sourceCode, index) => ({
    id: `m57-${index}`,
    sourceCode,
    sourceName: "Nesprávný název",
    quantity: 1,
    unit: "ks",
    rawText: sourceCode,
    mappingStatus: "unresolved" as const,
    itemType: "unknown" as const,
  }));
  const reconciled = reconcileOrderLines(lines, componentCatalogItems);
  assert.ok(reconciled.every((line) => line.mappingStatus === "matched"));
  assert.ok(reconciled.every((line) => line.mappedCatalogItemId === componentCatalog.chair.id));
});

test("M57 thumbnail používá photoUrl a po chybě čistý 2D fallback", () => {
  assert.equal(catalogImageUrl(componentCatalog.chair), "/models/chairs/M57/photo.jpg");
  assert.equal(catalogImageUrl(componentCatalog.chair, ["/models/chairs/M57/photo.jpg"]), undefined);
});

test("chybějící fotografie se při exportu bezpečně přeskočí", async () => {
  assert.equal(await loadCatalogPhoto(componentCatalog.chair.photoUrl!, async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) })), undefined);
  assert.equal(await loadCatalogPhoto(componentCatalog.chair.photoUrl!, async () => { throw new Error("404"); }), undefined);
});

test("Summary seskupí pět instancí M57 podle catalog itemu", () => {
  const scene = Array.from({ length: 5 }, (_, index) => placeComponent(componentCatalog.chair, `m57-${index}`, 500, 1500));
  const summary = groupCatalogSceneItems(scene, componentCatalogItems, "CZK");
  assert.equal(summary.length, 1);
  assert.deepEqual(summary[0], {
    catalogItemId: componentCatalog.chair.id,
    internalCode: "M57",
    displayName: "Židle kovová čalouněná",
    quantity: 5,
    unit: "ks",
    saleUnitNet: 300,
    saleTotalNet: 1500,
    photoUrl: "/models/chairs/M57/photo.jpg",
    photoAsset: componentCatalog.chair.photoAsset,
  });
});

test("L02 je cenová služba oddělená od technického bodu Elektro", () => {
  const service = componentCatalog.electricityService;
  assert.equal(service.internalCode, "L02");
  assert.equal(service.catalogItemType, "service");
  assert.equal(service.pricingEntries?.[0]?.salePrice, 5100);
  assert.notEqual(service.id, componentCatalog.electrical.id);
});

test("P86 má fixní NET cenu, included obsah, koberec a print surface", () => {
  const p86 = boothTypes.find((booth) => booth.internalCode === "P86")!;
  assert.equal(p86.pricingEntries?.[0]?.salePrice, 3640);
  assert.equal(p86.defaultCarpetFinishId, "carpet-grey");
  assert.equal(p86.packageContents?.find((item) => item.kind === "floor-finish")?.quantity, 4);
  assert.equal(p86.packageContents?.every((item) => item.includedInBasePrice), true);
  assert.equal(p86.printSurfaces?.length, 9);
  const fascia = p86.printSurfaces?.find((surface) => surface.id === "fascia-print");
  assert.deepEqual(fascia && [fascia.widthMm, fascia.heightMm], [2000, 300]);
  assert.equal(p86.graphicsRequired, true);
});

test("NET/VAT/gross helper počítá 300 + 21 % jako 363", () => {
  assert.deepEqual(calculateNetVatGross(300), { net: 300, vat: 63, gross: 363, vatRatePercent: 21 });
  assert.equal(calculateMarginDelta(300, 170), 130);
});
