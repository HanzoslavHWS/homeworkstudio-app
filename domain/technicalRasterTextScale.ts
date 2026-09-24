/**
 * Technické rastry — PRODUCTION BATCH, PART A: per-source-OCG-layer TEXT SIZE REDUCTION for the
 * vector PDF export. Real-fixture audit (both `_IMPORT/Hala 1.pdf` and `_IMPORT/Hala 3_2026-
 * ver.12_NOVY_3.pdf`) confirms the two layers this feature exists for — "NÁZVY + ROZMĚRY ***"
 * (exhibitor names + dimensions) and "ČÍSLA EXPOZIC ***" (stand numbers) — draw their own real PDF
 * text DIRECTLY in the page's own content stream, with ZERO Form XObject (`Do`) invocations inside
 * either OCG's own marked-content span on either fixture (see the final report's own "real PDF
 * text-layer audit" section for the raw numbers). This module is therefore deliberately scoped to
 * that real, verified shape — `Do` reached inside a target text-scale scope is reported
 * `"unsupported"`, never silently skipped or guessed at, exactly like
 * domain/technicalRasterVectorWhiteMode.ts's own "never partial output" discipline.
 *
 * Reuses the EXACT SAME safe tokenizer primitives that module already uses (spec: "do NOT build a
 * completely separate PDF parser if an existing safe mechanism can be extended") — see
 * domain/pdfContentStreamTokenizer.ts, extracted from technicalRasterVectorWhiteMode.ts specifically
 * so both transforms share one implementation.
 *
 * ONLY the font-SIZE operand of every `Tf` operator (e.g. the "12" in `/F1 12 Tf`) reached while
 * inside the target OCG's marked-content span is rewritten, multiplied by `scale` — never the font
 * NAME operand, never `Tm`/`Td`/other text-positioning operators, never any geometry/fill/stroke
 * operator, and never anything outside the target scope. This is exactly why only text visually
 * shrinks while its own anchor/origin (set by `Tm`/`Td`, completely untouched) stays put: a smaller
 * font drawn from the SAME text-line origin naturally renders smaller without moving where it
 * starts (spec section 4: "The original text anchor/origin should remain unchanged").
 */
import {
  applyContentStreamEdits,
  findOperandToken,
  nextToken,
  skipInlineImage,
  UnsupportedError,
  type ContentStreamEdit,
  type TokenType,
} from "./pdfContentStreamTokenizer.ts";

export type TextScaleOptions = Readonly<{
  /** Decoded (no leading "/") resource-dictionary key names that all resolve to the SAME target OCG object — same contract as VectorWhiteModeOptions.targetOcPropertyNames. Empty always means `status: "unsupported"`, never a silent no-op. */
  targetOcPropertyNames: ReadonlySet<string>;
  /** The multiplier applied to every `Tf` size operand found inside the target scope — already clamped by the caller to domain/technicalRaster.ts's own [MIN_SOURCE_LAYER_TEXT_SCALE, MAX_SOURCE_LAYER_TEXT_SCALE]. */
  scale: number;
}>;

export type TextScaleResult =
  | Readonly<{ status: "patched"; content: Uint8Array; scaledFontSizeCount: number }>
  | Readonly<{ status: "unsupported"; reason: string }>;

/** Formats a scaled font size as a plain PDF real number — never scientific notation, never a trailing ".0000" of noise, and never NaN/Infinity (defensively clamped to 0 in that impossible case, since a PDF number token can't encode either). */
function formatPdfNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 10000) / 10000;
  return rounded.toFixed(4).replace(/0+$/u, "").replace(/\.$/u, "");
}

/**
 * Runs the tokenizer/rewriter over one already-decoded content stream. Never throws — every parse
 * failure this module anticipates (`UnsupportedError`) is caught and reported as
 * `status: "unsupported"`, the same discipline as computeVectorWhiteModeContentStream.
 */
export function computeTextScaleContentStream(content: Uint8Array, options: TextScaleOptions): TextScaleResult {
  if (options.targetOcPropertyNames.size === 0) {
    return { status: "unsupported", reason: "Zvolená zdrojová vrstva nebyla v obsahu stránky nalezena (chybí odpovídající BDC/OC značka)." };
  }

  try {
    type StackFrame = Readonly<{ isTarget: boolean }>;
    const stack: StackFrame[] = [];
    // Same "nearest ancestor, not just top-of-stack" discipline as computeVectorWhiteModeContentStream
    // — text-tagging marked content (e.g. "/Span BMC") nested inside the target OCG's own "/OC BDC"
    // must still count as "inside target".
    let targetDepth = 0;
    const edits: ContentStreamEdit[] = [];
    const scaledOffsets = new Set<number>();

    let pos = 0;
    let commandStart: number | undefined;
    let pendingOperandCount = 0;
    let lastOperandType: TokenType | undefined;
    let lastOperandStart: number | undefined;
    let lastOperandEnd: number | undefined;

    for (;;) {
      const token = nextToken(content, pos);
      if (!token) break;
      pos = token.end;

      if (token.type !== "op") {
        if (commandStart === undefined) commandStart = token.start;
        pendingOperandCount += 1;
        lastOperandType = token.type;
        lastOperandStart = token.start;
        lastOperandEnd = token.end;
        continue;
      }

      const op = token.text ?? "";
      const cmdStart = commandStart ?? token.start;
      const insideTarget = targetDepth > 0;

      if (op === "BI") {
        // Inline images carry no text of their own and can never confuse the OCG-nesting tracker
        // below (spec: never corrupt/mis-tokenize binary content) — skipped unconditionally, inside
        // or outside target, since Tf-scaling has no interest in image data either way.
        pos = skipInlineImage(content, pos);
        commandStart = undefined; pendingOperandCount = 0; lastOperandType = undefined; lastOperandStart = undefined; lastOperandEnd = undefined;
        continue;
      }

      if (op === "BDC" || op === "BMC") {
        let isTarget = false;
        if (op === "BDC" && pendingOperandCount >= 2 && lastOperandType) {
          const tagToken = findOperandToken(content, cmdStart, pendingOperandCount - 2);
          const propsToken = findOperandToken(content, cmdStart, pendingOperandCount - 1);
          if (tagToken?.type === "name" && tagToken.text === "OC") {
            if (propsToken?.type === "name" && propsToken.text) {
              isTarget = options.targetOcPropertyNames.has(propsToken.text);
            } else {
              throw new UnsupportedError("Značka vrstvy (/OC) v obsahu stránky odkazuje na vloženy slovník, ne na pojmenovaný zdroj — nelze bezpečně ověřit, zda jde o zvolenou vrstvu.");
            }
          }
        }
        stack.push({ isTarget });
        if (isTarget) targetDepth += 1;
        commandStart = undefined; pendingOperandCount = 0; lastOperandType = undefined; lastOperandStart = undefined; lastOperandEnd = undefined;
        continue;
      }

      if (op === "EMC") {
        const frame = stack.pop();
        if (frame?.isTarget) targetDepth -= 1;
        commandStart = undefined; pendingOperandCount = 0; lastOperandType = undefined; lastOperandStart = undefined; lastOperandEnd = undefined;
        continue;
      }

      if (!insideTarget) { commandStart = undefined; pendingOperandCount = 0; lastOperandType = undefined; lastOperandStart = undefined; lastOperandEnd = undefined; continue; }

      if (op === "Do") {
        throw new UnsupportedError("Zvolená vrstva vyvolává Form XObject (Do) — zmenšení textu uvnitř vnořeného Form XObjectu není v této verzi podporováno.");
      }

      if (op === "Tf") {
        if (lastOperandType === "num" && lastOperandStart !== undefined && lastOperandEnd !== undefined) {
          const raw = content.subarray(lastOperandStart, lastOperandEnd);
          let text = "";
          for (let i = 0; i < raw.length; i += 1) text += String.fromCharCode(raw[i]!);
          const originalSize = Number(text);
          if (Number.isFinite(originalSize) && !scaledOffsets.has(lastOperandStart)) {
            scaledOffsets.add(lastOperandStart);
            edits.push({ offset: lastOperandStart, kind: "replace", end: lastOperandEnd, text: formatPdfNumber(originalSize * options.scale) });
          }
        }
        commandStart = undefined; pendingOperandCount = 0; lastOperandType = undefined; lastOperandStart = undefined; lastOperandEnd = undefined;
        continue;
      }

      commandStart = undefined; pendingOperandCount = 0; lastOperandType = undefined; lastOperandStart = undefined; lastOperandEnd = undefined;
    }

    if (stack.length > 0) throw new UnsupportedError("Nevyvážené BDC/EMC značky v obsahu stránky.");

    const result = applyContentStreamEdits(content, edits);
    return { status: "patched", content: result, scaledFontSizeCount: scaledOffsets.size };
  } catch (error) {
    if (error instanceof UnsupportedError) return { status: "unsupported", reason: error.message };
    throw error;
  }
}
