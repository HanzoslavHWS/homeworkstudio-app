/**
 * Live-generator booth picker — DB catalog_items (kind=booth) as the single source of truth,
 * replacing the static data/booths.ts list for THIS one picker (session 2026-08-19). Reuses the
 * SAME readiness/eligibility rules the admin screens already trust (domain/catalogItemsAdmin.ts's
 * computeReadiness/computeGeneratorEligibleLive) — never a parallel/looser production filter —
 * and adapts a catalog_items row into the BoothType shape components/BoothGenerator.tsx already
 * renders, so no UI redesign is needed.
 */
import {
  computeGeneratorEligibleLive,
  computeReadiness,
  documentPhotoAsset,
  documentVariants,
  type CatalogItemAdmin,
} from "./catalogItemsAdmin.ts";
import { pricingPolicyFor } from "./pricing.ts";
import type { BoothType, PricingEntry } from "./models.ts";

const NATURAL_CODE_COLLATOR = new Intl.Collator("cs", { sensitivity: "base", numeric: true });

/**
 * Production-selectable = active AND ready AND generatorEligible, computed live via the exact
 * same domain rules the admin UI already uses (never a stored/cached flag, never a second rule).
 * archived/needs_review/draft/inactive are excluded by construction: isGeneratorEligible already
 * returns false for any lifecycleStatus other than "active".
 */
export function isProductionReadyBooth(item: Pick<CatalogItemAdmin, "kind" | "lifecycleStatus" | "document">): boolean {
  return item.lifecycleStatus === "active" && computeReadiness(item).ready && computeGeneratorEligibleLive(item);
}

/**
 * The document JSONB is either already BoothType-shaped (P86 — a canonical seed with its own
 * constructionParts/collisionObstacles/pricing/printSurfaces/...) or a leaner ComponentDefinition
 * stub (T04..T25 — imported identity + dimensions + variants, no construction-part/collision
 * data of its own yet). `constructionParts` presence is what distinguishes the two shapes.
 */
function isFullBoothTypeShape(document: Readonly<Record<string, unknown>>): boolean {
  return Array.isArray(document.constructionParts);
}

function numberField(document: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = document[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringField(document: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = document[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Adapts ONE already-production-ready catalog_items row into the BoothType shape the generator
 * already renders. Never fabricates technical/business data — every field is either read
 * verbatim from the document, safely derived (e.g. "2 × 3 m" from real widthMm/depthMm), or a
 * structural/UI-state default (systemLocked, pricing POLICY — not a price — via the same
 * pricingPolicyFor() data/booths.ts itself uses).
 *
 * `id` prefers the document's OWN `id` field when present — for P86 that is the legacy
 * "koje-2x2" string, so existing saved projects keep resolving against the exact same identity
 * they always have (see resolveGeneratorBoothIdentity below for the full compatibility story).
 * Falls back to internalCode (Txx has no meaningful legacy id to preserve) and finally the DB
 * row's own uuid as a last resort.
 */
export function adaptCatalogItemToBoothType(item: CatalogItemAdmin): BoothType {
  const document = item.document;
  const documentId = stringField(document, "id");
  const id = documentId ?? item.internalCode ?? item.id;
  const widthMm = numberField(document, "widthMm");
  const depthMm = numberField(document, "depthMm");
  const heightMm = numberField(document, "heightMm");
  const photoAsset = documentPhotoAsset(document);
  const variants = documentVariants(document);
  const pricingEntries = Array.isArray(document.pricingEntries) ? (document.pricingEntries as readonly PricingEntry[]) : undefined;

  if (isFullBoothTypeShape(document)) {
    // Already a complete BoothType document (P86-style canonical seed) — trust it directly, but
    // the DB's own id/internalCode/lifecycleStatus/photoAsset/variants columns are the source of
    // truth, never a possibly-stale copy the document itself might carry.
    return {
      ...(document as unknown as BoothType),
      id,
      internalCode: item.internalCode ?? undefined,
      lifecycleStatus: item.lifecycleStatus,
      photoAsset,
      variants,
    };
  }

  // Minimal type-booth line (T04..T25) — synthesize the required BoothType scaffold around the
  // real, confirmed fields only. size/area are DERIVED from real widthMm/depthMm, never guessed.
  const size = widthMm && depthMm ? `${widthMm / 1000} × ${depthMm / 1000} m` : "—";
  const area = widthMm && depthMm ? `${Math.round((widthMm * depthMm) / 1_000_000)} m²` : "—";
  return {
    id,
    code: item.internalCode ?? item.displayName,
    internalCode: item.internalCode ?? undefined,
    name: item.displayName,
    description: stringField(document, "description") ?? "",
    projectType: "typovy",
    size,
    area,
    widthMm,
    depthMm,
    heightMm,
    collarHeightMm: null,
    profileWidthMm: null,
    // Reached this function only after isProductionReadyBooth() already passed — a real,
    // reviewed, ready-for-generator booth line, so it's accurate (not fabricated) to mark it
    // configReady here too (drives the "CAD ČEKÁ" placeholder badge in the picker card).
    configReady: true,
    systemLocked: true,
    userLocked: false,
    visible: true,
    variants,
    constructionParts: [],
    collisionObstacles: [],
    pricing: pricingPolicyFor("typovy"),
    lifecycleStatus: item.lifecycleStatus,
    photoAsset,
    category: item.category ?? undefined,
    pricingEntries,
  };
}

/**
 * Filters to kind=booth + production-ready, sorts deterministically (natural/numeric
 * internalCode order — same convention as sortCatalogItemsAdminByCode, mirrored here rather than
 * reused directly since that function operates on CatalogItemAdminListEntry, not CatalogItemAdmin/
 * BoothType), then adapts. Filter happens BEFORE sort/adapt, matching the admin lists' own
 * "filter first" convention.
 */
export function selectGeneratorBooths(items: readonly CatalogItemAdmin[]): readonly BoothType[] {
  return items
    .filter((item) => item.kind === "booth" && isProductionReadyBooth(item))
    .slice()
    .sort((a, b) => NATURAL_CODE_COLLATOR.compare(a.internalCode ?? a.displayName, b.internalCode ?? b.displayName))
    .map(adaptCatalogItemToBoothType);
}

/**
 * Saved-project compatibility resolution (section 23): a saved project stores booth identity as
 * a plain string (ProjectRecord.boothId) — historically the STATIC data/booths.ts id (e.g. P86's
 * "koje-2x2"). Resolves against the CURRENT DB-backed booth list by trying, in order: exact id
 * match (covers both legacy static ids preserved verbatim in the DB document AND any future
 * project saved with a DB-sourced id), then internalCode match (covers a project that happened
 * to store the code instead). Returns undefined — an explicit "unresolved" state, never a guess —
 * if nothing matches (e.g. the booth was archived/deactivated since the project was saved).
 */
export function resolveGeneratorBooth(booths: readonly BoothType[], savedBoothId: string): BoothType | undefined {
  if (!savedBoothId) return undefined;
  return booths.find((booth) => booth.id === savedBoothId) ?? booths.find((booth) => booth.internalCode === savedBoothId);
}

/**
 * Saved-project variant compatibility: a saved variantId only makes sense if the resolved booth
 * still HAS that exact variant. Never guesses a "closest" variant when the id doesn't match
 * (e.g. an old project referencing a variant id that no longer exists after a real data
 * correction) — returns undefined, an explicit unresolved state the caller must handle safely
 * (never silently substitute a different variant).
 */
export function resolveGeneratorVariant(booth: BoothType | undefined, savedVariantId: string): string {
  if (!booth || !savedVariantId) return "";
  return booth.variants.some((variant) => variant.id === savedVariantId) ? savedVariantId : "";
}
