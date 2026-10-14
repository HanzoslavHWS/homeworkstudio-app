import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { checkSupabaseTarget, KNOWN_PRODUCTION_SUPABASE_REFS, resolveAppEnvironment, supabaseProjectRef } from "../lib/env/supabaseEnvironment.ts";
import { createSupabaseServerClient, SupabaseConfigurationError, SupabaseEnvironmentGuardError } from "../lib/db/supabase.server.ts";

// =========================================================================================
// DEV / PROD separation — the database guard (docs/DEV_PROD_SETUP.md).
// =========================================================================================

const PROD = KNOWN_PRODUCTION_SUPABASE_REFS[0]!;
const DEV = "abcdefghijklmnopqrst";

test("project ref se čte z API URL i z connection stringu (přímý i pooler), nikdy z názvu", () => {
  assert.equal(supabaseProjectRef(`https://${PROD}.supabase.co`), PROD);
  assert.equal(supabaseProjectRef(`postgresql://postgres:heslo@db.${DEV}.supabase.co:5432/postgres`), DEV);
  assert.equal(supabaseProjectRef(`postgresql://postgres.${DEV}:heslo@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`), DEV);
  assert.equal(supabaseProjectRef("http://127.0.0.1:54321"), "local");
  assert.equal(supabaseProjectRef("https://example.com"), undefined);
  assert.equal(supabaseProjectRef(""), undefined);
});

test("prostředí: produkce je výchozí mimo `next dev`; `next dev` bez proměnné je vývoj", () => {
  assert.equal(resolveAppEnvironment({}), "production");
  assert.equal(resolveAppEnvironment({ NODE_ENV: "production" }), "production");
  assert.equal(resolveAppEnvironment({ NODE_ENV: "development" }), "development");
  assert.equal(resolveAppEnvironment({ NEXT_PUBLIC_APP_ENV: "development", NODE_ENV: "production" }), "development", "lokální `next start` s DEV konfigurací zůstává DEV");
  assert.equal(resolveAppEnvironment({ NEXT_PUBLIC_APP_ENV: "preview" }), "preview");
});

test("PRODUKCE: žádné omezení — Vercel se současnou konfigurací funguje beze změny", () => {
  assert.equal(checkSupabaseTarget({ NODE_ENV: "production", SUPABASE_URL: `https://${PROD}.supabase.co` }).ok, true);
  assert.equal(checkSupabaseTarget({ NEXT_PUBLIC_APP_ENV: "production", SUPABASE_URL: `https://${PROD}.supabase.co` }).ok, true);
});

test("DEV: produkční databáze se odmítne, i když je ref uveden jako očekávaný", () => {
  for (const environment of [
    { NODE_ENV: "development", SUPABASE_URL: `https://${PROD}.supabase.co` },
    { NEXT_PUBLIC_APP_ENV: "development", SUPABASE_URL: `https://${PROD}.supabase.co`, SUPABASE_EXPECTED_PROJECT_REF: PROD },
    { NEXT_PUBLIC_APP_ENV: "preview", SUPABASE_URL: `https://${PROD}.supabase.co`, SUPABASE_EXPECTED_PROJECT_REF: PROD },
  ]) {
    const check = checkSupabaseTarget(environment);
    assert.equal(check.ok, false);
    assert.match(check.ok ? "" : check.message, /PRODUKČNÍ/u);
  }
});

test("DEV: cílová databáze musí být výslovně potvrzená a shodná", () => {
  assert.equal(checkSupabaseTarget({ NEXT_PUBLIC_APP_ENV: "development", SUPABASE_URL: `https://${DEV}.supabase.co` }).ok, false, "bez SUPABASE_EXPECTED_PROJECT_REF");
  assert.equal(checkSupabaseTarget({ NEXT_PUBLIC_APP_ENV: "development", SUPABASE_URL: `https://${DEV}.supabase.co`, SUPABASE_EXPECTED_PROJECT_REF: "zzzzzzzzzzzzzzzzzzzz" }).ok, false, "nesouhlasný ref");
  assert.equal(checkSupabaseTarget({ NEXT_PUBLIC_APP_ENV: "development", SUPABASE_URL: "https://example.com" }).ok, false, "neověřitelná adresa");
  assert.deepEqual(checkSupabaseTarget({ NEXT_PUBLIC_APP_ENV: "development", SUPABASE_URL: `https://${DEV}.supabase.co`, SUPABASE_EXPECTED_PROJECT_REF: DEV }), { ok: true, environment: "development", projectRef: DEV });
  assert.equal(checkSupabaseTarget({ NEXT_PUBLIC_APP_ENV: "development", SUPABASE_URL: "http://127.0.0.1:54321" }).ok, true, "lokální Supabase stack");
});

test("server klient: v DEV odmítne produkční databázi chybou konfigurace (API vrátí 503), klíč nikdy neprozradí", () => {
  assert.throws(
    () => createSupabaseServerClient({ SUPABASE_URL: `https://${PROD}.supabase.co`, SUPABASE_SECRET_KEY: "SECRET_DO_NOT_LEAK", NODE_ENV: "development" }),
    (error) => error instanceof SupabaseEnvironmentGuardError && error instanceof SupabaseConfigurationError && !error.message.includes("SECRET_DO_NOT_LEAK"),
  );
  assert.ok(createSupabaseServerClient({ SUPABASE_URL: `https://${DEV}.supabase.co`, SUPABASE_SECRET_KEY: "x", NEXT_PUBLIC_APP_ENV: "development", SUPABASE_EXPECTED_PROJECT_REF: DEV }));
  assert.ok(createSupabaseServerClient({ SUPABASE_URL: `https://${PROD}.supabase.co`, SUPABASE_SECRET_KEY: "x", NODE_ENV: "production" }), "produkce beze změny");
});

test("ochrany: develop se na Vercelu nenasazuje; migrační skript vždy cílí přes --db-url a blokuje produkci", async () => {
  const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8")) as { git?: { deploymentEnabled?: Record<string, boolean> } };
  assert.equal(vercel.git?.deploymentEnabled?.develop, false);
  const script = await readFile(new URL("../scripts/supabaseDevMigrate.ts", import.meta.url), "utf8");
  assert.match(script, /"--db-url", dbUrl/u);
  assert.doesNotMatch(script, /"--linked"/u);
  assert.match(script, /KNOWN_PRODUCTION_SUPABASE_REFS\.includes\(ref\)/u);
  assert.match(script, /confirm !== expectedRef/u);
  const gitignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(gitignore, /^\.env\*$/mu);
  assert.match(gitignore, /^!\.env\.example$/mu);
});
