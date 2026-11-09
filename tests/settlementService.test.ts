import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createTestSessionToken as createSessionToken } from "./helpers/testAuth.ts";
import { handleSettlementCreate, handleSettlementGet, handleSettlementImport, handleSettlementList, handleSettlementRulesPost, type SettlementApiDependencies } from "../lib/settlement/settlementApi.server.ts";
import { parseAbfOrdersFromSheetGrid } from "../domain/settlementAbfOrderImport.ts";
import { parseCreativExpoWorkbook, type VendorSheetGrid } from "../domain/settlementCreativExpoImport.ts";
import { SettlementConflictError, SettlementValidationError, type ParsedAbfOrders, type ParsedVendorBilling, type SettlementCatalogItem } from "../domain/settlementCheck.ts";
import { parseSettlementRuleInput } from "../domain/settlementRules.ts";
import {
  addCatalogItemName,
  assignSettlementStand,
  changeSettlementRuleStatus,
  createSettlementCheck,
  createSettlementRule,
  deleteSettlementCheck,
  importSettlementFile,
  loadSettlementCheckDetail,
  loadSettlementSourceRows,
  recomputeSettlementCheck,
  removeSettlementFile,
  saveSettlementDecision,
  saveSettlementMapping,
  updateSettlementCheck,
  type SettlementImportRequest,
  type SettlementResultRow,
} from "../domain/settlementService.ts";
import { MemorySettlementRepository } from "./helpers/settlementMemoryRepository.ts";
import { creativSheet, readSheets, REAL_FILES } from "./helpers/settlementFixtures.ts";

// =========================================================================================
// Kontrola vyúčtování — service flow against an in-memory repository (same contract as the
// Supabase one), migration guards, API guards and UI wiring guards.
// =========================================================================================

const COMPANY = { id: "creativ-expo", name: "Creativ Expo" };

const CATALOG: readonly SettlementCatalogItem[] = [
  { id: "chair", abfCode: "M57", internalCode: "M57", displayName: "Židle čalouněná – kovová", officialName: "ŽIDLE KOVOVÁ ČALOUNĚNÁ", unit: "ks", lifecycleStatus: "active" },
  { id: "socket", abfCode: "L05", internalCode: "L05", displayName: "Trojzásuvka", officialName: "TROJZÁSUVKA", unit: "ks", lifecycleStatus: "active" },
  { id: "carpet", abfCode: "K02", internalCode: "K02", displayName: "Koberec barevný", officialName: "KOBEREC BAREVNÝ", unit: "m2", lifecycleStatus: "active" },
  { id: "parking", abfCode: "P01", internalCode: "P01", displayName: "Parkovací karta", officialName: "PARKOVACÍ KARTA - Nepřenosná", unit: "ks", lifecycleStatus: "active" },
];

function abfOrders(chairs = 2): ParsedAbfOrders {
  const row = (cells: Record<number, string | number>) => {
    const out: (string | number | null)[] = Array.from({ length: 15 }, () => null);
    for (const [column, value] of Object.entries(cells)) out[Number(column) - 1] = value;
    return out;
  };
  return parseAbfOrdersFromSheetGrid([
    row({ 1: "Stánek", 5: "Číslo dokladu" }),
    row({ 1: "3A17", 6: "V253-206/202" }),
    row({ 1: "VYSTAVOVATEL A s.r.o.", 8: "VYSTAVOVATEL A" }),
    row({ 1: "KOBEREC BAREVNÝ", 14: 9, 15: "m2" }),
    row({ 1: "TROJZÁSUVKA", 14: 1, 15: "ks" }),
    row({ 1: "ŽIDLE KOVOVÁ ČALOUNĚNÁ", 14: chairs, 15: "ks" }),
    row({ 1: "PARKOVACÍ KARTA - Nepřenosná", 14: 1, 15: "ks" }),
    row({ 1: "PARKOVACÍ KARTA - Nepřenosná", 14: 2, 15: "ks" }),
    row({ 1: "4C01", 6: "V253-78/2026" }),
    row({ 1: "ABF, a.s. - SOUTĚŽ" }),
    row({ 1: "TROJZÁSUVKA", 14: 6, 15: "ks" }),
  ]);
}

function vendorBilling(chairs: number | null = 2): ParsedVendorBilling {
  return parseCreativExpoWorkbook([
    creativSheet("3A17", "3A17 Vystavovatel A s.r.o.", { "koberec jiné barvy Kč/1m2": 9, trojzásuvka: 1, "židle čalouněná": chairs }),
    creativSheet("4C1-2", "4C1 - 2  soutěž ", { trojzásuvka: 6 }),
    creativSheet("16", "STÁNEK 16"),
  ]);
}

const fingerprint = (seed: string) => createHash("sha256").update(seed).digest("hex");

function abfRequest(checkId: string, overrides: Partial<SettlementImportRequest> = {}, chairs = 2): SettlementImportRequest {
  return { checkId, side: "abf", format: "xlsx", fileName: "creativ_stavby.xlsx", fileSize: 100, fingerprint: fingerprint(`abf-${chairs}`), parsed: { side: "abf", orders: abfOrders(chairs) }, ...overrides } as SettlementImportRequest;
}
function vendorRequest(checkId: string, overrides: Partial<SettlementImportRequest> = {}, chairs: number | null = 2): SettlementImportRequest {
  return { checkId, side: "vendor", format: "xlsx", fileName: "Beauty podzim 2026 hala 3.xlsx", fileSize: 200, fingerprint: fingerprint(`vendor-${chairs}`), parsed: { side: "vendor", billing: vendorBilling(chairs) }, ...overrides } as SettlementImportRequest;
}

async function setup() {
  const repository = new MemorySettlementRepository();
  repository.catalogItems = [...CATALOG];
  const check = await createSettlementCheck(repository, { eventId: "for-beauty-podzim-2026", realizationCompanyId: COMPANY.id, realizationCompanyName: COMPANY.name }, { actorName: "Hanz" });
  return { repository, checkId: check.id };
}

async function confirmBasicMappings(repository: MemorySettlementRepository) {
  for (const [text, id] of [["koberec jiné barvy Kč/1m2", "carpet"], ["trojzásuvka", "socket"], ["židle čalouněná", "chair"]] as const) {
    await saveSettlementMapping(repository, { realizationCompanyId: COMPANY.id, sourceText: text, catalogItemId: id, unit: null, status: "confirmed" });
  }
}

const statusOf = (rows: readonly SettlementResultRow[], standKey: string, rowKey: string) => rows.find((row) => row.standKey === standKey && row.rowKey === rowKey)?.status;

test("CHECK: jedna kontrola na akci + realizační firmu; druhá hala jde do téže kontroly", async () => {
  const { repository, checkId } = await setup();
  await assert.rejects(
    createSettlementCheck(repository, { eventId: "for-beauty-podzim-2026", realizationCompanyId: COMPANY.id, realizationCompanyName: COMPANY.name }),
    (error: unknown) => error instanceof SettlementConflictError && error.code === "check_exists" && (error.details as { checkId: string }).checkId === checkId,
  );
  await assert.rejects(createSettlementCheck(repository, { realizationCompanyId: COMPANY.id, realizationCompanyName: COMPANY.name }), SettlementValidationError);
  await createSettlementCheck(repository, { eventId: "for-beauty-podzim-2026", realizationCompanyId: "mac", realizationCompanyName: "MAC" });
  assert.equal(repository.checks.length, 2, "jiná firma = jiná kontrola");

  await importSettlementFile(repository, vendorRequest(checkId));
  await importSettlementFile(repository, vendorRequest(checkId, { fileName: "Beauty podzim 2026 hala 4.xlsx", fingerprint: fingerprint("hall-4"), parsed: { side: "vendor", billing: parseCreativExpoWorkbook([creativSheet("4A1", "4A1 EBD", { trojzásuvka: 2 })]) } }));
  assert.equal((await repository.listFiles(checkId)).filter((file) => file.side === "vendor" && file.status === "imported").length, 2);
  assert.equal((await repository.getCheck(checkId))!.status, "in_progress", "první import posune kontrolu z „Nová“");
});

test("IMPORT: šablonové řádky se uloží jako originál, do porovnání a slovníku jdou jen účtované", async () => {
  const { repository, checkId } = await setup();
  const { file } = await importSettlementFile(repository, vendorRequest(checkId));
  assert.equal(file.summary.itemCount, 4, "3 účtované na 3A17 + 1 na 4C1-2");
  assert.ok(file.summary.templateRowCount > 30);
  assert.equal(file.summary.standCount, 1);
  assert.equal(file.summary.unassignedCount, 2);
  assert.equal(repository.vendorItems.length, file.summary.itemCount + file.summary.templateRowCount, "všechny původní řádky jsou uložené");
  assert.equal((await repository.listVendorItems(checkId, { comparableOnly: true })).length, 4);

  const dictionary = await repository.listMappings(COMPANY.id);
  assert.deepEqual(dictionary.map((mapping) => mapping.sourceText).sort(), ["koberec jiné barvy Kč/1m2", "trojzásuvka", "židle čalouněná"], "slovník dostal jen 3 účtované texty, ne celou šablonu");
  assert.ok(dictionary.every((mapping) => mapping.status === "suggested" && mapping.catalogItemId === null && mapping.origin === "import"), "import nikdy nic nepotvrdí sám");

  const detail = await loadSettlementCheckDetail(repository, checkId);
  assert.equal(detail.results.filter((row) => row.status === "match").length, 0, "bez potvrzeného mapování není žádná shoda");
  assert.equal(detail.results.length, 3, "žádné falešné řádky ze šablony");
  assert.ok(detail.results.every((row) => row.status === "unclear"));
  assert.equal(detail.check.summary!.unassignedVendorSheetCount, 1, "4C1-2 má účtované položky; prázdná šablona „16“ se jako problém nepočítá");

  const sheet = detail.stands.find((stand) => stand.label === "3A17")!;
  const original = await loadSettlementSourceRows(repository, checkId, sheet.id);
  assert.ok(original.length > 10 && original.some((row) => !row.isBilled), "původní list je dohledatelný celý, včetně nevyplněných řádků");
});

test("REPEATED IMPORT: stejný soubor podruhé nic nezduplikuje; stejné jméno s jiným obsahem chce rozhodnutí", async () => {
  const { repository, checkId } = await setup();
  await importSettlementFile(repository, abfRequest(checkId));
  const before = { files: repository.files.length, stands: repository.stands.length, items: repository.abfItems.length };

  await assert.rejects(importSettlementFile(repository, abfRequest(checkId)), (error: unknown) => error instanceof SettlementConflictError && error.code === "duplicate_file");
  await assert.rejects(importSettlementFile(repository, abfRequest(checkId, { fileName: "jiny_nazev.xlsx" })), (error: unknown) => error instanceof SettlementConflictError && error.code === "duplicate_file", "rozhoduje obsah, ne jméno");
  assert.deepEqual({ files: repository.files.length, stands: repository.stands.length, items: repository.abfItems.length }, before, "po odmítnutém importu se nic nezměnilo");

  await assert.rejects(importSettlementFile(repository, abfRequest(checkId, {}, 5)), (error: unknown) => error instanceof SettlementConflictError && error.code === "same_name_file");
  assert.equal(repository.files.length, before.files, "bez volby replace/add se nová verze neuloží");

  const replaced = await importSettlementFile(repository, abfRequest(checkId, { mode: "replace" }, 5));
  assert.equal(replaced.replacedFileIds.length, 1);
  const files = await repository.listFiles(checkId);
  assert.deepEqual(files.map((file) => file.status).sort(), ["imported", "superseded"], "stará verze je označená jako nahrazená, její originál zůstává v databázi");
  assert.equal((await repository.listAbfItems(checkId)).length, before.items, "porovnání čte jen aktuální verzi — položky se nezdvojily");
  assert.equal(repository.abfItems.length, before.items * 2, "původní řádky nahrazené verze jsou stále uložené");
  const chairs = (await repository.listAbfItems(checkId)).find((item) => item.rawName === "ŽIDLE KOVOVÁ ČALOUNĚNÁ")!;
  assert.equal(chairs.quantity, 5);
});

test("IMPORT SAFETY: selhání zápisu nenechá nic po sobě; prázdný soubor se neimportuje; uzavřená kontrola je zamčená", async () => {
  const { repository, checkId } = await setup();
  repository.failNextImport = true;
  await assert.rejects(importSettlementFile(repository, abfRequest(checkId)), /simulated database failure/u);
  assert.deepEqual([repository.files.length, repository.stands.length, repository.abfItems.length], [0, 0, 0]);
  assert.equal((await repository.getCheck(checkId))!.status, "draft");

  await assert.rejects(
    importSettlementFile(repository, abfRequest(checkId, { fingerprint: fingerprint("empty"), parsed: { side: "abf", orders: parseAbfOrdersFromSheetGrid([["jen text"]]) } })),
    (error: unknown) => error instanceof SettlementValidationError && /žádný stánek/u.test(error.message),
  );
  assert.equal(repository.files.length, 0);

  await importSettlementFile(repository, abfRequest(checkId));
  await updateSettlementCheck(repository, checkId, { status: "closed" });
  await assert.rejects(importSettlementFile(repository, vendorRequest(checkId)), SettlementValidationError);
  await assert.rejects(removeSettlementFile(repository, checkId, repository.files[0]!.id), SettlementValidationError);
  await assert.rejects(deleteSettlementCheck(repository, checkId), SettlementValidationError, "uzavřenou kontrolu nelze smazat");
  assert.equal(repository.checks.length, 1);
});

test("MANUAL MAPPINGS: potvrzené mapování přežije přepočet i nový import a platí pro další soubory firmy", async () => {
  const { repository, checkId } = await setup();
  await importSettlementFile(repository, abfRequest(checkId));
  await importSettlementFile(repository, vendorRequest(checkId));
  assert.equal(statusOf(await repository.listResults(checkId), "3A17", "vendor:zidle calounena"), "unclear");

  await confirmBasicMappings(repository);
  await recomputeSettlementCheck(repository, checkId);
  let rows = await repository.listResults(checkId);
  assert.equal(statusOf(rows, "3A17", "item:chair"), "match");
  assert.equal(statusOf(rows, "3A17", "item:carpet"), "match");
  assert.equal(statusOf(rows, "3A17", "item:socket"), "match");
  assert.equal(statusOf(rows, "3A17", "item:parking"), "only_abf");
  assert.equal(rows.find((row) => row.rowKey === "item:parking")!.abfQuantity, 3, "dva řádky parkovací karty sečteny");

  // Recompute twice more + a new vendor file version: the confirmed entries must be untouched.
  await recomputeSettlementCheck(repository, checkId);
  await importSettlementFile(repository, vendorRequest(checkId, { mode: "replace" }, 3));
  const mappings = await repository.listMappings(COMPANY.id);
  assert.equal(mappings.length, 3, "nový import nepřidal duplicitní záznamy");
  assert.ok(mappings.every((mapping) => mapping.status === "confirmed" && mapping.origin === "manual" && mapping.catalogItemId), "import nepřepsal ruční potvrzení zpět na návrh");

  rows = await repository.listResults(checkId);
  const chair = rows.find((row) => row.standKey === "3A17" && row.rowKey === "item:chair")!;
  assert.equal(chair.status, "difference", "nová verze vyúčtování (3 židle) se porovnala bez nového mapování");
  assert.equal(chair.difference, 1);

  await assert.rejects(saveSettlementMapping(repository, { realizationCompanyId: COMPANY.id, sourceText: "regál", catalogItemId: null, unit: null, status: "confirmed" }), SettlementValidationError, "potvrdit lze jen mapování s komponentou");
  await assert.rejects(saveSettlementMapping(repository, { realizationCompanyId: COMPANY.id, sourceText: "regál", catalogItemId: "neexistuje", unit: null, status: "suggested" }), SettlementValidationError);
  await saveSettlementMapping(repository, { realizationCompanyId: "mac", sourceText: "židle čalouněná", catalogItemId: "socket", unit: null, status: "confirmed" });
  assert.equal((await repository.listMappings(COMPANY.id)).find((mapping) => mapping.sourceText === "židle čalouněná")!.catalogItemId, "chair", "stejný text u jiné realizačky je samostatný záznam");
});

test("DECISIONS + STAND ASSIGNMENT: ruční rozhodnutí přežijí přepočet; nepřiřazenou záložku lze přiřadit jen ke skutečnému číslu", async () => {
  const { repository, checkId } = await setup();
  await importSettlementFile(repository, abfRequest(checkId));
  await importSettlementFile(repository, vendorRequest(checkId));
  await confirmBasicMappings(repository);
  await recomputeSettlementCheck(repository, checkId);

  await saveSettlementDecision(repository, { checkId, standKey: "3A17", rowKey: "item:parking", decision: "accepted", note: "parkování řeší ABF" }, { actorName: "Hanz" });
  await assert.rejects(saveSettlementDecision(repository, { checkId, standKey: "3A17", rowKey: "item:parking", decision: "smazat", note: "" }), SettlementValidationError);

  let detail = await loadSettlementCheckDetail(repository, checkId);
  assert.deepEqual(detail.standIndex.map((stand) => [stand.standKey, stand.matchState]), [["3A17", "matched"], ["4C1", "abf_only"]], "4C1 je zatím jen u ABF — záložka 4C1-2 je nepřiřazená");
  const combined = detail.stands.find((stand) => stand.label === "4C1-2")!;
  assert.equal(combined.standKey, null);

  await assert.rejects(assignSettlementStand(repository, checkId, combined.id, "soutěž"), SettlementValidationError, "vymyšlené označení se jako stánek nepřijme");
  await assignSettlementStand(repository, checkId, combined.id, "4C01");
  detail = await loadSettlementCheckDetail(repository, checkId);
  assert.equal(detail.standIndex.find((stand) => stand.standKey === "4C1")!.matchState, "matched");
  assert.equal(statusOf(detail.results, "4C1", "item:socket"), "match", "6 trojzásuvek objednáno i účtováno");
  assert.equal(detail.check.summary!.unassignedVendorSheetCount, 0);

  await importSettlementFile(repository, abfRequest(checkId, { mode: "replace" }, 4));
  detail = await loadSettlementCheckDetail(repository, checkId);
  assert.deepEqual(detail.decisions.map((decision) => [decision.standKey, decision.rowKey, decision.decision, decision.note, decision.createdBy]), [["3A17", "item:parking", "accepted", "parkování řeší ABF", "Hanz"]]);
  assert.ok(detail.results.some((row) => row.standKey === "3A17" && row.rowKey === "item:parking"), "rozhodnutí stále ukazuje na existující řádek");

  await assignSettlementStand(repository, checkId, combined.id, "");
  assert.equal((await loadSettlementCheckDetail(repository, checkId)).check.summary!.unassignedVendorSheetCount, 1, "ruční přiřazení jde zrušit");
});

test("CATALOG NAMES: alternativní název ABF se jen přidává — karta katalogu se nemění a název nevede na dvě komponenty", async () => {
  const { repository, checkId } = await setup();
  const orders = parseAbfOrdersFromSheetGrid([["Stánek", null, null, null, "Číslo dokladu"], ["3A17", null, null, null, null, "V253-1/2026"], ["FIRMA"], ["ŽIDLE ČAL. KOV", null, null, null, null, null, null, null, null, null, null, null, null, 2, "ks"]]);
  await importSettlementFile(repository, abfRequest(checkId, { parsed: { side: "abf", orders } }));
  assert.equal(statusOf(await repository.listResults(checkId), "3A17", "abf:zidle cal. kov"), "unclear");

  const snapshot = JSON.stringify(repository.catalogItems);
  await addCatalogItemName(repository, { catalogItemId: "chair", nameType: "abf_alternative", name: "ŽIDLE ČAL. KOV" });
  await recomputeSettlementCheck(repository, checkId);
  assert.equal(statusOf(await repository.listResults(checkId), "3A17", "item:chair"), "only_abf", "název je teď rozpoznaný jako židle");
  assert.equal(JSON.stringify(repository.catalogItems), snapshot, "kódy ani názvy katalogu se nezměnily");

  await assert.rejects(addCatalogItemName(repository, { catalogItemId: "socket", nameType: "abf_alternative", name: "židle čal. kov" }), (error: unknown) => error instanceof SettlementConflictError && error.code === "abf_name_taken");
  await assert.rejects(addCatalogItemName(repository, { catalogItemId: "socket", nameType: "abf_alternative", name: "KOBEREC BAREVNÝ" }), (error: unknown) => error instanceof SettlementConflictError, "originální název jiné karty nelze přiřadit jinam");
  await assert.rejects(addCatalogItemName(repository, { catalogItemId: "chair", nameType: "nesmysl", name: "X" }), SettlementValidationError);
  assert.equal(repository.catalogNames.length, 1);
});

test("RULES: pravidlo vzniká jako návrh, aktivuje ho jen jmenovaná osoba a engine používá jen aktivní „mimo rozsah“", async () => {
  const { repository, checkId } = await setup();
  await importSettlementFile(repository, abfRequest(checkId));
  await importSettlementFile(repository, vendorRequest(checkId));
  await confirmBasicMappings(repository);

  const rule = await createSettlementRule(repository, COMPANY.id, { ruleType: "out_of_scope", name: "Parkovací karta — mimo rozsah", explanation: "Parkovací karty vydává ABF, realizačka je neúčtuje.", definition: { catalogItemId: "parking" }, status: "active", verifiedBy: "nikdo" });
  assert.equal(rule.status, "draft", "status ani ověřovatel z požadavku se nikdy nepřevezmou");
  assert.equal(rule.verifiedBy, null);
  await recomputeSettlementCheck(repository, checkId);
  assert.equal(statusOf(await repository.listResults(checkId), "3A17", "item:parking"), "only_abf", "návrh pravidla nic neovlivní");

  await assert.rejects(changeSettlementRuleStatus(repository, rule.id, "active", {}), SettlementValidationError, "bez jména nelze aktivovat");
  const active = await changeSettlementRuleStatus(repository, rule.id, "active", { actorName: "Hanz" }, () => "2026-10-13T10:00:00.000Z");
  assert.deepEqual([active.status, active.verifiedBy, active.verifiedAt], ["active", "Hanz", "2026-10-13T10:00:00.000Z"]);
  await recomputeSettlementCheck(repository, checkId);
  const parking = (await repository.listResults(checkId)).find((row) => row.rowKey === "item:parking")!;
  assert.equal(parking.status, "out_of_scope");
  assert.deepEqual(parking.explanation.ruleIds, [rule.id], "řádek odkazuje na pravidlo, které ho změnilo");
  assert.match(parking.explanation.reasons[0]!, /Parkovací karta — mimo rozsah/u);

  await changeSettlementRuleStatus(repository, rule.id, "disabled");
  await recomputeSettlementCheck(repository, checkId);
  assert.equal(statusOf(await repository.listResults(checkId), "3A17", "item:parking"), "only_abf");

  const conversion = await createSettlementRule(repository, COMPANY.id, { ruleType: "unit_conversion", name: "Límec v bm", explanation: "Límec ABF objednává v ks, Creativ účtuje v bm.", definition: { from: "ks", to: "bm", factor: 1 } });
  await changeSettlementRuleStatus(repository, conversion.id, "active", { actorName: "Hanz" });
  await recomputeSettlementCheck(repository, checkId);
  assert.equal((await repository.listResults(checkId)).filter((row) => row.explanation.ruleIds.includes(conversion.id)).length, 0, "ostatní typy pravidel se zatím jen evidují");

  assert.throws(() => parseSettlementRuleInput({ ruleType: "out_of_scope", name: "X", explanation: "krátké" }), SettlementValidationError);
  assert.throws(() => parseSettlementRuleInput({ ruleType: "out_of_scope", name: "X", explanation: "Dostatečně dlouhé vysvětlení." }), /komponentu katalogu nebo název/u);
  assert.throws(() => parseSettlementRuleInput({ ruleType: "vymyslene", name: "X", explanation: "Dostatečně dlouhé vysvětlení." }), SettlementValidationError);
});

const HAS_REAL = Object.values(REAL_FILES).every((path) => existsSync(path));

test("REAL END-TO-END: skutečné objednávky ABF + vyúčtování hal 3 a 4 — bez falešných rozdílů, se správnými stánky", { skip: HAS_REAL ? false : "skutečné referenční soubory nejsou v _IMPORT/vyuctovani_creativ/" }, async () => {
  const { repository, checkId } = await setup();
  const real = async (path: string) => fingerprint(readFileSync(path).toString("base64"));
  await importSettlementFile(repository, { checkId, side: "abf", format: "xlsx", fileName: "creativ_stavby.xlsx", fileSize: 1, fingerprint: await real(REAL_FILES.abfXlsx), parsed: { side: "abf", orders: parseAbfOrdersFromSheetGrid((await readSheets(REAL_FILES.abfXlsx))[0]!.rows) } });
  for (const [name, path] of [["Beauty podzim 2026 hala 3.xlsx", REAL_FILES.hall3], ["Beauty podzim 2026 hala 4.xlsx", REAL_FILES.hall4]] as const) {
    await importSettlementFile(repository, { checkId, side: "vendor", format: "xlsx", fileName: name, fileSize: 1, fingerprint: await real(path), parsed: { side: "vendor", billing: parseCreativExpoWorkbook(await readSheets(path)) } });
  }

  let detail = await loadSettlementCheckDetail(repository, checkId);
  const summary = detail.check.summary!;
  assert.deepEqual([summary.standCount, summary.matchedStandCount, summary.abfOnlyStandCount, summary.vendorOnlyStandCount], [43, 37, 5, 1]);
  assert.deepEqual(detail.standIndex.filter((stand) => stand.matchState === "abf_only").map((stand) => stand.displayNumber), ["4A09", "4A25", "4B07", "4C01", "4C02"]);
  assert.deepEqual(detail.standIndex.filter((stand) => stand.matchState === "vendor_only").map((stand) => stand.standKey), ["3B9"]);
  assert.equal(summary.unassignedVendorSheetCount, 3, "ostatní (hala 3), ostatní (hala 4), 4C1-2");
  assert.equal(summary.unassignedAbfStandCount, 0);

  assert.ok(repository.vendorItems.length > 5000, "celé šablony jsou uložené jako originál");
  assert.equal(detail.vendorItems.length, 242, "do porovnání jde jen 242 skutečně účtovaných řádků (108 hala 3 + 134 hala 4)");
  assert.equal(detail.abfItems.length, 485);
  assert.equal(summary.rowCounts.difference, 0, "bez potvrzených mapování nevznikne jediný falešný rozdíl");
  assert.equal(summary.rowCounts.match, 0);

  // Confirm the two Creativ texts used on 3A17 — the stand's real billing then matches the order.
  await confirmBasicMappings(repository);
  await recomputeSettlementCheck(repository, checkId);
  detail = await loadSettlementCheckDetail(repository, checkId);
  assert.equal(statusOf(detail.results, "3A17", "item:carpet"), "match", "KOBEREC BAREVNÝ 9 m² = koberec jiné barvy 9 m²");
  assert.equal(statusOf(detail.results, "3A17", "item:socket"), "match");
  const carpet = detail.results.find((row) => row.standKey === "3A17" && row.rowKey === "item:carpet")!;
  const source = detail.vendorItems.find((item) => item.id === carpet.vendorLineIds[0])!;
  assert.deepEqual([source.sourceSheet, source.sourceRow, source.rawName], ["3A17", 20, "koberec jiné barvy Kč/1m2"], "řádek je dohledatelný do původní záložky a řádku");
  assert.equal(repository.files.find((file) => file.id === source.fileId)!.fileName, "Beauty podzim 2026 hala 3.xlsx");
});

// --- migration guards -------------------------------------------------------------------------------

async function read(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

const MIGRATION = "supabase/migrations/20261013120000_settlement_checks.sql";
const TABLES = ["catalog_item_names", "settlement_checks", "settlement_import_files", "settlement_stands", "settlement_abf_items", "settlement_vendor_items", "settlement_vendor_mappings", "settlement_vendor_rules", "settlement_results", "settlement_decisions"];

test("MIGRATION: RLS na každé nové tabulce, žádné policy; čistě aditivní — existující tabulky se nemění", async () => {
  const sql = await read(MIGRATION);
  for (const table of TABLES) {
    assert.match(sql, new RegExp(`create table ${table} \\(`, "u"), `${table} is created`);
    assert.match(sql, new RegExp(`alter table ${table} enable row level security;`, "u"), `${table} has RLS enabled`);
  }
  assert.equal([...sql.matchAll(/^create table /gmu)].length, TABLES.length);
  assert.doesNotMatch(sql, /create policy/iu);
  assert.doesNotMatch(sql, /using\s*\(\s*true\s*\)/iu);
  assert.doesNotMatch(sql, /grant\s/iu);
  const altered = [...sql.matchAll(/^alter table (\w+)/gmu)].map((match) => match[1]);
  assert.deepEqual([...new Set(altered)].sort(), [...TABLES].sort(), "ALTER jen na nových tabulkách (zapnutí RLS)");
  assert.doesNotMatch(sql, /^(update|delete from|insert into|drop) /gimu, "žádný backfill ani zásah do existujících dat (KODY.xlsm se neimportuje)");
});

test("MIGRATION: odkazy vedou na existující entity; firma je měkká reference, aby nerozbila import Tiskových ploch", async () => {
  const sql = await read(MIGRATION);
  assert.match(sql, /event_id text not null references events \(id\)/u);
  assert.match(sql, /catalog_item_id uuid not null references catalog_items \(id\)/u);
  assert.doesNotMatch(sql, /references print_surface_realization_companies/u, "tvrdý FK by zablokoval replaceAll() v lib/db/realizationCompanyRepository.supabase.ts");
  for (const duplicate of ["events", "companies", "realization_companies", "stands", "catalog_items", "users"]) assert.doesNotMatch(sql, new RegExp(`create table ${duplicate} \\(`, "u"));
  assert.match(sql, /constraint settlement_checks_event_company_key unique \(event_id, realization_company_id\)/u);
  assert.match(sql, /unique index settlement_import_files_active_fingerprint_key on settlement_import_files \(check_id, side, fingerprint\) where status in \('importing', 'imported'\)/u);
  assert.match(sql, /constraint settlement_vendor_mappings_company_text_key unique \(realization_company_id, normalized_text\)/u);
  assert.match(sql, /constraint settlement_vendor_rules_active_is_verified check \(status <> 'active' or \(verified_at is not null and verified_by is not null\)\)/u);
  assert.match(sql, /constraint settlement_decisions_row_key unique \(check_id, stand_key, row_key\)/u);
});

test("MIGRATION: check constraints odpovídají doménovým výčtům", async () => {
  const sql = await read(MIGRATION);
  const sources = { check: await read("domain/settlementCheck.ts"), rules: await read("domain/settlementRules.ts") };
  const cases: readonly (readonly [keyof typeof sources, string, string, string])[] = [
    ["check", "SETTLEMENT_CHECK_STATUSES", "settlement_checks", "status"],
    ["check", "SETTLEMENT_FILE_STATUSES", "settlement_import_files", "status"],
    ["check", "SETTLEMENT_SIDES", "settlement_import_files", "side"],
    ["check", "SETTLEMENT_FILE_FORMATS", "settlement_import_files", "format"],
    ["check", "SETTLEMENT_RESULT_STATUSES", "settlement_results", "status"],
    ["check", "SETTLEMENT_MAPPING_STATUSES", "settlement_vendor_mappings", "status"],
    ["check", "SETTLEMENT_ORIGINS", "settlement_vendor_mappings", "origin"],
    ["check", "CATALOG_NAME_TYPES", "catalog_item_names", "name_type"],
    ["check", "SETTLEMENT_DECISIONS", "settlement_decisions", "decision"],
    ["rules", "SETTLEMENT_RULE_TYPES", "settlement_vendor_rules", "rule_type"],
    ["rules", "SETTLEMENT_RULE_STATUSES", "settlement_vendor_rules", "status"],
  ];
  for (const [file, constant, table, column] of cases) {
    const values = [...new RegExp(`${constant} = \\[([^\\]]+)\\]`, "u").exec(sources[file])![1]!.matchAll(/"([a-z_0-9]+)"/gu)].map((match) => match[1]);
    const tableSql = new RegExp(`create table ${table} \\(([\\s\\S]*?)\\n\\);`, "u").exec(sql)![1]!;
    const check = new RegExp(`\\n  ${column} text[^\\n]*check \\(${column} in \\(([^)]+)\\)\\)`, "u").exec(tableSql);
    assert.ok(check, `${table}.${column} check constraint`);
    assert.deepEqual([...check![1]!.matchAll(/'([a-z_0-9]+)'/gu)].map((match) => match[1]), values, `${table}.${column} = ${constant}`);
  }
});

// --- API + UI guards ---------------------------------------------------------------------------------

const SECRET = "settlement-checks-test-session-secret-32chars";
(process.env as Record<string, string | undefined>).APP_SESSION_SECRET = SECRET;

function request(token: string | undefined, url: string, init: Readonly<{ body?: unknown; form?: FormData }> = {}) {
  const headers: Record<string, string> = {};
  if (token) headers.Cookie = `homeworkstudio_session=${token}`;
  if (init.form) return new NextRequest(url, { method: "POST", headers, body: init.form });
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  return new NextRequest(url, { method: init.body !== undefined ? "POST" : "GET", headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
}

function dependencies(repository: MemorySettlementRepository, sheets: readonly VendorSheetGrid[] = []): SettlementApiDependencies {
  return {
    repository: () => repository,
    resolveEventId: () => async (eventId) => (eventId === "for-beauty-podzim-2026" ? { ok: true, eventId } : { ok: false, message: "Vybraný veletrh neexistuje." }),
    listCompanies: async () => [{ id: COMPANY.id, name: COMPANY.name, isActive: true }],
    readWorkbookSheets: async () => sheets,
  };
}

test("API: bez přihlášení 401; kontrola jen pro existující akci a existující realizační firmu", async () => {
  const repository = new MemorySettlementRepository();
  const deps = dependencies(repository);
  assert.equal((await handleSettlementList(request(undefined, "http://localhost/api/settlement-checks/list"), deps)).status, 401);
  assert.equal((await handleSettlementCreate(request(undefined, "http://localhost/api/settlement-checks/create", { body: {} }), deps)).status, 401);
  assert.equal((await handleSettlementImport(request(undefined, "http://localhost/api/settlement-checks/import", { form: new FormData() }), deps)).status, 401);

  const token = await createSessionToken(SECRET);
  const create = (body: unknown) => handleSettlementCreate(request(token, "http://localhost/api/settlement-checks/create", { body }), deps);
  assert.equal((await create({ eventId: "neexistuje", realizationCompanyId: COMPANY.id })).status, 400);
  assert.equal((await create({ eventId: "for-beauty-podzim-2026", realizationCompanyId: "vymyslena-firma" })).status, 400, "modul realizační firmy nezakládá");
  assert.equal(repository.checks.length, 0);

  const created = await create({ eventId: "for-beauty-podzim-2026", realizationCompanyId: COMPANY.id, actorName: "Hanz" });
  assert.equal(created.status, 200);
  const { check } = (await created.json()) as { check: { id: string; realizationCompanyName: string } };
  assert.equal(check.realizationCompanyName, "Creativ Expo", "název firmy se bere z databáze, ne z požadavku");
  const again = await create({ eventId: "for-beauty-podzim-2026", realizationCompanyId: COMPANY.id });
  assert.equal(again.status, 409);
  assert.equal(((await again.json()) as { code: string }).code, "check_exists");
  assert.equal((await handleSettlementGet(request(token, "http://localhost/api/settlement-checks/get?id=neexistuje"), deps)).status, 404);
});

test("API IMPORT: otisk souboru se počítá na serveru z bajtů; opakované nahrání vrátí 409 a nic nepřidá; PDF potřebuje text", async () => {
  const repository = new MemorySettlementRepository();
  repository.catalogItems = [...CATALOG];
  const check = await createSettlementCheck(repository, { eventId: "for-beauty-podzim-2026", realizationCompanyId: COMPANY.id, realizationCompanyName: COMPANY.name });
  const deps = dependencies(repository, [creativSheet("3A17", "3A17 Vystavovatel A s.r.o.", { trojzásuvka: 1 })]);
  const token = await createSessionToken(SECRET);
  const upload = (name: string, content: string, extra: Record<string, string> = {}) => {
    const form = new FormData();
    form.set("file", new File([content], name));
    form.set("checkId", check.id);
    form.set("side", extra.side ?? "vendor");
    for (const [key, value] of Object.entries(extra)) form.set(key, value);
    return handleSettlementImport(request(token, "http://localhost/api/settlement-checks/import", { form }), deps);
  };

  const first = await upload("hala 3.xlsx", "bytes-A");
  assert.equal(first.status, 200);
  assert.equal(((await first.json()) as { file: { fingerprint: string } }).file.fingerprint, createHash("sha256").update("bytes-A").digest("hex"));

  const duplicate = await upload("hala 3 kopie.xlsx", "bytes-A");
  assert.equal(duplicate.status, 409);
  assert.equal(((await duplicate.json()) as { code: string }).code, "duplicate_file");
  const sameName = await upload("hala 3.xlsx", "bytes-B");
  assert.equal(((await sameName.json()) as { code: string }).code, "same_name_file");
  assert.equal(repository.files.length, 1);
  assert.equal((await upload("hala 3.xlsx", "bytes-B", { mode: "replace" })).status, 200);

  assert.equal((await upload("vyuctovani.docx", "x")).status, 400, "nepodporovaný typ souboru");
  assert.equal((await upload("vyuctovani.pdf", "x")).status, 400, "vyúčtování realizačky jen z XLSX");
  assert.equal((await upload("objednavky.pdf", "x", { side: "abf" })).status, 400, "PDF bez extrahovaného textu");
  const pdf = await upload("objednavky.pdf", "pdf-bytes", { side: "abf", pdfTextItems: JSON.stringify([
    { str: "Stánek", page: 1, x: 28, y: 720, width: 20, height: 8 }, { str: "Číslo dokladu", page: 1, x: 113, y: 720, width: 40, height: 8 },
    { str: "3A17", page: 1, x: 28, y: 700, width: 20, height: 8 }, { str: "V253-206/2026", page: 1, x: 116, y: 700, width: 50, height: 8 },
    { str: "VYSTAVOVATEL A s.r.o.", page: 1, x: 28, y: 688, width: 50, height: 8 },
    { str: "TROJZÁSUVKA", page: 1, x: 28, y: 676, width: 50, height: 8 }, { str: "1,0 ks", page: 1, x: 244, y: 676, width: 20, height: 8 },
    { broken: true },
  ]) });
  assert.equal(pdf.status, 200);
  assert.equal((await repository.listAbfItems(check.id)).length, 1);
});

test("API RULES: „mimo rozsah“ z řádku se aktivuje jen se jménem autora", async () => {
  const repository = new MemorySettlementRepository();
  repository.catalogItems = [...CATALOG];
  const deps = dependencies(repository);
  const token = await createSessionToken(SECRET);
  const body = { action: "create", realizationCompanyId: COMPANY.id, activate: true, rule: { ruleType: "out_of_scope", name: "Parkovací karta — mimo rozsah", explanation: "Parkovací karty vydává ABF.", definition: { catalogItemId: "parking" } } };
  const anonymous = await handleSettlementRulesPost(request(token, "http://localhost/api/settlement-checks/rules", { body }), deps);
  assert.equal(anonymous.status, 400);
  assert.equal(repository.rules[0]!.status, "draft", "bez jména zůstane jen neaktivní návrh");
  const named = await handleSettlementRulesPost(request(token, "http://localhost/api/settlement-checks/rules", { body: { ...body, actorName: "Hanz" } }), deps);
  assert.equal(named.status, 200);
  assert.deepEqual([repository.rules[1]!.status, repository.rules[1]!.verifiedBy], ["active", "Hanz"]);
});

test("UI: položka „Kontrola vyúčtování“ v navigaci, stránka v BoothGenerator, filtry a žádné AI volání", async () => {
  const sidebar = await read("components/AppSidebar.tsx");
  assert.match(sidebar, /\{ section: "settlementChecks", icon: "[^"]+", label: "Kontrola vyúčtování"/u);
  assert.match(sidebar, /onClick=\{\(\) => onNavigate\?\.\(item\.section\)\}/u);
  const shell = await read("components/BoothGenerator.tsx");
  assert.match(shell, /\{workspaceSection === "settlementChecks" && \(\s*<SettlementChecksPage events=\{adminEvents\}/u);

  const list = await read("components/workflow/settlement/SettlementChecksPage.tsx");
  for (const label of ["+ Nová kontrola", "Realizační firma", "Stav", "Vytvořeno", "Poslední úprava"]) assert.ok(list.includes(label), label);
  const comparison = await read("domain/settlementComparison.ts");
  for (const label of ["Vše", "Shody", "Rozdíly", "Pouze ABF", "Pouze realizačka", "Nejasné položky"]) assert.ok(comparison.includes(`"${label}"`), label);
  const detail = await read("components/workflow/settlement/SettlementCheckDetailPage.tsx");
  for (const label of ["Nepřiřazené / Ostatní", "Potvrdit mapování", "Zobrazit celý původní list", "Původní řádky objednávky ABF", "Původní řádky vyúčtování realizačky", "Nahradit původní verzi"]) assert.ok(detail.includes(label), label);

  for (const path of ["domain/settlementComparison.ts", "domain/settlementService.ts", "domain/settlementRules.ts", "lib/settlement/settlementApi.server.ts"]) {
    assert.doesNotMatch(await read(path), /openai|lib\/ai\/|fetch\(/iu, `${path}: batch 1 nevolá žádné AI ani externí službu`);
  }
});
