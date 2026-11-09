import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createTestSessionToken as createSessionToken } from "./helpers/testAuth.ts";
import {
  createRealizationCompanyId,
  findCompanyByName,
  normalizeCompanyName,
  planAliasChanges,
  realizationReferenceLabel,
  resolveRealizationReference,
  validateRealizationCompanyCard,
} from "../domain/realizationCompanyIdentity.ts";
import type {
  RealizationCompany,
  RealizationCompanyAdminRepository,
  RealizationCompanyAlias,
  RealizationLegacyId,
} from "../domain/realizationCompany.ts";
import { planPrintSurfaceCatalogSync, type PrintSurfaceCatalogSnapshot, type PrintSurfaceCatalogSyncPayload } from "../domain/printSurfaceCatalogSync.ts";
import type { PrintSurfaceExcelImportResult } from "../domain/printSurfaceExcelImport.ts";
import { resolvePrintSurfaceProductionDimension } from "../domain/printSurfaceProductionDimension.ts";
import { resolveTechnicalRealizationGroup } from "../domain/technicalRasterRealization.ts";
import { createProjectRecord, normalizeProjectRecord } from "../domain/project.ts";
import { DEFAULT_REALIZATION_PROFILE_ID, realizationProfiles } from "../data/realizationProfiles.ts";
import { handlePrintSurfaceCatalogSync } from "../lib/printSurfaces/printSurfaceCatalogSyncApi.server.ts";
import { handleRealizationCompaniesList, handleRealizationCompanyCreate, handleRealizationCompanyUpdate } from "../lib/realizationCompanies/realizationCompanyApi.server.ts";

// =========================================================================================
// V1-DATA-02 — one register of realization companies: identity rules, old placeholder ids,
// the non-destructive print-surface catalog sync (B1), the admin API and migration guards.
// =========================================================================================

const SECRET = "realization-companies-test-session-secret-32";
(process.env as Record<string, string | undefined>).APP_SESSION_SECRET = SECRET;

const LEGACY_IDS: readonly RealizationLegacyId[] = [
  { legacyId: "default", kind: "system_no_override" },
  { legacyId: "realization-2", kind: "unresolved" },
  { legacyId: "realization-3", kind: "unresolved" },
  { legacyId: "realization-4", kind: "unresolved" },
];

const CREATIV: RealizationCompany = { id: "creativ-expo", name: "Creativ Expo", legalName: "CREATIV EXPO, s.r.o.", isActive: true, source: "import" };
const GENDAI: RealizationCompany = { id: "gendai", name: "Gendai", isActive: true, source: "import" };
const MACIK: RealizationCompany = { id: "macik", name: "Macík", isActive: true, source: "import" };

async function read(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

/** SQL without `--` comments, so a guard never trips over the explanatory header. */
async function readSqlCode(path: string): Promise<string> {
  return (await read(path)).split("\n").map((line) => line.replace(/--.*$/u, "")).join("\n");
}

function request(token: string | undefined, url: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (token) headers.Cookie = `homeworkstudio_session=${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new NextRequest(url, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

function issuesOf(result: ReturnType<typeof validateRealizationCompanyCard>) {
  return "issues" in result ? result.issues : [];
}

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

test("normalizeCompanyName: diakritika, právní forma a interpunkce se ignorují; Macík a MAC Praha zůstávají různé (A21)", () => {
  assert.equal(normalizeCompanyName("CREATIV EXPO, s.r.o."), normalizeCompanyName("Creativ Expo"));
  assert.equal(normalizeCompanyName("Macík"), "macik");
  assert.notEqual(normalizeCompanyName("MAC Praha, spol. s r.o."), normalizeCompanyName("Macík"));
  // technické rastry používají stejnou funkci a chovají se jako dřív
  assert.equal(resolveTechnicalRealizationGroup("Creative Expo s.r.o."), "creativExpo");
  assert.equal(resolveTechnicalRealizationGroup("MAC Praha, spol. s r.o."), "macPraha");
  assert.equal(resolveTechnicalRealizationGroup("Elseya spol. s r.o."), "ostatni");
});

test("findCompanyByName: přesná shoda přes pracovní, právní název i aktivní alias; neaktivní alias nehledá", () => {
  const aliases: RealizationCompanyAlias[] = [
    { id: "a1", realizationCompanyId: "gendai", alias: "GENDAI, s.r.o.", normalizedAlias: "gendai", kind: "alternative", isActive: true },
    { id: "a2", realizationCompanyId: "macik", alias: "Macík starý", normalizedAlias: normalizeCompanyName("Macík starý"), kind: "historical", isActive: false },
  ];
  const companies = [CREATIV, GENDAI, MACIK];
  assert.equal(findCompanyByName("Creativ Expo s.r.o.", companies, aliases).kind, "one");
  assert.deepEqual(findCompanyByName("CREATIV EXPO, s.r.o.", companies, aliases), { kind: "one", company: CREATIV });
  assert.equal(findCompanyByName("MAC Praha", companies, aliases).kind, "none", "žádné automatické slučování Macík ↔ MAC Praha");
  assert.equal(findCompanyByName("Macík starý", companies, aliases).kind, "none");
});

test("createRealizationCompanyId: stabilní slug, nikdy nekoliduje s existující firmou ani se starými ID", () => {
  assert.equal(createRealizationCompanyId("MAC Praha, spol. s r.o.", []), "mac-praha-spol-s-r-o");
  assert.equal(createRealizationCompanyId("Gendai", ["gendai"]), "gendai-2");
  assert.equal(createRealizationCompanyId("Default", []), "default-2");
  assert.equal(createRealizationCompanyId("Realization 2", [], ["realization-2"]), "realization-2-2");
  assert.equal(createRealizationCompanyId("Ostatní", []), "ostatni-2");
  assert.equal(createRealizationCompanyId("!!!", []), "firma");
});

test("validateRealizationCompanyCard: povinný název, formát IČO/DIČ, IČO a názvy unikátní napříč firmami", () => {
  const context = { companies: [CREATIV, { ...GENDAI, ico: "12345678" }, MACIK], aliases: [] };
  const invalid = validateRealizationCompanyCard({ name: "  ", ico: "12AB", dic: "123", isActive: true }, [], context);
  assert.equal(invalid.ok, false);
  assert.deepEqual(issuesOf(invalid).map((issue) => issue.code), ["EMPTY_NAME", "INVALID_ICO", "INVALID_DIC"]);

  const duplicate = validateRealizationCompanyCard({ name: "Nová", legalName: "Creativ Expo s.r.o.", ico: "1234 5678", isActive: true }, [{ alias: "gendai", kind: "alternative" }], context);
  assert.deepEqual(issuesOf(duplicate).map((issue) => [issue.code, issue.conflictingCompanyId]), [
    ["DUPLICATE_ICO", "gendai"],
    ["NAME_CONFLICT", "creativ-expo"],
    ["ALIAS_CONFLICT", "gendai"],
  ]);

  const own = validateRealizationCompanyCard({ name: "Creativ Expo", legalName: "CREATIV EXPO, s.r.o.", ico: "123", dic: "cz 123 45 678", isActive: true }, [{ alias: "Creative Expo s.r.o.", kind: "alternative" }], { ...context, companyId: "creativ-expo" });
  assert.equal(own.ok, true, "vlastní názvy firmy nejsou konflikt");
  assert.equal(own.ok && own.card.ico, "00000123");
  assert.equal(own.ok && own.card.dic, "CZ12345678");

  const twice = validateRealizationCompanyCard({ name: "X", isActive: true }, [{ alias: "Abc", kind: "alternative" }, { alias: "ABC.", kind: "historical" }], context);
  assert.deepEqual(issuesOf(twice).map((issue) => issue.code), ["DUPLICATE_ALIAS"]);
});

test("planAliasChanges: ponechaný alias se nemění, upravený = deaktivace + nový řádek, odebraný se jen deaktivuje", () => {
  const existing: RealizationCompanyAlias[] = [
    { id: "keep", realizationCompanyId: "gendai", alias: "GENDAI, s.r.o.", normalizedAlias: "gendai", kind: "alternative", isActive: true },
    { id: "edit", realizationCompanyId: "gendai", alias: "Gendaj", normalizedAlias: "gendaj", kind: "historical", isActive: true },
    { id: "drop", realizationCompanyId: "gendai", alias: "Gendai Praha", normalizedAlias: "gendaipraha", kind: "alternative", isActive: true },
    { id: "other", realizationCompanyId: "macik", alias: "Macík s.r.o.", normalizedAlias: "macik", kind: "alternative", isActive: true },
  ];
  const changes = planAliasChanges("gendai", [
    { id: "keep", alias: "GENDAI, s.r.o.", kind: "alternative" },
    { id: "edit", alias: "Gendaj CZ", kind: "historical" },
    { alias: "Gendai Brno", kind: "alternative" },
  ], existing);
  assert.deepEqual(changes.deactivateIds, ["edit", "drop"]);
  assert.deepEqual(changes.insert.map((alias) => [alias.alias, alias.normalizedAlias]), [["Gendaj CZ", "gendajcz"], ["Gendai Brno", "gendaibrno"]]);
});

// ---------------------------------------------------------------------------
// old placeholder ids (decision A2)
// ---------------------------------------------------------------------------

test("resolveRealizationReference: default = systémový režim bez přepisu (ne firma), realization-2..4 nevyřešené, prázdné = Ostatní / neurčeno", () => {
  const companies = [CREATIV, GENDAI, MACIK];
  assert.deepEqual(resolveRealizationReference("default", companies, LEGACY_IDS), { kind: "system_no_override", legacyId: "default" });
  for (const id of ["realization-2", "realization-3", "realization-4"]) {
    assert.deepEqual(resolveRealizationReference(id, companies, LEGACY_IDS), { kind: "unresolved_legacy", legacyId: id });
  }
  assert.deepEqual(resolveRealizationReference(undefined, companies, LEGACY_IDS), { kind: "unspecified" });
  assert.deepEqual(resolveRealizationReference("creativ-expo", companies, LEGACY_IDS), { kind: "company", company: CREATIV });
  assert.deepEqual(resolveRealizationReference("neco", companies, LEGACY_IDS), { kind: "unknown", id: "neco" });
  assert.equal(realizationReferenceLabel(resolveRealizationReference("", companies, LEGACY_IDS)), "Ostatní / neurčeno");
  assert.notEqual(resolveRealizationReference("default", companies, LEGACY_IDS).kind, "company", "žádný automatický převod default → Creativ Expo");

  const mapped: RealizationLegacyId[] = [...LEGACY_IDS.slice(1), { legacyId: "default", kind: "mapped", realizationCompanyId: "gendai" }];
  assert.deepEqual(resolveRealizationReference("default", companies, mapped), { kind: "company", company: GENDAI, viaLegacyId: "default" }, "potvrzené mapování půjde doplnit jen daty");
});

test("kompatibilita: staré projekty a výchozí hodnoty se nemění, výrobní rozměry se hledají podle uloženého ID beze změny", () => {
  assert.equal(DEFAULT_REALIZATION_PROFILE_ID, "default");
  assert.deepEqual(realizationProfiles.map((profile) => profile.id), ["default", "realization-2", "realization-3", "realization-4"]);
  assert.equal(createProjectRecord({}).realizationProfileId, "default");
  const legacy = normalizeProjectRecord(JSON.parse(JSON.stringify(createProjectRecord({ id: "p-old", realizationProfileId: "realization-3" }))));
  assert.equal(legacy?.realizationProfileId, "realization-3", "dokument projektu si ponechá staré ID");

  const dimensions = [{ realizationCompanyId: "creativ-expo", presetId: "Panel_S_100", status: "available" as const, widthMm: 950, heightMm: 2340 }];
  assert.deepEqual(resolvePrintSurfaceProductionDimension({ realizationCompanyId: "default", presetId: "Panel_S_100" }, dimensions), { status: "not_defined" }, "default nedostane rozměry Creativ Expo");
  assert.equal(resolvePrintSurfaceProductionDimension({ realizationCompanyId: "creativ-expo", presetId: "Panel_S_100" }, dimensions).status, "available");
});

// ---------------------------------------------------------------------------
// print-surface catalog sync (B1)
// ---------------------------------------------------------------------------

function imported(overrides: Partial<PrintSurfaceExcelImportResult> = {}): PrintSurfaceExcelImportResult {
  return {
    companies: [
      { id: "creativ-expo", name: "Creativ Expo", isActive: true },
      { id: "gendai", name: "Gendai", isActive: true },
    ],
    presets: [
      { id: "Panel_S_100", typeId: "panel", name: "Panel stěnový 1 x 2,5 m", isActive: true },
      { id: "Panel_S_50", typeId: "panel", name: "Panel stěnový 0,5 x 2,5 m", isActive: true },
    ],
    productionDimensions: [
      { realizationCompanyId: "creativ-expo", presetId: "Panel_S_100", status: "available", widthMm: 950, heightMm: 2340 },
      { realizationCompanyId: "gendai", presetId: "Panel_S_100", status: "available", widthMm: 972, heightMm: 2395 },
      { realizationCompanyId: "gendai", presetId: "Panel_S_50", status: "unavailable" },
    ],
    issues: [],
    counts: { realizationCompanies: 2, presets: 2, available: 2, unavailable: 1, notDefinedOrIncomplete: 0, warnings: 0, errors: 0 },
    ...overrides,
  } as PrintSurfaceExcelImportResult;
}

const EMPTY: PrintSurfaceCatalogSnapshot = { companies: [], aliases: [], legacyIds: LEGACY_IDS, presets: [], productionDimensions: [] };

function snapshotAfter(result: PrintSurfaceExcelImportResult, extra: Partial<PrintSurfaceCatalogSnapshot> = {}): PrintSurfaceCatalogSnapshot {
  return {
    ...EMPTY,
    companies: result.companies.map((company) => ({ ...company, source: "import" as const })),
    presets: result.presets,
    productionDimensions: result.productionDimensions,
    ...extra,
  };
}

test("sync: první import do prázdné DB všechno založí, nic nemaže", () => {
  const plan = planPrintSurfaceCatalogSync(imported(), EMPTY);
  assert.equal(plan.canApply, true);
  assert.deepEqual(plan.companies.map((company) => [company.action, company.id]), [["create", "creativ-expo"], ["create", "gendai"]]);
  assert.deepEqual(plan.presets, { create: 2, update: 0, unchanged: 0 });
  assert.deepEqual(plan.productionDimensions, { create: 3, update: 0, unchanged: 0 });
  assert.deepEqual(plan.payload.deactivateCompanyIds, []);
  assert.deepEqual(plan.payload.deactivatePresetIds, []);
});

test("sync: opakovaný import stejného souboru = vše beze změny, žádná nová firma (vazby úkolů a projektů zůstanou)", () => {
  const plan = planPrintSurfaceCatalogSync(imported(), snapshotAfter(imported()));
  assert.deepEqual(plan.companies.map((company) => [company.action, company.id]), [["existing", "creativ-expo"], ["existing", "gendai"]]);
  assert.deepEqual(plan.payload.companies, []);
  assert.deepEqual(plan.presets, { create: 0, update: 0, unchanged: 2 });
  assert.deepEqual(plan.productionDimensions, { create: 0, update: 0, unchanged: 3 });
});

test("sync: přejmenovaný sloupec v Excelu se přiřadí k existující firmě podle právního názvu nebo aliasu — žádná duplicitní firma", () => {
  const renamed = imported({
    companies: [{ id: "creativ-expo,-s.r.o.", name: "CREATIV EXPO, s.r.o.", isActive: true }, { id: "gendai-sro", name: "Gendai sro", isActive: true }],
    productionDimensions: [
      { realizationCompanyId: "creativ-expo,-s.r.o.", presetId: "Panel_S_100", status: "available", widthMm: 960, heightMm: 2340 },
      { realizationCompanyId: "gendai-sro", presetId: "Panel_S_100", status: "available", widthMm: 972, heightMm: 2395 },
    ],
  });
  const current = snapshotAfter(imported(), {
    companies: [{ ...CREATIV }, { ...GENDAI }],
    aliases: [{ id: "a1", realizationCompanyId: "gendai", alias: "Gendai sro", normalizedAlias: normalizeCompanyName("Gendai sro"), kind: "alternative", isActive: true }],
  });
  const plan = planPrintSurfaceCatalogSync(renamed, current);
  assert.equal(plan.canApply, true);
  assert.deepEqual(plan.companies.map((company) => [company.action, company.id, company.action === "existing" && company.matchedBy]), [["existing", "creativ-expo", "name"], ["existing", "gendai", "name"]]);
  assert.deepEqual(plan.payload.companies, []);
  assert.deepEqual(plan.payload.productionDimensions.map((dimension) => dimension.realizationCompanyId), ["creativ-expo", "gendai"]);
  assert.deepEqual(plan.productionDimensions, { create: 0, update: 1, unchanged: 1 });
  assert.equal(plan.keptDimensionCount, 1, "rozměr, který v souboru chybí, zůstává");
});

test("sync: sloupec odpovídající dvěma firmám, dva sloupce jedné firmy nebo vyhrazené ID blokují zápis", () => {
  const ambiguous = planPrintSurfaceCatalogSync(imported({ companies: [{ id: "x", name: "Expo", isActive: true }], productionDimensions: [] }), {
    ...EMPTY,
    companies: [{ id: "a", name: "Expo", isActive: true }, { id: "b", name: "B", legalName: "Expo s.r.o.", isActive: true }],
  });
  assert.equal(ambiguous.canApply, false);
  assert.equal(ambiguous.issues[0]?.code, "AMBIGUOUS_COMPANY");

  const twoColumns = planPrintSurfaceCatalogSync(imported({ companies: [{ id: "creativ-expo", name: "Creativ Expo", isActive: true }, { id: "creative-expo-sro", name: "CREATIV EXPO s.r.o.", isActive: true }], productionDimensions: [] }), snapshotAfter(imported()));
  assert.equal(twoColumns.canApply, false);
  assert.equal(twoColumns.issues[0]?.code, "DUPLICATE_COMPANY_COLUMN");

  const reserved = planPrintSurfaceCatalogSync(imported({ companies: [{ id: "default", name: "Default", isActive: true }], productionDimensions: [] }), EMPTY);
  assert.equal(reserved.canApply, false);
  assert.equal(reserved.issues[0]?.code, "RESERVED_COMPANY_ID");

  const withErrors = planPrintSurfaceCatalogSync(imported({ counts: { ...imported().counts, errors: 1 } }), EMPTY);
  assert.equal(withErrors.canApply, false);
});

test("sync: chybějící presety a firmy zůstávají; deaktivace jen na vyžádání a nikdy u ručně založené firmy", () => {
  const manual: RealizationCompany = { id: "nova-firma", name: "Nová firma", isActive: true, source: "manual" };
  const macik: RealizationCompany = { ...MACIK };
  const current = snapshotAfter(imported(), {
    companies: [CREATIV, GENDAI, macik, manual],
    presets: [...imported().presets, { id: "Stary_preset", typeId: "panel", name: "Starý", isActive: true }],
  });
  const keep = planPrintSurfaceCatalogSync(imported(), current);
  assert.deepEqual(keep.missingPresetIds, ["Stary_preset"]);
  assert.deepEqual(keep.missingCompanyIds, ["macik", "nova-firma"]);
  assert.deepEqual(keep.payload.deactivatePresetIds, []);
  assert.deepEqual(keep.payload.deactivateCompanyIds, []);

  const deactivate = planPrintSurfaceCatalogSync(imported(), current, { deactivateMissingPresets: true, deactivateMissingCompanies: true });
  assert.deepEqual(deactivate.payload.deactivatePresetIds, ["Stary_preset"]);
  assert.deepEqual(deactivate.payload.deactivateCompanyIds, ["macik"], "ruční firma se synchronizací nikdy nedeaktivuje");
});

test("sync: existující karta firmy se z Excelu nepřepisuje; neaktivní firma dostane varování, ne blokaci", () => {
  const edited: RealizationCompany = { ...CREATIV, name: "Creativ Expo (stavby)", isActive: false };
  const plan = planPrintSurfaceCatalogSync(imported(), snapshotAfter(imported(), { companies: [edited, GENDAI] }));
  assert.equal(plan.canApply, true);
  assert.deepEqual(plan.payload.companies, [], "sync nikdy neposílá update karty");
  assert.deepEqual(plan.issues.map((issue) => [issue.severity, issue.code]), [["warning", "INACTIVE_COMPANY"]]);
});

// ---------------------------------------------------------------------------
// API handlers (fake dependencies — never a live database)
// ---------------------------------------------------------------------------

test("API sync: preview nic nezapíše, apply zapíše plán přepočítaný na serveru, blokující chyba = 409 bez zápisu", async () => {
  const token = await createSessionToken(SECRET);
  const applied: PrintSurfaceCatalogSyncPayload[] = [];
  const dependencies = {
    loadSnapshot: async () => EMPTY,
    apply: async (payload: PrintSurfaceCatalogSyncPayload) => {
      applied.push(payload);
      return { companiesCreated: payload.companies.length, presetsWritten: 2, dimensionsWritten: 3, companiesDeactivated: 0, presetsDeactivated: 0 };
    },
  };
  const url = "http://localhost/api/print-surfaces/catalog/sync";

  assert.equal((await handlePrintSurfaceCatalogSync(request(undefined, url, { mode: "preview", imported: imported() }), dependencies)).status, 401);

  const preview = await handlePrintSurfaceCatalogSync(request(token, url, { mode: "preview", imported: imported() }), dependencies);
  assert.equal(preview.status, 200);
  assert.equal(applied.length, 0);

  const apply = await handlePrintSurfaceCatalogSync(request(token, url, { mode: "apply", imported: imported() }), dependencies);
  assert.equal(apply.status, 200);
  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0]!.companies.map((company) => company.id), ["creativ-expo", "gendai"]);

  const blocked = await handlePrintSurfaceCatalogSync(request(token, url, { mode: "apply", imported: imported({ companies: [{ id: "default", name: "Default", isActive: true }] }) }), dependencies);
  assert.equal(blocked.status, 409);
  assert.equal(applied.length, 1);
});

function fakeCompanyRepository(seed: readonly RealizationCompany[], seedAliases: readonly RealizationCompanyAlias[] = []): RealizationCompanyAdminRepository & { companies: RealizationCompany[]; aliases: RealizationCompanyAlias[] } {
  const companies = [...seed];
  const aliases = [...seedAliases];
  return {
    companies,
    aliases,
    async list() { return companies; },
    async listAliases() { return aliases; },
    async listLegacyIds() { return LEGACY_IDS; },
    async create(company) { companies.push(company); return company; },
    async update(company) {
      const index = companies.findIndex((candidate) => candidate.id === company.id);
      companies[index] = company;
      return company;
    },
    async saveAliases(changes) {
      for (const id of changes.deactivateIds) {
        const index = aliases.findIndex((alias) => alias.id === id);
        aliases[index] = { ...aliases[index]!, isActive: false };
      }
      changes.insert.forEach((alias, index) => aliases.push({ ...alias, id: `new-${aliases.length + index}` }));
    },
  };
}

test("API firmy: ruční založení dostane stabilní ID a zdroj manual; duplicitní název/IČO je 422 a nic nezaloží", async () => {
  const token = await createSessionToken(SECRET);
  const repository = fakeCompanyRepository([CREATIV, GENDAI, MACIK]);
  const dependencies = { repository: () => repository };
  const url = "http://localhost/api/realization-companies";

  const created = await handleRealizationCompanyCreate(request(token, url, { card: { name: "MAC Praha", legalName: "MAC Praha, spol. s r.o.", ico: "12345678" }, aliases: [{ alias: "MAC", kind: "alternative" }] }), dependencies);
  assert.equal(created.status, 201);
  const body = await created.json() as { company: RealizationCompany };
  assert.equal(body.company.id, "mac-praha");
  assert.equal(body.company.source, "manual");
  assert.deepEqual(repository.aliases.map((alias) => [alias.realizationCompanyId, alias.alias]), [["mac-praha", "MAC"]]);
  assert.equal(repository.companies.find((company) => company.id === "macik")?.name, "Macík", "Macík zůstává samostatnou firmou (A21)");

  const duplicate = await handleRealizationCompanyCreate(request(token, url, { card: { name: "CREATIV EXPO s.r.o." } }), dependencies);
  assert.equal(duplicate.status, 422);
  const duplicateIco = await handleRealizationCompanyCreate(request(token, url, { card: { name: "Jiná firma", ico: "12345678" } }), dependencies);
  assert.equal(duplicateIco.status, 422);
  assert.equal(repository.companies.length, 4);
});

test("API firmy: úprava karty zachová ID i zdroj; neznámá firma = 404; výpis vrací i historické identifikátory", async () => {
  const token = await createSessionToken(SECRET);
  const repository = fakeCompanyRepository([CREATIV, GENDAI]);
  const dependencies = { repository: () => repository };

  const updated = await handleRealizationCompanyUpdate(request(token, "http://localhost/api/realization-companies/update", { id: "creativ-expo", card: { name: "Creativ Expo", abraName: "CREATIV EXPO", isActive: false } }), dependencies);
  assert.equal(updated.status, 200);
  const company = repository.companies.find((candidate) => candidate.id === "creativ-expo")!;
  assert.equal(company.abraName, "CREATIV EXPO");
  assert.equal(company.isActive, false);
  assert.equal(company.source, "import");

  const missing = await handleRealizationCompanyUpdate(request(token, "http://localhost/api/realization-companies/update", { id: "neni", card: { name: "X" } }), dependencies);
  assert.equal(missing.status, 404);

  const list = await handleRealizationCompaniesList(request(token, "http://localhost/api/realization-companies"), dependencies);
  const listed = await list.json() as { legacyIds: RealizationLegacyId[] };
  assert.deepEqual(listed.legacyIds.map((legacy) => legacy.legacyId), ["default", "realization-2", "realization-3", "realization-4"]);
});

test("API firmy: žádná trasa pro mazání firem neexistuje", () => {
  for (const path of ["app/api/realization-companies/delete/route.ts", "app/api/realization-companies/[id]/route.ts"]) {
    assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), false, path);
  }
});

// ---------------------------------------------------------------------------
// migrations
// ---------------------------------------------------------------------------

const UNIFY = "supabase/migrations/20261019120000_realization_companies_unify.sql";
const SYNC = "supabase/migrations/20261019130000_print_surface_catalog_sync.sql";

test("MIGRACE M3: aditivní, bez nové tabulky firem, mazání a změna ID firem zakázané triggerem", async () => {
  const sql = await readSqlCode(UNIFY);
  assert.doesNotMatch(sql, /\bdrop\s/iu);
  assert.doesNotMatch(sql, /\bdelete\s+from\b/iu);
  assert.doesNotMatch(sql, /create table (realization_companies|companies) \(/u, "kanonická tabulka zůstává print_surface_realization_companies (A9)");
  assert.match(sql, /create view realization_companies with \(security_invoker = true\)/u);
  for (const column of ["legal_name text", "abra_name text", "ico text", "dic text", "contacts jsonb", "source text"]) assert.ok(sql.includes(`add column ${column}`), column);
  assert.match(sql, /before delete on print_surface_realization_companies/u);
  assert.match(sql, /before update of id on print_surface_realization_companies/u);
  assert.match(sql, /before delete on realization_company_aliases/u);
  assert.match(sql, /references print_surface_realization_companies \(id\) on delete restrict/u);
});

test("MIGRACE M3: stará ID jsou zapsaná bez firmy — default je systémový režim, realization-2..4 nevyřešené (A2)", async () => {
  const sql = await readSqlCode(UNIFY);
  assert.match(sql, /\('default', 'system_no_override', 'Výchozí/u);
  for (const id of ["realization-2", "realization-3", "realization-4"]) assert.match(sql, new RegExp(`\\('${id}', 'unresolved', '`, "u"));
  assert.doesNotMatch(sql, /'mapped'\s*,\s*'creativ-expo'/u);
  assert.doesNotMatch(sql, /insert into realization_company_legacy_ids[^;]*creativ-expo/u);
  assert.match(sql, /constraint realization_company_legacy_ids_mapped_has_company check \(\(kind = 'mapped'\) = \(realization_company_id is not null\)\)/u);
});

test("MIGRACE: RLS na nových tabulkách bez politik; RPC jen pro service_role", async () => {
  const unify = await readSqlCode(UNIFY);
  const sync = await readSqlCode(SYNC);
  for (const table of ["realization_company_aliases", "realization_company_legacy_ids"]) {
    assert.match(unify, new RegExp(`alter table ${table} enable row level security;`, "u"));
  }
  for (const sql of [unify, sync]) {
    assert.doesNotMatch(sql, /create policy/iu);
    assert.doesNotMatch(sql, /using\s*\(\s*true\s*\)/iu);
  }
  assert.match(sync, /revoke all on function sync_print_surface_catalog\(jsonb, jsonb, jsonb, text\[\], text\[\]\) from public, anon, authenticated;/u);
  assert.match(sync, /grant execute on function sync_print_surface_catalog\(jsonb, jsonb, jsonb, text\[\], text\[\]\) to service_role;/u);
});

test("MIGRACE M4: synchronizace nic nemaže, kartu firmy nepřepisuje a deaktivuje jen importované firmy", async () => {
  const sql = await readSqlCode(SYNC);
  assert.doesNotMatch(sql, /\bdelete\b/iu);
  assert.doesNotMatch(sql, /\btruncate\b/iu);
  assert.match(sql, /insert into print_surface_realization_companies \(id, name, source\)[\s\S]*?on conflict \(id\) do nothing;/u);
  assert.match(sql, /on conflict \(realization_company_id, preset_id\) do update/u);
  assert.match(sql, /where id = any\(p_deactivate_company_ids\) and source = 'import' and is_active;/u);
});
