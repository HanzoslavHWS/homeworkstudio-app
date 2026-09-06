/**
 * Tiskové plochy — the actual production size (mm) a given PRESET is manufactured at by a given
 * REALIZAČKA. Deliberately its own model, keyed by (realizationCompanyId, presetId) — never a
 * single size stored on the preset itself, since the same preset legitimately produces a
 * different real size per realizačka.
 *
 * A realizačka can also EXPLICITLY NOT OFFER a given preset at all — the source Excel marks this
 * with "NO" in both the width and height cells (see domain/printSurfaceExcelImport.ts). This is a
 * real, meaningful business fact ("tato realizačka tuto plochu vůbec nemá v nabídce"), completely
 * different from "we don't have this data yet" — so it gets its own `status: "unavailable"` row
 * here, NEVER width=0/height=0 and never silently treated the same as a missing row. A missing
 * row (no entry for this combination at all) means something else again: NOT_DEFINED — the data
 * simply hasn't been imported/filled in yet. See resolvePrintSurfaceProductionDimension for how
 * these three states are told apart; that function is the ONLY place this combination is looked
 * up — never re-derive it ad hoc elsewhere, and never guess/default a size.
 */

export type PrintSurfaceProductionDimension =
  | Readonly<{
      realizationCompanyId: string;
      presetId: string;
      status: "available";
      widthMm: number;
      heightMm: number;
      note?: string;
    }>
  | Readonly<{
      realizationCompanyId: string;
      presetId: string;
      status: "unavailable";
      note?: string;
    }>;

export interface PrintSurfaceProductionDimensionRepository {
  list(): Promise<readonly PrintSurfaceProductionDimension[]>;
  /** Full atomic replace — how a fresh Excel import applies its result (see domain/printSurfaceExcelImport.ts). */
  replaceAll(dimensions: readonly PrintSurfaceProductionDimension[]): Promise<void>;
}

export type ProductionDimensionResolution =
  | Readonly<{ status: "available"; widthMm: number; heightMm: number; note?: string }>
  | Readonly<{ status: "unavailable"; note?: string }>
  | Readonly<{ status: "not_defined" }>;

/**
 * The single source of truth for "what size does this marker actually get produced at right now,
 * for the project's chosen realizačka". Three, and only three, possible outcomes:
 *   - "available"   — a real widthMm/heightMm exists for this (company, preset) combination.
 *   - "unavailable" — the realizačka explicitly does not offer this preset (Excel said NO/NO).
 *   - "not_defined" — no row exists yet for this combination (data not imported/filled in), OR
 *                     no realizačka/preset is even selected yet.
 * Never guesses or falls back to a default in any case.
 */
export function resolvePrintSurfaceProductionDimension(
  input: Readonly<{ realizationCompanyId: string | undefined; presetId: string | undefined }>,
  dimensions: readonly PrintSurfaceProductionDimension[],
): ProductionDimensionResolution {
  if (!input.realizationCompanyId || !input.presetId) {
    return { status: "not_defined" };
  }
  const match = dimensions.find(
    (dimension) =>
      dimension.realizationCompanyId === input.realizationCompanyId && dimension.presetId === input.presetId,
  );
  if (!match) return { status: "not_defined" };
  if (match.status === "unavailable") return { status: "unavailable", note: match.note };
  return { status: "available", widthMm: match.widthMm, heightMm: match.heightMm, note: match.note };
}

/**
 * The (realizationCompanyId, presetId) combinations that appear MORE THAN ONCE — the combination
 * must be unique (spec section 3, and DUPLICATE_COMPANY_PRESET in the Excel importer's
 * validation). Intended for validating data coming from the Excel import, not for run-time
 * resolution (resolvePrintSurfaceProductionDimension always deterministically picks the first
 * match regardless).
 */
export function findDuplicateProductionDimensionKeys(
  dimensions: readonly PrintSurfaceProductionDimension[],
): readonly Readonly<{ realizationCompanyId: string; presetId: string }>[] {
  const seenOnce = new Set<string>();
  const duplicates = new Map<string, Readonly<{ realizationCompanyId: string; presetId: string }>>();
  for (const dimension of dimensions) {
    const key = `${dimension.realizationCompanyId}::${dimension.presetId}`;
    if (seenOnce.has(key)) {
      duplicates.set(key, { realizationCompanyId: dimension.realizationCompanyId, presetId: dimension.presetId });
    } else {
      seenOnce.add(key);
    }
  }
  return [...duplicates.values()];
}
