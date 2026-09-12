import assert from "node:assert/strict";
import test from "node:test";
import { LEGACY_EVENT_ID_ALIASES, resolveCanonicalEventId } from "../domain/eventIdentity.ts";
import { resolveEventPriceListForCurrency } from "../domain/organizations.ts";
import { exhibitions, priceLists } from "../data/organizations.ts";
import { fairs } from "../data/fairs.ts";

// ============================================================================
// Corrective batch — event-ID consistency audit. Root cause: the app's own local/dev seed
// (data/organizations.ts, data/fairs.ts) historically used per-EDITION ids ("for-beauty-autumn-2026")
// while the real production Supabase `events` table uses stable per-BRAND ids ("beauty", "arch",
// "decor", ...). These tests pin the ONE central resolver every persistence path now uses.
// ============================================================================

const PRODUCTION_EVENT_IDS = [
  "arch", "beauty", "ctm", "czechbus", "decor", "esalon", "event-1786622663908",
  "fishing", "gastro", "holiday", "interior", "kids", "pets", "svd", "truck",
];

test("resolveCanonicalEventId: 'for-beauty-autumn-2026' resolves to the real production 'beauty' id", () => {
  assert.equal(resolveCanonicalEventId("for-beauty-autumn-2026", PRODUCTION_EVENT_IDS), "beauty");
});

test("resolveCanonicalEventId: 'for-decor-2026' resolves to the real production 'decor' id", () => {
  assert.equal(resolveCanonicalEventId("for-decor-2026", PRODUCTION_EVENT_IDS), "decor");
});

test("resolveCanonicalEventId: 'for-beauty-autumn-2027'/'for-decor-2027' (the local seed's own OTHER legacy editions) resolve to the same brand ids", () => {
  assert.equal(resolveCanonicalEventId("for-beauty-autumn-2027", PRODUCTION_EVENT_IDS), "beauty");
  assert.equal(resolveCanonicalEventId("for-decor-2027", PRODUCTION_EVENT_IDS), "decor");
});

test("resolveCanonicalEventId: an already-canonical production id is returned UNCHANGED, never remapped", () => {
  for (const id of PRODUCTION_EVENT_IDS) {
    assert.equal(resolveCanonicalEventId(id, PRODUCTION_EVENT_IDS), id);
  }
});

test("resolveCanonicalEventId: the timestamp-shaped 'event-1786622663908' id is treated as a perfectly ordinary canonical id, never specially parsed", () => {
  assert.equal(resolveCanonicalEventId("event-1786622663908", PRODUCTION_EVENT_IDS), "event-1786622663908");
});

test("resolveCanonicalEventId: a genuinely unknown id (no known/aliased match) resolves to undefined — never a guess", () => {
  assert.equal(resolveCanonicalEventId("international-2026", PRODUCTION_EVENT_IDS), undefined, "no confirmed production brand exists for this — must never be silently invented");
  assert.equal(resolveCanonicalEventId("totally-made-up-id", PRODUCTION_EVENT_IDS), undefined);
});

test("resolveCanonicalEventId: empty/undefined/whitespace-only input resolves to undefined (a project with no fair is valid, never an error)", () => {
  assert.equal(resolveCanonicalEventId(undefined, PRODUCTION_EVENT_IDS), undefined);
  assert.equal(resolveCanonicalEventId(null, PRODUCTION_EVENT_IDS), undefined);
  assert.equal(resolveCanonicalEventId("", PRODUCTION_EVENT_IDS), undefined);
  assert.equal(resolveCanonicalEventId("   ", PRODUCTION_EVENT_IDS), undefined);
});

test("resolveCanonicalEventId: a documented alias whose TARGET is not actually present in knownEventIds still resolves to undefined — never trusts the alias table alone", () => {
  assert.equal(resolveCanonicalEventId("for-beauty-autumn-2026", ["arch", "decor"]), undefined, "the alias target 'beauty' isn't in the known set here, so this must fail closed, never silently succeed");
});

test("resolveCanonicalEventId: whitespace around the input id is trimmed the same way normalizeStandNumber-style helpers already do elsewhere in this app", () => {
  assert.equal(resolveCanonicalEventId("  beauty  ", PRODUCTION_EVENT_IDS), "beauty");
});

test("resolveCanonicalEventId: accepts a Set OR any iterable of known ids interchangeably", () => {
  assert.equal(resolveCanonicalEventId("beauty", new Set(PRODUCTION_EVENT_IDS)), "beauty");
  assert.equal(resolveCanonicalEventId("beauty", PRODUCTION_EVENT_IDS), "beauty");
});

test("LEGACY_EVENT_ID_ALIASES: contains ONLY the confirmed brand correspondences — never an invented mapping for 'international-2026', which has no production counterpart", () => {
  assert.equal(LEGACY_EVENT_ID_ALIASES["international-2026"], undefined);
  assert.deepEqual(Object.keys(LEGACY_EVENT_ID_ALIASES).sort(), ["for-beauty-autumn-2026", "for-beauty-autumn-2027", "for-decor-2026", "for-decor-2027"]);
});

// ============================================================================
// Corrective batch — event-ID consistency audit, section 11: the local seed's own `exhibitions`
// (data/organizations.ts) and `fairs` (data/fairs.ts) now use the REAL canonical event ids
// ("beauty"/"decor") — this must never break the EXISTING price-list/event association, since only
// `Exhibition.id` changed, never `Exhibition.priceListIds`/`PriceList.id` (a deliberately separate,
// DB-uuid-backed namespace in production — see data/organizations.ts's own updated doc).
// ============================================================================

test("seed fix regression: data/organizations.ts's own exhibitions now use the real canonical event ids", () => {
  assert.equal(exhibitions.find((event) => event.name === "FOR BEAUTY podzim 2026")?.id, "beauty");
  assert.equal(exhibitions.find((event) => event.name === "FOR DECOR 2026")?.id, "decor");
  // No confirmed production counterpart — deliberately left as a local-only id, never guessed.
  assert.equal(exhibitions.find((event) => event.name === "Zahraniční veletrh 2026")?.id, "international-2026");
});

test("seed fix regression: data/fairs.ts's own ids match data/organizations.ts's exhibitions exactly, for every fair with a real production counterpart", () => {
  assert.equal(fairs.find((fair) => fair.name === "FOR BEAUTY podzim 2026")?.id, "beauty");
  assert.equal(fairs.find((fair) => fair.name === "FOR DECOR 2026")?.id, "decor");
});

test("seed fix regression: resolveEventPriceListForCurrency still resolves the correct price list for the corrected 'beauty'/'decor' exhibitions — changing Exhibition.id never broke the priceListIds cross-reference", () => {
  const beauty = exhibitions.find((event) => event.id === "beauty")!;
  const decor = exhibitions.find((event) => event.id === "decor")!;
  assert.equal(resolveEventPriceListForCurrency(beauty, priceLists, "CZK")?.name, "FOR BEAUTY podzim 2026");
  assert.equal(resolveEventPriceListForCurrency(decor, priceLists, "CZK")?.name, "FOR DECOR 2026");
});
