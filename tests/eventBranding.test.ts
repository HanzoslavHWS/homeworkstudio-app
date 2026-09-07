import test from "node:test";
import assert from "node:assert/strict";
import { eventHasCuratedLogoAsset, resolveEventBranding } from "../domain/eventBranding.ts";
import { normalizeExhibition } from "../domain/organizations.ts";

// =========================================================================================
// Print Surfaces V5 (spec section 16): event branding resolver — never a per-event if/else,
// FOR BEAUTY/FOR ARCH/FOR DECOR/future events all resolve through the exact same path.
// =========================================================================================

test("FOR BEAUTY: resolver returns the static per-slug logo URL when no curated asset override is given", () => {
  const forBeauty = normalizeExhibition({ id: "for-beauty", slug: "for-beauty-podzim-2026", name: "FOR BEAUTY" });
  const branding = resolveEventBranding(forBeauty);
  assert.equal(branding.displayName, "FOR BEAUTY");
  assert.equal(branding.logoUrl, "/events/for-beauty-podzim-2026/logo.png");
  assert.equal(branding.hasCuratedLogo, false);
});

test("FOR ARCH / FOR DECOR / any other event: the SAME resolver path, no per-event branch — only the slug differs", () => {
  const forArch = normalizeExhibition({ id: "for-arch", slug: "for-arch-2026", name: "FOR ARCH" });
  const forDecor = normalizeExhibition({ id: "for-decor", slug: "for-decor-2026", name: "FOR DECOR" });
  assert.equal(resolveEventBranding(forArch).logoUrl, "/events/for-arch-2026/logo.png");
  assert.equal(resolveEventBranding(forDecor).logoUrl, "/events/for-decor-2026/logo.png");
});

test("a curated (DB-uploaded) logo asset URL, when resolved by the caller, wins over the static convention path", () => {
  const forBeauty = normalizeExhibition({ id: "for-beauty", slug: "for-beauty-podzim-2026", name: "FOR BEAUTY" });
  const branding = resolveEventBranding(forBeauty, "https://r2.example.test/curated-logo.png");
  assert.equal(branding.logoUrl, "https://r2.example.test/curated-logo.png");
  assert.equal(branding.hasCuratedLogo, true);
});

test("no event at all: resolver returns a text-only fallback, no logoUrl, never throws", () => {
  const branding = resolveEventBranding(undefined);
  assert.equal(branding.displayName, "");
  assert.equal(branding.logoUrl, undefined);
  assert.equal(branding.hasCuratedLogo, false);
});

test("eventHasCuratedLogoAsset: true only when logoAsset is actually present", () => {
  assert.equal(eventHasCuratedLogoAsset(undefined), false);
  assert.equal(eventHasCuratedLogoAsset({ logoAsset: undefined }), false);
  assert.equal(
    eventHasCuratedLogoAsset({ logoAsset: { id: "a", storageKey: "k", originalFileName: "logo.png", mimeType: "image/png", size: 1, createdAt: "2026-01-01T00:00:00.000Z", category: "event-logo" } }),
    true,
  );
});

test("event venue/date range: formatted only when eventFrom is present, single date when eventTo matches/absent", () => {
  const single = resolveEventBranding({ name: "X", slug: "x", logoUrl: "/x/logo.png", venue: "PVA Expo", eventFrom: "2026-03-05T00:00:00.000Z", eventTo: undefined });
  assert.equal(single.venue, "PVA Expo");
  assert.ok(single.dateRange);
  const noDates = resolveEventBranding({ name: "X", slug: "x", logoUrl: "/x/logo.png", venue: "PVA Expo", eventFrom: undefined, eventTo: undefined });
  assert.equal(noDates.dateRange, undefined);
});
