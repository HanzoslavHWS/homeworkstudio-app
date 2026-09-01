import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { encodeRgbaToPng, pngBytesToDataUrl } from "../lib/ai/pngEncoder.ts";
import {
  dataUrlToPngBytes,
  decodePngDataUrlToRgba,
  decodePngToRgba,
  PngDecodeError,
  readPngDimensions,
} from "../lib/ai/pngDecoder.ts";

// =========================================================================================
// Visualization v3.3 — lib/ai/pngDecoder.ts, the read-side counterpart to lib/ai/pngEncoder.ts.
// Needed to build the OpenAI edit mask from the already-captured Protected Mask PNG server-side.
// =========================================================================================

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from(type.split("").map((char) => char.charCodeAt(0)));
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  // CRC correctness doesn't matter — the decoder under test never verifies it (documented scope:
  // a minimal decoder, not a spec-compliance checker) — length/type/data framing is what matters.
  const out = new Uint8Array(4 + body.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  out.set(body, 4);
  return out;
}

/** Test-only PNG builder that can apply a SPECIFIC filter type per row (unlike pngEncoder.ts, which always emits filter 0) — needed to exercise the decoder's Sub/Up/Average/Paeth unfiltering paths, which a round-trip through encodeRgbaToPng alone can never reach. */
function buildPngWithFilters(
  width: number,
  height: number,
  rgba: Uint8Array,
  colorType: 2 | 6,
  filterTypePerRow: readonly number[],
): Uint8Array {
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const straight = new Uint8Array(height * stride);
  for (let i = 0; i < width * height; i++) {
    if (colorType === 6) {
      straight.set(rgba.subarray(i * 4, i * 4 + 4), i * bpp);
    } else {
      straight[i * bpp] = rgba[i * 4]!;
      straight[i * bpp + 1] = rgba[i * 4 + 1]!;
      straight[i * bpp + 2] = rgba[i * 4 + 2]!;
    }
  }

  const filtered = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const filterType = filterTypePerRow[y] ?? 0;
    const rowOut = y * (stride + 1);
    filtered[rowOut] = filterType;
    for (let x = 0; x < stride; x++) {
      const raw = straight[y * stride + x]!;
      const a = x >= bpp ? straight[y * stride + x - bpp]! : 0;
      const b = y > 0 ? straight[(y - 1) * stride + x]! : 0;
      const c = y > 0 && x >= bpp ? straight[(y - 1) * stride + x - bpp]! : 0;
      let value: number;
      switch (filterType) {
        case 0: value = raw; break;
        case 1: value = raw - a; break;
        case 2: value = raw - b; break;
        case 3: value = raw - Math.floor((a + b) / 2); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          value = raw - predictor;
          break;
        }
        default: throw new Error("unsupported test filter type");
      }
      filtered[rowOut + 1 + x] = value & 0xff;
    }
  }

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const idat = new Uint8Array(deflateSync(Buffer.from(filtered)));
  const parts = [Uint8Array.from(PNG_SIGNATURE), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function solidRgba(width: number, height: number, r: number, g: number, b: number, a: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = a;
  }
  return data;
}

test("ROUND TRIP via encodeRgbaToPng (filter type 0/None, color type 6/RGBA): decodePngToRgba recovers the exact original bytes", () => {
  const width = 5, height = 3;
  const original = new Uint8Array(width * height * 4);
  for (let i = 0; i < original.length; i++) original[i] = (i * 37) % 256;
  const png = encodeRgbaToPng(width, height, original);
  const decoded = decodePngToRgba(png);
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.deepEqual(decoded.rgba, original);
});

test("ROUND TRIP via data URL: decodePngDataUrlToRgba(pngBytesToDataUrl(...)) matches decodePngToRgba directly", () => {
  const rgba = solidRgba(4, 2, 10, 20, 30, 200);
  const dataUrl = pngBytesToDataUrl(encodeRgbaToPng(4, 2, rgba));
  const viaDataUrl = decodePngDataUrlToRgba(dataUrl);
  const viaBytes = decodePngToRgba(dataUrlToPngBytes(dataUrl));
  assert.deepEqual(viaDataUrl, viaBytes);
  assert.deepEqual(viaDataUrl.rgba, rgba);
});

test("UNFILTER — Sub (type 1), color type RGBA: recovers exact pixels on a non-trivial gradient", () => {
  const width = 6, height = 4;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      rgba[offset] = (x * 40) % 256; rgba[offset + 1] = (y * 60) % 256; rgba[offset + 2] = (x + y) * 10 % 256; rgba[offset + 3] = 255;
    }
  }
  const png = buildPngWithFilters(width, height, rgba, 6, new Array(height).fill(1));
  const decoded = decodePngToRgba(png);
  assert.deepEqual(decoded.rgba, rgba);
});

test("UNFILTER — Up (type 2), color type RGBA", () => {
  const width = 4, height = 5;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = (i * 13) % 256; rgba[i * 4 + 1] = (i * 29) % 256; rgba[i * 4 + 2] = (i * 53) % 256; rgba[i * 4 + 3] = 255 - (i % 200);
  }
  const png = buildPngWithFilters(width, height, rgba, 6, new Array(height).fill(2));
  const decoded = decodePngToRgba(png);
  assert.deepEqual(decoded.rgba, rgba);
});

test("UNFILTER — Average (type 3), color type RGBA", () => {
  const width = 5, height = 5;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = (i * 7) % 256; rgba[i * 4 + 1] = (i * 17) % 256; rgba[i * 4 + 2] = (i * 23) % 256; rgba[i * 4 + 3] = 255;
  }
  const png = buildPngWithFilters(width, height, rgba, 6, new Array(height).fill(3));
  const decoded = decodePngToRgba(png);
  assert.deepEqual(decoded.rgba, rgba);
});

test("UNFILTER — Paeth (type 4), color type RGBA", () => {
  const width = 6, height = 6;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = (i * 3) % 256; rgba[i * 4 + 1] = (i * 41) % 256; rgba[i * 4 + 2] = (255 - i) % 256; rgba[i * 4 + 3] = 255;
  }
  const png = buildPngWithFilters(width, height, rgba, 6, new Array(height).fill(4));
  const decoded = decodePngToRgba(png);
  assert.deepEqual(decoded.rgba, rgba);
});

test("UNFILTER — mixed filter types per row (the realistic adaptive-encoder case), color type RGBA", () => {
  const width = 8, height = 6;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = (i * 11) % 256; rgba[i * 4 + 1] = (i * 19) % 256; rgba[i * 4 + 2] = (i * 31) % 256; rgba[i * 4 + 3] = (i * 5) % 256;
  }
  const png = buildPngWithFilters(width, height, rgba, 6, [0, 1, 2, 3, 4, 1]);
  const decoded = decodePngToRgba(png);
  assert.deepEqual(decoded.rgba, rgba);
});

test("COLOR TYPE 2 (RGB, no alpha): decodes with alpha synthesized as 255 for every pixel", () => {
  const width = 3, height = 3;
  const rgba = solidRgba(width, height, 12, 34, 56, 255); // alpha ignored on encode for colorType 2
  const png = buildPngWithFilters(width, height, rgba, 2, [0, 2, 4]);
  const decoded = decodePngToRgba(png);
  for (let i = 0; i < width * height; i++) {
    assert.equal(decoded.rgba[i * 4], 12);
    assert.equal(decoded.rgba[i * 4 + 1], 34);
    assert.equal(decoded.rgba[i * 4 + 2], 56);
    assert.equal(decoded.rgba[i * 4 + 3], 255);
  }
});

test("readPngDimensions: reads width/height without needing to inflate/unfilter pixel data", () => {
  const png = encodeRgbaToPng(37, 21, solidRgba(37, 21, 1, 2, 3, 4));
  assert.deepEqual(readPngDimensions(png), { width: 37, height: 21 });
});

test("readPngDimensions and decodePngToRgba agree on dimensions for the same file", () => {
  const png = encodeRgbaToPng(9, 4, solidRgba(9, 4, 5, 6, 7, 8));
  const dims = readPngDimensions(png);
  const decoded = decodePngToRgba(png);
  assert.equal(dims.width, decoded.width);
  assert.equal(dims.height, decoded.height);
});

test("REJECTS bad signature", () => {
  assert.throws(() => readPngDimensions(new Uint8Array([1, 2, 3, 4])), PngDecodeError);
  assert.throws(() => decodePngToRgba(new Uint8Array([1, 2, 3, 4])), PngDecodeError);
});

test("REJECTS unsupported bit depth", () => {
  const png = encodeRgbaToPng(2, 2, solidRgba(2, 2, 0, 0, 0, 255));
  const corrupted = Uint8Array.from(png);
  corrupted[24] = 16; // IHDR bit-depth byte
  assert.throws(() => decodePngToRgba(corrupted), PngDecodeError);
});

test("REJECTS unsupported color type", () => {
  const png = encodeRgbaToPng(2, 2, solidRgba(2, 2, 0, 0, 0, 255));
  const corrupted = Uint8Array.from(png);
  corrupted[25] = 3; // IHDR color-type byte -> palette (unsupported)
  assert.throws(() => decodePngToRgba(corrupted), PngDecodeError);
});

test("dataUrlToPngBytes rejects a non-PNG data URL", () => {
  assert.throws(() => dataUrlToPngBytes("data:image/jpeg;base64,AA=="), PngDecodeError);
  assert.throws(() => dataUrlToPngBytes("not-a-data-url"), PngDecodeError);
});

test("DOES NOT MUTATE the input bytes", () => {
  const png = encodeRgbaToPng(4, 4, solidRgba(4, 4, 9, 8, 7, 6));
  const snapshot = Uint8Array.from(png);
  decodePngToRgba(png);
  assert.deepEqual(png, snapshot);
});
