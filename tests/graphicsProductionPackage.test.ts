import assert from "node:assert/strict";
import test from "node:test";
import {
  assembleGraphicsProductionZipEntries,
  type DownloadAssetBytes,
} from "../lib/graphicsProductionPackage.ts";
import {
  buildGraphicsProductionManifest,
  planGraphicsProductionFolders,
  type GraphicsProductionReadinessRow,
} from "../domain/graphicsProduction.ts";
import { DEFAULT_REALIZATION_PROFILE_ID } from "../data/realizationProfiles.ts";
import type { GraphicsSurfacePricingResult } from "../domain/technicalServices.ts";

const NOT_PRICED: GraphicsSurfacePricingResult = {
  printSurfaceId: "n/a", pricingBasis: "m²", quantity: 0, includedInPackage: false, status: "needs-quote",
};

function readyRow(overrides: Partial<GraphicsProductionReadinessRow> & Pick<GraphicsProductionReadinessRow, "printSurfaceId" | "groupId" | "groupName" | "name" | "exportFileName" | "sourceFileName">): GraphicsProductionReadinessRow {
  return {
    face: "front",
    status: "ready",
    displayName: `${overrides.groupName} – ${overrides.name} – Přední`,
    canonicalWidthMm: 900,
    canonicalHeightMm: 1000,
    productionWidthMm: 900,
    productionHeightMm: 1000,
    bleedLeftMm: 0,
    bleedRightMm: 0,
    bleedTopMm: 0,
    bleedBottomMm: 0,
    realizationProfileId: DEFAULT_REALIZATION_PROFILE_ID,
    usageRole: "print-data",
    displayFileName: overrides.sourceFileName,
    artworkAsset: { id: `asset-${overrides.printSurfaceId}`, storageKey: `key-${overrides.printSurfaceId}`, originalFileName: overrides.sourceFileName, mimeType: "application/pdf", size: 10, createdAt: "2026-08-26T00:00:00.000Z", category: "project-graphics" },
    pricing: NOT_PRICED,
    ...overrides,
  };
}

const MANIFEST_CONTEXT = {
  projectName: "Test01", company: "ACME s.r.o.", eventName: "Beauty",
  realizationProfileId: DEFAULT_REALIZATION_PROFILE_ID, realizationLabel: "Výchozí realizace",
  generatedAt: "2026-08-26T10:00:00.000Z",
};

// =========================================================================================
// Graphics Production Package v1 (report sections 7/8/16/23/29): the ZIP builder's async
// assembly, with an injected downloadAssetBytes so this stays testable under node:test with
// zero network access.
// =========================================================================================

test("PACKAGE: produces manifest.json + manifest.pdf + unmodified PRINT_DATA bytes for two files", async () => {
  const rowA = readyRow({ printSurfaceId: "surf-a", groupId: "g", groupName: "Zadní stěna", name: "Panel 1", exportFileName: "fileA.pdf", sourceFileName: "fileA.pdf" });
  const rowB = readyRow({ printSurfaceId: "surf-b", groupId: "g", groupName: "Zadní stěna", name: "Panel 2", exportFileName: "fileB.pdf", sourceFileName: "fileB.pdf" });
  const readyRows = [rowA, rowB];
  const folderPlan = planGraphicsProductionFolders(readyRows);
  const manifest = buildGraphicsProductionManifest(readyRows, MANIFEST_CONTEXT);

  const fixtureBytes: Record<string, Uint8Array> = {
    "key-surf-a": new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252]),
    "key-surf-b": new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1]),
  };
  const downloadAssetBytes: DownloadAssetBytes = async (storageKey) => {
    const bytes = fixtureBytes[storageKey];
    if (!bytes) throw new Error(`unexpected storageKey ${storageKey}`);
    return bytes;
  };

  const result = await assembleGraphicsProductionZipEntries(
    { readyRows, manifest, packageName: "FOR_BEAUTY_Test01_GRAFIKA", folderPlan },
    { downloadAssetBytes },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const manifestJsonEntry = result.entries.find((entry) => entry.path.endsWith("manifest.json"));
  assert.ok(manifestJsonEntry, "expected a manifest.json entry");
  const parsedManifest = JSON.parse(new TextDecoder().decode(manifestJsonEntry!.data));
  assert.equal(parsedManifest.version, 1);
  assert.equal(parsedManifest.surfaces.length, 2);

  const manifestPdfEntry = result.entries.find((entry) => entry.path.endsWith("manifest.pdf"));
  assert.ok(manifestPdfEntry, "expected a manifest.pdf entry");
  const pdfHeader = new TextDecoder().decode(manifestPdfEntry!.data.slice(0, 5));
  assert.equal(pdfHeader, "%PDF-", "manifest.pdf must be a real PDF binary");

  const fileAEntry = result.entries.find((entry) => entry.path.includes("fileA.pdf"));
  const fileBEntry = result.entries.find((entry) => entry.path.includes("fileB.pdf"));
  assert.ok(fileAEntry, "expected fileA in PRINT_DATA");
  assert.ok(fileBEntry, "expected fileB in PRINT_DATA");
  assert.deepEqual(fileAEntry!.data, fixtureBytes["key-surf-a"], "source bytes must be byte-for-byte unmodified — never re-encoded");
  assert.deepEqual(fileBEntry!.data, fixtureBytes["key-surf-b"], "source bytes must be byte-for-byte unmodified — never re-encoded");
  assert.match(fileAEntry!.path, /^FOR_BEAUTY_Test01_GRAFIKA\/PRINT_DATA\//u);
});

test("PACKAGE: same graphicsFile used on two surfaces still produces two independent PRINT_DATA entries", async () => {
  const sharedBytes = new Uint8Array([42, 42, 42]);
  const rowA = readyRow({ printSurfaceId: "surf-a", groupId: "g", groupName: "Zadní stěna", name: "Panel 1", exportFileName: "Zadni_stena_Panel_01_Predni.pdf", sourceFileName: "shared.pdf" });
  const rowB = readyRow({ printSurfaceId: "surf-b", groupId: "g", groupName: "Zadní stěna", name: "Panel 2", exportFileName: "Zadni_stena_Panel_02_Predni.pdf", sourceFileName: "shared.pdf" });
  const readyRows = [rowA, rowB];
  const folderPlan = planGraphicsProductionFolders(readyRows);
  const manifest = buildGraphicsProductionManifest(readyRows, MANIFEST_CONTEXT);
  const downloadAssetBytes: DownloadAssetBytes = async () => sharedBytes;

  const result = await assembleGraphicsProductionZipEntries({ readyRows, manifest, packageName: "PKG", folderPlan }, { downloadAssetBytes });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const printDataEntries = result.entries.filter((entry) => entry.path.includes("PRINT_DATA/"));
  assert.equal(printDataEntries.length, 2, "one surface-based file per surface, even for identical source bytes");
  assert.notEqual(printDataEntries[0]!.path, printDataEntries[1]!.path);
});

test("PACKAGE: any download failure fails the whole package and lists which files failed, never a partial ZIP", async () => {
  const rowA = readyRow({ printSurfaceId: "surf-a", groupId: "g", groupName: "Zadní stěna", name: "Panel 1", exportFileName: "fileA.pdf", sourceFileName: "fileA.pdf" });
  const rowB = readyRow({ printSurfaceId: "surf-b", groupId: "g", groupName: "Zadní stěna", name: "Panel 2", exportFileName: "fileB.pdf", sourceFileName: "fileB.pdf" });
  const readyRows = [rowA, rowB];
  const folderPlan = planGraphicsProductionFolders(readyRows);
  const manifest = buildGraphicsProductionManifest(readyRows, MANIFEST_CONTEXT);
  const downloadAssetBytes: DownloadAssetBytes = async (storageKey) => {
    if (storageKey === "key-surf-b") throw new Error("simulated R2 fetch failure");
    return new Uint8Array([1, 2, 3]);
  };

  const result = await assembleGraphicsProductionZipEntries({ readyRows, manifest, packageName: "PKG", folderPlan }, { downloadAssetBytes });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.failedFiles, ["fileB.pdf"]);
});

test("PACKAGE: progress callback reports completed/total as each file is processed", async () => {
  const rowA = readyRow({ printSurfaceId: "surf-a", groupId: "g", groupName: "Zadní stěna", name: "Panel 1", exportFileName: "fileA.pdf", sourceFileName: "fileA.pdf" });
  const readyRows = [rowA];
  const folderPlan = planGraphicsProductionFolders(readyRows);
  const manifest = buildGraphicsProductionManifest(readyRows, MANIFEST_CONTEXT);
  const progressCalls: Array<{ completed: number; total: number }> = [];
  const downloadAssetBytes: DownloadAssetBytes = async () => new Uint8Array([1]);

  await assembleGraphicsProductionZipEntries(
    { readyRows, manifest, packageName: "PKG", folderPlan },
    { downloadAssetBytes, onProgress: (progress) => progressCalls.push({ completed: progress.completed, total: progress.total }) },
  );
  assert.deepEqual(progressCalls, [{ completed: 0, total: 1 }, { completed: 1, total: 1 }]);
});
