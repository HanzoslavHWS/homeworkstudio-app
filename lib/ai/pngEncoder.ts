/**
 * Minimal RGBA -> PNG encoder using Node's built-in `zlib` for the DEFLATE step (no new
 * dependency — `node:zlib` is Node's standard library, not an npm package). Used only by
 * lib/ai/deterministicFakeAiProvider.ts to produce a real, valid, decodable image for the fake
 * provider's foundation-testing path (so "invalid image result is rejected" tests have a genuine
 * valid case to contrast against) — never imported by browser-bundled code, since it depends on
 * a Node built-in unavailable in that environment. Deliberately not `.server.ts` — it carries no
 * secret, the suffix in this codebase denotes credentials, not execution environment.
 */
import { deflateSync } from "node:zlib";

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from(type.split("").map((char) => char.charCodeAt(0)));
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(4 + body.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  out.set(body, 4);
  view.setUint32(4 + body.length, crc32(body), false);
  return out;
}

/** RGBA bytes (length === width*height*4) -> a real, valid, non-interlaced 8-bit PNG. */
export function encodeRgbaToPng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type 6 = RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Raw scanlines: each row prefixed with filter-type byte 0 (None).
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    raw.set(rgba.subarray(y * stride, y * stride + stride), rowStart + 1);
  }
  const idatData = deflateSync(Buffer.from(raw));

  const parts = [PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(idatData)), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

export function pngBytesToDataUrl(pngBytes: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(pngBytes).toString("base64")}`;
}
