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
 *     SAME content stream at that location), opacity 1 needs no ExtGState at all.
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
 */

const CH_LF = 10;
const CH_CR = 13;
const CH_TAB = 9;
const CH_FF = 12;
const CH_NUL = 0;
const CH_SPACE = 32;
const CH_PERCENT = 37;
const CH_LPAREN = 40;
const CH_RPAREN = 41;
const CH_SLASH = 47;
const CH_LESS = 60;
const CH_GREATER = 62;
const CH_LBRACKET = 91;
const CH_BACKSLASH = 92;
const CH_RBRACKET = 93;
const CH_LBRACE = 123;
const CH_RBRACE = 125;
const CH_PLUS = 43;
const CH_MINUS = 45;
const CH_DOT = 46;
const CH_HASH = 35;

function isWhitespace(byte: number): boolean {
  return byte === CH_NUL || byte === CH_TAB || byte === CH_LF || byte === CH_FF || byte === CH_CR || byte === CH_SPACE;
}

function isDigit(byte: number): boolean {
  return byte >= 48 && byte <= 57;
}

function isDelimiter(byte: number): boolean {
  return (
    byte === CH_LPAREN || byte === CH_RPAREN || byte === CH_LESS || byte === CH_GREATER ||
    byte === CH_LBRACKET || byte === CH_RBRACKET || byte === CH_LBRACE || byte === CH_RBRACE ||
    byte === CH_SLASH || byte === CH_PERCENT
  );
}

function isRegular(byte: number): boolean {
  return !isWhitespace(byte) && !isDelimiter(byte);
}

type TokenType = "num" | "name" | "string" | "hexstring" | "array" | "dict" | "op";

type Token = Readonly<{ type: TokenType; start: number; end: number; text?: string }>;

class UnsupportedError extends Error {}

/** Advances past a balanced literal string `( ... )`, honoring backslash escapes and nested parens (spec: never mis-tokenize a string's own contents as operators). `pos` must point AT the opening `(`. Returns the index just past the matching `)`. */
function skipLiteralString(bytes: Uint8Array, pos: number): number {
  let depth = 1;
  let i = pos + 1;
  while (i < bytes.length && depth > 0) {
    const byte = bytes[i];
    if (byte === CH_BACKSLASH) { i += 2; continue; }
    if (byte === CH_LPAREN) depth += 1;
    else if (byte === CH_RPAREN) depth -= 1;
    i += 1;
  }
  if (depth !== 0) throw new UnsupportedError("Nezavřený textový řetězec v obsahu stránky.");
  return i;
}

/** `pos` must point AT the opening `<` of a hex string (already confirmed not to be `<<`). Hex strings contain no escapes and cannot be nested. */
function skipHexString(bytes: Uint8Array, pos: number): number {
  let i = pos + 1;
  while (i < bytes.length && bytes[i] !== CH_GREATER) i += 1;
  if (i >= bytes.length) throw new UnsupportedError("Nezavřený hex řetězec v obsahu stránky.");
  return i + 1;
}

/** `pos` must point AT the opening `[`. Recursively skips nested arrays/strings/dicts to find the true matching `]`. */
function skipArray(bytes: Uint8Array, pos: number): number {
  let i = pos + 1;
  while (i < bytes.length) {
    const byte = bytes[i];
    if (byte === CH_RBRACKET) return i + 1;
    if (byte === CH_LBRACKET) { i = skipArray(bytes, i); continue; }
    if (byte === CH_LPAREN) { i = skipLiteralString(bytes, i); continue; }
    if (byte === CH_LESS) {
      if (bytes[i + 1] === CH_LESS) { i = skipDict(bytes, i); continue; }
      i = skipHexString(bytes, i);
      continue;
    }
    i += 1;
  }
  throw new UnsupportedError("Neuzavřené pole v obsahu stránky.");
}

/** `pos` must point AT the first `<` of `<<`. Recursively skips nested values to find the matching `>>`. */
function skipDict(bytes: Uint8Array, pos: number): number {
  let i = pos + 2;
  while (i < bytes.length) {
    if (bytes[i] === CH_GREATER && bytes[i + 1] === CH_GREATER) return i + 2;
    if (bytes[i] === CH_LBRACKET) { i = skipArray(bytes, i); continue; }
    if (bytes[i] === CH_LPAREN) { i = skipLiteralString(bytes, i); continue; }
    if (bytes[i] === CH_LESS) {
      if (bytes[i + 1] === CH_LESS) { i = skipDict(bytes, i); continue; }
      i = skipHexString(bytes, i);
      continue;
    }
    i += 1;
  }
  throw new UnsupportedError("Neuzavřený slovník v obsahu stránky.");
}

function decodeName(bytes: Uint8Array, start: number, end: number): string {
  // start points at '/', end is one-past the last regular char. Decodes #XX escapes (spec: a Name
  // like "/MC#31" must compare equal to the resource key it references) — a plain best-effort ASCII
  // decode is sufficient here since this app only ever needs to compare these against its own
  // resource dictionary keys (never displays them to a user).
  let out = "";
  for (let i = start + 1; i < end; i += 1) {
    if (bytes[i] === CH_HASH && i + 2 < end) {
      const hex = String.fromCharCode(bytes[i + 1], bytes[i + 2]);
      const code = Number.parseInt(hex, 16);
      if (Number.isFinite(code)) { out += String.fromCharCode(code); i += 2; continue; }
    }
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

function decodeAscii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

/** Tokenizes one full content stream. Throws UnsupportedError for constructs this module refuses to guess about (an inline image `BI...EI` is handled specially by the caller's main loop, never reaches here as a generic token). */
function nextToken(bytes: Uint8Array, pos: number): Token | undefined {
  let i = pos;
  while (i < bytes.length) {
    const byte = bytes[i];
    if (isWhitespace(byte)) { i += 1; continue; }
    if (byte === CH_PERCENT) { while (i < bytes.length && bytes[i] !== CH_LF && bytes[i] !== CH_CR) i += 1; continue; }
    break;
  }
  if (i >= bytes.length) return undefined;
  const byte = bytes[i];

  if (byte === CH_SLASH) {
    let j = i + 1;
    while (j < bytes.length && isRegular(bytes[j])) j += 1;
    return { type: "name", start: i, end: j, text: decodeName(bytes, i, j) };
  }
  if (byte === CH_LPAREN) return { type: "string", start: i, end: skipLiteralString(bytes, i) };
  if (byte === CH_LESS) {
    if (bytes[i + 1] === CH_LESS) return { type: "dict", start: i, end: skipDict(bytes, i) };
    return { type: "hexstring", start: i, end: skipHexString(bytes, i) };
  }
  if (byte === CH_LBRACKET) return { type: "array", start: i, end: skipArray(bytes, i) };
  if (byte === CH_LBRACE || byte === CH_RBRACE) {
    throw new UnsupportedError("Obsah stránky obsahuje PostScript calculator funkci, kterou tento nástroj nepodporuje.");
  }
  if (byte === CH_RBRACKET || byte === CH_GREATER) {
    throw new UnsupportedError("Neočekávaný uzavírací znak v obsahu stránky (poškozený nebo nepodporovaný obsah).");
  }
  if (isDigit(byte) || byte === CH_PLUS || byte === CH_MINUS || byte === CH_DOT) {
    let j = i + 1;
    while (j < bytes.length && (isDigit(bytes[j]) || bytes[j] === CH_DOT || bytes[j] === CH_PLUS || bytes[j] === CH_MINUS)) j += 1;
    // A lone "+"/"-"/"." with nothing following is not actually a valid number — fall through to
    // treat it as an operator-like token instead of crashing; real content streams never do this,
    // this is purely a defensive fallback.
    if (j === i + 1 && !isDigit(byte)) {
      while (j < bytes.length && isRegular(bytes[j])) j += 1;
      return { type: "op", start: i, end: j, text: decodeAscii(bytes, i, j) };
    }
    return { type: "num", start: i, end: j };
  }

  let j = i + 1;
  while (j < bytes.length && isRegular(bytes[j])) j += 1;
  return { type: "op", start: i, end: j, text: decodeAscii(bytes, i, j) };
}

/** Finds the end of an inline image (`BI ... ID <binary> EI`) starting right after the `BI` operator token — the binary data between `ID` and `EI` must never be tokenized as operators (spec: never corrupt binary content). Uses the same whitespace-preceded-"EI" heuristic real PDF parsers use. Returns the index just past `EI`. */
function skipInlineImage(bytes: Uint8Array, afterBiEnd: number): number {
  let idEnd = afterBiEnd;
  // Scan forward for the `ID` operator that ends the image's own parameter dictionary.
  for (;;) {
    const token = nextToken(bytes, idEnd);
    if (!token) throw new UnsupportedError("Neuzavřený inline obrázek (chybí ID) v obsahu stránky.");
    idEnd = token.end;
    if (token.type === "op" && token.text === "ID") break;
  }
  // Exactly one whitespace byte separates `ID` from the raw binary data per spec.
  let i = idEnd + 1;
  while (i < bytes.length - 1) {
    if (isWhitespace(bytes[i]) && bytes[i + 1] === 69 /* 'E' */ && bytes[i + 2] === 73 /* 'I' */ && (i + 3 >= bytes.length || isWhitespace(bytes[i + 3]) || isDelimiter(bytes[i + 3]))) {
      return i + 3;
    }
    i += 1;
  }
  throw new UnsupportedError("Neuzavřený inline obrázek (chybí EI) v obsahu stránky.");
}

export type VectorWhiteModeOptions = Readonly<{
  /** Decoded (no leading "/") resource-dictionary key names, from the copied page's own `/Resources/Properties`, that all resolve to the SAME target Optional Content Group object — a `BDC` operator's `/OC <Name>` is a match when `<Name>` (decoded) is in this set. Empty means "the target layer could not be located in this page's own resources" — always `status: "unsupported"`, never silently a no-op. */
  targetOcPropertyNames: ReadonlySet<string>;
  /** 0-1, already clamped by the caller (see resolveWhiteFillColor's own doc for why this uses the exact same 0-1 fraction as the live editor's "Krytí bílé"). */
  opacityFraction: number;
  /** Resource-dictionary key (no leading "/") of an ExtGState already registered by the caller with `/ca` set to `opacityFraction` — required whenever `opacityFraction < 1`; ignored otherwise (no wrapping is emitted for full opacity, since `/ca 1` is the graphics-state default already). */
  extGStateName?: string;
}>;

export type VectorWhiteModeResult =
  | Readonly<{ status: "patched"; content: Uint8Array; whitenedFillCommandCount: number; wrappedSpanCount: number }>
  | Readonly<{ status: "unsupported"; reason: string }>;

const FILL_COLOR_OPS = new Set(["g", "rg", "k", "sc", "scn"]);
const FILL_PAINT_OPS = new Set(["f", "F", "f*", "B", "B*", "b", "b*"]);
const WHITE_FILL_REPLACEMENT = " 1 1 1 rg ";

type Edit = Readonly<{ offset: number; kind: "insert" | "replace"; end?: number; text: string }>;

/**
 * Runs the tokenizer/rewriter over one already-decoded (decompressed) content stream. Never throws
 * — every parse failure this module anticipates (`UnsupportedError`) is caught and reported as
 * `status: "unsupported"`; this is deliberately the ONLY exit path other than a clean `"patched"`
 * result, so a caller never needs a second try/catch around this function.
 */
export function computeVectorWhiteModeContentStream(content: Uint8Array, options: VectorWhiteModeOptions): VectorWhiteModeResult {
  if (options.targetOcPropertyNames.size === 0) {
    return { status: "unsupported", reason: "Vrstva stánků nebyla v obsahu stránky nalezena (chybí odpovídající BDC/OC značka)." };
  }
  const wrapOpacity = options.opacityFraction < 1;
  if (wrapOpacity && !options.extGStateName) {
    return { status: "unsupported", reason: "Interní chyba: pro krytí bílé menší než 100 % chybí registrovaný ExtGState." };
  }

  try {
    type StackFrame = Readonly<{ isTarget: boolean; bdcStart: number; bdcEnd: number }>;
    const stack: StackFrame[] = [];
    // How many ancestor frames (not just the immediate parent) are the target OCG — content nested
    // inside the target span for an UNRELATED reason (e.g. a "/Span BMC" text-tagging marked
    // content nested inside the stand layer's own "/OC BDC") must still count as "inside target":
    // a plain top-of-stack check would wrongly stop whitening the instant any non-OC marked content
    // is nested inside, even though the fill still visually belongs to the target OCG.
    let targetDepth = 0;
    let lastFillColorCommand: Readonly<{ start: number; end: number; isPattern: boolean }> | undefined;
    const fillPatchOffsets = new Set<number>();
    const edits: Edit[] = [];
    let wrappedSpanCount = 0;

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
      const insideTarget = targetDepth > 0;

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
    if (fillPatchOffsets.size === 0) {
      return { status: "unsupported", reason: "V cílové vrstvě nebyla nalezena žádná barevná výplň, kterou by šlo bezpečně přebarvit." };
    }

    edits.sort((a, b) => a.offset - b.offset);
    const pieces: Uint8Array[] = [];
    let cursor = 0;
    for (const edit of edits) {
      pieces.push(content.subarray(cursor, edit.offset));
      pieces.push(stringToBytes(edit.text));
      cursor = edit.kind === "replace" ? edit.end! : edit.offset;
    }
    pieces.push(content.subarray(cursor));
    const totalLength = pieces.reduce((sum, piece) => sum + piece.length, 0);
    const result = new Uint8Array(totalLength);
    let writeOffset = 0;
    for (const piece of pieces) { result.set(piece, writeOffset); writeOffset += piece.length; }

    return { status: "patched", content: result, whitenedFillCommandCount: fillPatchOffsets.size, wrappedSpanCount };
  } catch (error) {
    if (error instanceof UnsupportedError) return { status: "unsupported", reason: error.message };
    throw error;
  }
}

/** Re-scans from a known command start to pull out the Nth (0-based) operand token — used only for BDC's own two operands, which we already know exist by count (spec: never re-tokenize the whole stream just to inspect two small operands). */
function findOperandToken(content: Uint8Array, commandStart: number, operandIndex: number): Token | undefined {
  let pos = commandStart;
  let index = 0;
  for (;;) {
    const token = nextToken(content, pos);
    if (!token || token.type === "op") return undefined;
    if (index === operandIndex) return token;
    pos = token.end;
    index += 1;
  }
}

function stringToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  return bytes;
}
