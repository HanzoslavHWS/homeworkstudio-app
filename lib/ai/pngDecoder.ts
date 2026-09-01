/**
 * Visualization v3.3 — minimal PNG -> RGBA decoder, the read-side counterpart to
 * lib/ai/pngEncoder.ts's RGBA -> PNG encoder. Needed because building the OpenAI edit mask
 * (report section "Mask") requires per-pixel access to the already-captured Protected Mask PNG
 * (ControlPassBundle.protectedMaskDataUrl / VisualizationAiGenerateInput.protectedMaskDataUrl) —
 * there is no image-decoding library anywhere in this repo's dependencies, and Node has no
 * built-in image codec, so this exists rather than adding a new npm dependency for one call site.
 *
 * Deliberately NOT `.server.ts` — same reasoning as pngEncoder.ts: the suffix denotes credentials
 * in this codebase, and this file carries none (it depends on `node:zlib`, a Node built-in, which
 * is why it's still Node-only/never imported by browser-bundled code).
 *
 * Scope is intentionally narrow — only what a browser's own `canvas.toDataURL("image/png")` /
 * `toBlob` output ever actually produces: 8-bit depth, non-interlaced, color type 2 (RGB) or 6
 * (RGBA). Anything else (16-bit, palette, grayscale, interlaced) is rejected with a clear error
 * rather than silently decoded wrong — this is not a general-purpose PNG library.
 */
import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

export type DecodedPng = Readonly<{ width: number; height: number; rgba: Uint8Array }>;

export class PngDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PngDecodeError";
  }
}

function checkSignature(bytes: Uint8Array): void {
  if (bytes.length < 8 || !PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    throw new PngDecodeError("Not a PNG file (bad signature).");
  }
}

export function dataUrlToPngBytes(dataUrl: string): Uint8Array {
  const match = /^data:image\/(?:png|x-png);base64,([\s\S]+)$/u.exec(dataUrl);
  if (!match) throw new PngDecodeError("Not a base64 PNG data URL.");
  return new Uint8Array(Buffer.from(match[1]!, "base64"));
}

/** Reads just width/height from the IHDR chunk — no zlib inflate needed. Cheap validation/sizing when the caller doesn't need pixel data (e.g. the beauty image, which is forwarded to OpenAI byte-for-byte, untouched). */
export function readPngDimensions(bytes: Uint8Array): Readonly<{ width: number; height: number }> {
  checkSignature(bytes);
  if (bytes.length < 8 + 8 + 13) throw new PngDecodeError("PNG too short to contain an IHDR chunk.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ihdrType = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
  if (ihdrType !== "IHDR") throw new PngDecodeError("First PNG chunk is not IHDR.");
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width <= 0 || height <= 0) throw new PngDecodeError("PNG reports non-positive dimensions.");
  return { width, height };
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Undoes PNG's per-scanline filtering (spec section 9) — all 5 filter types, since a browser's own PNG encoder chooses adaptively per row, never just "None". */
function unfilter(rawWithFilterBytes: Uint8Array, width: number, height: number, bytesPerPixel: number): Uint8Array {
  const stride = width * bytesPerPixel;
  const out = new Uint8Array(height * stride);
  let inputOffset = 0;
  for (let y = 0; y < height; y++) {
    const filterType = rawWithFilterBytes[inputOffset]!;
    inputOffset += 1;
    const rowOut = y * stride;
    const prevRowOut = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const raw = rawWithFilterBytes[inputOffset + x]!;
      const a = x >= bytesPerPixel ? out[rowOut + x - bytesPerPixel]! : 0;
      const b = y > 0 ? out[prevRowOut + x]! : 0;
      const c = y > 0 && x >= bytesPerPixel ? out[prevRowOut + x - bytesPerPixel]! : 0;
      let value: number;
      switch (filterType) {
        case 0: value = raw; break;
        case 1: value = raw + a; break;
        case 2: value = raw + b; break;
        case 3: value = raw + Math.floor((a + b) / 2); break;
        case 4: value = raw + paethPredictor(a, b, c); break;
        default: throw new PngDecodeError(`Unsupported PNG filter type ${filterType}.`);
      }
      out[rowOut + x] = value & 0xff;
    }
    inputOffset += stride;
  }
  return out;
}

/** Full decode (zlib inflate + unfilter) to straight RGBA bytes. */
export function decodePngToRgba(bytes: Uint8Array): DecodedPng {
  checkSignature(bytes);

  let width = 0, height = 0, bitDepth = 0, colorType = -1, interlaceMethod = 0;
  let sawIhdr = false;
  const idatParts: Uint8Array[] = [];

  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = view.getUint32(offset, false);
    const type = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!);
    const dataStart = offset + 8;
    if (dataStart + length > bytes.length) throw new PngDecodeError("Truncated PNG chunk.");
    const data = bytes.subarray(dataStart, dataStart + length);

    if (type === "IHDR") {
      const chunkView = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = chunkView.getUint32(0, false);
      height = chunkView.getUint32(4, false);
      bitDepth = data[8]!;
      colorType = data[9]!;
      interlaceMethod = data[12]!;
      sawIhdr = true;
    } else if (type === "IDAT") {
      idatParts.push(data);
    } else if (type === "IEND") {
      break;
    }

    offset = dataStart + length + 4; // skip the trailing CRC
  }

  if (!sawIhdr) throw new PngDecodeError("PNG is missing an IHDR chunk.");
  if (bitDepth !== 8) throw new PngDecodeError(`Unsupported PNG bit depth ${bitDepth} (only 8-bit is supported).`);
  if (colorType !== 2 && colorType !== 6) throw new PngDecodeError(`Unsupported PNG color type ${colorType} (only RGB/RGBA are supported).`);
  if (interlaceMethod !== 0) throw new PngDecodeError("Interlaced PNGs are not supported.");
  if (idatParts.length === 0) throw new PngDecodeError("PNG has no IDAT data.");
  if (width <= 0 || height <= 0) throw new PngDecodeError("PNG reports non-positive dimensions.");

  const totalIdatLength = idatParts.reduce((sum, part) => sum + part.length, 0);
  const compressed = new Uint8Array(totalIdatLength);
  let idatOffset = 0;
  for (const part of idatParts) { compressed.set(part, idatOffset); idatOffset += part.length; }

  const inflated = new Uint8Array(inflateSync(Buffer.from(compressed)));

  const sourceBpp = colorType === 6 ? 4 : 3;
  const expectedLength = height * (1 + width * sourceBpp);
  if (inflated.length < expectedLength) throw new PngDecodeError("PNG pixel data is shorter than expected.");

  const unfiltered = unfilter(inflated, width, height, sourceBpp);

  if (colorType === 6) return { width, height, rgba: unfiltered };

  // colorType === 2 (RGB, no alpha) — expand to RGBA with alpha=255 (opaque), matching this
  // module's PixelBuffer/RGBA-everywhere convention used throughout domain/visualization*.ts.
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = unfiltered[i * 3]!;
    rgba[i * 4 + 1] = unfiltered[i * 3 + 1]!;
    rgba[i * 4 + 2] = unfiltered[i * 3 + 2]!;
    rgba[i * 4 + 3] = 255;
  }
  return { width, height, rgba };
}

export function decodePngDataUrlToRgba(dataUrl: string): DecodedPng {
  return decodePngToRgba(dataUrlToPngBytes(dataUrl));
}
