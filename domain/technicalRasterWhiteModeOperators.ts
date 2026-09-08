/**
 * Technické rastry — the pure algorithm behind "pracovní bílý režim" (spec batch 2, section
 * 10-18). Real PDF verification (Hala 1.pdf) showed the "STÁNKY ***" layer draws every stand with
 * a single combined fill+stroke path operator (`closeEOFillStroke`) preceded by a fill-color-set
 * call — so turning off the WHOLE layer (the old approach) removes the outline along with the
 * fill. This module instead identifies exactly which fill-COLOR-setting operator to whiten,
 * leaving the paint operator (and therefore the stroke it draws in the very same call) untouched.
 *
 * Deliberately decoupled from pdfjs-dist's own numeric op codes (`OPS`) — the caller (the
 * browser-only adapter in lib/pdf/technicalRasterWhiteRender.ts) passes them in as plain data via
 * `WhiteModeOpCodes`, so this file has zero pdf.js dependency and is fully unit-testable with
 * small made-up op-code numbers (see tests/technicalRasterWhiteModeOperators.test.ts).
 *
 * Algorithm: walk the operator list once, tracking the Optional-Content (OCG) marked-content
 * stack exactly like a real PDF renderer would. Remember the index of the most recently seen
 * fill-color-setting operator (setFillRGBColor/setFillGray/setFillCMYKColor/setFillColor/
 * setFillColorN — a PDF's graphics state keeps whatever fill color was last set, same as a canvas
 * context's own fillStyle). Whenever, while INSIDE the target layer's marked-content span, a path
 * is painted with a fill-family paint type (fill/eoFill/fillStroke/eoFillStroke/closeFillStroke/
 * closeEOFillStroke, or the fill-only `rawFillPath` fast path), mark that remembered fill-setter
 * index for whitening — never the paint operator itself, so its stroke (and geometry) survive
 * completely untouched.
 *
 * Safety: if the target layer ever uses a fill mechanism this can't safely rewrite (a shading
 * pattern, an image, an image mask — spec section 16: "NEPŘEBARVUJ NIC" if unsure), the whole
 * transform is refused (`status: "unsupported"`) rather than silently doing a partial job.
 */

export type OperatorListLike = Readonly<{
  fnArray: readonly number[];
  argsArray: readonly unknown[];
}>;

/**
 * The pdfjs-dist `OPS` codes this algorithm needs, injected by the caller (never imported here).
 * `fillPaintTypes`/`fillColorSetters`/`unsupportedFillOps` are small sets because a PDF/pdf.js
 * version may add more color-space or paint variants later — passing them in keeps this file from
 * ever needing to track pdf.js's own enum growth.
 */
export type WhiteModeOpCodes = Readonly<{
  beginMarkedContentProps: number;
  beginMarkedContent: number;
  endMarkedContent: number;
  constructPath: number;
  rawFillPath?: number;
  /** Paint types of `constructPath`'s own first argument that include a FILL (spec section 13: fill/eoFill/fillStroke/eoFillStroke/closeFillStroke/closeEOFillStroke). */
  fillPaintTypes: ReadonlySet<number>;
  /** Ops that set the graphics state's current fill color (setFillRGBColor/setFillGray/setFillCMYKColor/setFillColor/setFillColorN). */
  fillColorSetters: ReadonlySet<number>;
  /** Fill mechanisms this transform refuses to touch — shading patterns, images, image masks. */
  unsupportedFillOps: ReadonlySet<number>;
}>;

export type WhiteModeTransformResult =
  | Readonly<{ status: "patched"; argsArray: readonly unknown[]; patchedIndices: readonly number[] }>
  | Readonly<{ status: "unsupported"; reason: string }>;

/** The exact whitened value stored for every one of the fill-color-setter ops above — pdf.js's evaluator pre-resolves PDF colors into ready-to-use canvas CSS color strings, so replacing an op's args with a single white CSS color string is correct across all of them (verified for setFillRGBColor against the real "Hala 1.pdf"; the other color-space variants follow the same pre-resolved-string convention). */
const WHITE_FILL_ARGS: readonly unknown[] = ["#ffffff"];

function readMarkedContentGroupId(args: unknown): string | undefined {
  if (!Array.isArray(args)) return undefined;
  const maybe = args[1];
  if (typeof maybe === "string") return maybe;
  if (maybe && typeof maybe === "object" && "id" in (maybe as Record<string, unknown>)) {
    const id = (maybe as Record<string, unknown>).id;
    return typeof id === "string" ? id : undefined;
  }
  return undefined;
}

/**
 * Computes a whitened COPY of `operatorList.argsArray` — never mutates the input arrays (spec
 * section 24G/26). Only the specific fill-color-setter indices identified as belonging to a
 * fill-family paint inside `targetLayerId` are replaced; every other index is the SAME reference
 * as in the source array (path geometry, transforms, line width, stroke color, dash — all
 * untouched, spec section 26).
 */
export function computeWhiteModeArgsArray(
  operatorList: OperatorListLike,
  targetLayerId: string,
  opCodes: WhiteModeOpCodes,
): WhiteModeTransformResult {
  const { fnArray, argsArray } = operatorList;
  const stack: (string | undefined)[] = [];
  let lastFillSetterIndex: number | undefined;
  const patchIndices = new Set<number>();
  let unsupportedReason: string | undefined;

  for (let index = 0; index < fnArray.length; index += 1) {
    const fn = fnArray[index];
    const args = argsArray[index];

    if (fn === opCodes.beginMarkedContentProps || fn === opCodes.beginMarkedContent) {
      stack.push(readMarkedContentGroupId(args));
      continue;
    }
    if (fn === opCodes.endMarkedContent) {
      stack.pop();
      continue;
    }

    const insideTarget = stack.length > 0 && stack[stack.length - 1] === targetLayerId;

    if (opCodes.fillColorSetters.has(fn)) {
      lastFillSetterIndex = index;
      continue;
    }

    if (!insideTarget) continue;

    if (opCodes.unsupportedFillOps.has(fn)) {
      unsupportedReason = "Cílová vrstva obsahuje jinou výplň než jednoduchou vektorovou barvu (např. shading nebo obrázek) — nelze bezpečně přebarvit jen výplň.";
      continue;
    }

    if (fn === opCodes.constructPath) {
      const paintType = Array.isArray(args) ? args[0] : undefined;
      if (typeof paintType === "number" && opCodes.fillPaintTypes.has(paintType) && lastFillSetterIndex !== undefined) {
        patchIndices.add(lastFillSetterIndex);
      }
      continue;
    }

    if (opCodes.rawFillPath !== undefined && fn === opCodes.rawFillPath && lastFillSetterIndex !== undefined) {
      patchIndices.add(lastFillSetterIndex);
    }
  }

  if (unsupportedReason) return { status: "unsupported", reason: unsupportedReason };
  if (patchIndices.size === 0) {
    return { status: "unsupported", reason: "V cílové vrstvě nebyla nalezena žádná barevná výplň, kterou by šlo bezpečně přebarvit." };
  }

  const patchedArgsArray = argsArray.slice();
  for (const index of patchIndices) patchedArgsArray[index] = WHITE_FILL_ARGS;
  return { status: "patched", argsArray: patchedArgsArray, patchedIndices: [...patchIndices].sort((a, b) => a - b) };
}

/**
 * Alias-based detection of "the stand layer" among a PDF's real Optional Content Groups (spec
 * section 15: "nehardcoduj celý systém pouze na přesný tento string"). Matches the layer's own
 * name after stripping diacritics/asterisks/whitespace against a small known-alias list. Exactly
 * one match is required — zero or multiple candidates means the system genuinely can't tell which
 * layer is the stand layer, and per spec section 16 the safe answer is "don't repaint anything",
 * never a best-effort guess.
 */
const STAND_LAYER_NAME_ALIASES: readonly string[] = ["stanky", "stands", "booth", "expozice"];

function normalizeLayerNameForMatching(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .replace(/[^a-z0-9]/giu, "")
    .toLowerCase();
}

export function detectStandLayerId(layers: readonly Readonly<{ id: string; name: string }>[]): Readonly<{ status: "found"; layerId: string } | { status: "none" } | { status: "ambiguous"; candidateLayerIds: readonly string[] }> {
  const matches = layers.filter((layer) => STAND_LAYER_NAME_ALIASES.some((alias) => normalizeLayerNameForMatching(layer.name).includes(alias)));
  if (matches.length === 0) return { status: "none" };
  if (matches.length > 1) return { status: "ambiguous", candidateLayerIds: matches.map((layer) => layer.id) };
  return { status: "found", layerId: matches[0]!.id };
}
