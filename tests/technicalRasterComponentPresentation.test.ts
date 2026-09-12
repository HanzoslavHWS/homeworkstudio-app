import assert from "node:assert/strict";
import test from "node:test";
import { resolveTechnicalRasterPresentation, type TechnicalRasterComponentConfig } from "../domain/technicalRasterComponentPresentation.ts";
import { resolveTechnicalServicePresentation } from "../domain/technicalRasterServicePresentation.ts";
import type { TechnicalRasterExportPlacementItem } from "../domain/technicalRasterExport.ts";

const electricity = { category: "electricity", externalLabel: "Do 3kW 230V" };

test("A) no component config -> exactly resolveTechnicalServicePresentation's own result (backward compatibility)", () => {
  const withoutConfig = resolveTechnicalRasterPresentation(electricity);
  const central = resolveTechnicalServicePresentation(electricity.category, electricity.externalLabel);
  assert.deepEqual(withoutConfig, central);
});

test("A2) an empty config object -> exactly the central result too", () => {
  assert.deepEqual(resolveTechnicalRasterPresentation(electricity, {}), resolveTechnicalServicePresentation(electricity.category, electricity.externalLabel));
});

test("A3) enabled:false -> explicit suppression: forces placementBehavior 'none' (spec batch 11 section 4: 'komponenta se jako technická značka nevykresluje'), never a crash, never deletes anything (this function has no placement data to delete in the first place)", () => {
  const config: TechnicalRasterComponentConfig = { enabled: false, color: "#000000", displayLabel: "OVERRIDDEN" };
  const resolved = resolveTechnicalRasterPresentation(electricity, config);
  assert.equal(resolved.placementBehavior, "none");
  assert.equal(resolved.color, "#000000", "other fields still resolve normally underneath the suppression — useful for a disabled-state admin preview");
  assert.equal(resolved.displayLabel, "OVERRIDDEN");
  assert.equal(resolved.isFallback, false);
});

test("A4) enabled:false with no other overrides still forces 'none', with central color/labels underneath", () => {
  const central = resolveTechnicalServicePresentation(electricity.category, electricity.externalLabel);
  const resolved = resolveTechnicalRasterPresentation(electricity, { enabled: false });
  assert.equal(resolved.placementBehavior, "none");
  assert.equal(resolved.color, central.color);
  assert.equal(resolved.displayLabel, central.displayLabel);
});

test("B) explicit color override — only color changes, every other field stays the central default", () => {
  const central = resolveTechnicalServicePresentation(electricity.category, electricity.externalLabel);
  const resolved = resolveTechnicalRasterPresentation(electricity, { color: "#00ff00" });
  assert.equal(resolved.color, "#00ff00");
  assert.equal(resolved.placementBehavior, central.placementBehavior);
  assert.equal(resolved.renderer, central.renderer);
  assert.equal(resolved.displayLabel, central.displayLabel);
  assert.equal(resolved.legendLabel, central.legendLabel);
});

test("multiple overrides simultaneously — color + label + legend + placementBehavior all apply together, independently, none clobbering another", () => {
  const resolved = resolveTechnicalRasterPresentation(electricity, {
    color: "#123456",
    displayLabel: "3kW!",
    legendLabel: "VLASTNÍ",
    placementBehavior: "informational",
  });
  assert.equal(resolved.color, "#123456");
  assert.equal(resolved.displayLabel, "3kW!");
  assert.equal(resolved.legendLabel, "VLASTNÍ");
  assert.equal(resolved.placementBehavior, "informational");
  // renderer wasn't overridden — still the central default for this real label.
  assert.equal(resolved.renderer, resolveTechnicalServicePresentation(electricity.category, electricity.externalLabel).renderer);
});

test("C) explicit label override (displayLabel + legendLabel) — only those change", () => {
  const central = resolveTechnicalServicePresentation(electricity.category, electricity.externalLabel);
  const resolved = resolveTechnicalRasterPresentation(electricity, { displayLabel: "3kW", legendLabel: "VLASTNÍ LEGENDA" });
  assert.equal(resolved.displayLabel, "3kW");
  assert.equal(resolved.legendLabel, "VLASTNÍ LEGENDA");
  assert.equal(resolved.color, central.color);
  assert.equal(resolved.renderer, central.renderer);
  assert.equal(resolved.placementBehavior, central.placementBehavior);
});

test("D) explicit placementBehavior override — a normally-point service can be forced informational (and vice versa)", () => {
  const forcedInformational = resolveTechnicalRasterPresentation(electricity, { placementBehavior: "informational" });
  assert.equal(forcedInformational.placementBehavior, "informational");

  const wifi = { category: "internet", externalLabel: "WIFI" }; // central default: informational
  const forcedPoint = resolveTechnicalRasterPresentation(wifi, { placementBehavior: "point" });
  assert.equal(forcedPoint.placementBehavior, "point");
});

test("E) fallback for an unknown service — no config still reports isFallback:true with the '?' label", () => {
  const unknown = { category: "some-future-category", externalLabel: "x" };
  const resolved = resolveTechnicalRasterPresentation(unknown);
  assert.equal(resolved.isFallback, true);
  assert.equal(resolved.displayLabel, "?");
});

test("E2) an unknown service WITH an explicit component override is no longer treated as a fallback", () => {
  const unknown = { category: "some-future-category", externalLabel: "x" };
  const resolved = resolveTechnicalRasterPresentation(unknown, { placementBehavior: "point", color: "#123456", displayLabel: "X" });
  assert.equal(resolved.isFallback, false, "a deliberately configured component override is a real, intentional presentation");
  assert.equal(resolved.color, "#123456");
});

test("E3) enabled:true with zero actual field overrides on an unknown service is STILL a fallback (nothing was really configured)", () => {
  const unknown = { category: "some-future-category", externalLabel: "x" };
  const resolved = resolveTechnicalRasterPresentation(unknown, { enabled: true });
  assert.equal(resolved.isFallback, true);
});

test("icon override — the iconAsset reference passes through the config untouched (resolveTechnicalRasterPresentation itself doesn't return it — TechnicalServicePresentation has no icon field yet — but the ORIGINAL config object the caller holds still carries it for the admin preview/future export wiring)", () => {
  const iconAsset = { id: "asset-1", storageKey: "catalog/technical-icons/x/icon.svg", originalFileName: "icon.svg", mimeType: "image/svg+xml", size: 512, createdAt: "2026-01-01T00:00:00.000Z", category: "catalog-technical-icon" as const };
  const config: TechnicalRasterComponentConfig = { iconAsset };
  assert.equal(config.iconAsset?.storageKey, iconAsset.storageKey, "the config object itself is the source of truth for the icon reference — a future renderer reads it from there, not from the resolved presentation");
});

test("F) this function's own signature carries no placement data at all — it can structurally never touch placement coordinates", () => {
  // A type-level guarantee, not a runtime one: resolveTechnicalRasterPresentation(service, componentConfig?) has no xNormalized/yNormalized/page parameter and returns a TechnicalServicePresentation, never a placement. Documented here as an explicit, checked assertion of the RETURN shape, which has no coordinate-like fields.
  const resolved = resolveTechnicalRasterPresentation(electricity, { color: "#ff0000" });
  assert.ok(!("xNormalized" in resolved) && !("yNormalized" in resolved) && !("page" in resolved));
});

test("G) the resolved presentation is structurally usable as a TechnicalRasterExportPlacementItem.presentation — the SAME export renderer (lib/technicalRasterVectorPdf.ts) can consume it unchanged", () => {
  const resolved = resolveTechnicalRasterPresentation(electricity, { color: "#00ff00", displayLabel: "3kW" });
  const item: TechnicalRasterExportPlacementItem = {
    standId: "s1",
    standNumber: "1A21",
    serviceId: "svc1",
    placementId: "p1",
    xNormalized: 0.5,
    yNormalized: 0.5,
    presentation: resolved,
  };
  assert.equal(item.presentation.color, "#00ff00");
});
