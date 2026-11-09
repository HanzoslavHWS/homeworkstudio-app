import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import {
  ADMIN_AREAS,
  LEGACY_ADMIN_SECTIONS,
  adminAreasFor,
  canOpenAdmin,
  defaultAdminRoute,
  normalizeAdminRoute,
  parseWorkspaceHash,
  workspaceHash,
} from "../domain/adminNavigation.ts";
import { canOpenSection } from "../domain/accessControl.ts";
import { anyFilterActive, buildCatalogItemListEntry, filterCatalogItemsAdmin, moreFiltersActive, type CatalogItemAdmin } from "../domain/catalogItemsAdmin.ts";

test("Administrace: jen správce; běžný a externí uživatel ji nevidí (server kontroluje zvlášť)", () => {
  assert.deepEqual(adminAreasFor("admin").map((area) => area.id), ["catalog", "prices", "events", "companies", "users"]);
  assert.deepEqual(adminAreasFor("user"), []);
  assert.deepEqual(adminAreasFor("external"), []);
  assert.equal(canOpenAdmin("admin"), true);
  assert.equal(canOpenAdmin("user"), false);
  assert.equal(canOpenSection("user", "admin"), false);
  assert.equal(canOpenSection("external", "admin"), false);
  assert.equal(canOpenSection("admin", "admin"), true);
  // operational modules stay where they were
  assert.equal(canOpenSection("user", "tasks"), true);
  assert.equal(canOpenSection("user", "customerCatalog"), true);
  assert.deepEqual(defaultAdminRoute("admin"), { area: "catalog", tab: "items" });
  assert.equal(defaultAdminRoute("user"), undefined);
});

test("adresa: každá oblast a záložka má vlastní URL; otevřená karta katalogu je součástí adresy; obnovení vrátí totéž místo", () => {
  for (const area of ADMIN_AREAS) {
    const tabs = area.tabs as readonly { id: string }[];
    for (const tab of tabs.length ? tabs.map((entry) => entry.id) : [undefined]) {
      const route = normalizeAdminRoute({ area: area.id, ...(tab ? { tab } : {}) });
      const hash = workspaceHash({ section: "admin", admin: route });
      assert.match(hash, /^#\/administrace\//u);
      assert.deepEqual(parseWorkspaceHash(hash), { section: "admin", admin: route }, hash);
    }
  }
  const card = { area: "catalog", tab: "items", itemId: "6b22b294-2a6d-436b-8211-80320b02a2e8" } as const;
  assert.equal(workspaceHash({ section: "admin", admin: card }), "#/administrace/katalog/polozky/6b22b294-2a6d-436b-8211-80320b02a2e8");
  assert.deepEqual(parseWorkspaceHash("#/administrace/katalog/polozky/6b22b294-2a6d-436b-8211-80320b02a2e8"), { section: "admin", admin: card });
  assert.equal(workspaceHash({ section: "admin", admin: { area: "catalog", tab: "import" } }), "#/administrace/katalog/import");
  assert.equal(workspaceHash({ section: "admin", admin: { area: "users" } }), "#/administrace/uzivatele");
  // operational modules and the project editor
  assert.equal(workspaceHash({ section: "tasks" }), "#/ukoly");
  assert.deepEqual(parseWorkspaceHash("#/technicke-rastry"), { section: "technicalRasters" });
  assert.equal(workspaceHash({ section: "project" }), "");
  assert.deepEqual(parseWorkspaceHash(""), { section: "project" });
  // unknown / broken addresses never crash: the project editor, or the first tab of the area
  assert.deepEqual(parseWorkspaceHash("#/neco-jineho"), { section: "project" });
  assert.deepEqual(parseWorkspaceHash("#/administrace/katalog/neexistuje"), { section: "admin", admin: { area: "catalog", tab: "items" } });
  assert.deepEqual(parseWorkspaceHash("#/administrace/ceniky/%E0%A4%A"), { section: "admin", admin: { area: "prices", tab: "versions" } });
});

test("dřívější sekce správy vedou na své místo ve společné administraci (odkazy „Otevřít ceník“ apod.)", () => {
  assert.deepEqual(LEGACY_ADMIN_SECTIONS.components, { area: "catalog", tab: "items" });
  assert.deepEqual(LEGACY_ADMIN_SECTIONS.booths, { area: "catalog", tab: "booths" });
  assert.deepEqual(LEGACY_ADMIN_SECTIONS.pricingAdmin, { area: "prices", tab: "base" });
  assert.deepEqual(LEGACY_ADMIN_SECTIONS.priceVersions, { area: "prices", tab: "versions" });
  assert.deepEqual(LEGACY_ADMIN_SECTIONS.priceLists, { area: "prices", tab: "lists" });
  assert.equal(workspaceHash({ section: "realizationCompanies" }), "#/administrace/firmy");
  assert.equal(workspaceHash({ section: "events" }), "#/administrace/veletrhy");
});

const card = (overrides: Partial<CatalogItemAdmin>): CatalogItemAdmin => ({
  id: crypto.randomUUID(), internalCode: "X", abfCode: null, itemType: "PRODUCT", kind: "furniture", lifecycleStatus: "active", displayName: "X",
  officialName: null, category: "chairs", unit: "ks", createdAt: "", updatedAt: "", document: {},
  ...overrides,
} as CatalogItemAdmin);

test("filtry katalogu: kategorie, stav i archiv; „Další filtry“ se počítají; vymazání vrátí výchozí pohled", () => {
  const entries = [
    card({ internalCode: "M57", displayName: "Židle", category: "chairs" }),
    card({ internalCode: "M20", displayName: "Pult", category: "product-counters", lifecycleStatus: "needs_review" }),
    card({ internalCode: "M99", displayName: "Stará židle", category: "chairs", lifecycleStatus: "archived" }),
    card({ internalCode: "L02", abfCode: "L02", displayName: "Elektřina 2 kW", itemType: "SERVICE", kind: "service", category: "service-electricity" }),
  ].map(buildCatalogItemListEntry);
  const codes = (filters: Parameters<typeof filterCatalogItemsAdmin>[1]) => filterCatalogItemsAdmin(entries, filters).map((entry) => entry.internalCode).sort();
  assert.deepEqual(codes({}), ["L02", "M20", "M57"], "archive hidden by default");
  assert.deepEqual(codes({ category: "chairs" }), ["M57"]);
  assert.deepEqual(codes({ category: "chairs", showArchived: true }), ["M57", "M99"]);
  assert.deepEqual(codes({ onlyArchived: true }), ["M99"]);
  assert.deepEqual(codes({ itemType: "PRODUCT", lifecycleStatus: "needs_review" }), ["M20"]);
  assert.deepEqual(codes({ query: "l02" }), ["L02"], "generator / ABF code search");
  assert.deepEqual(codes({ query: "zidle" }), ["M57"], "name search without diacritics");
  assert.equal(moreFiltersActive({ kind: "furniture", asset: "has-3d" }), 2);
  assert.equal(moreFiltersActive({ category: "chairs", query: "x" }), 0);
  assert.equal(anyFilterActive({}), false);
  assert.equal(anyFilterActive({ query: "  " }), false);
  assert.equal(anyFilterActive({ category: "chairs" }), true);
  assert.equal(anyFilterActive({ needsTypeReview: true }), true);
});

test("starý import KODY je pryč: žádné API, modul, skript ani tlačítko; nový „Importovat Excel“ zůstává", () => {
  for (const removed of ["app/api/catalog-admin/abf-import/route.ts", "domain/catalogAbfImport.ts", "lib/db/catalogAbfImport.supabase.ts", "lib/import/kodyReader.server.ts", "scripts/catalogAbfImportPreview.ts"]) {
    assert.equal(existsSync(removed), false, removed);
  }
  const page = readFileSync("components/workflow/ComponentAdminPage.tsx", "utf8");
  assert.doesNotMatch(page, /KODY|AbfImportPanel/u);
  assert.match(page, /Importovat Excel/u);
  assert.match(page, /<CatalogExcelImportPanel/u);
  const panels = readFileSync("components/workflow/CatalogAdminPanels.tsx", "utf8");
  assert.doesNotMatch(panels, /AbfImportPanel|abf-import/u);
  assert.doesNotMatch(readFileSync("lib/db/catalogItemsAdmin.remoteApi.client.ts", "utf8"), /abf-import/u);
  // the new import and its routes are untouched
  for (const kept of ["app/api/catalog-admin/excel-import/preview/route.ts", "app/api/catalog-admin/excel-import/confirm/route.ts", "app/api/catalog-admin/excel-import/runs/route.ts", "lib/catalogImport/catalogImportUi.server.ts"]) {
    assert.equal(existsSync(kept), true, kept);
  }
  // the import provenance already stored on cards is still shown, never dropped
  assert.match(page, /documentAbfImport/u);
});

test("menu: provozní moduly zůstávají, správa je pod jednou položkou Administrace", () => {
  const sidebar = readFileSync("components/AppSidebar.tsx", "utf8");
  assert.match(sidebar, /\{ section: "admin", icon: "[^"]+", label: "Administrace"/u);
  for (const removed of ["components", "booths", "priceLists", "priceVersions", "pricingAdmin", "events", "realizationCompanies", "users"]) {
    assert.doesNotMatch(sidebar, new RegExp(`section: "${removed}"`, "u"), removed);
  }
  const generator = readFileSync("components/BoothGenerator.tsx", "utf8");
  assert.match(generator, /<AdminShell role=\{currentUser\?\.role\}/u);
  assert.match(generator, /window\.addEventListener\("popstate"/u);
  assert.match(generator, /window\.history\.pushState/u);
});
