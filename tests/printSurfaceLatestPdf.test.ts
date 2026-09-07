import test from "node:test";
import assert from "node:assert/strict";
import {
  addPrintSurfaceItemWithPlacement,
  addPrintSurfaceView,
  buildPrintSurfaceProjectFingerprint,
  createPrintSurfaceProject,
  isPrintSurfacePdfCurrent,
  printSurfaceProjectFingerprintsEqual,
  summarizePrintSurfaceProject,
  updatePrintSurfaceItem,
  withItems,
  withLatestPdf,
  withProjectFields,
  type PrintSurfaceLatestPdf,
  type PrintSurfaceProjectImage,
} from "../domain/printSurfaceProject.ts";

// =========================================================================================
// Real-usage follow-up: ONE current PDF artifact per project, freshness by content fingerprint —
// deliberately NOT by comparing updatedAt (see withLatestPdf's own doc: the DB's blind
// set_updated_at trigger would make a just-saved PDF register as stale the instant it's
// persisted). See domain/visualizationRender.ts for the established precedent this mirrors.
// =========================================================================================

function makeImage(seed: string): PrintSurfaceProjectImage {
  return {
    asset: { id: `asset-${seed}`, storageKey: `print-surfaces/p1/image/${seed}.jpg`, originalFileName: `${seed}.jpg`, mimeType: "image/jpeg", size: 100, createdAt: "2026-01-01T00:00:00.000Z", category: "print-surface-image" },
    widthPx: 800,
    heightPx: 600,
  };
}

function buildFixtureProject() {
  let project = createPrintSurfaceProject({ name: "Test 001", companyName: "ACME" }, "project-1");
  project = addPrintSurfaceView(project, makeImage("front"), "view-front");
  project = addPrintSurfaceItemWithPlacement(project, { typeId: "panel" }, "view-front", 0.3, 0.4, { itemId: "item-a" }).project;
  return project;
}

function fakeLatestPdfFor(project: ReturnType<typeof buildFixtureProject>): PrintSurfaceLatestPdf {
  return {
    storageKey: "print-surfaces/p1/export/uuid-1.pdf",
    fileName: "Tiskove_plochy_Test_001.pdf",
    generatedAt: "2026-01-01T00:00:00.000Z",
    projectFingerprint: buildPrintSurfaceProjectFingerprint(project),
  };
}

test("no latestPdf at all -> never current (first export must still happen)", () => {
  const project = buildFixtureProject();
  assert.equal(isPrintSurfacePdfCurrent(project, project.latestPdf), false);
  assert.equal(project.latestPdf, undefined);
});

test("first export creates the current PDF: withLatestPdf attaches it, and it immediately reads as current", () => {
  const project = buildFixtureProject();
  const latestPdf = fakeLatestPdfFor(project);
  const withPdf = withLatestPdf(project, latestPdf);
  assert.equal(withPdf.latestPdf, latestPdf);
  assert.equal(isPrintSurfacePdfCurrent(withPdf, withPdf.latestPdf), true);
});

test("withLatestPdf does NOT bump updatedAt — attaching the artifact reference is never treated as a content edit", () => {
  const project = buildFixtureProject();
  const withPdf = withLatestPdf(project, fakeLatestPdfFor(project));
  assert.equal(withPdf.updatedAt, project.updatedAt);
});

test("project change marks the PDF stale: editing an item's label changes the fingerprint, isPrintSurfacePdfCurrent flips to false", () => {
  const project = buildFixtureProject();
  const withPdf = withLatestPdf(project, fakeLatestPdfFor(project));
  const edited = withItems(withPdf, updatePrintSurfaceItem(withPdf.items, "item-a", { label: "Z" }));
  assert.equal(isPrintSurfacePdfCurrent(edited, edited.latestPdf), false);
  // the stale latestPdf reference itself is NOT cleared — the UI decides what to show/offer based on isPrintSurfacePdfCurrent, never a mutation that deletes the old reference.
  assert.equal(edited.latestPdf, withPdf.latestPdf);
});

test("project change via name/company/event fields also marks the PDF stale (fingerprint covers more than just items)", () => {
  const project = buildFixtureProject();
  const withPdf = withLatestPdf(project, fakeLatestPdfFor(project));
  const renamed = withProjectFields(withPdf, { name: "Test 002" });
  assert.equal(isPrintSurfacePdfCurrent(renamed, renamed.latestPdf), false);
});

test("subsequent regeneration REPLACES the current PDF reference (a new storageKey/fileName/generatedAt), never accumulates a second one", () => {
  const project = buildFixtureProject();
  const first = withLatestPdf(project, fakeLatestPdfFor(project));
  const editedProject = withItems(first, updatePrintSurfaceItem(first.items, "item-a", { label: "Z" }));
  const secondLatestPdf: PrintSurfaceLatestPdf = {
    storageKey: "print-surfaces/p1/export/uuid-2.pdf",
    fileName: "Tiskove_plochy_Test_001.pdf",
    generatedAt: "2026-01-02T00:00:00.000Z",
    projectFingerprint: buildPrintSurfaceProjectFingerprint(editedProject),
  };
  const regenerated = withLatestPdf(editedProject, secondLatestPdf);
  assert.equal(regenerated.latestPdf?.storageKey, "print-surfaces/p1/export/uuid-2.pdf");
  assert.notEqual(regenerated.latestPdf?.storageKey, first.latestPdf?.storageKey);
});

test("regeneration marks the PDF current again: after regenerating against the CURRENT content, isPrintSurfacePdfCurrent is true", () => {
  const project = buildFixtureProject();
  const first = withLatestPdf(project, fakeLatestPdfFor(project));
  const editedProject = withItems(first, updatePrintSurfaceItem(first.items, "item-a", { label: "Z" }));
  assert.equal(isPrintSurfacePdfCurrent(editedProject, editedProject.latestPdf), false);
  const regenerated = withLatestPdf(editedProject, {
    storageKey: "print-surfaces/p1/export/uuid-2.pdf",
    fileName: "Tiskove_plochy_Test_001.pdf",
    generatedAt: "2026-01-02T00:00:00.000Z",
    projectFingerprint: buildPrintSurfaceProjectFingerprint(editedProject),
  });
  assert.equal(isPrintSurfacePdfCurrent(regenerated, regenerated.latestPdf), true);
});

test("fingerprint is order-independent: rebuilding items/placements in a different array order still compares equal", () => {
  let project = createPrintSurfaceProject({ name: "X", companyName: "ACME" }, "p2");
  project = addPrintSurfaceView(project, makeImage("front"), "view-front");
  project = addPrintSurfaceItemWithPlacement(project, { typeId: "panel" }, "view-front", 0.1, 0.1, { itemId: "item-a" }).project;
  project = addPrintSurfaceItemWithPlacement(project, { typeId: "panel" }, "view-front", 0.2, 0.2, { itemId: "item-b" }).project;

  const fingerprintA = buildPrintSurfaceProjectFingerprint(project);
  const reordered = { ...project, items: [...project.items].reverse(), placements: [...project.placements].reverse() };
  const fingerprintB = buildPrintSurfaceProjectFingerprint(reordered);
  assert.ok(printSurfaceProjectFingerprintsEqual(fingerprintA, fingerprintB));
});

test("PrintSurfaceProjectSummary carries ONLY the PDF artifact identity (storageKey/fileName), never a freshness/current-vs-stale signal — the list is not an authoritative source of truth for that (real-usage follow-up)", () => {
  const project = buildFixtureProject();
  const withPdf = withLatestPdf(project, fakeLatestPdfFor(project));
  const summary = summarizePrintSurfaceProject(withPdf);
  assert.equal(summary.latestPdf?.storageKey, withPdf.latestPdf?.storageKey);
  assert.equal(summary.latestPdf?.fileName, withPdf.latestPdf?.fileName);
  assert.equal("isCurrent" in (summary.latestPdf ?? {}), false);

  // even after a real content edit (which WOULD flip isPrintSurfacePdfCurrent inside an open
  // editor), the summary's latestPdf shape is unchanged — it never recomputes or exposes freshness.
  const edited = withItems(withPdf, updatePrintSurfaceItem(withPdf.items, "item-a", { label: "Z" }));
  const editedSummary = summarizePrintSurfaceProject(edited);
  assert.equal("isCurrent" in (editedSummary.latestPdf ?? {}), false);
  assert.equal(editedSummary.latestPdf?.storageKey, withPdf.latestPdf?.storageKey);
});

test("summarizePrintSurfaceProject with no PDF ever generated -> latestPdf is undefined, not a false-current placeholder", () => {
  const project = buildFixtureProject();
  const summary = summarizePrintSurfaceProject(project);
  assert.equal(summary.latestPdf, undefined);
});
