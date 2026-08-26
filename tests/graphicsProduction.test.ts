import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGraphicsProductionManifest,
  buildGraphicsProductionPackageName,
  buildGraphicsProductionReadiness,
  planGraphicsProductionFolders,
  selectProductionReadyRows,
} from "../domain/graphicsProduction.ts";
import { buildGraphicsExportRows } from "../domain/graphicsExport.ts";
import { boothTypes } from "../data/booths.ts";
import { DEFAULT_REALIZATION_PROFILE_ID } from "../data/realizationProfiles.ts";
import type { ComponentDefinition, PrintSurface } from "../domain/models.ts";
import type { GraphicFileReference, PrintSurfaceAssignment } from "../domain/project.ts";
import type { PricingContext } from "../domain/catalog.ts";
import type { StoredAsset } from "../domain/assets.ts";

const p86 = boothTypes.find((booth) => booth.internalCode === "P86");
if (!p86) throw new Error("Testovací definice P86 nebyla nalezena.");

const NO_CATALOG_ITEMS: readonly ComponentDefinition[] = [];
const CZK_CONTEXT: PricingContext = { currency: "CZK" };

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

function asset(overrides: Partial<StoredAsset> & Pick<StoredAsset, "id" | "storageKey">): StoredAsset {
  return {
    originalFileName: "01.pdf",
    mimeType: "application/pdf",
    size: 1000,
    createdAt: "2026-08-26T00:00:00.000Z",
    category: "project-graphics",
    ...overrides,
  };
}

function graphicsFile(overrides: Partial<GraphicFileReference> & Pick<GraphicFileReference, "id" | "name">): GraphicFileReference {
  return {
    size: 1000,
    mimeType: "application/pdf",
    availability: "persistent" as const,
    ...overrides,
  };
}

function readiness(
  assignments: readonly PrintSurfaceAssignment[],
  files: readonly GraphicFileReference[],
  booth: Readonly<{ printSurfaces?: readonly PrintSurface[]; packageContents?: readonly unknown[] }> = p86!,
  realizationProfileId = DEFAULT_REALIZATION_PROFILE_ID,
) {
  const rows = buildGraphicsExportRows(booth as never, assignments, files, realizationProfileId, NO_CATALOG_ITEMS, CZK_CONTEXT);
  return buildGraphicsProductionReadiness(rows, assignments);
}

// =========================================================================================
// Graphics Production Package v1 — status derivation (report sections 2-3/22): READY / PREVIEW
// ONLY / MISSING / SOURCE MISSING, computed in domain code only, never in React.
// =========================================================================================

test("READY: a selected-for-print surface with a print-data-role asset attached gets status ready", () => {
  const files = [graphicsFile({ id: "art-1", name: "01.pdf", usageRole: "print-data", asset: asset({ id: "a1", storageKey: "k1" }) })];
  const assignments = [assignment({ printSurfaceId: "fascia-print", selectedForPrint: true, artworkFileId: "art-1", artworkStatus: "received" })];
  const rows = readiness(assignments, files);
  const row = rows.find((item) => item.printSurfaceId === "fascia-print")!;
  assert.equal(row.status, "ready");
  assert.equal(row.exportFileName, "Limec_Predni.pdf");
});

test("PREVIEW ONLY: a preview-role asset attached never resolves to ready", () => {
  const files = [graphicsFile({ id: "art-1", name: "01.png", usageRole: "preview", asset: asset({ id: "a1", storageKey: "k1", mimeType: "image/png", originalFileName: "01.png" }) })];
  const assignments = [assignment({ printSurfaceId: "fascia-print", selectedForPrint: true, artworkFileId: "art-1", artworkStatus: "received" })];
  const rows = readiness(assignments, files);
  assert.equal(rows.find((item) => item.printSurfaceId === "fascia-print")?.status, "preview-only");
});

test("PREVIEW ONLY: a legacy asset with no usageRole at all defaults to preview-only, never assumed print-ready", () => {
  const files = [graphicsFile({ id: "art-1", name: "01.png", asset: asset({ id: "a1", storageKey: "k1", mimeType: "image/png", originalFileName: "01.png" }) })];
  const assignments = [assignment({ printSurfaceId: "fascia-print", selectedForPrint: true, artworkFileId: "art-1", artworkStatus: "received" })];
  const rows = readiness(assignments, files);
  assert.equal(rows.find((item) => item.printSurfaceId === "fascia-print")?.status, "preview-only");
});

test("MISSING: a surface selected for print with no artworkFileId gets status missing", () => {
  const assignments = [assignment({ printSurfaceId: "fascia-print", selectedForPrint: true })];
  const rows = readiness(assignments, []);
  assert.equal(rows.find((item) => item.printSurfaceId === "fascia-print")?.status, "missing");
});

test("MISSING: a dangling artworkFileId (no matching GraphicFileReference at all) gets status missing, not source-missing", () => {
  const assignments = [assignment({ printSurfaceId: "fascia-print", selectedForPrint: true, artworkFileId: "does-not-exist", artworkStatus: "received" })];
  const rows = readiness(assignments, []);
  assert.equal(rows.find((item) => item.printSurfaceId === "fascia-print")?.status, "missing");
});

test("SOURCE MISSING: a resolved GraphicFileReference with no StoredAsset attached gets status source-missing, not missing", () => {
  const files = [graphicsFile({ id: "art-1", name: "01.pdf" })]; // no .asset
  const assignments = [assignment({ printSurfaceId: "fascia-print", selectedForPrint: true, artworkFileId: "art-1", artworkStatus: "received" })];
  const rows = readiness(assignments, files);
  assert.equal(rows.find((item) => item.printSurfaceId === "fascia-print")?.status, "source-missing");
});

test("NOT SELECTED FOR PRINT: a surface never flagged selectedForPrint is excluded from readiness entirely — never a 5th status", () => {
  const assignments = [assignment({ printSurfaceId: "fascia-print", selectedForPrint: false })];
  const rows = readiness(assignments, []);
  assert.equal(rows.find((item) => item.printSurfaceId === "fascia-print"), undefined);
});

test("SELECTION: selectProductionReadyRows only ever returns status-ready rows the caller included, never preview-only/missing", () => {
  const files = [
    graphicsFile({ id: "ready-1", name: "01.pdf", usageRole: "print-data", asset: asset({ id: "a1", storageKey: "k1" }) }),
    graphicsFile({ id: "preview-1", name: "02.png", usageRole: "preview", asset: asset({ id: "a2", storageKey: "k2", mimeType: "image/png", originalFileName: "02.png" }) }),
  ];
  const assignments = [
    assignment({ printSurfaceId: "fascia-print", selectedForPrint: true, artworkFileId: "ready-1", artworkStatus: "received" }),
    assignment({ printSurfaceId: "back-wall-01-front", selectedForPrint: true, artworkFileId: "preview-1", artworkStatus: "received" }),
  ];
  const rows = readiness(assignments, files);
  const included = new Set(rows.map((row) => row.printSurfaceId)); // include everything the caller offers
  const selected = selectProductionReadyRows(rows, included);
  assert.deepEqual(selected.map((row) => row.printSurfaceId), ["fascia-print"]);
});

test("SELECTION: a ready row explicitly excluded by the caller's include-set is not returned", () => {
  const files = [graphicsFile({ id: "ready-1", name: "01.pdf", usageRole: "print-data", asset: asset({ id: "a1", storageKey: "k1" }) })];
  const assignments = [assignment({ printSurfaceId: "fascia-print", selectedForPrint: true, artworkFileId: "ready-1", artworkStatus: "received" })];
  const rows = readiness(assignments, files);
  assert.deepEqual(selectProductionReadyRows(rows, new Set()), []);
});

// =========================================================================================
// Production dimensions (report section 18): always the CURRENT realization resolver, never a
// persisted assignment snapshot — same discipline as domain/graphicsExport.ts.
// =========================================================================================

test("REALIZATION CHANGE: readiness production dimensions follow the current realizationProfileId", () => {
  const surfaceWithBleed: PrintSurface = { id: "fascia-print", name: "Límec", widthMm: 2000, heightMm: 300, active: true, pricingUnit: "bm", allowanceLinearMeters: 2, group: { id: "fascia", name: "Límec", order: 0 }, productionProfiles: { "realization-2": { bleedLeftMm: 25, bleedRightMm: 25, bleedTopMm: 0, bleedBottomMm: 0 } } };
  const boothWithBleed = { printSurfaces: [surfaceWithBleed] };
  const files = [graphicsFile({ id: "art-1", name: "01.pdf", usageRole: "print-data", asset: asset({ id: "a1", storageKey: "k1" }) })];
  const assignments = [assignment({ printSurfaceId: "fascia-print", selectedForPrint: true, artworkFileId: "art-1", artworkStatus: "received" })];
  const withDefault = readiness(assignments, files, boothWithBleed, DEFAULT_REALIZATION_PROFILE_ID)[0]!;
  const withRealization2 = readiness(assignments, files, boothWithBleed, "realization-2")[0]!;
  assert.equal(withDefault.productionWidthMm, 2000);
  assert.equal(withRealization2.productionWidthMm, 2050);
  assert.notEqual(withDefault.productionWidthMm, withRealization2.productionWidthMm);
});

test("STALE SNAPSHOT IGNORED: a wildly wrong assignment.productionWidthMm/HeightMm snapshot never leaks into the readiness row", () => {
  const files = [graphicsFile({ id: "art-1", name: "01.pdf", usageRole: "print-data", asset: asset({ id: "a1", storageKey: "k1" }) })];
  const assignments = [assignment({ printSurfaceId: "fascia-print", selectedForPrint: true, artworkFileId: "art-1", artworkStatus: "received", productionWidthMm: 999999, productionHeightMm: 999999 })];
  const rows = readiness(assignments, files);
  const row = rows.find((item) => item.printSurfaceId === "fascia-print")!;
  assert.notEqual(row.productionWidthMm, 999999);
  assert.equal(row.productionWidthMm, 2000);
});

// =========================================================================================
// Surface-based handoff (report sections 8/16/17): one entry per SURFACE, never per asset.
// =========================================================================================

test("SHARED ARTWORK: the same graphicsFile.id used on two different surfaces yields two independent readiness rows", () => {
  const shared = graphicsFile({ id: "shared-1", name: "shared.pdf", usageRole: "print-data", asset: asset({ id: "a1", storageKey: "k1" }) });
  const assignments = [
    assignment({ printSurfaceId: "back-wall-01-front", selectedForPrint: true, artworkFileId: "shared-1", artworkStatus: "received" }),
    assignment({ printSurfaceId: "back-wall-02-front", selectedForPrint: true, artworkFileId: "shared-1", artworkStatus: "received" }),
  ];
  const rows = readiness(assignments, [shared]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.printSurfaceId).sort(), ["back-wall-01-front", "back-wall-02-front"]);
  assert.ok(rows.every((row) => row.status === "ready"));
});

test("DUPLICATE FILENAMES: two surfaces producing the same generated export name get deterministic -2/-3 suffixes, never overwriting", () => {
  const surfaceA: PrintSurface = { id: "twin-a", name: "Panel", widthMm: 900, heightMm: 1000, active: true, group: { id: "twins", name: "Dvojče", order: 0 }, sceneBinding: { nodeName: "n1", face: "front", coordinateSpace: "node-local", localNormalAxis: "-y" } };
  const surfaceB: PrintSurface = { id: "twin-b", name: "Panel", widthMm: 900, heightMm: 1000, active: true, group: { id: "twins", name: "Dvojče", order: 0 }, sceneBinding: { nodeName: "n2", face: "front", coordinateSpace: "node-local", localNormalAxis: "-y" } };
  const booth = { printSurfaces: [surfaceA, surfaceB] };
  const files = [
    graphicsFile({ id: "art-a", name: "a.pdf", usageRole: "print-data", asset: asset({ id: "aa", storageKey: "ka" }) }),
    graphicsFile({ id: "art-b", name: "b.pdf", usageRole: "print-data", asset: asset({ id: "ab", storageKey: "kb" }) }),
  ];
  const assignments = [
    assignment({ printSurfaceId: "twin-a", selectedForPrint: true, artworkFileId: "art-a", artworkStatus: "received" }),
    assignment({ printSurfaceId: "twin-b", selectedForPrint: true, artworkFileId: "art-b", artworkStatus: "received" }),
  ];
  const rows = readiness(assignments, files, booth);
  const names = rows.map((row) => row.exportFileName).sort();
  assert.deepEqual(names, ["Dvojce_Panel_Predni-2.pdf", "Dvojce_Panel_Predni.pdf"]);
  assert.notEqual(names[0], names[1], "never the same filename twice — one would silently overwrite the other in the ZIP");
});

// =========================================================================================
// Folder planning (report section 7) — grouping derives purely from row metadata, never a
// P86-specific folder table.
// =========================================================================================

test("FOLDER PLAN: a single-group ready set stays flat under PRINT_DATA/", () => {
  const files = [graphicsFile({ id: "art-1", name: "01.pdf", usageRole: "print-data", asset: asset({ id: "a1", storageKey: "k1" }) })];
  const assignments = [assignment({ printSurfaceId: "fascia-print", selectedForPrint: true, artworkFileId: "art-1", artworkStatus: "received" })];
  const rows = readiness(assignments, files);
  const plan = planGraphicsProductionFolders(rows);
  assert.equal(plan[0]?.path, "PRINT_DATA/Limec_Predni.pdf");
});

test("FOLDER PLAN: a multi-group ready set is grouped under PRINT_DATA/<GROUP>/, derived purely from group metadata", () => {
  const files = [
    graphicsFile({ id: "art-1", name: "01.pdf", usageRole: "print-data", asset: asset({ id: "a1", storageKey: "k1" }) }),
    graphicsFile({ id: "art-2", name: "02.pdf", usageRole: "print-data", asset: asset({ id: "a2", storageKey: "k2" }) }),
  ];
  const assignments = [
    assignment({ printSurfaceId: "fascia-print", selectedForPrint: true, artworkFileId: "art-1", artworkStatus: "received" }),
    assignment({ printSurfaceId: "back-wall-01-front", selectedForPrint: true, artworkFileId: "art-2", artworkStatus: "received" }),
  ];
  const rows = readiness(assignments, files);
  const plan = planGraphicsProductionFolders(rows);
  assert.ok(plan.every((entry) => entry.path.startsWith("PRINT_DATA/")));
  const fasciaEntry = plan.find((entry) => entry.row.printSurfaceId === "fascia-print")!;
  const wallEntry = plan.find((entry) => entry.row.printSurfaceId === "back-wall-01-front")!;
  assert.match(fasciaEntry.path, /^PRINT_DATA\/LIMEC\//u);
  assert.match(wallEntry.path, /^PRINT_DATA\/ZADNI_STENA\//u);
});

// =========================================================================================
// Package naming (report section 15) — same sanitizer principle as artwork filenames.
// =========================================================================================

test("PACKAGE NAME: filesystem-safe, event/project driven, no revision suffix when none given", () => {
  assert.equal(buildGraphicsProductionPackageName({ eventName: "Beauty", projectName: "Test01" }), "FOR_BEAUTY_Test01_GRAFIKA");
});

test("PACKAGE NAME: revision, when given, is a zero-padded suffix", () => {
  assert.equal(buildGraphicsProductionPackageName({ eventName: "Beauty", projectName: "Test01", revision: 1 }), "FOR_BEAUTY_Test01_GRAFIKA_R01");
});

// =========================================================================================
// Manifest (report sections 11/13/19) — machine-readable contract, no storage secrets.
// =========================================================================================

test("MANIFEST: surfaces carry correct dims/face/file names per surface", () => {
  const files = [graphicsFile({ id: "art-1", name: "01.pdf", usageRole: "print-data", asset: asset({ id: "a1", storageKey: "k1", mimeType: "application/pdf" }) })];
  const assignments = [assignment({ printSurfaceId: "fascia-print", selectedForPrint: true, artworkFileId: "art-1", artworkStatus: "received" })];
  const readyRows = selectProductionReadyRows(readiness(assignments, files), new Set(["fascia-print"]));
  const manifest = buildGraphicsProductionManifest(readyRows, {
    projectName: "Test01", company: "ACME", eventName: "Beauty",
    realizationProfileId: DEFAULT_REALIZATION_PROFILE_ID, realizationLabel: "Výchozí realizace",
    generatedAt: "2026-08-26T10:00:00.000Z",
  });
  assert.equal(manifest.version, 1);
  assert.equal(manifest.surfaces.length, 1);
  const surface = manifest.surfaces[0]!;
  assert.equal(surface.printSurfaceId, "fascia-print");
  assert.equal(surface.face, "front");
  assert.equal(surface.exportFileName, "Limec_Predni.pdf");
  assert.equal(surface.mimeType, "application/pdf");
  assert.equal(surface.productionWidthMm, 2000);
  assert.equal(surface.canonicalWidthMm, 2000);
});

test("MANIFEST: never contains a storageKey field anywhere in its serialized output", () => {
  const files = [graphicsFile({ id: "art-1", name: "01.pdf", usageRole: "print-data", asset: asset({ id: "a1", storageKey: "super-secret-internal-key" }) })];
  const assignments = [assignment({ printSurfaceId: "fascia-print", selectedForPrint: true, artworkFileId: "art-1", artworkStatus: "received" })];
  const readyRows = selectProductionReadyRows(readiness(assignments, files), new Set(["fascia-print"]));
  const manifest = buildGraphicsProductionManifest(readyRows, {
    projectName: "Test01", company: "ACME", eventName: "Beauty",
    realizationProfileId: DEFAULT_REALIZATION_PROFILE_ID, realizationLabel: "Výchozí realizace",
    generatedAt: "2026-08-26T10:00:00.000Z",
  });
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /storageKey/u);
  assert.doesNotMatch(serialized, /super-secret-internal-key/u);
});

test("MANIFEST: preparedBy/revision are omitted entirely when not provided — never a fake/empty entry", () => {
  const files = [graphicsFile({ id: "art-1", name: "01.pdf", usageRole: "print-data", asset: asset({ id: "a1", storageKey: "k1" }) })];
  const assignments = [assignment({ printSurfaceId: "fascia-print", selectedForPrint: true, artworkFileId: "art-1", artworkStatus: "received" })];
  const readyRows = selectProductionReadyRows(readiness(assignments, files), new Set(["fascia-print"]));
  const manifest = buildGraphicsProductionManifest(readyRows, {
    projectName: "Test01", company: "ACME", eventName: "Beauty",
    realizationProfileId: DEFAULT_REALIZATION_PROFILE_ID, realizationLabel: "Výchozí realizace",
    generatedAt: "2026-08-26T10:00:00.000Z",
  });
  assert.equal(manifest.preparedBy, undefined);
  assert.equal(manifest.revision, undefined);
});

test("MANIFEST: preparedBy is carried through verbatim when the caller provides it", () => {
  const files = [graphicsFile({ id: "art-1", name: "01.pdf", usageRole: "print-data", asset: asset({ id: "a1", storageKey: "k1" }) })];
  const assignments = [assignment({ printSurfaceId: "fascia-print", selectedForPrint: true, artworkFileId: "art-1", artworkStatus: "received" })];
  const readyRows = selectProductionReadyRows(readiness(assignments, files), new Set(["fascia-print"]));
  const preparedBy = { name: "Jan Novák", email: "jan@example.cz" };
  const manifest = buildGraphicsProductionManifest(readyRows, {
    projectName: "Test01", company: "ACME", eventName: "Beauty",
    realizationProfileId: DEFAULT_REALIZATION_PROFILE_ID, realizationLabel: "Výchozí realizace",
    generatedAt: "2026-08-26T10:00:00.000Z", revision: 2, preparedBy,
  });
  assert.deepEqual(manifest.preparedBy, preparedBy);
  assert.equal(manifest.revision, 2);
});

// =========================================================================================
// Genericity (report section 26) — never P86/wall/fascia-specific; any future PrintSurface
// works automatically.
// =========================================================================================

test("NON-P86 SURFACE: a fully synthetic printable surface (counter front) works with zero special-casing", () => {
  const counterSurface: PrintSurface = {
    id: "counter-front-01", name: "Čelo", widthMm: 900, heightMm: 1100, active: true,
    group: { id: "counter", name: "Pult", order: 9 },
    sceneBinding: { nodeName: "HWS_COUNTER__FRONT", face: "front", coordinateSpace: "node-local", localNormalAxis: "-y" },
  };
  const otherBooth = { printSurfaces: [counterSurface] };
  const files = [graphicsFile({ id: "art-1", name: "01.pdf", usageRole: "print-data", asset: asset({ id: "a1", storageKey: "k1" }) })];
  const assignments = [assignment({ printSurfaceId: "counter-front-01", selectedForPrint: true, artworkFileId: "art-1", artworkStatus: "received" })];
  const rows = readiness(assignments, files, otherBooth);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, "ready");
  assert.equal(rows[0]?.displayName, "Pult – Čelo – Přední");
});

test("NO PACKAGE METADATA: a booth with no packageContents at all still produces a valid ready row — P86 package wiring is never required", () => {
  const surface: PrintSurface = { id: "generic-panel", name: "Panel", widthMm: 800, heightMm: 800, active: true };
  const boothWithoutPackage = { printSurfaces: [surface] }; // no packageContents key at all
  const files = [graphicsFile({ id: "art-1", name: "01.pdf", usageRole: "print-data", asset: asset({ id: "a1", storageKey: "k1" }) })];
  const assignments = [assignment({ printSurfaceId: "generic-panel", selectedForPrint: true, artworkFileId: "art-1", artworkStatus: "received" })];
  const rows = readiness(assignments, files, boothWithoutPackage);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, "ready");
});
