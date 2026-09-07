import assert from "node:assert/strict";
import test from "node:test";
import {
  addPrintSurfaceItemWithPlacement,
  addPrintSurfaceView,
  buildPrintSurfaceProjectFingerprint,
  createPrintSurfaceProject,
  diffPrintSurfaceProjectFingerprints,
  isPrintSurfacePdfCurrent,
  migrateLegacyPrintSurfaceDocument,
  movePlacement,
  printSurfaceProjectFingerprintsEqual,
  resolvePrintSurfaceItemQuantity,
  updatePrintSurfaceItem,
  withItems,
  withLatestPdf,
  withPlacements,
  withProjectFields,
  type PrintSurfaceLatestPdf,
  type PrintSurfaceProject,
  type PrintSurfaceProjectImage,
  type PrintSurfaceView,
} from "../domain/printSurfaceProject.ts";
import { readFileSync } from "node:fs";
import { SupabasePrintSurfaceProjectRepository } from "../lib/db/printSurfaceProjectRepository.supabase.ts";

// =============================================================================================
// "PDF se sám po čase označí jako neaktuální" — false-stale investigation.
//
// FINDING (see the final report for the full write-up): exhaustive tracing of
// buildPrintSurfaceProjectFingerprint / isPrintSurfacePdfCurrent / the full
// SupabasePrintSurfaceProjectRepository create->attach->save->reload round trip found NO source
// of drift — the fingerprint already only reads PDF-relevant fields (never updatedAt/createdAt/
// generatedAt/latestPdf itself/sentAt/sentBy/status/any Date.now()), and a pure JSON round trip
// (exactly what an HTTP request body / Postgres jsonb column undergoes) reproduces byte-identical
// output. This file locks that guarantee down with explicit regression tests (spec section 22),
// and hardens the fingerprint further against two classes of DRIFT RISK that were real even though
// not proven to be live bugs: locale-dependent sort order (`localeCompare` swapped for a plain
// ordinal comparator) and floating-point representation noise (coordinates rounded to
// PRINT_SURFACE_FINGERPRINT_COORDINATE_PRECISION decimal places).
// =============================================================================================

function makeImage(seed: string): PrintSurfaceProjectImage {
  return {
    asset: { id: `asset-${seed}`, storageKey: `print-surfaces/p1/image/${seed}.jpg`, originalFileName: `${seed}.jpg`, mimeType: "image/jpeg", size: 100, createdAt: "2026-01-01T00:00:00.000Z", category: "print-surface-image" },
    widthPx: 800,
    heightPx: 600,
  };
}

function buildFixtureProject(): PrintSurfaceProject {
  let project = createPrintSurfaceProject({ name: "Test 001", companyName: "ACME", eventId: "for-beauty-2026", realizationCompanyId: "gendai" }, "project-1", "2026-01-01T00:00:00.000Z");
  project = addPrintSurfaceView(project, makeImage("front"), "view-front");
  project = addPrintSurfaceItemWithPlacement(project, { typeId: "panel" }, "view-front", 0.3, 0.4, { itemId: "item-a" }).project;
  return project;
}

function attachLatestPdf(project: PrintSurfaceProject, generatedAt = "2026-01-01T00:00:00.000Z"): PrintSurfaceProject {
  const latestPdf: PrintSurfaceLatestPdf = {
    storageKey: "print-surfaces/p1/export/uuid-1.pdf",
    fileName: "Tiskove_plochy_Test_001.pdf",
    generatedAt,
    projectFingerprint: buildPrintSurfaceProjectFingerprint(project),
  };
  return withLatestPdf(project, latestPdf);
}

// ---------------------------------------------------------------------------------------------
// A) passage of time alone, no content change -> still current
// ---------------------------------------------------------------------------------------------
test("A) FALSE-STALE: pure passage of time (no content edit) never flips isPrintSurfacePdfCurrent", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const project = buildFixtureProject();
  const withPdf = attachLatestPdf(project);
  assert.equal(isPrintSurfacePdfCurrent(withPdf, withPdf.latestPdf), true);

  t.mock.timers.tick(1000 * 60 * 60 * 24 * 30); // 30 days forward, nothing else changes
  assert.equal(isPrintSurfacePdfCurrent(withPdf, withPdf.latestPdf), true, "current status must not depend on wall-clock time");
  t.mock.timers.reset();
});

// ---------------------------------------------------------------------------------------------
// B) debounced autosave (save + reload, no edits) -> still current
// ---------------------------------------------------------------------------------------------
test("B) FALSE-STALE: a debounced autosave round trip (repository.save then reload) with no user edits never invalidates the PDF", async () => {
  const client = createFakeSupabaseClient();
  const repository = new SupabasePrintSurfaceProjectRepository(client as never);
  const created = await repository.create({ name: "Test 001", companyName: "ACME", eventId: "for-beauty-2026", realizationCompanyId: "gendai" });
  const withView = addPrintSurfaceView(created, makeImage("front"), "view-front");
  const { project: withItem } = addPrintSurfaceItemWithPlacement(withView, { typeId: "panel" }, "view-front", 0.3, 0.4, { itemId: "item-a" });
  const withPdf = attachLatestPdf(withItem);
  await repository.save(withPdf);

  // simulate the debounced autosave firing again later with the SAME (unedited) in-memory project —
  // exactly what PrintSurfaceEditorPage's useEffect does on any project state change, discarding the result.
  await repository.save(withPdf);
  const reloaded = await repository.get(withPdf.id);
  assert.ok(reloaded);
  assert.equal(isPrintSurfacePdfCurrent(reloaded!, reloaded!.latestPdf), true);
});

// ---------------------------------------------------------------------------------------------
// C) DB serialize/read round trip -> still current
// ---------------------------------------------------------------------------------------------
test("C) FALSE-STALE: full repository create -> attach latestPdf -> save -> get() reload round trip preserves current status", async () => {
  const client = createFakeSupabaseClient();
  const repository = new SupabasePrintSurfaceProjectRepository(client as never);
  const created = await repository.create({ name: "Test 001", companyName: "ACME" });
  const withView = addPrintSurfaceView(created, makeImage("front"), "view-front");
  const { project: withItem } = addPrintSurfaceItemWithPlacement(withView, { typeId: "panel" }, "view-front", 0.123456789, 0.987654321, { itemId: "item-a" });
  const withPdf = attachLatestPdf(withItem);

  await repository.save(withPdf);
  const reloaded = await repository.get(withPdf.id);
  assert.ok(reloaded);
  assert.equal(isPrintSurfacePdfCurrent(reloaded!, reloaded!.latestPdf), true);
  assert.deepEqual(buildPrintSurfaceProjectFingerprint(reloaded!), buildPrintSurfaceProjectFingerprint(withPdf));
});

// ---------------------------------------------------------------------------------------------
// D) only updatedAt changes -> still current (updatedAt is not part of the fingerprint at all)
// ---------------------------------------------------------------------------------------------
test("D) FALSE-STALE: bumping updatedAt alone (no PDF-relevant field touched) never invalidates the PDF", () => {
  const project = buildFixtureProject();
  const withPdf = attachLatestPdf(project);
  const onlyTimestampChanged: PrintSurfaceProject = { ...withPdf, updatedAt: "2099-01-01T00:00:00.000Z" };
  assert.equal(isPrintSurfacePdfCurrent(onlyTimestampChanged, onlyTimestampChanged.latestPdf), true);
});

// ---------------------------------------------------------------------------------------------
// E) latestPdf.generatedAt changing on its own doesn't change the CONTENT fingerprint
// ---------------------------------------------------------------------------------------------
test("E) latestPdf.generatedAt is metadata about WHEN, never fed into the content fingerprint itself", () => {
  const project = buildFixtureProject();
  const fingerprint = buildPrintSurfaceProjectFingerprint(project);
  const pdfA: PrintSurfaceLatestPdf = { storageKey: "k1", fileName: "f.pdf", generatedAt: "2026-01-01T00:00:00.000Z", projectFingerprint: fingerprint };
  const pdfB: PrintSurfaceLatestPdf = { storageKey: "k1", fileName: "f.pdf", generatedAt: "2026-06-15T10:30:00.000Z", projectFingerprint: fingerprint };
  assert.ok(printSurfaceProjectFingerprintsEqual(pdfA.projectFingerprint, pdfB.projectFingerprint));
  assert.equal(isPrintSurfacePdfCurrent(project, pdfA), isPrintSurfacePdfCurrent(project, pdfB));
});

// ---------------------------------------------------------------------------------------------
// F) same arrays in different ordering -> canonical fingerprint identical
// ---------------------------------------------------------------------------------------------
test("F) FALSE-STALE: array order differences (e.g. a DB round trip returning items in a different order) never invalidate the PDF", () => {
  let project = createPrintSurfaceProject({ name: "X", companyName: "ACME" }, "p2");
  project = addPrintSurfaceView(project, makeImage("front"), "view-front");
  project = addPrintSurfaceItemWithPlacement(project, { typeId: "panel" }, "view-front", 0.1, 0.1, { itemId: "item-a" }).project;
  project = addPrintSurfaceItemWithPlacement(project, { typeId: "panel" }, "view-front", 0.2, 0.2, { itemId: "item-b" }).project;

  const reordered: PrintSurfaceProject = { ...project, items: [...project.items].reverse(), placements: [...project.placements].reverse() };
  assert.ok(printSurfaceProjectFingerprintsEqual(buildPrintSurfaceProjectFingerprint(project), buildPrintSurfaceProjectFingerprint(reordered)));

  const withPdf = attachLatestPdf(project);
  assert.equal(isPrintSurfacePdfCurrent(reordered, withPdf.latestPdf), true);
});

// ---------------------------------------------------------------------------------------------
// G) stable storageKey, different runtime/signed URL data -> fingerprint identical
// ---------------------------------------------------------------------------------------------
test("G) FALSE-STALE: the image fingerprint uses only the stable storageKey — a different checksum/displayName/asset id on re-upload of the SAME logical file never invalidates the PDF", () => {
  const project = buildFixtureProject();
  const sameStorageKeyDifferentMetadata: PrintSurfaceProject = {
    ...project,
    views: project.views.map((view) => ({
      ...view,
      image: {
        ...view.image,
        asset: { ...view.image.asset, id: "a-completely-different-asset-record-id", checksum: "sha256-does-not-matter", displayName: "renamed-on-disk.jpg" },
      },
    })),
  };
  assert.ok(printSurfaceProjectFingerprintsEqual(buildPrintSurfaceProjectFingerprint(project), buildPrintSurfaceProjectFingerprint(sameStorageKeyDifferentMetadata)));
});

test("G2) the fingerprint type never carries a URL field at all — confirms no signed/temporary download URL can leak in", () => {
  const project = buildFixtureProject();
  const fingerprint = buildPrintSurfaceProjectFingerprint(project);
  const serialized = JSON.stringify(fingerprint);
  assert.doesNotMatch(serialized, /https?:\/\//u);
  assert.doesNotMatch(serialized, /expiresAt|expires_at|signature|X-Amz/iu);
});

// ---------------------------------------------------------------------------------------------
// Numeric stability (spec section 9): sub-visual float noise must not flip staleness.
// ---------------------------------------------------------------------------------------------
test("numeric stability: xNormalized/yNormalized differing only past the 6th decimal place (JSON/DB float representation noise) still compares as current", () => {
  const project = buildFixtureProject();
  const withPdf = attachLatestPdf(project);
  const noisy: PrintSurfaceProject = {
    ...project,
    placements: project.placements.map((placement) => ({ ...placement, xNormalized: placement.xNormalized + 1e-10, yNormalized: placement.yNormalized - 1e-10 })),
  };
  assert.equal(isPrintSurfacePdfCurrent(noisy, withPdf.latestPdf), true);
});

test("numeric stability does NOT mask a real, visually-significant move: a 1% (0.01) position change still invalidates", () => {
  const project = buildFixtureProject();
  const withPdf = attachLatestPdf(project);
  const moved = withPlacements(project, movePlacement(project.placements, project.placements[0]!.id, project.placements[0]!.xNormalized + 0.01, project.placements[0]!.yNormalized));
  assert.equal(isPrintSurfacePdfCurrent(moved, withPdf.latestPdf), false);
});

// ---------------------------------------------------------------------------------------------
// TRUE-STALE: every PDF-relevant edit must invalidate (spec section 23 / 14).
// ---------------------------------------------------------------------------------------------
test("TRUE-STALE: moving a marker placement invalidates the PDF", () => {
  const project = buildFixtureProject();
  const withPdf = attachLatestPdf(project);
  const moved = withPlacements(project, movePlacement(project.placements, project.placements[0]!.id, 0.9, 0.9));
  assert.equal(isPrintSurfacePdfCurrent(moved, withPdf.latestPdf), false);
});

test("TRUE-STALE: changing an item's preset invalidates the PDF", () => {
  const project = buildFixtureProject();
  const withPdf = attachLatestPdf(project);
  const edited = withItems(project, updatePrintSurfaceItem(project.items, "item-a", { presetId: "Panel_S_100" }));
  assert.equal(isPrintSurfacePdfCurrent(edited, withPdf.latestPdf), false);
});

test("TRUE-STALE: changing the project's realization company invalidates the PDF", () => {
  const project = buildFixtureProject();
  const withPdf = attachLatestPdf(project);
  const edited = withProjectFields(project, { realizationCompanyId: "macik" });
  assert.equal(isPrintSurfacePdfCurrent(edited, withPdf.latestPdf), false);
});

test("TRUE-STALE: changing an item's note invalidates the PDF", () => {
  const project = buildFixtureProject();
  const withPdf = attachLatestPdf(project);
  const edited = withItems(project, updatePrintSurfaceItem(project.items, "item-a", { note: "Pozor, křehké" }));
  assert.equal(isPrintSurfacePdfCurrent(edited, withPdf.latestPdf), false);
});

test("TRUE-STALE: adding a new item/placement invalidates the PDF", () => {
  const project = buildFixtureProject();
  const withPdf = attachLatestPdf(project);
  const { project: withNewItem } = addPrintSurfaceItemWithPlacement(project, { typeId: "panel" }, "view-front", 0.6, 0.6, { itemId: "item-b" });
  assert.equal(isPrintSurfacePdfCurrent(withNewItem, withPdf.latestPdf), false);
});

test("TRUE-STALE: replacing a view's image (different storageKey) invalidates the PDF", () => {
  const project = buildFixtureProject();
  const withPdf = attachLatestPdf(project);
  const edited: PrintSurfaceProject = { ...project, views: project.views.map((view) => ({ ...view, image: makeImage("back") })) };
  assert.equal(isPrintSurfacePdfCurrent(edited, withPdf.latestPdf), false);
});

test("TRUE-STALE: changing the event invalidates the PDF", () => {
  const project = buildFixtureProject();
  const withPdf = attachLatestPdf(project);
  const edited = withProjectFields(project, { eventId: "for-beauty-2027" });
  assert.equal(isPrintSurfacePdfCurrent(edited, withPdf.latestPdf), false);
});

test("draft/ready/sent status does NOT affect PDF freshness — it is deliberately outside the fingerprint (spec section 15: fingerprint = PDF content, not the whole DB row)", () => {
  const project = buildFixtureProject();
  const withPdf = attachLatestPdf(project);
  const sentVariant: PrintSurfaceProject = { ...project, status: "sent", sentAt: "2026-02-01T00:00:00.000Z", sentBy: "jan.novak" };
  assert.equal(isPrintSurfacePdfCurrent(sentVariant, withPdf.latestPdf), true);
});

// ---------------------------------------------------------------------------------------------
// Diagnostic diff helper (spec section 10) — dev/test only, reports which field(s) actually changed.
// ---------------------------------------------------------------------------------------------
test("diffPrintSurfaceProjectFingerprints reports no changed fields for two identical snapshots", () => {
  const project = buildFixtureProject();
  const fingerprint = buildPrintSurfaceProjectFingerprint(project);
  const diff = diffPrintSurfaceProjectFingerprints(fingerprint, buildPrintSurfaceProjectFingerprint(project));
  assert.equal(diff.equal, true);
  assert.deepEqual(diff.changedFields, []);
});

test("diffPrintSurfaceProjectFingerprints pinpoints exactly which section changed (placements) when a marker moves, and nothing else", () => {
  const project = buildFixtureProject();
  const before = buildPrintSurfaceProjectFingerprint(project);
  const moved = withPlacements(project, movePlacement(project.placements, project.placements[0]!.id, 0.9, 0.9));
  const diff = diffPrintSurfaceProjectFingerprints(before, buildPrintSurfaceProjectFingerprint(moved));
  assert.equal(diff.equal, false);
  assert.deepEqual(diff.changedFields, ["placements"]);
});

test("diffPrintSurfaceProjectFingerprints pinpoints name/companyName changes independently", () => {
  const project = buildFixtureProject();
  const before = buildPrintSurfaceProjectFingerprint(project);
  const renamed = withProjectFields(project, { name: "Test 002" });
  const diff = diffPrintSurfaceProjectFingerprints(before, buildPrintSurfaceProjectFingerprint(renamed));
  assert.deepEqual(diff.changedFields, ["name"]);
});

// =============================================================================================
// DEFAULT/NULL/UNDEFINED CANONICALIZATION (real-usage follow-up): semantically identical values
// serialized differently must produce IDENTICAL fingerprints, because buildPrintSurfaceExportViewModel
// already treats them as identical when actually rendering the PDF.
// =============================================================================================
test("resolvePrintSurfaceItemQuantity: undefined resolves to 1 — the SAME default buildPrintSurfaceExportViewModel's row builder uses (domain/printSurfaceExport.ts)", () => {
  assert.equal(resolvePrintSurfaceItemQuantity({ quantity: undefined }), 1);
  assert.equal(resolvePrintSurfaceItemQuantity({ quantity: 3 }), 3);
});

test("CANONICALIZATION: quantity undefined vs explicit 1 produce the SAME fingerprint (both render as '1 ks' in the PDF)", () => {
  const project = buildFixtureProject();
  const undefinedQuantity = withItems(project, updatePrintSurfaceItem(project.items, "item-a", { quantity: undefined }));
  const explicitQuantityOne = withItems(project, updatePrintSurfaceItem(project.items, "item-a", { quantity: 1 }));
  assert.ok(printSurfaceProjectFingerprintsEqual(buildPrintSurfaceProjectFingerprint(undefinedQuantity), buildPrintSurfaceProjectFingerprint(explicitQuantityOne)));
});

test("CANONICALIZATION: note undefined (malformed/legacy row) vs explicit '' produce the SAME fingerprint", () => {
  const project = buildFixtureProject();
  const withUndefinedNote: PrintSurfaceProject = { ...project, items: project.items.map((item) => ({ ...item, note: undefined as unknown as string })) };
  const withEmptyNote = withItems(project, updatePrintSurfaceItem(project.items, "item-a", { note: "" }));
  assert.ok(printSurfaceProjectFingerprintsEqual(buildPrintSurfaceProjectFingerprint(withUndefinedNote), buildPrintSurfaceProjectFingerprint(withEmptyNote)));
});

test("CANONICALIZATION: presetId/customWidthMm/customHeightMm null (possible legacy/DB round-trip shape) is treated the same as undefined", () => {
  const project = buildFixtureProject();
  const withNulls: PrintSurfaceProject = {
    ...project,
    items: project.items.map((item) => ({ ...item, presetId: null as unknown as undefined, customWidthMm: null as unknown as undefined, customHeightMm: null as unknown as undefined })),
  };
  const withUndefined: PrintSurfaceProject = {
    ...project,
    items: project.items.map((item) => ({ ...item, presetId: undefined, customWidthMm: undefined, customHeightMm: undefined })),
  };
  assert.ok(printSurfaceProjectFingerprintsEqual(buildPrintSurfaceProjectFingerprint(withNulls), buildPrintSurfaceProjectFingerprint(withUndefined)));
});

test("CANONICALIZATION: eventId/realizationCompanyId null is treated the same as undefined", () => {
  const project = buildFixtureProject();
  const withNulls: PrintSurfaceProject = { ...project, eventId: null as unknown as undefined, realizationCompanyId: null as unknown as undefined };
  const withUndefined: PrintSurfaceProject = { ...project, eventId: undefined, realizationCompanyId: undefined };
  assert.ok(printSurfaceProjectFingerprintsEqual(buildPrintSurfaceProjectFingerprint(withNulls), buildPrintSurfaceProjectFingerprint(withUndefined)));
});

test("CANONICALIZATION: a view with NO 'order' key at all (pre-V3 shape, predates the field's introduction) still produces a stable fingerprint — never throws, never treated as different from an explicit order matching its array position", () => {
  const project = buildFixtureProject();
  const viewWithoutOrder = { ...project.views[0] } as { order?: number } & Omit<PrintSurfaceView, "order">;
  delete viewWithoutOrder.order;
  const legacyShapedProject: PrintSurfaceProject = { ...project, views: [viewWithoutOrder as PrintSurfaceView] };
  const explicitOrderZero: PrintSurfaceProject = { ...project, views: [{ ...project.views[0]!, order: 0 }] };
  assert.ok(printSurfaceProjectFingerprintsEqual(buildPrintSurfaceProjectFingerprint(legacyShapedProject), buildPrintSurfaceProjectFingerprint(explicitOrderZero)));
});

test("LEGACY PROJECT FIXTURE: a pre-V4 document (single embedded `image`, items carrying imageId/xNormalized/yNormalized directly, no separate placements[], no view `order`) migrates, fingerprints, survives a full save/reload round trip, and stays current", async () => {
  const legacyDocument = {
    image: { asset: { id: "asset-legacy", storageKey: "print-surfaces/legacy-project/image/a.jpg", originalFileName: "a.jpg", mimeType: "image/jpeg", size: 100, createdAt: "2025-06-01T00:00:00.000Z", category: "print-surface-image" as const }, widthPx: 1200, heightPx: 900 },
    items: [
      { id: "legacy-item-1", label: "A", typeId: "panel" as const, xNormalized: 0.25, yNormalized: 0.35, imageId: "legacy-view-1", note: undefined },
      { id: "legacy-item-2", label: "B", typeId: "fascia" as const, xNormalized: 0.6, yNormalized: 0.8, imageId: "legacy-view-1", customWidthMm: 3000, customHeightMm: 300 },
    ],
  };
  const migrated = migrateLegacyPrintSurfaceDocument(legacyDocument);
  const legacyProject: PrintSurfaceProject = {
    id: "legacy-project", name: "Starý projekt 2025", companyName: "Legacy s.r.o.", status: "draft",
    views: migrated.views, items: migrated.items, placements: migrated.placements,
    createdAt: "2025-06-01T00:00:00.000Z", updatedAt: "2025-06-01T00:00:00.000Z",
  };

  const fingerprintBeforeSave = buildPrintSurfaceProjectFingerprint(legacyProject);
  const withPdf = withLatestPdf(legacyProject, {
    storageKey: "print-surfaces/legacy-project/export/uuid-1.pdf", fileName: "Tiskove_plochy_Starý_projekt_2025.pdf",
    generatedAt: "2025-06-01T00:05:00.000Z", projectFingerprint: fingerprintBeforeSave,
  });
  assert.equal(isPrintSurfacePdfCurrent(withPdf, withPdf.latestPdf), true);

  const client = createFakeSupabaseClient();
  const repository = new SupabasePrintSurfaceProjectRepository(client as never);
  await client.from("print_surface_projects").insert({
    id: legacyProject.id, name: legacyProject.name, company_name: legacyProject.companyName, event_id: null, realization_company_id: null,
    status: "draft", created_by: null, sent_at: null, sent_by: null,
    document: { image: legacyDocument.image, items: legacyDocument.items, latestPdf: withPdf.latestPdf },
    created_at: legacyProject.createdAt, updated_at: legacyProject.updatedAt,
  });

  const reloaded = await repository.get(legacyProject.id);
  assert.ok(reloaded);
  assert.equal(isPrintSurfacePdfCurrent(reloaded!, reloaded!.latestPdf), true, "a legacy (pre-V4) project must still read as PDF-current after a real DB round trip, with no false-stale from the migration/normalization step");

  // no-op autosave on top of the reloaded/migrated shape — still current.
  await repository.save(reloaded!);
  const reloadedAgain = await repository.get(legacyProject.id);
  assert.equal(isPrintSurfacePdfCurrent(reloadedAgain!, reloadedAgain!.latestPdf), true);
});

// =============================================================================================
// Immediate post-generation self-check + one-time dev diagnostic (spec sections 2/7) — source
// contract, since this repo has no DOM/component test runner (see tests/printSurfaceEmailFlow.
// test.ts's own doc note).
// =============================================================================================
test("immediate self-check: handlePdfGenerated recomputes the fingerprint against the FRESH state and warns (dev only) on any mismatch, right where a real race would be caught", () => {
  const editorSource = readFileSync(new URL("../components/workflow/printSurfaces/PrintSurfaceEditorPage.tsx", import.meta.url), "utf8");
  const match = editorSource.match(/function handlePdfGenerated\([\s\S]*?\n  \}\n/u);
  assert.ok(match, "expected to find function handlePdfGenerated");
  const handlePdfGenerated = match![0];
  assert.match(handlePdfGenerated, /process\.env\.NODE_ENV !== "production"/u);
  assert.match(handlePdfGenerated, /buildPrintSurfaceProjectFingerprint\(next\)/u);
  assert.match(handlePdfGenerated, /printSurfaceProjectFingerprintsEqual\(latestPdf\.projectFingerprint, recomputed\)/u);
  assert.match(handlePdfGenerated, /console\.warn\(/u);
});

test("one-time stale diagnostic: PrintSurfaceExportPanel logs a structured diff (changedFields/stored/current) the first time a given PDF artifact is observed stale, gated to non-production, keyed so it never re-logs on every render", () => {
  const exportPanelSource = readFileSync(new URL("../components/workflow/printSurfaces/PrintSurfaceExportPanel.tsx", import.meta.url), "utf8");
  assert.match(exportPanelSource, /process\.env\.NODE_ENV === "production"\) return;/u);
  assert.match(exportPanelSource, /loggedStaleArtifactKeyRef/u);
  assert.match(exportPanelSource, /diffPrintSurfaceProjectFingerprints\(project\.latestPdf\.projectFingerprint, current\)/u);
  assert.match(exportPanelSource, /console\.warn\("\[print-surfaces\] PDF marked as not current"/u);
});

// -----------------------------------------------------------------------------------------------
// Minimal in-memory fake Supabase client — same idiom as tests/printSurfaceDb.test.ts.
// -----------------------------------------------------------------------------------------------
type FakeRow = Record<string, unknown>;

function createFakeSupabaseClient() {
  const tables = new Map<string, FakeRow[]>();
  function getTable(name: string): FakeRow[] {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  }
  function from(tableName: string) {
    let op: "select" | "insert" | "update" | "delete" = "select";
    let filters: Readonly<{ column: string; value: unknown }>[] = [];
    let payload: FakeRow | FakeRow[] | undefined;
    let singleMode: "none" | "maybeSingle" | "single" = "none";
    function rowMatches(row: FakeRow): boolean {
      return filters.every((filter) => row[filter.column] === filter.value);
    }
    const builder = {
      select() { return builder; },
      insert(row: FakeRow) { op = "insert"; payload = row; return builder; },
      update(patch: FakeRow) { op = "update"; payload = patch; return builder; },
      eq(column: string, value: unknown) { filters = [...filters, { column, value }]; return builder; },
      maybeSingle() { singleMode = "maybeSingle"; return execute(); },
      single() { singleMode = "single"; return execute(); },
      then(onFulfilled: (value: { data: unknown; error: unknown }) => unknown, onRejected?: (reason: unknown) => unknown) {
        return execute().then(onFulfilled, onRejected);
      },
    };
    async function execute(): Promise<{ data: unknown; error: unknown }> {
      const rows = getTable(tableName);
      if (op === "select") {
        const matched = rows.filter(rowMatches);
        if (singleMode === "maybeSingle") return { data: matched[0] ?? null, error: null };
        if (singleMode === "single") return matched[0] ? { data: matched[0], error: null } : { data: null, error: { message: "not found" } };
        return { data: matched, error: null };
      }
      if (op === "insert") {
        // Simulates the JSON transport a real request body / Postgres jsonb column undergoes —
        // proves the fingerprint survives an ACTUAL serialize/deserialize round trip, not just an
        // in-memory reference copy.
        const clone = JSON.parse(JSON.stringify(payload)) as FakeRow;
        if (clone.id === undefined) clone.id = crypto.randomUUID();
        if (clone.created_at === undefined) clone.created_at = new Date().toISOString();
        if (clone.updated_at === undefined) clone.updated_at = new Date().toISOString();
        rows.push(clone);
        return { data: clone, error: null };
      }
      if (op === "update") {
        const matched = rows.filter(rowMatches);
        for (const row of matched) {
          const merged = JSON.parse(JSON.stringify({ ...row, ...payload })) as FakeRow;
          merged.updated_at = new Date().toISOString();
          Object.assign(row, merged);
        }
        return matched[0] ? { data: matched[0], error: null } : { data: null, error: { message: "not found" } };
      }
      return { data: null, error: { message: "unsupported" } };
    }
    return builder;
  }
  return { from };
}
