/**
 * V1-CARPET-04: plan for the carpet catalog — three cards (M01 / M02 / M04), one swatch book
 * KOBERCE-SERBUS with the 56 SERBUS shades (data/catalog/serbusCarpetSwatches.json), and the
 * card ↔ swatch-book links. Pure: it only COMPARES the wanted state with what exists and lists what
 * to create. Idempotent by construction — an existing card, swatch book or colour is never
 * rewritten; something that exists but differs is reported as a conflict and left alone.
 *
 * Billing: PODIUM-PLAT-020 → M01 (the base grey, default colour), every other shade → M02 with the
 * rule price_difference (in a kit line of M01 the surcharge is price(M02 + line) − price(M01)).
 * M04 (Koberec PVA) offers all 56 colours (scope all_variants) and is agreement-only (hradí PVA).
 * Prices are NOT part of this plan — they belong to a price list version (see the report).
 * Supplier images are only referenced (status pending_permission) — never copied.
 */
import type { CatalogItemAdmin } from "./catalogItemsAdmin.ts";
import { documentUsageAgreement, documentVariantOptions } from "./catalogItemsAdmin.ts";
import type { CardVariantOptions, CatalogVariantInput, CatalogVariantSet } from "./catalogVariants.ts";

export type SwatchManifestShade = Readonly<{
  code: string;
  series: string;
  shadeCode: string;
  name: string;
  sortOrder: number;
  sourcePageUrl: string;
  sourceImageUrl: string | null;
  targetFileName: string;
  imageCheck: string;
  /** "manual" = the image could not be matched reliably; never uploaded until confirmed. */
  photoReview?: "manual";
  note?: string;
}>;

export type SwatchManifest = Readonly<{ series: readonly Readonly<{ code: string; declaredShadeCount: number }>[]; shades: readonly SwatchManifestShade[] }>;

export const CARPET_SWATCH_BOOK = { code: "KOBERCE-SERBUS", name: "Koberce SERBUS", kind: "carpet" as const };
export const CARPET_BASE_SHADE = "PODIUM-PLAT-020";

export type CarpetCardSpec = Readonly<{ abfCode: "M01" | "M02" | "M04"; displayName: string; scope: CardVariantOptions["scope"]; agreementPayer?: string }>;

export const CARPET_CARDS: readonly CarpetCardSpec[] = [
  { abfCode: "M01", displayName: "Koberec šedý", scope: "billed_by_card" },
  { abfCode: "M02", displayName: "Koberec barevný", scope: "billed_by_card" },
  { abfCode: "M04", displayName: "Koberec PVA", scope: "all_variants", agreementPayer: "PVA" },
];

/** What a carpet card must look like for the plan to accept an existing one. */
export const CARPET_CARD_CLASSIFICATION = { itemType: "PRODUCT", kind: "floor_finish", category: "product-carpets", unitCode: "m2" } as const;

export type CarpetCardPlan =
  | Readonly<{ abfCode: string; action: "create"; spec: CarpetCardSpec }>
  | Readonly<{ abfCode: string; action: "keep"; itemId: string }>
  | Readonly<{ abfCode: string; action: "conflict"; itemId?: string; reason: string }>;

export type CarpetLinkPlan = Readonly<{ abfCode: string; variantOptions?: "set" | "keep" | "conflict"; agreement?: "set" | "keep"; reason?: string }>;

export type CarpetCatalogPlan = Readonly<{
  problems: readonly string[];
  cards: readonly CarpetCardPlan[];
  swatchBook: "create" | "keep";
  /** Colours to add (by code); billedBy = card abf code. */
  newVariants: readonly Readonly<{ code: string; billedBy: "M01" | "M02" }>[];
  keptVariants: readonly string[];
  variantConflicts: readonly Readonly<{ code: string; reason: string }>[];
  links: readonly CarpetLinkPlan[];
  /** Nothing to write. */
  upToDate: boolean;
}>;

/** Manifest sanity: declared counts, unique codes, one image per shade, no image shared. */
export function validateSwatchManifest(manifest: SwatchManifest): readonly string[] {
  const problems: string[] = [];
  for (const series of manifest.series) {
    const count = manifest.shades.filter((shade) => shade.series === series.code).length;
    if (count !== series.declaredShadeCount) problems.push(`Řada ${series.code}: ${count} odstínů, stránka uvádí ${series.declaredShadeCount}.`);
  }
  const codes = manifest.shades.map((shade) => shade.code);
  if (new Set(codes).size !== codes.length) problems.push("Manifest obsahuje duplicitní kódy odstínů.");
  for (const shade of manifest.shades) {
    if (shade.code !== `${shade.series}-${shade.shadeCode}`) problems.push(`${shade.code}: kód neodpovídá řadě a kódu odstínu.`);
    if (!shade.sourceImageUrl) problems.push(`${shade.code}: chybí zdrojový obrázek.`);
  }
  const images = manifest.shades.flatMap((shade) => (shade.sourceImageUrl ? [shade.sourceImageUrl] : []));
  if (new Set(images).size !== images.length) problems.push("Stejný obrázek je přiřazen více odstínům.");
  if (!manifest.shades.some((shade) => shade.code === CARPET_BASE_SHADE)) problems.push(`Manifest neobsahuje základní šedou ${CARPET_BASE_SHADE}.`);
  return problems;
}

function cardIssue(item: CatalogItemAdmin): string | undefined {
  const issues: string[] = [];
  if ((item.itemType ?? "PRODUCT") !== CARPET_CARD_CLASSIFICATION.itemType) issues.push(`typ ${item.itemType}`);
  if (item.kind !== CARPET_CARD_CLASSIFICATION.kind) issues.push(`druh ${item.kind}`);
  if (item.category !== CARPET_CARD_CLASSIFICATION.category) issues.push(`kategorie ${item.category ?? "—"}`);
  if ((item.unitCode ?? null) !== CARPET_CARD_CLASSIFICATION.unitCode) issues.push(`jednotka ${item.unitCode ?? item.unit ?? "—"}`);
  return issues.length ? `existující karta má ${issues.join(", ")} (očekáváno Produkt / floor_finish / Koberce / m²) — nepřepisuje se` : undefined;
}

export function planCarpetCatalog(input: Readonly<{ manifest: SwatchManifest; items: readonly CatalogItemAdmin[]; variantSets: readonly CatalogVariantSet[] }>): CarpetCatalogPlan {
  const problems = [...validateSwatchManifest(input.manifest)];
  const cards: CarpetCardPlan[] = CARPET_CARDS.map((spec) => {
    const matches = input.items.filter((item) => item.abfCode === spec.abfCode || item.internalCode === spec.abfCode);
    if (matches.length > 1) return { abfCode: spec.abfCode, action: "conflict", reason: `kód ${spec.abfCode} používá ${matches.length} karet` };
    const existing = matches[0];
    if (!existing) return { abfCode: spec.abfCode, action: "create", spec };
    const issue = cardIssue(existing);
    return issue ? { abfCode: spec.abfCode, action: "conflict", itemId: existing.id, reason: issue } : { abfCode: spec.abfCode, action: "keep", itemId: existing.id };
  });

  const set = input.variantSets.find((candidate) => candidate.code === CARPET_SWATCH_BOOK.code);
  const billedBy = (code: string): "M01" | "M02" => (code === CARPET_BASE_SHADE ? "M01" : "M02");
  const itemIdOf = (abfCode: string) => {
    const card = cards.find((candidate) => candidate.abfCode === abfCode);
    return card && card.action === "keep" ? card.itemId : undefined;
  };
  const newVariants: { code: string; billedBy: "M01" | "M02" }[] = [];
  const keptVariants: string[] = [];
  const variantConflicts: { code: string; reason: string }[] = [];
  for (const shade of input.manifest.shades) {
    const stored = set?.variants.find((variant) => variant.code === shade.code);
    if (!stored) { newVariants.push({ code: shade.code, billedBy: billedBy(shade.code) }); continue; }
    const wantedItem = itemIdOf(billedBy(shade.code));
    if (stored.series && stored.series !== shade.series) variantConflicts.push({ code: shade.code, reason: `uložená řada ${stored.series}` });
    else if (wantedItem && stored.priceItemId && stored.priceItemId !== wantedItem) variantConflicts.push({ code: shade.code, reason: "účtováno jinou kartou" });
    else keptVariants.push(shade.code);
  }

  const links: CarpetLinkPlan[] = CARPET_CARDS.map((spec) => {
    const card = cards.find((candidate) => candidate.abfCode === spec.abfCode)!;
    if (card.action === "conflict") return { abfCode: spec.abfCode, reason: "karta v konfliktu" };
    if (card.action === "create") return { abfCode: spec.abfCode, variantOptions: "set", ...(spec.agreementPayer ? { agreement: "set" as const } : {}) };
    const item = input.items.find((candidate) => candidate.id === card.itemId)!;
    const options = documentVariantOptions(item.document);
    const variantOptions = !options ? "set" : set && options.variantSetId === set.id && options.scope === spec.scope ? "keep" : "conflict";
    const agreement = spec.agreementPayer ? (documentUsageAgreement(item.document) ? "keep" : "set") : undefined;
    return { abfCode: spec.abfCode, variantOptions, ...(agreement ? { agreement } : {}), ...(variantOptions === "conflict" ? { reason: "karta už má jiný vzorník nebo rozsah barev — nepřepisuje se" } : {}) };
  });

  const upToDate = cards.every((card) => card.action !== "create") && Boolean(set) && newVariants.length === 0 && links.every((link) => link.variantOptions !== "set" && link.agreement !== "set");
  return { problems, cards, swatchBook: set ? "keep" : "create", newVariants, keptVariants, variantConflicts, links, upToDate };
}

/**
 * Variant inputs for saveCatalogVariantSet: every stored colour first, exactly as stored (order and
 * values kept — nothing is rewritten), then the new colours in manifest order.
 */
export function swatchBookVariantInputs(input: Readonly<{ manifest: SwatchManifest; stored?: CatalogVariantSet; itemIdOf: (abfCode: "M01" | "M02") => string }>): readonly CatalogVariantInput[] {
  const kept: CatalogVariantInput[] = (input.stored?.variants ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder).map((variant) => ({
    id: variant.id,
    code: variant.code,
    name: variant.name,
    ...(variant.nameEn ? { nameEn: variant.nameEn } : {}),
    ...(variant.series ? { series: variant.series } : {}),
    ...(variant.swatchColor ? { swatchColor: variant.swatchColor } : {}),
    ...(variant.photoAsset ? { photoAsset: variant.photoAsset } : {}),
    ...(variant.textureAsset ? { textureAsset: variant.textureAsset } : {}),
    ...(variant.imageSource ? { imageSource: variant.imageSource } : {}),
    ...(variant.priceItemId ? { priceItemId: variant.priceItemId } : {}),
    surchargeRule: variant.surchargeRule,
    ...(variant.surchargeUnitCode ? { surchargeUnitCode: variant.surchargeUnitCode } : {}),
    ...(variant.legacyFinishId ? { legacyFinishId: variant.legacyFinishId } : {}),
    isActive: variant.isActive,
    ...(variant.note ? { note: variant.note } : {}),
  }));
  const storedCodes = new Set(kept.map((variant) => variant.code));
  const added: CatalogVariantInput[] = input.manifest.shades
    .filter((shade) => !storedCodes.has(shade.code))
    .slice()
    .sort((a, b) => (a.series === b.series ? a.sortOrder - b.sortOrder : a.series === "PODIUM-PLAT" ? -1 : 1))
    .map((shade) => {
      const base = shade.code === CARPET_BASE_SHADE;
      return {
        code: shade.code,
        name: shade.name,
        series: shade.series,
        priceItemId: input.itemIdOf(base ? "M01" : "M02"),
        surchargeRule: base ? "none" : "price_difference",
        isActive: true,
        imageSource: { sourcePageUrl: shade.sourcePageUrl, ...(shade.sourceImageUrl ? { sourceImageUrl: shade.sourceImageUrl } : {}), status: "pending_permission", ...(shade.note ? { note: shade.note } : {}) },
        ...(base ? { note: "Výchozí základní šedá — účtováno M01." } : {}),
      } satisfies CatalogVariantInput;
    });
  return [...kept, ...added];
}

// ---------------------------------------------------------------------------------------------
// Swatch photos (V1-CARPET, photos approved 2026-11-03). One deterministic R2 key per shade, so a
// repeated run can never upload a second copy; a colour that already has a photo (uploaded earlier
// or replaced by hand) is never touched; a shade marked photoReview "manual" is never uploaded.
// ---------------------------------------------------------------------------------------------
export const SWATCH_PHOTO_OWNER = "koberce-serbus";

export type SwatchPhotoAction =
  | Readonly<{ code: string; action: "upload"; variantId: string; storageKey: string; sourceImageUrl: string; fileName: string }>
  | Readonly<{ code: string; action: "keep"; reason: string }>
  | Readonly<{ code: string; action: "manual_review"; variantId?: string; reason: string }>
  | Readonly<{ code: string; action: "skip"; reason: string }>;

/** Same shape as domain/assets.ts createStorageKey("catalog-photo", …) with the shade code as id. */
export function swatchPhotoStorageKey(shadeCode: string): string {
  return `catalog/furniture/${SWATCH_PHOTO_OWNER}/photos/${shadeCode.toLowerCase()}.jpg`;
}

export function planSwatchPhotos(input: Readonly<{ manifest: SwatchManifest; set: CatalogVariantSet | undefined }>): readonly SwatchPhotoAction[] {
  return input.manifest.shades.map((shade): SwatchPhotoAction => {
    const variant = input.set?.variants.find((candidate) => candidate.code === shade.code);
    if (!variant) return { code: shade.code, action: "skip", reason: "barva ve vzorníku není" };
    if (variant.photoAsset) return { code: shade.code, action: "keep", reason: variant.photoAsset.storageKey === swatchPhotoStorageKey(shade.code) ? "fotka už je nahraná" : "barva má jinou (ručně nahranou) fotku — nepřepisuje se" };
    if (shade.photoReview === "manual") return { code: shade.code, action: "manual_review", variantId: variant.id, reason: shade.note ?? "přiřazení obrázku nelze spolehlivě potvrdit" };
    if (!shade.sourceImageUrl) return { code: shade.code, action: "skip", reason: "chybí zdrojový obrázek" };
    return { code: shade.code, action: "upload", variantId: variant.id, storageKey: swatchPhotoStorageKey(shade.code), sourceImageUrl: shade.sourceImageUrl, fileName: shade.sourceImageUrl.split("/").pop() ?? `${shade.code}.jpg` };
  });
}
