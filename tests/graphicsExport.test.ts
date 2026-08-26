import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildAssignedArtworkExportRows,
  buildGraphicsDimensionExportRows,
  buildGraphicsExportRows,
  graphicsExportSubtotal,
  groupGraphicsExportRows,
} from "../domain/graphicsExport.ts";
import { TECHNICAL_SERVICE_IDS } from "../domain/technicalServices.ts";
import { P86_CANONICAL_PRINT_SURFACES } from "../domain/printSurfaces.ts";
import { createStorageKey } from "../domain/assets.ts";
import { boothTypes } from "../data/booths.ts";
import { DEFAULT_REALIZATION_PROFILE_ID } from "../data/realizationProfiles.ts";
import type { ComponentDefinition, PrintSurface } from "../domain/models.ts";
import type { GraphicFileReference, PrintSurfaceAssignment } from "../domain/project.ts";
import type { PricingContext } from "../domain/catalog.ts";

const p86 = boothTypes.find((booth) => booth.internalCode === "P86");
if (!p86) throw new Error("Testovací definice P86 nebyla nalezena.");

const NO_CATALOG_ITEMS: readonly ComponentDefinition[] = [];
const CZK_CONTEXT: PricingContext = { currency: "CZK" };

function fullWrapCatalogItem(salePrice: number): ComponentDefinition {
  return {
    id: TECHNICAL_SERVICE_IDS.fullWrapGraphics,
    type: "service",
    name: "Grafika – celopolep",
    category: "graphics",
    widthMm: 0,
    depthMm: 0,
    resizable: false,
    productionProfiles: {},
    rotation: { defaultMode: "free", snapStep: 45, quickAngles: [0], allowFreeRotation: true, locked: false },
    systemLocked: false,
    userLocked: false,
    visible: false,
    sceneLabel: "Grafika – celopolep",
    pricingEntries: [{ id: "wrap-rate", itemId: TECHNICAL_SERVICE_IDS.fullWrapGraphics, currency: "CZK", salePrice }],
  };
}

function assignment(overrides: Partial<PrintSurfaceAssignment> & Pick<PrintSurfaceAssignment, "printSurfaceId">): PrintSurfaceAssignment {
  return {
    sceneReference: p86!.id,
    graphicsKind: "fullWrap",
    artworkStatus: "missing",
    selectedForPrint: false,
    canonicalWidthMm: 0,
    canonicalHeightMm: 0,
    productionWidthMm: 0,
    productionHeightMm: 0,
    includedInPackage: false,
    pricedSeparately: true,
    ...overrides,
  };
}

function graphicsFile(overrides: Partial<GraphicFileReference> & Pick<GraphicFileReference, "id" | "name">): GraphicFileReference {
  return {
    size: 1000,
    mimeType: "image/png",
    availability: "persistent" as const,
    ...overrides,
  };
}

// =========================================================================================
// Graphics Export v1, sections 8-10/14/18-22: the reusable, generic (never P86-only) row
// builder behind Export A (dimensions) and Export B (assigned artwork).
// =========================================================================================

test("EXPORT A: buildGraphicsExportRows contains every available active printable surface, with or without artwork", () => {
  const rows = buildGraphicsExportRows(p86, [], [], DEFAULT_REALIZATION_PROFILE_ID, NO_CATALOG_ITEMS, CZK_CONTEXT);
  const activeSurfaceIds = P86_CANONICAL_PRINT_SURFACES.filter((surface) => surface.active).map((surface) => surface.id);
  assert.deepEqual(rows.map((row) => row.printSurfaceId).sort(), activeSurfaceIds.sort());
});

test("EXPORT A SELECTION: user selection restricts the dimension export to only the chosen surfaces", () => {
  const rows = buildGraphicsExportRows(p86, [], [], DEFAULT_REALIZATION_PROFILE_ID, NO_CATALOG_ITEMS, CZK_CONTEXT);
  const selected = new Set(["back-wall-01-front", "fascia-print"]);
  const exported = buildGraphicsDimensionExportRows(rows, selected);
  assert.deepEqual(exported.map((row) => row.printSurfaceId).sort(), ["back-wall-01-front", "fascia-print"]);
});

test("SELECT ALL: selecting every row id generically includes every available surface — no P86-specific selection logic needed", () => {
  const rows = buildGraphicsExportRows(p86, [], [], DEFAULT_REALIZATION_PROFILE_ID, NO_CATALOG_ITEMS, CZK_CONTEXT);
  const allIds = new Set(rows.map((row) => row.printSurfaceId));
  const exported = buildGraphicsDimensionExportRows(rows, allIds);
  assert.equal(exported.length, rows.length);
});

test("PRODUCTION DIMENSIONS: rows use the CURRENT realization resolver, never a persisted assignment snapshot", () => {
  const surfaceWithBleed: PrintSurface = { ...P86_CANONICAL_PRINT_SURFACES.find((s) => s.id === "fascia-print")!, productionProfiles: { "realization-2": { bleedLeftMm: 10, bleedRightMm: 10, bleedTopMm: 0, bleedBottomMm: 0 } } };
  const boothWithBleed = { ...p86, printSurfaces: [surfaceWithBleed] };
  const staleAssignment = assignment({ printSurfaceId: "fascia-print", productionWidthMm: 999999, productionHeightMm: 999999 });
  const rows = buildGraphicsExportRows(boothWithBleed, [staleAssignment], [], "realization-2", NO_CATALOG_ITEMS, CZK_CONTEXT);
  const row = rows.find((item) => item.printSurfaceId === "fascia-print")!;
  assert.equal(row.productionWidthMm, 2020, "the stale 999999 assignment snapshot must never leak into the export row");
  assert.equal(row.canonicalWidthMm, 2000);
});

test("REALIZATION CHANGE: switching realizationProfileId changes the export's production dimensions", () => {
  const surfaceWithBleed: PrintSurface = { ...P86_CANONICAL_PRINT_SURFACES.find((s) => s.id === "fascia-print")!, productionProfiles: { "realization-2": { bleedLeftMm: 25, bleedRightMm: 25, bleedTopMm: 0, bleedBottomMm: 0 } } };
  const boothWithBleed = { ...p86, printSurfaces: [surfaceWithBleed] };
  const withDefault = buildGraphicsExportRows(boothWithBleed, [], [], DEFAULT_REALIZATION_PROFILE_ID, NO_CATALOG_ITEMS, CZK_CONTEXT)[0]!;
  const withRealization2 = buildGraphicsExportRows(boothWithBleed, [], [], "realization-2", NO_CATALOG_ITEMS, CZK_CONTEXT)[0]!;
  assert.equal(withDefault.productionWidthMm, 2000);
  assert.equal(withRealization2.productionWidthMm, 2050);
});

test("EXPORT B: assigned-artwork export contains ONLY surfaces with an artworkFileId", () => {
  const files = [graphicsFile({ id: "art-1", name: "Zadni_stena_Panel_01_Predni.png" })];
  const assignments = [assignment({ printSurfaceId: "back-wall-01-front", artworkFileId: "art-1", artworkStatus: "received" })];
  const rows = buildGraphicsExportRows(p86, assignments, files, DEFAULT_REALIZATION_PROFILE_ID, NO_CATALOG_ITEMS, CZK_CONTEXT);
  const exported = buildAssignedArtworkExportRows(rows);
  assert.deepEqual(exported.map((row) => row.printSurfaceId), ["back-wall-01-front"]);
});

test("EXPORT B ENABLE/DISABLE: an explicit enabled-id set further narrows Export B's rows before printing", () => {
  const files = [
    graphicsFile({ id: "art-1", name: "Zadni_stena_Panel_01_Predni.png" }),
    graphicsFile({ id: "art-2", name: "Limec_Predni.png" }),
  ];
  const assignments = [
    assignment({ printSurfaceId: "back-wall-01-front", artworkFileId: "art-1", artworkStatus: "received" }),
    assignment({ printSurfaceId: "fascia-print", artworkFileId: "art-2", artworkStatus: "received" }),
  ];
  const rows = buildGraphicsExportRows(p86, assignments, files, DEFAULT_REALIZATION_PROFILE_ID, NO_CATALOG_ITEMS, CZK_CONTEXT);
  const onlyFascia = buildAssignedArtworkExportRows(rows, new Set(["fascia-print"]));
  assert.deepEqual(onlyFascia.map((row) => row.printSurfaceId), ["fascia-print"]);
});

test("SHARED ARTWORK: the same graphicsFile assigned to two surfaces is never duplicated, and each row gets its OWN surface-specific exportFileName", () => {
  const sharedFile = graphicsFile({ id: "shared-1", name: "Custom.png", asset: { id: "a1", storageKey: "k1", originalFileName: "01.png", mimeType: "image/png", size: 10, createdAt: "2026-08-25T00:00:00.000Z", category: "project-graphics" } });
  const assignments = [
    assignment({ printSurfaceId: "back-wall-01-front", artworkFileId: "shared-1", artworkStatus: "received" }),
    assignment({ printSurfaceId: "back-wall-02-front", artworkFileId: "shared-1", artworkStatus: "received" }),
  ];
  const rows = buildGraphicsExportRows(p86, assignments, [sharedFile], DEFAULT_REALIZATION_PROFILE_ID, NO_CATALOG_ITEMS, CZK_CONTEXT);
  const row1 = rows.find((row) => row.printSurfaceId === "back-wall-01-front")!;
  const row2 = rows.find((row) => row.printSurfaceId === "back-wall-02-front")!;
  assert.equal(row1.artworkFileId, "shared-1");
  assert.equal(row2.artworkFileId, "shared-1");
  assert.equal(row1.exportFileName, "Zadni_stena_Panel_01_Predni.png");
  assert.equal(row2.exportFileName, "Zadni_stena_Panel_02_Predni.png");
  assert.notEqual(row1.exportFileName, row2.exportFileName, "one shared asset, two DIFFERENT surface-specific export names — never a duplicated/renamed asset");
});

test("LEGACY FILE: a graphicsFile with no asset.displayName falls back to originalFileName, never a blank name", () => {
  const legacyFile = graphicsFile({ id: "legacy-1", name: "01.png", asset: { id: "a1", storageKey: "k1", originalFileName: "01.png", mimeType: "image/png", size: 10, createdAt: "2026-08-25T00:00:00.000Z", category: "project-graphics" } });
  const assignments = [assignment({ printSurfaceId: "fascia-print", artworkFileId: "legacy-1", artworkStatus: "received" })];
  const rows = buildGraphicsExportRows(p86, assignments, [legacyFile], DEFAULT_REALIZATION_PROFILE_ID, NO_CATALOG_ITEMS, CZK_CONTEXT);
  const row = rows.find((item) => item.printSurfaceId === "fascia-print")!;
  assert.equal(row.artworkDisplayName, "01.png");
  assert.equal(row.artworkOriginalFileName, "01.png");
});

test("USAGE ROLE: a legacy graphicsFile with no usageRole resolves to 'preview' in the export row (never assumed print-ready)", () => {
  const legacyFile = graphicsFile({ id: "legacy-1", name: "01.png" });
  const assignments = [assignment({ printSurfaceId: "fascia-print", artworkFileId: "legacy-1", artworkStatus: "received" })];
  const rows = buildGraphicsExportRows(p86, assignments, [legacyFile], DEFAULT_REALIZATION_PROFILE_ID, NO_CATALOG_ITEMS, CZK_CONTEXT);
  assert.equal(rows.find((row) => row.printSurfaceId === "fascia-print")?.artworkUsageRole, "preview");
});

test("USAGE ROLE: an explicit print-data role is distinguished from preview in the export row", () => {
  const printDataFile = graphicsFile({ id: "pd-1", name: "01.pdf", usageRole: "print-data" });
  const assignments = [assignment({ printSurfaceId: "fascia-print", artworkFileId: "pd-1", artworkStatus: "received" })];
  const rows = buildGraphicsExportRows(p86, assignments, [printDataFile], DEFAULT_REALIZATION_PROFILE_ID, NO_CATALOG_ITEMS, CZK_CONTEXT);
  assert.equal(rows.find((row) => row.printSurfaceId === "fascia-print")?.artworkUsageRole, "print-data");
});

test("PLACEMENT: artworkPlacement is carried through into the export row unchanged", () => {
  const file = graphicsFile({ id: "art-1", name: "art.png" });
  const placement = { mode: "fit" as const, scale: 1.2, offsetXmm: 15, offsetYmm: -5 };
  const assignments = [assignment({ printSurfaceId: "fascia-print", artworkFileId: "art-1", artworkStatus: "received", artworkPlacement: placement })];
  const rows = buildGraphicsExportRows(p86, assignments, [file], DEFAULT_REALIZATION_PROFILE_ID, NO_CATALOG_ITEMS, CZK_CONTEXT);
  assert.deepEqual(rows.find((row) => row.printSurfaceId === "fascia-print")?.artworkPlacement, placement);
});

test("NON-P86 SURFACE: a printable surface from a hypothetical other component is included with zero P86-specific logic", () => {
  const counterSurface: PrintSurface = {
    id: "counter-front-01",
    name: "Čelo",
    widthMm: 900,
    heightMm: 1100,
    active: true,
    group: { id: "counter", name: "Pult", order: 9 },
    sceneBinding: { nodeName: "HWS_COUNTER__FRONT", face: "front", coordinateSpace: "node-local", localNormalAxis: "-y" },
  };
  const otherBooth = { printSurfaces: [counterSurface] };
  const rows = buildGraphicsExportRows(otherBooth, [], [], DEFAULT_REALIZATION_PROFILE_ID, NO_CATALOG_ITEMS, CZK_CONTEXT);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.printSurfaceId, "counter-front-01");
  assert.equal(rows[0]?.canonicalWidthMm, 900);
});

test("GROUPING: groupGraphicsExportRows groups by the real PrintSurfaceGroup, matching the four P86 groups", () => {
  const rows = buildGraphicsExportRows(p86, [], [], DEFAULT_REALIZATION_PROFILE_ID, NO_CATALOG_ITEMS, CZK_CONTEXT);
  const groups = groupGraphicsExportRows(rows);
  assert.deepEqual(groups.map((group) => group.name).sort(), ["Límec", "Levá stěna", "Pravá stěna", "Zadní stěna"].sort());
});

// =========================================================================================
// Report section 3/8: R2 storage identity is completely independent of display/export naming.
// =========================================================================================

test("R2 STORAGE KEY: createStorageKey's input never includes displayName — renaming a file for display/export never moves/renames the R2 object", () => {
  const key1 = createStorageKey({ category: "project-graphics", ownerId: "owner-1", originalFileName: "01.png", mimeType: "image/png" });
  const key2 = createStorageKey({ category: "project-graphics", ownerId: "owner-1", originalFileName: "01.png", mimeType: "image/png" });
  // Two calls with the exact same input still differ (uuid-based uniqueness) — but critically,
  // nothing about a "displayName" parameter exists in the function's input shape at all, so it
  // structurally cannot affect the key.
  assert.notEqual(key1, key2, "sanity: storageKey includes a random unique component, not a deterministic name-derived one");
  assert.doesNotMatch(key1, /Zadni_stena|Limec/u, "storageKey must never contain the human-readable display name");
});

// =========================================================================================
// Selection state (report section 18) and UI wiring — source-scan pins, matching this
// codebase's established convention for React-level guarantees (see tests/individual*.test.ts).
// =========================================================================================

const panelSource = readFileSync(new URL("../components/workflow/GraphicsExportPanel.tsx", import.meta.url), "utf8");
const projectSource = readFileSync(new URL("../domain/project.ts", import.meta.url), "utf8");

test("SELECTION STATE: GraphicsExportPanel keeps its surface selection in local useState only — never in a ProjectRecord setter", () => {
  assert.match(panelSource, /useState<ReadonlySet<string>>\(\(\) => new Set\(\)\)/u);
  assert.doesNotMatch(panelSource, /onProjectChange|setProject\(/u);
});

test("SELECTION STATE: ProjectRecord itself gained no new 'selected export surfaces' persistence field", () => {
  assert.doesNotMatch(projectSource, /selectedExportSurfaceIds|graphicsExportSelection/u);
});

test("PREVIEW: ArtworkPreview resolves a raster image via the existing useAssetUrl hook + isRasterArtworkFile — never a pre-resolved URL baked into domain data", () => {
  assert.match(panelSource, /useAssetUrl\(row\.artworkAsset, undefined\)/u);
  assert.match(panelSource, /isRasterArtworkFile\(/u);
});

test("PDF PLACEHOLDER: a non-raster (PDF) artwork row renders a placeholder instead of attempting an <img>, never throwing", () => {
  const match = panelSource.match(/function ArtworkPreview\([\s\S]{0,600}?\n\}/u);
  assert.ok(match, "expected to find the ArtworkPreview component");
  assert.match(match![0], /graphicsExportPreviewPlaceholder/u);
});

// =========================================================================================
// Graphics Export v1.1, sections 14-19: pricing on every row, from the SAME resolver the main
// calculation uses — never a second m² formula in the export UI.
// =========================================================================================

test("EXPORT A PRICING: a selected surface with NO artwork still gets a real price, from the same resolveGraphicsSurfacePricing used everywhere else", () => {
  const rows = buildGraphicsExportRows(p86, [], [], DEFAULT_REALIZATION_PROFILE_ID, [fullWrapCatalogItem(450)], CZK_CONTEXT);
  const panel = rows.find((row) => row.printSurfaceId === "back-wall-01-front")!;
  assert.equal(panel.artworkFileId, undefined, "no artwork assigned");
  assert.equal(panel.pricing.status, "priced");
  assert.equal(panel.pricing.pricingBasis, "m²");
  assert.equal(Math.round(panel.pricing.quantity * 1000) / 1000, 2.223);
  assert.equal(panel.pricing.unitPriceNet, 450);
  assert.equal(Math.round(panel.pricing.totalNet!), 1000);
});

test("EXPORT B PRICING: an assigned-artwork row prices via the same resolver, matching the report's worked example (2.223 m² × 450 Kč/m²)", () => {
  const files = [graphicsFile({ id: "art-1", name: "art.png" })];
  const assignments = [assignment({ printSurfaceId: "back-wall-01-front", artworkFileId: "art-1", artworkStatus: "received" })];
  const rows = buildGraphicsExportRows(p86, assignments, files, DEFAULT_REALIZATION_PROFILE_ID, [fullWrapCatalogItem(450)], CZK_CONTEXT);
  const row = buildAssignedArtworkExportRows(rows)[0]!;
  assert.equal(Math.round(row.pricing.totalNet!), 1000);
});

test("MISSING PRICE: no matching PricingEntry never invents a rate — status 'needs-quote', totalNet/unitPriceNet left undefined", () => {
  const rows = buildGraphicsExportRows(p86, [], [], DEFAULT_REALIZATION_PROFILE_ID, NO_CATALOG_ITEMS, CZK_CONTEXT);
  const panel = rows.find((row) => row.printSurfaceId === "back-wall-01-front")!;
  assert.equal(panel.pricing.status, "needs-quote");
  assert.equal(panel.pricing.unitPriceNet, undefined);
  assert.equal(panel.pricing.totalNet, undefined);
});

test("P86 FASCIA INCLUDED: fascia-print's export row prices at totalNet 0 / status 'included' — package metadata wins, never re-priced through PriceList", () => {
  const rows = buildGraphicsExportRows(p86, [], [], DEFAULT_REALIZATION_PROFILE_ID, NO_CATALOG_ITEMS, CZK_CONTEXT);
  const fascia = rows.find((row) => row.printSurfaceId === "fascia-print")!;
  assert.equal(fascia.pricing.status, "included");
  assert.equal(fascia.pricing.includedInPackage, true);
  assert.equal(fascia.pricing.totalNet, 0);
  assert.equal(fascia.pricing.pricingBasis, "bm");
  assert.ok(fascia.pricing.quantity > 0, "quantity still reflects the real bm allowance even though price is 0");
});

test("GRAPHICS SUBTOTAL: sums only the rows actually passed in — never booth/furniture/other project pricing (which this module has no access to at all)", () => {
  const rows = buildGraphicsExportRows(p86, [], [], DEFAULT_REALIZATION_PROFILE_ID, [fullWrapCatalogItem(450)], CZK_CONTEXT);
  const selected = buildGraphicsDimensionExportRows(rows, new Set(["back-wall-01-front"]));
  assert.equal(Math.round(graphicsExportSubtotal(selected)), 1000);
  // Excluding fascia (included, totalNet 0) or any unrelated surface never changes this number —
  // the subtotal is a plain sum over exactly the rows given, nothing else.
  const selectedTwo = buildGraphicsDimensionExportRows(rows, new Set(["back-wall-01-front", "fascia-print"]));
  assert.equal(Math.round(graphicsExportSubtotal(selectedTwo)), 1000, "fascia contributes 0, so the subtotal is unchanged");
});

test("EXPORT A SELECTION DOES NOT AFFECT MAIN CALCULATION: buildGraphicsDimensionExportRows/graphicsExportSubtotal never write anywhere — pure read/derive functions with no project-mutation side channel", () => {
  const domainSource = readFileSync(new URL("../domain/graphicsExport.ts", import.meta.url), "utf8");
  assert.doesNotMatch(domainSource, /setPrintSurfaceAssignments|setProject|assignArtworkToPrintSurface/u);
});
