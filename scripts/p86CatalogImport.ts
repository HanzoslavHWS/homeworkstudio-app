/**
 * P86 "Kóje 2 × 2 m" → catalog (V1-COMPLETE-02): the built-in booth as ONE BOOTH card plus its
 * confirmed commercial content. Nothing else — unlike scripts/importBatch2b.ts, no other card.
 *
 *   npm run p86:dev:import                                   (dry run — writes nothing)
 *   npm run p86:dev:import -- --apply --confirm=<dev-ref>    (writes to DEV)
 *
 * Safety: DEV only (NEXT_PUBLIC_APP_ENV=development, SUPABASE_URL = SUPABASE_EXPECTED_PROJECT_REF,
 * never production; the database client is createScriptSupabaseClient). Idempotent: an existing
 * P86 is never rewritten and its lines are only created while it has none. The card lands as
 * "K doplnění" (never activated, no reviewedAt). No price list row is written — the user enters
 * the P86 price (3 640 Kč) in the price list. See domain/p86CatalogImport.ts.
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
if (apply && process.argv.find((arg) => arg.startsWith("--confirm="))?.slice("--confirm=".length) !== appRef) {
  console.error(`✖ Zápis vyžaduje --confirm=${appRef}.`);
  process.exit(1);
}

const { createScriptSupabaseClient } = await import("../lib/db/scriptSupabase.server.ts");
const { readCatalogItemsAdmin, readCatalogVariantSets, saveCatalogPackageItems } = await import("../lib/db/catalogItemsAdmin.supabase.ts");
const { applyP86CardPlan } = await import("../lib/db/p86Catalog.supabase.ts");
const { planP86Card, planP86Lines } = await import("../domain/p86CatalogImport.ts");
const { boothTypes } = await import("../data/booths.ts");

const seed = boothTypes.find((booth) => booth.internalCode === "P86");
if (!seed) {
  console.error("✖ P86 (koje-2x2) ve vestavěných datech data/booths.ts není.");
  process.exit(1);
}
const client = createScriptSupabaseClient();
const read = async () => ({ items: await readCatalogItemsAdmin(client), variantSets: await readCatalogVariantSets(client) });

let state = await read();
const cardPlan = planP86Card(seed, state.items);
const p86IdBefore = cardPlan.action === "keep" ? cardPlan.itemId : undefined;
const linesPlan = cardPlan.action === "create"
  ? planP86Lines({ p86Id: "planned", items: [...state.items, { id: "planned", packageItems: [] } as never], variantSets: state.variantSets })
  : planP86Lines({ p86Id: p86IdBefore, items: state.items, variantSets: state.variantSets });

console.log(`Cíl: DEV ${appRef} · režim: ${apply ? "ZÁPIS" : "suchý běh (nic se nezapíše)"}`);
console.log(`Karta P86: ${cardPlan.action === "create" ? `založit „${seed.name}“ (BOOTH, ${seed.widthMm}×${seed.depthMm}×${seed.heightMm} mm, ${seed.printSurfaces.length} tiskových ploch, ${(seed.defaultViews ?? []).length} pohledy, GLB ${seed.modelUrl}) ve stavu K doplnění` : cardPlan.reason}`);
console.log(`Obsah kompletu: ${linesPlan.action === "create" ? linesPlan.lines.map((line) => `${line.lineKey} ${line.quantity} ${line.unitCode}${line.includedInPackage ? " v ceně" : ""}`).join(" · ") : `${linesPlan.action} — ${linesPlan.reason}`}`);
console.log(`Ostatní karty: beze změny · ceník: beze změny`);

const nothingToDo = cardPlan.action !== "create" && linesPlan.action !== "create";
if (cardPlan.action === "conflict") {
  console.error("✖ Konflikt — nic se nezapíše.");
  process.exitCode = 1;
} else if (nothingToDo) {
  console.log("✔ P86 je aktuální — nic k zápisu.");
} else if (apply) {
  let p86Id = p86IdBefore;
  if (cardPlan.action === "create") {
    p86Id = await applyP86CardPlan(client, cardPlan);
    console.log(`✔ Založena karta P86 (${p86Id}) — K doplnění`);
  }
  state = await read();
  const lines = planP86Lines({ p86Id, items: state.items, variantSets: state.variantSets });
  if (lines.action === "create") {
    const saved = await saveCatalogPackageItems(client, p86Id!, lines.lines);
    console.log(`✔ Obsah kompletu: ${saved.packageItems.length} řádky${saved.warnings.length ? ` · upozornění: ${saved.warnings.join(" ")}` : ""}`);
  } else {
    console.log(`Obsah kompletu: ${lines.action} — ${lines.reason}`);
  }
  const after = await read();
  const again = planP86Card(seed, after.items);
  const againLines = planP86Lines({ p86Id: again.action === "keep" ? again.itemId : undefined, items: after.items, variantSets: after.variantSets });
  console.log(again.action === "keep" && againLines.action !== "create" ? "✔ Hotovo — opakovaný běh už nic nezapíše." : "⚠ Po zápisu zůstávají rozdíly.");
}
