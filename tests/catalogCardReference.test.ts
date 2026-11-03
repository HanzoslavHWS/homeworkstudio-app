import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { StoredAsset } from "../domain/assets.ts";
import { applyCatalogItemEdit, computeReadiness, InvalidCatalogItemAdminCreateInputError, documentGalleryPhotoAssets, documentPhotoAsset, documentServiceTechnical, documentSourceAssets, parseCatalogItemAdminEdit, resolveRestoreStatus, type CatalogItemAdmin } from "../domain/catalogItemsAdmin.ts";
import { CatalogReadinessError } from "../domain/catalogReadiness.ts";
import { buildBatchCardEdit, changeBatchTarget, planBatchUpload } from "../domain/catalogBatchUpload.ts";
import { cardPurchaseListChoice, cardPurchasePrice, cardSaleListChoice, cardSalePrices, defaultCardVersion } from "../domain/catalogCardPrices.ts";
import { documentReferencesCode, isSystemGeneratorCode } from "../domain/catalogCodeChange.ts";
import { isSystemParameterName, mergeParameters, parameterProblem, parseRecommendedParameters, recommendedParameterKey, setParameterValue, splitParameters } from "../domain/catalogParameters.ts";
import type { PriceListVersion, PurchasePriceEntry, SalePriceEntry, VersionedPriceList } from "../domain/priceVersions.ts";
import { createCatalogItemAdmin, saveCatalogItemAdmin } from "../lib/db/catalogItemsAdmin.supabase.ts";
import { BUILT_IN_CATALOG_CATEGORIES, categoriesForGroup, categoryChangeIssue, classificationIssue, classificationTarget, derivedPriceCategory, findCategory, groupOfCard, parseCatalogCategoryInput } from "../domain/catalogClassification.ts";
import { componentCatalogItems, placeComponent } from "../data/components.ts";
import { createDefaultTechnicalRequirements, type TechnicalRequirements } from "../domain/project.ts";
import { legacyPricingCatalogItems, priceProjectLegacy } from "../domain/projectPricing.ts";
import { readCatalogItems } from "../lib/db/catalogPricing.supabase.ts";

// Reference card (M57 workflow): fixes found while filling the first card by hand — generator code
// vs. Lifecycle, batch upload with a photo gallery, and prices read from versioned price lists.

// ---------------------------------------------------------------------------------------------
// Minimal in-memory Supabase client (same shape as tests/catalogItemsAdmin.test.ts)
// ---------------------------------------------------------------------------------------------
type FakeRow = Record<string, unknown>;
function fakeClient(seed: Readonly<Record<string, readonly FakeRow[]>>) {
  const tables = new Map<string, FakeRow[]>(Object.entries(seed).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]));
  const table = (name: string) => { if (!tables.has(name)) tables.set(name, []); return tables.get(name)!; };
  function from(name: string) {
    let op: "select" | "update" | "insert" = "select";
    let filters: Array<[string, unknown]> = [];
    let payload: FakeRow | undefined;
    let single = false;
    const run = async () => {
      if (op === "insert") {
        const inserted = { created_at: "2026-10-23T00:00:00.000Z", updated_at: "2026-10-23T00:00:00.000Z", id: `fake-${table(name).length + 1}`, ...payload };
        table(name).push(inserted);
        return { data: single ? inserted : [inserted], error: null };
      }
      const matched = table(name).filter((row) => filters.every(([column, value]) => row[column] === value));
      if (op === "update") for (const row of matched) Object.assign(row, payload);
      return { data: single ? matched[0] ?? null : matched, error: null };
    };
    const builder = {
      select: () => builder,
      update: (patch: FakeRow) => { op = "update"; payload = patch; return builder; },
      insert: (row: FakeRow) => { op = "insert"; payload = row; return builder; },
      eq: (column: string, value: unknown) => { filters = [...filters, [column, value]]; return builder; },
      maybeSingle: () => { single = true; return run(); },
      single: () => { single = true; return run(); },
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => run().then(resolve, reject),
    };
    return builder;
  }
  return { from, tables };
}

const asset = (id: string, category: StoredAsset["category"], extension: string): StoredAsset => ({
  id,
  storageKey: `catalog/furniture/zkusebni/${category === "catalog-photo" ? "photos" : category === "catalog-model" ? "models" : "source"}/${id}.${extension}`,
  originalFileName: `${id}.${extension}`,
  mimeType: extension === "glb" ? "model/gltf-binary" : extension === "pdf" ? "application/pdf" : extension === "png" ? "image/png" : extension === "jpg" ? "image/jpeg" : "application/octet-stream",
  size: 1000,
  createdAt: "2026-10-23T00:00:00.000Z",
  category,
});

/** A furniture card created in the admin: the generator code lives ONLY in the internal_code column, never in the document. */
const ADMIN_DOCUMENT = {
  displayName: "Židle čalouněná černá",
  name: "Židle čalouněná černá",
  category: "Nábytek",
  catalogItemKind: "furniture",
  unit: "ks",
  widthMm: 530,
  depthMm: 600,
  heightMm: 820,
  showIn2D: true,
  showIn3D: true,
  footprint2D: { shape: "rectangle" },
  modelAsset: asset("glb-1", "catalog-model", "glb"),
};

function adminRow(overrides: FakeRow = {}): FakeRow {
  return {
    id: "zkusebni-card",
    internal_code: "ZKUS-M57",
    abf_code: "ZKUS-M57",
    item_type: "PRODUCT",
    kind: "furniture",
    lifecycle_status: "needs_review",
    display_name: "Židle čalouněná černá",
    official_name: null,
    category: "Nábytek",
    unit: "ks",
    unit_code: "ks",
    document: ADMIN_DOCUMENT,
    created_at: "2026-10-23T00:00:00.000Z",
    updated_at: "2026-10-23T08:00:00.000000+00:00",
    ...overrides,
  };
}

function adminItem(internalCode: string | null, document: FakeRow = ADMIN_DOCUMENT): CatalogItemAdmin {
  return { id: "zkusebni-card", internalCode, abfCode: "ZKUS-M57", kind: "furniture", lifecycleStatus: "needs_review", displayName: "Židle", category: "Nábytek", unit: "ks", document } as unknown as CatalogItemAdmin;
}

// ---------------------------------------------------------------------------------------------
// Generator code vs. Lifecycle
// ---------------------------------------------------------------------------------------------

test("kód shodný s ABF: karta s kódem jen ve sloupci nehlásí „Chybí interní kód“, jen čeká na kontrolu", () => {
  const readiness = computeReadiness(adminItem("ZKUS-M57"));
  assert.equal(readiness.issues.includes("missing_internal_code"), false);
  assert.deepEqual(readiness.issues, ["requires_review"]);
});

test("vlastní odlišný generátorový kód funguje stejně (identita = sloupec, ABF kód zůstává zvlášť)", () => {
  const readiness = computeReadiness({ ...adminItem("INT-ZIDLE-01"), abfCode: "ZKUS-M57" } as CatalogItemAdmin);
  assert.deepEqual(readiness.issues, ["requires_review"]);
});

test("karta bez generátorového kódu dál hlásí „Chybí interní kód“ (pravidlo se neobchází)", () => {
  assert.equal(computeReadiness(adminItem(null)).issues.includes("missing_internal_code"), true);
});

test("starší importovaná karta s kódem jen v dokumentu zůstává v pořádku", () => {
  assert.equal(computeReadiness(adminItem(null, { ...ADMIN_DOCUMENT, internalCode: "F01" })).issues.includes("missing_internal_code"), false);
});

test("aktivace přes server: bez kontroly se odmítne jen kvůli kontrole, po kontrole projde — žádný falešný „chybí kód“", async () => {
  const client = fakeClient({ catalog_items: [adminRow()] });
  await assert.rejects(
    () => saveCatalogItemAdmin(client as never, "zkusebni-card", { lifecycleStatus: "active" }, "2026-10-23T08:00:00.000000+00:00"),
    (error) => error instanceof CatalogReadinessError && error.issues.includes("requires_review") && !error.issues.includes("missing_internal_code"),
  );
  const reviewed = await saveCatalogItemAdmin(client as never, "zkusebni-card", { markReviewed: true }, "2026-10-23T08:00:00.000000+00:00");
  const activated = await saveCatalogItemAdmin(client as never, "zkusebni-card", { lifecycleStatus: "active" }, reviewed.updatedAt);
  assert.equal(activated.lifecycleStatus, "active");
  assert.equal(activated.internalCode, "ZKUS-M57");
  assert.equal((activated.document as FakeRow).internalCode, undefined, "kód se do dokumentu nekopíruje — žádný druhý interní kód");
});

test("obnovení z archivu a použitelnost v generátoru čtou kód ze sloupce", async () => {
  const archived = { ...adminItem("ZKUS-M57", { ...ADMIN_DOCUMENT, reviewedAt: "2026-10-23T09:00:00.000Z", archivedFromStatus: "active" }) };
  assert.equal(resolveRestoreStatus(archived), "active");
  const client = fakeClient({ catalog_items: [adminRow({ lifecycle_status: "active", document: { ...ADMIN_DOCUMENT, reviewedAt: "2026-10-23T09:00:00.000Z" } })] });
  const [summary] = await readCatalogItems(client as never);
  assert.equal(summary?.generatorEligible, true);
});

// ---------------------------------------------------------------------------------------------
// Batch upload
// ---------------------------------------------------------------------------------------------

const BATCH = [
  { name: "zidle-predni.JPG", size: 400_000 },
  { name: "zidle-bok.png", size: 300_000 },
  { name: "zidle.glb", size: 2_000_000 },
  { name: "zidle.skp", size: 5_000_000 },
  { name: "zidle.dwg", size: 800_000 },
  { name: "zidle.dxf", size: 700_000 },
  { name: "technicky-list.pdf", size: 900_000 },
  { name: "poznamky.txt", size: 100 },
];

test("hromadný výběr: návrh zařazení podle přípony, neplatný soubor se nenahraje", () => {
  const rows = planBatchUpload(BATCH, { hasMainPhoto: false, hasModel: false, modelAllowed: true, cadAllowed: true, documentsAllowed: true });
  assert.deepEqual(rows.map((row) => row.target), ["photo_main", "photo_gallery", "model_active", "source_sketchup", "source_dwg", "source_dxf", "source_pdf", "skip"]);
  assert.match(rows[7]!.error ?? "", /Nepodporovaný typ souboru \(\.txt\)/u);
  assert.deepEqual(rows[7]!.options, []);
  assert.equal(rows[3]!.options.includes("model_active"), false, "SKP se nikdy nezamění za aktivní GLB");
});

test("karta už má hlavní fotku a GLB: nic se samo nepřepíše", () => {
  const rows = planBatchUpload(BATCH.slice(0, 3), { hasMainPhoto: true, hasModel: true, modelAllowed: true, cadAllowed: true, documentsAllowed: true });
  assert.deepEqual(rows.map((row) => row.target), ["photo_gallery", "photo_gallery", "skip"]);
  assert.match(rows[2]!.note ?? "", /už má aktivní 3D model/u);
});

test("více GLB: žádný se sám nestane aktivním; volba jednoho ruší předchozí volbu (poslední nevyhrává potichu)", () => {
  let rows = planBatchUpload([{ name: "a.glb", size: 10 }, { name: "b.glb", size: 10 }], { hasMainPhoto: false, hasModel: false, modelAllowed: true, cadAllowed: true, documentsAllowed: true });
  assert.deepEqual(rows.map((row) => row.target), ["skip", "skip"]);
  rows = changeBatchTarget(rows, 0, "model_active");
  rows = changeBatchTarget(rows, 1, "model_active");
  assert.deepEqual(rows.map((row) => row.target), ["skip", "model_active"]);
  rows = changeBatchTarget(planBatchUpload(BATCH.slice(0, 2), { hasMainPhoto: false, hasModel: false, modelAllowed: true, cadAllowed: true, documentsAllowed: true }), 1, "photo_main");
  assert.deepEqual(rows.map((row) => row.target), ["photo_gallery", "photo_main"], "vždy jen jedna hlavní fotografie");
});

test("prázdný nebo příliš velký soubor se označí chybou předem (server dál validuje sám)", () => {
  const rows = planBatchUpload([{ name: "prazdna.jpg", size: 0 }, { name: "obri.png", size: 16_000_000 }], { hasMainPhoto: false, hasModel: false, modelAllowed: true, cadAllowed: true, documentsAllowed: true });
  assert.equal(rows[0]!.error, "Soubor je prázdný.");
  assert.match(rows[1]!.error ?? "", /limit 15 MB/u);
  assert.deepEqual(rows.map((row) => row.target), ["skip", "skip"]);
});

test("jedna úprava karty: nová hlavní fotka přesune dosavadní do galerie, podklady se přidají, nic se neodebere", () => {
  const oldMain = asset("old-main", "catalog-photo", "jpg");
  const edit = buildBatchCardEdit([
    { target: "photo_main", asset: asset("new-main", "catalog-photo", "jpg") },
    { target: "photo_gallery", asset: asset("side", "catalog-photo", "png") },
    { target: "source_dwg", asset: asset("dwg", "catalog-source", "dwg") },
    { target: "source_pdf", asset: asset("pdf", "catalog-source", "pdf") },
  ], oldMain);
  const existingSource = { id: "skp-1", kind: "sketchup", asset: asset("skp", "catalog-source", "skp") };
  const parsed = parseCatalogItemAdminEdit(JSON.parse(JSON.stringify(edit)));
  const next = applyCatalogItemEdit({ ...ADMIN_DOCUMENT, photoAsset: oldMain, sourceAssets: [existingSource] }, parsed);
  assert.equal(documentPhotoAsset(next)?.id, "new-main");
  assert.deepEqual(documentGalleryPhotoAssets(next).map((photo) => photo.id), ["old-main", "side"]);
  assert.deepEqual(documentSourceAssets(next).map((entry) => entry.kind), ["sketchup", "dwg", "pdf"]);
  assert.equal((next.modelAsset as StoredAsset).id, "glb-1", "GLB beze změny, když ho uživatel výslovně nenahradil");
});

test("galerie: nastavit jako hlavní (předchozí hlavní do galerie) a odebrat jen referenci", () => {
  const main = asset("main", "catalog-photo", "jpg");
  const second = asset("second", "catalog-photo", "jpg");
  const promoted = applyCatalogItemEdit({ ...ADMIN_DOCUMENT, photoAsset: main, galleryPhotoAssets: [second] }, parseCatalogItemAdminEdit({ promoteGalleryPhotoAssetId: "second" }));
  assert.equal(documentPhotoAsset(promoted)?.id, "second");
  assert.deepEqual(documentGalleryPhotoAssets(promoted).map((photo) => photo.id), ["main"]);
  const removed = applyCatalogItemEdit(promoted, parseCatalogItemAdminEdit({ removeGalleryPhotoAssetId: "main" }));
  assert.equal(documentGalleryPhotoAssets(removed).length, 0);
  assert.equal(documentPhotoAsset(removed)?.id, "second");
});

test("server přijme do galerie a podkladů jen soubory správné kategorie s platným klíčem", () => {
  const foreign = { ...asset("x", "catalog-photo", "jpg"), storageKey: "../../etc/passwd" };
  const wrongCategory = asset("y", "catalog-source", "pdf");
  const edit = parseCatalogItemAdminEdit({ addGalleryPhotoAssets: [foreign, wrongCategory], addSourceAssets: [{ kind: "pdf", asset: asset("z", "catalog-photo", "jpg") }, { kind: "exe", asset: wrongCategory }] });
  assert.equal(edit.addGalleryPhotoAssets, undefined);
  assert.equal(edit.addSourceAssets, undefined);
});

// ---------------------------------------------------------------------------------------------
// Prices on the card — read from the chosen version, never stored on the card
// ---------------------------------------------------------------------------------------------

function version(overrides: Partial<PriceListVersion>): PriceListVersion {
  return { id: "v1", priceListId: "base", versionNo: 1, revision: 1, status: "published", eurRate: 24.17, eurRoundingMode: "ceil", eurRoundingStep: 1, ...overrides };
}
const saleEntry = (overrides: Partial<SalePriceEntry>): SalePriceEntry => ({ id: "e1", versionId: "v1", catalogItemId: "card", priceMode: "fixed", saleCzk: 516, eurMode: "derived", saleEurWorld: 30, ...overrides });

test("tři prodejní ceny z vybrané verze: CZK, EUR SK přepočtem kurzem verze (nahoru), EUR WORLD samostatně", () => {
  const prices = cardSalePrices(version({}), [saleEntry({})], "card");
  assert.deepEqual(prices.czk, { status: "priced", amount: 516 });
  assert.equal(prices.eurSk.amount, 22, "516 / 24,17 = 21,35 → 22");
  assert.equal(prices.eurSk.source, "derived");
  assert.equal(prices.eurSk.rate, 24.17);
  assert.deepEqual(prices.eurWorld, { status: "priced", amount: 30 });
  const otherRate = cardSalePrices(version({ eurRate: 25 }), [saleEntry({})], "card");
  assert.equal(otherRate.eurSk.amount, 21, "kurz bere verze, nikdy pevná konstanta");
  assert.equal(otherRate.eurWorld.amount, 30, "EUR WORLD na kurzu nezávisí");
});

test("ruční výjimka EUR SK z ceníku se ukáže jako ruční včetně hodnoty přepočtu", () => {
  const prices = cardSalePrices(version({}), [saleEntry({ eurMode: "manual", saleEur: 25 })], "card");
  assert.equal(prices.eurSk.amount, 25);
  assert.equal(prices.eurSk.source, "manual");
  assert.equal(prices.eurSk.derivedAmount, 22);
});

test("chybějící cena = „K nacenění“ (missing), nikdy 0; individuální / v ceně zůstávají odlišené", () => {
  const none = cardSalePrices(version({}), [], "card");
  assert.equal(none.hasEntry, false);
  assert.deepEqual([none.czk.status, none.eurSk.status, none.eurWorld.status], ["missing", "missing", "missing"]);
  assert.equal(none.czk.amount, undefined);
  const noWorld = cardSalePrices(version({}), [saleEntry({ saleEurWorld: undefined })], "card");
  assert.equal(noWorld.eurWorld.status, "missing");
  assert.equal(cardSalePrices(version({}), [saleEntry({ priceMode: "individual", saleCzk: undefined })], "card").czk.status, "individual");
  assert.equal(cardSalePrices(version({}), [saleEntry({ priceMode: "included", saleCzk: undefined })], "card").eurWorld.status, "included");
  assert.equal(cardSalePrices(version({ id: "v2" }), [saleEntry({})], "card").hasEntry, false, "řádek jiné verze se nepoužije");
});

test("nákupní cena: jeden společný nákupní ceník, vlastní verze; chybějící = K nacenění", () => {
  const purchaseVersion = version({ id: "p3", priceListId: "purchase", versionNo: 3 });
  const rows: PurchasePriceEntry[] = [
    { id: "p", versionId: "p3", catalogItemId: "card", purchaseCzk: 310 },
    { id: "pv", versionId: "p3", catalogItemId: "card", variantId: "red", purchaseCzk: 330 },
  ];
  assert.deepEqual(cardPurchasePrice(purchaseVersion, rows, "card"), { status: "priced", amount: 310, variantRowCount: 1 });
  assert.deepEqual(cardPurchasePrice(purchaseVersion, rows, "other"), { status: "missing", variantRowCount: 0 });
});

test("výchozí verze karty: nejnovější publikovaná (ne novější koncept); výběr prodejní a nákupní verze je nezávislý", () => {
  const versions = [version({ id: "a", versionNo: 1 }), version({ id: "b", versionNo: 2 }), version({ id: "c", versionNo: 3, status: "draft" }), version({ id: "p1", priceListId: "purchase", versionNo: 7 })];
  assert.equal(defaultCardVersion(versions, "base")?.id, "b");
  assert.equal(defaultCardVersion(versions, "purchase")?.id, "p1");
  assert.equal(defaultCardVersion([version({ id: "d", status: "draft" })], "base")?.id, "d");
});

// ---------------------------------------------------------------------------------------------
// Safety: the card only reads; purchase prices never reach customer outputs
// ---------------------------------------------------------------------------------------------

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("sekce Ceny na kartě jen čte: žádné ukládání ceníku, přiřazení veletrhu ani úprava karty", () => {
  const source = read("components/workflow/CatalogCardPrices.tsx");
  for (const forbidden of ["saveRows", ".assign(", "createVersion", "publishVersion", "archiveVersion", "setPriceCategory", "onSave", "localStorage"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

function sourceFiles(directory: string): string[] {
  const root = new URL(`../${directory}`, import.meta.url);
  return readdirSync(root).flatMap((name) => {
    const path = join(root.pathname.replace(/^\/([A-Za-z]:)/u, "$1"), name);
    if (statSync(path).isDirectory()) return sourceFiles(`${directory}/${name}`);
    return /\.(ts|tsx)$/u.test(name) ? [`${directory}/${name}`] : [];
  });
}

test("nákupní ceny se nedostanou do zákaznického katalogu, kalkulace, PDF ani veřejného API katalogu", () => {
  const customerFacing = [
    ...sourceFiles("app/api/customer-catalog"),
    ...sourceFiles("app/api/catalog"),
    "domain/customerCatalog.ts",
    "domain/calculationExport.ts",
    "domain/projectPricing.ts",
    "components/workflow/WorkflowSteps.tsx",
  ];
  assert.ok(sourceFiles("app/api/customer-catalog").length > 0 && sourceFiles("app/api/catalog").length > 0, "kontrola musí soubory skutečně najít");
  for (const file of customerFacing) {
    const source = read(file);
    for (const marker of ["purchase-prices", "purchaseCzk", "PurchasePriceEntry", "listPurchaseEntries", "CatalogCardPrices"]) {
      assert.equal(source.includes(marker), false, `${file}: ${marker}`);
    }
  }
  const importers = [...sourceFiles("components"), ...sourceFiles("app")].filter((file) => read(file).includes("from \"./CatalogCardPrices\""));
  assert.deepEqual(importers, ["components/workflow/ComponentAdminPage.tsx"], "sekce s nákupní cenou je jen v administraci katalogu");
});

// ---------------------------------------------------------------------------------------------
// Generator code field: card with ABF code vs. internal component without one
// ---------------------------------------------------------------------------------------------

/** Internal construction post: no ABF code, own generator code only. */
function postRow(overrides: FakeRow = {}): FakeRow {
  return adminRow({
    id: "zkusebni-sloupek",
    internal_code: null,
    abf_code: null,
    item_type: "INTERNAL_COMPONENT",
    kind: "booth_component",
    display_name: "ZKUŠEBNÍ sloupek",
    document: { displayName: "ZKUŠEBNÍ sloupek", name: "ZKUŠEBNÍ sloupek", category: "Sloupky", catalogItemKind: "booth_component", modelAsset: asset("post-glb", "catalog-model", "glb"), sourceAssets: [{ id: "post-skp", kind: "sketchup", asset: asset("post-skp", "catalog-source", "skp") }] },
    ...overrides,
  });
}

test("interní komponenta bez ABF kódu: doplní vlastní generátorový kód a projde aktivací — žádný fiktivní ABF kód", async () => {
  const client = fakeClient({ catalog_items: [postRow(), adminRow()], projects: [] });
  const withCode = await saveCatalogItemAdmin(client as never, "zkusebni-sloupek", parseCatalogItemAdminEdit({ fillInternalCode: "ZKUS-SLOUPEK-2500" }), "2026-10-23T08:00:00.000000+00:00");
  assert.equal(withCode.internalCode, "ZKUS-SLOUPEK-2500");
  assert.equal(withCode.abfCode ?? null, null);
  const active = await saveCatalogItemAdmin(client as never, "zkusebni-sloupek", { lifecycleStatus: "active" }, withCode.updatedAt);
  assert.equal(active.lifecycleStatus, "active");
});

test("změna existujícího kódu: nepoužívaný kód lze výslovně změnit (ABF zůstává), unikátnost se hlídá", async () => {
  const client = fakeClient({ catalog_items: [adminRow(), postRow({ internal_code: "ZKUS-SLOUPEK-2500" })], projects: [] });
  const changed = await saveCatalogItemAdmin(client as never, "zkusebni-card", parseCatalogItemAdminEdit({ changeInternalCode: { from: "ZKUS-M57", to: "ZKUS-ZIDLE-01" } }), "2026-10-23T08:00:00.000000+00:00");
  assert.equal(changed.internalCode, "ZKUS-ZIDLE-01");
  assert.equal(changed.abfCode, "ZKUS-M57", "ABF kód se změnou generátorového kódu nemění");
  await assert.rejects(
    () => saveCatalogItemAdmin(client as never, "zkusebni-card", parseCatalogItemAdminEdit({ changeInternalCode: { from: "ZKUS-ZIDLE-01", to: "zkus-sloupek-2500" } }), changed.updatedAt),
    /už je v katalogu použitý/u,
  );
});

test("změna kódu je zablokovaná, když ho používá uložený projekt, aplikace (M57, L02 …) nebo se mezitím změnil", async () => {
  const project = { id: "p1", document: { id: "p1", name: "ZKUŠEBNÍ projekt", sceneObjects: [{ id: "o1", definitionId: "ZKUS-M57" }] } };
  const used = fakeClient({ catalog_items: [adminRow()], projects: [project] });
  await assert.rejects(
    () => saveCatalogItemAdmin(used as never, "zkusebni-card", parseCatalogItemAdminEdit({ changeInternalCode: { from: "ZKUS-M57", to: "ZKUS-NOVY" } }), "2026-10-23T08:00:00.000000+00:00"),
    /používají uložené projekty \(ZKUŠEBNÍ projekt\)/u,
  );
  assert.equal(used.tables.get("catalog_items")![0]!.internal_code, "ZKUS-M57", "nic se nezapsalo");
  const system = fakeClient({ catalog_items: [adminRow({ internal_code: "M57", abf_code: "M57" })], projects: [] });
  await assert.rejects(
    () => saveCatalogItemAdmin(system as never, "zkusebni-card", parseCatalogItemAdminEdit({ changeInternalCode: { from: "M57", to: "M57-NOVA" } }), "2026-10-23T08:00:00.000000+00:00"),
    /používá aplikace/u,
  );
  const stale = fakeClient({ catalog_items: [adminRow()], projects: [] });
  await assert.rejects(
    () => saveCatalogItemAdmin(stale as never, "zkusebni-card", parseCatalogItemAdminEdit({ changeInternalCode: { from: "JINY-KOD", to: "ZKUS-NOVY" } }), "2026-10-23T08:00:00.000000+00:00"),
    /mezitím změnil/u,
  );
});

test("nový kód nesmí být ABF kódem jiné karty (kontrola křížových kolizí platí i pro změnu)", async () => {
  const client = fakeClient({ catalog_items: [adminRow(), postRow({ internal_code: "ZKUS-SLOUPEK-2500", abf_code: "ZKUS-X1" })], projects: [] });
  await assert.rejects(
    () => saveCatalogItemAdmin(client as never, "zkusebni-card", parseCatalogItemAdminEdit({ changeInternalCode: { from: "ZKUS-M57", to: "ZKUS-X1" } }), "2026-10-23T08:00:00.000000+00:00"),
    /ABF kódem jiné položky/u,
  );
});

test("hledání kódu v projektu je přesné (celá hodnota, bez ohledu na velikost písmen) a systémové kódy jsou chráněné", () => {
  assert.equal(documentReferencesCode({ a: [{ b: "zkus-m57" }] }, "ZKUS-M57"), true);
  assert.equal(documentReferencesCode({ a: "ZKUS-M570", note: "obsahuje ZKUS-M57 v textu" }, "ZKUS-M57"), false);
  for (const code of ["M57", "L02", "U05", "P86", "T04"]) assert.equal(isSystemGeneratorCode(code), true, code);
  assert.equal(isSystemGeneratorCode("ZKUS-SLOUPEK-2500"), false);
});

// ---------------------------------------------------------------------------------------------
// Which sale price list a card uses
// ---------------------------------------------------------------------------------------------

const lists: VersionedPriceList[] = [
  { id: "e2e", code: "E2E-AUTOTEST", name: "Automatický test", kind: "base", isActive: false },
  { id: "base", code: "ZAKLADNI", name: "Základní ceník", kind: "base", isActive: true },
  { id: "el", code: "ELEKTRINA", name: "Ceník elektřiny", kind: "electricity", isActive: true },
  { id: "buy", code: "NAKUP", name: "Nákupní ceník", kind: "purchase", isActive: true },
];

test("M57 i interní sloupek (standardní kategorie) → pevně základní prodejní ceník, nikdy ceník elektřiny ani neaktivní test", () => {
  const choice = cardSaleListChoice("standard", lists);
  assert.equal(choice.kind, "base");
  assert.deepEqual(choice.lists.map((list) => list.id), ["base"]);
  assert.equal(choice.locked, true);
});

test("L02 (kategorie elektřina) → ceník elektřiny; více ceníků elektřiny = výběr jen mezi nimi", () => {
  assert.deepEqual(cardSaleListChoice("electricity", lists).lists.map((list) => list.id), ["el"]);
  const two = cardSaleListChoice("electricity", [...lists, { id: "el2", code: "ELEKTRINA-BRNO", name: "Elektřina Brno", kind: "electricity", isActive: true }]);
  assert.equal(two.locked, false);
  assert.deepEqual(two.lists.map((list) => list.id), ["el", "el2"]);
});

test("chybějící klasifikace nebo ceník daného druhu = srozumitelné upozornění, žádný tichý náhradní ceník", () => {
  const unknown = cardSaleListChoice(undefined, lists);
  assert.deepEqual(unknown.lists, []);
  assert.match(unknown.warning ?? "", /cenová kategorie/u);
  const noElectricity = cardSaleListChoice("electricity", lists.filter((list) => list.kind !== "electricity"));
  assert.deepEqual(noElectricity.lists, []);
  assert.match(noElectricity.warning ?? "", /ceník elektřiny/u);
});

test("nákupní cena: pevně společný nákupní ceník (prodejní ceníky se nenabízejí)", () => {
  const choice = cardPurchaseListChoice(lists);
  assert.deepEqual(choice.lists.map((list) => list.id), ["buy"]);
  assert.equal(choice.locked, true);
});

test("sekce Ceny: zdroj ceníku z cenové kategorie, verze veletrhu jen jako náhled", () => {
  const source = read("components/workflow/CatalogCardPrices.tsx");
  assert.match(source, /cardSaleListChoice\(priceCategory, sale\.lists\)/u);
  assert.match(source, /saleApi\.resolve\(\{ priceTrack, eventId, items: \[\{ catalogItemId \}\] \}\)/u, "cena podle veletrhu = schválený resolver V1-DATA-05");
  assert.match(source, /🔒/u);
});

// ---------------------------------------------------------------------------------------------
// Technical services: service type → price category (L02), card mode by 2D/3D, kept attachments
// ---------------------------------------------------------------------------------------------

test("Druh → Kategorie: platné a neplatné kombinace (stejná pravidla pro formulář i server)", () => {
  const reg = BUILT_IN_CATALOG_CATEGORIES;
  const issue = (itemType: string, kind: string, category: string) => classificationIssue(reg, { itemType: itemType as never, kind: kind as never, category });
  assert.equal(issue("PRODUCT", "furniture", "chairs"), undefined, "Produkt + Židle");
  assert.equal(issue("SERVICE", "service", "service-electricity"), undefined, "Technická služba + Elektřina");
  assert.equal(issue("INTERNAL_COMPONENT", "booth_component", "Sloupky"), undefined, "Interní komponenta + Sloupky");
  assert.equal(issue("SERVICE", "graphics_service", "graphics-fascia"), undefined, "Grafika + Límec");
  assert.equal(issue("SERVICE", "technical_point", "point-electricity"), undefined, "Technický bod + Elektro bod");
  assert.match(issue("SERVICE", "service", "chairs") ?? "", /patří k druhu „Produkt“/u, "Technická služba + Židle");
  assert.match(issue("PRODUCT", "furniture", "service-electricity") ?? "", /patří k druhu „Technická služba“/u, "Produkt + Elektřina");
  assert.match(issue("SERVICE", "technical_point", "chairs") ?? "", /patří k druhu „Produkt“/u, "Technický bod + Židle");
  assert.match(issue("PRODUCT", "furniture", "point-electricity") ?? "", /Technický bod/u, "Produkt + Elektro bod");
  assert.match(issue("SERVICE", "technical_point", "graphics-fascia") ?? "", /Grafika/u, "Technický bod + Límec");
  assert.match(issue("SERVICE", "service", "") ?? "", /Vyberte kategorii/u, "bez kategorie nelze");
  assert.equal(issue("BOOTH", "booth", "Typovky"), undefined, "typové stánky mají vlastní pravidla");
  assert.equal(issue("KIT", "other", "Ostatní"), undefined, "komplety mají vlastní pravidla");
  assert.equal(classificationIssue(reg, { itemType: "SERVICE", kind: "service", category: "services" }, { requireActive: true })?.includes("neaktivní"), true, "historickou obecnou kategorii nelze nově vybrat");
});

test("nabídka kategorií je jen pro zvolený druh; cenová kategorie se odvozuje z kategorie", () => {
  const reg = BUILT_IN_CATALOG_CATEGORIES;
  const service = categoriesForGroup(reg, "technical_service").map((category) => category.name);
  assert.deepEqual(service, ["Elektřina", "Internet", "Úklid", "Voda", "Odpad", "Ostatní technické služby"]);
  assert.equal(categoriesForGroup(reg, "product").some((category) => category.id === "service-electricity"), false);
  assert.deepEqual(categoriesForGroup(reg, "graphics").map((category) => category.name), ["Límec (bm)", "Celopolep (m²)", "Polep pultu (m²)", "Ostatní grafika"]);
  const price = (id: string) => derivedPriceCategory(findCategory(reg, id)!);
  assert.equal(price("service-electricity"), "electricity");
  assert.equal(price("service-internet"), "standard");
  assert.equal(price("chairs"), "standard");
  assert.equal(price("graphics-fascia"), "standard");
  assert.equal(price("Sloupky"), "standard");
  assert.equal(price("point-electricity"), undefined, "technický bod se samostatně neúčtuje");
  assert.deepEqual(classificationTarget(findCategory(reg, "chairs")!, "other"), { itemType: "PRODUCT", kind: "furniture" });
  assert.deepEqual(classificationTarget(findCategory(reg, "Nábytek")!, "other"), { itemType: "PRODUCT", kind: "other" }, "povolený druh karty se nemění");
});

function serviceRow(overrides: FakeRow = {}): FakeRow {
  return adminRow({
    id: "zkusebni-l02",
    internal_code: "ZKUS-L02",
    abf_code: "ZKUS-L02",
    item_type: "SERVICE",
    kind: "service",
    category: "chairs",
    price_category: "standard",
    display_name: "ZKUŠEBNÍ elektřina 2 kW",
    document: { displayName: "ZKUŠEBNÍ elektřina 2 kW", name: "ZKUŠEBNÍ elektřina 2 kW", category: "chairs", catalogItemKind: "service", unit: "ks", serviceTechnical: { powerKw: 2 } },
    ...overrides,
  });
}

test("L02 s historickou kombinací (Technická služba + Židle): běžné uložení ji nemění; výběr kategorie Elektřina nastaví electricity a technickou kategorii", async () => {
  const client = fakeClient({ catalog_items: [serviceRow()], projects: [] });
  const renamed = await saveCatalogItemAdmin(client as never, "zkusebni-l02", { displayName: "ZKUŠEBNÍ elektřina 2 kW (upraveno)" }, "2026-10-23T08:00:00.000000+00:00");
  assert.equal(renamed.category, "chairs", "historická kategorie se sama nepřepíše");
  assert.equal(client.tables.get("catalog_items")![0]!.price_category, "standard");
  const electricity = await saveCatalogItemAdmin(client as never, "zkusebni-l02", parseCatalogItemAdminEdit({ category: "service-electricity" }), renamed.updatedAt);
  assert.equal(electricity.category, "service-electricity");
  assert.equal(electricity.priceCategory, "electricity");
  assert.deepEqual(electricity.document.serviceTechnical, { powerKw: 2, serviceCategory: "electricity" }, "výkon zůstává, technická kategorie se odvodí");
  assert.equal(electricity.id, "zkusebni-l02");
  const cleaning = await saveCatalogItemAdmin(client as never, "zkusebni-l02", parseCatalogItemAdminEdit({ category: "service-cleaning" }), electricity.updatedAt);
  assert.equal(cleaning.priceCategory, "standard");
});

test("server odmítne neplatnou kombinaci i při přímém volání API a nic nezapíše", async () => {
  const client = fakeClient({ catalog_items: [serviceRow({ category: "service-electricity", document: { displayName: "x", category: "service-electricity", catalogItemKind: "service" } })], projects: [] });
  await assert.rejects(() => saveCatalogItemAdmin(client as never, "zkusebni-l02", parseCatalogItemAdminEdit({ category: "chairs" }), "2026-10-23T08:00:00.000000+00:00"), /patří k druhu „Produkt“/u);
  await assert.rejects(() => saveCatalogItemAdmin(client as never, "zkusebni-l02", parseCatalogItemAdminEdit({ itemType: "PRODUCT", kind: "furniture" }), "2026-10-23T08:00:00.000000+00:00"), /patří k druhu „Technická služba“/u, "Produkt + Elektřina");
  await assert.rejects(() => saveCatalogItemAdmin(client as never, "zkusebni-l02", parseCatalogItemAdminEdit({ kind: "technical_point" }), "2026-10-23T08:00:00.000000+00:00"), /Technická služba/u, "změna druhu zneplatní původní kategorii");
  assert.equal(client.tables.get("catalog_items")![0]!.category, "service-electricity");
  assert.equal(client.tables.get("catalog_items")![0]!.kind, "service");
});

test("L02 založená jako technický bod: ruční přeřazení na Technická služba + Elektřina zachová UUID, kód i ostatní údaje", async () => {
  const pointL02 = serviceRow({ kind: "technical_point", category: "chairs", document: { displayName: "ZKUŠEBNÍ elektřina 2 kW", name: "ZKUŠEBNÍ elektřina 2 kW", category: "chairs", catalogItemKind: "technical_point", unit: "ks", note: "ruční poznámka" } });
  const client = fakeClient({ catalog_items: [pointL02], projects: [] });
  const saved = await saveCatalogItemAdmin(client as never, "zkusebni-l02", parseCatalogItemAdminEdit({ kind: "service", category: "service-electricity" }), "2026-10-23T08:00:00.000000+00:00");
  assert.equal(saved.kind, "service");
  assert.equal(saved.priceCategory, "electricity");
  assert.equal(saved.internalCode, "ZKUS-L02");
  assert.equal((saved.document as FakeRow).note, "ruční poznámka");
});

test("technický bod: jen technické kategorie bodu, bez cenové kategorie (neúčtuje se)", async () => {
  const client = fakeClient({ catalog_items: [serviceRow({ id: "zkusebni-bod", kind: "technical_point", category: null, price_category: "standard", document: { displayName: "Elektro bod", catalogItemKind: "technical_point" } })], projects: [] });
  const saved = await saveCatalogItemAdmin(client as never, "zkusebni-bod", parseCatalogItemAdminEdit({ category: "point-electricity" }), "2026-10-23T08:00:00.000000+00:00");
  assert.equal(client.tables.get("catalog_items")![0]!.price_category, "standard", "bod nedostane ceník elektřiny");
  assert.equal((saved.document.serviceTechnical as { serviceCategory?: string }).serviceCategory, "electricity", "budoucí vazba na rastry zůstává");
  await assert.rejects(() => saveCatalogItemAdmin(client as never, "zkusebni-bod", parseCatalogItemAdminEdit({ category: "service-electricity" }), saved.updatedAt), /Technická služba/u);
});

test("založení: interní sloupek bez ABF kódu v kategorii Sloupky projde; Technická služba + Židle se nezaloží", async () => {
  const client = fakeClient({ catalog_items: [], projects: [] });
  const post = await createCatalogItemAdmin(client as never, { itemType: "INTERNAL_COMPONENT", kind: "booth_component", displayName: "ZKUŠEBNÍ sloupek 2500", internalCode: "ZKUS-SLOUPEK-2500", category: "Sloupky", showIn2D: true, showIn3D: true });
  assert.equal(post.abfCode ?? null, null);
  assert.equal(post.category, "Sloupky");
  await assert.rejects(() => createCatalogItemAdmin(client as never, { itemType: "SERVICE", kind: "service", displayName: "Špatně", category: "chairs" }), (error) => error instanceof InvalidCatalogItemAdminCreateInputError && /Produkt/u.test(error.message));
  const electricity = await createCatalogItemAdmin(client as never, { itemType: "SERVICE", kind: "service", displayName: "ZKUŠEBNÍ elektřina", internalCode: "ZKUS-EL", category: "service-electricity" });
  assert.equal(client.tables.get("catalog_items")!.find((row) => row.id === electricity.id)?.price_category, "electricity");
});

test("registr kategorií: migrace je nedestruktivní, zakládá všechny vestavěné kategorie a zachovává existující hodnoty jako id", () => {
  const sql = read("supabase/migrations/20261023120000_catalog_categories.sql");
  for (const category of BUILT_IN_CATALOG_CATEGORIES) assert.ok(sql.includes(`('${category.id}', `), category.id);
  assert.doesNotMatch(sql, /\b(drop|truncate|delete from|alter table catalog_items)\b/iu);
  assert.match(sql, /alter table catalog_categories enable row level security/u);
  for (const legacy of ["chairs", "Nábytek", "T. služby", "Sloupky", "services"]) assert.ok(findCategory(BUILT_IN_CATALOG_CATEGORIES, legacy), legacy);
});

test("správa kategorií: nová kategorie (Barové židle) se zadá bez úpravy kódu; použité kategorii nelze změnit druh", () => {
  const bar = parseCatalogCategoryInput({ name: "Barové židle", group: "product", kinds: ["furniture", "service"] });
  assert.equal(bar.id, "barove-zidle");
  assert.deepEqual(bar.kinds, ["furniture"], "jen druhy povolené pro Produkt");
  assert.throws(() => parseCatalogCategoryInput({ name: "X", group: "product", kinds: ["furniture"], priceCategory: "electricity" }), /jen technické službě/u);
  const chairs = findCategory(BUILT_IN_CATALOG_CATEGORIES, "chairs")!;
  assert.match(categoryChangeIssue(chairs, { ...chairs, group: "technical_service", kinds: ["service"] }, ["furniture"]) ?? "", /nelze změnit/u);
  assert.equal(categoryChangeIssue(chairs, { ...chairs, name: "Židle a křesla" }, ["furniture"]), undefined);
});

test("elektrický bod ve stánku se samostatně neúčtuje — účtuje se jen objednaná elektřina (jeden řádek)", () => {
  const point = componentCatalogItems.find((item) => item.internalCode === "TECH-ELECTRO")!;
  const pricing = priceProjectLegacy({
    currency: "CZK",
    sceneObjects: [placeComponent(point, "bod", 0, 0)],
    requirements: { ...createDefaultTechnicalRequirements(), electricity: { status: "ordered", note: "", powerOption: "2kw", customPower: "" } as TechnicalRequirements["electricity"] },
    printSurfaceAssignments: [],
    realizationProfileId: "default",
    catalogItems: legacyPricingCatalogItems([], componentCatalogItems),
    priceLists: [],
  });
  assert.equal(pricing.lines.find((line) => line.kind === "scene_item")?.status, "not_billed");
  assert.equal(pricing.lines.filter((line) => line.kind === "service" && /Elektrick/u.test(line.name)).length, 1);
});

test("hromadný výběr u L02 (služba bez 3D): PDF → technický list, foto volitelně, GLB/SKP/DWG/DXF jen „Nenahrávat“ s vysvětlením", () => {
  const rows = planBatchUpload(
    [{ name: "L02-technicky-list.pdf", size: 1000 }, { name: "zasuvka.jpg", size: 1000 }, { name: "model.glb", size: 1000 }, { name: "x.skp", size: 1000 }, { name: "x.dwg", size: 1000 }, { name: "x.dxf", size: 1000 }],
    { hasMainPhoto: false, hasModel: false, modelAllowed: false, cadAllowed: false, documentsAllowed: true },
  );
  assert.deepEqual(rows.map((row) => row.target), ["source_pdf", "photo_main", "skip", "skip", "skip", "skip"]);
  assert.deepEqual(rows[0]!.options, ["source_pdf", "skip"]);
  assert.match(rows[2]!.note ?? "", /vypnuté 3D/u);
  assert.match(rows[3]!.note ?? "", /nepoužívá CAD/u);
  for (const row of rows.slice(2)) assert.deepEqual(row.options, ["skip"], "nelze omylem zařadit");
});

test("vypnutí 3D na kartě nesmaže GLB ani SKP/DWG/DXF/PDF; zapnutí je vrátí do sekcí (data se nemění)", () => {
  const document = { ...ADMIN_DOCUMENT, sourceAssets: [{ id: "s", kind: "sketchup", asset: asset("s", "catalog-source", "skp") }, { id: "d", kind: "dwg", asset: asset("d", "catalog-source", "dwg") }, { id: "p", kind: "pdf", asset: asset("p", "catalog-source", "pdf") }] };
  const off = applyCatalogItemEdit(document, parseCatalogItemAdminEdit({ showIn3D: false }));
  assert.equal((off.modelAsset as StoredAsset).id, "glb-1");
  assert.deepEqual(documentSourceAssets(off).map((entry) => entry.id), ["s", "d", "p"]);
  const on = applyCatalogItemEdit(off, parseCatalogItemAdminEdit({ showIn3D: true }));
  assert.deepEqual(on.modelAsset, document.modelAsset);
});

test("karta: GLB sekce podle 3D režimu, CAD u bodu jen s 3D, PDF jako technický list, skryté přílohy v přehledu", () => {
  const source = read("components/workflow/ComponentAdminPage.tsx");
  assert.match(source, /\{!isVariantBooth && model3DMode && \(/u);
  assert.match(source, /!isVariantBooth && cadMode && \(/u);
  assert.match(source, /<CatalogDocumentsSection entries=\{documentAssets\}/u);
  assert.match(source, /<CatalogHiddenAttachments/u);
  assert.match(source, /const CAPABILITY_TOGGLE_KINDS[^;]+"service", "graphics_service"\]/u, "3D lze u služby výslovně zapnout");
  const documents = read("components/workflow/CatalogDocumentsSection.tsx");
  assert.match(documents, /category: "catalog-source", ownerId, mimeType: "application\/pdf"/u, "PDF přes existující R2 upload");
  assert.doesNotMatch(documents, /deleteObject|\/api\/assets\/delete/u, "odebrání je jen reference");
});

test("formulář: Druh komponenty → Kategorie místo Typu karty / Druhu / Typu služby; změna druhu vynuluje kategorii, nic nepředvybere", () => {
  const card = read("components/workflow/ComponentAdminPage.tsx");
  assert.match(card, /<EditRow label="Druh komponenty">/u);
  assert.match(card, /<EditRow label="Kategorie">/u);
  assert.doesNotMatch(card, /<EditRow label="Typ karty">/u);
  assert.doesNotMatch(card, /<EditRow label="Druh \(pravidla readiness\)">/u);
  assert.match(card, /if \(categoryDef\?\.group !== next\) setCategory\(""\);/u, "kategorie jiného druhu se nepřenese");
  assert.match(card, /<option value="">— vyberte kategorii —<\/option>/u, "nic se samo nevybere");
  assert.match(card, /const formProblem = classificationProblem \?\? powerProblem \?\? parametersProblem;/u);
  assert.match(card, /if \(formProblem\) \{\s*setError\(formProblem\);\s*return;/u, "neplatné zařazení ani neplatný parametr se neodešle");
  const service = read("components/workflow/CatalogAdminPanels.tsx");
  assert.doesNotMatch(service, /<select value=\{serviceType\}/u, "Typ služby už není samostatná volba");
  assert.doesNotMatch(service, /Typ služby/u, "typ služby už nikde jako samostatný údaj — určuje ho Kategorie");
  assert.match(service, /function selectPick\(next[^)]*\) \{\s*setPick\(next\);\s*\/\/[^\n]*\n\s*setCategory\(""\);/u, "založení: změna druhu vynuluje kategorii");
});

test("M57: Produkt + Židle je platné zařazení; samotné načtení a běžné uložení zařazení nemění", async () => {
  assert.equal(groupOfCard("PRODUCT", "furniture"), "product");
  assert.equal(classificationIssue(BUILT_IN_CATALOG_CATEGORIES, { itemType: "PRODUCT", kind: "furniture", category: "chairs" }), undefined);
  const client = fakeClient({ catalog_items: [adminRow({ id: "m57", internal_code: "M57", abf_code: "M57", category: "chairs", price_category: "standard", document: { ...ADMIN_DOCUMENT, category: "chairs", photoAsset: asset("foto", "catalog-photo", "jpg") } })], projects: [] });
  const saved = await saveCatalogItemAdmin(client as never, "m57", { note: "ruční test" }, "2026-10-23T08:00:00.000000+00:00");
  assert.equal(saved.category, "chairs");
  assert.equal(saved.kind, "furniture");
  assert.equal(saved.internalCode, "M57");
  assert.equal(client.tables.get("catalog_items")![0]!.price_category, "standard");
  assert.equal(documentPhotoAsset(saved.document)?.id, "foto");
  assert.equal((saved.document.modelAsset as StoredAsset).id, "glb-1");
});

test("API kategorií: vyžaduje přihlášení; bez migrace je registr jen pro čtení (vestavěný seznam)", async () => {
  const { handleCatalogCategoriesGet, handleCatalogCategorySave } = await import("../app/api/catalog-admin/categories/route.ts");
  const { NextRequest } = await import("next/server.js");
  const anonymous = new NextRequest("http://localhost/api/catalog-admin/categories");
  assert.equal((await handleCatalogCategoriesGet(anonymous, { readRegister: async () => ({ categories: [], persisted: false }), saveCategory: async (category) => category })).status, 401);
  const notMigrated = fakeClient({ catalog_items: [] });
  const { readCatalogCategoryRegister, saveCatalogCategory, CatalogCategoriesNotMigratedError } = await import("../lib/db/catalogCategories.supabase.ts");
  const register = await readCatalogCategoryRegister(notMigrated as never);
  assert.equal(register.persisted, false);
  assert.equal(register.categories.length, BUILT_IN_CATALOG_CATEGORIES.length);
  await assert.rejects(() => saveCatalogCategory(notMigrated as never, parseCatalogCategoryInput({ name: "Barové židle", group: "product", kinds: ["furniture"] }), true), (error) => error instanceof CatalogCategoriesNotMigratedError);
  assert.equal(typeof handleCatalogCategorySave, "function");
});

test("správa kategorií po migraci: novou kategorii lze přidat, použité kategorii nelze změnit druh, kategorie se nemažou", async () => {
  const { saveCatalogCategory } = await import("../lib/db/catalogCategories.supabase.ts");
  const rows = BUILT_IN_CATALOG_CATEGORIES.map((category) => ({ id: category.id, name: category.name, component_group: category.group, kinds: [...category.kinds], description: category.description ?? null, is_active: category.isActive, sort_order: category.sortOrder, service_category: category.serviceCategory ?? null, price_category: category.priceCategory ?? null }));
  const client = fakeClient({ catalog_categories: rows, catalog_items: [adminRow({ category: "chairs" })] });
  const bar = await saveCatalogCategory(client as never, parseCatalogCategoryInput({ name: "Barové židle", group: "product", kinds: ["furniture"] }), true);
  assert.equal(bar.id, "barove-zidle");
  assert.equal(client.tables.get("catalog_categories")!.some((row) => row.id === "barove-zidle"), true);
  await assert.rejects(() => saveCatalogCategory(client as never, parseCatalogCategoryInput({ id: "chairs", name: "Židle", group: "technical_service", kinds: ["service"] }), false), /nelze změnit/u);
  const renamed = await saveCatalogCategory(client as never, parseCatalogCategoryInput({ id: "chairs", name: "Židle a křesla", group: "product", kinds: ["furniture"] }), false);
  assert.equal(renamed.name, "Židle a křesla");
  const sql = read("supabase/migrations/20261023120000_catalog_categories.sql");
  assert.match(sql, /catalog_categories_prevent_delete/u);
});

// ---------------------------------------------------------------------------------------------
// Final service UI: parameters in "Parametry komponenty", shared purchase price list
// ---------------------------------------------------------------------------------------------

test("L02: výkon (kW) a parametry jsou ve strukturovaných metadatech služby, uloží se běžným uložením karty a po znovunačtení zůstanou", async () => {
  const client = fakeClient({ catalog_items: [serviceRow({ category: "service-electricity", price_category: "electricity", document: { displayName: "ZKUŠEBNÍ elektřina 2 kW", category: "service-electricity", catalogItemKind: "service", unit: "ks", showIn2D: true, serviceTechnical: { serviceCategory: "electricity" } } })], projects: [] });
  const saved = await saveCatalogItemAdmin(client as never, "zkusebni-l02", parseCatalogItemAdminEdit({ displayName: "ZKUŠEBNÍ elektřina 2 kW / 230 V", serviceTechnical: { serviceCategory: "electricity", powerKw: 2, parameters: [{ key: "Napětí", value: "230 V" }] } }), "2026-10-23T08:00:00.000000+00:00");
  const reread = documentServiceTechnical(saved.document);
  assert.deepEqual(reread, { serviceCategory: "electricity", powerKw: 2, parameters: [{ key: "Napětí", value: "230 V" }] });
  assert.equal(typeof reread?.powerKw, "number", "výkon je číslo, ne text");
  assert.equal(saved.document.showIn2D, true, "2D nastavení zůstává");
  assert.equal(saved.priceCategory, "electricity");
  assert.equal(saved.displayName, "ZKUŠEBNÍ elektřina 2 kW / 230 V", "jedno uložení pro údaje karty i parametry");
});

test("Internet / Úklid: výkon v kW není povinný, vlastní parametry zůstávají", async () => {
  const client = fakeClient({ catalog_items: [serviceRow({ id: "zkusebni-internet", category: "service-internet", document: { displayName: "Internet", category: "service-internet", catalogItemKind: "service", unit: "ks", serviceTechnical: { serviceCategory: "internet" } } })], projects: [] });
  const saved = await saveCatalogItemAdmin(client as never, "zkusebni-internet", parseCatalogItemAdminEdit({ serviceTechnical: { serviceCategory: "internet", parameters: [{ key: "Rychlost", value: "100 Mb/s" }] } }), "2026-10-23T08:00:00.000000+00:00");
  assert.deepEqual(documentServiceTechnical(saved.document), { serviceCategory: "internet", parameters: [{ key: "Rychlost", value: "100 Mb/s" }] });
  assert.equal(computeReadiness(saved).issues.length, 0, "služba bez výkonu i bez nákupní ceny je připravená (stačí jednotka)");
});

test("formulář: žádná samostatná sekce Technická služba; výkon jen u elektřiny (nebo když je uložený), parametry ve společné sekci a v běžném uložení", () => {
  const card = read("components/workflow/ComponentAdminPage.tsx");
  assert.doesNotMatch(card, /ServiceTechnicalSection/u);
  assert.doesNotMatch(read("components/workflow/CatalogAdminPanels.tsx"), /export function ServiceTechnicalSection|Uložit parametry/u);
  assert.match(card, /const showPower = isServiceCard && \(categoryDef\?\.serviceCategory === "electricity" \|\| initialService\?\.powerKw !== undefined\);/u);
  assert.match(card, /\{showPower && \(\s*<EditRow label="Výkon \(kW\)">/u);
  assert.match(card, /if \(isServiceCard\) \{\s*const draft = serviceTechnicalDraft\(\);/u, "parametry služby jdou s běžným Uložit");
  assert.match(card, /if \(initialService\?\.serviceCategory\) draft\.serviceCategory = initialService\.serviceCategory;/u, "technická kategorie se neztratí");
  assert.equal((card.match(/<h3>Parametry komponenty<\/h3>/gu) ?? []).length, 1, "jedna společná sekce pro všechny druhy");
  assert.doesNotMatch(card.slice(card.indexOf("<h3>Parametry komponenty</h3>"), card.indexOf("<h3>Použití v generátoru</h3>")), /Technické rastry/u, "informace o rastrech není v parametrech");
});

test("M57: produktová karta parametry služby neposílá; barva, materiál a další parametry zůstávají", async () => {
  const card = read("components/workflow/ComponentAdminPage.tsx");
  assert.match(card, /const isServiceCard = currentItemType === "SERVICE";/u);
  const client = fakeClient({ catalog_items: [adminRow({ id: "m57", internal_code: "M57", abf_code: "M57", category: "chairs", document: { ...ADMIN_DOCUMENT, category: "chairs", attributes: { color: "černá", material: "kov", extra: [{ key: "Nosnost", value: "120 kg" }] } } })], projects: [] });
  const saved = await saveCatalogItemAdmin(client as never, "m57", parseCatalogItemAdminEdit({ note: "test" }), "2026-10-23T08:00:00.000000+00:00");
  assert.deepEqual(saved.document.attributes, { color: "černá", material: "kov", extra: [{ key: "Nosnost", value: "120 kg" }] });
  assert.equal(saved.document.serviceTechnical, undefined);
  assert.equal(saved.document.widthMm, 530);
});

test("nákupní cena: „Nákupní cena (interní)“ ze Společného nákupního ceníku; chybějící = „Nezadáno“, výslovná 0 = 0 Kč", () => {
  const prices = read("components/workflow/CatalogCardPrices.tsx");
  assert.match(prices, /<h4>Nákupní cena \(interní\)<\/h4>/u);
  assert.match(prices, /Společný nákupní ceník pro realizační firmy, ABF a ostatní dodavatele/u);
  assert.match(prices, /sourceLabel="Společný nákupní ceník"/u);
  assert.doesNotMatch(prices, /Nákupní cena od realizaček/u);
  assert.match(prices, /purchasePrice\.status === "priced" \? <strong>\{formatAmount\(purchasePrice\.amount, "CZK"\)\}<\/strong> : <strong className="purchaseNotEntered">Nezadáno<\/strong>/u);
  const version = { id: "p1", priceListId: "buy", versionNo: 1, revision: 1, status: "published" as const, eurRate: 24.17, eurRoundingMode: "ceil" as const, eurRoundingStep: 1 };
  assert.deepEqual(cardPurchasePrice(version, [{ id: "z", versionId: "p1", catalogItemId: "nula", purchaseCzk: 0 }], "nula"), { status: "priced", amount: 0, variantRowCount: 0 }, "výslovná nula zůstává 0 Kč");
  assert.deepEqual(cardPurchasePrice(version, [], "l02"), { status: "missing", variantRowCount: 0 }, "nezadaná cena nemá žádnou částku");
});

// ---------------------------------------------------------------------------------------------
// Parametry komponenty: system vs. recommended parameters (V1-CATALOG)
// ---------------------------------------------------------------------------------------------

const internetSpeed = { id: "speed", name: "Rychlost připojení", valueType: "number" as const, unit: "Mb/s", sortOrder: 10, isActive: true };
const connectionType = { id: "type", name: "Typ připojení", valueType: "text" as const, sortOrder: 20, isActive: true };

test("doporučený parametr ukládá hodnotu do existujícího seznamu parametrů karty pod čitelným klíčem; vlastní parametry zůstávají", () => {
  assert.equal(recommendedParameterKey(internetSpeed), "Rychlost připojení (Mb/s)");
  const stored = [{ key: "Rychlost připojení (Mb/s)", value: "100" }, { key: "Poznámka technika", value: "zásuvka u zadní stěny" }];
  const split = splitParameters(stored, [internetSpeed, connectionType]);
  assert.deepEqual(split.recommended.map((row) => [row.parameter.name, row.value]), [["Rychlost připojení", "100"], ["Typ připojení", ""]]);
  assert.deepEqual(split.own, [{ key: "Poznámka technika", value: "zásuvka u zadní stěny" }]);
  assert.deepEqual(setParameterValue(stored, "Typ připojení", "optika").at(-1), { key: "Typ připojení", value: "optika" });
  assert.deepEqual(setParameterValue(stored, "Rychlost připojení (Mb/s)", ""), [{ key: "Poznámka technika", value: "zásuvka u zadní stěny" }], "vymazaná nepovinná hodnota se neukládá");
  assert.deepEqual(mergeParameters(split.recommended, split.own), stored, "nevyplněný doporučený parametr nevytvoří fiktivní hodnotu");
});

test("deaktivovaný nebo přejmenovaný doporučený parametr: historická hodnota na kartě zůstane jako vlastní parametr", () => {
  const stored = [{ key: "Rychlost připojení (Mb/s)", value: "100" }];
  assert.deepEqual(splitParameters(stored, [{ ...internetSpeed, isActive: false }]).own, stored);
  assert.deepEqual(splitParameters(stored, [{ ...internetSpeed, unit: "Gb/s" }]).own, stored);
  assert.deepEqual(splitParameters(stored, []).own, stored);
});

test("systémové parametry (rozměry, barva, materiál, výkon) nejdou zadat jako doporučené ani vlastní — žádné duplicity", () => {
  for (const name of ["Šířka", "výška (mm)", "Hloubka", "Výkon", "Výkon (kW)", "Barva", "Materiál"]) assert.equal(isSystemParameterName(name), true, name);
  assert.equal(isSystemParameterName("Rychlost připojení"), false);
  assert.throws(() => parseRecommendedParameters([{ name: "Šířka", valueType: "number", unit: "mm" }]), /systémový parametr/u);
  assert.throws(() => parseRecommendedParameters([{ name: "Typ", valueType: "text" }, { name: "typ", valueType: "text" }]), /dvakrát/u);
  assert.match(parameterProblem({ recommended: [], own: [{ key: "Šířka", value: "500" }] }) ?? "", /systémový údaj/u);
  assert.match(parameterProblem({ recommended: [], own: [{ key: "Napětí", value: "230 V" }, { key: "napětí", value: "400 V" }] }) ?? "", /dvakrát/u);
});

test("kontrola hodnot: neplatné číslo zastaví uložení, nevyplněný nepovinný parametr ne", () => {
  assert.equal(parameterProblem({ recommended: [{ parameter: internetSpeed, value: "" }], own: [], dimensions: [{ label: "Šířka", value: "" }] }), undefined);
  assert.match(parameterProblem({ recommended: [{ parameter: internetSpeed, value: "rychlé" }], own: [] }) ?? "", /musí být číslo/u);
  assert.match(parameterProblem({ recommended: [], own: [], dimensions: [{ label: "Šířka", value: "-5" }] }) ?? "", /nezáporné číslo v mm/u);
  assert.equal(parameterProblem({ recommended: [{ parameter: internetSpeed, value: "100,5" }], own: [] }), undefined);
});

test("administrace: doporučené parametry kategorie lze přidat, upravit a deaktivovat; před migrací parametrů se nedají uložit", async () => {
  const { saveCatalogCategory, readCatalogCategoryRegister, CatalogCategoriesNotMigratedError } = await import("../lib/db/catalogCategories.supabase.ts");
  const rows = BUILT_IN_CATALOG_CATEGORIES.map((category) => ({ id: category.id, name: category.name, component_group: category.group, kinds: [...category.kinds], description: null, is_active: category.isActive, sort_order: category.sortOrder, service_category: category.serviceCategory ?? null, price_category: category.priceCategory ?? null, recommended_parameters: [] }));
  const client = fakeClient({ catalog_categories: rows, catalog_items: [] });
  const internet = findCategory(BUILT_IN_CATALOG_CATEGORIES, "service-internet")!;
  const saved = await saveCatalogCategory(client as never, parseCatalogCategoryInput({ ...internet, recommendedParameters: [{ name: "Rychlost připojení", valueType: "number", unit: "Mb/s" }] }), false);
  assert.deepEqual(saved.recommendedParameters?.map((parameter) => [parameter.name, parameter.unit, parameter.isActive]), [["Rychlost připojení", "Mb/s", true]]);
  const id = saved.recommendedParameters![0]!.id;
  const edited = await saveCatalogCategory(client as never, parseCatalogCategoryInput({ ...internet, recommendedParameters: [{ id, name: "Rychlost připojení", valueType: "number", unit: "Mbit/s", isActive: false }] }), false);
  assert.deepEqual(edited.recommendedParameters?.map((parameter) => [parameter.id, parameter.unit, parameter.isActive]), [[id, "Mbit/s", false]]);
  assert.equal((await readCatalogCategoryRegister(client as never)).categories.find((category) => category.id === "service-internet")?.recommendedParameters?.[0]?.isActive, false);
  // Categories migrated, parameters column not yet: reading works, saving templates refuses with the migration name.
  const withoutColumn = { from: (table: string) => { const builder = client.from(table) as unknown as Record<string, unknown>; const originalSelect = builder.select as (columns?: string) => unknown; builder.select = (columns?: string) => (typeof columns === "string" && columns.includes("recommended_parameters") ? { then: (resolve: (value: unknown) => unknown) => resolve({ data: null, error: { code: "42703" } }) } : originalSelect(columns)); return builder; } };
  const register = await readCatalogCategoryRegister(withoutColumn as never);
  assert.equal(register.parametersMigrated, false);
  assert.equal(register.persisted, true);
  await assert.rejects(() => saveCatalogCategory(withoutColumn as never, parseCatalogCategoryInput({ ...internet, recommendedParameters: [{ name: "Typ připojení" }] }), false), (error) => error instanceof CatalogCategoriesNotMigratedError && /20261023130000/u.test(error.message));
});

test("migrace doporučených parametrů navazuje na kategorie a je nedestruktivní", () => {
  const sql = read("supabase/migrations/20261023130000_catalog_category_parameters.sql");
  assert.match(sql, /alter table catalog_categories\s+add column recommended_parameters jsonb not null default '\[\]'::jsonb/u);
  assert.doesNotMatch(sql, /\b(drop|truncate|delete from|update)\b/iu);
  const migrations = readdirSync(new URL("../supabase/migrations/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();
  assert.equal(migrations.indexOf("20261023130000_catalog_category_parameters.sql"), migrations.indexOf("20261023120000_catalog_categories.sql") + 1);
});

test("M57: rozměry 530 × 600 × 820 mm ve společné sekci, uložené ve strukturovaných polích; žádné duplicitní parametry Šířka/Hloubka/Výška", async () => {
  const card = read("components/workflow/ComponentAdminPage.tsx");
  assert.doesNotMatch(card, /<h3>Rozměry<\/h3>/u);
  assert.match(card, /const showDimensions = catalogTypeHasField\(itemType, "width_mm"\) \|\| Boolean\(initialWidth \|\| initialDepth \|\| initialHeight\);/u, "rozměry zůstanou vidět, i když je karta má uložené");
  assert.match(card, /if \(widthMm !== initialWidth\) \{\s*const parsed = Number\(widthMm\);\s*if \(Number\.isFinite\(parsed\)\) edit\.widthMm = parsed;/u, "rozměry jdou do původních strukturovaných polí");
  assert.match(card, /\+ Přidat parametr/u);
  const client = fakeClient({ catalog_items: [adminRow({ id: "m57", internal_code: "M57", abf_code: "M57", category: "chairs", document: { ...ADMIN_DOCUMENT, category: "chairs", attributes: { color: "Černá", material: "Kov/textil" } } })], projects: [] });
  const saved = await saveCatalogItemAdmin(client as never, "m57", parseCatalogItemAdminEdit({ heightMm: 830, attributes: { color: "Černá", material: "Kov/textil", extra: [{ key: "Nosnost", value: "120 kg" }] } }), "2026-10-23T08:00:00.000000+00:00");
  assert.deepEqual([saved.document.widthMm, saved.document.depthMm, saved.document.heightMm], [530, 600, 830]);
  assert.deepEqual(saved.document.attributes, { color: "Černá", material: "Kov/textil", extra: [{ key: "Nosnost", value: "120 kg" }] });
  assert.equal(saved.document.serviceTechnical, undefined, "úprava produktu nesahá na metadata služby");
});

test("Internet bez šablony: žádné smyšlené přednastavené hodnoty, výkon se nenabízí; po přidání doporučeného parametru se pole nabídne", () => {
  const internet = findCategory(BUILT_IN_CATALOG_CATEGORIES, "service-internet")!;
  assert.equal(internet.recommendedParameters, undefined, "vestavěné kategorie nemají žádné doporučené parametry");
  assert.ok(BUILT_IN_CATALOG_CATEGORIES.every((category) => !category.recommendedParameters?.length));
  assert.deepEqual(splitParameters([], internet.recommendedParameters ?? []).recommended, []);
  assert.deepEqual(splitParameters([], [internetSpeed]).recommended.map((row) => row.parameter.name), ["Rychlost připojení"]);
  const card = read("components/workflow/ComponentAdminPage.tsx");
  assert.match(card, /const recommendedTemplates = activeRecommendedParameters\(categoryDef\?\.recommendedParameters\);/u);
});
