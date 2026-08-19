import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  adaptCatalogItemToBoothType,
  isProductionReadyBooth,
  resolveGeneratorBooth,
  resolveGeneratorVariant,
  selectGeneratorBooths,
} from "../domain/generatorBooths.ts";
import type { CatalogItemAdmin } from "../domain/catalogItemsAdmin.ts";
import { boothTypes } from "../data/booths.ts";

function fixture(overrides: Partial<CatalogItemAdmin> & { document?: Record<string, unknown> } = {}): CatalogItemAdmin {
  return {
    id: "row-uuid",
    internalCode: null,
    kind: "booth",
    lifecycleStatus: "needs_review",
    displayName: "Fixture",
    officialName: null,
    category: null,
    unit: null,
    document: {},
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
    ...overrides,
  };
}

const glbAsset = {
  id: "glb-1",
  storageKey: "catalog/furniture/t04/models/v1.glb",
  originalFileName: "v1.glb",
  mimeType: "model/gltf-binary" as const,
  size: 500_000,
  createdAt: "2026-08-19T00:00:00.000Z",
  category: "catalog-model" as const,
};

const skpAsset = {
  id: "skp-1",
  kind: "sketchup" as const,
  asset: {
    id: "skp-asset-1",
    storageKey: "catalog/furniture/t04/source/v1.skp",
    originalFileName: "v1.skp",
    mimeType: "application/octet-stream",
    size: 400_000,
    createdAt: "2026-08-19T00:00:00.000Z",
    category: "catalog-source" as const,
  },
};

const photoAsset = {
  id: "photo-1",
  storageKey: "catalog/furniture/t04/photos/main.jpg",
  originalFileName: "main.jpg",
  mimeType: "image/jpeg" as const,
  size: 200_000,
  createdAt: "2026-08-19T00:00:00.000Z",
  category: "catalog-photo" as const,
};

const t04ReadyVariants = [
  { id: "t04-corner-left", name: "Roh – levý", modelAsset: glbAsset, sourceAssets: [skpAsset] },
  { id: "t04-corner-right", name: "Roh – pravý", modelAsset: glbAsset, sourceAssets: [skpAsset] },
  { id: "t04-inline", name: "Řada / přímý", modelAsset: glbAsset, sourceAssets: [skpAsset] },
];

function t04Fixture(overrides: Partial<CatalogItemAdmin> = {}, documentOverrides: Record<string, unknown> = {}): CatalogItemAdmin {
  return fixture({
    id: "t04-uuid",
    internalCode: "T04",
    displayName: "Typový stánek octanorm - T4",
    category: "Typovky",
    lifecycleStatus: "active",
    document: {
      internalCode: "T04",
      displayName: "Typový stánek octanorm - T4",
      category: "Typovky",
      description: "Typová konstrukce Octanorm T04, tři varianty provedení: roh vlevo, roh vpravo, řadová/přímá. Bez zázemí.",
      widthMm: 2000,
      depthMm: 2000,
      heightMm: 2500,
      variants: t04ReadyVariants,
      variantsConfirmed: true,
      photoAsset,
      pricingEntries: [{ id: "t04-czk", itemId: "t04", currency: "CZK", salePrice: 4400 }],
      ...documentOverrides,
    },
    ...overrides,
  });
}

const p86RealDocument = boothTypes.find((booth) => booth.internalCode === "P86")!;

function p86Fixture(overrides: Partial<CatalogItemAdmin> = {}): CatalogItemAdmin {
  return fixture({
    id: "p86-uuid",
    internalCode: "P86",
    displayName: "Kóje 2 × 2 m (P86)",
    category: "Canonical",
    lifecycleStatus: "active",
    document: { ...p86RealDocument, lifecycleStatus: "active" } as unknown as Record<string, unknown>,
    ...overrides,
  });
}

// =========================================================================================
// isProductionReadyBooth — active AND ready AND generatorEligible, reusing the exact same
// domain rules the admin UI already trusts (never a parallel/looser production rule).
// =========================================================================================

test("isProductionReadyBooth: a fully-ready active T04 (confirmed variants, all GLB+SKP, real height) is production-ready", () => {
  assert.equal(isProductionReadyBooth(t04Fixture()), true);
});

test("isProductionReadyBooth: needs_review is never production-ready, even if otherwise complete", () => {
  assert.equal(isProductionReadyBooth(t04Fixture({ lifecycleStatus: "needs_review" })), false);
});

test("isProductionReadyBooth: archived is never production-ready", () => {
  assert.equal(isProductionReadyBooth(t04Fixture({ lifecycleStatus: "archived" })), false);
});

test("isProductionReadyBooth: active but missing assets (not actually ready) is never production-ready", () => {
  assert.equal(isProductionReadyBooth(fixture({ lifecycleStatus: "active", internalCode: "T09", document: { internalCode: "T09", widthMm: 3000, depthMm: 3000 } })), false);
});

test("isProductionReadyBooth: active + fully-modelled but variantsConfirmed=false (T06..T25's real current state) is never production-ready", () => {
  const t06 = t04Fixture({ internalCode: "T06", id: "t06-uuid" }, { internalCode: "T06", variantsConfirmed: false, variants: t04ReadyVariants.map((v) => ({ ...v, id: `t06-${v.id}` })) });
  assert.equal(isProductionReadyBooth(t06), false);
});

test("isProductionReadyBooth: P86 (real canonical seed, no variants) is production-ready once active", () => {
  assert.equal(isProductionReadyBooth(p86Fixture()), true);
});

// =========================================================================================
// adaptCatalogItemToBoothType
// =========================================================================================

test("adaptCatalogItemToBoothType: P86 (full BoothType-shaped document) preserves parts/printSurfaces/pricingEntries/constructionParts verbatim — never a stub rewrite", () => {
  const adapted = adaptCatalogItemToBoothType(p86Fixture());
  assert.deepEqual(adapted.parts, p86RealDocument.parts);
  assert.deepEqual(adapted.printSurfaces, p86RealDocument.printSurfaces);
  assert.deepEqual(adapted.pricingEntries, p86RealDocument.pricingEntries);
  assert.deepEqual(adapted.constructionParts, p86RealDocument.constructionParts);
  assert.deepEqual(adapted.collisionObstacles, p86RealDocument.collisionObstacles);
});

test("adaptCatalogItemToBoothType: P86's id stays the legacy static 'koje-2x2' — the document's OWN id field wins, so old saved projects keep resolving", () => {
  const adapted = adaptCatalogItemToBoothType(p86Fixture());
  assert.equal(adapted.id, "koje-2x2");
  assert.equal(adapted.internalCode, "P86");
});

test("adaptCatalogItemToBoothType: T04 (minimal ComponentDefinition-shaped document) synthesizes ONLY structural scaffold fields — size/area are DERIVED from real widthMm/depthMm, never fabricated", () => {
  const adapted = adaptCatalogItemToBoothType(t04Fixture());
  assert.equal(adapted.internalCode, "T04");
  assert.equal(adapted.code, "T04");
  assert.equal(adapted.widthMm, 2000);
  assert.equal(adapted.depthMm, 2000);
  assert.equal(adapted.heightMm, 2500);
  assert.equal(adapted.size, "2 × 2 m");
  assert.equal(adapted.area, "4 m²");
  assert.equal(adapted.constructionParts.length, 0);
  assert.equal(adapted.collisionObstacles.length, 0);
});

test("adaptCatalogItemToBoothType: T04 has EXACTLY 3 variants (Roh – levý, Roh – pravý, Řada / přímý) — never a 4th", () => {
  const adapted = adaptCatalogItemToBoothType(t04Fixture());
  assert.equal(adapted.variants.length, 3);
  assert.deepEqual(adapted.variants.map((v) => v.name), ["Roh – levý", "Roh – pravý", "Řada / přímý"]);
});

test("adaptCatalogItemToBoothType: never fabricates a missing dimension — a booth without a real widthMm/depthMm gets null, never a guessed number", () => {
  const noDims = adaptCatalogItemToBoothType(fixture({ internalCode: "P87", document: { internalCode: "P87", displayName: "Kóje 2 × 3 m" } }));
  assert.equal(noDims.widthMm, null);
  assert.equal(noDims.depthMm, null);
  assert.equal(noDims.heightMm, null);
  assert.equal(noDims.size, "—");
  assert.equal(noDims.area, "—");
});

test("adaptCatalogItemToBoothType: photoAsset carries through for both shapes", () => {
  const t04Adapted = adaptCatalogItemToBoothType(t04Fixture());
  assert.deepEqual(t04Adapted.photoAsset, photoAsset);
});

// =========================================================================================
// selectGeneratorBooths — filter (kind=booth AND production-ready) THEN sort (natural code order)
// THEN adapt. Archived/needs_review/other-kind items are excluded by construction.
// =========================================================================================

test("selectGeneratorBooths: only kind=booth AND production-ready items appear — archived and needs_review are excluded, a furniture item is excluded even if 'ready'", () => {
  const items: readonly CatalogItemAdmin[] = [
    t04Fixture(),
    t04Fixture({ id: "t06-uuid", internalCode: "T06", lifecycleStatus: "needs_review" }, { internalCode: "T06" }),
    t04Fixture({ id: "archived-uuid", internalCode: "T09", lifecycleStatus: "archived" }, { internalCode: "T09" }),
    fixture({ kind: "furniture", internalCode: "M99", lifecycleStatus: "active", document: { internalCode: "M99", displayName: "Židle", widthMm: 1, depthMm: 1, showIn2D: true, footprint2D: { shape: "rectangle" }, reviewedAt: "2026-01-01T00:00:00.000Z", unit: "ks" } }),
  ];
  const selected = selectGeneratorBooths(items);
  assert.deepEqual(selected.map((b) => b.internalCode), ["T04"]);
});

test("selectGeneratorBooths: sorted by natural/numeric internalCode order — P86, P87, T04, T06, T09, T12 (never lexicographic, never DB return order)", () => {
  const codes = ["T12", "T04", "P87", "T09", "P86", "T06"];
  const items = codes.map((code) =>
    t04Fixture({ id: `${code.toLowerCase()}-uuid`, internalCode: code, displayName: `Booth ${code}` }, { internalCode: code, widthMm: 2000, depthMm: 2000 }),
  );
  // Deliberately shuffled input order — selectGeneratorBooths must never trust it.
  const shuffled = [items[3]!, items[0]!, items[5]!, items[1]!, items[4]!, items[2]!];
  const selected = selectGeneratorBooths(shuffled);
  assert.deepEqual(selected.map((b) => b.internalCode), ["P86", "P87", "T04", "T06", "T09", "T12"]);
});

test("selectGeneratorBooths: P86 stays selectable end to end through the full filter+sort+adapt pipeline", () => {
  const selected = selectGeneratorBooths([p86Fixture()]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0]!.id, "koje-2x2");
});

test("selectGeneratorBooths: empty input -> empty output, never throws", () => {
  assert.deepEqual(selectGeneratorBooths([]), []);
});

// =========================================================================================
// resolveGeneratorBooth / resolveGeneratorVariant — saved-project compatibility (section 23).
// Never guesses: returns undefined/"" when nothing matches.
// =========================================================================================

test("resolveGeneratorBooth: matches by id first (covers P86's legacy 'koje-2x2' identity)", () => {
  const booths = selectGeneratorBooths([p86Fixture()]);
  assert.equal(resolveGeneratorBooth(booths, "koje-2x2")?.internalCode, "P86");
});

test("resolveGeneratorBooth: falls back to internalCode match if id doesn't match", () => {
  const booths = selectGeneratorBooths([t04Fixture()]);
  assert.equal(resolveGeneratorBooth(booths, "T04")?.internalCode, "T04");
});

test("resolveGeneratorBooth: no match -> undefined, never a guess", () => {
  const booths = selectGeneratorBooths([p86Fixture()]);
  assert.equal(resolveGeneratorBooth(booths, "does-not-exist"), undefined);
});

test("resolveGeneratorBooth: empty saved id -> undefined (never matches an empty-string booth id by accident)", () => {
  const booths = selectGeneratorBooths([p86Fixture()]);
  assert.equal(resolveGeneratorBooth(booths, ""), undefined);
});

test("resolveGeneratorVariant: matches an existing variant id", () => {
  const booth = adaptCatalogItemToBoothType(t04Fixture());
  assert.equal(resolveGeneratorVariant(booth, "t04-corner-left"), "t04-corner-left");
});

test("resolveGeneratorVariant: a variant id that no longer exists on the resolved booth -> '' (explicit unresolved state, never a guessed substitute)", () => {
  const booth = adaptCatalogItemToBoothType(t04Fixture());
  assert.equal(resolveGeneratorVariant(booth, "some-old-variant-id-that-no-longer-exists"), "");
});

test("resolveGeneratorVariant: undefined booth (unresolved) -> '' safely, never throws", () => {
  assert.equal(resolveGeneratorVariant(undefined, "t04-corner-left"), "");
});

// =========================================================================================
// PHOTO / SIGNED URL — StoredAsset never carries a signed/resolved URL, only storageKey.
// =========================================================================================

test("adapted BoothType.photoAsset is a plain StoredAsset (storageKey only) — never a signed URL persisted on the object itself", () => {
  const adapted = adaptCatalogItemToBoothType(t04Fixture());
  assert.equal(adapted.photoAsset?.storageKey, photoAsset.storageKey);
  assert.equal("url" in (adapted.photoAsset ?? {}), false);
  assert.equal("signedUrl" in (adapted.photoAsset ?? {}), false);
});

// =========================================================================================
// SOURCE WIRING — BoothGenerator.tsx no longer reads the static list for its live picker.
// =========================================================================================

test("BoothGenerator.tsx no longer imports boothTypes from the static data/booths.ts", () => {
  const source = readFileSync(new URL("../components/BoothGenerator.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from "\.\.\/data\/booths"/u);
});

test("BoothGenerator.tsx sources its booth picker from selectGeneratorBooths (DB-backed), fetched via the existing RemoteApiCatalogItemsAdminRepository — no second/parallel booth data source", () => {
  const source = readFileSync(new URL("../components/BoothGenerator.tsx", import.meta.url), "utf8");
  assert.match(source, /selectGeneratorBooths\(catalogItems\)/u);
  assert.match(source, /catalogItemsAdminRepositoryRef\.current\.list\(\)/u);
});

test("BoothGenerator.tsx shows a visible loading/error/empty state for the booth picker — never a silent fallback to static demo data on failure", () => {
  const source = readFileSync(new URL("../components/BoothGenerator.tsx", import.meta.url), "utf8");
  assert.match(source, /Načítám typové stánky…/u);
  assert.match(source, /Typové stánky se nepodařilo načíst/u);
  assert.match(source, /Pro tento výběr nejsou dostupné žádné aktivní stánky\./u);
});

test("BoothGenerator.tsx's variant card thumbnail falls back variant.photoAsset -> parent booth.photoAsset -> placeholder, via the same useAssetUrl hook", () => {
  const source = readFileSync(new URL("../components/BoothGenerator.tsx", import.meta.url), "utf8");
  const match = source.match(/function VariantCardThumbnail\([\s\S]{0,700}?\n\}/u);
  assert.ok(match, "expected to find VariantCardThumbnail");
  assert.match(match![0], /variant\.photoAsset \?\? parentPhotoAsset/u);
  assert.match(match![0], /useAssetUrl\(/u);
});

test("BoothGenerator.tsx's selectedBooth lookup uses resolveGeneratorBooth (id-or-internalCode compatibility), not a plain .find", () => {
  const source = readFileSync(new URL("../components/BoothGenerator.tsx", import.meta.url), "utf8");
  assert.match(source, /const selectedBooth = resolveGeneratorBooth\(boothTypes, selectedBoothId\);/u);
});
