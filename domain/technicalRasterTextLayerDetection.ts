/**
 * Technické rastry — PRODUCTION BATCH, PART A section 3: "detect whether the layer contains text
 * operators before showing the size control." Pure algorithm, mirroring
 * domain/technicalRasterWhiteModeOperators.ts's own BDC/BMC/EMC marked-content-stack tracking
 * against pdf.js's own pre-parsed operator list (same reasoning: decoupled from pdfjs-dist's own
 * numeric op codes, so this stays fully unit-testable with small made-up op-code numbers — see
 * tests/technicalRasterTextLayerDetection.test.ts).
 *
 * Walks the operator list once, tracking which Optional Content Group id (pdf.js's own marked-
 * content group id, the SAME string RasterLayer.id already carries) is the nearest enclosing marked-
 * content ancestor at every point — a text-showing operator (Tj/TJ/'/") reached anywhere inside a
 * given OCG's span marks that OCG id as "contains text". Never inspects the actual glyph content —
 * this is a presence check only, purely to decide whether the text-scale UI control is worth
 * showing for a given layer (spec: "never show meaningless text-size controls for purely geometric
 * layers").
 */

export type OperatorListLike = Readonly<{
  fnArray: readonly number[];
  argsArray: readonly unknown[];
}>;

export type TextLayerDetectionOpCodes = Readonly<{
  beginMarkedContentProps: number;
  beginMarkedContent: number;
  endMarkedContent: number;
  /** Every op code that actually shows text (pdf.js may use more than one — e.g. showText and a spaced-text variant); any op in this set reached inside a marked-content group marks that group as text-bearing. */
  showTextOps: ReadonlySet<number>;
}>;

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
 * Returns the set of OCG (marked-content group) ids that have AT LEAST ONE real text-showing
 * operator somewhere inside their own span, anywhere in the given operator list — text nested inside
 * an unrelated tagged span (e.g. a "/Span BMC" inside the real OCG's own "/OC BDC") still correctly
 * attributes to the nearest REAL OCG ancestor, mirroring computeWhiteModeArgsArray's own "any
 * ancestor, not just top-of-stack" discipline used for a structurally identical situation.
 */
export function detectOcgIdsContainingText(operatorList: OperatorListLike, opCodes: TextLayerDetectionOpCodes): ReadonlySet<string> {
  const { fnArray, argsArray } = operatorList;
  const stack: (string | undefined)[] = [];
  const result = new Set<string>();

  for (let index = 0; index < fnArray.length; index += 1) {
    const fn = fnArray[index];

    if (fn === opCodes.beginMarkedContentProps || fn === opCodes.beginMarkedContent) {
      stack.push(readMarkedContentGroupId(argsArray[index]));
      continue;
    }
    if (fn === opCodes.endMarkedContent) {
      stack.pop();
      continue;
    }
    if (opCodes.showTextOps.has(fn)) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        const groupId = stack[i];
        if (groupId !== undefined) { result.add(groupId); break; }
      }
    }
  }

  return result;
}
