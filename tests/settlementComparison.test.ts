import assert from "node:assert/strict";
import test from "node:test";
import {
  compareSettlement,
  matchesRowFilter,
  type ComparisonAbfLine,
  type ComparisonCatalogItem,
  type ComparisonInput,
  type ComparisonRow,
  type ComparisonVendorLine,
  type ComparisonVendorMapping,
} from "../domain/settlementComparison.ts";
import { normalizeSettlementText } from "../domain/settlementCheck.ts";

// =========================================================================================
// Kontrola vyúčtování — deterministic comparison engine.
// =========================================================================================

const CATALOG: readonly ComparisonCatalogItem[] = [
  { id: "chair", abfCode: "M57", displayName: "Židle čalouněná – kovová", abfNames: ["ŽIDLE KOVOVÁ ČALOUNĚNÁ"] },
  { id: "spot", abfCode: "L10", displayName: "Bodové světlo 60 W", abfNames: ["SVÍTIDLO BODOVÉ 60 W"] },
  { id: "carpet", abfCode: "K02", displayName: "Koberec barevný", abfNames: ["KOBEREC BAREVNÝ"] },
  { id: "fascia", abfCode: "G01", displayName: "Límec – grafika", abfNames: ["LÍMEC - GRAFIKA"] },
  { id: "t18", abfCode: "T18", displayName: "Typový stánek T18", abfNames: [] },
  { id: "insurance", abfCode: "S10", displayName: "Pojištění odpovědnosti", abfNames: ["ZAJIŠTĚNÍ POJIŠTĚNÍ ODPOVĚDNOSTI ZA ŠKODU"] },
  { id: "parking", abfCode: "P01", displayName: "Parkovací karta", abfNames: ["PARKOVACÍ KARTA - Nepřenosná"] },
  { id: "tableA", abfCode: "N01", displayName: "Stůl A", abfNames: ["STŮL"] },
  { id: "tableB", abfCode: "N02", displayName: "Stůl B", abfNames: ["STŮL"] },
];

const confirmed = (text: string, catalogItemId: string, unit: string | null = null): ComparisonVendorMapping => ({ normalizedText: normalizeSettlementText(text), catalogItemId, unit, status: "confirmed" });

const MAPPINGS: readonly ComparisonVendorMapping[] = [
  confirmed("židle čalouněná", "chair"),
  confirmed("bodové svítidlo 60 W", "spot"),
  confirmed("koberec jiné barvy Kč/1m2", "carpet"),
  confirmed("límec, výška 30 cm Kč/bm", "fascia"),
  confirmed("typový stánek octanorm - T18", "t18"),
];

let sequence = 0;
function abf(standKey: string | null, rawName: string, quantity: number | null, unitRaw: string | null, extra: Partial<ComparisonAbfLine> = {}): ComparisonAbfLine {
  sequence += 1;
  return { id: `abf-${sequence}`, standKey, standLabel: standKey ?? "?", exhibitorName: "Vystavovatel", rawName, abfCode: null, quantity, quantityIssue: null, unitRaw, ...extra };
}
function vendor(standKey: string | null, rawName: string, quantity: number | null, unit: string | null, extra: Partial<ComparisonVendorLine> = {}): ComparisonVendorLine {
  sequence += 1;
  return { id: `vendor-${sequence}`, standKey, standLabel: standKey ?? "?", exhibitorName: "Vystavovatel R", rawName, quantity, quantityIssue: null, unit, ...extra };
}
function run(input: Partial<ComparisonInput>) {
  return compareSettlement({ catalog: CATALOG, mappings: MAPPINGS, abfLines: [], vendorLines: [], ...input });
}
function rowOf(result: ReturnType<typeof run>, standKey: string, rowKey: string): ComparisonRow {
  const row = result.stands.find((stand) => stand.standKey === standKey)?.rows.find((candidate) => candidate.rowKey === rowKey);
  assert.ok(row, `řádek ${rowKey} na stánku ${standKey}`);
  return row;
}

test("MATCH / DIFFERENCE: stejné množství je shoda, jiné je rozdíl = vyúčtováno − objednáno", () => {
  const result = run({
    abfLines: [abf("3A27", "ŽIDLE KOVOVÁ ČALOUNĚNÁ", 2, "ks"), abf("3A27", "SVÍTIDLO BODOVÉ 60 W", 3, "ks"), abf("3A27", "KOBEREC BAREVNÝ", 9, "m2")],
    vendorLines: [vendor("3A27", "židle čalouněná", 2, "ks"), vendor("3A27", "bodové svítidlo 60 W", 5, "ks"), vendor("3A27", "koberec jiné barvy Kč/1m2", 7.5, "m2")],
  });
  const chair = rowOf(result, "3A27", "item:chair");
  assert.equal(chair.status, "match");
  assert.equal(chair.difference, 0);
  assert.equal(chair.label, "Židle čalouněná – kovová", "řádek nese náš zobrazovaný název");
  assert.equal(chair.abfCode, "M57");
  assert.deepEqual(chair.explanation.abfMatch, ["abf_name"]);
  assert.equal(chair.explanation.vendorMappingConfirmed, true);

  const spot = rowOf(result, "3A27", "item:spot");
  assert.equal(spot.status, "difference");
  assert.equal(spot.difference, 2, "realizačka účtuje o 2 víc");

  const carpet = rowOf(result, "3A27", "item:carpet");
  assert.equal(carpet.status, "difference");
  assert.equal(carpet.difference, -1.5, "záporný rozdíl = účtováno méně");
  assert.deepEqual([carpet.abfQuantity, carpet.abfUnit, carpet.vendorQuantity, carpet.vendorUnit], [9, "m2", 7.5, "m2"]);

  const stand = result.stands[0]!;
  assert.equal(stand.matchState, "matched");
  assert.equal(stand.problemCount, 2);
  assert.deepEqual(stand.rows.map((row) => row.status), ["difference", "difference", "match"], "problémy jsou nahoře");
});

test("ONLY ABF / ONLY VENDOR: známá komponenta jen na jedné straně", () => {
  const result = run({
    abfLines: [abf("3A27", "ŽIDLE KOVOVÁ ČALOUNĚNÁ", 2, "ks")],
    vendorLines: [vendor("3A27", "bodové svítidlo 60 W", 3, "ks")],
  });
  assert.equal(rowOf(result, "3A27", "item:chair").status, "only_abf");
  assert.equal(rowOf(result, "3A27", "item:chair").difference, null);
  assert.equal(rowOf(result, "3A27", "item:spot").status, "only_vendor");
});

test("UNITS: ks, m² a bm se nikdy neporovnávají automaticky — řádek vyžaduje pravidlo, ne falešný rozdíl", () => {
  const result = run({
    // Real case: ABF orders the fascia as "4,5 ks", Creativ bills it per running metre.
    abfLines: [abf("3A27", "LÍMEC - GRAFIKA", 4.5, "ks")],
    vendorLines: [vendor("3A27", "límec, výška 30 cm Kč/bm", 4.5, "bm")],
  });
  const fascia = rowOf(result, "3A27", "item:fascia");
  assert.equal(fascia.status, "requires_rule");
  assert.equal(fascia.difference, null, "stejné číslo v jiných jednotkách není shoda ani rozdíl 0");
  assert.match(fascia.explanation.reasons.join(" "), /Rozdílné jednotky: ABF ks, realizačka bm/u);
  assert.equal(result.summary.rowCounts.match, 0);
});

test("UNITS: jednotka ze slovníku přebíjí jednotku z textu; chybějící jednotka je nejasná, ne shoda", () => {
  const withOverride = run({
    mappings: [confirmed("stropní podhled bílý Kč/1m", "carpet", "m2")],
    abfLines: [abf("3A27", "KOBEREC BAREVNÝ", 9, "m2")],
    vendorLines: [vendor("3A27", "stropní podhled bílý Kč/1m", 9, "m")],
  });
  assert.equal(rowOf(withOverride, "3A27", "item:carpet").status, "match", "uživatel ve slovníku určil, že „/1m“ je m²");

  const missingUnit = run({
    abfLines: [abf("3A27", "ŽIDLE KOVOVÁ ČALOUNĚNÁ", 2, null)],
    vendorLines: [vendor("3A27", "židle čalouněná", 2, "ks")],
  });
  assert.equal(rowOf(missingUnit, "3A27", "item:chair").status, "unclear");
  assert.equal(rowOf(missingUnit, "3A27", "item:chair").difference, null);

  const equivalent = run({
    abfLines: [abf("3A27", "KOBEREC BAREVNÝ", 18, "m2/ak")],
    vendorLines: [vendor("3A27", "koberec jiné barvy Kč/1m2", 18, "m2")],
  });
  assert.equal(rowOf(equivalent, "3A27", "item:carpet").status, "match", "„m2/ak“ a „m2“ je táž jednotka");
});

test("UNRECOGNIZED NAMES: bez katalogu / bez potvrzeného mapování je řádek nejasný, nikdy shoda", () => {
  const result = run({
    mappings: [
      { normalizedText: normalizeSettlementText("vitrína pultová 100x50x100"), catalogItemId: "chair", unit: null, status: "suggested" },
      { normalizedText: normalizeSettlementText("regál pětipolicový"), catalogItemId: null, unit: null, status: "suggested" },
      { normalizedText: normalizeSettlementText("věšák stěnový"), catalogItemId: "spot", unit: null, status: "unclear" },
    ],
    abfLines: [abf("3A27", "NEZNÁMÁ POLOŽKA ABF", 1, "ks"), abf("3A27", "STŮL", 2, "ks")],
    vendorLines: [
      vendor("3A27", "grafika záslepky", 1, "ks"),
      vendor("3A27", "vitrína pultová 100x50x100", 1, "ks"),
      vendor("3A27", "regál pětipolicový", 1, "ks"),
      vendor("3A27", "věšák stěnový", 1, "ks"),
    ],
  });
  const stand = result.stands[0]!;
  assert.ok(stand.rows.every((row) => row.status === "unclear"), "všech 6 řádků je nejasných");
  assert.equal(stand.rows.length, 6);
  assert.equal(stand.counts.match, 0);

  assert.match(rowOf(result, "3A27", "abf:neznama polozka abf").explanation.reasons[0]!, /není v katalogu/u);
  const ambiguous = rowOf(result, "3A27", "abf:stul");
  assert.deepEqual([...ambiguous.explanation.candidateCatalogItemIds].sort(), ["tableA", "tableB"], "název vedoucí na dvě komponenty se nerozhodne sám");
  assert.match(rowOf(result, "3A27", "vendor:grafika zaslepky").explanation.reasons[0]!, /není ve slovníku/u);
  assert.match(rowOf(result, "3A27", "vendor:vitrina pultova 100x50x100").explanation.reasons[0]!, /jen návrh/u, "návrh mapování se nepoužije, dokud ho člověk nepotvrdí");
  assert.match(rowOf(result, "3A27", "vendor:vesak stenovy").explanation.reasons[0]!, /nejasné/u);
});

test("ABF RESOLUTION: kód v textu položky, přesný název a zkrácený název (ABF sestava ořezává na ~40 znaků)", () => {
  const result = run({
    abfLines: [
      abf("3A28", "T18 - TYPOVÝ STÁNEK 6X3 m (STAVBA)", 1, "ks", { abfCode: "T18" }),
      abf("3A28", "ZAJIŠTĚNÍ POJIŠTĚNÍ ODPOVĚDNOSTI ZA ŠK", 1, "ks"),
      abf("3A28", "ZAJIŠTĚNÍ", 1, "ks"),
    ],
    vendorLines: [vendor("3A28", "typový stánek octanorm - T18", 1, "ks")],
  });
  const booth = rowOf(result, "3A28", "item:t18");
  assert.equal(booth.status, "match");
  assert.deepEqual(booth.explanation.abfMatch, ["abf_code"]);

  const insurance = rowOf(result, "3A28", "item:insurance");
  assert.deepEqual(insurance.explanation.abfMatch, ["abf_name_truncated"]);
  assert.match(insurance.explanation.reasons.join(" "), /zkrácený/u, "zkrácené přiřazení je v řádku přiznané");
  assert.equal(rowOf(result, "3A28", "abf:zajisteni").status, "unclear", "krátký začátek názvu se za zkrácený název nepovažuje");
});

test("DUPLICATE ROWS: dva stejné řádky zůstávají jako dva původní řádky; sčítají se jen ve stejné jednotce", () => {
  const first = abf("3A17", "PARKOVACÍ KARTA - Nepřenosná", 1, "ks");
  const second = abf("3A17", "PARKOVACÍ KARTA - Nepřenosná", 2, "ks");
  const result = run({ abfLines: [first, second] });
  const parking = rowOf(result, "3A17", "item:parking");
  assert.equal(parking.abfQuantity, 3);
  assert.deepEqual(parking.abfLineIds, [first.id, second.id], "oba původní řádky jsou dohledatelné");
  assert.match(parking.explanation.reasons.join(" "), /Sečteno z 2 řádků objednávky ABF/u);

  const mixed = run({
    abfLines: [abf("3A17", "KOBEREC BAREVNÝ", 9, "m2"), abf("3A17", "KOBEREC BAREVNÝ", 2, "ks")],
    vendorLines: [vendor("3A17", "koberec jiné barvy Kč/1m2", 11, "m2")],
  });
  const carpet = rowOf(mixed, "3A17", "item:carpet");
  assert.equal(carpet.status, "requires_rule", "9 m² + 2 ks se nesečte na 11");
  assert.equal(carpet.abfQuantity, null);
  assert.equal(carpet.abfLineIds.length, 2);

  const unresolvedTwice = run({ vendorLines: [vendor("3A17", "atyp výplně", 2, "ks"), vendor("3A17", "atyp výplně", 3, "ks")] });
  const atyp = rowOf(unresolvedTwice, "3A17", "vendor:atyp vyplne");
  assert.equal(atyp.vendorLineIds.length, 2);
  assert.equal(atyp.vendorQuantity, 5);
  assert.equal(atyp.status, "unclear");
});

test("QUANTITY ISSUE: řádek s nečitelným množstvím nikdy nedá shodu", () => {
  const result = run({
    abfLines: [abf("3A27", "ŽIDLE KOVOVÁ ČALOUNĚNÁ", 2, "ks")],
    vendorLines: [vendor("3A27", "židle čalouněná", null, "ks", { quantityIssue: "Množství „dle dohody“ se nepodařilo přečíst jako číslo." })],
  });
  assert.equal(rowOf(result, "3A27", "item:chair").status, "unclear");
});

test("STANDS: nespárované stánky jsou odděleně na obou stranách; nepřiřazené řádky do porovnání nevstupují", () => {
  const result = run({
    abfLines: [abf("4A9", "ŽIDLE KOVOVÁ ČALOUNĚNÁ", 2, "ks"), abf("4C7", "ŽIDLE KOVOVÁ ČALOUNĚNÁ", 4, "ks"), abf(null, "ŽIDLE KOVOVÁ ČALOUNĚNÁ", 9, "ks")],
    vendorLines: [vendor("3B9", "židle čalouněná", 1, "ks"), vendor("4C7", "židle čalouněná", 4, "ks"), vendor(null, "židle čalouněná", 50, "ks")],
    abfStandKeys: [{ standKey: "4B7", label: "4B07", exhibitorName: "Bez položek" }],
  });
  assert.deepEqual(result.stands.map((stand) => [stand.standKey, stand.matchState]), [["3B9", "vendor_only"], ["4A9", "abf_only"], ["4B7", "abf_only"], ["4C7", "matched"]]);
  assert.deepEqual(result.summary, { standCount: 4, matchedStandCount: 1, abfOnlyStandCount: 2, vendorOnlyStandCount: 1, rowCounts: { match: 1, difference: 0, only_abf: 1, only_vendor: 1, unclear: 0, requires_rule: 0, out_of_scope: 0 } });
  assert.equal(result.stands.find((stand) => stand.standKey === "4B7")!.rows.length, 0, "stánek bez položek v přehledu zůstává");
  assert.equal(result.stands.find((stand) => stand.standKey === "4B7")!.displayNumber, "4B07");
});

test("RULE out_of_scope: jen aktivní pravidlo, jen když realizačka položku vůbec neúčtuje, a řádek říká proč", () => {
  const rule = { id: "rule-1", name: "Parkovací karta — mimo rozsah", catalogItemId: "parking", abfNormalizedName: null };
  const nameRule = { id: "rule-2", name: "Registrace — mimo rozsah", catalogItemId: null, abfNormalizedName: normalizeSettlementText("REGISTRACE VYSTAVOVATELE") };
  const lines = { abfLines: [abf("3A17", "PARKOVACÍ KARTA - Nepřenosná", 1, "ks"), abf("3A17", "REGISTRACE VYSTAVOVATELE", 1, "ks")] };

  const without = run(lines);
  assert.equal(rowOf(without, "3A17", "item:parking").status, "only_abf");
  assert.equal(rowOf(without, "3A17", "abf:registrace vystavovatele").status, "unclear");

  const withRules = run({ ...lines, outOfScopeRules: [rule, nameRule] });
  const parking = rowOf(withRules, "3A17", "item:parking");
  assert.equal(parking.status, "out_of_scope");
  assert.deepEqual(parking.explanation.ruleIds, ["rule-1"]);
  assert.match(parking.explanation.reasons[0]!, /podle pravidla „Parkovací karta — mimo rozsah“/u);
  assert.equal(rowOf(withRules, "3A17", "abf:registrace vystavovatele").status, "out_of_scope");
  assert.equal(withRules.stands[0]!.problemCount, 0);

  const billedAnyway = run({ ...lines, mappings: [confirmed("parkování", "parking")], vendorLines: [vendor("3A17", "parkování", 1, "ks")], outOfScopeRules: [rule] });
  assert.equal(rowOf(billedAnyway, "3A17", "item:parking").status, "match", "když ji realizačka přesto účtuje, pravidlo nic neskryje");
});

test("FILTERS: „Nejasné položky“ zahrnují i řádky vyžadující pravidlo", () => {
  assert.equal(matchesRowFilter("requires_rule", "unclear"), true);
  assert.equal(matchesRowFilter("unclear", "unclear"), true);
  assert.equal(matchesRowFilter("match", "unclear"), false);
  assert.equal(matchesRowFilter("out_of_scope", "all"), true);
  assert.equal(matchesRowFilter("difference", "match"), false);
});
