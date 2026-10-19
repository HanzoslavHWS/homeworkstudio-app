import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

// Every table created by any migration must have Row Level Security enabled (with zero policies —
// the browser never talks to Postgres; the server uses the service-role client). email_templates
// and email_history were the last two without it (20261020120000_email_tables_enable_rls.sql).

const MIGRATIONS = new URL("../supabase/migrations/", import.meta.url);

async function allMigrationSql(): Promise<string> {
  const files = (await readdir(MIGRATIONS)).filter((name) => name.endsWith(".sql")).sort();
  const contents = await Promise.all(files.map((name) => readFile(new URL(name, MIGRATIONS), "utf8")));
  return contents.map((sql) => sql.split("\n").map((line) => line.replace(/--.*$/u, "")).join("\n")).join("\n");
}

test("RLS: každá tabulka z migrací má zapnuté row level security", async () => {
  const sql = await allMigrationSql();
  const tables = [...sql.matchAll(/create table (?:if not exists )?(?:public\.)?([a-z_]+)\s*\(/giu)].map((match) => match[1]!);
  const secured = new Set([...sql.matchAll(/alter table (?:public\.)?([a-z_]+) enable row level security/giu)].map((match) => match[1]!));
  assert.ok(tables.length > 30, `nalezeno ${tables.length} tabulek`);
  assert.deepEqual(tables.filter((table) => !secured.has(table)), []);
});

test("RLS: migrace nepřidávají veřejné politiky", async () => {
  const sql = await allMigrationSql();
  assert.doesNotMatch(sql, /create policy/iu);
  assert.doesNotMatch(sql, /using\s*\(\s*true\s*\)/iu);
});
