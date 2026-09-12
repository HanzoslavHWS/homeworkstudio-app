import assert from "node:assert/strict";
import test from "node:test";
import { AssetValidationError, validateUploadInput, createStorageKey, isValidStorageKey } from "../domain/assets.ts";

/**
 * Stabilization batch (spec batch 12 section 16) — asset validation hardening for the
 * "catalog-technical-icon" AssetCategory (domain/assets.ts, added for the component "Technické
 * rastry" icon upload). Exercises the SAME validateUploadInput/createStorageKey functions every
 * other asset category already goes through — never a second/parallel validation path.
 */

const OWNER_ID = "comp-1";

function svgInput(overrides: Partial<Parameters<typeof validateUploadInput>[0]> = {}) {
  return { category: "catalog-technical-icon", ownerId: OWNER_ID, originalFileName: "icon.svg", mimeType: "image/svg+xml", size: 2048, ...overrides };
}

test("SVG is accepted for catalog-technical-icon", () => {
  assert.doesNotThrow(() => validateUploadInput(svgInput()));
});

test("PNG is accepted for catalog-technical-icon", () => {
  assert.doesNotThrow(() => validateUploadInput(svgInput({ originalFileName: "icon.png", mimeType: "image/png" })));
});

test("JPG is rejected for catalog-technical-icon (not in the allowed mime list)", () => {
  assert.throws(() => validateUploadInput(svgInput({ originalFileName: "icon.jpg", mimeType: "image/jpeg" })), AssetValidationError);
});

test("PDF is rejected for catalog-technical-icon", () => {
  assert.throws(() => validateUploadInput(svgInput({ originalFileName: "icon.pdf", mimeType: "application/pdf" })), AssetValidationError);
});

test("GIF and WEBP are rejected too (spec section 12: 'Nepovoluj... pokud pro ně nemáme jasný důvod')", () => {
  assert.throws(() => validateUploadInput(svgInput({ originalFileName: "icon.gif", mimeType: "image/gif" })), AssetValidationError);
  assert.throws(() => validateUploadInput(svgInput({ originalFileName: "icon.webp", mimeType: "image/webp" })), AssetValidationError);
});

test("an oversized icon is rejected (2 MB ceiling)", () => {
  assert.throws(() => validateUploadInput(svgInput({ size: 3_000_000 })), AssetValidationError);
});

test("a well-formed request produces a valid, correctly-prefixed storage key", () => {
  const key = createStorageKey({ category: "catalog-technical-icon", ownerId: OWNER_ID, originalFileName: "icon.svg", mimeType: "image/svg+xml" }, "fixed-uuid");
  assert.match(key, /^catalog\/technical-icons\/comp-1\/fixed-uuid\.svg$/u);
  assert.equal(isValidStorageKey(key), true);
});
