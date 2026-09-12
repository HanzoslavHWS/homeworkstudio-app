import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCatalogItemEdit,
  documentTechnicalRaster,
  parseCatalogItemAdminEdit,
  type CatalogItemAdminDocument,
} from "../domain/catalogItemsAdmin.ts";
import type { StoredAsset } from "../domain/assets.ts";

function iconAsset(overrides: Partial<StoredAsset> = {}): StoredAsset {
  return {
    id: "icon-1",
    storageKey: "catalog/technical-icons/comp-1/icon.svg",
    originalFileName: "waterdrop.svg",
    mimeType: "image/svg+xml",
    size: 1024,
    createdAt: "2026-01-01T00:00:00.000Z",
    category: "catalog-technical-icon",
    ...overrides,
  };
}

// ============================================================================
// parseCatalogItemAdminEdit — whitelist validation (spec batch 11 section 31/33)
// ============================================================================

test("parse: a well-formed technicalRaster object is accepted verbatim (valid fields only)", () => {
  const edit = parseCatalogItemAdminEdit({
    technicalRaster: { enabled: true, placementBehavior: "point", renderer: "textLabel", displayLabel: "IP", color: "#D89B00", legendLabel: "INTERNET — PEVNÁ PŘÍPOJKA" },
  });
  assert.deepEqual(edit.technicalRaster, {
    enabled: true,
    placementBehavior: "point",
    renderer: "textLabel",
    displayLabel: "IP",
    color: "#d89b00",
    legendLabel: "INTERNET — PEVNÁ PŘÍPOJKA",
  });
});

test("parse: technicalRaster: null is accepted as an explicit reset marker", () => {
  const edit = parseCatalogItemAdminEdit({ technicalRaster: null });
  assert.equal(edit.technicalRaster, null);
});

test("parse: omitting technicalRaster entirely leaves it undefined (no unintended reset/change)", () => {
  const edit = parseCatalogItemAdminEdit({ displayName: "X" });
  assert.equal("technicalRaster" in edit, false);
});

test("parse: an invalid placementBehavior string is silently dropped, not the whole object", () => {
  const edit = parseCatalogItemAdminEdit({ technicalRaster: { placementBehavior: "not-a-real-value", color: "#ff0000" } });
  assert.equal(edit.technicalRaster?.placementBehavior, undefined);
  assert.equal(edit.technicalRaster?.color, "#ff0000");
});

test("parse: an invalid hex color is dropped", () => {
  const edit = parseCatalogItemAdminEdit({ technicalRaster: { color: "red" } });
  assert.equal(edit.technicalRaster, undefined, "an object with zero recognized fields resolves to undefined entirely");
});

test("parse: a displayLabel containing HTML markup is rejected (spec section 8/13: never raw markup in a text field)", () => {
  const edit = parseCatalogItemAdminEdit({ technicalRaster: { displayLabel: "<script>x</script>" } });
  assert.equal(edit.technicalRaster, undefined);
});

test("parse: a displayLabel longer than the short-label ceiling is rejected", () => {
  const edit = parseCatalogItemAdminEdit({ technicalRaster: { displayLabel: "THIS LABEL IS WAY TOO LONG FOR A SYMBOL" } });
  assert.equal(edit.technicalRaster, undefined);
});

test("parse: displayLabel is trimmed", () => {
  const edit = parseCatalogItemAdminEdit({ technicalRaster: { displayLabel: "  IP  " } });
  assert.equal(edit.technicalRaster?.displayLabel, "IP");
});

test("parse: a valid StoredAsset-shaped iconAsset is accepted; a malformed one is dropped", () => {
  const validEdit = parseCatalogItemAdminEdit({ technicalRaster: { iconAsset: iconAsset() } });
  assert.equal(validEdit.technicalRaster?.iconAsset?.storageKey, "catalog/technical-icons/comp-1/icon.svg");

  const invalidEdit = parseCatalogItemAdminEdit({ technicalRaster: { iconAsset: { id: "x" } } });
  assert.equal(invalidEdit.technicalRaster, undefined);
});

test("parse: an attacker-controlled body with extra/unknown keys never leaks them through", () => {
  const edit = parseCatalogItemAdminEdit({ technicalRaster: { color: "#123456", evilField: "DROP TABLE" } });
  assert.deepEqual(edit.technicalRaster, { color: "#123456" });
});

// ============================================================================
// applyCatalogItemEdit + documentTechnicalRaster — persistence round trip (spec section 32)
// ============================================================================

test("persistence round trip: apply then read back returns exactly the saved values", () => {
  const document: CatalogItemAdminDocument = { displayName: "Pevná IP" };
  const edit = parseCatalogItemAdminEdit({ technicalRaster: { color: "#00ff00", displayLabel: "IP" } });
  const saved = applyCatalogItemEdit(document, edit);
  const reloaded = documentTechnicalRaster(saved);
  assert.deepEqual(reloaded, { color: "#00ff00", displayLabel: "IP" });
});

test("persistence: a document with NO technicalRaster key at all (every existing component today) reads back as undefined — backward compatible", () => {
  const document: CatalogItemAdminDocument = { displayName: "Legacy component", widthMm: 500 };
  assert.equal(documentTechnicalRaster(document), undefined);
});

test("persistence: applying an edit with technicalRaster undefined leaves an existing config completely untouched", () => {
  const document: CatalogItemAdminDocument = { technicalRaster: { color: "#ff0000" } };
  const saved = applyCatalogItemEdit(document, { displayName: "renamed only" });
  assert.deepEqual(documentTechnicalRaster(saved), { color: "#ff0000" });
});

test("Reset: applying technicalRaster:null removes the override entirely, key is gone from the raw document too", () => {
  const document: CatalogItemAdminDocument = { technicalRaster: { color: "#ff0000", displayLabel: "EL" } };
  const saved = applyCatalogItemEdit(document, { technicalRaster: null });
  assert.equal(documentTechnicalRaster(saved), undefined);
  assert.equal("technicalRaster" in saved, false);
});

test("Reset then re-check: a reset document behaves identically to a component that never had a config", () => {
  const withConfig: CatalogItemAdminDocument = { technicalRaster: { color: "#ff0000" } };
  const afterReset = applyCatalogItemEdit(withConfig, { technicalRaster: null });
  const neverConfigured: CatalogItemAdminDocument = {};
  assert.deepEqual(documentTechnicalRaster(afterReset), documentTechnicalRaster(neverConfigured));
});

test("documentTechnicalRaster: a garbage-shaped stored value never throws, just reads as undefined", () => {
  assert.equal(documentTechnicalRaster({ technicalRaster: "not-an-object" } as unknown as CatalogItemAdminDocument), undefined);
  assert.equal(documentTechnicalRaster({ technicalRaster: 42 } as unknown as CatalogItemAdminDocument), undefined);
  assert.equal(documentTechnicalRaster({ technicalRaster: null } as unknown as CatalogItemAdminDocument), undefined);
});

test("full JSON.stringify -> JSON.parse round trip (spec batch 12 section 9) — simulates a real DB write/read of the JSONB document column, including a StoredAsset iconAsset, and confirms documentTechnicalRaster still reads it back correctly afterward", () => {
  const document: CatalogItemAdminDocument = {
    displayName: "Pevná IP",
    technicalRaster: {
      enabled: true,
      placementBehavior: "point",
      renderer: "textLabel",
      displayLabel: "IP",
      color: "#d89b00",
      legendLabel: "INTERNET — PEVNÁ PŘÍPOJKA",
      iconAsset: iconAsset(),
    },
  };
  const roundTripped = JSON.parse(JSON.stringify(document)) as CatalogItemAdminDocument;
  assert.deepEqual(roundTripped, document, "the raw JSON round trip itself is byte-for-byte identical");
  const reloaded = documentTechnicalRaster(roundTripped);
  assert.deepEqual(reloaded, document.technicalRaster);
  assert.equal(reloaded?.iconAsset?.storageKey, iconAsset().storageKey);
});

test("saving a WHOLE new config replaces the previous one entirely (whole-value replace, matching photoAsset/modelAsset semantics) — not a partial merge", () => {
  const document: CatalogItemAdminDocument = { technicalRaster: { color: "#ff0000", displayLabel: "OLD", legendLabel: "OLD LEGEND" } };
  const edit = parseCatalogItemAdminEdit({ technicalRaster: { color: "#00ff00" } });
  const saved = applyCatalogItemEdit(document, edit);
  assert.deepEqual(documentTechnicalRaster(saved), { color: "#00ff00" }, "displayLabel/legendLabel from the OLD config are gone — the admin form is responsible for sending the full resulting object each save");
});
