/**
 * Tiskové plochy — the actual production size (mm) a given PRESET is manufactured at by a given
 * REALIZAČKA. Deliberately its own model, keyed by (realizationCompanyId, presetId) — never a
 * single size stored on the preset itself, since the same preset legitimately produces a
 * different real size per realizačka. This file also owns resolvePrintSurfaceProductionDimension,
 * the ONLY place that combination is looked up — never re-derive it ad hoc elsewhere, and never
 * guess/default a size when it isn't defined (see ProductionDimensionResolution: "not_found" is a
 * normal, expected state until the real Excel import supplies the row — not an error).
 */

export type PrintSurfaceProductionDimension = Readonly<{
  realizationCompanyId: string;
  presetId: string;
  widthMm: number;
  heightMm: number;
  note?: string;
}>;

export interface PrintSurfaceProductionDimensionRepository {
  list(): Promise<readonly PrintSurfaceProductionDimension[]>;
}

export type ProductionDimensionResolution =
  | Readonly<{ status: "found"; dimension: PrintSurfaceProductionDimension }>
  | Readonly<{ status: "not_found" }>;

/**
 * The single source of truth for "what size does this marker actually get produced at right now".
 * Never guesses or falls back to a default — a missing realizationCompanyId/presetId, or simply no
 * matching row yet, both resolve to "not_found", which the UI renders as "Rozměr není definován",
 * not an error state.
 */
export function resolvePrintSurfaceProductionDimension(
  input: Readonly<{ realizationCompanyId: string | undefined; presetId: string | undefined }>,
  dimensions: readonly PrintSurfaceProductionDimension[],
): ProductionDimensionResolution {
  if (!input.realizationCompanyId || !input.presetId) {
    return { status: "not_found" };
  }
  const match = dimensions.find(
    (dimension) =>
      dimension.realizationCompanyId === input.realizationCompanyId && dimension.presetId === input.presetId,
  );
  return match ? { status: "found", dimension: match } : { status: "not_found" };
}

/**
 * The (realizationCompanyId, presetId) combinations that appear MORE THAN ONCE — the combination
 * must be unique (spec section 3). Intended for validating data coming from a future Excel import
 * or the config-backed repository's seed, not for run-time resolution (resolvePrintSurfaceProductionDimension
 * always deterministically picks the first match regardless).
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
