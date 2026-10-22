/**
 * End-to-end check of the versioned price lists (V1-DATA-05) against a LOCAL dev server on DEV.
 *
 *   npm run dev                      (in another terminal)
 *   npm run test:price-versions-e2e  [-- --base-url=http://localhost:3000]
 *
 * Safety rules (docs/V1_DATA_DECISIONS.md 8.2):
 *   - Refuses to run unless .env.local targets the DEV project (never a production ref) and the
 *     server is on localhost.
 *   - Works ONLY in the dedicated list E2E-AUTOTEST (kept inactive, created once). It never writes
 *     to any other list, version, event or catalog card: every write goes through writeOwn(), which
 *     refuses a version this run did not create.
 *   - Only DRAFT versions labelled with a unique run id are created, and they are deleted in a
 *     finally block, also after a failure. Nothing is published or assigned (both are permanent by
 *     design); those paths are covered by unit tests and the rolled-back SQL test of the migrations.
 *   - Catalog cards are only read (the ZKUŠEBNÍ V1-DATA-04 cards).
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

const LIST_CODE = "E2E-AUTOTEST";
const RUN_ID = `e2e-${new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
const log = (...parts: unknown[]) => console.log("•", ...parts);

type Json = Record<string, any>;

async function login(): Promise<string> {
  const form = new FormData();
  form.set("password", process.env.APP_LOGIN_PASSWORD ?? "");
  form.set("next", "/abf");
  const response = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", body: form, redirect: "manual" });
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  if (!cookie.startsWith("homeworkstudio_session=")) throw new Error("Přihlášení selhalo (APP_LOGIN_PASSWORD v .env.local).");
  return cookie;
}

/** One browser session (an "editor"). */
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

const ownVersions = new Set<string>();

/** The only way this script writes to a version: it must be one this run created. */
function writeOwn(versionId: string): string {
  if (!ownVersions.has(versionId)) throw new Error(`Bezpečnostní pojistka: verze ${versionId} nepatří tomuto běhu (${RUN_ID}), zápis odmítnut.`);
  return versionId;
}

const editorA = session(await login());
const editorB = session(await login());

const register = await editorA.get("/api/price-versions");
const item = (name: string) => {
  const found = (register.items as Json[]).find((candidate) => candidate.displayName === name);
  assert.ok(found, `Chybí zkušební karta „${name}“ (V1-DATA-04).`);
  return found as Json;
};
const chair = item("ZKUŠEBNÍ V1-DATA-04 židle");
const kit = item("ZKUŠEBNÍ V1-DATA-04 komplet");
const grey = item("ZKUŠEBNÍ V1-DATA-04 koberec šedý");
const blue = (register.variantSets as Json[]).flatMap((set) => set.variants as Json[]).find((variant) => variant.code === "CARPET-BLUE");
assert.ok(blue, "Chybí varianta CARPET-BLUE.");

let list = (register.lists as Json[]).find((candidate) => candidate.code === LIST_CODE);
if (!list) {
  list = (await editorA.post("/api/price-versions", { action: "saveList", actor: RUN_ID, list: { code: LIST_CODE, name: "Automatický test (neměnit ručně)", kind: "base", isActive: false, note: "Jen pro scripts/priceVersionsE2E.ts. Koncepty běhů se mažou." } }, 201)).list as Json;
  log("vytvořen vyhrazený neaktivní ceník", LIST_CODE);
}
assert.equal(list.code, LIST_CODE);

const failures: string[] = [];
try {
  // ---- a draft with three prices --------------------------------------------------------------
  const versionId = (await editorA.post("/api/price-versions", { action: "createVersion", priceListId: list.id, actor: RUN_ID }, 201)).versionId as string;
  ownVersions.add(versionId);
  const load = async (editor: ReturnType<typeof session>) => editor.get(`/api/price-versions/rows?versionId=${writeOwn(versionId)}`);
  let state = await load(editorA);
  const header = (rate: number) => ({ label: RUN_ID, eurRate: rate, eurRoundingMode: "ceil", eurRoundingStep: 1 });
  let revision = (await editorA.post("/api/price-versions", { action: "updateVersion", versionId: writeOwn(versionId), expectedRevision: state.version.revision, header: header(24.17) })).revision as number;
  const entries = [
    { catalogItemId: chair.id, saleCzk: "516", eurMode: "derived", saleEurWorld: "29", unitCode: "ks" },
    { catalogItemId: grey.id, saleCzk: "120", eurMode: "derived", saleEurWorld: "6", unitCode: "m2" },
    { catalogItemId: kit.id, saleCzk: "20000", eurMode: "manual", saleEur: "830", saleEurWorld: "900" },
  ];
  const surcharges = [{ targetKind: "variant", variantId: blue.id, amountCzk: "30", eurMode: "derived", amountEurWorld: "2" }];
  revision = (await editorA.post("/api/price-versions/rows", { versionId: writeOwn(versionId), expectedRevision: revision, entries, surcharges })).revision as number;

  const resolve = async (track: string, items: Json[], extra: Json = {}) => editorA.post("/api/price-versions/resolve", { priceTrack: track, baseVersionId: versionId, items, ...extra });
  const three = await Promise.all(["CZK", "EUR_SK", "EUR_WORLD"].map((track) => resolve(track, [{ catalogItemId: chair.id }, { catalogItemId: kit.id }])));
  const amounts = three.map((result) => (result.results as Json[]).map((row) => row.result.amountNet));
  assert.deepEqual(amounts, [[516, 20000], [22, 830], [29, 900]]);
  log("tři ceny: židle 516 Kč / 22 € SK / 29 € WORLD; komplet 20000 Kč / 830 € SK (ruční) / 900 € WORLD");
  await editorA.post("/api/price-versions/resolve", { currency: "EUR", baseVersionId: versionId, items: [{ catalogItemId: chair.id }] }, 400);
  log("výpočet bez výslovného režimu odmítnut");

  revision = (await editorA.post("/api/price-versions", { action: "updateVersion", versionId: writeOwn(versionId), expectedRevision: revision, header: header(25) })).revision as number;
  const afterRate = await Promise.all(["EUR_SK", "EUR_WORLD"].map((track) => resolve(track, [{ catalogItemId: chair.id }, { catalogItemId: kit.id }])));
  assert.deepEqual(afterRate.map((result) => (result.results as Json[]).map((row) => row.result.amountNet)), [[21, 830], [29, 900]]);
  log("kurz 25: EUR SK židle 22 → 21, ruční EUR SK kompletu i EUR WORLD beze změny");

  for (const track of ["CZK", "EUR_SK", "EUR_WORLD"]) {
    const kitResult = (await resolve(track, [], { kitItemId: kit.id, selections: [] })).kit as Json;
    log(`komplet ${track}: ${kitResult.totalNet}${kitResult.needsQuote ? " (obsahuje položky k nacenění)" : ""}`);
  }
  const surcharge = (await editorA.post("/api/price-versions/resolve", { priceTrack: "EUR_WORLD", baseVersionId: versionId, kitItemId: kit.id, selections: (register.kitLines as Json[]).filter((line) => line.packageItemId === kit.id && line.variantSetId).map((line) => ({ lineKey: line.lineKey, variantId: blue.id })) })).kit as Json;
  const carpetLine = (surcharge.lines as Json[]).find((line) => line.surcharge?.rule === "per_unit");
  if (carpetLine) log(`příplatek modré barvy v EUR WORLD: ${carpetLine.surcharge.amountNet} € (${carpetLine.quantity} × 2 €)`);

  const check = await editorA.post("/api/price-versions", { action: "checkPublish", versionId: writeOwn(versionId) });
  assert.deepEqual(check.errors, []);
  log("kontrola publikace úplného konceptu: bez chyb (nepublikuje se)");

  // ---- two editors on one draft ----------------------------------------------------------------
  const seenByA = await load(editorA);
  const seenByB = await load(editorB);
  assert.equal(seenByA.version.revision, seenByB.version.revision);
  const savedA = await editorA.post("/api/price-versions/rows", { versionId: writeOwn(versionId), expectedRevision: seenByA.version.revision, entries: entries.map((entry) => (entry.catalogItemId === chair.id ? { ...entry, saleCzk: "600" } : entry)), surcharges });
  const conflict = await editorB.post("/api/price-versions/rows", { versionId: writeOwn(versionId), expectedRevision: seenByB.version.revision, entries: entries.map((entry) => (entry.catalogItemId === chair.id ? { ...entry, saleCzk: "999" } : entry)), surcharges }, 409);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.currentRevision, savedA.revision);
  state = await load(editorB);
  assert.equal((state.entries as Json[]).find((entry) => entry.catalogItemId === chair.id)?.saleCzk, 600);
  log(`souběh: editor A uložil (revize ${savedA.revision}), editor B se starou revizí dostal 409 „${conflict.error}“; v databázi zůstalo 600 Kč od A`);
  await editorB.post("/api/price-versions", { action: "updateVersion", versionId: writeOwn(versionId), expectedRevision: seenByB.version.revision, header: header(24.17) }, 409);
  await editorB.post("/api/price-versions", { action: "createVersion", priceListId: list.id, basedOnVersionId: writeOwn(versionId), basedOnRevision: seenByB.version.revision }, 409);
  await editorB.post("/api/price-versions", { action: "publishVersion", versionId: writeOwn(versionId), expectedRevision: seenByB.version.revision }, 409);
  await editorB.post("/api/price-versions", { action: "deleteVersion", versionId: writeOwn(versionId), expectedRevision: seenByB.version.revision }, 409);
  log("souběh: hlavička, kopie, publikace i smazání se starou revizí odmítnuty (409)");
  const retried = await editorB.post("/api/price-versions/rows", { versionId: writeOwn(versionId), expectedRevision: state.version.revision, entries, surcharges });
  log(`editor B po načtení aktuálního stavu uložil (revize ${retried.revision})`);

  // ---- copy of an own draft at the current revision, then cleanup ------------------------------
  const copyId = (await editorA.post("/api/price-versions", { action: "createVersion", priceListId: list.id, basedOnVersionId: writeOwn(versionId), basedOnRevision: retried.revision, actor: RUN_ID }, 201)).versionId as string;
  ownVersions.add(copyId);
  const copyRows = await editorA.get(`/api/price-versions/rows?versionId=${writeOwn(copyId)}`);
  assert.equal((copyRows.entries as Json[]).length, entries.length);
  log("kopie konceptu s aktuální revizí: OK");
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  // Cleanup: delete every draft this run created (current revision read just before deleting).
  // Newest first: a copy must go before the draft it was based on (based_on_version_id).
  for (const versionId of [...ownVersions].reverse()) {
    try {
      const current = await editorA.get(`/api/price-versions/rows?versionId=${versionId}`);
      if (current.version.status === "draft") await editorA.post("/api/price-versions", { action: "deleteVersion", versionId: writeOwn(versionId), expectedRevision: current.version.revision });
    } catch (error) {
      failures.push(`Úklid verze ${versionId} selhal: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  log(`úklid: smazáno ${ownVersions.size} konceptů běhu ${RUN_ID}`);
}

if (failures.length) {
  console.error(`\n✖ ${failures.join("\n✖ ")}`);
  process.exit(1);
}
console.log(`\n✔ E2E ceníků prošlo (běh ${RUN_ID}).`);
