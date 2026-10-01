/**
 * Component Administration ("Administrace → Komponenty") — pure domain layer for browsing
 * and safely editing the REAL catalog_items table (all kinds: furniture/booth/construction/
 * service/..., all lifecycle statuses, unlike domain/catalogPricing.ts which is a narrow
 * customer-safe summary for technical-service pricing only).
 *
 * generatorEligible is NEVER stored — it is always recomputed live here via
 * domain/catalogReadiness.ts's evaluateCatalogReadiness()/isGeneratorEligible(), the exact
 * same functions the rest of the app already trusts. No parallel readiness logic.
 */
import { CATALOG_ITEM_KINDS, CATALOG_ITEM_STATUSES, type BoothVariant, type CatalogItemKind, type CatalogItemStatus, type CatalogItemType, type ComponentDefinition, type PricingEntry } from "./models.ts";
import { evaluateCatalogReadiness, isGeneratorEligible, isValidCatalogItemStatus, type ReadinessResult } from "./catalogReadiness.ts";
import {
  defaultItemTypeForKind,
  defaultKindForItemType,
  isCatalogItemType,
  isKindCompatibleWithItemType,
  normalizeAbfCode,
  normalizeInternalCode,
} from "./catalogItemTypes.ts";
import type { CatalogPackageItem } from "./catalogPackages.ts";
import { getBasePricingEntry } from "./catalog.ts";
import { catalogCategories } from "./catalogCategories.ts";
import { SOURCE_ASSET_KINDS, type SourceAssetEntry, type SourceAssetKind, type StoredAsset } from "./assets.ts";
import { resolveBoothAssetDefinition } from "./boothAssets.ts";
import { TECHNICAL_SERVICE_PLACEMENT_BEHAVIORS, TECHNICAL_SERVICE_SYMBOL_RENDERERS, type TechnicalRasterComponentConfig } from "./technicalRasterComponentPresentation.ts";

export const CATALOG_ITEM_KIND_LABELS_CS: Readonly<Record<CatalogItemKind, string>> = {
  booth: "Stánek",
  booth_component: "Komponenta stánku",
  construction: "Konstrukce / Octanorm",
  furniture: "Mobiliář",
  technical_point: "Technický bod",
  service: "Služba",
  graphics_service: "Grafická služba",
  floor_finish: "Podlahová krytina",
  other: "Ostatní",
};

const reusedCategoryLabel = new Map(catalogCategories.map((entry) => [entry.id, entry.name]));

/**
 * Every category value actually present in the remote catalog_items table (live-audited,
 * 81 rows, 2026-08) — a closed, curated set, never free text. "chairs"/"services" reuse the
 * exact labels already declared in domain/catalogCategories.ts (M57/L02's original static
 * seed values) rather than re-declaring them; the rest are the Czech PRICELIST sheet category
 * names Batch #2A/#2B preserved verbatim on import — kept as their real canonical DB value,
 * only the LABEL is translated/expanded for display.
 */
export const CATALOG_ITEM_CATEGORY_OPTIONS: readonly Readonly<{ value: string; label: string }>[] = [
  { value: "chairs", label: reusedCategoryLabel.get("chairs") ?? "Židle" },
  { value: "Nábytek", label: "Nábytek" },
  { value: "Kuchyňka", label: "Kuchyňka" },
  { value: "Octanorm", label: "Octanorm" },
  { value: "Ostatní", label: "Ostatní" },
  { value: "Stavba", label: "Stavba" },
  { value: "Úvaz", label: "Úvaz (rigging)" },
  { value: "Světlo", label: "Světlo" },
  { value: "Typovky", label: "Typovky" },
  { value: "Canonical", label: "Canonical" },
  { value: "T. služby", label: "Technické služby" },
  { value: "services", label: reusedCategoryLabel.get("services") ?? "Služby" },
  { value: "Panely / stěny", label: "Panely / stěny" },
  { value: "Sloupky", label: "Sloupky" },
  { value: "Límce", label: "Límce" },
  { value: "Dveře", label: "Dveře" },
  { value: "Zázemí / konstrukce", label: "Zázemí / konstrukce" },
  { value: "Podlaha", label: "Podlaha" },
  { value: "Osvětlení", label: "Osvětlení" },
];

/** Never hides/crashes on an unlisted value — falls back to the raw canonical string, same defensive spirit as categoryOptions()'s existing fallback in domain/catalogCategories.ts. */
export function categoryLabelCs(value: string | null): string {
  if (!value) return "—";
  return CATALOG_ITEM_CATEGORY_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

/** The document JSONB column stores EITHER a full ComponentDefinition OR a BoothType payload (see the catalog_items migration comment) — never assume one shape here, only read named fields defensively. */
export type CatalogItemAdminDocument = Record<string, unknown>;

export type CatalogItemAdmin = Readonly<{
  id: string;
  internalCode: string | null;
  /**
   * ABF price-list code (catalog_items.abf_code) — deliberately separate from internalCode. The
   * repository always fills abfCode/itemType; they are optional on the type only so rows read
   * before the 20261001120000 migration (and older test fixtures) stay valid — read them through
   * itemTypeOf()/abfCodeOf(), never directly.
   */
  abfCode?: string | null;
  /** Catalog card type (catalog_items.item_type). See itemTypeOf(). */
  itemType?: CatalogItemType;
  kind: CatalogItemKind;
  lifecycleStatus: CatalogItemStatus;
  displayName: string;
  officialName: string | null;
  category: string | null;
  unit: string | null;
  document: CatalogItemAdminDocument;
  createdAt: string;
  updatedAt: string;
  /** BOOTH package contents (catalog_item_package_items where package_item_id = id). Empty/absent for every other type. */
  packageItems?: readonly CatalogPackageItem[];
}>;

export function itemTypeOf(item: Pick<CatalogItemAdmin, "itemType" | "kind">): CatalogItemType {
  return item.itemType ?? defaultItemTypeForKind(item.kind);
}

export function abfCodeOf(item: Pick<CatalogItemAdmin, "abfCode">): string | null {
  return item.abfCode ?? null;
}

/** Free-text admin note ("Poznámka") — internal only, never customer-facing. */
export function documentNote(document: CatalogItemAdminDocument): string {
  return typeof document.note === "string" ? document.note : "";
}

/**
 * Set by the KODY import when the card type could NOT be safely determined from the data (see
 * domain/catalogAbfImport.ts classifyAbfCodeItemType) — the admin list offers a "K zařazení"
 * filter for these. Cleared by any explicit type confirmation in the admin.
 */
export function documentItemTypeNeedsReview(document: CatalogItemAdminDocument): boolean {
  return document.itemTypeNeedsReview === true;
}

/**
 * SERVICE technical metadata — deliberately small and open (spec: "nevynucuj komplikovaný
 * model"): an optional power figure and free key/value parameters. Placement in the technical
 * raster, marker and icon keep living in the existing `document.technicalRaster` config
 * (TechnicalRasterSection) — never duplicated here.
 */
export type ServiceTechnicalMetadata = Readonly<{
  powerKw?: number;
  parameters?: readonly Readonly<{ key: string; value: string }>[];
}>;

const SERVICE_PARAMETER_KEY_MAX = 40;
const SERVICE_PARAMETER_VALUE_MAX = 200;
const SERVICE_PARAMETERS_MAX = 30;

function parseServiceTechnical(value: unknown): ServiceTechnicalMetadata | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const result: { powerKw?: number; parameters?: { key: string; value: string }[] } = {};
  if (typeof candidate.powerKw === "number" && Number.isFinite(candidate.powerKw) && candidate.powerKw >= 0) result.powerKw = candidate.powerKw;
  if (Array.isArray(candidate.parameters)) {
    const parameters = candidate.parameters
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      .map((entry) => ({
        key: typeof entry.key === "string" ? entry.key.trim() : "",
        value: typeof entry.value === "string" ? entry.value.trim() : "",
      }))
      .filter((entry) => entry.key && entry.key.length <= SERVICE_PARAMETER_KEY_MAX && entry.value.length <= SERVICE_PARAMETER_VALUE_MAX && isPlainTextWithoutMarkup(entry.key) && isPlainTextWithoutMarkup(entry.value))
      .slice(0, SERVICE_PARAMETERS_MAX);
    if (parameters.length > 0) result.parameters = parameters;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function documentServiceTechnical(document: CatalogItemAdminDocument): ServiceTechnicalMetadata | undefined {
  return parseServiceTechnical(document.serviceTechnical);
}

/** Provenance of the last KODY/ABF import touching this card (read-only in the admin). */
export type AbfImportProvenance = Readonly<{
  sourceFile: string;
  sourceSheet: string;
  sourceRow: number;
  abfName: string;
  abfNameEn: string | null;
  importedAt: string;
}>;

export function documentAbfImport(document: CatalogItemAdminDocument): AbfImportProvenance | undefined {
  const value = document.abfImport;
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.sourceFile !== "string" || typeof candidate.sourceRow !== "number" || typeof candidate.abfName !== "string") return undefined;
  return {
    sourceFile: candidate.sourceFile,
    sourceSheet: typeof candidate.sourceSheet === "string" ? candidate.sourceSheet : "",
    sourceRow: candidate.sourceRow,
    abfName: candidate.abfName,
    abfNameEn: typeof candidate.abfNameEn === "string" ? candidate.abfNameEn : null,
    importedAt: typeof candidate.importedAt === "string" ? candidate.importedAt : "",
  };
}

function readNumber(document: CatalogItemAdminDocument, key: string): number | undefined {
  const value = document[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(document: CatalogItemAdminDocument, key: string): string | undefined {
  const value = document[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export type DocumentDimensions = Readonly<{
  widthMm: number | null;
  depthMm: number | null;
  heightMm: number | null;
  hasDimensions: boolean;
}>;

/** Mirrors catalogReadiness.ts's hasDimensions() exactly (widthMm>0 && depthMm>0) — 0/absent is this codebase's established "unknown", never a real measurement. */
export function documentDimensions(document: CatalogItemAdminDocument): DocumentDimensions {
  const widthMm = readNumber(document, "widthMm") ?? null;
  const depthMm = readNumber(document, "depthMm") ?? null;
  const heightMm = readNumber(document, "heightMm") ?? null;
  const hasDimensions = Boolean(widthMm && widthMm > 0 && depthMm && depthMm > 0);
  return {
    widthMm: widthMm && widthMm > 0 ? widthMm : null,
    depthMm: depthMm && depthMm > 0 ? depthMm : null,
    heightMm: heightMm && heightMm > 0 ? heightMm : null,
    hasDimensions,
  };
}

function isRuntimeGlbReference(value: string | undefined): boolean {
  return Boolean(value) && !value.toLowerCase().endsWith(".skp");
}

/**
 * True or false only — see documentModelAsset() below for the actual StoredAsset the UI needs
 * to render/resolve a download URL for. Mirrors domain/catalogReadiness.ts's has3DAsset — a
 * .skp reference (SketchUp authoring source) never counts as a usable runtime model, however
 * it got set.
 */
export function documentHas3DAsset(document: CatalogItemAdminDocument): boolean {
  return Boolean(documentEffectiveModelReference(document));
}

function isStoredAssetShape(value: unknown): value is StoredAsset {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.storageKey === "string" &&
    Boolean(candidate.storageKey) &&
    typeof candidate.originalFileName === "string" &&
    typeof candidate.mimeType === "string" &&
    typeof candidate.size === "number" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.category === "string"
  );
}

/** The R2-backed photo reference, if the document has a validly-shaped one — never a signed URL, only the stable storageKey-bearing StoredAsset. */
export function documentPhotoAsset(document: CatalogItemAdminDocument): StoredAsset | undefined {
  return isStoredAssetShape(document.photoAsset) ? document.photoAsset : undefined;
}

/** The R2-backed 3D model reference, if the document has a validly-shaped one. */
export function documentModelAsset(document: CatalogItemAdminDocument): StoredAsset | undefined {
  return isStoredAssetShape(document.modelAsset) ? document.modelAsset : undefined;
}

/** "Krátký text" length ceiling (spec batch 11 section 8: "12-16 znaků") — generous enough for "LEDNIČKA"/"NONSTOP" while staying a genuinely SHORT on-symbol label, never a sentence. */
const TECHNICAL_RASTER_DISPLAY_LABEL_MAX_LENGTH = 16;
/** "Text legendy" is a full descriptive line (e.g. "INTERNET — PEVNÁ PŘÍPOJKA") — a generous but still bounded ceiling, never unlimited free text. */
const TECHNICAL_RASTER_LEGEND_LABEL_MAX_LENGTH = 80;
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;

/** No HTML/markup ever accepted in a plain technical-marker text field (spec batch 11 section 8: "Nevkládej arbitrary HTML/SVG markup") — a blunt but sufficient guard for a short label field: reject outright rather than attempt to sanitize. */
function isPlainTextWithoutMarkup(value: string): boolean {
  return !/[<>]/u.test(value);
}

function sanitizeShortLabel(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || !isPlainTextWithoutMarkup(trimmed)) return undefined;
  return trimmed;
}

/**
 * Validates a raw (possibly attacker-controlled, or a previously-saved document's own)
 * technicalRaster value into a well-shaped TechnicalRasterComponentConfig — the ONE place that
 * validation happens, reused by both documentTechnicalRaster (reading an already-saved document)
 * and parseCatalogItemAdminEdit (validating a fresh request body) so the two can never drift.
 * Returns undefined for anything not shaped like an object, or an object with zero recognized
 * fields — never throws, never partially trusts a malformed value.
 */
function parseTechnicalRasterConfig(value: unknown): TechnicalRasterComponentConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const config: { -readonly [K in keyof TechnicalRasterComponentConfig]?: TechnicalRasterComponentConfig[K] } = {};
  if (typeof candidate.enabled === "boolean") config.enabled = candidate.enabled;
  if (typeof candidate.placementBehavior === "string" && (TECHNICAL_SERVICE_PLACEMENT_BEHAVIORS as readonly string[]).includes(candidate.placementBehavior)) {
    config.placementBehavior = candidate.placementBehavior as TechnicalRasterComponentConfig["placementBehavior"];
  }
  if (typeof candidate.renderer === "string" && (TECHNICAL_SERVICE_SYMBOL_RENDERERS as readonly string[]).includes(candidate.renderer)) {
    config.renderer = candidate.renderer as TechnicalRasterComponentConfig["renderer"];
  }
  const displayLabel = sanitizeShortLabel(candidate.displayLabel, TECHNICAL_RASTER_DISPLAY_LABEL_MAX_LENGTH);
  if (displayLabel !== undefined) config.displayLabel = displayLabel;
  if (typeof candidate.color === "string" && HEX_COLOR_PATTERN.test(candidate.color.trim())) config.color = candidate.color.trim().toLowerCase();
  const legendLabel = sanitizeShortLabel(candidate.legendLabel, TECHNICAL_RASTER_LEGEND_LABEL_MAX_LENGTH);
  if (legendLabel !== undefined) config.legendLabel = legendLabel;
  if (isStoredAssetShape(candidate.iconAsset)) config.iconAsset = candidate.iconAsset;
  return Object.keys(config).length > 0 ? config : undefined;
}

/**
 * The "TECHNICKÉ RASTRY" section's own explicit config, if the document has a validly-shaped one
 * (spec batch 11) — undefined for the overwhelming majority of existing components, which have
 * never set this at all; domain/technicalRasterComponentPresentation.ts's
 * resolveTechnicalRasterPresentation() already treats `undefined` as "use the central default
 * entirely", so callers never need a second fallback here. Defensively re-validates every field's
 * shape (never trusts the JSONB blob) rather than a bare cast — a document written by a future,
 * differently-shaped version of this config must never crash the admin UI.
 */
export function documentTechnicalRaster(document: CatalogItemAdminDocument): TechnicalRasterComponentConfig | undefined {
  return parseTechnicalRasterConfig(document.technicalRaster);
}

function isSourceAssetEntryShape(value: unknown): value is SourceAssetEntry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    (SOURCE_ASSET_KINDS as readonly string[]).includes(candidate.kind as string) &&
    isStoredAssetShape(candidate.asset)
  );
}

/** Every validly-shaped source/manufacturing file entry (SKP/DWG/DXF/PDF/other) on the document — see domain/assets.ts's SourceAssetEntry. Never a signed URL, only the stable storageKey-bearing StoredAsset per entry. */
export function documentSourceAssets(document: CatalogItemAdminDocument): readonly SourceAssetEntry[] {
  const value = document.sourceAssets;
  return Array.isArray(value) ? value.filter(isSourceAssetEntryShape) : [];
}

function isVariantShape(value: unknown): value is BoothVariant {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || !candidate.id) return false;
  if (typeof candidate.name !== "string" || !candidate.name) return false;
  if (candidate.modelAsset !== undefined && !isStoredAssetShape(candidate.modelAsset)) return false;
  if (candidate.photoAsset !== undefined && !isStoredAssetShape(candidate.photoAsset)) return false;
  if (candidate.sourceAssets !== undefined && !(Array.isArray(candidate.sourceAssets) && candidate.sourceAssets.every(isSourceAssetEntryShape))) return false;
  return true;
}

/** Every validly-shaped variant of a multi-variant type-booth line (T04..T25) — never array-index identity, always the variant's own stable `id`. Empty/absent means "not a variant line" (e.g. P86). */
export function documentVariants(document: CatalogItemAdminDocument): readonly BoothVariant[] {
  const value = document.variants;
  return Array.isArray(value) ? value.filter(isVariantShape) : [];
}

/** Mirrors documentHas3DAsset but scoped to ONE variant's own modelAsset — never falls back to the parent's or another variant's. */
export function variantHas3DAsset(variant: BoothVariant): boolean {
  return isRuntimeGlbReference(variant.modelAsset?.storageKey);
}

/** Mirrors documentSourceTraceability's sketchup check but scoped to ONE variant's own sourceAssets — never the parent's. */
export function variantHasSketchupSource(variant: BoothVariant): boolean {
  return Boolean(variant.sourceAssets?.some((entry) => entry.kind === "sketchup" && entry.asset?.storageKey));
}

/** Legacy static/public photo URL fallback (pre-R2 seeds like M57). */
export function documentPhotoUrl(document: CatalogItemAdminDocument): string | undefined {
  return readString(document, "photoUrl");
}

/** Legacy static/public GLB URL fallback (P86's canonical seed). */
export function documentModelUrl(document: CatalogItemAdminDocument): string | undefined {
  return readString(document, "modelUrl");
}

export type EffectiveDocumentModelReference = Readonly<
  | { kind: "booth-asset"; url: string; fileName: string }
  | { kind: "stored"; asset: StoredAsset; fileName: string }
  | { kind: "legacy-url"; url: string; fileName: string }
>;

function modelFileName(url: string): string {
  return url.split(/[?#]/u)[0]?.split("/").pop() || url;
}

/** Canonical boothAsset wins; R2 and legacy references remain supported as fallbacks. */
export function documentEffectiveModelReference(
  document: CatalogItemAdminDocument,
): EffectiveDocumentModelReference | undefined {
  const boothAsset = resolveBoothAssetDefinition(document);
  if (boothAsset && isRuntimeGlbReference(boothAsset.glbAssetPath)) {
    return {
      kind: "booth-asset",
      url: boothAsset.glbAssetPath,
      fileName: modelFileName(boothAsset.glbAssetPath),
    };
  }

  const stored = documentModelAsset(document);
  if (stored && isRuntimeGlbReference(stored.storageKey)) {
    return { kind: "stored", asset: stored, fileName: stored.originalFileName };
  }

  const legacyUrl = documentModelUrl(document);
  if (legacyUrl && isRuntimeGlbReference(legacyUrl)) {
    return { kind: "legacy-url", url: legacyUrl, fileName: modelFileName(legacyUrl) };
  }

  const assets = document.assets as { models3d?: readonly { url?: unknown }[] } | undefined;
  const legacyAssetUrl = assets?.models3d?.find(
    (asset) => typeof asset.url === "string" && isRuntimeGlbReference(asset.url),
  )?.url;
  return typeof legacyAssetUrl === "string"
    ? { kind: "legacy-url", url: legacyAssetUrl, fileName: modelFileName(legacyAssetUrl) }
    : undefined;
}

/** Set exclusively by the explicit "Označit jako zkontrolované" action (section 9) — never as a side effect of an asset upload. */
export function documentReviewedAt(document: CatalogItemAdminDocument): string | undefined {
  return readString(document, "reviewedAt");
}

export type DocumentFootprint2D = Readonly<{ shape: "rectangle" | "circle" | "symbol"; symbol?: string }>;
const FOOTPRINT_SHAPES = ["rectangle", "circle", "symbol"] as const;

/** Mirrors evaluateCatalogReadiness's has2DRepresentation() check (Boolean(item.footprint2D)) — used for admin display only, never a second readiness rule. */
export function documentFootprint2D(document: CatalogItemAdminDocument): DocumentFootprint2D | undefined {
  const value = document.footprint2D;
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.shape !== "string" || !(FOOTPRINT_SHAPES as readonly string[]).includes(candidate.shape)) return undefined;
  return { shape: candidate.shape as DocumentFootprint2D["shape"], symbol: typeof candidate.symbol === "string" ? candidate.symbol : undefined };
}

export type SourceTraceability = Readonly<{ sourceSystem: string | null; sourceKey: string | null }>;

/** Read-only provenance — never editable from the admin UI (section 8 of the spec). */
export function documentSourceTraceability(document: CatalogItemAdminDocument): SourceTraceability {
  return { sourceSystem: readString(document, "sourceSystem") ?? null, sourceKey: readString(document, "sourceKey") ?? null };
}

export type DocumentBasePricing = Readonly<{ czk: number | null; eur: number | null }>;

/** "Base" pricing = a PricingEntry with no priceListId/exhibitionId (see domain/catalog.ts getBasePricingEntry) — never event pricing_entries. */
export function documentBasePricing(document: CatalogItemAdminDocument): DocumentBasePricing {
  const entries = Array.isArray(document.pricingEntries) ? (document.pricingEntries as readonly PricingEntry[]) : undefined;
  return {
    czk: getBasePricingEntry(entries, "CZK")?.salePrice ?? null,
    eur: getBasePricingEntry(entries, "EUR")?.salePrice ?? null,
  };
}

/** Adapts a document (ComponentDefinition- or BoothType-shaped) + its real lifecycle_status column into the shape evaluateCatalogReadiness/isGeneratorEligible expect — same spread+cast technique already established by domain/catalogPricing.ts's computeGeneratorEligible. */
function toReadinessAdapter(item: Pick<CatalogItemAdmin, "document" | "lifecycleStatus">): ComponentDefinition {
  return { ...item.document, lifecycleStatus: item.lifecycleStatus } as ComponentDefinition;
}

export function computeReadiness(item: Pick<CatalogItemAdmin, "document" | "lifecycleStatus" | "kind">): ReadinessResult {
  return evaluateCatalogReadiness(toReadinessAdapter(item), item.kind);
}

/** NEVER stored — always live-computed, so a stale flag can never drift from the real rules. */
export function computeGeneratorEligibleLive(item: Pick<CatalogItemAdmin, "document" | "lifecycleStatus" | "kind">): boolean {
  return isGeneratorEligible(toReadinessAdapter(item), item.kind);
}

export type CatalogItemAdminListEntry = Readonly<{
  id: string;
  internalCode: string | null;
  abfCode: string | null;
  itemType: CatalogItemType;
  itemTypeNeedsReview: boolean;
  packageItemCount: number;
  displayName: string;
  kind: CatalogItemKind;
  category: string | null;
  lifecycleStatus: CatalogItemStatus;
  widthMm: number | null;
  depthMm: number | null;
  heightMm: number | null;
  hasDimensions: boolean;
  has3DAsset: boolean;
  basePriceCzk: number | null;
  basePriceEur: number | null;
  readiness: ReadinessResult;
  generatorEligible: boolean;
  /** The item's own canonical thumbnail source (never a signed URL) — see hooks/useAssetUrl for resolution. photoAsset wins when present; photoUrl is the legacy static fallback (e.g. M57). */
  photoAsset: StoredAsset | undefined;
  photoUrl: string | undefined;
}>;

export function buildCatalogItemListEntry(item: CatalogItemAdmin): CatalogItemAdminListEntry {
  const dims = documentDimensions(item.document);
  const pricing = documentBasePricing(item.document);
  return {
    id: item.id,
    internalCode: item.internalCode,
    abfCode: abfCodeOf(item),
    itemType: itemTypeOf(item),
    itemTypeNeedsReview: documentItemTypeNeedsReview(item.document),
    packageItemCount: item.packageItems?.length ?? 0,
    displayName: item.displayName,
    kind: item.kind,
    category: item.category,
    lifecycleStatus: item.lifecycleStatus,
    widthMm: dims.widthMm,
    depthMm: dims.depthMm,
    heightMm: dims.heightMm,
    hasDimensions: dims.hasDimensions,
    has3DAsset: documentHas3DAsset(item.document),
    basePriceCzk: pricing.czk,
    basePriceEur: pricing.eur,
    readiness: computeReadiness(item),
    generatorEligible: computeGeneratorEligibleLive(item),
    photoAsset: documentPhotoAsset(item.document),
    photoUrl: documentPhotoUrl(item.document),
  };
}

// ============================================================================
// FILTERS — list-view search/category/status/readiness/asset (section 5). Every option here
// is a value the real model already supports; nothing invented.
// ============================================================================

export type CatalogItemAdminFilters = Readonly<{
  query?: string;
  kind?: CatalogItemKind | "";
  itemType?: CatalogItemType | "";
  lifecycleStatus?: CatalogItemStatus | "";
  readiness?: "ready" | "not-ready" | "";
  asset?: "has-3d" | "missing-3d" | "";
  /** Default false: archived items are hidden from every admin list unless explicitly shown — never deleted, just not cluttering the default view. */
  showArchived?: boolean;
  /** "Jen archivované" — the archive view; wins over showArchived. */
  onlyArchived?: boolean;
  /** "K zařazení" — only cards whose type the import could not safely determine. */
  needsTypeReview?: boolean;
}>;

function normalizedText(value: string): string {
  return value.toLocaleLowerCase("cs").normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

export function matchesCatalogItemAdminSearch(
  entry: Pick<CatalogItemAdminListEntry, "internalCode" | "displayName" | "category"> & Partial<Pick<CatalogItemAdminListEntry, "abfCode">>,
  query: string,
): boolean {
  if (!query.trim()) return true;
  const haystack = normalizedText(`${entry.internalCode ?? ""} ${entry.abfCode ?? ""} ${entry.displayName} ${entry.category ?? ""}`);
  return haystack.includes(normalizedText(query));
}

export function filterCatalogItemsAdmin(entries: readonly CatalogItemAdminListEntry[], filters: CatalogItemAdminFilters): readonly CatalogItemAdminListEntry[] {
  return entries.filter((entry) => {
    // Archived items are excluded from the default view regardless of any other filter —
    // "Zobrazit archivované" is the one explicit switch that reveals them (section 3).
    if (filters.onlyArchived) {
      if (entry.lifecycleStatus !== "archived") return false;
    } else if (entry.lifecycleStatus === "archived" && !filters.showArchived) return false;
    if (filters.query && !matchesCatalogItemAdminSearch(entry, filters.query)) return false;
    if (filters.itemType && entry.itemType !== filters.itemType) return false;
    if (filters.needsTypeReview && !entry.itemTypeNeedsReview) return false;
    if (filters.kind && entry.kind !== filters.kind) return false;
    if (filters.lifecycleStatus && entry.lifecycleStatus !== filters.lifecycleStatus) return false;
    if (filters.readiness === "ready" && !entry.readiness.ready) return false;
    if (filters.readiness === "not-ready" && entry.readiness.ready) return false;
    if (filters.asset === "has-3d" && !entry.has3DAsset) return false;
    if (filters.asset === "missing-3d" && entry.has3DAsset) return false;
    return true;
  });
}

// ============================================================================
// SORT — deterministic default list ordering, applied AFTER filtering (never before — filtering
// must never depend on/disturb sort order, and sorting a filtered subset is cheaper than sorting
// everything up front). NEVER trusts DB/API return order (created_at, updated_at, Supabase's own
// row order): active items always first, then alphabetical (Czech-locale) or natural/numeric
// order within each lifecycle group, with internalCode then id as final tie-breakers so the list
// can never visibly reshuffle between renders for otherwise-identical entries.
// ============================================================================

const CZECH_TEXT_COLLATOR = new Intl.Collator("cs", { sensitivity: "base" });
/** numeric:true makes "T4" < "T6" < "T10" compare correctly instead of lexicographic "T10" < "T4" — matters even though today's real Txx codes happen to already be zero-padded (T04, T06, ...). */
const NATURAL_CODE_COLLATOR = new Intl.Collator("cs", { sensitivity: "base", numeric: true });

/** active is always group 0; every other status keeps CATALOG_ITEM_STATUSES' own declared relative order (draft, needs_review, [active — already handled], inactive, archived). */
function lifecycleGroupRank(status: CatalogItemStatus): number {
  if (status === "active") return -1;
  const declaredIndex = CATALOG_ITEM_STATUSES.indexOf(status);
  return declaredIndex === -1 ? CATALOG_ITEM_STATUSES.length : declaredIndex;
}

function compareByLifecycleGroup<T extends Pick<CatalogItemAdminListEntry, "lifecycleStatus">>(a: T, b: T): number {
  return lifecycleGroupRank(a.lifecycleStatus) - lifecycleGroupRank(b.lifecycleStatus);
}

function compareByIdentityTieBreak<T extends Pick<CatalogItemAdminListEntry, "internalCode" | "id">>(a: T, b: T): number {
  return NATURAL_CODE_COLLATOR.compare(a.internalCode ?? "", b.internalCode ?? "") || NATURAL_CODE_COLLATOR.compare(a.id, b.id);
}

/**
 * Default ordering for "Administrace → Komponenty" and "Knihovna stánků → Komponenty stánku":
 * active first, then alphabetical (cs locale) by displayName within each lifecycle group,
 * internalCode/id as final deterministic tie-breakers.
 */
export function sortCatalogItemsAdminByName<T extends Pick<CatalogItemAdminListEntry, "displayName" | "lifecycleStatus" | "internalCode" | "id">>(
  entries: readonly T[],
): readonly T[] {
  return entries.slice().sort((a, b) =>
    compareByLifecycleGroup(a, b) ||
    CZECH_TEXT_COLLATOR.compare(a.displayName, b.displayName) ||
    compareByIdentityTieBreak(a, b),
  );
}

/**
 * Default ordering for "Knihovna stánků → Typové stánky": active first, then natural/numeric
 * order by internalCode within each lifecycle group (P86, P87, T04, T06, ... rather than a
 * name-based sort) — internalCode is how this catalog identifies these lines, so it reads more
 * naturally than alphabetizing "Kóje 2 × 2 m" against "Typový stánek octanorm - T4". Falls back
 * to displayName then id for entries that somehow lack a code.
 */
export function sortCatalogItemsAdminByCode<T extends Pick<CatalogItemAdminListEntry, "displayName" | "lifecycleStatus" | "internalCode" | "id">>(
  entries: readonly T[],
): readonly T[] {
  return entries.slice().sort((a, b) =>
    compareByLifecycleGroup(a, b) ||
    NATURAL_CODE_COLLATOR.compare(a.internalCode ?? "", b.internalCode ?? "") ||
    CZECH_TEXT_COLLATOR.compare(a.displayName, b.displayName) ||
    NATURAL_CODE_COLLATOR.compare(a.id, b.id),
  );
}

// ============================================================================
// EDIT — whitelisted fields only (section 7/8). internalCode/sourceSystem/sourceKey/document
// wholesale are NEVER accepted here, no matter what a raw request body contains.
// ============================================================================

export type CatalogItemAdminEdit = Readonly<{
  displayName?: string;
  name?: string;
  category?: string;
  unit?: string;
  widthMm?: number;
  depthMm?: number;
  heightMm?: number;
  lifecycleStatus?: CatalogItemStatus;
  /** undefined = leave unchanged; a StoredAsset = set/replace; null = explicit remove. Remove is ALWAYS metadata-only — see lib/db/catalogItemsAdmin.supabase.ts, never a physical R2 delete (mirrors app/api/assets/delete's reference-safety no-op). */
  photoAsset?: StoredAsset | null;
  modelAsset?: StoredAsset | null;
  /**
   * Source/manufacturing files (SKP/DWG/DXF/PDF/other) are a LIST, unlike the single
   * photo/model asset — one edit either appends one new entry or removes one existing entry by
   * id, never a wholesale replace. Removal is metadata-only, same reference-safety guarantee as
   * photoAsset/modelAsset above.
   */
  addSourceAsset?: Readonly<{ kind: SourceAssetKind; label?: string; asset: StoredAsset }>;
  removeSourceAssetId?: string;
  /**
   * Sets/clears ONE variant's own GLB or photo by its stable `id` — never a wholesale replace of
   * the variants array, and never able to create/remove a variant itself (that's a structural
   * change made only by the canonical migration script, not the admin edit form). A variantId
   * that matches nothing is a silent no-op, same reference-safety spirit as removeSourceAssetId.
   */
  setVariantModelAsset?: Readonly<{ variantId: string; asset: StoredAsset | null }>;
  setVariantPhotoAsset?: Readonly<{ variantId: string; asset: StoredAsset | null }>;
  /** Same list-semantics as addSourceAsset/removeSourceAssetId (append one / remove one by id), scoped to ONE variant's own sourceAssets by variantId. A variantId/sourceAssetId matching nothing is a silent no-op. */
  addVariantSourceAsset?: Readonly<{ variantId: string; kind: SourceAssetKind; label?: string; asset: StoredAsset }>;
  removeVariantSourceAssetId?: Readonly<{ variantId: string; sourceAssetId: string }>;
  /** Section 9: the ONLY way reviewedAt is ever set — never as a side effect of an asset upload. The server stamps the actual timestamp (see saveCatalogItemAdmin); a client-supplied date is never trusted. */
  markReviewed?: true;
  /**
   * Explicit "used in generator" declaration — the SAME showIn2D/showIn3D fields
   * evaluateCatalogReadiness() already reads (domain/catalogReadiness.ts's
   * declaresSceneCapability/has2DRepresentation/has3DAsset checks). Never auto-set from kind
   * or internalCode; only ever changed by an explicit admin action.
   */
  showIn2D?: boolean;
  showIn3D?: boolean;
  /**
   * "TECHNICKÉ RASTRY" section (spec batch 11) — `undefined` = leave unchanged; a
   * TechnicalRasterComponentConfig = REPLACE the whole stored config with exactly this object
   * (same whole-value-replace discipline as photoAsset/modelAsset, never a partial server-side
   * merge of individual sub-fields — the admin form itself is responsible for sending the
   * complete resulting object); `null` = "Obnovit výchozí nastavení" (explicit reset — removes
   * the override entirely, the resolver then falls through to the central default).
   */
  technicalRaster?: TechnicalRasterComponentConfig | null;
  /**
   * ABF code (catalog_items.abf_code) — `undefined` = unchanged, `null` = clear, string = set.
   * Freely editable (an ABF code may change in future without breaking anything internal: every
   * internal reference uses the row id / internalCode). Uniqueness is enforced by the repository
   * and by the DB's partial unique index.
   */
  abfCode?: string | null;
  /**
   * Fills the internal code of a card that has NONE yet (e.g. an INTERNAL_COMPONENT like
   * "Sloupek 2500" -> INT-SLOUPEK-2500). Deliberately a separate, explicit field: a plain
   * `internalCode` key in a request body is still dropped by the whitelist, and an existing
   * internal code is never rewritten (technical-service pricing and saved projects look items up
   * by it) — the repository rejects a fill on a card that already has one.
   */
  fillInternalCode?: string;
  /** Catalog card type. If the current kind doesn't fit the new type, kind moves to the type's default kind. */
  itemType?: CatalogItemType;
  /** Readiness profile — must be compatible with the (resulting) item type. */
  kind?: CatalogItemKind;
  /** "Poznámka" — internal free text. */
  note?: string;
  /** SERVICE technical metadata — whole-value replace, `null` = clear. */
  serviceTechnical?: ServiceTechnicalMetadata | null;
  /** Explicitly confirms the current card type (clears the import's "K zařazení" flag) without changing it. */
  confirmItemType?: true;
  /**
   * "Obnovit" from the archive — the repository resolves the target status via
   * resolveRestoreStatus() (previous status, re-checked against readiness), never a client-chosen
   * status. Takes precedence over lifecycleStatus.
   */
  restoreFromArchive?: true;
}>;

export class InvalidCatalogItemAdminEditError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "InvalidCatalogItemAdminEditError";
    this.field = field;
  }
}

const NOTE_MAX_LENGTH = 2000;

const EDITABLE_STRING_KEYS = ["displayName", "name", "category", "unit"] as const;
const EDITABLE_NUMBER_KEYS = ["widthMm", "depthMm", "heightMm"] as const;
const EDITABLE_BOOLEAN_KEYS = ["showIn2D", "showIn3D"] as const;
const EDITABLE_ASSET_KEYS = ["photoAsset", "modelAsset"] as const;

/** Whitelists a raw (possibly attacker-controlled) JSON body — anything not explicitly listed here is silently dropped, never merged. */
export function parseCatalogItemAdminEdit(body: unknown): CatalogItemAdminEdit {
  if (!body || typeof body !== "object") return {};
  const raw = body as Record<string, unknown>;
  const edit: { -readonly [K in keyof CatalogItemAdminEdit]?: CatalogItemAdminEdit[K] } = {};
  for (const key of EDITABLE_STRING_KEYS) {
    const value = raw[key];
    if (typeof value === "string") edit[key] = value;
  }
  for (const key of EDITABLE_NUMBER_KEYS) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) edit[key] = value;
  }
  if (typeof raw.lifecycleStatus === "string" && isValidCatalogItemStatus(raw.lifecycleStatus)) edit.lifecycleStatus = raw.lifecycleStatus;
  for (const key of EDITABLE_BOOLEAN_KEYS) {
    const value = raw[key];
    if (typeof value === "boolean") edit[key] = value;
  }
  for (const key of EDITABLE_ASSET_KEYS) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (value === null) edit[key] = null;
    else if (isStoredAssetShape(value)) edit[key] = value;
  }
  if (raw.markReviewed === true) edit.markReviewed = true;
  if (raw.addSourceAsset && typeof raw.addSourceAsset === "object") {
    const candidate = raw.addSourceAsset as Record<string, unknown>;
    if ((SOURCE_ASSET_KINDS as readonly string[]).includes(candidate.kind as string) && isStoredAssetShape(candidate.asset)) {
      edit.addSourceAsset = {
        kind: candidate.kind as SourceAssetKind,
        asset: candidate.asset,
        label: typeof candidate.label === "string" ? candidate.label : undefined,
      };
    }
  }
  if (typeof raw.removeSourceAssetId === "string" && raw.removeSourceAssetId) edit.removeSourceAssetId = raw.removeSourceAssetId;
  for (const key of ["setVariantModelAsset", "setVariantPhotoAsset"] as const) {
    const value = raw[key];
    if (!value || typeof value !== "object") continue;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.variantId !== "string" || !candidate.variantId) continue;
    if (candidate.asset === null) edit[key] = { variantId: candidate.variantId, asset: null };
    else if (isStoredAssetShape(candidate.asset)) edit[key] = { variantId: candidate.variantId, asset: candidate.asset };
  }
  if (raw.addVariantSourceAsset && typeof raw.addVariantSourceAsset === "object") {
    const candidate = raw.addVariantSourceAsset as Record<string, unknown>;
    if (
      typeof candidate.variantId === "string" && candidate.variantId &&
      (SOURCE_ASSET_KINDS as readonly string[]).includes(candidate.kind as string) &&
      isStoredAssetShape(candidate.asset)
    ) {
      edit.addVariantSourceAsset = {
        variantId: candidate.variantId,
        kind: candidate.kind as SourceAssetKind,
        asset: candidate.asset,
        label: typeof candidate.label === "string" ? candidate.label : undefined,
      };
    }
  }
  if (raw.removeVariantSourceAssetId && typeof raw.removeVariantSourceAssetId === "object") {
    const candidate = raw.removeVariantSourceAssetId as Record<string, unknown>;
    if (typeof candidate.variantId === "string" && candidate.variantId && typeof candidate.sourceAssetId === "string" && candidate.sourceAssetId) {
      edit.removeVariantSourceAssetId = { variantId: candidate.variantId, sourceAssetId: candidate.sourceAssetId };
    }
  }
  if ("technicalRaster" in raw) {
    if (raw.technicalRaster === null) edit.technicalRaster = null;
    else {
      const parsed = parseTechnicalRasterConfig(raw.technicalRaster);
      if (parsed) edit.technicalRaster = parsed;
    }
  }
  if ("abfCode" in raw) {
    if (raw.abfCode === null || raw.abfCode === "") edit.abfCode = null;
    else {
      const normalized = normalizeAbfCode(raw.abfCode);
      if (normalized === null) throw new InvalidCatalogItemAdminEditError("abfCode", "ABF kód nesmí obsahovat mezery ani uvozovky a může mít nejvýše 32 znaků.");
      edit.abfCode = normalized ?? null;
    }
  }
  if (typeof raw.fillInternalCode === "string" && raw.fillInternalCode.trim()) {
    const normalized = normalizeInternalCode(raw.fillInternalCode);
    if (!normalized) throw new InvalidCatalogItemAdminEditError("fillInternalCode", "Interní kód nesmí obsahovat mezery ani uvozovky a může mít nejvýše 64 znaků.");
    edit.fillInternalCode = normalized;
  }
  if (raw.itemType !== undefined) {
    if (!isCatalogItemType(raw.itemType)) throw new InvalidCatalogItemAdminEditError("itemType", "Neplatný typ katalogové karty.");
    edit.itemType = raw.itemType;
  }
  if (raw.kind !== undefined) {
    if (typeof raw.kind !== "string" || !isKnownCatalogItemKind(raw.kind)) throw new InvalidCatalogItemAdminEditError("kind", "Neplatný druh položky (kind).");
    edit.kind = raw.kind;
  }
  if (typeof raw.note === "string") edit.note = raw.note.slice(0, NOTE_MAX_LENGTH);
  if ("serviceTechnical" in raw) {
    edit.serviceTechnical = raw.serviceTechnical === null ? null : (parseServiceTechnical(raw.serviceTechnical) ?? null);
  }
  if (raw.confirmItemType === true) edit.confirmItemType = true;
  if (raw.restoreFromArchive === true) edit.restoreFromArchive = true;
  return edit;
}

/**
 * Resolves the item type + kind a save will end with, enforcing compatibility. Pure — the
 * repository applies the result to the columns. Throws InvalidCatalogItemAdminEditError for an
 * incompatible explicit kind, or for any kind change on an ACTIVE item (an active item feeds the
 * live generator; its readiness profile must not silently change under it — deactivate/archive
 * first).
 */
export function resolveTypeAndKindEdit(
  current: Pick<CatalogItemAdmin, "itemType" | "kind" | "lifecycleStatus">,
  edit: Pick<CatalogItemAdminEdit, "itemType" | "kind">,
): Readonly<{ itemType: CatalogItemType; kind: CatalogItemKind }> {
  const itemType = edit.itemType ?? itemTypeOf(current);
  let kind = edit.kind ?? current.kind;
  if (!isKindCompatibleWithItemType(kind, itemType)) {
    if (edit.kind !== undefined) {
      throw new InvalidCatalogItemAdminEditError("kind", "Zvolený druh položky (kind) neodpovídá typu karty.");
    }
    kind = defaultKindForItemType(itemType);
  }
  if (kind !== current.kind && current.lifecycleStatus === "active") {
    throw new InvalidCatalogItemAdminEditError(
      "itemType",
      "Aktivní položce nelze změnit typ/druh — používá ji generátor. Nejdřív ji archivujte nebo převeďte do stavu K doplnění.",
    );
  }
  return { itemType, kind };
}

/**
 * "Obnovit" target status: the status the item had before archival (stored as
 * document.archivedFromStatus by the archive action). A previously-ACTIVE item only returns to
 * active if it still passes readiness today; otherwise — and for legacy archives without the
 * stored status — it lands on needs_review, never silently active.
 */
export function resolveRestoreStatus(item: Pick<CatalogItemAdmin, "document" | "kind">): CatalogItemStatus {
  const previous = item.document.archivedFromStatus;
  if (typeof previous !== "string" || !isValidCatalogItemStatus(previous) || previous === "archived") return "needs_review";
  if (previous === "active") {
    const readiness = evaluateCatalogReadiness({ ...item.document, lifecycleStatus: "active" } as ComponentDefinition, item.kind);
    return readiness.ready ? "active" : "needs_review";
  }
  return previous;
}

/**
 * Pure merge into the EXISTING document — spreads first so every unknown/non-whitelisted field
 * (parts, printSurfaces, pricingEntries, assets, sourceSystem, sourceKey, ...) survives
 * untouched. This is the P86-sanity guarantee (section 12): save can never serialize a small
 * form and silently drop canonical metadata.
 */
export function applyCatalogItemEdit(document: CatalogItemAdminDocument, edit: CatalogItemAdminEdit): CatalogItemAdminDocument {
  const next: CatalogItemAdminDocument = { ...document };
  if (edit.displayName !== undefined) next.displayName = edit.displayName;
  if (edit.name !== undefined) next.name = edit.name;
  if (edit.category !== undefined) next.category = edit.category;
  if (edit.unit !== undefined) next.unit = edit.unit;
  if (edit.widthMm !== undefined) next.widthMm = edit.widthMm;
  if (edit.depthMm !== undefined) next.depthMm = edit.depthMm;
  if (edit.heightMm !== undefined) next.heightMm = edit.heightMm;
  if (edit.lifecycleStatus !== undefined) next.lifecycleStatus = edit.lifecycleStatus;
  if (edit.showIn2D !== undefined) next.showIn2D = edit.showIn2D;
  if (edit.showIn3D !== undefined) next.showIn3D = edit.showIn3D;
  if (edit.note !== undefined) {
    if (edit.note.trim()) next.note = edit.note;
    else delete next.note;
  }
  if (edit.serviceTechnical === null) delete next.serviceTechnical;
  else if (edit.serviceTechnical !== undefined) next.serviceTechnical = edit.serviceTechnical;
  if (edit.kind !== undefined) next.catalogItemKind = edit.kind;
  // Any explicit type decision (set or confirm) resolves the import's "K zařazení" flag.
  if (edit.itemType !== undefined || edit.confirmItemType === true) delete next.itemTypeNeedsReview;
  // "Obnovit výchozí nastavení" (spec batch 11 section 18) — null removes the override entirely,
  // never leaves a stray empty {} object sitting in the document (documentTechnicalRaster/
  // parseTechnicalRasterConfig already treat {} as "nothing configured", but deleting it outright
  // keeps a reset genuinely indistinguishable from "never configured" in the raw JSON too).
  if (edit.technicalRaster === null) delete next.technicalRaster;
  else if (edit.technicalRaster !== undefined) next.technicalRaster = edit.technicalRaster;
  // Section 5 of the capability-hardening spec: showIn2D=true needs SOME 2D representation
  // (evaluateCatalogReadiness's has2DRepresentation just checks footprint2D presence) — reuse
  // the exact minimal shape M57's own seed already uses ({shape:"rectangle"}), never a new
  // SVG/thumbnail system. Only fills a gap; never overwrites an already-set footprint2D.
  if (edit.showIn2D === true && !next.footprint2D) {
    next.footprint2D = { shape: "rectangle" };
  }
  if (edit.photoAsset === null) delete next.photoAsset;
  else if (edit.photoAsset !== undefined) next.photoAsset = edit.photoAsset;
  if (edit.modelAsset === null) delete next.modelAsset;
  else if (edit.modelAsset !== undefined) next.modelAsset = edit.modelAsset;
  if (edit.addSourceAsset || edit.removeSourceAssetId !== undefined) {
    const existing: readonly SourceAssetEntry[] = Array.isArray(document.sourceAssets)
      ? (document.sourceAssets as readonly SourceAssetEntry[])
      : [];
    let updated = existing;
    if (edit.removeSourceAssetId !== undefined) {
      updated = updated.filter((entry) => entry.id !== edit.removeSourceAssetId);
    }
    if (edit.addSourceAsset) {
      updated = [...updated, { id: crypto.randomUUID(), kind: edit.addSourceAsset.kind, label: edit.addSourceAsset.label, asset: edit.addSourceAsset.asset }];
    }
    next.sourceAssets = updated;
  }
  if (edit.setVariantModelAsset || edit.setVariantPhotoAsset || edit.addVariantSourceAsset || edit.removeVariantSourceAssetId) {
    const existingVariants = documentVariants(document);
    next.variants = existingVariants.map((variant) => {
      let nextVariant = variant;
      if (edit.setVariantModelAsset && variant.id === edit.setVariantModelAsset.variantId) {
        const { modelAsset: _unused, ...withoutModel } = nextVariant;
        nextVariant = edit.setVariantModelAsset.asset === null ? withoutModel : { ...withoutModel, modelAsset: edit.setVariantModelAsset.asset };
      }
      if (edit.setVariantPhotoAsset && variant.id === edit.setVariantPhotoAsset.variantId) {
        const { photoAsset: _unused, ...withoutPhoto } = nextVariant;
        nextVariant = edit.setVariantPhotoAsset.asset === null ? withoutPhoto : { ...withoutPhoto, photoAsset: edit.setVariantPhotoAsset.asset };
      }
      const touchesSourceAssets =
        (edit.addVariantSourceAsset && variant.id === edit.addVariantSourceAsset.variantId) ||
        (edit.removeVariantSourceAssetId && variant.id === edit.removeVariantSourceAssetId.variantId);
      if (touchesSourceAssets) {
        let updatedSourceAssets: readonly SourceAssetEntry[] = nextVariant.sourceAssets ?? [];
        if (edit.removeVariantSourceAssetId && variant.id === edit.removeVariantSourceAssetId.variantId) {
          updatedSourceAssets = updatedSourceAssets.filter((entry) => entry.id !== edit.removeVariantSourceAssetId!.sourceAssetId);
        }
        if (edit.addVariantSourceAsset && variant.id === edit.addVariantSourceAsset.variantId) {
          updatedSourceAssets = [
            ...updatedSourceAssets,
            { id: crypto.randomUUID(), kind: edit.addVariantSourceAsset.kind, label: edit.addVariantSourceAsset.label, asset: edit.addVariantSourceAsset.asset },
          ];
        }
        nextVariant = { ...nextVariant, sourceAssets: updatedSourceAssets };
      }
      return nextVariant;
    });
  }
  return next;
}

// ============================================================================
// CREATE — a brand-new catalog_items row (section: "Nová komponenta stánku" workflow). Always
// lifecycle_status="needs_review" (enforced by the repository, this input has no such field at
// all), never a fake import sourceSystem/sourceKey, internalCode never auto-generated.
// ============================================================================

export type CatalogItemAdminCreateInput = Readonly<{
  kind: CatalogItemKind;
  /** Card type. Optional for older callers (BoothComponentCreateForm sends kind only) — derived from kind then. */
  itemType?: CatalogItemType;
  displayName: string;
  internalCode?: string;
  /** Never required — and for INTERNAL_COMPONENT typically absent. */
  abfCode?: string;
  note?: string;
  category: string;
  unit?: string;
  widthMm?: number;
  depthMm?: number;
  heightMm?: number;
  showIn2D?: boolean;
  showIn3D?: boolean;
}>;

export class InvalidCatalogItemAdminCreateInputError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "InvalidCatalogItemAdminCreateInputError";
    this.field = field;
  }
}

function requiredNonBlankString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new InvalidCatalogItemAdminCreateInputError(key, `Pole "${key}" je povinné.`);
  }
  return value.trim();
}

/** Whitelists a raw (possibly attacker-controlled) JSON body for creating a brand-new catalog item. Unlike parseCatalogItemAdminEdit, `kind`/`displayName`/`category` are required, not merely accepted-if-present. */
export function parseCatalogItemAdminCreateInput(body: unknown): CatalogItemAdminCreateInput {
  if (!body || typeof body !== "object") {
    throw new InvalidCatalogItemAdminCreateInputError("body", "Chybí data pro vytvoření položky.");
  }
  const raw = body as Record<string, unknown>;

  if (raw.itemType !== undefined && !isCatalogItemType(raw.itemType)) {
    throw new InvalidCatalogItemAdminCreateInputError("itemType", "Neplatný typ katalogové karty.");
  }
  const requestedItemType = raw.itemType as CatalogItemType | undefined;
  if (raw.kind !== undefined && (typeof raw.kind !== "string" || !isKnownCatalogItemKind(raw.kind))) {
    throw new InvalidCatalogItemAdminCreateInputError("kind", "Neplatný druh položky (kind).");
  }
  if (raw.kind === undefined && !requestedItemType) {
    throw new InvalidCatalogItemAdminCreateInputError("itemType", "Vyberte typ položky (Produkt / Služba / Stánek / Interní komponenta).");
  }
  const kind = (raw.kind as CatalogItemKind | undefined) ?? defaultKindForItemType(requestedItemType!);
  const itemType = requestedItemType ?? defaultItemTypeForKind(kind);
  if (!isKindCompatibleWithItemType(kind, itemType)) {
    throw new InvalidCatalogItemAdminCreateInputError("kind", "Zvolený druh položky (kind) neodpovídá typu karty.");
  }
  const displayName = requiredNonBlankString(raw, "displayName");
  const category = requiredNonBlankString(raw, "category");

  const input: { -readonly [K in keyof CatalogItemAdminCreateInput]?: CatalogItemAdminCreateInput[K] } = {
    kind,
    itemType,
    displayName,
    category,
  };

  if (typeof raw.internalCode === "string" && raw.internalCode.trim()) {
    const normalized = normalizeInternalCode(raw.internalCode);
    if (!normalized) throw new InvalidCatalogItemAdminCreateInputError("internalCode", "Interní kód nesmí obsahovat mezery ani uvozovky a může mít nejvýše 64 znaků.");
    input.internalCode = normalized;
  }
  if (typeof raw.abfCode === "string" && raw.abfCode.trim()) {
    const normalized = normalizeAbfCode(raw.abfCode);
    if (!normalized) throw new InvalidCatalogItemAdminCreateInputError("abfCode", "ABF kód nesmí obsahovat mezery ani uvozovky a může mít nejvýše 32 znaků.");
    input.abfCode = normalized;
  }
  if (typeof raw.note === "string" && raw.note.trim()) input.note = raw.note.slice(0, NOTE_MAX_LENGTH);
  if (typeof raw.unit === "string" && raw.unit.trim()) input.unit = raw.unit;
  if (typeof raw.widthMm === "number" && Number.isFinite(raw.widthMm)) input.widthMm = raw.widthMm;
  if (typeof raw.depthMm === "number" && Number.isFinite(raw.depthMm)) input.depthMm = raw.depthMm;
  if (typeof raw.heightMm === "number" && Number.isFinite(raw.heightMm)) input.heightMm = raw.heightMm;
  if (typeof raw.showIn2D === "boolean") input.showIn2D = raw.showIn2D;
  if (typeof raw.showIn3D === "boolean") input.showIn3D = raw.showIn3D;

  return input as CatalogItemAdminCreateInput;
}

/**
 * Builds the JSONB document for a brand-new catalog item. Deliberately omits internalCode (lives
 * only in the DB column), sourceSystem/sourceKey (no fake import provenance — see
 * documentSourceTraceability), reviewedAt (never auto-reviewed), and lifecycleStatus (the outer
 * DB column is the single source of truth, matching saveCatalogItemAdmin's existing pattern).
 */
export function buildCatalogItemCreateDocument(input: CatalogItemAdminCreateInput): CatalogItemAdminDocument {
  const document: CatalogItemAdminDocument = {
    displayName: input.displayName,
    name: input.displayName,
    category: input.category,
    catalogItemKind: input.kind,
  };
  if (input.unit !== undefined) document.unit = input.unit;
  if (input.note !== undefined) document.note = input.note;
  if (input.widthMm !== undefined) document.widthMm = input.widthMm;
  if (input.depthMm !== undefined) document.depthMm = input.depthMm;
  if (input.heightMm !== undefined) document.heightMm = input.heightMm;
  if (input.showIn2D !== undefined) document.showIn2D = input.showIn2D;
  if (input.showIn3D !== undefined) document.showIn3D = input.showIn3D;
  // Section 5 of the capability-hardening spec (mirrored from applyCatalogItemEdit): showIn2D=true
  // needs SOME 2D representation — fill the minimal shape so a freshly-created item is never left
  // in the inconsistent "showIn2D=true, no footprint2D" state.
  if (input.showIn2D === true) document.footprint2D = { shape: "rectangle" };
  return document;
}

// ============================================================================
// DUPLICATE — "Duplikovat" copies a card's own catalog content (dimensions, assets references,
// scene flags, technical metadata, package contents) into a NEW needs_review card. Identity and
// provenance never travel: no internal/ABF code (both unique), no reviewedAt, no import source,
// no archive bookkeeping, no base pricing entries (prices live per PriceList and must be set for
// the new card explicitly — never silently inherited).
// ============================================================================

const DUPLICATE_DROPPED_DOCUMENT_KEYS = [
  "id",
  "internalCode",
  "code",
  "reviewedAt",
  "sourceSystem",
  "sourceKey",
  "abfImport",
  "archivedFromStatus",
  "archivedAt",
  "itemTypeNeedsReview",
  "pricingEntries",
  "lifecycleStatus",
  "boothAsset",
] as const;

export function buildCatalogItemDuplicateDocument(source: Pick<CatalogItemAdmin, "document" | "displayName">, newDisplayName: string): CatalogItemAdminDocument {
  const document: CatalogItemAdminDocument = { ...source.document };
  for (const key of DUPLICATE_DROPPED_DOCUMENT_KEYS) delete document[key];
  document.displayName = newDisplayName;
  document.name = newDisplayName;
  document.duplicatedFromDisplayName = source.displayName;
  return document;
}

export function duplicateDisplayName(displayName: string): string {
  return `${displayName} (kopie)`;
}

// ============================================================================
// ARCHIVE BOOKKEEPING — archive remembers the previous status so "Obnovit" can return to it.
// ============================================================================

export function withArchiveBookkeeping(document: CatalogItemAdminDocument, previousStatus: CatalogItemStatus, archivedAt: string): CatalogItemAdminDocument {
  return { ...document, archivedFromStatus: previousStatus, archivedAt };
}

export function withoutArchiveBookkeeping(document: CatalogItemAdminDocument): CatalogItemAdminDocument {
  const { archivedFromStatus: _status, archivedAt: _at, ...rest } = document;
  return rest;
}

export type BulkLifecycleAction = "archive" | "restore";

export type BulkLifecycleRequest = Readonly<{
  ids: readonly string[];
  action: BulkLifecycleAction;
  /** Bulk archive skips ACTIVE items unless this is explicitly true (they feed the live generator). */
  includeActive?: boolean;
}>;

const BULK_LIFECYCLE_MAX_IDS = 500;

export function parseBulkLifecycleRequest(body: unknown): BulkLifecycleRequest {
  if (!body || typeof body !== "object") throw new InvalidCatalogItemAdminEditError("body", "Chybí data hromadné akce.");
  const raw = body as Record<string, unknown>;
  if (raw.action !== "archive" && raw.action !== "restore") throw new InvalidCatalogItemAdminEditError("action", "Neplatná hromadná akce.");
  if (!Array.isArray(raw.ids) || raw.ids.length === 0 || !raw.ids.every((id) => typeof id === "string" && id)) {
    throw new InvalidCatalogItemAdminEditError("ids", "Vyberte alespoň jednu položku.");
  }
  if (raw.ids.length > BULK_LIFECYCLE_MAX_IDS) throw new InvalidCatalogItemAdminEditError("ids", `Najednou lze zpracovat nejvýše ${BULK_LIFECYCLE_MAX_IDS} položek.`);
  return { ids: [...new Set(raw.ids as string[])], action: raw.action, includeActive: raw.includeActive === true };
}

export type BulkLifecycleOutcome = Readonly<{
  id: string;
  result: "archived" | "restored" | "skipped";
  /** Why it was skipped / what it was restored to. */
  detail: string;
}>;

/**
 * Pure per-item decision for a bulk archive/restore — the repository then applies it. Archiving
 * an already-archived item or restoring a non-archived one is a no-op "skipped", never an error;
 * an ACTIVE item is skipped by bulk archive unless includeActive (explicit confirmation).
 */
export function planBulkLifecycle(
  item: Pick<CatalogItemAdmin, "id" | "lifecycleStatus" | "document" | "kind">,
  request: Pick<BulkLifecycleRequest, "action" | "includeActive">,
): Readonly<{ skip: true; detail: string } | { skip: false; targetStatus: CatalogItemStatus }> {
  if (request.action === "archive") {
    if (item.lifecycleStatus === "archived") return { skip: true, detail: "Už je archivováno." };
    if (item.lifecycleStatus === "active" && !request.includeActive) {
      return { skip: true, detail: "Aktivní položka (používá ji generátor) — přeskočeno, archivujte ji jednotlivě nebo potvrďte zahrnutí aktivních." };
    }
    return { skip: false, targetStatus: "archived" };
  }
  if (item.lifecycleStatus !== "archived") return { skip: true, detail: "Není archivováno." };
  return { skip: false, targetStatus: resolveRestoreStatus(item) };
}

export class CatalogItemAdminNotFoundError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`Katalogová položka ${id} nebyla nalezena.`);
    this.name = "CatalogItemAdminNotFoundError";
    this.id = id;
  }
}

export function isKnownCatalogItemKind(value: string): value is CatalogItemKind {
  return (CATALOG_ITEM_KINDS as readonly string[]).includes(value);
}
