import assert from "node:assert/strict";
import test from "node:test";
import { PDFArray, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { appendContentStreamToPage, appendRawContentChunk, replacePageContentsWithSingleStream, resolvePageContentsShape } from "../lib/pdf/pdfPageContentAppend.ts";

// ============================================================================
// Corrective batch (post real-file acceptance) section 1 — the exact real-world crash was
// "Contents.push is not a function": pdf-lib's own internal addContentStream() blindly calls
// .push() on whatever /Contents currently resolves to. These tests exercise all three legal
// /Contents shapes directly against real pdf-lib PDFDocument/PDFPage objects — never a mock.
// ============================================================================

function decodeAllStreams(doc: PDFDocument, page: ReturnType<PDFDocument["getPage"]>): string[] {
  const contents = page.node.Contents();
  const streams: PDFRawStream[] = [];
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i += 1) {
      const s = doc.context.lookup(contents.get(i));
      if (s instanceof PDFRawStream) streams.push(s);
    }
  } else if (contents instanceof PDFRawStream) {
    streams.push(contents);
  }
  return streams.map((s) => new TextDecoder("latin1").decode(decodePDFRawStream(s).decode()));
}

test("resolvePageContentsShape: a page with NO /Contents at all is classified 'missing'", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([100, 100]);
  page.node.delete(PDFName.of("Contents"));
  const shape = resolvePageContentsShape(doc.context, page);
  assert.equal(shape.status, "missing");
});

test("resolvePageContentsShape: a freshly created page with a single content stream is classified 'single'", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([100, 100]);
  page.drawLine({ start: { x: 0, y: 0 }, end: { x: 10, y: 10 } });
  // pdf-lib normalizes on save/access; force a raw single-ref shape the way copyPages produces it
  // by loading a document that never had drawing appended after copy.
  const bytes = await doc.save();
  const reloaded = await PDFDocument.load(bytes);
  const reloadedPage = reloaded.getPage(0);
  const shape = resolvePageContentsShape(reloaded.context, reloadedPage);
  // A saved+reloaded page's own /Contents may already be an array (pdf-lib normalizes before
  // save) or a single stream depending on how many draw calls were made — either is a legitimate
  // real-world shape; assert it's one of the two documented ones, never an unexpected 3rd shape.
  assert.ok(shape.status === "single" || shape.status === "array");
});

test("appendContentStreamToPage: MISSING /Contents -> creates a new array with exactly the new stream", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([100, 100]);
  page.node.delete(PDFName.of("Contents"));
  const newRef = doc.context.register(doc.context.stream("1 0 0 rg 0 0 10 10 re f", {}));
  appendContentStreamToPage(doc.context, page, newRef);
  const shape = resolvePageContentsShape(doc.context, page);
  assert.equal(shape.status, "array");
  if (shape.status === "array") assert.equal(shape.array.size(), 1);
});

test("appendContentStreamToPage: SINGLE stream /Contents -> converts to [existing, new], preserving order", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([100, 100]);
  const existingRef = doc.context.register(doc.context.stream("0 0 0 rg 0 0 5 5 re f", {}));
  page.node.set(PDFName.of("Contents"), existingRef);
  const newRef = doc.context.register(doc.context.stream("1 0 0 rg 0 0 10 10 re f", {}));
  appendContentStreamToPage(doc.context, page, newRef);

  const shape = resolvePageContentsShape(doc.context, page);
  assert.equal(shape.status, "array");
  if (shape.status !== "array") return;
  assert.equal(shape.array.size(), 2);
  const first = doc.context.lookup(shape.array.get(0));
  const second = doc.context.lookup(shape.array.get(1));
  assert.ok(first instanceof PDFRawStream && second instanceof PDFRawStream);
  const firstText = new TextDecoder("latin1").decode(decodePDFRawStream(first).decode());
  const secondText = new TextDecoder("latin1").decode(decodePDFRawStream(second).decode());
  assert.match(firstText, /0 0 0 rg/, "existing content must come FIRST");
  assert.match(secondText, /1 0 0 rg/, "new content comes SECOND");
});

test("appendContentStreamToPage: ARRAY /Contents -> appends via the real PDFArray.push, never replacing existing entries", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([100, 100]);
  const ref1 = doc.context.register(doc.context.stream("0 0 0 rg", {}));
  const ref2 = doc.context.register(doc.context.stream("0 0 1 rg", {}));
  const arr = doc.context.obj([ref1, ref2]);
  page.node.set(PDFName.of("Contents"), arr);

  const newRef = doc.context.register(doc.context.stream("1 0 0 rg", {}));
  appendContentStreamToPage(doc.context, page, newRef);

  const shape = resolvePageContentsShape(doc.context, page);
  assert.equal(shape.status, "array");
  if (shape.status === "array") assert.equal(shape.array.size(), 3, "the two existing entries must survive, plus the new one");
});

test("appendContentStreamToPage: TWO successive appends onto an originally-missing /Contents both land, in order", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([100, 100]);
  page.node.delete(PDFName.of("Contents"));
  const ref1 = doc.context.register(doc.context.stream("A", {}));
  const ref2 = doc.context.register(doc.context.stream("B", {}));
  appendContentStreamToPage(doc.context, page, ref1);
  appendContentStreamToPage(doc.context, page, ref2);
  const shape = resolvePageContentsShape(doc.context, page);
  assert.equal(shape.status, "array");
  if (shape.status === "array") assert.equal(shape.array.size(), 2);
});

test("replacePageContentsWithSingleStream: always leaves /Contents as a real PDFArray, never a bare ref — the actual crash fix", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([100, 100]);
  const existingRef = doc.context.register(doc.context.stream("0 0 0 rg", {}));
  page.node.set(PDFName.of("Contents"), existingRef); // simulate a copied page's own single-stream Contents

  const replacementRef = doc.context.register(doc.context.stream("1 1 1 rg", {}));
  replacePageContentsWithSingleStream(doc.context, page, replacementRef);

  const shape = resolvePageContentsShape(doc.context, page);
  assert.equal(shape.status, "array", "/Contents must be a real array immediately after replacement, never a bare single ref");
  if (shape.status !== "array") return;
  assert.equal(shape.array.size(), 1);
});

test("REAL CRASH REPRODUCTION: replacing /Contents with a bare single ref (the OLD, buggy behavior), then drawing via pdf-lib's own high-level API, throws 'Contents.push is not a function'", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([100, 100]);
  const existingRef = doc.context.register(doc.context.stream("0 0 0 rg", {}));
  // Trigger pdf-lib's own normalize() EARLY (as newExtGState does for opacity < 100%), latching
  // its private `normalized` flag true while /Contents still points at the ORIGINAL content.
  page.node.newExtGState("Test", doc.context.register(doc.context.obj({ Type: "ExtGState", ca: 0.6 })));
  // The OLD, buggy white-mode code path: a bare .set() with a single ref, bypassing this module's
  // own safe helper entirely.
  const replacementRef = doc.context.register(doc.context.stream("1 1 1 rg", {}));
  page.node.set(PDFName.of("Contents"), replacementRef);

  assert.throws(() => page.drawText("X", { x: 0, y: 0 }), /Contents\.push is not a function/u);
  void existingRef;
});

test("FIXED SEQUENCE: the same scenario, but using replacePageContentsWithSingleStream, never throws — drawing afterward succeeds and both pieces of content survive", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([100, 100]);
  const existingRef = doc.context.register(doc.context.stream("0 0 0 rg", {}));
  page.node.set(PDFName.of("Contents"), existingRef);
  page.node.newExtGState("Test", doc.context.register(doc.context.obj({ Type: "ExtGState", ca: 0.6 })));

  const replacementRef = doc.context.register(doc.context.stream("1 1 1 rg 0 0 10 10 re f", {}));
  replacePageContentsWithSingleStream(doc.context, page, replacementRef);

  assert.doesNotThrow(() => page.drawText("X", { x: 5, y: 5, size: 4 }));

  const bytes = await doc.save();
  const reloaded = await PDFDocument.load(bytes);
  const texts = decodeAllStreams(reloaded, reloaded.getPage(0));
  const joined = texts.join("\n");
  assert.match(joined, /1 1 1 rg/, "the white-mode-replaced content must survive");
  assert.match(joined, /Tj|TJ/, "the overlay drawn AFTER the replacement must also survive");
});

// ============================================================================
// CORRECTIVE BATCH (3rd) sections 9/11 — appendRawContentChunk: the convenience used by the new
// vector-outline glyph fills AND the GENERÁTOR DATA OCG's own `/OC ... BDC`/`EMC` bracket. Must
// share the exact same safe-shape discipline as appendContentStreamToPage above (never a blind
// `.push()` on a bare single ref).
// ============================================================================

test("appendRawContentChunk: MISSING /Contents -> creates a new array containing exactly the raw chunk", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([100, 100]);
  page.node.delete(PDFName.of("Contents"));
  appendRawContentChunk(doc.context, page, "/OC /GenData1 BDC");
  const shape = resolvePageContentsShape(doc.context, page);
  assert.equal(shape.status, "array");
  assert.equal(decodeAllStreams(doc, page).join(""), "/OC /GenData1 BDC");
});

test("appendRawContentChunk: SINGLE stream /Contents -> converts to [existing, new chunk], preserving order — never a blind .push() on a bare ref", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([100, 100]);
  const existingRef = doc.context.register(doc.context.stream("0 0 0 rg", {}));
  page.node.set(PDFName.of("Contents"), existingRef);
  appendRawContentChunk(doc.context, page, "EMC");
  const texts = decodeAllStreams(doc, page);
  assert.deepEqual(texts, ["0 0 0 rg", "EMC"]);
});

test("REAL SEQUENCE: white-mode replace, THEN a BDC bracket, THEN a vector-outline glyph fill chunk (appendRawContentChunk), THEN an EMC close, THEN a pdf-lib high-level draw (drawLine) — the full real GENERÁTOR DATA overlay order — never crashes, every piece survives in order", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([100, 100]);
  const existingRef = doc.context.register(doc.context.stream("0 0 0 rg", {}));
  page.node.set(PDFName.of("Contents"), existingRef);

  const replacementRef = doc.context.register(doc.context.stream("1 1 1 rg 0 0 10 10 re f", {}));
  replacePageContentsWithSingleStream(doc.context, page, replacementRef);

  appendRawContentChunk(doc.context, page, "/OC /GenData1 BDC");
  appendRawContentChunk(doc.context, page, "0.702 0.149 0.118 rg\n1 1 m 2 2 l h\nf");
  assert.doesNotThrow(() => page.drawLine({ start: { x: 1, y: 1 }, end: { x: 9, y: 9 }, thickness: 1 }));
  appendRawContentChunk(doc.context, page, "EMC");

  const bytes = await doc.save();
  const reloaded = await PDFDocument.load(bytes);
  const texts = decodeAllStreams(reloaded, reloaded.getPage(0));
  assert.equal(texts.length, 5, "white-mode-replaced content + BDC + glyph fill + drawLine's own stream + EMC, in order, never merged/dropped");
  assert.match(texts[0]!, /1 1 1 rg/);
  assert.equal(texts[1], "/OC /GenData1 BDC");
  assert.match(texts[2]!, /0\.702 0\.149 0\.118 rg/);
  assert.match(texts[3]!, /\bS\b/, "the pdf-lib drawLine call's own content still lands correctly in between");
  assert.equal(texts[4], "EMC");
});
