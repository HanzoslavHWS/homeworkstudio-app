/**
 * End-to-end check of the event administration (V1-DATA-06) against a LOCAL dev server on DEV.
 *
 *   npm run dev                     (in another terminal)
 *   npm run test:event-admin-e2e    [-- --base-url=http://localhost:3000]
 *
 * Safety rules (docs/V1_DATA_DECISIONS.md 8.2 and 9):
 *   - Refuses to run unless .env.local targets the DEV project and the server is on localhost.
 *   - Writes ONLY to the reserved, inactive event `e2e-autotest` (created once; events cannot be
 *     deleted). Every write goes through writeOwnEvent(), which refuses any other event id.
 *   - Other events (e.g. the ZKUŠEBNÍ test event) are only read.
 *   - At the end the event's configuration (firms, paths) is reset to empty, also after a failure.
 *   - Nothing touches a file system: paths are text only.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KNOWN_PRODUCTION_SUPABASE_REFS, supabaseProjectRef } from "../lib/env/supabaseEnvironment.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
if (existsSync(`${root}.env.local`)) process.loadEnvFile(`${root}.env.local`);
const expectedRef = process.env.SUPABASE_EXPECTED_PROJECT_REF?.trim();
const appRef = supabaseProjectRef(process.env.SUPABASE_URL);
if (process.env.NEXT_PUBLIC_APP_ENV?.trim() !== "development" || !expectedRef || appRef !== expectedRef || KNOWN_PRODUCTION_SUPABASE_REFS.includes(appRef)) {
  console.error("✖ Skript běží jen proti DEV (NEXT_PUBLIC_APP_ENV=development, SUPABASE_URL = SUPABASE_EXPECTED_PROJECT_REF, ne produkce).");
  process.exit(1);
}
const baseUrl = (process.argv.find((arg) => arg.startsWith("--base-url="))?.slice("--base-url=".length) ?? "http://localhost:3000").replace(/\/$/u, "");
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/u.test(baseUrl)) {
  console.error("✖ Server musí běžet lokálně (http://localhost:…).");
  process.exit(1);
}

const EVENT_ID = "e2e-autotest";
const log = (...parts: unknown[]) => console.log("•", ...parts);
type Json = Record<string, any>;

function writeOwnEvent(eventId: string): string {
  if (eventId !== EVENT_ID) throw new Error(`Bezpečnostní pojistka: zápis do veletrhu ${eventId} odmítnut (skript smí jen ${EVENT_ID}).`);
  return eventId;
}

async function login(): Promise<string> {
  const form = new FormData();
  form.set("password", process.env.APP_LOGIN_PASSWORD ?? "");
  form.set("next", "/abf");
  const response = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", body: form, redirect: "manual" });
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  if (!cookie.startsWith("homeworkstudio_session=")) throw new Error("Přihlášení selhalo (APP_LOGIN_PASSWORD v .env.local).");
  return cookie;
}

function session(cookie: string) {
  const call = async (method: string, path: string, body?: unknown, expect = 200): Promise<Json> => {
    const response = await fetch(`${baseUrl}${path}`, { method, headers: { cookie, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    const json = text ? (JSON.parse(text) as Json) : {};
    if (response.status !== expect) throw new Error(`${method} ${path} → HTTP ${response.status} (čekáno ${expect}): ${text.slice(0, 300)}`);
    return json;
  };
  return { get: (path: string, expect?: number) => call("GET", path, undefined, expect), post: (path: string, body: unknown, expect?: number) => call("POST", path, body, expect) };
}

const editorA = session(await login());
const editorB = session(await login());

// Reserved event (created once, inactive, with its fixed short code).
let events = (await editorA.get("/api/events/list")).events as Json[];
let own = events.find((event) => event.id === EVENT_ID);
if (!own) {
  own = (await editorA.post("/api/events/save", {
    event: { id: writeOwnEvent(EVENT_ID), slug: EVENT_ID, shortCode: "E2E-AUTOTEST", name: "Automatický test (neměnit ručně)", edition: "", year: 2026, venue: "", deadlines: [], documents: [], priceListIds: [], defaultCurrency: "CZK", active: false },
    expectedRevision: null,
  })).event as Json;
  log("vytvořen vyhrazený neaktivní veletrh", EVENT_ID);
}

const failures: string[] = [];
const resetConfig = async () => {
  const current = await editorA.get(`/api/events/config?eventId=${writeOwnEvent(EVENT_ID)}`);
  let revision = (await editorA.post("/api/events/config", { action: "saveRealization", eventId: writeOwnEvent(EVENT_ID), expectedConfigRevision: current.configRevision, links: [] })).configRevision as number;
  revision = (await editorA.post("/api/events/config", { action: "savePaths", eventId: writeOwnEvent(EVENT_ID), expectedConfigRevision: revision, paths: [] })).configRevision as number;
  return revision;
};

try {
  // ---- card document: typed deadlines, short code fixed, optimistic concurrency ----------------
  events = (await editorA.get("/api/events/list")).events as Json[];
  own = events.find((event) => event.id === EVENT_ID)!;
  const deadlines = [
    { id: "e2e-orders", name: "Objednávky elektro", date: "2026-08-25", kind: "technical", audience: "customer" },
    { id: "e2e-internal", name: "Interní kontrola", date: "2026-08-01", audience: "internal" },
  ];
  const savedA = (await editorA.post("/api/events/save", { event: { ...own, deadlines, eventFrom: "2026-09-15", eventTo: "2026-09-18" }, expectedRevision: own.revision })).event as Json;
  assert.deepEqual(savedA.deadlines.map((deadline: Json) => [deadline.kind ?? "-", deadline.audience ?? "-"]), [["technical", "customer"], ["-", "internal"]]);
  log(`uzávěrky s typem a určením uloženy (revize karty ${own.revision} → ${savedA.revision})`);
  await editorB.post("/api/events/save", { event: { ...own, name: "Přepis editoru B" }, expectedRevision: own.revision }, 409);
  log("karta: druhý editor se starou revizí dostal 409, nic nepřepsal");
  const changed = await editorA.post("/api/events/save", { event: { ...savedA, shortCode: "E2E-AUTOTEST-2" }, expectedRevision: savedA.revision }, 422);
  log(`kód veletrhu: změna odmítnuta — „${changed.error}“`);
  await editorA.post("/api/events/save", { event: { ...savedA, shortCode: "SPATNY KOD" }, expectedRevision: savedA.revision }, 422);

  // ---- realization firms (one list) and folder paths with config revision ----------------------
  const config = await editorA.get(`/api/events/config?eventId=${writeOwnEvent(EVENT_ID)}`);
  const company = (name: string) => (config.companies as Json[]).find((candidate) => candidate.name === name)?.id as string;
  assert.ok(company("Creativ Expo") && company("Gendai") && company("MAC Praha"), "chybí zkušební firmy v DEV");
  const seenByB = config.configRevision as number;
  const links = [
    { realizationCompanyId: company("Gendai"), isDefault: true },
    { realizationCompanyId: company("Creativ Expo"), isDefault: false },
    { realizationCompanyId: company("MAC Praha"), isDefault: false, note: "hala 4" },
  ];
  let revision = (await editorA.post("/api/events/config", { action: "saveRealization", eventId: writeOwnEvent(EVENT_ID), expectedConfigRevision: config.configRevision, links })).configRevision as number;
  const stale = await editorB.post("/api/events/config", { action: "savePaths", eventId: writeOwnEvent(EVENT_ID), expectedConfigRevision: seenByB, paths: [{ role: "event_root", path: "P:\\B" }] }, 409);
  assert.equal(stale.conflict, true);
  log(`firmy: jeden seznam (Gendai výchozí, Creativ, MAC); druhý editor se starou revizí 409 „${stale.error}“`);
  await editorA.post("/api/events/config", { action: "saveRealization", eventId: writeOwnEvent(EVENT_ID), expectedConfigRevision: revision, links: links.map((link) => ({ ...link, isDefault: true })) }, 422);
  log("dvě výchozí realizačky odmítnuty (422)");

  // Standard HomeworkStudio: the root + the nine approved relative subfolders.
  const root = "C:\\HWS_TEST\\E2E_AUTOTEST";
  const standard = [
    { role: "event_root", path: root },
    { role: "documents", path: "00_DOKUMENTY" },
    { role: "working_stands", path: "01_STAVBY" },
    { role: "event_graphics", path: "02_GRAFIKA_AKCE" },
    { role: "contractor_outputs", path: "03_PODKLADY_REALIZACEK" },
    { role: "technical_rasters", path: "04_RASTRY" },
    { role: "event_carpet", path: "05_KOBERCE_AKCE" },
    { role: "abra_imports", path: "06_SJETINY" },
    { role: "issued_orders", path: "07_VYDANA_OBJEDNAVKA" },
    { role: "settlements", path: "08_VYUCTOVANI" },
  ];
  const savedStandard = await editorA.post("/api/events/config", { action: "savePaths", eventId: writeOwnEvent(EVENT_ID), expectedConfigRevision: revision, paths: standard });
  revision = savedStandard.configRevision as number;
  assert.deepEqual((savedStandard.paths as Json[]).map((path) => path.path), standard.map((path) => path.path));
  log("standard uložen:", (savedStandard.paths as Json[]).slice(1).map((path) => path.path).join(", "));

  // Custom: relative, absolute and empty (= root) subfolders.
  const custom = [
    { role: "event_root", path: "c:/HWS_TEST/E2E_AUTOTEST/" },
    { role: "working_stands", path: "VLASTNI/STAVBY" },
    { role: "contractor_outputs", path: "\\\\nas01\\vystupy\\e2e" },
    { role: "documents", path: "" },
  ];
  const savedCustom = await editorA.post("/api/events/config", { action: "savePaths", eventId: writeOwnEvent(EVENT_ID), expectedConfigRevision: revision, paths: custom });
  revision = savedCustom.configRevision as number;
  assert.deepEqual((savedCustom.paths as Json[]).map((path) => `${path.role}=${path.path}`), ["event_root=C:\\HWS_TEST\\E2E_AUTOTEST", "working_stands=VLASTNI\\STAVBY", "contractor_outputs=\\\\nas01\\vystupy\\e2e"]);
  log("vlastní uloženo (prázdné Dokumenty = kořenová složka, neukládá se):", (savedCustom.paths as Json[]).map((path) => `${path.role}=${path.path}`).join(" | "));
  const bad = await editorA.post("/api/events/config", { action: "savePaths", eventId: writeOwnEvent(EVENT_ID), expectedConfigRevision: revision, paths: [{ role: "event_root", path: "P:\\AKCE\\..\\JINAM" }] }, 422);
  log(`nebezpečná cesta odmítnuta: „${bad.error}“`);
  await editorA.post("/api/events/config", { action: "savePaths", eventId: writeOwnEvent(EVENT_ID), expectedConfigRevision: revision, paths: [{ role: "working_stands", path: "C:\\JINDE" }] }, 422);
  log("podsložka bez kořenové složky odmítnuta (prázdný kořen = nenakonfigurováno)");
  const reread = await editorB.get(`/api/events/config?eventId=${writeOwnEvent(EVENT_ID)}`);
  assert.equal((reread.realizationLinks as Json[]).length, 3);
  assert.equal((reread.pathMappings as Json[]).length, 3);
  assert.equal(reread.configRevision, revision);
  log("druhý editor po načtení vidí aktuální stav (3 firmy, kořen + 2 vlastní složky)");

  // ---- read-only checks of the shared ZKUŠEBNÍ event --------------------------------------------
  const shared = await editorA.get("/api/events/config?eventId=zkusebni-v1-data-05", 200);
  log(`ZKUŠEBNÍ veletrh (jen čtení): firmy ${(shared.realizationLinks as Json[]).map((link) => `${(shared.companies as Json[]).find((candidate) => candidate.id === link.realizationCompanyId)?.name}${link.isDefault ? " (výchozí)" : ""}`).join(", ")}; cest ${(shared.pathMappings as Json[]).length}`);
  const register = await editorA.get("/api/price-versions");
  const assigned = (register.assignments as Json[]).filter((assignment) => assignment.eventId === "zkusebni-v1-data-05" && !assignment.replacedAt);
  log(`ZKUŠEBNÍ veletrh: přiřazené verze ceníků ${assigned.length} (beze změny)`);
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  try {
    await resetConfig();
    log(`úklid: nastavení veletrhu ${EVENT_ID} vráceno do prázdného stavu (historie firem zůstává jako neaktivní)`);
  } catch (error) {
    failures.push(`Úklid selhal: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures.length) {
  console.error(`\n✖ ${failures.join("\n✖ ")}`);
  process.exit(1);
}
console.log("\n✔ E2E administrace veletrhů prošlo.");
