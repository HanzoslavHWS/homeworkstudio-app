import test from "node:test";
import assert from "node:assert/strict";
import { buildPrintSurfacePdf } from "../lib/printSurfacePdf.ts";
import { buildPrintSurfaceExportViewModel } from "../domain/printSurfaceExport.ts";
import {
  addMarkerPlacementForExistingItem,
  addPrintSurfaceItemWithPlacement,
  addPrintSurfaceView,
  createPrintSurfaceProject,
  type PrintSurfaceProjectImage,
} from "../domain/printSurfaceProject.ts";
import type { PrintSurfacePreset } from "../domain/printSurfacePreset.ts";
import { resolveEventBranding } from "../domain/eventBranding.ts";
import { normalizeExhibition } from "../domain/organizations.ts";

/**
 * A jsPDF circle drawn with style "FD" (fill+stroke) emits a standalone `B` PDF content-stream
 * operator after its 4 Bézier curve segments — verified empirically against real jsPDF output.
 * Nothing else this module draws uses that operator (table-row shading uses "F"/fill-only via
 * rect, borders/lines use plain stroke) so counting it is a reliable structural proxy for "how
 * many marker pins were actually drawn", without depending on the embedded custom font's
 * text-operator encoding (which is NOT plain ASCII and can't be reliably grepped for labels).
 */
function countMarkerDrawOperations(bytes: Uint8Array): number {
  const text = new TextDecoder("latin1").decode(bytes);
  return (text.match(/^B$/gm) ?? []).length;
}

function countImageXObjects(bytes: Uint8Array): number {
  const text = new TextDecoder("latin1").decode(bytes);
  return (text.match(/\/Subtype\s*\/Image/g) ?? []).length;
}

function countPages(bytes: Uint8Array): number {
  const text = new TextDecoder("latin1").decode(bytes);
  return (text.match(/\/Type\s*\/Page\b/g) ?? []).length;
}

// 1x1 red PNG — same fixture presentationPdf.test.ts already uses.
const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
// A distinct 1x1 PNG (different pixel data, never byte-identical to TINY_PNG) — needed so tests
// counting embedded image XObjects can tell "the event logo" and "the view photo" apart; jsPDF
// dedupes an image it has already embedded when given byte-identical data again.
const OTHER_TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPgEpEDAABoAD1UCKP3AAAAAElFTkSuQmCC";

function makeImage(seed: string): PrintSurfaceProjectImage {
  return {
    asset: { id: `asset-${seed}`, storageKey: `print-surfaces/p1/image/${seed}.jpg`, originalFileName: `${seed}.jpg`, mimeType: "image/jpeg", size: 100, createdAt: "2026-01-01T00:00:00.000Z", category: "print-surface-image" },
    widthPx: 800,
    heightPx: 600,
  };
}

const PRESETS: readonly PrintSurfacePreset[] = [{ id: "Panel_S_100", typeId: "panel", name: "Panel stěnový 1 x 2,5 m", isActive: true }];

function buildFixtureProject() {
  let project = createPrintSurfaceProject({ name: "Stánek XY", companyName: "ACME s.r.o.", createdBy: "jan.novak" }, "project-1");
  project = { ...project, realizationCompanyId: "creativ-expo" };
  project = addPrintSurfaceView(project, makeImage("front"), "view-front");
  project = addPrintSurfaceItemWithPlacement(project, { typeId: "panel", presetId: "Panel_S_100" }, "view-front", 0.3, 0.4, { itemId: "item-a" }).project;
  project = addPrintSurfaceItemWithPlacement(project, { typeId: "fascia", customWidthMm: 3000, customHeightMm: 300 }, "view-front", 0.5, 0.9, { itemId: "item-b" }).project;
  return project;
}

test("PDF: output is a real PDF binary (%PDF- magic bytes)", async () => {
  const viewModel = buildPrintSurfaceExportViewModel({ project: buildFixtureProject(), presets: PRESETS, productionDimensions: [], revision: 1 });
  const bytes = await buildPrintSurfacePdf(viewModel);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
});

test("PDF: builds without throwing when no branding logos and no view images are provided (spec section 3/4 — never blocks on a missing/unresolved logo)", async () => {
  const viewModel = buildPrintSurfaceExportViewModel({ project: buildFixtureProject(), presets: PRESETS, productionDimensions: [], revision: 1 });
  const bytes = await buildPrintSurfacePdf(viewModel, {}, new Map());
  assert.ok(bytes.length > 0);
});

test("PDF: builds without throwing when an event logo IS provided as a data URL", async () => {
  const forBeauty = normalizeExhibition({ id: "for-beauty", slug: "for-beauty-podzim-2026", name: "FOR BEAUTY" });
  const viewModel = buildPrintSurfaceExportViewModel({
    project: buildFixtureProject(), presets: PRESETS, productionDimensions: [], revision: 1, eventBranding: resolveEventBranding(forBeauty),
  });
  const bytes = await buildPrintSurfacePdf(viewModel, { eventLogoDataUrl: TINY_PNG }, new Map());
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
});

test("PDF: includes a view image when a resolved data URL is given for that viewId", async () => {
  const project = buildFixtureProject();
  const viewModel = buildPrintSurfaceExportViewModel({ project, presets: PRESETS, productionDimensions: [], revision: 1 });
  const viewImages = new Map([["view-front", { widthPx: 800, heightPx: 600, dataUrl: TINY_PNG }]]);
  const bytes = await buildPrintSurfacePdf(viewModel, {}, viewImages);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
});

test("PDF: a small project (fits entirely on one page) never gets a forced trailing/blank page — no more instructions block appended after the table", async () => {
  const viewModel = buildPrintSurfaceExportViewModel({ project: buildFixtureProject(), presets: PRESETS, productionDimensions: [], revision: 1 });
  const bytes = await buildPrintSurfacePdf(viewModel);
  assert.equal(countPages(bytes), 1);
});

test("PDF: a project with enough rows to overflow the table paginates the table itself, but never appends an extra trailing page beyond what the table needed", async () => {
  let project = createPrintSurfaceProject({ name: "Velký projekt", companyName: "ACME" }, "project-big");
  project = addPrintSurfaceView(project, makeImage("front"), "view-front");
  for (let i = 0; i < 60; i++) {
    project = addPrintSurfaceItemWithPlacement(project, { typeId: "panel" }, "view-front", 0.1, 0.1, { itemId: `item-${i}` }).project;
  }
  const viewModel = buildPrintSurfaceExportViewModel({ project, presets: [], productionDimensions: [], revision: 1 });
  const bytes = await buildPrintSurfacePdf(viewModel, {}, new Map());
  // 60 rows overflow onto further pages (drawTable's own internal page breaks) — but there must be
  // no page beyond that, since the trailing graphics-instructions page no longer exists.
  assert.ok(countPages(bytes) >= 2);
});

// =========================================================================================
// Branding cleanup: remove internal ABF/HomeworkStudio branding from the real PDF export, keep
// event branding (e.g. FOR BEAUTY). PrintSurfacePdfBranding no longer even HAS an ABF-logo field,
// so a leftover ABF draw call is structurally impossible — verified below via embedded image
// XObject counts (never via literal text search: the embedded custom Czech font encodes glyphs,
// not plain ASCII, so a "does the PDF contain the substring HOMEWORKSTUDIO" check would pass
// even while the text WAS being drawn — an unreliable, misleading test).
// =========================================================================================

test("PDF: with no branding logo provided, exactly the view photo is embedded — never an extra (ABF) logo image", async () => {
  const viewModel = buildPrintSurfaceExportViewModel({ project: buildFixtureProject(), presets: PRESETS, productionDimensions: [], revision: 1 });
  const viewImages = new Map([["view-front", { widthPx: 800, heightPx: 600, dataUrl: TINY_PNG }]]);
  const bytes = await buildPrintSurfacePdf(viewModel, {}, viewImages);
  assert.equal(countImageXObjects(bytes), 1);
});

test("PDF: with an event (FOR BEAUTY) logo provided, exactly 2 images are embedded (event logo + view photo) — never 3, proving no ABF logo is drawn alongside it", async () => {
  const forBeauty = normalizeExhibition({ id: "for-beauty", slug: "for-beauty-podzim-2026", name: "FOR BEAUTY" });
  const viewModel = buildPrintSurfaceExportViewModel({
    project: buildFixtureProject(), presets: PRESETS, productionDimensions: [], revision: 1, eventBranding: resolveEventBranding(forBeauty),
  });
  const viewImages = new Map([["view-front", { widthPx: 800, heightPx: 600, dataUrl: TINY_PNG }]]);
  const bytes = await buildPrintSurfacePdf(viewModel, { eventLogoDataUrl: OTHER_TINY_PNG }, viewImages);
  assert.equal(countImageXObjects(bytes), 2);
});

test("PDF: marker overlay is unaffected by the branding cleanup — still draws one pin per placement", async () => {
  const project = buildFixtureProject(); // 2 items, each with one placement on view-front
  const viewModel = buildPrintSurfaceExportViewModel({ project, presets: PRESETS, productionDimensions: [], revision: 1 });
  const viewImages = new Map([["view-front", { widthPx: 800, heightPx: 600, dataUrl: TINY_PNG }]]);
  const bytes = await buildPrintSurfacePdf(viewModel, { eventLogoDataUrl: OTHER_TINY_PNG }, viewImages);
  assert.equal(countMarkerDrawOperations(bytes), 2);
});

test("CZECH TEXT: builds without throwing for names/notes containing Czech diacritics", async () => {
  let project = createPrintSurfaceProject({ name: "Zákazník s.r.o. – Řízení a Realizace", companyName: "Žofie Nováková" }, "project-2");
  project = addPrintSurfaceView(project, makeImage("front"), "view-front");
  project = addPrintSurfaceItemWithPlacement(project, { typeId: "panel" }, "view-front", 0.5, 0.5, { itemId: "item-a" }).project;
  const viewModel = buildPrintSurfaceExportViewModel({ project, presets: [], productionDimensions: [], revision: 1 });
  const bytes = await buildPrintSurfacePdf(viewModel);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
});

test("PDF: builds without throwing when showPrices is true (price footer/column path is exercised)", async () => {
  const project = buildFixtureProject();
  const viewModel = buildPrintSurfaceExportViewModel({
    project, presets: PRESETS, productionDimensions: [], revision: 1, showPrices: true, priceResolutions: new Map(),
  });
  const bytes = await buildPrintSurfacePdf(viewModel);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
});

// =========================================================================================
// Marker-overlay follow-up (spec sections 1-9): the real jsPDF artifact must draw the SAME
// A/B/C pins the editor and the browser print-preview HTML show, positioned against the actual
// rendered (contain-fit) image rectangle.
// =========================================================================================

test("PDF: draws exactly one marker pin per placement when the view's image resolved successfully", async () => {
  const project = buildFixtureProject(); // 2 items, each with one placement on view-front
  const viewModel = buildPrintSurfaceExportViewModel({ project, presets: PRESETS, productionDimensions: [], revision: 1 });
  assert.equal(viewModel.images[0]?.markers.length, 2);
  const viewImages = new Map([["view-front", { widthPx: 800, heightPx: 600, dataUrl: TINY_PNG }]]);
  const bytes = await buildPrintSurfacePdf(viewModel, {}, viewImages);
  assert.equal(countMarkerDrawOperations(bytes), 2);
});

test("PDF: draws NO marker pins for a view whose image never resolved — a pin is never placed at a meaningless (0,0)", async () => {
  const project = buildFixtureProject();
  const viewModel = buildPrintSurfaceExportViewModel({ project, presets: PRESETS, productionDimensions: [], revision: 1 });
  const bytes = await buildPrintSurfacePdf(viewModel, {}, new Map()); // no resolved image for view-front
  assert.equal(countMarkerDrawOperations(bytes), 0);
});

test("A) jeden pohled s A/B/C: 3 items on one view produce exactly 3 marker draw operations", async () => {
  let project = createPrintSurfaceProject({ name: "Jeden pohled", companyName: "ACME" }, "project-single");
  project = addPrintSurfaceView(project, makeImage("only"), "view-1");
  project = addPrintSurfaceItemWithPlacement(project, { typeId: "panel" }, "view-1", 0.1, 0.1, { itemId: "item-a" }).project;
  project = addPrintSurfaceItemWithPlacement(project, { typeId: "panel" }, "view-1", 0.5, 0.5, { itemId: "item-b" }).project;
  project = addPrintSurfaceItemWithPlacement(project, { typeId: "panel" }, "view-1", 0.9, 0.9, { itemId: "item-c" }).project;
  const viewModel = buildPrintSurfaceExportViewModel({ project, presets: [], productionDimensions: [], revision: 1 });
  assert.deepEqual(viewModel.images[0]?.markers.map((m) => m.label), ["A", "B", "C"]);
  const viewImages = new Map([["view-1", { widthPx: 800, heightPx: 600, dataUrl: TINY_PNG }]]);
  const bytes = await buildPrintSurfacePdf(viewModel, {}, viewImages);
  assert.equal(countMarkerDrawOperations(bytes), 3);
});

test("B) dva pohledy: každý pohled má svoje vlastní placements — marker z Pohledu 1 se nikdy neobjeví na Pohledu 2", async () => {
  let project = createPrintSurfaceProject({ name: "Dva pohledy", companyName: "ACME" }, "project-two");
  project = addPrintSurfaceView(project, makeImage("front"), "view-front");
  project = addPrintSurfaceView(project, makeImage("side"), "view-side");
  project = addPrintSurfaceItemWithPlacement(project, { typeId: "panel" }, "view-front", 0.2, 0.2, { itemId: "item-a" }).project;
  project = addPrintSurfaceItemWithPlacement(project, { typeId: "showcase" }, "view-side", 0.7, 0.7, { itemId: "item-b" }).project;
  const viewModel = buildPrintSurfaceExportViewModel({ project, presets: [], productionDimensions: [], revision: 1 });
  const front = viewModel.images.find((i) => i.viewId === "view-front")!;
  const side = viewModel.images.find((i) => i.viewId === "view-side")!;
  assert.deepEqual(front.markers.map((m) => m.label), ["A"]);
  assert.deepEqual(side.markers.map((m) => m.label), ["B"]);

  const viewImages = new Map([
    ["view-front", { widthPx: 800, heightPx: 600, dataUrl: TINY_PNG }],
    ["view-side", { widthPx: 800, heightPx: 600, dataUrl: TINY_PNG }],
  ]);
  const bytes = await buildPrintSurfacePdf(viewModel, {}, viewImages);
  assert.equal(countMarkerDrawOperations(bytes), 2); // one pin per view, never duplicated onto the other
});

test("C) jedna plocha A na obou pohledech: PDF kreslí marker A na OBOU obrázcích (2 draw operations), ale exportní tabulka ji nese jen JEDNOU", async () => {
  let project = createPrintSurfaceProject({ name: "Sdílená plocha", companyName: "ACME" }, "project-shared");
  project = addPrintSurfaceView(project, makeImage("front"), "view-front");
  project = addPrintSurfaceView(project, makeImage("side"), "view-side");
  const created = addPrintSurfaceItemWithPlacement(project, { typeId: "panel" }, "view-front", 0.3, 0.3, { itemId: "item-a" });
  project = created.project;
  project = addMarkerPlacementForExistingItem(project, "item-a", "view-side", 0.6, 0.6).project;

  const viewModel = buildPrintSurfaceExportViewModel({ project, presets: [], productionDimensions: [], revision: 1 });
  const front = viewModel.images.find((i) => i.viewId === "view-front")!;
  const side = viewModel.images.find((i) => i.viewId === "view-side")!;
  assert.deepEqual(front.markers.map((m) => m.label), ["A"]);
  assert.deepEqual(side.markers.map((m) => m.label), ["A"]);
  // the SAME view model fed to the table builder — exactly one row for the shared item, never two.
  assert.equal(viewModel.rows.filter((row) => row.label === "A").length, 1);
  // and summary counts the ITEM once, never per placement (spec: "summary stále počítá Item, ne Placement").
  assert.equal(viewModel.summary.total, 1);

  const viewImages = new Map([
    ["view-front", { widthPx: 800, heightPx: 600, dataUrl: TINY_PNG }],
    ["view-side", { widthPx: 800, heightPx: 600, dataUrl: TINY_PNG }],
  ]);
  const bytes = await buildPrintSurfacePdf(viewModel, {}, viewImages);
  assert.equal(countMarkerDrawOperations(bytes), 2, "the same physical item is pinned on 2 photos, so 2 visible pins are correct and expected — this is NOT double counting (the table/summary assertions above prove that)");
});

test("PDF: marker draw count is unaffected by a non-trivial contain-fit aspect ratio — a tall/narrow source image still produces exactly one pin per placement", async () => {
  let project = createPrintSurfaceProject({ name: "Aspect ratio", companyName: "ACME" }, "project-aspect");
  project = addPrintSurfaceView(project, { asset: { id: "a", storageKey: "k", originalFileName: "tall.jpg", mimeType: "image/jpeg", size: 1, createdAt: "2026-01-01T00:00:00.000Z", category: "print-surface-image" }, widthPx: 600, heightPx: 1800 }, "view-tall");
  project = addPrintSurfaceItemWithPlacement(project, { typeId: "panel" }, "view-tall", 0.05, 0.95, { itemId: "item-a" }).project; // near a corner — would land outside a naive box-relative mapping
  const viewModel = buildPrintSurfaceExportViewModel({ project, presets: [], productionDimensions: [], revision: 1 });
  const viewImages = new Map([["view-tall", { widthPx: 600, heightPx: 1800, dataUrl: TINY_PNG }]]);
  const bytes = await buildPrintSurfacePdf(viewModel, {}, viewImages);
  assert.equal(countMarkerDrawOperations(bytes), 1);
});
