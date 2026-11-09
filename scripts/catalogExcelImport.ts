/**
 * Catalog Excel import (Generator_ABF_Katalog, sheets Produkty + Sluzby in one plan) — domain/catalogExcelImport.ts.
 *
 *   npm run catalog:dev:excel-import -- ["_IMPORT/Generator_ABF_Katalog(6).xlsx"]
 *       dry run: reads the workbook and the live DEV catalog, prints the plan, writes nothing
 *   npm run catalog:dev:excel-import -- [file] --apply --confirm=<dev-ref> --expect=<create>/<update>/<unchanged>
 *       writes to DEV — only when the fresh plan has no conflict, no workbook error and exactly the
 *       expected counts (the ones the reviewed preview showed), so a changed file or catalog never
 *       writes blindly
 *
 * Safety: DEV only (NEXT_PUBLIC_APP_ENV=development, SUPABASE_URL = SUPABASE_EXPECTED_PROJECT_REF,
 * never production; the database client is createScriptSupabaseClient). New cards land as
 * "K doplnění"; existing cards keep their lifecycle, files, prices and attachments.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
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
const option = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const apply = process.argv.includes("--apply");
if (apply && option("confirm") !== appRef) {
  console.error(`✖ Zápis vyžaduje --confirm=${appRef}.`);
  process.exit(1);
}
const expected = option("expect")?.split("/").map(Number);
if (apply && (!expected || expected.length !== 3 || expected.some((count) => !Number.isInteger(count) || count < 0))) {
  console.error("✖ Zápis vyžaduje --expect=<vytvořit>/<aktualizovat>/<beze změny> podle zkontrolovaného náhledu.");
  process.exit(1);
}

const { extractStrictSheetGrid, readWorkbookFromBufferTolerant } = await import("../lib/import/xlsxReader.server.ts");
const { planCatalogWorkbookImport } = await import("../domain/catalogExcelImport.ts");
const { createScriptSupabaseClient } = await import("../lib/db/scriptSupabase.server.ts");
const { readCatalogItemsAdmin, readCatalogVariantSets } = await import("../lib/db/catalogItemsAdmin.supabase.ts");
const { readCatalogCategoryRegister } = await import("../lib/db/catalogCategories.supabase.ts");
const { applyCatalogExcelImportPlan } = await import("../lib/db/catalogExcelImport.supabase.ts");
type ImportValue = import("../domain/catalogExcelImport.ts").ImportValue;

const source = path.resolve(process.cwd(), process.argv.slice(2).find((argument) => !argument.startsWith("--")) ?? path.join("_IMPORT", "Generator_ABF_Katalog(6).xlsx"));
const workbook = await readWorkbookFromBufferTolerant(readFileSync(source));
const sheets = workbook.worksheets.map((sheet) => ({ name: sheet.name, grid: extractStrictSheetGrid(workbook, sheet.name) }));
const client = createScriptSupabaseClient();
const [items, register, variantSets] = await Promise.all([readCatalogItemsAdmin(client), readCatalogCategoryRegister(client), readCatalogVariantSets(client)]);
const plan = planCatalogWorkbookImport(sheets, { items, categories: register.categories, variantSets, targetEnvironment: "DEV" });

const show = (value: ImportValue) => (value === null ? "∅" : typeof value === "boolean" ? (value ? "ANO" : "NE") : typeof value === "string" ? `„${value}“` : String(value));
const display = (field: string, value: ImportValue) => {
  if (field === "category" && typeof value === "string") return `${show(register.categories.find((category) => category.id === value)?.name ?? value)} [${value}]`;
  if (field === "variant_set" && typeof value === "string") return show(variantSets.find((set) => set.id === value)?.code ?? value);
  return show(value);
};
console.log(`Zdroj: ${source}`);
console.log(`Cíl: DEV ${appRef} · režim: ${apply ? "ZÁPIS" : "suchý běh (nic se nezapíše)"}`);
console.log(`Šablona: ${plan.templateFormat ?? "—"} · prostředí v souboru: ${plan.environment ?? "—"} · katalog DEV: ${items.length} karet, ${register.categories.length} kategorií, ${variantSets.length} vzorníků`);
console.log("\nListy:");
for (const sheet of plan.sheets) console.log(`  ${sheet.name.padEnd(18)} ${sheet.status.padEnd(22)} ${sheet.dataRows} datových řádků`);
if (plan.issues.length) {
  console.log("\nUpozornění k sešitu:");
  for (const issue of plan.issues) console.log(`  [${issue.severity}] ${issue.message}`);
}
console.log(`\nSouhrn: vytvořit ${plan.summary.create} · aktualizovat ${plan.summary.update} · beze změny ${plan.summary.unchanged} · konflikt ${plan.summary.conflict} · upozornění ${plan.summary.warnings}`);
for (const [sheet, counts] of Object.entries(plan.bySheet)) console.log(`  ${sheet.padEnd(9)} vytvořit ${counts.create} · aktualizovat ${counts.update} · beze změny ${counts.unchanged} · konflikt ${counts.conflict}`);
const verbose = !process.argv.includes("--brief");
for (const row of plan.rows) {
  if (!verbose && row.action === "unchanged") continue;
  console.log(`\n${row.sheet.padEnd(8)} ř.${String(row.rowNumber).padStart(3)} ${row.label.padEnd(8)} ${row.action.toUpperCase()}${row.itemId ? ` (${row.itemId})` : ""}`);
  for (const change of row.changes) console.log(`        ${change.labelCs}: ${row.action === "create" ? "" : `${display(change.field, change.before)} → `}${display(change.field, change.after)}`);
  for (const issue of row.issues) console.log(`        [${issue.severity}] ${issue.message}`);
}

if (!apply) {
  console.log("\nNáhled — nic nebylo zapsáno.");
} else {
  const actual = [plan.summary.create, plan.summary.update, plan.summary.unchanged];
  const workbookErrors = plan.issues.filter((issue) => issue.severity === "error").length;
  if (plan.summary.conflict > 0 || workbookErrors > 0 || actual.some((count, index) => count !== expected![index])) {
    console.error(`\n✖ Plán (${actual.join("/")}, konflikty ${plan.summary.conflict}, chyby sešitu ${workbookErrors}) neodpovídá očekávání --expect=${expected!.join("/")} — nic se nezapisuje.`);
    process.exitCode = 1;
  } else {
    const result = await applyCatalogExcelImportPlan(client, plan);
    console.log(`\nZapsáno ${result.written.length} řádků:`);
    for (const entry of result.written) console.log(`  ${entry.sheet.padEnd(8)} ř.${String(entry.rowNumber).padStart(3)} ${entry.label.padEnd(8)} ${entry.action.padEnd(6)} ${entry.itemId} · stav ${entry.lifecycleStatus}`);
    if (result.failed) {
      console.error(`\n✖ ${result.failed.sheet} ř. ${result.failed.rowNumber} (${result.failed.label}) selhal: ${result.failed.message}`);
      console.error(`  Zapsané řádky: ${result.written.map((entry) => `${entry.sheet} ${entry.rowNumber} ${entry.label}`).join(", ") || "žádné"}`);
      console.error(`  Nezapsané řádky: ${result.notWritten.map((entry) => `${entry.sheet} ${entry.rowNumber} ${entry.label}`).join(", ")}`);
      console.error("  Opakovaný běh naváže (zapsané řádky už vyjdou beze změny).");
      process.exitCode = 1;
    }
  }
}
