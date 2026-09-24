/**
 * Technické rastry — the shared, dependency-free PDF content-stream OPERATOR TOKENIZER behind both
 * domain/technicalRasterVectorWhiteMode.ts ("Pracovní — bílé" export fill-color rewriting) and
 * domain/technicalRasterTextScale.ts (per-source-OCG text-size reduction export, PRODUCTION BATCH
 * part A). Extracted verbatim (byte-for-byte identical algorithm — this is a pure move, not a
 * rewrite) from technicalRasterVectorWhiteMode.ts's own original private implementation, per spec's
 * own explicit instruction to "reuse existing PDF operator/tokenizer infrastructure where possible…
 * do NOT build a completely separate PDF parser if an existing safe mechanism can be extended."
 *
 * Pure bytes in, pure bytes out, zero pdf-lib/pdfjs-dist imports — directly unit-testable with small
 * hand-built content streams (see tests/pdfContentStreamTokenizer.test.ts and the existing
 * tests/technicalRasterVectorWhiteMode.test.ts, both still passing against the SAME code, now
 * imported rather than duplicated).
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

export type TokenType = "num" | "name" | "string" | "hexstring" | "array" | "dict" | "op";

export type Token = Readonly<{ type: TokenType; start: number; end: number; text?: string }>;

export class UnsupportedError extends Error {}

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

export function decodeName(bytes: Uint8Array, start: number, end: number): string {
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

export function decodeAscii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

/** Tokenizes one full content stream. Throws UnsupportedError for constructs this module refuses to guess about (an inline image `BI...EI` is handled specially by the caller's main loop, never reaches here as a generic token). */
export function nextToken(bytes: Uint8Array, pos: number): Token | undefined {
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
export function skipInlineImage(bytes: Uint8Array, afterBiEnd: number): number {
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

/** Re-scans from a known command start to pull out the Nth (0-based) operand token — used for a multi-operand operator's own operands, which the caller already knows exist by count (spec: never re-tokenize the whole stream just to inspect a couple of small operands). */
export function findOperandToken(content: Uint8Array, commandStart: number, operandIndex: number): Token | undefined {
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

export function stringToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  return bytes;
}

/** One rewrite instruction against the ORIGINAL byte offsets — never against an already-edited buffer (spec: edits are always planned against the pristine input, then applied in one pass by `applyContentStreamEdits`). */
export type ContentStreamEdit = Readonly<{ offset: number; kind: "insert" | "replace"; end?: number; text: string }>;

/**
 * Applies a set of edits (each a byte-range replace, or a zero-width insert) to `content` in ONE
 * pass, producing a brand-new buffer — `content` itself is never mutated. Shared by both
 * domain/technicalRasterVectorWhiteMode.ts and domain/technicalRasterTextScale.ts so the exact same
 * "insert-before-replace-at-the-same-offset" tie-break (needed when e.g. a whole-form wrap inserted
 * at offset 0 collides with a replace that also starts at offset 0) is never re-implemented slightly
 * differently in two places.
 */
export function applyContentStreamEdits(content: Uint8Array, edits: readonly ContentStreamEdit[]): Uint8Array {
  const sorted = [...edits].sort((a, b) => a.offset - b.offset || (a.kind === "insert" ? -1 : b.kind === "insert" ? 1 : 0));
  const pieces: Uint8Array[] = [];
  let cursor = 0;
  for (const edit of sorted) {
    pieces.push(content.subarray(cursor, edit.offset));
    pieces.push(stringToBytes(edit.text));
    cursor = edit.kind === "replace" ? edit.end! : edit.offset;
  }
  pieces.push(content.subarray(cursor));
  const totalLength = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const result = new Uint8Array(totalLength);
  let writeOffset = 0;
  for (const piece of pieces) { result.set(piece, writeOffset); writeOffset += piece.length; }
  return result;
}
