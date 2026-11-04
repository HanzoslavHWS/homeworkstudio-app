/**
 * SERBUS swatch photos → DEV R2 → colours of KOBERCE-SERBUS (V1-CARPET; use approved by the user
 * 2026-11-03 — cooperation with SERBUS, internal use).
 *
 *   npm run carpets:dev:photos                                   (dry run — downloads/uploads nothing)
 *   npm run carpets:dev:photos -- --apply --confirm=<dev-ref>    (uploads to the DEV bucket, links colours)
 *
 * Safety: DEV only — the database client is createScriptSupabaseClient (target checked against
 * SUPABASE_EXPECTED_PROJECT_REF) and R2 goes through readR2Config, which outside production accepts
 * only the dedicated dev bucket. Idempotent (domain/carpetCatalogImport.ts planSwatchPhotos): one
 * deterministic key per shade, an object already in R2 with the same size is reused (never a second
 * copy), a colour that already has a photo is never touched, a shade marked photoReview "manual"
 * (PODIUM-PLAT-4962) is never uploaded. The photos are catalog swatch photos, never 3D textures.
 * Nothing else changes: codes, ABF links, prices and other cards stay as they are.
 */
import { createHash } from "node:crypto";
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
if (apply && process.argv.find((arg) => arg.startsWith("--confirm="))?.slice("--confirm=".length) !== appRef) {
  console.error(`✖ Zápis vyžaduje --confirm=${appRef}.`);
  process.exit(1);
}

const { createScriptSupabaseClient } = await import("../lib/db/scriptSupabase.server.ts");
const { readCatalogVariantSets, saveCatalogVariantSet } = await import("../lib/db/catalogItemsAdmin.supabase.ts");
const { readR2Config } = await import("../lib/storage/r2Config.ts");
const { CloudflareR2StorageProvider } = await import("../lib/storage/cloudflareR2.server.ts");
const { CARPET_SWATCH_BOOK, planSwatchPhotos } = await import("../domain/carpetCatalogImport.ts");
type Manifest = import("../domain/carpetCatalogImport.ts").SwatchManifest;
type StoredAsset = import("../domain/assets.ts").StoredAsset;
type VariantInput = import("../domain/catalogVariants.ts").CatalogVariantInput;

const manifest = JSON.parse(readFileSync(`${root}data/catalog/serbusCarpetSwatches.json`, "utf8")) as Manifest;
const r2 = readR2Config(process.env);
console.log(`Cíl: DEV ${appRef} · R2 bucket ${r2.bucketName} · režim: ${apply ? "ZÁPIS" : "suchý běh (nic se nestáhne ani nenahraje)"}`);
const client = createScriptSupabaseClient();
const set = (await readCatalogVariantSets(client)).find((candidate) => candidate.code === CARPET_SWATCH_BOOK.code);
if (!set) {
  console.error(`✖ Vzorník ${CARPET_SWATCH_BOOK.code} v DEV není — nejdřív npm run carpets:dev:import.`);
  process.exit(1);
}
const plan = planSwatchPhotos({ manifest, set });
const count = (action: string) => plan.filter((entry) => entry.action === action).length;
console.log(`Plán: nahrát ${count("upload")} · beze změny ${count("keep")} · k ruční kontrole ${count("manual_review")} · přeskočit ${count("skip")}`);
for (const entry of plan) if (entry.action !== "upload" && entry.action !== "keep") console.log(`  ${entry.code}: ${entry.action} — ${entry.reason}`);
const manualPending = plan.filter((entry) => entry.action === "manual_review" && !set.variants.find((variant) => variant.id === entry.variantId)?.imageSource?.manualReview);
const nothingToDo = count("upload") === 0 && manualPending.length === 0;
if (nothingToDo) console.log("✔ Fotografie jsou aktuální — nic k zápisu.");
if (apply && !nothingToDo) await uploadAndLink();

async function uploadAndLink() {

const provider = new CloudflareR2StorageProvider(r2);
const uploaded = new Map<string, StoredAsset>();
const problems: string[] = [];
let reused = 0;
for (const entry of plan) {
  if (entry.action !== "upload") continue;
  const response = await fetch(entry.sourceImageUrl, { headers: { "User-Agent": "Generator_ABF swatch import" } });
  if (!response.ok) { problems.push(`${entry.code}: stažení selhalo (HTTP ${response.status})`); continue; }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) { problems.push(`${entry.code}: soubor není JPEG`); continue; }
  if (bytes.length > 15_000_000) { problems.push(`${entry.code}: soubor je větší než 15 MB`); continue; }
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const existing = await provider.getMetadata(entry.storageKey);
  if (existing && existing.contentLength !== bytes.length) { problems.push(`${entry.code}: v R2 už je jiný objekt ${entry.storageKey} — nepřepisuje se`); continue; }
  if (existing) {
    reused += 1;
  } else {
    const upload = await provider.createUploadUrl({ storageKey: entry.storageKey, mimeType: "image/jpeg", originalFileName: entry.fileName });
    const put = await fetch(upload.uploadUrl, { method: "PUT", headers: upload.headers, body: bytes });
    if (!put.ok) { problems.push(`${entry.code}: nahrání selhalo (HTTP ${put.status})`); continue; }
    const check = await provider.getMetadata(entry.storageKey);
    if (check?.contentLength !== bytes.length) { problems.push(`${entry.code}: po nahrání nesedí velikost`); continue; }
  }
  uploaded.set(entry.code, { id: `serbus-${entry.code.toLowerCase()}`, storageKey: entry.storageKey, originalFileName: entry.fileName, mimeType: "image/jpeg", size: bytes.length, createdAt: new Date().toISOString(), checksum, displayName: entry.code, category: "catalog-photo" });
}

// Link: every stored colour round-trips verbatim; only uploaded ones gain photoAsset + approved
// status, manual-review ones get the flag — nothing else in the swatch book changes.
const reviewCodes = new Map(plan.flatMap((entry) => (entry.action === "manual_review" ? [[entry.code, entry.reason] as const] : [])));
const variants: VariantInput[] = set.variants.slice().sort((a, b) => a.sortOrder - b.sortOrder).map((variant) => {
  const photo = uploaded.get(variant.code);
  const review = reviewCodes.get(variant.code);
  const imageSource = photo
    ? { ...(variant.imageSource ?? {}), status: "approved" as const }
    : review && variant.imageSource
      ? { ...variant.imageSource, status: "approved" as const, manualReview: true, note: review }
      : variant.imageSource;
  return {
    id: variant.id,
    code: variant.code,
    name: variant.name,
    ...(variant.nameEn ? { nameEn: variant.nameEn } : {}),
    ...(variant.series ? { series: variant.series } : {}),
    ...(variant.swatchColor ? { swatchColor: variant.swatchColor } : {}),
    ...(photo ? { photoAsset: photo } : variant.photoAsset ? { photoAsset: variant.photoAsset } : {}),
    ...(variant.textureAsset ? { textureAsset: variant.textureAsset } : {}),
    ...(imageSource ? { imageSource } : {}),
    ...(variant.priceItemId ? { priceItemId: variant.priceItemId } : {}),
    surchargeRule: variant.surchargeRule,
    ...(variant.surchargeUnitCode ? { surchargeUnitCode: variant.surchargeUnitCode } : {}),
    ...(variant.legacyFinishId ? { legacyFinishId: variant.legacyFinishId } : {}),
    isActive: variant.isActive,
    ...(variant.note ? { note: variant.note } : {}),
  };
});
const saved = await saveCatalogVariantSet(client, { id: set.id, code: set.code, name: set.name, kind: set.kind, isActive: set.isActive, ...(set.note ? { note: set.note } : {}), variants });
console.log(`✔ Staženo a ověřeno ${uploaded.size} · nově nahráno ${uploaded.size - reused} · v R2 už bylo ${reused} · propojeno ${saved.variants.filter((variant) => variant.photoAsset).length}/${saved.variants.length} barev · k ruční kontrole ${reviewCodes.size}`);
if (problems.length) {
  console.log("Problémy:", problems);
  process.exitCode = 1;
}
const again = planSwatchPhotos({ manifest, set: saved });
console.log(again.every((entry) => entry.action !== "upload") ? "✔ Opakovaný běh už nic nenahraje." : "⚠ Některé fotky zůstávají k nahrání.");
}
