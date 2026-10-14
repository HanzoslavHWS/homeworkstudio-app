/**
 * Guarded migrations for the DEV Supabase project (docs/DEV_PROD_SETUP.md).
 *
 *   npm run db:dev:check   — verifies the target, lists local migrations, runs `db push --dry-run`
 *   npm run db:dev:list    — `migration list` (what is applied in DEV)
 *   npm run db:dev:apply -- --confirm=<dev project ref>   — real `db push` into DEV
 *
 * Always passes an explicit --db-url to the Supabase CLI. Plain `supabase db push` would target the
 * LINKED project, which in this repository was the production project. Refuses to run when:
 *   - the connection string or SUPABASE_URL is a known production project,
 *   - the connection string, SUPABASE_URL and SUPABASE_EXPECTED_PROJECT_REF do not name the same project,
 *   - NEXT_PUBLIC_APP_ENV is not "development",
 *   - `apply` is called without --confirm=<the same ref>.
 * The connection string (it contains the database password) is never printed.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KNOWN_PRODUCTION_SUPABASE_REFS, supabaseProjectRef } from "../lib/env/supabaseEnvironment.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const envFile = `${root}.env.local`;
if (existsSync(envFile)) process.loadEnvFile(envFile);

const [mode = "check", ...flags] = process.argv.slice(2);
const confirm = flags.find((flag) => flag.startsWith("--confirm="))?.slice("--confirm=".length);

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

if (!["check", "list", "apply"].includes(mode)) fail(`Neznámý režim „${mode}“. Použijte check | list | apply.`);

const dbUrl = process.env.SUPABASE_DEV_DB_URL?.trim();
const expectedRef = process.env.SUPABASE_EXPECTED_PROJECT_REF?.trim();
const appEnv = process.env.NEXT_PUBLIC_APP_ENV?.trim();
if (appEnv !== "development") fail(`NEXT_PUBLIC_APP_ENV musí být v .env.local „development“ (je „${appEnv ?? ""}“).`);
if (!expectedRef) fail("Chybí SUPABASE_EXPECTED_PROJECT_REF (ref DEV projektu) v .env.local.");
if (!dbUrl) fail("Chybí SUPABASE_DEV_DB_URL (connection string DEV databáze) v .env.local.");

const dbRef = supabaseProjectRef(dbUrl);
const appRef = supabaseProjectRef(process.env.SUPABASE_URL);
for (const [label, ref] of [["SUPABASE_DEV_DB_URL", dbRef], ["SUPABASE_URL", appRef], ["SUPABASE_EXPECTED_PROJECT_REF", expectedRef]] as const) {
  if (ref && KNOWN_PRODUCTION_SUPABASE_REFS.includes(ref)) fail(`${label} míří na PRODUKČNÍ projekt ${ref}. Migrace do produkce tímto skriptem nejdou.`);
}
if (dbRef !== expectedRef) fail(`SUPABASE_DEV_DB_URL míří na projekt ${dbRef ?? "neznámý"}, očekáván ${expectedRef}.`);
if (appRef !== expectedRef) fail(`SUPABASE_URL (aplikace) míří na projekt ${appRef ?? "neznámý"}, ale migrace na ${expectedRef} — aplikace a migrace musí cílit na stejnou DEV databázi.`);
if (mode === "apply" && confirm !== expectedRef) fail(`Pro skutečný zápis zopakujte příkaz s --confirm=${expectedRef}.`);

const migrations = readdirSync(`${root}supabase/migrations`).filter((name) => name.endsWith(".sql")).sort();
console.log(`Cíl: DEV projekt ${expectedRef} (ověřeno z connection stringu i SUPABASE_URL)`);
console.log(`Produkční projekty blokované: ${KNOWN_PRODUCTION_SUPABASE_REFS.join(", ")}`);
console.log(`Lokálních migrací: ${migrations.length} (${migrations[0]} … ${migrations[migrations.length - 1]})`);
console.log(`Režim: ${mode === "check" ? "kontrola (db push --dry-run, nic se nezapíše)" : mode === "list" ? "výpis stavu migrací" : "ZÁPIS do DEV (db push)"}\n`);

// Read-only API probe: the secret key must belong to the DEV project (a key of another project gets 401).
if (mode === "check") {
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!secretKey) fail("Chybí SUPABASE_SECRET_KEY (secret key DEV projektu) v .env.local.");
  const response = await fetch(`${process.env.SUPABASE_URL!.trim().replace(/\/$/u, "")}/rest/v1/`, { headers: { apikey: secretKey, Accept: "application/openapi+json" } });
  if (!response.ok) fail(`API DEV projektu odmítlo SUPABASE_SECRET_KEY (HTTP ${response.status}) — klíč nepatří projektu ${expectedRef} nebo je neplatný.`);
  console.log(`API: SUPABASE_SECRET_KEY platí pro projekt ${expectedRef} (HTTP ${response.status}, jen čtení).\n`);
}

const cli = `${root}node_modules/supabase/dist/supabase.js`;
if (!existsSync(cli)) fail("Supabase CLI není nainstalované — spusťte npm install.");
const args = mode === "list" ? ["migration", "list", "--db-url", dbUrl] : ["db", "push", "--db-url", dbUrl, ...(mode === "check" ? ["--dry-run"] : [])];
const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
const mask = (text: string) => text.split(dbUrl).join("<SUPABASE_DEV_DB_URL>");
process.stdout.write(mask(result.stdout ?? ""));
process.stderr.write(mask(result.stderr ?? ""));
process.exit(result.status ?? 1);
