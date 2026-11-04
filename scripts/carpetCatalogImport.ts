/**
 * Carpet catalog import for DEV (V1-CARPET-04): cards M01 / M02 / M04, swatch book KOBERCE-SERBUS
 * with the 56 SERBUS shades (data/catalog/serbusCarpetSwatches.json) and the card ↔ swatch-book
 * links.
 *
 *   npm run carpets:dev:import                                   (dry run — writes nothing)
 *   npm run carpets:dev:import -- --apply --confirm=<dev-ref>    (writes to DEV)
 *
 * Safety: refuses to run unless .env.local targets DEV (NEXT_PUBLIC_APP_ENV=development, SUPABASE_URL
 * = SUPABASE_EXPECTED_PROJECT_REF, never a known production project). Idempotent: an existing card,
 * swatch book or colour is never rewritten (domain/carpetCatalogImport.ts) — a differing one is a
 * reported conflict. New cards land as "K doplnění" (never activated). No price list, price,
 * purchase price or image file is written: supplier images stay referenced, pending permission.
 */
import { existsSync, readFileSync } from "node:fs";
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
const confirm = process.argv.find((arg) => arg.startsWith("--confirm="))?.slice("--confirm=".length);
if (apply && confirm !== appRef) {
  console.error(`✖ Zápis vyžaduje --confirm=${appRef}.`);
  process.exit(1);
}

const { createScriptSupabaseClient } = await import("../lib/db/scriptSupabase.server.ts");
const { createCatalogItemAdmin, readCatalogItemsAdmin, readCatalogVariantSets, saveCatalogItemAdmin, saveCatalogVariantSet } = await import("../lib/db/catalogItemsAdmin.supabase.ts");
const { parseCatalogItemAdminCreateInput } = await import("../domain/catalogItemsAdmin.ts");
const { CARPET_CARDS, CARPET_CARD_CLASSIFICATION, CARPET_SWATCH_BOOK, planCarpetCatalog, swatchBookVariantInputs } = await import("../domain/carpetCatalogImport.ts");
type Manifest = import("../domain/carpetCatalogImport.ts").SwatchManifest;

const manifest = JSON.parse(readFileSync(`${root}data/catalog/serbusCarpetSwatches.json`, "utf8")) as Manifest;
const client = createScriptSupabaseClient();
const read = async () => ({ items: await readCatalogItemsAdmin(client), variantSets: await readCatalogVariantSets(client) });

let state = await read();
const plan = planCarpetCatalog({ manifest, ...state });
console.log(`Cíl: DEV ${appRef} · režim: ${apply ? "ZÁPIS" : "suchý běh (nic se nezapíše)"}`);
console.log(`Manifest: ${manifest.shades.length} odstínů (${manifest.series.map((series) => `${series.code} ${manifest.shades.filter((shade) => shade.series === series.code).length}/${series.declaredShadeCount}`).join(", ")})`);
if (plan.problems.length) console.log("Problémy manifestu:", plan.problems);
for (const card of plan.cards) console.log(`Karta ${card.abfCode}: ${card.action === "create" ? "založit" : card.action === "keep" ? "existuje — beze změny" : `KONFLIKT — ${card.reason}`}`);
console.log(`Vzorník ${CARPET_SWATCH_BOOK.code}: ${plan.swatchBook === "create" ? "založit" : "existuje"} · nové barvy ${plan.newVariants.length} (M01 ${plan.newVariants.filter((v) => v.billedBy === "M01").length}, M02 ${plan.newVariants.filter((v) => v.billedBy === "M02").length}) · beze změny ${plan.keptVariants.length} · konflikty ${plan.variantConflicts.length}`);
for (const conflict of plan.variantConflicts) console.log(`  KONFLIKT barvy ${conflict.code}: ${conflict.reason}`);
for (const link of plan.links) console.log(`Vazba ${link.abfCode}: barvy ${link.variantOptions ?? "—"}${link.agreement ? ` · dohoda ${link.agreement}` : ""}${link.reason ? ` (${link.reason})` : ""}`);
if (plan.upToDate) console.log("✔ Katalog koberců je aktuální — nic k zápisu.");
if (!apply || plan.upToDate) process.exit(plan.problems.length ? 1 : 0);
if (plan.problems.length) {
  console.error("✖ Manifest má problémy — import se nespustí.");
  process.exit(1);
}

// 1. Cards (new ones only — "K doplnění", never activated).
for (const card of plan.cards) {
  if (card.action !== "create") continue;
  const created = await createCatalogItemAdmin(client, parseCatalogItemAdminCreateInput({
    itemType: CARPET_CARD_CLASSIFICATION.itemType,
    kind: CARPET_CARD_CLASSIFICATION.kind,
    category: CARPET_CARD_CLASSIFICATION.category,
    unitCode: CARPET_CARD_CLASSIFICATION.unitCode,
    displayName: card.spec.displayName,
    abfCode: card.spec.abfCode,
    internalCode: card.spec.abfCode,
  }));
  console.log(`✔ Založena karta ${card.abfCode} (${created.id}) — stav ${created.lifecycleStatus}`);
}
state = await read();
const idOf = (abfCode: string) => state.items.find((item) => item.abfCode === abfCode)?.id;

// 2. Swatch book (stored colours kept verbatim, missing ones appended).
const billedCardsReady = plan.cards.filter((card) => card.abfCode !== "M04").every((card) => card.action !== "conflict");
if (plan.newVariants.length > 0 || plan.swatchBook === "create") {
  if (!billedCardsReady || !idOf("M01") || !idOf("M02")) {
    console.error("✖ Barvy se nezaloží: karta M01 nebo M02 je v konfliktu nebo chybí.");
  } else {
    const stored = state.variantSets.find((set) => set.code === CARPET_SWATCH_BOOK.code);
    const saved = await saveCatalogVariantSet(client, {
      ...(stored ? { id: stored.id } : {}),
      code: CARPET_SWATCH_BOOK.code,
      name: stored?.name ?? CARPET_SWATCH_BOOK.name,
      kind: stored?.kind ?? CARPET_SWATCH_BOOK.kind,
      isActive: stored?.isActive ?? true,
      ...(stored?.note ? { note: stored.note } : { note: "SERBUS — PODIUM / PLAT (23) a REVEXPO (33). Obrázky čekají na oprávnění k použití." }),
      variants: swatchBookVariantInputs({ manifest, ...(stored ? { stored } : {}), itemIdOf: (abfCode) => idOf(abfCode)! }),
    });
    console.log(`✔ Vzorník ${saved.code}: ${saved.variants.length} barev`);
  }
}
state = await read();

// 3. Card links (only where missing — an existing different link stays, reported above).
const set = state.variantSets.find((candidate) => candidate.code === CARPET_SWATCH_BOOK.code);
for (const link of plan.links) {
  const itemId = idOf(link.abfCode);
  const spec = CARPET_CARDS.find((candidate) => candidate.abfCode === link.abfCode)!;
  if (!itemId || !set || (link.variantOptions !== "set" && link.agreement !== "set")) continue;
  await saveCatalogItemAdmin(client, itemId, {
    ...(link.variantOptions === "set" ? { variantOptions: { variantSetId: set.id, scope: spec.scope } } : {}),
    ...(link.agreement === "set" && spec.agreementPayer ? { usageAgreement: { payerLabel: spec.agreementPayer } } : {}),
  }, null);
  console.log(`✔ ${link.abfCode}: vazba na vzorník${link.agreement === "set" ? " + použití jen na dohodu" : ""}`);
}
const after = planCarpetCatalog({ manifest, ...(await read()) });
console.log(after.upToDate ? "✔ Hotovo — opakovaný běh už nic nezapíše." : "⚠ Po zápisu zůstávají rozdíly — viz suchý běh.");
