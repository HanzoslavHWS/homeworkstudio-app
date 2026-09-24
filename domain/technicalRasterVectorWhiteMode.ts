/**
 * Technické rastry — corrective batch section 4: "Vector white mode" for the PDF EXPORT, replacing
 * the previous "not supported" state (see docs/technical-rasters.md's own former "Deliberately not
 * done yet" entry). The live editor's white mode (lib/pdf/technicalRasterWhiteRender.ts) works by
 * intercepting pdf.js's CANVAS render — that mechanism has no equivalent when writing a real PDF
 * with pdf-lib, because pdf-lib never interprets/renders the copied page's content stream at all.
 *
 * This module is a from-scratch, dependency-free PDF **content-stream operator tokenizer +
 * rewriter** — pure bytes in, pure bytes out, zero pdf-lib/pdfjs imports, so it is directly
 * unit-testable with small hand-built content streams. It performs exactly ONE transformation,
 * mirroring the live editor's own rule as closely as the two mediums allow:
 *
 *   - Track the Optional-Content (BDC/BMC ... EMC) marked-content nesting exactly like a real PDF
 *     content-stream interpreter would (the same technique domain/technicalRasterWhiteModeOperators.ts
 *     already uses against pdf.js's own pre-parsed operator list — this is the raw-content-stream
 *     equivalent, operating on real PDF operator syntax instead of pdf.js's numeric op codes).
 *   - Remember the most recently seen NON-STROKING color-setting command (`g`/`rg`/`k`/`sc`/`scn`
 *     — lowercase only; the STROKING variants `G`/`RG`/`K`/`SC`/`SCN` are never touched, so a
 *     stroke's own color is always preserved exactly as the source PDF drew it).
 *   - Whenever a FILL-family painting operator (`f`/`F`/`f*`/`B`/`B*`/`b`/`b*`) runs while INSIDE
 *     one of the target Optional Content spans, mark that remembered color-setting command's own
 *     byte range for replacement with a plain, colorspace-independent `1 1 1 rg` (opaque white in
 *     DeviceRGB — valid without any preceding `cs`, so it can safely replace ANY prior fill-color
 *     mechanism). The painting operator itself, and everything else in the stream, is left
 *     byte-for-byte untouched — geometry, stroke color/width/dash, transforms, text, all of it.
 *   - When `opacityFraction < 1`, additionally wraps each ENTIRE target marked-content span in
 *     `q\n/<extGStateName> gs\n ... \nQ\n`, invoking an ExtGState the caller has already registered
 *     with `/ca <opacityFraction>` (non-stroking alpha only — `/CA`, the STROKING alpha, is never
 *     touched, so a stroke's opacity is exactly the source PDF's own, never affected by "Krytí
 *     bílé"). This reproduces the exact same alpha-compositing semantics the live editor's own
 *     `resolveWhiteFillColor` already uses (a literal `rgba(255,255,255,opacity)` canvas fill,
 *     painted over whatever the page has already drawn beneath it at that point in the stream) —
 *     opacity 0 means the fill effectively disappears (revealing whatever was drawn earlier in the
 *     SAME content stream at that location); opacity 1 needs no ExtGState UNLESS the target scope's
 *     own SOURCE content sets its own alpha via a `gs` call (see `hasSourceGsInsideTarget`'s own
 *     doc below — real production evidence, Hala 3/FOR BEAUTY, where a per-stand `/ca 0.76`
 *     ExtGState is set at the page level before every stand's own Form XObject, letting the hall's
 *     background grid show through even a "fully opaque" white fill unless neutralized).
 *
 * Anything this algorithm cannot confidently classify — a Pattern-space fill (`scn` whose last
 * operand is a Name, i.e. a tiling/shading pattern), a shading fill (`sh`), an XObject invocation
 * (`Do`, which could be an image), an inline image (`BI...ID...EI`), or any other construct this
 * tokenizer doesn't recognize (a PostScript calculator function body `{ ... }`, which should never
 * appear directly in ordinary page content) while INSIDE a target span — aborts the WHOLE
 * transform with `status: "unsupported"` and a plain-language reason. Per the module's own explicit
 * requirement, there is no partial/best-effort output and never a raster fallback of any kind here
 * — the caller (lib/technicalRasterVectorPdf.ts) is expected to fall back to the page's ORIGINAL,
 * still-fully-vector colors when this reports "unsupported", exactly like the live editor already
 * falls back to an unpatched (but still real) render.
 *
 * PRODUCTION BATCH (per-source-OCG-layer text-size reduction) — the raw byte-level tokenizer this
 * module's own algorithm is built on (nextToken/skipInlineImage/decodeName/findOperandToken/edit-
 * application) was extracted, verbatim, into domain/pdfContentStreamTokenizer.ts so
 * domain/technicalRasterTextScale.ts's own Tf-scaling transform could reuse the SAME safe mechanism
 * (spec: "do NOT build a completely separate PDF parser") rather than duplicating it — this module's
 * own transform logic below is completely unchanged by that extraction.
 */
import {
  applyContentStreamEdits,
  decodeName,
  findOperandToken,
  nextToken,
  skipInlineImage,
  UnsupportedError,
  type ContentStreamEdit,
  type TokenType,
} from "./pdfContentStreamTokenizer.ts";

export type VectorWhiteModeOptions = Readonly<{
  /** Decoded (no leading "/") resource-dictionary key names, from the copied page's own `/Resources/Properties`, that all resolve to the SAME target Optional Content Group object — a `BDC` operator's `/OC <Name>` is a match when `<Name>` (decoded) is in this set. Empty means "the target layer could not be located in this page's own resources" — always `status: "unsupported"`, never silently a no-op. Ignored (never checked) when `assumeEntireStreamIsTarget` is set. */
  targetOcPropertyNames: ReadonlySet<string>;
  /** 0-1, already clamped by the caller (see resolveWhiteFillColor's own doc for why this uses the exact same 0-1 fraction as the live editor's "Krytí bílé"). */
  opacityFraction: number;
  /** Resource-dictionary key (no leading "/") of an ExtGState already registered by the caller with `/ca` set to `opacityFraction` — required whenever `opacityFraction < 1`; ignored otherwise (no wrapping is emitted for full opacity, since `/ca 1` is the graphics-state default already). */
  extGStateName?: string;
  /**
   * CORRECTIVE BATCH (white mode / Form XObject support) — when `true`, a `Do` operator reached
   * while inside the target scope no longer aborts the transform with "unsupported". Instead each
   * such invocation is recorded (deduplicated by resource name, with the byte range of the name
   * operand immediately preceding `Do`, for an optional rename edit — see `renameFormInvocations`)
   * into the result's own `formInvocationsInsideTarget`, and left byte-for-byte untouched in the
   * output unless renamed. Every `Do` reached OUTSIDE the target scope is also recorded (into
   * `formInvocationsOutsideTarget`) purely for the caller's own shared-Form detection — this module
   * itself never inspects PDF objects, it only ever reports NAMES and byte ranges; resolving a name
   * to an actual XObject, checking its `/Subtype`, and deciding mutate-vs-clone-on-write for a
   * shared Form are all lib/technicalRasterVectorPdf.ts's own job (this module has zero pdf-lib
   * dependency, spec's own "pure bytes in, pure bytes out" discipline). Omitted (or false) keeps
   * today's exact original behavior: a `Do` inside target scope still aborts as "unsupported".
   */
  allowFormXObjects?: boolean;
  /**
   * When `true`, the ENTIRE stream is treated as already being inside the target scope from byte 0
   * — no BDC/OC marked-content detection is performed at all (`targetOcPropertyNames` is ignored).
   * Used for recursing into a Form XObject's OWN content once the caller has already established
   * (from the PAGE's own marked-content structure) that this Form was invoked from inside the
   * target OCG span — a Form reached that way is unconditionally "target" content for its entire
   * body, exactly like the spec's own "target OCG -> Form A -> Form B -> fill" example.
   */
  assumeEntireStreamIsTarget?: boolean;
  /**
   * Old resource name -> new resource name, applied ONLY at `Do`-invocation name operands found
   * INSIDE the target scope (never touches an outside-target invocation of the same name, and never
   * touches the `Do` operator token itself — only the name operand immediately before it). Used by
   * the caller for the "shared Form" case (spec section 10): when a Form is invoked from BOTH the
   * target scope and elsewhere, the caller clones the Form under a NEW resource name and asks this
   * function to redirect only the target-scope invocation(s) to that new name, leaving the original
   * name (and therefore the original, unmodified Form object) fully intact for its other use(s).
   */
  renameFormInvocations?: ReadonlyMap<string, string>;
}>;

export type FormInvocation = Readonly<{ name: string }>;

export type VectorWhiteModeResult =
  | Readonly<{
    status: "patched";
    content: Uint8Array;
    whitenedFillCommandCount: number;
    wrappedSpanCount: number;
    /** Deduplicated by name — every `Do` invocation reached while inside the target scope (only ever non-empty when `allowFormXObjects` was set). */
    formInvocationsInsideTarget: readonly FormInvocation[];
    /** Deduplicated by name — every `Do` invocation reached OUTSIDE the target scope, for the caller's own shared-Form detection. */
    formInvocationsOutsideTarget: readonly FormInvocation[];
  }>
  | Readonly<{ status: "unsupported"; reason: string }>;

const FILL_COLOR_OPS = new Set(["g", "rg", "k", "sc", "scn"]);
const FILL_PAINT_OPS = new Set(["f", "F", "f*", "B", "B*", "b", "b*"]);
const WHITE_FILL_REPLACEMENT = " 1 1 1 rg ";

/**
 * Runs the tokenizer/rewriter over one already-decoded (decompressed) content stream. Never throws
 * — every parse failure this module anticipates (`UnsupportedError`) is caught and reported as
 * `status: "unsupported"`; this is deliberately the ONLY exit path other than a clean `"patched"`
 * result, so a caller never needs a second try/catch around this function.
 */
export function computeVectorWhiteModeContentStream(content: Uint8Array, options: VectorWhiteModeOptions): VectorWhiteModeResult {
  if (!options.assumeEntireStreamIsTarget && options.targetOcPropertyNames.size === 0) {
    return { status: "unsupported", reason: "Vrstva stánků nebyla v obsahu stránky nalezena (chybí odpovídající BDC/OC značka)." };
  }
  // CORRECTIVE BATCH (real production — H3 100% white / grid-through-fill) — wrapping/reasserting
  // is needed not only when the PROJECT itself requests less than 100% opacity, but ALSO whenever
  // the target scope's own SOURCE content contains a `gs` operator that could set alpha away from
  // 1 (real H3 evidence — see hasSourceGsInsideTarget's own doc) — otherwise a fully-opaque
  // "opacityFraction===1" request could still render translucent, letting earlier-drawn content
  // (the hall's own background grid) show through. H1 (and every existing synthetic fixture with no
  // `gs` at all) never triggers this extra check, so today's "opacity 1 needs no ExtGState at all"
  // output is completely unchanged for that case.
  const wrapOpacity = options.opacityFraction < 1 || hasSourceGsInsideTarget(content, options);
  if (wrapOpacity && !options.extGStateName) {
    return { status: "unsupported", reason: "Interní chyba: chybí registrovaný ExtGState pro krytí bílé (potřebný i při 100 %, pokud zdrojový obsah sám nastavuje průhlednost)." };
  }
  const renameMap = options.renameFormInvocations;

  try {
    type StackFrame = Readonly<{ isTarget: boolean; bdcStart: number; bdcEnd: number }>;
    const stack: StackFrame[] = [];
    // How many ancestor frames (not just the immediate parent) are the target OCG — content nested
    // inside the target span for an UNRELATED reason (e.g. a "/Span BMC" text-tagging marked
    // content nested inside the stand layer's own "/OC BDC") must still count as "inside target":
    // a plain top-of-stack check would wrongly stop whitening the instant any non-OC marked content
    // is nested inside, even though the fill still visually belongs to the target OCG.
    let targetDepth = options.assumeEntireStreamIsTarget ? 1 : 0;
    let lastFillColorCommand: Readonly<{ start: number; end: number; isPattern: boolean }> | undefined;
    const fillPatchOffsets = new Set<number>();
    const edits: ContentStreamEdit[] = [];
    let wrappedSpanCount = 0;
    const formInvocationsInsideTarget = new Map<string, FormInvocation>();
    const formInvocationsOutsideTarget = new Map<string, FormInvocation>();

    // CORRECTIVE BATCH (white mode / Form XObject support, section 8; generalized by the real-
    // production H3 100%-white batch below) — whenever wrapping is active, ANY `gs` operator the
    // TARGET SCOPE'S OWN content invokes (a real source ExtGState this transform never inspects/
    // mutates — "do not strip arbitrary transparency that belongs to unrelated content") gets our
    // own opacity ExtGState immediately RE-ASSERTED right after it. A `gs` invocation fully
    // REPLACES the graphics state's current alpha (never multiplies), so re-asserting ours
    // immediately after ANY source `gs` call guarantees the FINAL alpha in effect for anything
    // drawn afterward is always exactly the project's own "Krytí bílé" value, regardless of what
    // the source's own ExtGState set (or didn't set) — the source `gs` call itself, and everything
    // else it may configure (blend mode, overprint, soft mask), is left completely untouched.
    // Originally scoped to ONLY the recursed-Form-body case (`assumeEntireStreamIsTarget`) — real
    // H3 evidence proved a source `gs` can equally be reached directly inside an ordinary page-level
    // BDC/OC span (the per-stand `/ca 0.76` ExtGState set immediately before each `/FmNN Do`), so
    // this now applies uniformly to BOTH shapes of target scope.
    const reassertOpacityAfterGs = wrapOpacity;

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

      if (op === "gs" && reassertOpacityAfterGs && insideTarget) {
        edits.push({ offset: token.end, kind: "insert", text: `\n/${options.extGStateName} gs\n` });
      }

      if (op === "Do" && options.allowFormXObjects) {
        const name = lastOperandType === "name" && lastOperandStart !== undefined && lastOperandEnd !== undefined
          ? decodeName(content, lastOperandStart, lastOperandEnd)
          : undefined;
        if (!name) throw new UnsupportedError("Operátor \"Do\" odkazuje na neplatný název zdroje.");
        if (insideTarget) {
          formInvocationsInsideTarget.set(name, { name });
          const renamed = renameMap?.get(name);
          if (renamed !== undefined && lastOperandStart !== undefined && lastOperandEnd !== undefined) {
            edits.push({ offset: lastOperandStart, kind: "replace", end: lastOperandEnd, text: `/${renamed}` });
          }
        } else {
          formInvocationsOutsideTarget.set(name, { name });
        }
        commandStart = undefined; pendingOperandCount = 0; lastOperandType = undefined; lastOperandStart = undefined; lastOperandEnd = undefined;
        continue;
      }

      if (op === "BI") {
        pos = skipInlineImage(content, pos);
        if (insideTarget) throw new UnsupportedError("Cílová vrstva obsahuje inline obrázek — nelze bezpečně přebarvit jen výplň.");
        commandStart = undefined; pendingOperandCount = 0; lastOperandType = undefined;
        continue;
      }

      if (op === "BDC" || op === "BMC") {
        let isTarget = false;
        if (op === "BDC" && pendingOperandCount >= 2 && lastOperandType) {
          // The tag (e.g. "/OC") is the second-to-last operand; the properties reference is the
          // last. We only need the properties operand's own token, re-scanned from cmdStart.
          const tagToken = findOperandToken(content, cmdStart, pendingOperandCount - 2);
          const propsToken = findOperandToken(content, cmdStart, pendingOperandCount - 1);
          if (tagToken?.type === "name" && tagToken.text === "OC") {
            if (propsToken?.type === "name" && propsToken.text) {
              isTarget = options.targetOcPropertyNames.has(propsToken.text);
            } else {
              throw new UnsupportedError("Značka vrstvy (/OC) v obsahu stránky odkazuje na vloženy slovník, ne na pojmenovaný zdroj — nelze bezpečně ověřit, zda jde o vrstvu stánků.");
            }
          }
        }
        stack.push({ isTarget, bdcStart: cmdStart, bdcEnd: token.end });
        if (isTarget) {
          targetDepth += 1;
          if (wrapOpacity) {
            edits.push({ offset: token.end, kind: "insert", text: `\nq\n/${options.extGStateName} gs\n` });
            wrappedSpanCount += 1;
          }
        }
        commandStart = undefined; pendingOperandCount = 0; lastOperandType = undefined;
        continue;
      }

      if (op === "EMC") {
        const frame = stack.pop();
        if (frame?.isTarget) {
          targetDepth -= 1;
          if (wrapOpacity) edits.push({ offset: cmdStart, kind: "insert", text: "\nQ\n" });
        }
        commandStart = undefined; pendingOperandCount = 0; lastOperandType = undefined;
        continue;
      }

      if (FILL_COLOR_OPS.has(op)) {
        lastFillColorCommand = { start: cmdStart, end: token.end, isPattern: op === "scn" && lastOperandType === "name" };
        commandStart = undefined; pendingOperandCount = 0; lastOperandType = undefined;
        continue;
      }

      if (!insideTarget) { commandStart = undefined; pendingOperandCount = 0; lastOperandType = undefined; continue; }

      if (op === "sh" || op === "Do") {
        throw new UnsupportedError(`Cílová vrstva obsahuje "${op}" (shading nebo XObject) — nelze bezpečně přebarvit jen výplň.`);
      }

      if (FILL_PAINT_OPS.has(op)) {
        if (lastFillColorCommand) {
          if (lastFillColorCommand.isPattern) {
            throw new UnsupportedError("Cílová vrstva používá vzorkovou (Pattern) výplň — nelze bezpečně přebarvit jen výplň.");
          }
          if (!fillPatchOffsets.has(lastFillColorCommand.start)) {
            fillPatchOffsets.add(lastFillColorCommand.start);
            edits.push({ offset: lastFillColorCommand.start, kind: "replace", end: lastFillColorCommand.end, text: WHITE_FILL_REPLACEMENT });
          }
        }
      }

      commandStart = undefined; pendingOperandCount = 0; lastOperandType = undefined;
    }

    if (stack.length > 0) throw new UnsupportedError("Nevyvážené BDC/EMC značky v obsahu stránky.");
    if (fillPatchOffsets.size === 0 && formInvocationsInsideTarget.size === 0) {
      return { status: "unsupported", reason: "V cílové vrstvě nebyla nalezena žádná barevná výplň, kterou by šlo bezpečně přebarvit." };
    }

    // CORRECTIVE BATCH (white mode / Form XObject support) — a recursed Form's ENTIRE body is
    // itself the "target span" (there is no BDC/EMC of its own to hang the opacity wrap off), so it
    // gets the SAME q/gs/Q bracket the page-level BDC/EMC span already gets, just spanning the
    // whole stream instead of one marked-content region. `wrappedSpanCount` counts it identically
    // (spec: "implement it consistently with the existing Hala 1 behavior").
    if (options.assumeEntireStreamIsTarget && wrapOpacity) {
      edits.push({ offset: 0, kind: "insert", text: `\nq\n/${options.extGStateName} gs\n` });
      edits.push({ offset: content.length, kind: "insert", text: "\nQ\n" });
      wrappedSpanCount += 1;
    }

    // An "insert" at a given offset must always be applied before a "replace" that starts at that
    // SAME offset (e.g. the whole-form q/gs wrap inserted at offset 0 colliding with a fill-color
    // replace that also starts at offset 0, when the form's very first bytes are the fill command) —
    // applyContentStreamEdits (domain/pdfContentStreamTokenizer.ts) handles this exact tie-break.
    const result = applyContentStreamEdits(content, edits);

    return {
      status: "patched",
      content: result,
      whitenedFillCommandCount: fillPatchOffsets.size,
      wrappedSpanCount,
      formInvocationsInsideTarget: [...formInvocationsInsideTarget.values()],
      formInvocationsOutsideTarget: [...formInvocationsOutsideTarget.values()],
    };
  } catch (error) {
    if (error instanceof UnsupportedError) return { status: "unsupported", reason: error.message };
    throw error;
  }
}

/**
 * CORRECTIVE BATCH (real production — H3 100% white / grid-through-fill) — pre-scan: does the
 * target scope contain ANY `gs` operator at all? Real evidence (Hala 3/FOR BEAUTY): the source PDF
 * applies its OWN non-1 alpha via a `gs` call reached from inside the target OCG span — a per-stand
 * ExtGState (`/ca 0.76 /CA 0.76`) set at the PAGE level, immediately before invoking that stand's
 * own Form XObject, completely independent of anything this app's own "Krytí bílé" opacity slider
 * says. Left unneutralized, that source alpha lets whatever was drawn BEFORE it in the same content
 * stream (the hall's own background grid) show through even a fully-opaque (opacityFraction===1)
 * white fill — confirmed structurally: H1 has zero `gs` operators anywhere in its stand span
 * (direct fills only), so it never exercises this path at all, exactly matching why H1 never showed
 * the artifact while H3 does. When this returns true, `computeVectorWhiteModeContentStream` wraps
 * and re-asserts opacity EVEN AT opacityFraction===1 (a real `ca:1` ExtGState re-asserted after
 * every source `gs`), purely to neutralize arbitrary source alpha — never to change the numeric
 * opacity the project actually requested. A lightweight boolean walk (mirrors the main loop's own
 * BDC/EMC/targetDepth tracking exactly, but touches nothing else — never a second edit pass).
 */
function hasSourceGsInsideTarget(content: Uint8Array, options: VectorWhiteModeOptions): boolean {
  const stack: boolean[] = [];
  let targetDepth = options.assumeEntireStreamIsTarget ? 1 : 0;
  let pos = 0;
  let commandStart: number | undefined;
  let pendingOperandCount = 0;
  let lastOperandType: TokenType | undefined;
  for (;;) {
    const token = nextToken(content, pos);
    if (!token) break;
    pos = token.end;
    if (token.type !== "op") {
      if (commandStart === undefined) commandStart = token.start;
      pendingOperandCount += 1;
      lastOperandType = token.type;
      continue;
    }
    const op = token.text ?? "";
    const cmdStart = commandStart ?? token.start;
    if (op === "gs" && targetDepth > 0) return true;
    if (op === "BI") { pos = skipInlineImage(content, pos); commandStart = undefined; pendingOperandCount = 0; lastOperandType = undefined; continue; }
    if (op === "BDC" || op === "BMC") {
      let isTarget = false;
      if (op === "BDC" && pendingOperandCount >= 2 && lastOperandType) {
        const tagToken = findOperandToken(content, cmdStart, pendingOperandCount - 2);
        const propsToken = findOperandToken(content, cmdStart, pendingOperandCount - 1);
        if (tagToken?.type === "name" && tagToken.text === "OC" && propsToken?.type === "name" && propsToken.text) {
          isTarget = options.targetOcPropertyNames.has(propsToken.text);
        }
      }
      stack.push(isTarget);
      if (isTarget) targetDepth += 1;
      commandStart = undefined; pendingOperandCount = 0; lastOperandType = undefined;
      continue;
    }
    if (op === "EMC") {
      const wasTarget = stack.pop();
      if (wasTarget) targetDepth -= 1;
      commandStart = undefined; pendingOperandCount = 0; lastOperandType = undefined;
      continue;
    }
    commandStart = undefined; pendingOperandCount = 0; lastOperandType = undefined;
  }
  return false;
}

