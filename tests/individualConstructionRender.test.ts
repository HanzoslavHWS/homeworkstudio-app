import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const boothGeneratorSource = readFileSync(new URL("../components/BoothGenerator.tsx", import.meta.url), "utf8");
const globalsCss = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

// =========================================================================================
// Turn 5 LIVE QA sections 22-25/51: the Konstrukce shared 2D canvas used to fill its ENTIRE
// boothCanvas (workspace-sized for Individual, not the real plot) with the legacy single-carpet
// rect — a big grey/colored block regardless of the booth's real (possibly L/U/triangle) shape.
// This pins that the legacy carpet layer is hidden for Individual, and that the real plot
// polygon + confirmed floor zones + an outside-plot dim mask are rendered instead, reusing the
// SAME worldToPlanView convention as everything else on this canvas.
// =========================================================================================

test("CONSTRUCTION RENDER: the legacy whole-canvas carpet layer is rendered ONLY for typovka (type !== \"individualni\") — never for Individual, where floorZones is the only source of truth", () => {
  assert.match(boothGeneratorSource, /\{type !== "individualni" && \(/u);
  const carpetDivIndex = boothGeneratorSource.indexOf('className={`carpetLayer');
  assert.ok(carpetDivIndex > 0, "expected the carpetLayer div in the source");
  const guardIndex = boothGeneratorSource.lastIndexOf('{type !== "individualni" && (', carpetDivIndex);
  assert.ok(guardIndex > 0 && carpetDivIndex - guardIndex < 200, "expected the carpetLayer div to be immediately inside the type !== \"individualni\" guard");
});

test("CONSTRUCTION RENDER: an outside-plot dim mask, a neutral 'uncovered' fill, and the plot boundary are all rendered for Individual, reusing the real individualPlotPolygon (never the workspace rectangle)", () => {
  const overlayBlock = boothGeneratorSource.match(/\{type === "individualni" && individualPlotPolygon && \([\s\S]{0,2500}?<\/div>\s*\)\}/u);
  assert.ok(overlayBlock, "expected the plotOutlineOverlay block");
  assert.match(overlayBlock![0], /className="plotOutsideMask"/u);
  assert.match(overlayBlock![0], /fillRule="evenodd"/u);
  assert.match(overlayBlock![0], /className="plotUncoveredFill"/u);
  assert.match(overlayBlock![0], /className="plotOutlineShape"/u);
});

test("CONSTRUCTION RENDER: each floor zone is rendered separately, and only CONFIRMED zones get a material-styled fill (per-finish class) — never 'whole workspace grey + one zone'", () => {
  const overlayBlock = boothGeneratorSource.match(/\{type === "individualni" && individualPlotPolygon && \([\s\S]{0,2500}?<\/div>\s*\)\}/u);
  assert.ok(overlayBlock);
  assert.match(overlayBlock![0], /individualFloorZones\.map\(\(zone\) => \(/u);
  assert.match(overlayBlock![0], /isFloorZoneConfirmed\(zone\) \? `plotOutlineFloorZone plotFloorZoneFill-\$\{zone\.finish\}` : "plotOutlineFloorZone"/u);
});

test("CONSTRUCTION RENDER CSS: plotUncoveredFill is a flat neutral fill (not a material-styled look), each plotFloorZoneFill-<finish> is a distinguishable, distinct color", () => {
  assert.match(globalsCss, /\.plotUncoveredFill\s*\{[^}]*fill:\s*#f2f2f2/u);
  const finishFills = ["carpet", "vinyl", "laminate", "other"].map((finish) => {
    const rule = globalsCss.match(new RegExp(`\\.plotFloorZoneFill-${finish}\\s*\\{[^}]*fill:\\s*(#[0-9a-f]{6})`, "iu"));
    assert.ok(rule, `expected a .plotFloorZoneFill-${finish} rule`);
    return rule![1]!.toLowerCase();
  });
  assert.equal(new Set(finishFills).size, finishFills.length, "every finish must have a visually distinct fill color");
});

// =========================================================================================
// Turn 5 LIVE QA sections 39-42/53: Konstrukce and Mobiliář are two DIFFERENT catalog sources
// sharing one scene. type === "individualni" alone used to always render BoothComponentLibrary,
// even on the Mobiliář sub-step — this pins the real switch on individualSubStep.
// =========================================================================================

test("MOBILIAR SWITCH: BoothComponentLibrary renders ONLY for individualni + konstrukce; every other case (typovka, OR individualni + mobiliar/plocha/podlaha) falls through to the shared production ComponentLibrary", () => {
  assert.match(
    boothGeneratorSource,
    /\{type === "individualni" && individualSubStep === "konstrukce" \? \([\s\S]{0,80}<BoothComponentLibrary[\s\S]{0,400}\) : \([\s\S]{0,80}<ComponentLibrary[\s\S]{0,150}\)\}/u,
  );
  // Never a second, narrower condition that would ALSO show BoothComponentLibrary on "mobiliar".
  assert.doesNotMatch(boothGeneratorSource, /individualSubStep === "mobiliar"[\s\S]{0,60}<BoothComponentLibrary/u);
});

test("MOBILIAR SWITCH: the SAME ComponentLibrary/inventory props typovka already uses are reused verbatim for Individual's Mobiliář — never a second furniture picker/catalog", () => {
  const match = boothGeneratorSource.match(/<ComponentLibrary\s+onAddComponent=\{addComponent\}\s+inventory=\{orderInventory\}\s*\/>/u);
  assert.ok(match, "expected exactly one <ComponentLibrary> call shared by typovka and Individual's Mobiliář");
  assert.equal((boothGeneratorSource.match(/<ComponentLibrary\b/gu) ?? []).length, 1, "never a second <ComponentLibrary> instance");
});
