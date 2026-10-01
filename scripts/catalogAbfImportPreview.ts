/**
 * KODY.xlsm import preview — READ-ONLY, never writes anything (no DB, no file writes).
 *
 *   node --no-warnings scripts/catalogAbfImportPreview.ts                     -> file only
 *   node --no-warnings --env-file=.env.local scripts/catalogAbfImportPreview.ts --against-db
 *                                                                              -> plan vs live catalog (read-only)
 *
 * The real import is applied from the admin UI (Katalog komponent → Import ABF kódů), which
 * shows the same preview and asks for confirmation.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { readKodyRowsFromBuffer } from "../lib/import/kodyReader.server.ts";
import { planAbfImport } from "../domain/catalogAbfImport.ts";
import { createSupabaseServerClient } from "../lib/db/supabase.server.ts";
import { catalogAbfSchemaAvailable, readAbfImportExistingItems } from "../lib/db/catalogAbfImport.supabase.ts";

const SOURCE = path.resolve(process.cwd(), "_IMPORT", "KODY.xlsm");
const againstDb = process.argv.includes("--against-db");

const rows = await readKodyRowsFromBuffer(readFileSync(SOURCE));
let existing: Awaited<ReturnType<typeof readAbfImportExistingItems>> = [];
let schemaReady: boolean | undefined;
if (againstDb) {
  const client = createSupabaseServerClient();
  [existing, schemaReady] = await Promise.all([readAbfImportExistingItems(client), catalogAbfSchemaAvailable(client)]);
}
const plan = planAbfImport(rows, existing, path.basename(SOURCE));

console.log(`Zdroj: ${SOURCE}${againstDb ? ` · porovnáno s živým katalogem (${existing.length} položek, migrace ${schemaReady ? "aplikována" : "NEAPLIKOVÁNA"})` : " · bez porovnání s DB"}`);
console.log(JSON.stringify(plan.summary, null, 2));
for (const row of plan.rows) {
  const detail =
    row.action === "create" ? `${row.classification.itemType}/${row.classification.kind}${row.classification.confident ? "" : " K ZAŘAZENÍ"}`
    : row.action === "update" ? `${row.itemLabel} [${row.linkedVia}] ${row.changes.map((change) => change.field).join(",")}`
    : row.action === "unchanged" ? row.itemLabel
    : `${row.reason}: ${row.message}${row.candidateLabel ? ` (${row.candidateLabel})` : ""}`;
  console.log(`${String(row.row.sourceRow).padStart(4)} ${String(row.abfCode ?? "—").padEnd(5)} ${row.action.padEnd(9)} ${row.row.nameCz} :: ${detail}`);
}
console.log(`\nPřeskočeno bez ABF kódu (${plan.skippedWithoutAbfCode.length}):`);
for (const row of plan.skippedWithoutAbfCode) console.log(`${String(row.sourceRow).padStart(4)} ${row.nameCz}`);
if (plan.notInFile.length) {
  console.log(`\nV katalogu s ABF kódem, ale ne v souboru (${plan.notInFile.length}) — import je nemění:`);
  for (const entry of plan.notInFile) console.log(`  ${entry.abfCode} ${entry.label} (${entry.lifecycleStatus})`);
}
