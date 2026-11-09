import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createTestSessionToken as createSessionToken } from "./helpers/testAuth.ts";
import {
  buildStandardEventPaths,
  customValuesLostByStandard,
  defaultRealizationCompany,
  inferEventPathMode,
  STANDARD_EVENT_FOLDERS,
  eventDateWarnings,
  eventDeadlineEntries,
  eventShortCodeChangeIssue,
  eventShortCodeIssue,
  legacyRealizationLabel,
  normalizeEventDeadline,
  normalizeEventPaths,
  normalizeEventShortCode,
  parseEventPath,
  resolveEventPath,
  suggestedTaskRealizationCompany,
  validateEventPaths,
  validateRealizationLinks,
  type EventPathMapping,
  type EventRealizationLink,
} from "../domain/eventAdmin.ts";
import { normalizeExhibition, type Exhibition } from "../domain/organizations.ts";
import { eventTaskOverview, taskInputFromContext, type Task } from "../domain/tasks.ts";
import { handleEventConfigRead, handleEventConfigSave, type EventConfigApiDependencies } from "../lib/events/eventConfigApi.server.ts";
import { EventConfigConflictError, type EventConfig, type EventConfigRepository } from "../lib/db/eventConfig.supabase.ts";
import { handleEventsSave } from "../app/api/events/save/route.ts";
import type { PersistedExhibition, RemoteEventRepository } from "../domain/remotePersistence.ts";

// V1-DATA-06 — event administration: one list of realization firms, short code, typed deadlines,
// folder paths for the future Organizer, concurrency of the new sections, migration.

const SECRET = "event-admin-test-session-secret-32";
(process.env as Record<string, string | undefined>).APP_SESSION_SECRET = SECRET;

const COMPANIES = [
  { id: "creativ-expo", name: "Creativ Expo", isActive: true },
  { id: "gendai", name: "Gendai", isActive: true },
  { id: "mac-praha", name: "MAC Praha", isActive: true },
  { id: "stara-firma", name: "Stará firma", isActive: false },
];

// ---------------------------------------------------------------------------------------------
// Folder paths
// ---------------------------------------------------------------------------------------------

test("cesty: P:\\, síťová UNC i relativní; existující názvy s mezerami a diakritikou zůstávají", () => {
  assert.deepEqual(parseEventPath("p:/301-Technická realizace/1_AKCE/AKCE PODZIM 2026/FOR_BEAUTY_2026_podzim/"), { ok: true, kind: "drive", path: "P:\\301-Technická realizace\\1_AKCE\\AKCE PODZIM 2026\\FOR_BEAUTY_2026_podzim" });
  assert.deepEqual(parseEventPath("\\\\nas01\\data\\301-Technická realizace\\1_AKCE"), { ok: true, kind: "unc", path: "\\\\nas01\\data\\301-Technická realizace\\1_AKCE" });
  assert.deepEqual(parseEventPath("03_PODKLADY_REALIZACEK"), { ok: true, kind: "relative", path: "03_PODKLADY_REALIZACEK" });
  assert.deepEqual(parseEventPath("01_STAVBY/Global_Nutrition__Collamedic"), { ok: true, kind: "relative", path: "01_STAVBY\\Global_Nutrition__Collamedic" });
  assert.deepEqual(parseEventPath("c:\\HWS_TEST\\TEST_BEAUTY_2026_P"), { ok: true, kind: "drive", path: "C:\\HWS_TEST\\TEST_BEAUTY_2026_P" });
  assert.deepEqual(parseEventPath("P:"), { ok: true, kind: "drive", path: "P:\\" });
});

test("cesty: odmítne .., zakázané znaky, rezervované názvy, koncovou mezeru/tečku a neúplnou síťovou cestu", () => {
  for (const [raw, pattern] of [
    ["P:\\AKCE\\..\\jinam", /\.\./u],
    ["01_STAVBY\\..", /\.\./u],
    ["P:\\AKCE\\a<b", /nepovoluje/u],
    ["P:\\AKCE\\co:to", /nepovoluje/u],
    ["P:\\AKCE\\CON", /rezervovaný/u],
    ["P:\\AKCE\\lpt1.txt", /rezervovaný/u],
    ["P:\\AKCE\\Složka \\podsložka", /mezerou nebo tečkou/u],
    ["P:\\AKCE\\Složka.\\podsložka", /mezerou nebo tečkou/u],
    ["\\\\server", /\\\\server\\sdílení/u],
    ["\\AKCE", /bez písmene disku/u],
    ["   ", /prázdná/u],
  ] as const) {
    const parsed = parseEventPath(raw);
    assert.equal(parsed.ok, false, raw);
    if (parsed.ok === false) assert.match(parsed.message, pattern, raw);
  }
});

test("složky — standard HomeworkStudio: z kořene přesně schválené relativní podsložky a výsledné cesty", () => {
  const root = "C:\\HWS_TEST\\TEST_BEAUTY_2026_P";
  const standard = buildStandardEventPaths(root);
  assert.deepEqual(standard.map((path) => [path.role, path.path]), [
    ["event_root", root],
    ["documents", "00_DOKUMENTY"],
    ["working_stands", "01_STAVBY"],
    ["event_graphics", "02_GRAFIKA_AKCE"],
    ["contractor_outputs", "03_PODKLADY_REALIZACEK"],
    ["technical_rasters", "04_RASTRY"],
    ["event_carpet", "05_KOBERCE_AKCE"],
    ["abra_imports", "06_SJETINY"],
    ["issued_orders", "07_VYDANA_OBJEDNAVKA"],
    ["settlements", "08_VYUCTOVANI"],
  ]);
  assert.deepEqual(validateEventPaths(standard), {});
  assert.equal(resolveEventPath("working_stands", standard), "C:\\HWS_TEST\\TEST_BEAUTY_2026_P\\01_STAVBY");
  assert.equal(resolveEventPath("settlements", standard), "C:\\HWS_TEST\\TEST_BEAUTY_2026_P\\08_VYUCTOVANI");
  assert.equal(inferEventPathMode(standard), "standard");
  assert.deepEqual(buildStandardEventPaths("  "), [], "prázdný kořen = nenakonfigurováno, žádný disk se nedoplňuje");
  assert.ok(!Object.values(STANDARD_EVENT_FOLDERS).some((name) => /09_PODKLADY|04_VIZUALIZACE|00_PRIHLASKA/u.test(name)), "žádné staré názvy z historických příkladů");
});

test("složky — vlastní nastavení: relativní i úplné cesty, prázdná podsložka = kořenová složka, náhled vždy", () => {
  const custom: EventPathMapping[] = [
    { role: "event_root", path: "P:\\301-Technická realizace\\1_AKCE\\FOR_DECOR_2026" },
    { role: "working_stands", path: "VLASTNI_STAVBY" },
    { role: "contractor_outputs", path: "\\\\nas01\\vystupy\\decor" },
  ];
  assert.deepEqual(validateEventPaths(custom), {});
  assert.equal(resolveEventPath("working_stands", custom), "P:\\301-Technická realizace\\1_AKCE\\FOR_DECOR_2026\\VLASTNI_STAVBY");
  assert.equal(resolveEventPath("contractor_outputs", custom), "\\\\nas01\\vystupy\\decor");
  assert.equal(resolveEventPath("documents", custom), "P:\\301-Technická realizace\\1_AKCE\\FOR_DECOR_2026", "prázdné pole = kořenová složka");
  assert.equal(inferEventPathMode(custom), "custom");
  assert.equal(resolveEventPath("documents", []), undefined, "bez kořene nenakonfigurováno");
  assert.equal(resolveEventPath("event_root", [{ role: "event_root", path: "P:" }]), "P:\\");
  assert.equal(resolveEventPath("documents", [{ role: "event_root", path: "P:" }, { role: "documents", path: "00_DOKUMENTY" }]), "P:\\00_DOKUMENTY", "kořen disku bez zdvojeného lomítka");
  assert.match(validateEventPaths([{ role: "event_root", path: "FOR_DECOR" }]).event_root ?? "", /úplná cesta/u);
  assert.match(validateEventPaths([{ role: "working_stands", path: "C:\\JINDE" }]).working_stands ?? "", /kořenovou složku/u, "bez kořene nelze nic nastavit");
  assert.deepEqual(normalizeEventPaths([{ role: "event_root", path: "p:/akce/" }, { role: "documents", path: "  " }]), [{ role: "event_root", path: "P:\\akce" }], "prázdná podsložka se neukládá");
});

test("složky — zobrazení odpovídá uloženým hodnotám; přepnutí na standard hlásí ručně zadané cesty", () => {
  // The DEV test event as stored on 2026-10-22: every folder written as a full path -> shown as custom, nothing rewritten.
  const stored: EventPathMapping[] = [{ role: "event_root", path: "C:\\HWS_TEST\\TEST_BEAUTY_2026_P" }, ...Object.entries(STANDARD_EVENT_FOLDERS).map(([role, name]) => ({ role: role as EventPathMapping["role"], path: `C:\\HWS_TEST\\TEST_BEAUTY_2026_P\\${name}` }))];
  assert.equal(inferEventPathMode(stored), "custom");
  assert.equal(resolveEventPath("documents", stored), resolveEventPath("documents", buildStandardEventPaths("C:\\HWS_TEST\\TEST_BEAUTY_2026_P")), "stejný výsledek jako standard");
  assert.equal(inferEventPathMode([]), "standard", "nové nastavení začíná standardem");
  assert.equal(inferEventPathMode([{ role: "event_root", path: "P:\\A" }]), "custom", "jen kořen = vlastní (podsložky = kořen)");
  assert.deepEqual(customValuesLostByStandard({ documents: "MOJE", working_stands: "01_STAVBY", settlements: "  " }), ["documents"]);
  assert.deepEqual(customValuesLostByStandard({}), []);
});

// ---------------------------------------------------------------------------------------------
// Realization firms
// ---------------------------------------------------------------------------------------------

test("realizační firmy: jeden seznam, nejvýš jedna výchozí; neznámá nebo zástupná firma je chyba, neaktivní jen upozornění", () => {
  const links: EventRealizationLink[] = [
    { realizationCompanyId: "creativ-expo", isDefault: true },
    { realizationCompanyId: "gendai", isDefault: false },
    { realizationCompanyId: "stara-firma", isDefault: false },
  ];
  const ok = validateRealizationLinks(links, COMPANIES);
  assert.deepEqual(ok.errors, []);
  assert.match(ok.warnings[0] ?? "", /neaktivní/u);
  assert.match(validateRealizationLinks([...links, { realizationCompanyId: "gendai", isDefault: false }], COMPANIES).errors.join(" "), /dvakrát/u);
  assert.match(validateRealizationLinks([{ realizationCompanyId: "gendai", isDefault: true }, { realizationCompanyId: "mac-praha", isDefault: true }], COMPANIES).errors.join(" "), /jen jedna/u);
  assert.match(validateRealizationLinks([{ realizationCompanyId: "default", isDefault: true }], COMPANIES).errors[0] ?? "", /není v evidenci/u, "zástupné „default“ není firma");
  assert.equal(defaultRealizationCompany(links), "creativ-expo");
  assert.equal(defaultRealizationCompany([{ realizationCompanyId: "gendai", isDefault: false }]), undefined, "výchozí je volitelná");
});

test("historická hodnota realizačky se jen popíše, nikdy se nepřevede na firmu", () => {
  assert.equal(legacyRealizationLabel("default", COMPANIES), "Neurčeno (historická hodnota „default“)");
  assert.match(legacyRealizationLabel("realization-2", COMPANIES), /zástupná/u);
  assert.equal(legacyRealizationLabel("gendai", COMPANIES), "Gendai");
  assert.equal(legacyRealizationLabel(undefined, COMPANIES), "Nevyplněno");
  const legacyEvent = normalizeExhibition({ id: "beauty", realizationCompanyId: "default" });
  assert.equal(legacyEvent.realizationCompanyId, "default", "existující data se nepřepisují");
  assert.equal(normalizeExhibition({ id: "nova" }).realizationCompanyId, undefined, "nový veletrh nedostane „default“");
});

test("úkoly: výchozí realizačka jen předvyplní nový úkol; „default“ ani neznámá hodnota nic nepředvyplní", () => {
  const links: EventRealizationLink[] = [{ realizationCompanyId: "gendai", isDefault: true }, { realizationCompanyId: "creativ-expo", isDefault: false }];
  assert.equal(suggestedTaskRealizationCompany(links, "default", COMPANIES), "gendai");
  assert.equal(suggestedTaskRealizationCompany([], "default", COMPANIES), undefined);
  assert.equal(suggestedTaskRealizationCompany([], "creativ-expo", COMPANIES), "creativ-expo", "dřívější chování pro skutečnou firmu zůstává");
  assert.equal(suggestedTaskRealizationCompany([{ realizationCompanyId: "creativ-expo", isDefault: false }], undefined, COMPANIES), undefined, "bez výchozí nic");
  const input = taskInputFromContext({ eventId: "beauty", realizationCompanyId: suggestedTaskRealizationCompany(links, undefined, COMPANIES) });
  assert.equal(input.realizationCompanyId, "gendai", "jen předvyplněná hodnota nového úkolu");
});

// ---------------------------------------------------------------------------------------------
// Short code and deadlines
// ---------------------------------------------------------------------------------------------

test("kód veletrhu: volitelný, formát BEAUTY-2026-P, po uložení neměnný, nic se nedopočítává", () => {
  assert.equal(normalizeEventShortCode(" beauty-2026-p "), "BEAUTY-2026-P");
  assert.equal(normalizeEventShortCode(""), undefined);
  assert.equal(eventShortCodeIssue("BEAUTY-2026-P"), undefined);
  assert.equal(eventShortCodeIssue(undefined), undefined, "nepovinný");
  for (const bad of ["BEAUTY 2026", "BEAUTY--2026", "-BEAUTY", "KRÁSA-2026", "A".repeat(33)]) assert.ok(eventShortCodeIssue(bad), bad);
  assert.equal(eventShortCodeChangeIssue(undefined, "BEAUTY-2026-P"), undefined, "první nastavení je dovolené");
  assert.match(eventShortCodeChangeIssue("BEAUTY-2026-P", "BEAUTY-2026-J") ?? "", /neměnný/u);
  assert.match(eventShortCodeChangeIssue("BEAUTY-2026-P", undefined) ?? "", /neměnný/u);
  assert.equal(normalizeExhibition({ id: "x", name: "FOR BEAUTY podzim 2026" }).shortCode, undefined, "kód se z názvu neodhaduje");
  assert.equal(normalizeExhibition({ id: "x", shortCode: "beauty-2026-p" }).shortCode, "BEAUTY-2026-P");
});

test("uzávěrky: volitelný typ a interní/zákaznická; stabilní odkazy pro budoucí automatické úkoly; neznámé hodnoty se zahodí", () => {
  const event = normalizeExhibition({
    id: "beauty",
    materialDataDeadline: "2026-08-20",
    designApprovalDeadline: "2026-08-10",
    deadlines: [
      { id: "d1", name: "Objednávky elektro", date: "2026-08-25", kind: "technical", audience: "customer" },
      { id: "d2", name: "Interní kontrola", date: "2026-08-01", audience: "internal" },
      { id: "d3", name: "Bez data", date: "" },
      { id: "d4", name: "Starý typ", date: "2026-09-01", kind: "nesmysl" as never },
    ],
  });
  assert.equal(event.deadlines.length, 4, "všechny řádky zůstávají");
  assert.equal(event.deadlines[3]?.kind, undefined, "neznámý typ se zahodí, řádek zůstane");
  assert.deepEqual(eventDeadlineEntries(event).map((entry) => [entry.ref, entry.kind ?? "-", entry.audience ?? "-"]), [
    ["deadline:d2", "-", "internal"],
    ["builtin:designApproval", "design", "customer"],
    ["builtin:materialData", "graphics", "customer"],
    ["deadline:d1", "technical", "customer"],
    ["deadline:d4", "-", "-"],
  ]);
  assert.deepEqual(normalizeEventDeadline({ id: "x" }), { id: "x", name: "", date: "" });
});

test("termíny: obrácené pořadí je jen upozornění", () => {
  assert.deepEqual(eventDateWarnings({ assemblyDate: "2026-09-12", eventFrom: "2026-09-15", eventTo: "2026-09-18", disassemblyDate: "2026-09-19" }), []);
  assert.match(eventDateWarnings({ eventFrom: "2026-09-15", eventTo: "2026-09-14" })[0] ?? "", /Konec/u);
});

// ---------------------------------------------------------------------------------------------
// API: sections with optimistic concurrency
// ---------------------------------------------------------------------------------------------

type ConfigState = { config?: EventConfig; savedLinks: number; savedPaths: number };

function fakeConfigRepository(state: ConfigState): EventConfigRepository {
  const bump = (expected: number) => {
    if (!state.config) throw Object.assign(new Error("Veletrh nebyl nalezen."), { code: "P0002" });
    if (state.config.configRevision !== expected) throw new EventConfigConflictError("Nastavení veletrhu mezitím změnil někdo jiný.", state.config.configRevision);
    state.config = { ...state.config, configRevision: expected + 1 };
    return expected + 1;
  };
  return {
    load: async () => state.config,
    listCompanies: async () => COMPANIES,
    saveRealizationLinks: async (_id, expected, links) => {
      const revision = bump(expected);
      state.config = { ...state.config!, realizationLinks: links };
      state.savedLinks += 1;
      return revision;
    },
    savePathMappings: async (_id, expected, paths) => {
      const revision = bump(expected);
      state.config = { ...state.config!, pathMappings: paths };
      state.savedPaths += 1;
      return revision;
    },
  };
}

function deps(state: ConfigState, authorized = true): EventConfigApiDependencies {
  return { repository: () => fakeConfigRepository(state), isAuthorized: async () => authorized };
}

const request = (path: string, body?: unknown) => new NextRequest(`http://localhost${path}`, body === undefined ? { method: "GET" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function savedEvent(): ConfigState {
  return { config: { eventId: "beauty", configRevision: 3, realizationLinks: [], pathMappings: [] }, savedLinks: 0, savedPaths: 0 };
}

test("API nastavení: neuložený veletrh = 404 s vysvětlením; bez přihlášení 401", async () => {
  const response = await handleEventConfigRead(request("/api/events/config?eventId=event-123"), deps({ savedLinks: 0, savedPaths: 0 }));
  assert.equal(response.status, 404);
  assert.match(((await response.json()) as { error: string }).error, /Nejdřív uložte/u);
  assert.equal((await handleEventConfigRead(request("/api/events/config?eventId=beauty"), deps(savedEvent(), false))).status, 401);
  const ok = await handleEventConfigRead(request("/api/events/config?eventId=beauty"), deps(savedEvent()));
  const body = (await ok.json()) as { configRevision: number; companies: unknown[] };
  assert.deepEqual([body.configRevision, body.companies.length], [3, 4]);
});

test("API nastavení: uložení firem a cest ověří revizi; dva editory — druhý dostane 409 a nic se nezapíše", async () => {
  const state = savedEvent();
  const first = await handleEventConfigSave(request("/api/events/config", { action: "saveRealization", eventId: "beauty", expectedConfigRevision: 3, links: [{ realizationCompanyId: "gendai", isDefault: true }, { realizationCompanyId: "creativ-expo", isDefault: false }] }), deps(state));
  assert.equal(first.status, 200);
  assert.deepEqual(state.config?.realizationLinks, [{ realizationCompanyId: "gendai", isDefault: true }, { realizationCompanyId: "creativ-expo", isDefault: false }], "role se do seznamu nepřenáší");
  assert.equal(((await first.json()) as { configRevision: number }).configRevision, 4);
  const second = await handleEventConfigSave(request("/api/events/config", { action: "savePaths", eventId: "beauty", expectedConfigRevision: 3, paths: [{ role: "event_root", path: "P:\\AKCE" }] }), deps(state));
  assert.equal(second.status, 409);
  const body = (await second.json()) as { conflict: boolean; currentRevision: number };
  assert.deepEqual([body.conflict, body.currentRevision], [true, 4]);
  assert.equal(state.savedPaths, 0);
  const retry = await handleEventConfigSave(request("/api/events/config", { action: "savePaths", eventId: "beauty", expectedConfigRevision: 4, paths: [{ role: "event_root", path: "p:/akce/" }, { role: "working_stands", path: "01_STAVBY" }, { role: "documents", path: "" }] }), deps(state));
  assert.equal(retry.status, 200);
  assert.deepEqual(((await retry.json()) as { paths: EventPathMapping[] }).paths, [{ role: "event_root", path: "P:\\akce" }, { role: "working_stands", path: "01_STAVBY" }]);
});

test("API nastavení: bez revize, se špatnou cestou, se dvěma výchozími nebo se zástupnou firmou je odmítnuto", async () => {
  const state = savedEvent();
  const save = (body: Record<string, unknown>) => handleEventConfigSave(request("/api/events/config", { eventId: "beauty", ...body }), deps(state));
  assert.equal((await save({ action: "savePaths", paths: [] })).status, 422);
  assert.equal((await save({ action: "savePaths", expectedConfigRevision: 3, paths: [{ role: "event_root", path: "P:\\AKCE\\..\\JINAM" }] })).status, 422);
  assert.equal((await save({ action: "savePaths", expectedConfigRevision: 3, paths: [{ role: "neznama", path: "P:\\A" }] })).status, 422);
  assert.equal((await save({ action: "saveRealization", expectedConfigRevision: 3, links: [{ realizationCompanyId: "gendai", isDefault: true }, { realizationCompanyId: "mac-praha", isDefault: true }] })).status, 422);
  assert.equal((await save({ action: "saveRealization", expectedConfigRevision: 3, links: [{ realizationCompanyId: "default", isDefault: true }] })).status, 422);
  assert.equal((await save({ action: "savePaths", expectedConfigRevision: 3, paths: [{ role: "working_stands", path: "C:\\JINDE" }] })).status, 422, "bez kořene");
  assert.equal(state.savedLinks + state.savedPaths, 0);
});

// ---------------------------------------------------------------------------------------------
// Event card save: short code errors
// ---------------------------------------------------------------------------------------------

function fakeEventRepository(error?: unknown): RemoteEventRepository {
  return {
    list: async () => [],
    save: async (event) => event,
    getWithRevision: async () => undefined,
    saveWithRevision: async (event) => {
      if (error) throw error;
      return { ...event, revision: 2 } as PersistedExhibition;
    },
  };
}

async function eventSave(event: Partial<Exhibition>, error?: unknown) {
  const token = await createSessionToken(SECRET);
  const req = new NextRequest("http://localhost/api/events/save", { method: "POST", headers: { "Content-Type": "application/json", cookie: `homeworkstudio_session=${token}` }, body: JSON.stringify({ event: { id: "beauty", ...event }, expectedRevision: 1 }) });
  return handleEventsSave(req, () => fakeEventRepository(error));
}

test("uložení karty: neplatný kód 422; duplicitní kód i pokus o změnu uloženého kódu srozumitelně (ne jako souběh)", async () => {
  assert.equal((await eventSave({ shortCode: "BEAUTY 2026" })).status, 422);
  assert.equal((await eventSave({ shortCode: "BEAUTY-2026-P" })).status, 200);
  const duplicate = await eventSave({ shortCode: "BEAUTY-2026-P" }, { code: "23505", message: 'duplicate key value violates unique constraint "events_short_code_key"' });
  assert.equal(duplicate.status, 422);
  assert.match(((await duplicate.json()) as { error: string }).error, /kód veletrhu už používá/u);
  const changed = await eventSave({ shortCode: "BEAUTY-2026-J" }, { code: "P0001", message: "Kód veletrhu BEAUTY-2026-P je po uložení neměnný. Změna je možná jen řízeným postupem." });
  assert.equal(changed.status, 422);
  assert.match(((await changed.json()) as { error: string }).error, /neměnný/u);
});

// ---------------------------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------------------------

test("migrace V1-DATA-06: jen přidává, nic existujícího nepřepisuje ani nemaže", async () => {
  const migrations = readdirSync(new URL("../supabase/migrations/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(migrations.includes("20261022150000_events_admin.sql"));
  const sql = (await readFile(new URL("../supabase/migrations/20261022150000_events_admin.sql", import.meta.url), "utf8")).toLowerCase();
  assert.doesNotMatch(sql, /drop\s+(table|column|function)|truncate|disable trigger/u);
  assert.doesNotMatch(sql, /update\s+events\s+set\s+(?!config_revision)/u, "jediný update veletrhu je počítadlo revize nastavení");
  assert.doesNotMatch(sql, /update\s+(projects|print_surface|tasks|price_)/u);
  assert.deepEqual([...sql.matchAll(/delete from (\w+)/gu)].map((match) => match[1]), ["event_path_mappings"], "maže se jen odebraná cesta v nastavení");
  assert.match(sql, /create trigger events_prevent_delete before delete on events/u);
  assert.match(sql, /create trigger events_short_code_guard before update on events/u);
  assert.match(sql, /create unique index events_short_code_key on events \(short_code\) where short_code is not null/u);
  assert.match(sql, /create unique index event_realization_companies_default_key on event_realization_companies \(event_id, role\) where is_default and is_active/u);
  assert.match(sql, /references print_surface_realization_companies \(id\)/u, "skutečná evidence firem");
  assert.match(sql, /using errcode = 'p0409'/u);
  for (const table of ["event_realization_companies", "event_path_mappings"]) assert.match(sql, new RegExp(`alter table ${table} enable row level security`, "u"));
  for (const fn of ["save_event_realization_companies", "save_event_path_mappings", "event_config_lock"]) assert.match(sql, new RegExp(`grant execute on function ${fn}\\([^)]*\\) to service_role`, "u"));
  assert.doesNotMatch(sql, /creativ-expo|realization_company_id\s*=\s*'default'|document\s*->>?\s*'realizationcompanyid'/u, "žádný převod historické hodnoty na firmu");
});

test("migrace jednoho seznamu realizaček: poslední, nic nemaže, firmy z jiných rolí přenese, historie zůstane", async () => {
  const migrations = readdirSync(new URL("../supabase/migrations/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();
  // Ordered right after the events admin migration (later stages may add newer migrations after it).
  const index = migrations.indexOf("20261022160000_event_realization_single_list.sql");
  assert.ok(index > 0);
  assert.equal(migrations[index - 1], "20261022150000_events_admin.sql");
  const sql = (await readFile(new URL("../supabase/migrations/20261022160000_event_realization_single_list.sql", import.meta.url), "utf8")).toLowerCase();
  assert.doesNotMatch(sql, /delete\s+from|drop\s+(table|column|function|index)|truncate/u, "nic se nemaže");
  assert.match(sql, /insert into event_realization_companies[\s\S]*'construction'[\s\S]*on conflict \(event_id, realization_company_id, role\) do update set is_active = true/u, "firma z jiné role se přenese do seznamu");
  assert.match(sql, /set is_default = true/u, "výchozí firma se nepoztrácí");
  assert.match(sql, /update event_realization_companies set is_active = false, is_default = false where is_active and role <> 'construction'/u, "staré role zůstanou jako neaktivní historie");
  assert.match(sql, /check \(role = 'construction' or not is_active\)/u);
  assert.doesNotMatch(sql, /update\s+(events|price_\w+|event_price_assignments)\b/u, "historická realizačka ani ceníky se nemění");
  assert.deepEqual([...sql.matchAll(/\bupdate\s+(\w+)/gu)].map((match) => match[1]).filter((target) => target !== "set"), ["event_realization_companies", "event_realization_companies"]);
});

// ---------------------------------------------------------------------------------------------
// Regression (manual test 2026-10-22): a new manual task due in two days was invisible on the event card
// ---------------------------------------------------------------------------------------------

function task(id: string, patch: Partial<Task>): Task {
  return { id, title: id, status: "new", priority: "normal", sourceType: "manual", isAutomatic: false, createdAt: "2026-10-22T10:00:00Z", updatedAt: "2026-10-22T10:00:00Z", ...patch } as Task;
}

test("karta veletrhu: nový ruční úkol s pozdějším termínem i bez termínu je mezi nesplněnými; jiné veletrhy se nemíchají", () => {
  const today = "2026-10-22";
  const tasks = [
    task("test", { title: "test", eventId: "zkusebni-v1-data-05", dueDate: "2026-10-24", categoryId: "graphics", realizationCompanyId: "creativ-expo" }),
    task("bez-terminu", { eventId: "zkusebni-v1-data-05" }),
    task("za-mesic", { eventId: "zkusebni-v1-data-05", dueDate: "2026-11-20", isAutomatic: true, sourceType: "booth_project" as Task["sourceType"] }),
    task("po-terminu", { eventId: "zkusebni-v1-data-05", dueDate: "2026-10-01", status: "in_progress" }),
    task("hotovo", { eventId: "zkusebni-v1-data-05", dueDate: "2026-10-23", status: "done" }),
    task("zruseno", { eventId: "zkusebni-v1-data-05", status: "cancelled" }),
    task("jiny-veletrh", { eventId: "beauty", dueDate: "2026-10-23" }),
  ];
  const overview = eventTaskOverview(tasks, "zkusebni-v1-data-05", today);
  assert.equal(overview.openCount, 4, "nesplněné: test, bez termínu, za měsíc, po termínu");
  assert.deepEqual(overview.nextOpen.map((item) => item.id), ["po-terminu", "test", "za-mesic", "bez-terminu"]);
  assert.equal(overview.counts.thisWeek, 1, "test (so 24. 10.) je v tomto týdnu");
  assert.deepEqual([overview.counts.today, overview.counts.waiting, overview.counts.review], [0, 0, 0], "dřívější čtyři počty ho nezachytily");
  assert.equal(overview.counts.overdue, 1);
  assert.ok(!overview.nextOpen.some((item) => item.eventId !== "zkusebni-v1-data-05"));
  assert.equal(eventTaskOverview(tasks, "zkusebni-v1-data-05", today, 2).nextOpen.length, 2, "seznam má limit, počet ne");
  assert.equal(eventTaskOverview(tasks, "beauty", today).openCount, 1);
  assert.equal(eventTaskOverview([], "zkusebni-v1-data-05", today).openCount, 0);
});
