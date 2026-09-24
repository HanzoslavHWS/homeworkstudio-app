/**
 * Technické rastry — PRODUCTION BATCH, PART A: the pure algorithm behind the LIVE EDITOR's own text
 * scaling preview, mirroring domain/technicalRasterWhiteModeOperators.ts's own architecture exactly
 * (same reasoning: decoupled from pdfjs-dist's own numeric op codes, walking the operator list once,
 * tracking the Optional-Content marked-content stack the same way a real PDF renderer would).
 *
 * Unlike the fill-color whitening algorithm, this one only needs to find WHICH operator indices are
 * a `setFont` (Tf) call reached while inside the target layer's own marked-content span — the actual
 * font-size SCALING happens later, in the canvas Proxy (lib/pdf/pdfWhiteModeCanvasProxy.ts), which
 * intercepts pdf.js's own `ctx.font = "<size>px <family>"` assignment at exactly these indices and
 * multiplies the parsed size by the configured scale — the SAME "compute WHICH index, force the
 * canvas property AT that index" split white mode's own fillStyle mechanism already uses (this file
 * never touches a canvas or pdf.js itself).
 */

export type TextScaleOperatorListLike = Readonly<{
  fnArray: readonly number[];
  argsArray: readonly unknown[];
}>;

export type TextScaleOpCodes = Readonly<{
  beginMarkedContentProps: number;
  beginMarkedContent: number;
  endMarkedContent: number;
  /** pdf.js's own `Tf` operator code (OPS.setFont). */
  setFont: number;
}>;

export type TextScalePatchPlanResult =
  | Readonly<{ status: "patched"; patchedIndices: readonly number[] }>
  | Readonly<{ status: "unsupported"; reason: string }>;

/**
 * Computes every operator-list INDEX that is a `setFont` call reached while inside `targetLayerId`'s
 * own marked-content span (top-of-stack match — same simple, already-proven convention
 * computeWhiteModeArgsArray itself uses for this exact same job on the exact same kind of operator
 * list, never the "any ancestor" variant the raw content-stream tokenizer needs for its own
 * different reasons). Zero matches is reported as `"unsupported"` — the caller only ever invokes
 * this for a layer the app has already confirmed contains text (domain/technicalRasterTextLayerDetection.ts),
 * so finding none here means the live raster no longer matches the project's own persisted
 * configuration (e.g. a re-uploaded/different source PDF) — never silently a no-op.
 */
export function computeTextScalePatchIndices(
  operatorList: TextScaleOperatorListLike,
  targetLayerId: string,
  opCodes: TextScaleOpCodes,
): TextScalePatchPlanResult {
  const { fnArray, argsArray } = operatorList;
  const stack: (string | undefined)[] = [];
  const patchIndices: number[] = [];

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
    if (insideTarget && fn === opCodes.setFont) patchIndices.push(index);
  }

  if (patchIndices.length === 0) {
    return { status: "unsupported", reason: "V cílové vrstvě nebyl nalezen žádný text (Tf), který by šlo zmenšit." };
  }
  return { status: "patched", patchedIndices: patchIndices };
}

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
