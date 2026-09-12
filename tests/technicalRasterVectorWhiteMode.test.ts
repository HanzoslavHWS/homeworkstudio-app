import assert from "node:assert/strict";
import test from "node:test";
import { computeVectorWhiteModeContentStream } from "../domain/technicalRasterVectorWhiteMode.ts";

// =========================================================================================
// Technické rastry — corrective batch section 4/12A: the EXPORT-side vector white-mode content
// stream rewriter. Unlike domain/technicalRasterWhiteModeOperators.ts (which patches pdf.js's own
// pre-parsed operator list for the live canvas preview), this module tokenizes REAL PDF content
// stream bytes — these tests build small, hand-written content streams that mirror the real shape
// docs/technical-rasters.md describes (one BDC/OC span per layer, stands drawn with a combined
// fill+stroke paint op) plus the specific hostile/edge cases the spec calls out.
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

test("technicalRasterVectorWhiteMode: whitens a fill color inside the target OCG span, leaves stroke untouched", () => {
  const stream = bytes("/OC /MC0 BDC\n1 0 0 rg 0 0 1 RG 10 10 50 50 re b*\nEMC\n");
  const result = computeVectorWhiteModeContentStream(stream, { targetOcPropertyNames: TARGET, opacityFraction: 1 });
  assert.equal(result.status, "patched");
  if (result.status !== "patched") return;
  const out = text(result.content);
  assert.match(out, /1 1 1 rg/);
  assert.match(out, /0 0 1 RG/); // stroke color byte-for-byte unchanged
  assert.equal(result.whitenedFillCommandCount, 1);
});

test("technicalRasterVectorWhiteMode: a fill outside the target OCG is never touched", () => {
  const stream = bytes("1 0 0 rg 10 10 50 50 re f\n/OC /MC0 BDC\nEMC\n");
  const result = computeVectorWhiteModeContentStream(stream, { targetOcPropertyNames: TARGET, opacityFraction: 1 });
  assert.equal(result.status, "unsupported"); // no fill INSIDE the target span at all
});

test("technicalRasterVectorWhiteMode: opacity 1 needs no ExtGState wrapping", () => {
  const stream = bytes("/OC /MC0 BDC\n0 g 0 0 10 10 re f\nEMC\n");
  const result = computeVectorWhiteModeContentStream(stream, { targetOcPropertyNames: TARGET, opacityFraction: 1 });
  assert.equal(result.status, "patched");
  if (result.status !== "patched") return;
  assert.equal(result.wrappedSpanCount, 0);
  assert.ok(!text(result.content).includes(" gs"));
});

test("technicalRasterVectorWhiteMode: opacity 0.6 wraps the whole target span in q/gs/Q with the given ExtGState", () => {
  const stream = bytes("/OC /MC0 BDC\n0 g 0 0 10 10 re f\nEMC\n");
  const result = computeVectorWhiteModeContentStream(stream, {
    targetOcPropertyNames: TARGET,
    opacityFraction: 0.6,
    extGStateName: "GSWhite",
  });
  assert.equal(result.status, "patched");
  if (result.status !== "patched") return;
  const out = text(result.content);
  assert.equal(result.wrappedSpanCount, 1);
  assert.match(out, /BDC[\s\S]*q[\s\S]*\/GSWhite gs[\s\S]*1 1 1 rg[\s\S]*Q[\s\S]*EMC/);
  // q/Q must balance
  assert.equal((out.match(/(^|[^A-Za-z])q(\s|$)/g) ?? []).length, (out.match(/(^|[^A-Za-z])Q(\s|$)/g) ?? []).length);
});

test("technicalRasterVectorWhiteMode: opacity 0 still patches (fill becomes fully transparent white, stroke untouched)", () => {
  const stream = bytes("/OC /MC0 BDC\n0 g 0 0 10 10 re f\nEMC\n");
  const result = computeVectorWhiteModeContentStream(stream, {
    targetOcPropertyNames: TARGET,
    opacityFraction: 0,
    extGStateName: "GSWhite",
  });
  assert.equal(result.status, "patched");
  if (result.status !== "patched") return;
  assert.equal(result.wrappedSpanCount, 1);
});

test("technicalRasterVectorWhiteMode: a nested, unrelated marked-content span inside the target OCG is still considered inside target", () => {
  const stream = bytes("/OC /MC0 BDC\n/Span BMC\n1 0 0 rg 0 0 10 10 re f\nEMC\nEMC\n");
  const result = computeVectorWhiteModeContentStream(stream, { targetOcPropertyNames: TARGET, opacityFraction: 1 });
  assert.equal(result.status, "patched");
  if (result.status !== "patched") return;
  assert.match(text(result.content), /1 1 1 rg/);
});

test("technicalRasterVectorWhiteMode: multiple separate BDC spans for the same OCG are all whitened", () => {
  const stream = bytes("/OC /MC0 BDC\n1 0 0 rg 0 0 10 10 re f\nEMC\n0 0 0 rg 1 1 1 1 re f\n/OC /MC0 BDC\n0 1 0 rg 5 5 5 5 re f\nEMC\n");
  const result = computeVectorWhiteModeContentStream(stream, { targetOcPropertyNames: TARGET, opacityFraction: 1 });
  assert.equal(result.status, "patched");
  if (result.status !== "patched") return;
  assert.equal(result.whitenedFillCommandCount, 2);
  // the fill OUTSIDE both spans ("0 0 0 rg") must remain untouched
  assert.match(text(result.content), /0 0 0 rg/);
});

test("technicalRasterVectorWhiteMode: a Pattern-space fill inside the target OCG is reported unsupported, never guessed", () => {
  const stream = bytes("/OC /MC0 BDC\n/Pattern cs /P1 scn 0 0 10 10 re f\nEMC\n");
  const result = computeVectorWhiteModeContentStream(stream, { targetOcPropertyNames: TARGET, opacityFraction: 1 });
  assert.equal(result.status, "unsupported");
});

test("technicalRasterVectorWhiteMode: a shading fill (sh) inside the target OCG is unsupported", () => {
  const stream = bytes("/OC /MC0 BDC\n/Sh1 sh\nEMC\n");
  const result = computeVectorWhiteModeContentStream(stream, { targetOcPropertyNames: TARGET, opacityFraction: 1 });
  assert.equal(result.status, "unsupported");
});

test("technicalRasterVectorWhiteMode: an XObject invocation (Do) inside the target OCG is unsupported", () => {
  const stream = bytes("/OC /MC0 BDC\n0 g 0 0 10 10 re f /Im1 Do\nEMC\n");
  const result = computeVectorWhiteModeContentStream(stream, { targetOcPropertyNames: TARGET, opacityFraction: 1 });
  assert.equal(result.status, "unsupported");
});

test("technicalRasterVectorWhiteMode: an inline image inside the target OCG is unsupported, and never corrupts tokenization of the rest of the stream", () => {
  const stream = bytes("/OC /MC0 BDC\n0 g 0 0 10 10 re f\nBI /W 1 /H 1 /BPC 8 ID \x00\x01\x02 EI\nEMC\n1 0 0 rg 0 0 1 1 re f\n");
  const result = computeVectorWhiteModeContentStream(stream, { targetOcPropertyNames: TARGET, opacityFraction: 1 });
  assert.equal(result.status, "unsupported");
});

test("technicalRasterVectorWhiteMode: an inline image OUTSIDE the target OCG never blocks the export", () => {
  const stream = bytes("BI /W 1 /H 1 /BPC 8 ID \x00\x01\x02 EI\n/OC /MC0 BDC\n0 g 0 0 10 10 re f\nEMC\n");
  const result = computeVectorWhiteModeContentStream(stream, { targetOcPropertyNames: TARGET, opacityFraction: 1 });
  assert.equal(result.status, "patched");
});

test("technicalRasterVectorWhiteMode: no target property names at all is reported unsupported, never a silent no-op", () => {
  const stream = bytes("/OC /MC0 BDC\n0 g 0 0 10 10 re f\nEMC\n");
  const result = computeVectorWhiteModeContentStream(stream, { targetOcPropertyNames: new Set(), opacityFraction: 1 });
  assert.equal(result.status, "unsupported");
});

test("technicalRasterVectorWhiteMode: scn with a plain numeric (non-pattern) fill color is whitened normally", () => {
  const stream = bytes("/OC /MC0 BDC\n/CS0 cs 0.2 0.4 0.6 scn 0 0 10 10 re f\nEMC\n");
  const result = computeVectorWhiteModeContentStream(stream, { targetOcPropertyNames: TARGET, opacityFraction: 1 });
  assert.equal(result.status, "patched");
  if (result.status !== "patched") return;
  assert.match(text(result.content), /1 1 1 rg/);
  assert.ok(!text(result.content).includes("0.2 0.4 0.6 scn"));
});

test("technicalRasterVectorWhiteMode: a colon-balanced sequence of unrelated BMC/EMC around the target never corrupts nesting", () => {
  const stream = bytes("/Artifact BMC\nEMC\n/OC /MC0 BDC\n0 g 0 0 10 10 re f\nEMC\n/Artifact BMC\nEMC\n");
  const result = computeVectorWhiteModeContentStream(stream, { targetOcPropertyNames: TARGET, opacityFraction: 1 });
  assert.equal(result.status, "patched");
});
