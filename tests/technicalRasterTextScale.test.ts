import assert from "node:assert/strict";
import test from "node:test";
import { computeTextScaleContentStream } from "../domain/technicalRasterTextScale.ts";

// =========================================================================================
// Technické rastry — PRODUCTION BATCH, PART A: the EXPORT-side per-source-OCG-layer text-scale
// content-stream rewriter. Same hand-written-content-stream testing discipline as
// tests/technicalRasterVectorWhiteMode.test.ts (the sibling transform this module shares its
// tokenizer with) — these streams mirror the real shape found in the real H1/H3 fixtures (one
// BDC/OC span per layer, `/F1 <size> Tf` immediately before each text run).
// =========================================================================================

function bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i);
  return out;
}

function text(content: Uint8Array): string {
  let out = "";
  for (const byte of content) out += String.fromCharCode(byte);
  return out;
}

const TARGET = new Set(["MC0"]);

test("default/100%: scale=1 still 'patches' (a harmless no-op numerically) — every Tf size is rewritten to the SAME value", () => {
  const stream = bytes("/OC /MC0 BDC\nBT /F1 12 Tf (Stand 1) Tj ET\nEMC\n");
  const result = computeTextScaleContentStream(stream, { targetOcPropertyNames: TARGET, scale: 1 });
  assert.equal(result.status, "patched");
  if (result.status !== "patched") return;
  assert.match(text(result.content), /\/F1 12 Tf/);
  assert.equal(result.scaledFontSizeCount, 1);
});

test("80% scales every Tf size inside the target OCG proportionally", () => {
  const stream = bytes("/OC /MC0 BDC\nBT /F1 12 Tf (A) Tj ET\nBT /F1 8 Tf (B) Tj ET\nEMC\n");
  const result = computeTextScaleContentStream(stream, { targetOcPropertyNames: TARGET, scale: 0.8 });
  assert.equal(result.status, "patched");
  if (result.status !== "patched") return;
  const out = text(result.content);
  assert.match(out, /\/F1 9\.6 Tf/, "12 * 0.8 = 9.6");
  assert.match(out, /\/F1 6\.4 Tf/, "8 * 0.8 = 6.4");
  assert.equal(result.scaledFontSizeCount, 2);
});

test("multiple font sizes (6pt/8pt/12pt) at 75% retain their relative differences — a plain multiplier, never one fixed replacement value", () => {
  const stream = bytes("/OC /MC0 BDC\n/F1 6 Tf /F1 8 Tf /F1 12 Tf\nEMC\n");
  const result = computeTextScaleContentStream(stream, { targetOcPropertyNames: TARGET, scale: 0.75 });
  assert.equal(result.status, "patched");
  if (result.status !== "patched") return;
  const out = text(result.content);
  assert.match(out, /\/F1 4\.5 Tf/);
  assert.match(out, /\/F1 6 Tf/);
  assert.match(out, /\/F1 9 Tf/);
});

test("non-target OCG text is completely unchanged", () => {
  const stream = bytes("/F1 20 Tf\n/OC /MC0 BDC\n/F1 12 Tf\nEMC\n");
  const result = computeTextScaleContentStream(stream, { targetOcPropertyNames: TARGET, scale: 0.5 });
  assert.equal(result.status, "patched");
  if (result.status !== "patched") return;
  const out = text(result.content);
  assert.match(out, /\/F1 20 Tf/, "the OUTSIDE-target Tf must survive byte-for-byte");
  assert.match(out, /\/F1 6 Tf/, "12 * 0.5 = 6, only the INSIDE-target one is scaled");
});

test("only the size operand changes — the font NAME operand is never touched", () => {
  const stream = bytes("/OC /MC0 BDC\n/CustomFontName123 12 Tf\nEMC\n");
  const result = computeTextScaleContentStream(stream, { targetOcPropertyNames: TARGET, scale: 0.5 });
  assert.equal(result.status, "patched");
  if (result.status !== "patched") return;
  assert.match(text(result.content), /\/CustomFontName123 6 Tf/);
});

test("geometry/fill/stroke/transform operators inside the target OCG are never scaled — only Tf", () => {
  const stream = bytes("/OC /MC0 BDC\n1 0 0 rg 0 0 1 RG 2 w 10 10 50 50 re f 1 0 0 1 5 5 cm /F1 10 Tf\nEMC\n");
  const result = computeTextScaleContentStream(stream, { targetOcPropertyNames: TARGET, scale: 0.5 });
  assert.equal(result.status, "patched");
  if (result.status !== "patched") return;
  const out = text(result.content);
  assert.match(out, /1 0 0 rg/);
  assert.match(out, /0 0 1 RG/);
  assert.match(out, /2 w/);
  assert.match(out, /10 10 50 50 re f/);
  assert.match(out, /1 0 0 1 5 5 cm/);
  assert.match(out, /\/F1 5 Tf/, "only the Tf size is scaled — 10 * 0.5 = 5");
});

test("Tm/Td text-positioning operators are never touched — the text ANCHOR/origin stays exactly where the source PDF put it", () => {
  const stream = bytes("/OC /MC0 BDC\nBT 1 0 0 1 100 200 Tm 5 5 Td /F1 12 Tf (X) Tj ET\nEMC\n");
  const result = computeTextScaleContentStream(stream, { targetOcPropertyNames: TARGET, scale: 0.7 });
  assert.equal(result.status, "patched");
  if (result.status !== "patched") return;
  const out = text(result.content);
  assert.match(out, /1 0 0 1 100 200 Tm/, "Tm byte-for-byte unchanged");
  assert.match(out, /5 5 Td/, "Td byte-for-byte unchanged");
  assert.match(out, /\/F1 8\.4 Tf/, "only the font size shrinks — 12 * 0.7 = 8.4");
});

test("nested, unrelated marked-content span inside the target OCG (e.g. accessibility tagging) is still considered inside target", () => {
  const stream = bytes("/OC /MC0 BDC\n/Span BMC\n/F1 10 Tf\nEMC\nEMC\n");
  const result = computeTextScaleContentStream(stream, { targetOcPropertyNames: TARGET, scale: 0.5 });
  assert.equal(result.status, "patched");
  if (result.status !== "patched") return;
  assert.match(text(result.content), /\/F1 5 Tf/);
});

test("a Do (Form XObject invocation) inside the target scope is reported unsupported, never silently skipped", () => {
  const stream = bytes("/OC /MC0 BDC\n/Fm1 Do\nEMC\n");
  const result = computeTextScaleContentStream(stream, { targetOcPropertyNames: TARGET, scale: 0.5 });
  assert.equal(result.status, "unsupported");
});

test("a Do OUTSIDE the target scope never blocks the transform", () => {
  const stream = bytes("/Fm1 Do\n/OC /MC0 BDC\n/F1 10 Tf\nEMC\n");
  const result = computeTextScaleContentStream(stream, { targetOcPropertyNames: TARGET, scale: 0.5 });
  assert.equal(result.status, "patched");
  if (result.status !== "patched") return;
  assert.match(text(result.content), /\/F1 5 Tf/);
});

test("an empty target property name set is always unsupported — the chosen layer wasn't found in this page's content", () => {
  const stream = bytes("/OC /MC0 BDC\n/F1 10 Tf\nEMC\n");
  const result = computeTextScaleContentStream(stream, { targetOcPropertyNames: new Set(), scale: 0.5 });
  assert.equal(result.status, "unsupported");
});

test("unbalanced BDC/EMC is reported unsupported, never crashes", () => {
  const stream = bytes("/OC /MC0 BDC\n/F1 10 Tf\n");
  const result = computeTextScaleContentStream(stream, { targetOcPropertyNames: TARGET, scale: 0.5 });
  assert.equal(result.status, "unsupported");
});

test("zero Tf calls inside the target scope is still 'patched' with scaledFontSizeCount 0 — a harmless no-op, never an error", () => {
  const stream = bytes("/OC /MC0 BDC\n1 0 0 rg 0 0 10 10 re f\nEMC\n");
  const result = computeTextScaleContentStream(stream, { targetOcPropertyNames: TARGET, scale: 0.5 });
  assert.equal(result.status, "patched");
  if (result.status !== "patched") return;
  assert.equal(result.scaledFontSizeCount, 0);
  assert.match(text(result.content), /1 0 0 rg 0 0 10 10 re f/, "geometry stays completely untouched");
});

test("an inline image inside the target scope never blocks or corrupts the transform (never confused with Tf/Do)", () => {
  const stream = bytes("/OC /MC0 BDC\n/F1 10 Tf\nBI /W 1 /H 1 /BPC 8 ID \x00 EI\n/F1 6 Tf\nEMC\n");
  const result = computeTextScaleContentStream(stream, { targetOcPropertyNames: TARGET, scale: 0.5 });
  assert.equal(result.status, "patched");
  if (result.status !== "patched") return;
  const out = text(result.content);
  assert.match(out, /\/F1 5 Tf/);
  assert.match(out, /\/F1 3 Tf/);
});
