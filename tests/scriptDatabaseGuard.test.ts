import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { checkScriptDatabaseTarget, KNOWN_PRODUCTION_SUPABASE_REFS } from "../lib/env/supabaseEnvironment.ts";
import { assertScriptDatabaseClient, createScriptSupabaseClient, resolveScriptEnvironment, ScriptDatabaseTargetError } from "../lib/db/scriptSupabase.server.ts";
import { applyBatch1Plan } from "../lib/db/importBatch1.supabase.ts";
import { applyBatch2aPlan } from "../lib/db/importBatch2a.supabase.ts";
import { applyBatch2bPlan } from "../lib/db/importBatch2b.supabase.ts";
import { applyCanonicalPlanEntry } from "../lib/db/typeBoothCanonicalization.supabase.ts";
import { applyCatalogExcelImportPlan } from "../lib/db/catalogExcelImport.supabase.ts";

// =========================================================================================
// Scripts (imports, canonicalization, repairs) never write to production
// (docs/DEV_DATA_IMPORT_PLAN.md, section 2).
// =========================================================================================

const PROD = KNOWN_PRODUCTION_SUPABASE_REFS[0]!;
const DEV = "abcdefghijklmnopqrst";
const SECRET = "SECRET_DO_NOT_LEAK";
const DEV_ENVIRONMENT = { NEXT_PUBLIC_APP_ENV: "development", SUPABASE_URL: `https://${DEV}.supabase.co`, SUPABASE_EXPECTED_PROJECT_REF: DEV, SUPABASE_SECRET_KEY: SECRET } as const;

function refused(environment: Parameters<typeof checkScriptDatabaseTarget>[0], pattern?: RegExp): void {
  const check = checkScriptDatabaseTarget(environment);
  assert.equal(check.ok, false, JSON.stringify({ ...environment, SUPABASE_SECRET_KEY: "…" }));
  if (check.ok === false) {
    assert.doesNotMatch(check.message, new RegExp(SECRET, "u"), "zpráva nikdy neobsahuje klíč");
    if (pattern) assert.match(check.message, pattern);
  }
}

test("skript: produkční projekt se odmítne vždy — i s NEXT_PUBLIC_APP_ENV=production a i když je uveden jako očekávaný", () => {
  for (const appEnvironment of ["development", "preview", "production", undefined]) {
    refused({ ...DEV_ENVIRONMENT, NEXT_PUBLIC_APP_ENV: appEnvironment, SUPABASE_URL: `https://${PROD}.supabase.co` });
    refused({ ...DEV_ENVIRONMENT, NEXT_PUBLIC_APP_ENV: appEnvironment, SUPABASE_URL: `https://${PROD}.supabase.co`, SUPABASE_EXPECTED_PROJECT_REF: PROD });
  }
  refused({ ...DEV_ENVIRONMENT, SUPABASE_URL: `https://${PROD}.supabase.co`, SUPABASE_EXPECTED_PROJECT_REF: PROD }, /PRODUKČNÍ/u);
  refused({ ...DEV_ENVIRONMENT, SUPABASE_URL: `https://${PROD}.supabase.co` }, /PRODUKČNÍ/u);
});

test("skript: chybějící nebo nejednoznačná konfigurace je odmítnutí, nikdy výchozí hodnota", () => {
  refused({ ...DEV_ENVIRONMENT, NEXT_PUBLIC_APP_ENV: undefined }, /NEXT_PUBLIC_APP_ENV/u);
  refused({ ...DEV_ENVIRONMENT, NEXT_PUBLIC_APP_ENV: "production" }, /NEXT_PUBLIC_APP_ENV/u);
  refused({ ...DEV_ENVIRONMENT, NEXT_PUBLIC_APP_ENV: "dev" }, /NEXT_PUBLIC_APP_ENV/u);
  refused({ ...DEV_ENVIRONMENT, SUPABASE_EXPECTED_PROJECT_REF: undefined }, /SUPABASE_EXPECTED_PROJECT_REF/u);
  refused({ ...DEV_ENVIRONMENT, SUPABASE_EXPECTED_PROJECT_REF: "  " }, /SUPABASE_EXPECTED_PROJECT_REF/u);
  refused({ ...DEV_ENVIRONMENT, SUPABASE_EXPECTED_PROJECT_REF: "homeworkstudio-dev" }, /platný project ref/u);
  refused({ ...DEV_ENVIRONMENT, SUPABASE_EXPECTED_PROJECT_REF: "zzzzzzzzzzzzzzzzzzzz" }, /zzzzzzzzzzzzzzzzzzzz/u);
  refused({ ...DEV_ENVIRONMENT, SUPABASE_URL: undefined }, /SUPABASE_URL/u);
  refused({ ...DEV_ENVIRONMENT, SUPABASE_URL: "https://example.com" }, /nelze ověřit/u);
  refused({ ...DEV_ENVIRONMENT, SUPABASE_URL: "http://127.0.0.1:54321" }, /nelze ověřit/u);
  refused({ ...DEV_ENVIRONMENT, SUPABASE_URL: "není url" }, /nelze ověřit/u);
  refused({ ...DEV_ENVIRONMENT, SUPABASE_SECRET_KEY: undefined }, /SUPABASE_SECRET_KEY/u);
  assert.deepEqual(checkScriptDatabaseTarget(DEV_ENVIRONMENT), { ok: true, projectRef: DEV });
  assert.deepEqual(checkScriptDatabaseTarget({ ...DEV_ENVIRONMENT, NEXT_PUBLIC_APP_ENV: "preview" }), { ok: true, projectRef: DEV });
});

test("skript: prostředí — shell a .env.local se nesmí lišit, duplicitní klíč s různou hodnotou je odmítnutí", () => {
  const file = `NEXT_PUBLIC_APP_ENV=development\nSUPABASE_URL=https://${DEV}.supabase.co\nSUPABASE_EXPECTED_PROJECT_REF=${DEV}\n# komentář SUPABASE_URL=https://${PROD}.supabase.co\nSUPABASE_SECRET_KEY=${SECRET}\n`;
  assert.deepEqual(resolveScriptEnvironment({}, file), DEV_ENVIRONMENT, "jen soubor");
  assert.deepEqual(resolveScriptEnvironment({ ...DEV_ENVIRONMENT }, undefined), DEV_ENVIRONMENT, "jen shell (bez .env.local)");
  assert.deepEqual(resolveScriptEnvironment({ ...DEV_ENVIRONMENT }, file), DEV_ENVIRONMENT, "node --env-file=.env.local: stejné hodnoty nejsou konflikt");

  const conflicts = [
    () => resolveScriptEnvironment({ SUPABASE_URL: `https://${PROD}.supabase.co` }, file),
    () => resolveScriptEnvironment({ SUPABASE_SECRET_KEY: "jiny-klic" }, file),
    () => resolveScriptEnvironment({ NEXT_PUBLIC_APP_ENV: "production" }, file),
    () => resolveScriptEnvironment({}, `${file}SUPABASE_URL=https://${PROD}.supabase.co\n`),
    () => resolveScriptEnvironment({}, `SUPABASE_SECRET_KEY=\n${file}`),
  ];
  for (const conflict of conflicts) {
    assert.throws(conflict, (error) => error instanceof ScriptDatabaseTargetError && !error.message.includes(SECRET) && !error.message.includes("jiny-klic"));
  }
});

test("skript: klient se pro produkci vůbec nevytvoří a přepínač --force nic nemění", () => {
  const argv = process.argv;
  process.argv = [...argv, "--force", "--apply", "--allow-production"];
  try {
    let built = 0;
    for (const environment of [{ ...DEV_ENVIRONMENT, SUPABASE_URL: `https://${PROD}.supabase.co` }, { ...DEV_ENVIRONMENT, SUPABASE_EXPECTED_PROJECT_REF: undefined }]) {
      assert.throws(() => createScriptSupabaseClient({ environment, createClient: () => { built += 1; return {} as never; } }), ScriptDatabaseTargetError);
    }
    assert.equal(built, 0, "kontrola proběhne PŘED vytvořením klienta");
  } finally {
    process.argv = argv;
  }
});

test("zapisovače importů odmítnou klienta, který neprošel kontrolou cíle — dřív, než se dotknou databáze", async () => {
  let touched = 0;
  const unchecked = { from: () => { touched += 1; throw new Error("nesmí se zavolat"); } } as never;
  const writers: Array<[string, () => Promise<unknown>]> = [
    ["applyBatch1Plan", () => applyBatch1Plan(unchecked, {} as never, { sourceFileName: "x", sourceFingerprint: "x", sourceVersion: "x" })],
    ["applyBatch2aPlan", () => applyBatch2aPlan(unchecked, {} as never, { sourceFileName: "x", sourceFingerprint: "x" })],
    ["applyBatch2bPlan", () => applyBatch2bPlan(unchecked, [], {} as never, { sourceFileName: "x", sourceFingerprint: "x" })],
    ["applyCanonicalPlanEntry", () => applyCanonicalPlanEntry(unchecked, { action: "create" } as never)],
    ["applyCatalogExcelImportPlan", () => applyCatalogExcelImportPlan(unchecked, {} as never)],
  ];
  for (const [name, write] of writers) await assert.rejects(write, ScriptDatabaseTargetError, name);
  assert.equal(touched, 0);
  assert.throws(() => assertScriptDatabaseClient(null), ScriptDatabaseTargetError);
  const verified = createScriptSupabaseClient({ environment: DEV_ENVIRONMENT, createClient: () => ({}) as never });
  assert.doesNotThrow(() => assertScriptDatabaseClient(verified));
});

test("skripty v scripts/ používají pro databázi výhradně kontrolovaného klienta a nemají žádný obchvat", async () => {
  const directory = new URL("../scripts/", import.meta.url);
  let databaseScripts = 0;
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".ts") || name === "supabaseDevMigrate.ts") continue;
    const source = await readFile(new URL(name, directory), "utf8");
    assert.doesNotMatch(source, /supabase\.server\.ts|@supabase\/supabase-js|\/rest\/v1/u, `${name}: obchází createScriptSupabaseClient`);
    assert.doesNotMatch(source, /--force|ALLOW_PRODUCTION|SKIP_GUARD/u, `${name}: přepínač obchvatu`);
    if (/lib\/db\/.*\.supabase\.ts/u.test(source)) {
      databaseScripts += 1;
      assert.match(source, /createScriptSupabaseClient\(\)/u, `${name}: databázový skript bez kontrolovaného klienta`);
    }
  }
  assert.ok(databaseScripts >= 5, `nalezeno ${databaseScripts} databázových skriptů`);

  const guard = await readFile(new URL("../lib/db/scriptSupabase.server.ts", import.meta.url), "utf8");
  assert.doesNotMatch(guard, /process\.argv|--force/u, "kontrola nečte příkazovou řádku");
  let writers = 0;
  for (const writer of ["importBatch1", "importBatch2a", "importBatch2b", "typeBoothCanonicalization", "p86Catalog", "catalogExcelImport"]) {
    const source = await readFile(new URL(`../lib/db/${writer}.supabase.ts`, import.meta.url), "utf8");
    for (const match of source.matchAll(/export async function apply\w+\([^)]*\)[^{]*\{\r?\n(.*)\r?\n/gu)) {
      writers += 1;
      assert.equal(match[1]!.trim(), "assertScriptDatabaseClient(client);", `${writer}: první příkaz zapisovače`);
    }
  }
  assert.equal(writers, 6);
});
