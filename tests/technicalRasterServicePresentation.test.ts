import assert from "node:assert/strict";
import test from "node:test";
import {
  TECHNICAL_RASTER_COLORS,
  categoryCanHaveExportableSymbol,
  extractElectricityKwLabel,
  resolveTechnicalServicePresentation,
} from "../domain/technicalRasterServicePresentation.ts";

// =========================================================================================
// Technické rastry — Phase 2 technical presentation config (spec batch 7). Every real label
// asserted here comes straight from the actual parsed Hala 1.pdf / Decor 26 report set (verified
// against a real run of the parsers, never invented) — see the module's own doc for the full list.
// =========================================================================================

test("electricity: Do 3kW -> 3 kW, red, point, power legend", () => {
  const p = resolveTechnicalServicePresentation("electricity", "Do 3kW 230V");
  assert.equal(p.placementBehavior, "point");
  assert.equal(p.renderer, "powerLabel");
  assert.equal(p.displayLabel, "3 kW");
  assert.equal(p.color, TECHNICAL_RASTER_COLORS.electricity);
  assert.equal(p.isFallback, false);
});

test("electricity: Do 6kW -> 6 kW", () => {
  assert.equal(resolveTechnicalServicePresentation("electricity", "Do 6kW 230V").displayLabel, "6 kW");
});

test("electricity: Do 9kW 400V -> 9 kW (voltage suffix ignored, kW is the only thing extracted)", () => {
  assert.equal(resolveTechnicalServicePresentation("electricity", "Do 9kW 400V").displayLabel, "9 kW");
});

test("electricity: Lednicový okruh -> refrigeratedStar, point, red, refrigerated legend", () => {
  const p = resolveTechnicalServicePresentation("electricity", "Lednicový okruh");
  assert.equal(p.placementBehavior, "point");
  assert.equal(p.renderer, "refrigeratedStar");
  assert.equal(p.color, TECHNICAL_RASTER_COLORS.electricity);
  assert.equal(p.legendLabel, "LEDNICOVÝ OKRUH");
});

test("electricity: 'Non stop' (spec section 16's documented alias, not in the real fixture set but must still resolve) -> same refrigeratedStar presentation", () => {
  const p = resolveTechnicalServicePresentation("electricity", "Non stop");
  assert.equal(p.renderer, "refrigeratedStar");
  assert.equal(p.legendLabel, "LEDNICOVÝ OKRUH");
});

test("electricity: a label with no extractable kW and no refrigerated match -> honest 'EL' fallback label, never a guessed number", () => {
  const p = resolveTechnicalServicePresentation("electricity", "Rozvaděč");
  assert.equal(p.placementBehavior, "point");
  assert.equal(p.renderer, "powerLabel");
  assert.equal(p.displayLabel, "EL");
  assert.equal(p.isFallback, false, "still a real, recognized electricity row — just without a safely-extractable number, not an unresolved fallback");
});

test("extractElectricityKwLabel: handles a comma decimal separator too", () => {
  assert.equal(extractElectricityKwLabel("Do 2,5kW"), "2.5 kW");
});

test("extractElectricityKwLabel: returns undefined when there is genuinely no kW figure", () => {
  assert.equal(extractElectricityKwLabel("Osvětlení"), undefined);
});

test("internet: Pevná IP -> IP, point, gold, fixed-IP legend", () => {
  const p = resolveTechnicalServicePresentation("internet", "Pevná IP");
  assert.equal(p.placementBehavior, "point");
  assert.equal(p.renderer, "textLabel");
  assert.equal(p.displayLabel, "IP");
  assert.equal(p.color, TECHNICAL_RASTER_COLORS.internet);
});

test("internet: plain 'Internet' -> INT, point (a real cabled drop, same as Pevná IP conceptually)", () => {
  const p = resolveTechnicalServicePresentation("internet", "Internet");
  assert.equal(p.placementBehavior, "point");
  assert.equal(p.displayLabel, "INT");
});

test("CORRECTIVE BATCH (real production): internet: WIFI -> point, placeable exactly like Internet/IP", () => {
  const p = resolveTechnicalServicePresentation("internet", "WIFI");
  assert.equal(p.placementBehavior, "point");
  assert.equal(p.color, TECHNICAL_RASTER_COLORS.internet);
});

test("PRODUCTION BATCH (real production): internet: WIFI -> onePerRecord — a WiFi order's own quantity (2/3/5) means licenses/devices, never distinct physical points; exactly one marker is required regardless of the raw imported quantity", () => {
  for (const label of ["WIFI", "WiFi", "Wi-Fi", "wifi"]) {
    const p = resolveTechnicalServicePresentation("internet", label);
    assert.equal(p.placementCardinality, "onePerRecord", `label "${label}"`);
  }
  // Internet/Pevná IP are explicitly UNCHANGED by this batch — still perQuantity.
  assert.equal(resolveTechnicalServicePresentation("internet", "Internet").placementCardinality, "perQuantity");
  assert.equal(resolveTechnicalServicePresentation("internet", "Pevná IP").placementCardinality, "perQuantity");
});

test("CORRECTIVE BATCH (2nd) — label mapping: WiFi must display literal 'WiFi' text, never fall through to the generic Internet 'INT' label", () => {
  for (const label of ["WIFI", "WiFi", "Wi-Fi", "wifi"]) {
    const p = resolveTechnicalServicePresentation("internet", label);
    assert.equal(p.renderer, "textLabel", `label "${label}"`);
    assert.equal(p.displayLabel, "WiFi", `label "${label}"`);
    assert.notEqual(p.displayLabel, "INT", `label "${label}" must never fall through to generic Internet`);
  }
});

test("CORRECTIVE BATCH (2nd) — label mapping: breaker characteristic ('Jistič C'/'Jistič D') must display its own letter, never fall through to the generic electricity 'EL' label", () => {
  const c = resolveTechnicalServicePresentation("electricity", "Jistič C");
  assert.equal(c.placementBehavior, "point");
  assert.equal(c.renderer, "textLabel");
  assert.equal(c.displayLabel, "C");
  assert.notEqual(c.displayLabel, "EL");
  assert.equal(c.color, TECHNICAL_RASTER_COLORS.electricity);

  const d = resolveTechnicalServicePresentation("electricity", "Jistič D");
  assert.equal(d.displayLabel, "D");
});

test("CORRECTIVE BATCH (2nd) — breaker: a concrete amperage value already present in the real label is shown verbatim, never invented", () => {
  assert.equal(resolveTechnicalServicePresentation("electricity", "Jistič C16").displayLabel, "C16");
  assert.equal(resolveTechnicalServicePresentation("electricity", "Jistič C 20A").displayLabel, "C20");
  assert.equal(resolveTechnicalServicePresentation("electricity", "jistic C").displayLabel, "C", "diacritic-free 'jistic' must still be recognized");
});

test("GENERATED LEGEND BATCH — breaker legendLabel is per-characteristic-letter, extensible: C and D never collapse into one shared 'JISTIČ (CHARAKTERISTIKA)' legend row", () => {
  assert.equal(resolveTechnicalServicePresentation("electricity", "Jistič C").legendLabel, "JISTIČ CHARAKTERISTIKY C");
  assert.equal(resolveTechnicalServicePresentation("electricity", "Jistič D").legendLabel, "JISTIČ CHARAKTERISTIKY D");
  assert.notEqual(
    resolveTechnicalServicePresentation("electricity", "Jistič C").legendLabel,
    resolveTechnicalServicePresentation("electricity", "Jistič D").legendLabel,
  );
  // A concrete amperage (C16/C20) still dedups to the SAME per-letter legend row as a bare "Jistič C" — the legend describes the characteristic, never one row per amperage value.
  assert.equal(resolveTechnicalServicePresentation("electricity", "Jistič C16").legendLabel, "JISTIČ CHARAKTERISTIKY C");
});

test("water: category-level point/green/waterDrop regardless of externalLabel", () => {
  const p = resolveTechnicalServicePresentation("water", "Přípojka vody");
  assert.equal(p.placementBehavior, "point");
  assert.equal(p.renderer, "waterDrop");
  assert.equal(p.color, TECHNICAL_RASTER_COLORS.water);
});

test("CORRECTIVE BATCH (real production): waste -> point, onePerRecord, never crashes on the real 'Kontejn 1100 l' label", () => {
  const p = resolveTechnicalServicePresentation("waste", "Kontejn 1100 l");
  assert.equal(p.placementBehavior, "point");
  assert.equal(p.placementCardinality, "onePerRecord");
  assert.equal(p.renderer, "textLabel");
  assert.equal(p.displayLabel, "ODP");
  assert.equal(p.color, TECHNICAL_RASTER_COLORS.waste);
  assert.equal(p.isFallback, false, "a genuinely classified decision, not an unresolved fallback");
});

test("CORRECTIVE BATCH (real production): cleaning -> point, onePerRecord — quantity 40 (e.g. '40 cleaning days') must never translate into 40 required placements", () => {
  const p = resolveTechnicalServicePresentation("cleaning", "Denní úklid");
  assert.equal(p.placementBehavior, "point");
  assert.equal(p.placementCardinality, "onePerRecord");
  assert.equal(p.renderer, "textLabel");
  assert.equal(p.displayLabel, "ÚKL");
  assert.equal(p.color, TECHNICAL_RASTER_COLORS.cleaning);
});

test("CORRECTIVE BATCH (real production): unknown category -> still placeable (point, onePerRecord) via a compact fallback label, isFallback true, never guessed", () => {
  const p = resolveTechnicalServicePresentation("some-future-category", "Nějaká nová služba");
  assert.equal(p.placementBehavior, "point");
  assert.equal(p.placementCardinality, "onePerRecord");
  assert.equal(p.displayLabel, "NĚJA");
  assert.equal(p.color, TECHNICAL_RASTER_COLORS.fallback);
  assert.equal(p.isFallback, true);
});

test("colors are centralized — every non-fallback presentation's color is one of TECHNICAL_RASTER_COLORS's own values, never a one-off literal", () => {
  const knownColors: Set<string> = new Set(Object.values(TECHNICAL_RASTER_COLORS));
  const samples = [
    resolveTechnicalServicePresentation("electricity", "Do 3kW 230V"),
    resolveTechnicalServicePresentation("internet", "Pevná IP"),
    resolveTechnicalServicePresentation("water", "x"),
    resolveTechnicalServicePresentation("waste", "x"),
    resolveTechnicalServicePresentation("cleaning", "x"),
    resolveTechnicalServicePresentation("unknown", "x"),
  ];
  for (const sample of samples) assert.ok(knownColors.has(sample.color), `unexpected one-off color: ${sample.color}`);
});

// =========================================================================================
// Stabilization batch (spec batch 12 section 7) — a single, stable, table-driven SNAPSHOT of
// every real report key this app has actually seen (verified against a live parser run of the
// real _IMPORT/Decor 26 fixtures, never invented — see this module's own doc). A future change to
// any of these rows is a REAL, visible presentation change — this test exists so that can never
// happen silently. Individual, more detailed assertions for each case already exist above; this
// table is a compact regression net over the same real keys, not a duplicate of their intent.
// =========================================================================================

const PRESENTATION_SNAPSHOT_CASES: readonly Readonly<{
  category: string;
  externalLabel: string;
  placementBehavior: string;
  placementCardinality: string;
  renderer: string;
  displayLabel?: string;
  colorKey: keyof typeof TECHNICAL_RASTER_COLORS;
}>[] = [
  { category: "electricity", externalLabel: "Do 2kW 230V", placementBehavior: "point", placementCardinality: "perQuantity", renderer: "powerLabel", displayLabel: "2 kW", colorKey: "electricity" },
  { category: "electricity", externalLabel: "Do 3kW 230V", placementBehavior: "point", placementCardinality: "perQuantity", renderer: "powerLabel", displayLabel: "3 kW", colorKey: "electricity" },
  { category: "electricity", externalLabel: "Do 5kW 230V", placementBehavior: "point", placementCardinality: "perQuantity", renderer: "powerLabel", displayLabel: "5 kW", colorKey: "electricity" },
  { category: "electricity", externalLabel: "Do 6kW 230V", placementBehavior: "point", placementCardinality: "perQuantity", renderer: "powerLabel", displayLabel: "6 kW", colorKey: "electricity" },
  { category: "electricity", externalLabel: "Do 9kW 400V", placementBehavior: "point", placementCardinality: "perQuantity", renderer: "powerLabel", displayLabel: "9 kW", colorKey: "electricity" },
  { category: "electricity", externalLabel: "Lednicový okruh", placementBehavior: "point", placementCardinality: "perQuantity", renderer: "refrigeratedStar", colorKey: "electricity" },
  { category: "internet", externalLabel: "Pevná IP", placementBehavior: "point", placementCardinality: "perQuantity", renderer: "textLabel", displayLabel: "IP", colorKey: "internet" },
  { category: "internet", externalLabel: "Internet", placementBehavior: "point", placementCardinality: "perQuantity", renderer: "textLabel", displayLabel: "INT", colorKey: "internet" },
  { category: "internet", externalLabel: "WIFI", placementBehavior: "point", placementCardinality: "onePerRecord", renderer: "textLabel", displayLabel: "WiFi", colorKey: "internet" },
  { category: "electricity", externalLabel: "Jistič C", placementBehavior: "point", placementCardinality: "perQuantity", renderer: "textLabel", displayLabel: "C", colorKey: "electricity" },
  { category: "water", externalLabel: "Přípojka vody", placementBehavior: "point", placementCardinality: "perQuantity", renderer: "waterDrop", colorKey: "water" },
  { category: "waste", externalLabel: "Kontejn 1100 l", placementBehavior: "point", placementCardinality: "onePerRecord", renderer: "textLabel", displayLabel: "ODP", colorKey: "waste" },
  { category: "cleaning", externalLabel: "Denní úklid", placementBehavior: "point", placementCardinality: "onePerRecord", renderer: "textLabel", displayLabel: "ÚKL", colorKey: "cleaning" },
  { category: "some-unknown-category", externalLabel: "Nová budoucí služba", placementBehavior: "point", placementCardinality: "onePerRecord", renderer: "fallback", displayLabel: "NOVÁ", colorKey: "fallback" },
];

test("SNAPSHOT: every known real report key resolves to its expected, stable presentation", () => {
  for (const testCase of PRESENTATION_SNAPSHOT_CASES) {
    const resolved = resolveTechnicalServicePresentation(testCase.category, testCase.externalLabel);
    const label = `${testCase.category} / "${testCase.externalLabel}"`;
    assert.equal(resolved.placementBehavior, testCase.placementBehavior, `${label}: placementBehavior`);
    assert.equal(resolved.placementCardinality, testCase.placementCardinality, `${label}: placementCardinality`);
    assert.equal(resolved.renderer, testCase.renderer, `${label}: renderer`);
    if (testCase.displayLabel !== undefined) assert.equal(resolved.displayLabel, testCase.displayLabel, `${label}: displayLabel`);
    assert.equal(resolved.color, TECHNICAL_RASTER_COLORS[testCase.colorKey], `${label}: color`);
  }
});

// =========================================================================================
// Manual acceptance batch, section 43 — export "Zahrnout" filter should only list categories that
// can ever produce a real vector export symbol. Pinned here (next to the presentation config that
// defines this) rather than in the UI component, so the rule stays correct even if
// TechnicalRasterOutputsPanel.tsx's own JSX changes.
// =========================================================================================

test("CORRECTIVE BATCH (real production): categoryCanHaveExportableSymbol is true for every category, including waste/cleaning/unknown — every imported operational service must be placeable AND exportable", () => {
  assert.equal(categoryCanHaveExportableSymbol("electricity"), true);
  assert.equal(categoryCanHaveExportableSymbol("internet"), true);
  assert.equal(categoryCanHaveExportableSymbol("water"), true);
  assert.equal(categoryCanHaveExportableSymbol("waste"), true);
  assert.equal(categoryCanHaveExportableSymbol("cleaning"), true);
  assert.equal(categoryCanHaveExportableSymbol("some-unknown-category"), true);
});
