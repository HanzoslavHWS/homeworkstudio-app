import assert from "node:assert/strict";
import test from "node:test";
import {
  TECHNICAL_RASTER_COLORS,
  categoryCanHaveExportableSymbol,
  extractElectricityKwLabel,
  resolveTechnicalServicePresentation,
} from "../domain/technicalRasterServicePresentation.ts";
import { APPROVED_TECHNICAL_MARKER_ROWS } from "../domain/technicalMarkerApprovedTable.ts";

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

test("HOTFIX-02: Lednicový okruh -> text 'LED', Non stop -> its OWN text 'Non-stop' (no shared star glyph any more)", () => {
  const fridge = resolveTechnicalServicePresentation("electricity", "Lednicový okruh");
  const nonStop = resolveTechnicalServicePresentation("electricity", "Non stop");
  assert.deepEqual([fridge.renderer, fridge.displayLabel, fridge.color], ["textLabel", "LED", TECHNICAL_RASTER_COLORS.electricity]);
  assert.deepEqual([nonStop.renderer, nonStop.displayLabel], ["textLabel", "Non-stop"]);
  assert.notEqual(fridge.variantId, nonStop.variantId);
});

test("electricity: a label with no extractable kW and no dedicated variant -> honest 'EL', never a guessed number", () => {
  const p = resolveTechnicalServicePresentation("electricity", "Prodlužovací kabel");
  assert.equal(p.placementBehavior, "point");
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

test("HOTFIX-02: legendLabel is the CATEGORY legend text — the PDF legend explains colors, never individual labels", () => {
  assert.equal(resolveTechnicalServicePresentation("electricity", "Jistič C").legendLabel, "ELEKTŘINA");
  assert.equal(resolveTechnicalServicePresentation("electricity", "Do 3kW 230V").legendLabel, "ELEKTŘINA");
  assert.equal(resolveTechnicalServicePresentation("internet", "WIFI").legendLabel, "INTERNET / WiFi");
  assert.equal(resolveTechnicalServicePresentation("water", "Voda, odpad").legendLabel, "VODA");
  assert.equal(resolveTechnicalServicePresentation("waste", "Kontejn 1100 l").legendLabel, "ODPAD");
  assert.equal(resolveTechnicalServicePresentation("cleaning", "Denní úklid").legendLabel, "ÚKLID");
});

test("water: any other water label -> text 'Voda', point, green", () => {
  const p = resolveTechnicalServicePresentation("water", "Přípojka vody");
  assert.equal(p.placementBehavior, "point");
  assert.equal(p.renderer, "textLabel");
  assert.equal(p.displayLabel, "Voda");
  assert.equal(p.color, TECHNICAL_RASTER_COLORS.water);
});

test("HOTFIX-02 dynamic label: 'Bazén - objem' shows its own quantity as '{mnozstvi} m³', always ONE point", () => {
  assert.equal(resolveTechnicalServicePresentation("water", "Bazén - objem", 3).displayLabel, "3 m³");
  assert.equal(resolveTechnicalServicePresentation("water", "Bazén - objem", 5).displayLabel, "5 m³");
  assert.equal(resolveTechnicalServicePresentation("water", "Bazén – objem", 2.5).displayLabel, "2.5 m³", "en dash and a decimal quantity");
  assert.equal(resolveTechnicalServicePresentation("water", "Bazén - objem").displayLabel, "? m³", "no quantity known -> never an invented number");
  assert.equal(resolveTechnicalServicePresentation("water", "Bazén - objem", 3).placementCardinality, "onePerRecord");
  assert.equal(resolveTechnicalServicePresentation("water", "Bazén - objem", 3).variantId, resolveTechnicalServicePresentation("water", "Bazén - objem", 5).variantId, "the identity never depends on the quantity");
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
  { category: "electricity", externalLabel: "Lednicový okruh", placementBehavior: "point", placementCardinality: "perQuantity", renderer: "textLabel", displayLabel: "LED", colorKey: "electricity" },
  { category: "internet", externalLabel: "Pevná IP", placementBehavior: "point", placementCardinality: "perQuantity", renderer: "textLabel", displayLabel: "IP", colorKey: "internet" },
  { category: "internet", externalLabel: "Internet", placementBehavior: "point", placementCardinality: "perQuantity", renderer: "textLabel", displayLabel: "INT", colorKey: "internet" },
  { category: "internet", externalLabel: "WIFI", placementBehavior: "point", placementCardinality: "onePerRecord", renderer: "textLabel", displayLabel: "WiFi", colorKey: "internet" },
  { category: "electricity", externalLabel: "Jistič C", placementBehavior: "point", placementCardinality: "perQuantity", renderer: "textLabel", displayLabel: "C", colorKey: "electricity" },
  { category: "water", externalLabel: "Přípojka vody", placementBehavior: "point", placementCardinality: "perQuantity", renderer: "textLabel", displayLabel: "Voda", colorKey: "water" },
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

// =========================================================================================
// HOTFIX-02 — the APPROVED marker table (_IMPORT/TECHNICKE_ZNACKY/Generator_ABF_Revize_technickych_znacek.xlsx,
// sheet "Technické značky": B = ABRA name, K = NOVÝ popisek v rastru (= L, NOVÝ text v PDF),
// N = NOVÁ barva, P = NOVÉ pravidlo počtu bodů). Every one of the 34 approved rows, verbatim.
// The Excel itself is never committed; scripts/technicalMarkersExcelCheck.ts re-checks the same
// table (domain/technicalMarkerApprovedTable.ts) against it when it is available locally.
// =========================================================================================

test("HOTFIX-02 APPROVED TABLE: every approved ABRA name -> its approved text, color and point rule; every marker is TEXT", () => {
  assert.equal(APPROVED_TECHNICAL_MARKER_ROWS.length, 34);
  for (const row of APPROVED_TECHNICAL_MARKER_ROWS) {
    const quantity = 4;
    const p = resolveTechnicalServicePresentation(row.category, row.abraName, quantity);
    const where = `${row.category} / "${row.abraName}"`;
    assert.equal(p.displayLabel, row.label.replace("{mnozstvi}", String(quantity)), `${where}: label`);
    assert.equal(p.color, row.color, `${where}: color`);
    assert.equal(p.placementCardinality, row.rule === "Vždy 1 bod" ? "onePerRecord" : "perQuantity", `${where}: point rule`);
    assert.equal(p.placementBehavior, "point", `${where}: placeable`);
    assert.ok(["powerLabel", "textLabel", "fallback"].includes(p.renderer), `${where}: drawn as text, got ${p.renderer}`);
  }
});

test("HOTFIX-02 identity: every approved service that is a DIFFERENT service has a different internal variant id", () => {
  const ids = (category: string, ...labels: string[]) => labels.map((label) => resolveTechnicalServicePresentation(category, label).variantId);
  const [do21, rozvadec] = ids("electricity", "Do 21kW 400V", "Rozvaděč 9-21kW");
  assert.notEqual(do21, rozvadec, "Do 21 kW ≠ Rozvaděč 9–21 kW");
  const [fridge, nonStop] = ids("electricity", "Lednicový okruh", "Non stop");
  assert.notEqual(fridge, nonStop, "Non stop ≠ Lednicový okruh");
  const [lighting, overhead, plusKw] = ids("electricity", "Osvětlení", "Vrchní přívod", "+ kW");
  assert.equal(new Set([lighting, overhead, plusKw]).size, 3, "Osvětlení ≠ Vrchní přívod ≠ + kW");
  const [internet, router] = ids("internet", "Internet", "Router zapůjčení");
  assert.notEqual(internet, router, "Internet ≠ Router");
  const [poolConnection, poolVolume, water] = ids("water", "Bazén - přípojka", "Bazén - objem", "Voda, odpad");
  assert.equal(new Set([poolConnection, poolVolume, water]).size, 3);
  // Labels the approved table treats as the same service kind keep ONE identity.
  assert.deepEqual(ids("internet", "WIFI", "Další WIFI přípojka", "WIFI 2 EEt"), ["wifi", "wifi", "wifi"]);
});

test("HOTFIX-02 identity: ids of services that never collided are byte-identical to the previous version (no churn)", () => {
  const expected: readonly [string, string, string][] = [
    ["electricity", "Do 2kW 230V", "2kw"], ["electricity", "Do 21kW 400V", "21kw"], ["electricity", "EET 0.5KW", "0.5kw"],
    ["electricity", "Lednicový okruh", "refrigerated"], ["internet", "Pevná IP", "fixed-ip"], ["internet", "WIFI", "wifi"],
    ["internet", "Router zapůjčení", "internet:router"], ["internet", "Internet", "internet:plain"], ["water", "Voda, odpad", "water:connection"],
    ["cleaning", "Denní úklid", "cleaning:daily"], ["cleaning", "Generální úklid", "cleaning:general"], ["waste", "Kontejn 1100 l", "kontejn 1100 l"],
  ];
  for (const [category, label, variantId] of expected) assert.equal(resolveTechnicalServicePresentation(category, label).variantId, variantId, label);
});
