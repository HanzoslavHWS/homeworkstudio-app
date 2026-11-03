import assert from "node:assert/strict";
import test from "node:test";
import { assertCanActivate, CatalogReadinessError, evaluateCatalogReadiness, READINESS_ISSUE_LABELS_CS } from "../domain/catalogReadiness.ts";
import { GRAPHICS_CATEGORY_PRICING_UNITS, resolveGraphicsPricingUnit } from "../domain/graphicsPricingUnit.ts";
import { pricingModeForTypeId } from "../domain/printSurfacePricing.ts";
import type { ComponentDefinition } from "../domain/models.ts";

/** Same document shape the admin saves for the hand-made DEV cards M91/M95/M96 (no pricingUnit, unit + category only). */
function graphicsCard(category: string, unit: string | undefined, extra: Partial<ComponentDefinition> = {}): ComponentDefinition {
  return {
    id: `test-${category}`,
    name: `Grafika ${category}`,
    displayName: `Grafika ${category}`,
    category,
    ...(unit === undefined ? {} : { unit }),
    showIn2D: true,
    showIn3D: false,
    footprint2D: { shape: "rectangle" },
    catalogItemKind: "graphics_service",
    widthMm: 0,
    depthMm: 0,
    ...extra,
  } as ComponentDefinition;
}

test("Límec / Celopolep / Polep pultu: cenová jednotka se odvodí z kategorie, žádná falešná chyba v Lifecycle", () => {
  const cases: readonly [string, string, string][] = [
    ["graphics-fascia", "bm", "linear-meter"],
    ["graphics-full-wrap", "m²", "square-meter"],
    ["graphics-counter", "m²", "square-meter"],
  ];
  for (const [category, unit, expected] of cases) {
    const card = graphicsCard(category, unit);
    assert.deepEqual(resolveGraphicsPricingUnit(card), { status: "resolved", pricingUnit: expected, source: "category" }, category);
    const readiness = evaluateCatalogReadiness(card, "graphics_service");
    assert.equal(readiness.ready, true, `${category}: ${readiness.issues.join(", ")}`);
    assert.ok(!readiness.issues.includes("missing_pricing_unit"));
  }
});

test("registrové kódy i textové zápisy jednotky platí stejně (m2 = m², b. m. = bm)", () => {
  assert.equal(evaluateCatalogReadiness(graphicsCard("graphics-full-wrap", "m2"), "graphics_service").ready, true);
  assert.equal(evaluateCatalogReadiness(graphicsCard("graphics-fascia", "b. m."), "graphics_service").ready, true);
});

test("nesoulad jednotky a kategorie je chyba, nikdy tichý převod bm ↔ m²", () => {
  const wrong: readonly [string, string][] = [["graphics-fascia", "m²"], ["graphics-full-wrap", "bm"], ["graphics-counter", "bm"], ["graphics-counter", "ks"]];
  for (const [category, unit] of wrong) {
    const card = graphicsCard(category, unit);
    const resolution = resolveGraphicsPricingUnit(card);
    assert.equal(resolution.status, "mismatch", `${category} + ${unit}`);
    assert.match(resolution.status === "mismatch" ? resolution.message : "", /nepřevádějí/u);
    const readiness = evaluateCatalogReadiness(card, "graphics_service");
    assert.equal(readiness.ready, false);
    assert.deepEqual(readiness.issues, ["pricing_unit_mismatch"]);
    assert.throws(() => assertCanActivate({ ...card, lifecycleStatus: "active" }, "graphics_service"), CatalogReadinessError, "nesouladnou kartu nelze aktivovat");
  }
  assert.ok(READINESS_ISSUE_LABELS_CS.pricing_unit_mismatch.includes("Límec = bm"));
});

test("uložená (legacy) pricingUnit musí odpovídat odvozené jednotce", () => {
  assert.equal(resolveGraphicsPricingUnit(graphicsCard("graphics-fascia", "bm", { pricingUnit: "linear-meter" })).status, "resolved");
  assert.equal(resolveGraphicsPricingUnit(graphicsCard("graphics-full-wrap", "m²", { pricingUnit: "linear-meter" })).status, "mismatch");
  assert.equal(resolveGraphicsPricingUnit(graphicsCard("graphics-other", "m²", { pricingUnit: "linear-meter" })).status, "mismatch");
});

test("bez jednotky: pevná kategorie stačí; Ostatní grafika bez jednotky hlásí chybějící cenovou jednotku", () => {
  assert.deepEqual(resolveGraphicsPricingUnit(graphicsCard("graphics-fascia", undefined)), { status: "resolved", pricingUnit: "linear-meter", source: "category" });
  const other = graphicsCard("graphics-other", undefined);
  assert.equal(resolveGraphicsPricingUnit(other).status, "missing");
  assert.deepEqual(evaluateCatalogReadiness(other, "graphics_service").issues, ["missing_pricing_unit"]);
});

test("Ostatní grafika přebírá jednotku karty (bm, m², ks)", () => {
  assert.deepEqual(resolveGraphicsPricingUnit(graphicsCard("graphics-other", "ks")), { status: "resolved", pricingUnit: "piece", source: "unit" });
  assert.deepEqual(resolveGraphicsPricingUnit(graphicsCard("graphics-other", "bm")), { status: "resolved", pricingUnit: "linear-meter", source: "unit" });
});

test("ostatní kontroly připravenosti grafiky dál platí (název, kategorie)", () => {
  const noName = graphicsCard("graphics-counter", "m²", { name: "", displayName: "" });
  assert.ok(evaluateCatalogReadiness(noName, "graphics_service").issues.includes("missing_display_name"));
  const noCategory = graphicsCard("", "m²");
  const issues = evaluateCatalogReadiness(noCategory, "graphics_service").issues;
  assert.ok(issues.includes("missing_category"));
});

test("cenové jednotky kategorií odpovídají pravidlu generátoru (límec = bm, pult a ostatní plochy = m²)", () => {
  assert.equal(GRAPHICS_CATEGORY_PRICING_UNITS["graphics-fascia"], "linear-meter");
  assert.equal(pricingModeForTypeId("fascia"), "running_metre");
  assert.equal(GRAPHICS_CATEGORY_PRICING_UNITS["graphics-counter"], GRAPHICS_CATEGORY_PRICING_UNITS["graphics-full-wrap"]);
  for (const typeId of ["panel", "panel_above_door", "counter_front", "counter_side", "showcase", "custom"] as const) {
    assert.equal(pricingModeForTypeId(typeId), "area_m2", typeId);
  }
});

test("2D zapnuto / 3D vypnuto bez GLB: grafika zůstává připravená (3D se u grafiky nevyžaduje)", () => {
  const card = graphicsCard("graphics-full-wrap", "m²", { showIn3D: false, modelUrl: undefined });
  assert.equal(evaluateCatalogReadiness(card, "graphics_service").ready, true);
  const with3dNoModel = graphicsCard("graphics-full-wrap", "m²", { showIn3D: true, modelUrl: undefined });
  assert.equal(evaluateCatalogReadiness(with3dNoModel, "graphics_service").ready, true, "zapnuté 3D bez GLB u grafiky neblokuje připravenost");
});
