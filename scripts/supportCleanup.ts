/**
 * Cleanup of support attachments (V1-SUPPORT-01).
 *
 *   npm run support:dev:cleanup                                          (dry run — lists, deletes nothing)
 *   npm run support:dev:cleanup -- --apply --confirm=<dev-ref>           (unfinished uploads older than 24 h)
 *   npm run support:dev:cleanup -- --all --apply --confirm=<dev-ref>     (rollback: EVERY support file)
 *
 * Safety: DEV only (same guard as the other DEV scripts; R2 through readR2Config, which outside
 * production accepts only the dedicated dev bucket). Without --all it deletes only uploads that never
 * became part of a saved article / report / reply (status pending or verified) — an attached file is
 * never touched (domain/support.ts selectCleanup). Only keys under support/ are ever deleted.
 */
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
const apply = process.argv.includes("--apply");
const all = process.argv.includes("--all");
if (apply && process.argv.find((arg) => arg.startsWith("--confirm="))?.slice("--confirm=".length) !== appRef) {
  console.error(`✖ Zápis vyžaduje --confirm=${appRef}.`);
  process.exit(1);
}

const { createScriptSupabaseClient } = await import("../lib/db/scriptSupabase.server.ts");
const { readR2Config } = await import("../lib/storage/r2Config.ts");
const { CloudflareR2StorageProvider } = await import("../lib/storage/cloudflareR2.server.ts");
const { selectCleanup } = await import("../domain/support.ts");

const r2 = readR2Config(process.env);
const client = createScriptSupabaseClient();
console.log(`Cíl: DEV ${appRef} · R2 bucket ${r2.bucketName} · režim: ${apply ? "ZÁPIS" : "suchý běh"}${all ? " · VŠECHNY soubory podpory (rollback)" : " · jen nedokončená nahrání starší 24 h"}`);
const { data, error } = await client.from("support_attachments").select("id, status, created_at, storage_key");
if (error) {
  console.error(`✖ ${error.message}`);
  process.exit(1);
}
const rows = ((data ?? []) as { id: string; status: string; created_at: string; storage_key: string }[]).map((row) => ({ id: row.id, status: row.status, createdAt: row.created_at, storageKey: row.storage_key }));
const selected = selectCleanup(rows, new Date(Date.now() - 24 * 3600 * 1000), all);
console.log(`Příloh celkem ${rows.length} · ke smazání ${selected.length}`);
for (const row of selected) console.log(`  ${row.status.padEnd(8)} ${row.storageKey}`);
if (apply && selected.length) {
  const provider = new CloudflareR2StorageProvider(r2);
  let deleted = 0;
  for (const row of selected) {
    await provider.deleteObject(row.storageKey);
    // the row goes only after its file; without --all an attached row is never deleted (double check in SQL)
    const query = client.from("support_attachments").delete().eq("id", row.id);
    const { error: rowError } = all ? await query : await query.neq("status", "attached");
    if (rowError) console.error(`  ✖ ${row.id}: ${rowError.message}`);
    else deleted += 1;
  }
  console.log(`✔ Smazáno ${deleted} souborů a záznamů.`);
}
