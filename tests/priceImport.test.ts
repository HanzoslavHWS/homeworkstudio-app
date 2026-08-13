import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  detectUnitFromName,
  normalizeEventPricingSheet,
  normalizeEventSourceSheet,
  normalizePricelistSheet,
  parseCzechDateRange,
  parsePriceCell,
  type RawSheetRow,
} from "../domain/priceImport.ts";
import { suggestCatalogMappingCandidates } from "../domain/catalogMapping.ts";
import { extractSheetGrid, readWorkbookSheets } from "../lib/import/xlsxReader.server.ts";
import { componentCatalogItems } from "../data/components.ts";

test(".xlsm se čte bez spouštění maker", async (t) => {
  // exceljs is a pure JS zip/XML cell-value parser — it has no VBA execution engine at all
  // (no COM interop, nothing that would run vbaProject.bin), so successfully reading cell
  // values through it is itself the proof no macro code ever ran.
  const filePath = path.resolve(process.cwd(), "private-imports", "Ultimátní kalkulace V6.6.xlsm");
  if (!existsSync(filePath)) {
    t.skip("privátní zdrojový soubor není v tomto prostředí dostupný (negituje se, viz .gitignore)");
    return;
  }
  const workbook = await readWorkbookSheets(filePath);
  const grid = extractSheetGrid(workbook, "PRICELIST");
  assert.ok(grid.length > 100);
  assert.equal(grid[0]?.[0], "kategorie");
});

test("kategorie v PRICELIST se dědí dolů, dokud není v novém řádku uvedena jiná", () => {
  const rows: RawSheetRow[] = [
    ["kategorie", "položka", "ks", "Kč / ks", "item", "€ / pcs", "NÁKLAD Kč / ks", "info"],
    ["Nábytek", "Stůl", "", 500, "Table", 22, 330],
    ["", "Židle", "", 300, "Chair", 13, 170],
    ["", "", "", "", "", "", ""],
    ["Světlo", "Bodovka", "", 200, "Spot", 9, 120],
  ];
  const parsed = normalizePricelistSheet(rows);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0]?.category, "Nábytek");
  assert.equal(parsed[1]?.category, "Nábytek");
  assert.equal(parsed[2]?.category, "Světlo");
});

test("CZ a EN názvy se čtou ze správných sloupců", () => {
  const rows: RawSheetRow[] = [
    ["kategorie", "položka", "ks", "Kč / ks", "item", "€ / pcs", "NÁKLAD Kč / ks", "info"],
    ["Nábytek", "Židle čalouněná", "", 300, "Upholstered chair", 13, 170],
  ];
  const [row] = normalizePricelistSheet(rows);
  assert.equal(row?.rawNameCz, "Židle čalouněná");
  assert.equal(row?.rawNameEn, "Upholstered chair");
});

test("CZK sale, EUR sale a CZK purchase se parsují z odpovídajících sloupců", () => {
  const rows: RawSheetRow[] = [
    ["kategorie", "položka", "ks", "Kč / ks", "item", "€ / pcs", "NÁKLAD Kč / ks", "info"],
    ["Nábytek", "Židle čalouněná", "", 300, "Upholstered chair", 13, 170],
  ];
  const [row] = normalizePricelistSheet(rows);
  assert.deepEqual(row?.saleCzk, { amount: 300, status: "priced" });
  assert.deepEqual(row?.saleEur, { amount: 13, status: "priced" });
  assert.deepEqual(row?.purchaseCzk, { amount: 170, status: "priced" });
});

test('"??" znamená chybějící cenu, NIKDY 0', () => {
  assert.deepEqual(parsePriceCell("??"), { amount: null, status: "missing" });
  assert.notDeepEqual(parsePriceCell("??"), { amount: 0, status: "priced" });
});

test('"ZVOL VELETRH" znamená chybějící/non-price hodnotu', () => {
  assert.deepEqual(parsePriceCell("ZVOL VELETRH"), { amount: null, status: "missing" });
});

test("prázdná buňka znamená chybějící cenu", () => {
  assert.deepEqual(parsePriceCell(""), { amount: null, status: "missing" });
  assert.deepEqual(parsePriceCell(null), { amount: null, status: "missing" });
  assert.deepEqual(parsePriceCell(undefined), { amount: null, status: "missing" });
});

test("skutečná nulová cena zůstává priced, ne missing", () => {
  assert.deepEqual(parsePriceCell(0), { amount: 0, status: "priced" });
});

test("event source IDs se čtou jako stabilní sourceKey z 'data sheet'", () => {
  const rows: RawSheetRow[] = [
    ["id", "AAA VYBER", "xxx"],
    ["beauty", "For Beauty", "2. - 3. 10. 2026"],
    ["arch", "For Arch", "16. - 19. 9. 2026"],
  ];
  const events = normalizeEventSourceSheet(rows);
  assert.deepEqual(events.map((e) => e.sourceKey), ["beauty", "arch"]);
  assert.equal(events[0]?.name, "For Beauty");
});

test("event date parsing zvládne 'D1 - D2. M. YYYY' bezpečně", () => {
  const parsed = parseCzechDateRange("2. - 3. 10. 2026");
  assert.deepEqual(parsed, { startDate: "2026-10-02", endDate: "2026-10-03", needsReview: false });
});

test("neznámé/nejednoznačné datum zůstává null a needsReview, nikdy se nevymýšlí", () => {
  const unknown = parseCzechDateRange("zatím nebylo určeno");
  assert.deepEqual(unknown, { startDate: null, endDate: null, needsReview: true });

  const crossMonthAmbiguous = parseCzechDateRange("28. 2. - 3. 3. 2027");
  assert.equal(crossMonthAmbiguous.needsReview, true);
  assert.equal(crossMonthAmbiguous.startDate, null);
});

test("CZK a EUR event pricing sheets se parsují nezávisle, žádný přepočet kurzem", () => {
  const czkRows: RawSheetRow[] = [
    ["CZK", "beauty", "arch"],
    ["Přípojka el. energie - 2kW", 5100, 5500],
  ];
  const eurRows: RawSheetRow[] = [
    ["EUR", "beauty", "arch"],
    ["Přípojka el. energie - 2kW", 231, "??"],
  ];
  const [czk] = normalizeEventPricingSheet(czkRows);
  const [eur] = normalizeEventPricingSheet(eurRows);
  assert.deepEqual(czk?.pricesByEventKey.beauty, { amount: 5100, status: "priced" });
  assert.deepEqual(eur?.pricesByEventKey.beauty, { amount: 231, status: "priced" });
  // 231 is not 5100 divided by any implied rate stored anywhere — EUR is a fully independent
  // column read, confirmed by arch staying missing in EUR despite having a CZK price.
  assert.deepEqual(eur?.pricesByEventKey.arch, { amount: null, status: "missing" });
});

test("prázdný technický nákladový sheet nevymýšlí náklady", () => {
  const emptyNaklad: RawSheetRow[] = [
    ["náklad?", "beauty", "arch"],
    ["Přípojka el. energie - 2kW", "", ""],
    ["Úklid denní", "", ""],
  ];
  const parsed = normalizeEventPricingSheet(emptyNaklad);
  const allPrices = parsed.flatMap((row) => Object.values(row.pricesByEventKey));
  assert.equal(allPrices.every((price) => price.status === "missing"), true);
  assert.equal(allPrices.some((price) => price.amount === 0), false);
});

test("jednotka se odvodí jen z explicitních markerů (1 m², 1 bm, /den, m³), jinak NULL + needsReview", () => {
  assert.deepEqual(detectUnitFromName("Stavba octanorm 1 m²"), { unit: "m²", needsReview: false });
  assert.deepEqual(detectUnitFromName("Stěna plná - octanorm (výška 250 cm) - 1 bm"), { unit: "bm", needsReview: false });
  assert.deepEqual(detectUnitFromName('Zapůjčení TV (40")/den'), { unit: "den", needsReview: false });
  assert.deepEqual(detectUnitFromName("Napuštění bazénu - m³"), { unit: "m³", needsReview: false });
  assert.deepEqual(detectUnitFromName("Židle čalouněná"), { unit: null, needsReview: true });
});

test("M57 se navrhne jako candidate mapping pro 'Židle čalouněná', bez automatického sloučení", () => {
  const candidates = suggestCatalogMappingCandidates({ rawNameCz: "Židle čalouněná", rawNameEn: "Upholstered chair" }, componentCatalogItems);
  const m57 = candidates.find((c) => c.internalCode === "M57");
  assert.ok(m57, "M57 musí být mezi navrženými kandidáty");
  assert.ok(m57!.score < 1, "shoda není přesná, nesmí se tvářit jako jistota");
});

test("L02 se navrhne jako candidate mapping pro 'Přípojka el. energie - 2kW'", () => {
  const candidates = suggestCatalogMappingCandidates({ rawNameCz: "Přípojka el. energie - 2kW" }, componentCatalogItems);
  const l02 = candidates.find((c) => c.internalCode === "L02");
  assert.ok(l02, "L02 musí být mezi navrženými kandidáty");
});

test("žádné automatické fuzzy sloučení: kandidát se nikdy sám nestane confirmed mappingem", () => {
  const candidates = suggestCatalogMappingCandidates({ rawNameCz: "Židle čalouněná" }, componentCatalogItems);
  // suggestCatalogMappingCandidates only ever returns advisory candidates — confirming a
  // mapping is a separate, explicit CatalogMapping.confirmed=true action elsewhere.
  assert.ok(candidates.every((c) => !("confirmed" in c)));
});
