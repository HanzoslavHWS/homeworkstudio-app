import {
  CATALOG_ITEM_STATUSES,
  type BoothVariant,
  type CatalogItemKind,
  type CatalogItemStatus,
  type ComponentDefinition,
} from "./models.ts";

export const CATALOG_ITEM_STATUS_LABELS_CS: Readonly<Record<CatalogItemStatus, string>> = {
  draft: "Koncept",
  needs_review: "K doplnění",
  active: "Aktivní",
  inactive: "Neaktivní",
  archived: "Archivováno",
};

export type ReadinessIssue =
  | "missing_internal_code"
  | "missing_display_name"
  | "missing_category"
  | "missing_unit"
  | "missing_dimensions"
  | "missing_scene_capability"
  | "missing_2d_representation"
  | "missing_3d_asset"
  | "missing_sketchup_source"
  | "missing_pricing_unit"
  | "requires_review"
  | "variants_unconfirmed";

export const READINESS_ISSUE_LABELS_CS: Readonly<Record<ReadinessIssue, string>> = {
  missing_internal_code: "Chybí interní kód",
  missing_display_name: "Chybí zobrazovaný název",
  missing_category: "Chybí kategorie",
  missing_unit: "Chybí jednotka",
  missing_dimensions: "Chybí rozměry",
  missing_scene_capability: "Chybí nastavení zobrazení ve 2D/3D",
  missing_2d_representation: "Chybí platná 2D reprezentace",
  missing_3d_asset: "Chybí platný 3D model (GLB)",
  missing_sketchup_source: "Chybí zdrojový SketchUp (.skp) soubor",
  missing_pricing_unit: "Chybí typ jednotky pro cenotvorbu",
  requires_review: "Čeká na kontrolu/schválení",
  variants_unconfirmed: "Varianty ještě nejsou potvrzené jako finální katalog",
};

export type ReadinessResult = Readonly<{
  ready: boolean;
  issues: readonly ReadinessIssue[];
}>;

function hasText(value: string | undefined): boolean {
  return Boolean(value && value.trim().length > 0);
}

function hasDimensions(item: ComponentDefinition): boolean {
  return Number.isFinite(item.widthMm) && item.widthMm > 0 && Number.isFinite(item.depthMm) && item.depthMm > 0;
}

function has2DRepresentation(item: ComponentDefinition): boolean {
  return Boolean(item.footprint2D);
}

/**
 * Runtime 3D assets are always GLB (GLTFLoader-loadable) — a SketchUp authoring source (.skp)
 * must never satisfy readiness, however it got set (hand-edited seed, manual DB edit, future
 * field). Upload validation already keeps .skp out of R2 (domain/assets.ts's catalog-model
 * category only accepts model/gltf-binary), so this is a defensive second layer at the
 * resolution boundary, not a fix for an active bug.
 */
function isRuntimeGlbReference(value: string | undefined): boolean {
  return Boolean(value) && !value!.toLowerCase().endsWith(".skp");
}

function has3DAsset(item: ComponentDefinition): boolean {
  if (isRuntimeGlbReference(item.modelUrl)) return true;
  if (isRuntimeGlbReference(item.modelAsset?.storageKey)) return true;
  return Boolean(item.assets?.models3d?.some((asset) => isRuntimeGlbReference(asset.url)));
}

/** A single variant's OWN runtime GLB — never falls back to the parent's/another variant's modelAsset. */
function hasVariantModel(variant: BoothVariant): boolean {
  return isRuntimeGlbReference(variant.modelAsset?.storageKey);
}

/** A single variant's OWN evidenced SketchUp source — same "sketchup"-kind sourceAssets entry rule as hasSketchupSource(item), scoped to one variant. */
function hasVariantSketchupSource(variant: BoothVariant): boolean {
  return Boolean(variant.sourceAssets?.some((entry) => entry.kind === "sketchup" && entry.asset?.storageKey));
}

/**
 * A real SketchUp authoring source has been evidenced via sourceAssets — see domain/assets.ts's
 * SourceAssetEntry. Only a "sketchup"-kind entry counts; DWG/DXF/PDF/other never satisfy this,
 * however many of them are attached (Part 3: those kinds are never mandatory for activation).
 */
function hasSketchupSource(item: ComponentDefinition): boolean {
  return Boolean(item.sourceAssets?.some((entry) => entry.kind === "sketchup" && entry.asset?.storageKey));
}

/** Booth kind requires a real, placeable footprint — unlike furniture, height is mandatory too (mirrors BoothType's own NominalDimensions, where widthMm/depthMm/heightMm are all non-optional). */
function hasBoothDimensions(item: ComponentDefinition): boolean {
  return hasDimensions(item) && Number.isFinite(item.heightMm) && (item.heightMm as number) > 0;
}

/**
 * Whether an item EXPLICITLY declares itself scene-placeable (showIn2D/showIn3D). Absence is
 * ambiguous, not a negative claim: a catalog_item's document may simply never have set these
 * flags. Kinds that are inherently always placed (booth) don't use this signal at all; kinds
 * where placement is optional (construction/other) treat an undeclared capability as "unknown,
 * needs a human", never as "confirmed non-placeable" — see the construction/other cases below.
 */
function declaresSceneCapability(item: ComponentDefinition): boolean {
  return Boolean(item.showIn2D || item.showIn3D);
}

/**
 * Readiness = "this item can be safely offered to the generator for its intended kind of use" —
 * never merely "has an internalCode", "has a price", or "was an EXACT_SAFE import match". Rules
 * are kind-based (dispatched by CatalogItemKind) but each rule itself checks CAPABILITY signals
 * already on the model (showIn2D/showIn3D, modelUrl/assets, pricingUnit, reviewedAt) rather than
 * a name/category heuristic — see section 9 of the readiness-hardening spec.
 *
 * Deliberately NOT checked anywhere for service/graphics_service/construction/floor_finish: a
 * base sale price. A service (or a package-priced construction line) is a valid, activatable
 * catalog item even with no fixed price — its price may live entirely in Event → PriceList →
 * PricingEntry, be "individual" (e.g. Kontejner — quoted per case), or be "included" in a booth
 * package (e.g. P86 fascia graphics). Whether a *specific project/event* currently has a number
 * to charge is a separate, later concern — see domain/catalog.ts resolvePricingAvailability,
 * which returns "missing"/"individual"/"included"/"fixed" without ever touching whether the
 * CatalogItem itself is allowed to be active.
 *
 * Also deliberately NEVER checked anywhere: whether the item came from an EXACT_SAFE import
 * match, or whether it has a confirmed base price — identity/pricing confidence is not the same
 * thing as "safe to offer to the generator" (see domain/importBatch2b.ts: every EXACT_SAFE
 * import still lands as lifecycleStatus=needs_review, generatorEligible=false).
 */
export function evaluateCatalogReadiness(item: ComponentDefinition, kind: CatalogItemKind): ReadinessResult {
  const issues: ReadinessIssue[] = [];
  const displayName = item.displayName ?? item.name;

  if (!hasText(displayName)) issues.push("missing_display_name");
  if (!hasText(item.category)) issues.push("missing_category");

  switch (kind) {
    // Physical, placeable furniture — the strictest rule set (unchanged by this hardening
    // pass; audited and found correct). Requires a real identity, unit, valid footprint, an
    // explicitly declared scene capability with a matching representation, and human review.
    case "furniture": {
      if (!hasText(item.internalCode)) issues.push("missing_internal_code");
      if (!hasText(item.unit)) issues.push("missing_unit");
      if (!hasDimensions(item)) issues.push("missing_dimensions");
      if (!declaresSceneCapability(item)) issues.push("missing_scene_capability");
      if (item.showIn2D && !has2DRepresentation(item)) issues.push("missing_2d_representation");
      if (item.showIn3D && !has3DAsset(item)) issues.push("missing_3d_asset");
      if (!item.reviewedAt) issues.push("requires_review");
      break;
    }
    // A scene point (electricity/water/waste marker) is never a GLB-requiring object unless it
    // explicitly declares 3D placement.
    case "technical_point": {
      if (!declaresSceneCapability(item)) issues.push("missing_scene_capability");
      if (item.showIn2D && !has2DRepresentation(item)) issues.push("missing_2d_representation");
      if (item.showIn3D && !has3DAsset(item)) issues.push("missing_3d_asset");
      break;
    }
    // Technical services never need a GLB — they are never placed in the scene. internalCode
    // is deliberately NOT required here (unlike furniture): a legitimately catalog-ready
    // service can still be individually/per-case priced without a confirmed ABF code (e.g.
    // Kontejner — see the existing "individuálně cenová služba" test/domain precedent); what
    // it does need is a real charging unit. reviewedAt is also deliberately NOT required for
    // services — the coarser lifecycleStatus active/needs_review gate (isGeneratorEligible,
    // not this function) already serves that purpose for this kind. L02 (unit="ks", no
    // internalCode requirement, no reviewedAt) stays ready under this rule.
    case "service": {
      if (!hasText(item.unit)) issues.push("missing_unit");
      break;
    }
    case "graphics_service": {
      if (!item.pricingUnit) issues.push("missing_pricing_unit");
      break;
    }
    // A booth is ALWAYS the placed stage every other object sits in — there is no such thing
    // as a non-placeable booth, so (unlike furniture/construction) placement itself is never
    // gated behind a showIn2D/showIn3D flag: BoothType doesn't even model those fields. What
    // genuinely matters is a real nominal footprint (width/depth/HEIGHT — a booth without a
    // height is not a usable 3D volume) and a usable geometry asset. PrintSurfaces are
    // deliberately NEVER required here — not every booth needs a print allowance.
    //
    // SKP is explicitly NOT required on the PARENT itself (unlike booth_component below, and
    // unlike a variant — see below) — a single-geometry type-booth (P86) was always planned to
    // activate on GLB alone; DWG/DXF/PDF/other source files are evidence/documentation, never
    // generator-readiness gates. P86 must stay ready=true / generatorEligible=true with no SKP
    // evidenced at all.
    //
    // Multi-variant type-booth lines (T04..T25 — one catalog_item, several variants, see
    // ComponentDefinition.variants): the PARENT never carries its own single canonical GLB for
    // these, so has3DAsset(item) would always be false and misleadingly blame "missing_3d_asset"
    // even once every variant is fully modelled. Once variants are declared, the asset rule
    // switches to per-variant: every declared variant needs its OWN GLB *and* its own evidenced
    // SketchUp source (mirrors booth_component's GLB+SKP rule exactly, scoped per variant instead
    // of per item) — this is deliberately strict (ALL, not ANY): a line where 3 of 4 variants are
    // modelled must never read as fully ready, or an admin could activate T04 while one variant
    // silently has no geometry/source at all. missing_3d_asset and missing_sketchup_source are
    // reported independently so the admin UI can tell GLB-missing from SKP-missing. A booth with
    // no variants declared (P86, or any future single-geometry type-booth) is completely
    // unaffected — it keeps using its own has3DAsset(item)-only rule exactly as before, no SKP
    // requirement at all.
    //
    // variantsConfirmed (2026-08-19, generator-DB-integration session): a variants line can NEVER
    // become ready/generatorEligible while its variant SET ITSELF is still an unconfirmed
    // placeholder (T06..T25's generic "Varianta N" scaffold, variantsConfirmed=false) — no matter
    // how complete each individual variant's GLB/SKP happens to be. This is deliberate: uploading
    // real assets onto a still-unconfirmed placeholder variant (wrong count/names) must never let
    // that placeholder line quietly become production-selectable. Checked ONLY when variants
    // exist; a variants-less booth (P86) never reads this field at all. This is the ONE central
    // domain rule the live generator's booth picker relies on — never a separate UI-only filter.
    case "booth": {
      if (!hasBoothDimensions(item)) issues.push("missing_dimensions");
      const variants = item.variants ?? [];
      if (variants.length > 0) {
        if (!variants.every(hasVariantModel)) issues.push("missing_3d_asset");
        if (!variants.every(hasVariantSketchupSource)) issues.push("missing_sketchup_source");
        if (item.variantsConfirmed !== true) issues.push("variants_unconfirmed");
      } else if (!has3DAsset(item)) {
        issues.push("missing_3d_asset");
      }
      break;
    }
    // An individual booth-construction element (sloupek/panel/dveře/límec/rastr/koberec, ...)
    // evidenced for future individual-booth assembly — see domain/models.ts's CatalogItemKind
    // doc comment. Only the two files Part 3 actually requires are mandatory: a runtime GLB and
    // a SketchUp authoring source. No footprint-dimensions rule (unlike "booth" — many of these
    // elements, e.g. límec/rastr, don't have a meaningful single width×depth×height the way a
    // whole booth does), and no showIn2D/showIn3D scene-capability rule (never wired into the
    // live generator picker in this phase — see SCENE_CAPABILITY_KINDS in ComponentAdminPage.tsx).
    case "booth_component": {
      if (!has3DAsset(item)) issues.push("missing_3d_asset");
      if (!hasSketchupSource(item)) issues.push("missing_sketchup_source");
      break;
    }
    // Construction line items split into two real uses the current model can't always tell
    // apart from data alone: (A) a placeable scene component (a wall/rig with real geometry)
    // vs (B) a pricing/package-only service (e.g. "Stavba octanorm 1 m²" — never placed,
    // priced per m²). Forcing a GLB on every construction item would wrongly block (B); never
    // requiring one would wrongly let (A) through. The safe answer: scene rules apply ONLY
    // when the item itself declares placement (showIn2D/showIn3D) — an undeclared capability
    // is treated as unknown, not as a confirmed "this is pricing-only", so it still requires a
    // human review before it can ever be offered to the generator.
    case "construction": {
      if (item.showIn2D && !has2DRepresentation(item)) issues.push("missing_2d_representation");
      if (item.showIn3D && !has3DAsset(item)) issues.push("missing_3d_asset");
      if (!item.reviewedAt) issues.push("requires_review");
      break;
    }
    // A floor finish (e.g. carpet) is applied in the generator as a surface/finish over an
    // area the PROJECT determines — never its own placed 3D object with fixed dimensions of
    // its own. No width/depth/GLB requirement here; only a real charging unit and review.
    case "floor_finish": {
      if (!hasText(item.unit)) issues.push("missing_unit");
      if (!item.reviewedAt) issues.push("requires_review");
      break;
    }
    // "other" is the catch-all — its generator use is, by definition, not well-defined. It
    // must never become ready purely by having a name/category. If it happens to declare a
    // scene capability, the matching representation is still required; either way it always
    // needs an explicit human review before it can ever be considered ready. Conservative by
    // design (section 8 of the spec) rather than guessing a use from its name/category.
    case "other":
    default: {
      if (item.showIn2D && !has2DRepresentation(item)) issues.push("missing_2d_representation");
      if (item.showIn3D && !has3DAsset(item)) issues.push("missing_3d_asset");
      if (!item.reviewedAt) issues.push("requires_review");
      break;
    }
  }

  return { ready: issues.length === 0, issues };
}

/**
 * Section 6: an item may exist in the DB without being selectable in the generator.
 * Undefined lifecycleStatus means the item predates this field (current seeds like
 * M57/L02/P86) and stays eligible, so nothing already shipped silently disappears.
 */
export function isGeneratorEligible(item: ComponentDefinition, kind?: CatalogItemKind): boolean {
  if (item.lifecycleStatus === undefined) return true;
  if (item.lifecycleStatus !== "active") return false;
  const resolvedKind = kind ?? item.catalogItemKind ?? inferCatalogItemKind(item);
  return evaluateCatalogReadiness(item, resolvedKind).ready;
}

export function inferCatalogItemKind(item: Pick<ComponentDefinition, "catalogItemType" | "sceneLayer" | "printable">): CatalogItemKind {
  if (item.catalogItemType === "service") {
    return item.printable ? "graphics_service" : "service";
  }
  if (item.sceneLayer && item.sceneLayer !== "furniture") return "technical_point";
  return "furniture";
}

export class CatalogReadinessError extends Error {
  readonly issues: readonly ReadinessIssue[];

  constructor(issues: readonly ReadinessIssue[]) {
    super(`Položku nelze aktivovat – chybí: ${issues.map((issue) => READINESS_ISSUE_LABELS_CS[issue]).join(", ")}.`);
    this.name = "CatalogReadinessError";
    this.issues = issues;
  }
}

/**
 * Section 9: activation must be enforced server-side too, not just hidden by the UI.
 * Call this before persisting a status transition into "active".
 */
export function assertCanActivate(item: ComponentDefinition, kind: CatalogItemKind): void {
  const result = evaluateCatalogReadiness(item, kind);
  if (!result.ready) throw new CatalogReadinessError(result.issues);
}

export function isValidCatalogItemStatus(value: string): value is CatalogItemStatus {
  return (CATALOG_ITEM_STATUSES as readonly string[]).includes(value);
}

export class DuplicateInternalCodeError extends Error {
  readonly internalCode: string;

  constructor(internalCode: string) {
    super(`Interní kód "${internalCode}" už je v katalogu použitý.`);
    this.name = "DuplicateInternalCodeError";
    this.internalCode = internalCode;
  }
}

/**
 * Mirrors the DB's partial unique index (catalog_items_internal_code_key — unique only
 * where internal_code is not null, see the init migration): a missing/null code is always
 * fine, but two non-null codes must never collide, case/whitespace-insensitively.
 */
export function assertUniqueInternalCode(existingItems: readonly Pick<ComponentDefinition, "internalCode">[], candidateCode: string | undefined): void {
  if (!candidateCode || !candidateCode.trim()) return;
  const normalized = candidateCode.trim().toLocaleUpperCase("cs");
  const collision = existingItems.some((item) => item.internalCode && item.internalCode.trim().toLocaleUpperCase("cs") === normalized);
  if (collision) throw new DuplicateInternalCodeError(candidateCode);
}
