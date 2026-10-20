/**
 * Graphics included in a kit price (V1-DATA-04, decision A17). Pure, no I/O.
 *
 * A kit line may include a scope of graphics, e.g. P86 "2 bm límce". Every print surface of a
 * project is then split into the part covered by that scope and the overflow, and only the
 * overflow is charged. Rules:
 *   - A scope covers surfaces of one print surface type (PRINT_SURFACE_TYPES) and/or named booth
 *     surfaces (printSurfaceIds), always in ONE unit (bm, m², ks). Different types and units are
 *     never offset against each other: 2 bm of fascia never pays for 1 m² of a panel.
 *   - Each physical surface counts once. The Tiskové plochy module keeps physical surfaces
 *     (PrintSurfaceItem) apart from their pins on views (MarkerPlacement), and the usage builders
 *     below read the surfaces only — a surface pinned on three visualizations is still one.
 *   - Quantities come from canonical (design) sizes, never production sizes with bleed, so the
 *     included scope does not depend on the realization company.
 */
import type { BoothType } from "./models.ts";
import type { PrintSurfaceAssignment } from "./project.ts";
import type { PrintSurfaceItem } from "./printSurfaceProject.ts";
import { PRINT_SURFACE_TYPES, type PrintSurfaceTypeId } from "./printSurfaceTypeCatalog.ts";

export const KIT_ALLOWANCE_UNITS = ["bm", "m2", "ks"] as const;
export type KitAllowanceUnit = (typeof KIT_ALLOWANCE_UNITS)[number];

export const KIT_ALLOWANCE_UNIT_LABELS_CS: Readonly<Record<KitAllowanceUnit, string>> = { bm: "bm", m2: "m²", ks: "ks" };

/** One included scope of graphics on a kit line (catalog_item_package_items.print_allowance[]). */
export type KitPrintAllowance = Readonly<{
  surfaceTypeId?: PrintSurfaceTypeId;
  printSurfaceIds?: readonly string[];
  unitCode: KitAllowanceUnit;
  includedQuantity: number;
}>;

export type KitPrintAllowanceSource = KitPrintAllowance & Readonly<{ lineKey: string }>;

/** One physical print surface of a project, measured in one unit. */
export type PrintSurfaceUsage = Readonly<{
  /** Identity of the physical surface — duplicates (same surface on several views) count once. */
  surfaceId: string;
  typeId?: PrintSurfaceTypeId;
  /** Booth surface id (PrintSurface.id, e.g. fascia-print) when the surface comes from the generator. */
  printSurfaceId?: string;
  unitCode: KitAllowanceUnit;
  quantity: number;
}>;

export type PrintSurfaceAllowanceStatus = "included_in_kit" | "kit_overflow" | "charged";

export type PrintSurfaceAllowanceLine = Readonly<{
  surfaceId: string;
  typeId?: PrintSurfaceTypeId;
  unitCode: KitAllowanceUnit;
  quantity: number;
  includedQuantity: number;
  /** Overflow (or the whole surface when no scope matches) — the only part that is priced. */
  chargedQuantity: number;
  status: PrintSurfaceAllowanceStatus;
  /** Kit lines whose scope covered (part of) this surface. */
  lineKeys: readonly string[];
}>;

export type KitAllowanceBucket = Readonly<{
  lineKey: string;
  surfaceTypeId?: PrintSurfaceTypeId;
  printSurfaceIds?: readonly string[];
  unitCode: KitAllowanceUnit;
  includedQuantity: number;
  usedQuantity: number;
  remainingQuantity: number;
}>;

export type KitAllowanceAllocation = Readonly<{
  surfaces: readonly PrintSurfaceAllowanceLine[];
  buckets: readonly KitAllowanceBucket[];
  /** How many repeated usages of an already counted surface were ignored. */
  duplicateUsagesIgnored: number;
}>;

const round = (value: number) => Math.round(value * 10_000) / 10_000;

const KNOWN_TYPE_IDS = new Set<string>(PRINT_SURFACE_TYPES.map((type) => type.id));

/** Validation messages for one line's scopes (empty = valid). Used by the kit validation. */
export function kitPrintAllowanceIssues(allowances: readonly KitPrintAllowance[]): readonly string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const [index, allowance] of allowances.entries()) {
    const label = `Grafika ${index + 1}`;
    if (!(KIT_ALLOWANCE_UNITS as readonly string[]).includes(allowance.unitCode)) issues.push(`${label}: jednotka musí být bm, m² nebo ks.`);
    if (!Number.isFinite(allowance.includedQuantity) || allowance.includedQuantity < 0) issues.push(`${label}: zahrnuté množství musí být nezáporné číslo.`);
    if (allowance.surfaceTypeId && !KNOWN_TYPE_IDS.has(allowance.surfaceTypeId)) issues.push(`${label}: neznámý typ tiskové plochy.`);
    if (!allowance.surfaceTypeId && !(allowance.printSurfaceIds?.length)) issues.push(`${label}: vyberte typ tiskové plochy nebo konkrétní plochu.`);
    const key = `${allowance.surfaceTypeId ?? ""}|${(allowance.printSurfaceIds ?? []).join(",")}|${allowance.unitCode}`;
    if (seen.has(key)) issues.push(`${label}: stejný rozsah grafiky je na řádku vícekrát.`);
    seen.add(key);
  }
  return issues;
}

/** Whitelists raw JSON (request body or DB jsonb) into scopes; drops nothing silently that the validation would not report. */
export function parseKitPrintAllowances(raw: unknown): readonly KitPrintAllowance[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): KitPrintAllowance[] => {
    if (!entry || typeof entry !== "object") return [];
    const value = entry as Record<string, unknown>;
    const ids = Array.isArray(value.printSurfaceIds) ? value.printSurfaceIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())).map((id) => id.trim()) : [];
    const unitCode = value.unitCode === "m²" ? "m2" : value.unitCode;
    return [{
      ...(typeof value.surfaceTypeId === "string" && value.surfaceTypeId ? { surfaceTypeId: value.surfaceTypeId as PrintSurfaceTypeId } : {}),
      ...(ids.length ? { printSurfaceIds: ids } : {}),
      unitCode: unitCode as KitAllowanceUnit,
      includedQuantity: typeof value.includedQuantity === "number" ? value.includedQuantity : Number(value.includedQuantity),
    }];
  });
}

function matches(bucket: KitAllowanceBucket, usage: PrintSurfaceUsage): boolean {
  if (bucket.unitCode !== usage.unitCode) return false;
  if (bucket.printSurfaceIds?.length) {
    return bucket.printSurfaceIds.includes(usage.surfaceId) || (usage.printSurfaceId !== undefined && bucket.printSurfaceIds.includes(usage.printSurfaceId));
  }
  return bucket.surfaceTypeId !== undefined && bucket.surfaceTypeId === usage.typeId;
}

/**
 * Splits every surface into included and charged quantity. Surfaces are consumed in the given
 * order; scopes naming concrete surfaces are tried before scopes of a whole type, so a dedicated
 * scope is not eaten up by another surface of the same type.
 */
export function allocateKitPrintAllowance(allowances: readonly KitPrintAllowanceSource[], usages: readonly PrintSurfaceUsage[]): KitAllowanceAllocation {
  const buckets = allowances.map((allowance) => ({
    lineKey: allowance.lineKey,
    ...(allowance.surfaceTypeId ? { surfaceTypeId: allowance.surfaceTypeId } : {}),
    ...(allowance.printSurfaceIds?.length ? { printSurfaceIds: allowance.printSurfaceIds } : {}),
    unitCode: allowance.unitCode,
    includedQuantity: Math.max(0, allowance.includedQuantity),
    usedQuantity: 0,
    remainingQuantity: Math.max(0, allowance.includedQuantity),
  }));
  const ordered = [...buckets.filter((bucket) => bucket.printSurfaceIds), ...buckets.filter((bucket) => !bucket.printSurfaceIds)];
  const counted = new Set<string>();
  let duplicateUsagesIgnored = 0;
  const surfaces: PrintSurfaceAllowanceLine[] = [];
  for (const usage of usages) {
    if (counted.has(usage.surfaceId)) {
      duplicateUsagesIgnored += 1;
      continue;
    }
    counted.add(usage.surfaceId);
    const quantity = round(Math.max(0, usage.quantity));
    let open = quantity;
    let matched = false;
    const lineKeys: string[] = [];
    for (const bucket of ordered) {
      if (!matches(bucket, usage)) continue;
      matched = true;
      if (open <= 0 || bucket.remainingQuantity <= 0) continue;
      const take = round(Math.min(open, bucket.remainingQuantity));
      bucket.remainingQuantity = round(bucket.remainingQuantity - take);
      bucket.usedQuantity = round(bucket.usedQuantity + take);
      open = round(open - take);
      if (!lineKeys.includes(bucket.lineKey)) lineKeys.push(bucket.lineKey);
    }
    const includedQuantity = round(quantity - open);
    const status: PrintSurfaceAllowanceStatus = !matched ? "charged" : open > 0 ? "kit_overflow" : "included_in_kit";
    surfaces.push({
      surfaceId: usage.surfaceId,
      ...(usage.typeId ? { typeId: usage.typeId } : {}),
      unitCode: usage.unitCode,
      quantity,
      includedQuantity,
      chargedQuantity: open,
      status,
      lineKeys,
    });
  }
  return { surfaces, buckets, duplicateUsagesIgnored };
}

/** Charged quantity per (type, unit) — what the graphics price is applied to. Never mixes units. */
export function chargedQuantityByTypeAndUnit(allocation: KitAllowanceAllocation): ReadonlyMap<string, number> {
  const totals = new Map<string, number>();
  for (const surface of allocation.surfaces) {
    if (surface.chargedQuantity <= 0) continue;
    const key = `${surface.typeId ?? "unknown"}|${surface.unitCode}`;
    totals.set(key, round((totals.get(key) ?? 0) + surface.chargedQuantity));
  }
  return totals;
}

// ============================================================================
// USAGE BUILDERS — adapters from the existing modules, nothing there changes.
// ============================================================================

/**
 * Tiskové plochy: one usage per PrintSurfaceItem (the physical surface), never per placement.
 * Límec is measured in bm (width × count), every other type in m² (width × height × count),
 * matching pricingModeForTypeId. Items without a resolvable size are returned in `unresolved`.
 */
export function usagesFromPrintSurfaceItems(
  items: readonly Pick<PrintSurfaceItem, "id" | "typeId" | "quantity">[],
  canonicalSize: (itemId: string) => Readonly<{ widthMm: number; heightMm: number }> | undefined,
): Readonly<{ usages: readonly PrintSurfaceUsage[]; unresolved: readonly string[] }> {
  const usages: PrintSurfaceUsage[] = [];
  const unresolved: string[] = [];
  for (const item of items) {
    const size = canonicalSize(item.id);
    if (!size || !(size.widthMm > 0) || !(size.heightMm > 0)) {
      unresolved.push(item.id);
      continue;
    }
    const count = item.quantity && item.quantity > 0 ? item.quantity : 1;
    const fascia = item.typeId === "fascia";
    usages.push({
      surfaceId: item.id,
      typeId: item.typeId,
      unitCode: fascia ? "bm" : "m2",
      quantity: round(fascia ? (size.widthMm / 1000) * count : ((size.widthMm * size.heightMm) / 1_000_000) * count),
    });
  }
  return { usages, unresolved };
}

/**
 * Generator: one usage per booth print surface that the project actually prints (selected or with
 * artwork). A fascia-like surface (pricingUnit bm / allowanceLinearMeters) is measured in bm,
 * exactly like fasciaQuantityBm; any other in canonical m².
 */
export function usagesFromBoothAssignments(
  booth: Pick<BoothType, "printSurfaces">,
  assignments: readonly Pick<PrintSurfaceAssignment, "printSurfaceId" | "selectedForPrint" | "artworkFileId">[],
): readonly PrintSurfaceUsage[] {
  return assignments.flatMap((assignment): PrintSurfaceUsage[] => {
    if (!assignment.selectedForPrint && !assignment.artworkFileId) return [];
    const surface = booth.printSurfaces?.find((candidate) => candidate.id === assignment.printSurfaceId);
    if (!surface) return [];
    const fascia = surface.pricingUnit === "bm" || surface.allowanceLinearMeters !== undefined;
    return [{
      surfaceId: surface.id,
      printSurfaceId: surface.id,
      ...(fascia ? { typeId: "fascia" as const } : {}),
      unitCode: fascia ? "bm" : "m2",
      quantity: round(fascia ? (surface.allowanceLinearMeters ?? surface.widthMm / 1000) : (surface.widthMm * surface.heightMm) / 1_000_000),
    }];
  });
}

/** Today's BoothType.packageContents "print-allowance" (P86: Grafika na límec, 2 bm, fascia-print) as kit scopes. */
export function legacyKitPrintAllowances(booth: Pick<BoothType, "packageContents"> | undefined): readonly KitPrintAllowanceSource[] {
  return (booth?.packageContents ?? []).flatMap((item): KitPrintAllowanceSource[] => {
    if (item.kind !== "print-allowance" || !item.includedInBasePrice || !item.printSurfaceId) return [];
    return [{ lineKey: item.id, printSurfaceIds: [item.printSurfaceId], unitCode: item.unit === "m²" ? "m2" : item.unit, includedQuantity: item.quantity }];
  });
}
