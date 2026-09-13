import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFHexString, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream, type PDFContext } from "pdf-lib";
import { buildTechnicalRasterVectorExportPdf, TechnicalRasterVectorExportError } from "../lib/technicalRasterVectorPdf.ts";
import { resolveTechnicalServicePresentation } from "../domain/technicalRasterServicePresentation.ts";
import type { TechnicalRasterExportPlacementItem } from "../domain/technicalRasterExport.ts";

// ============================================================================
// CORRECTIVE BATCH (white mode / Form XObject support) — real-file evidence: Hala 3_2026-
// ver.12_NOVY_3.pdf (FOR BEAUTY, Hall 3) draws every stand fill inside its own Form XObject
// (`/FmNN Do`, each its own `/Group /S /Transparency` form with its own `/Resources`) instead of
// with direct fill operators, unlike the FOR DECOR control file (Hala 1.pdf, 47 direct fills, 0
// Form invocations). This file exercises the recursive Form XObject support added to
// planFormXObjectWhitening/applyFormWhiteningPlan (lib/technicalRasterVectorPdf.ts) and the pure
// tokenizer extensions (domain/technicalRasterVectorWhiteMode.ts) — using ONLY self-contained
// synthetic pdf-lib fixtures (never a real customer PDF in the committed suite; see
// scripts/technicalRasterWhiteModeFormXObjectDiagnostic.ts and
// scripts/technicalRasterWhiteModeRealDiagnostic.ts for the real-fixture-based diagnostics, both
// skip-safe and never required by `npm test`).
// ============================================================================

const STAND_LAYER_NAME = "STÁNKY ***"; // matches this app's real alias-based stand-layer detection

/** Registers a "STÁNKY ***" OCG (the real alias-matched stand layer name) on `page`'s own /Resources/Properties under key "MC0", plus a matching catalog-level /OCProperties — the same minimal shape tests/technicalRasterVectorPdf.test.ts's own buildStandLayerContentFixture uses, factored out here since every fixture below needs it. */
function registerStandOcgCatalog(doc: PDFDocument, page: ReturnType<PDFDocument["addPage"]>): void {
  const ctx = doc.context;
  const ocg = PDFDict.withContext(ctx);
  ocg.set(PDFName.of("Type"), PDFName.of("OCG"));
  ocg.set(PDFName.of("Name"), PDFHexString.fromText(STAND_LAYER_NAME));
  const ocgRef = ctx.register(ocg);

  const props = PDFDict.withContext(ctx);
  props.set(PDFName.of("MC0"), ocgRef);
  const resources = page.node.lookup(PDFName.of("Resources"));
  if (resources instanceof PDFDict) resources.set(PDFName.of("Properties"), props);

  const ocgsArr = PDFArray.withContext(ctx);
  ocgsArr.push(ocgRef);
  const onArr = PDFArray.withContext(ctx);
  onArr.push(ocgRef);
  const orderArr = PDFArray.withContext(ctx);
  orderArr.push(ocgRef);
  const dDict = PDFDict.withContext(ctx);
  dDict.set(PDFName.of("BaseState"), PDFName.of("ON"));
  dDict.set(PDFName.of("ON"), onArr);
  dDict.set(PDFName.of("OFF"), PDFArray.withContext(ctx));
  dDict.set(PDFName.of("Order"), orderArr);
  const ocPropsDict = PDFDict.withContext(ctx);
  ocPropsDict.set(PDFName.of("OCGs"), ctx.register(ocgsArr));
  ocPropsDict.set(PDFName.of("D"), ctx.register(dDict));
  doc.catalog.set(PDFName.of("OCProperties"), ctx.register(ocPropsDict));
}

/** Adds (or extends) `resources`'s own `/XObject` dict with `name -> formRef` — mirrors exactly how a real page/Form's own resource dict references a Form XObject. */
function addFormXObject(ctx: PDFContext, resources: PDFDict, name: string, formRef: PDFRef): void {
  const existing = resources.lookup(PDFName.of("XObject"));
  const xobjectDict = existing instanceof PDFDict ? existing : PDFDict.withContext(ctx);
  if (!(existing instanceof PDFDict)) resources.set(PDFName.of("XObject"), xobjectDict);
  xobjectDict.set(PDFName.of(name), formRef);
}

/** Builds a real `/Subtype /Form` XObject stream (Type/Subtype/FormType/BBox/Matrix, optionally its own `/Resources`) — registers it and returns its ref. `bbox`/`matrix` default to plausible, non-trivial real values so a later test can prove they survive white-mode rewriting completely unchanged (spec section 9: never alter Form geometry). */
function createFormStream(ctx: PDFContext, contentText: string, options: Readonly<{ resources?: PDFDict; bbox?: readonly number[]; matrix?: readonly number[] }> = {}): PDFRef {
  const dict = buildFormDict(ctx, options);
  return ctx.register(PDFRawStream.of(dict, new TextEncoder().encode(contentText)));
}

function buildFormDict(ctx: PDFContext, options: Readonly<{ resources?: PDFDict; bbox?: readonly number[]; matrix?: readonly number[] }>): PDFDict {
  const dict = PDFDict.withContext(ctx);
  dict.set(PDFName.of("Type"), PDFName.of("XObject"));
  dict.set(PDFName.of("Subtype"), PDFName.of("Form"));
  dict.set(PDFName.of("FormType"), PDFNumber.of(1));
  const bbox = PDFArray.withContext(ctx);
  (options.bbox ?? [0, 0, 120, 80]).forEach((n) => bbox.push(PDFNumber.of(n)));
  dict.set(PDFName.of("BBox"), bbox);
  const matrix = PDFArray.withContext(ctx);
  (options.matrix ?? [1, 0, 0, 1, 7, 3]).forEach((n) => matrix.push(PDFNumber.of(n)));
  dict.set(PDFName.of("Matrix"), matrix);
  if (options.resources) dict.set(PDFName.of("Resources"), options.resources);
  return dict;
}

/** A Form XObject whose own content invokes ITSELF via `/FmSelf Do` — a malformed/self-referencing XObject graph, built by reserving the ref up front (`ctx.nextRef()`) before the content that needs to reference it exists. */
function createSelfReferencingFormStream(ctx: PDFContext): PDFRef {
  const selfRef = ctx.nextRef();
  const resources = PDFDict.withContext(ctx);
  addFormXObject(ctx, resources, "FmSelf", selfRef);
  const dict = buildFormDict(ctx, { resources });
  ctx.assign(selfRef, PDFRawStream.of(dict, new TextEncoder().encode("/FmSelf Do\n")));
  return selfRef;
}

function resolveFormRef(resources: PDFDict, name: string): PDFRef {
  const xobjectDict = resources.lookup(PDFName.of("XObject"));
  assert.ok(xobjectDict instanceof PDFDict, "expected an /XObject resource dict");
  const ref = (xobjectDict as PDFDict).get(PDFName.of(name));
  assert.ok(ref instanceof PDFRef, `expected "${name}" to resolve to a real PDFRef`);
  return ref;
}

function resolveFormDict(context: PDFContext, resources: PDFDict, name: string): PDFDict {
  const stream = context.lookup(resolveFormRef(resources, name));
  assert.ok(stream instanceof PDFRawStream, `expected "${name}" to resolve to a real stream`);
  return (stream as PDFRawStream).dict;
}

function resolveFormContentText(context: PDFContext, resources: PDFDict, name: string): string {
  const stream = context.lookup(resolveFormRef(resources, name));
  assert.ok(stream instanceof PDFRawStream, `expected "${name}" to resolve to a real stream`);
  return new TextDecoder("latin1").decode(decodePDFRawStream(stream as PDFRawStream).decode());
}

function numbersOf(value: unknown): number[] {
  assert.ok(value instanceof PDFArray);
  const result: number[] = [];
  for (let i = 0; i < (value as PDFArray).size(); i += 1) result.push(Number((value as PDFArray).get(i)?.toString()));
  return result;
}

async function readAllPage1ContentText(bytes: Uint8Array): Promise<string> {
  const reloaded = await PDFDocument.load(bytes);
  const page1 = reloaded.getPage(0);
  const contents = page1.node.Contents();
  const streams: PDFRawStream[] = [];
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i += 1) {
      const stream = reloaded.context.lookup(contents.get(i));
      if (stream instanceof PDFRawStream) streams.push(stream);
    }
  } else if (contents instanceof PDFRawStream) {
    streams.push(contents);
  }
  return streams.map((stream) => new TextDecoder("latin1").decode(decodePDFRawStream(stream).decode())).join("\n");
}

function textOf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}
void textOf;

// ============================================================================
// 1) Form XObject fill reached from inside the target OCG
// ============================================================================

async function buildFormFillFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const ctx = doc.context;
  registerStandOcgCatalog(doc, page);

  const formRef = createFormStream(ctx, "1 0 0 rg 0 0 10 10 re f\n", { bbox: [0, 0, 33, 44], matrix: [1, 0, 0, 1, 11, 22] });
  const pageResources = page.node.lookup(PDFName.of("Resources"));
  assert.ok(pageResources instanceof PDFDict);
  addFormXObject(ctx, pageResources as PDFDict, "Fm1", formRef);

  const contentText = "/OC /MC0 BDC\n/Fm1 Do\nEMC\n0 0 0 rg 5 5 15 15 re f\n";
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(new TextEncoder().encode(contentText), {})));
  return doc.save();
}

test("Form XObject fill: '/Fm1 Do' inside the target OCG span whitens the Form's OWN fill, the Do call itself is untouched, output stays fully vector", async () => {
  const source = await buildFormFillFixture();
  const { bytes, whiteModeDiagnostic } = await buildTechnicalRasterVectorExportPdf({
    sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X", whiteMode: { opacity: 1 },
  });
  assert.deepEqual(whiteModeDiagnostic, { status: "applied", whitenedFillCommandCount: 1, opacity: 1 });

  const reloaded = await PDFDocument.load(bytes);
  const page1 = reloaded.getPage(0);
  const pageResources = page1.node.lookup(PDFName.of("Resources")) as PDFDict;

  const formText = resolveFormContentText(reloaded.context, pageResources, "Fm1");
  assert.match(formText, /1 1 1 rg/u);
  assert.ok(!formText.includes("1 0 0 rg"), "the original red fill must be gone from the Form's own content");

  const pageText = await readAllPage1ContentText(bytes);
  assert.match(pageText, /\/Fm1 Do/u, "the Do invocation itself is byte-for-byte unchanged (Fm1 is not shared, so no rename is needed)");
  assert.match(pageText, /0 0 0 rg/u, "content OUTSIDE the target OCG (the page's own direct fill) remains completely untouched");

  // Spec section 9: never alter Form geometry (Matrix/BBox) — only the fill behavior/content.
  const formDict = resolveFormDict(reloaded.context, pageResources, "Fm1");
  assert.deepEqual(numbersOf(formDict.lookup(PDFName.of("BBox"))), [0, 0, 33, 44]);
  assert.deepEqual(numbersOf(formDict.lookup(PDFName.of("Matrix"))), [1, 0, 0, 1, 11, 22]);
});

// ============================================================================
// 2) Nested Form (target OCG -> Form A -> Form B -> fill)
// ============================================================================

async function buildNestedFormFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const ctx = doc.context;
  registerStandOcgCatalog(doc, page);

  const innerRef = createFormStream(ctx, "0 1 0 rg 0 0 10 10 re f\n");
  const outerResources = PDFDict.withContext(ctx);
  addFormXObject(ctx, outerResources, "FmB", innerRef);
  const outerRef = createFormStream(ctx, "/FmB Do\n", { resources: outerResources });

  const pageResources = page.node.lookup(PDFName.of("Resources"));
  assert.ok(pageResources instanceof PDFDict);
  addFormXObject(ctx, pageResources as PDFDict, "FmA", outerRef);

  const contentText = "/OC /MC0 BDC\n/FmA Do\nEMC\n";
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(new TextEncoder().encode(contentText), {})));
  return doc.save();
}

test("nested Form XObject (target OCG -> Form A -> Form B -> fill): the innermost fill is whitened, recursion works at least 2 levels deep", async () => {
  const source = await buildNestedFormFixture();
  const { bytes, whiteModeDiagnostic } = await buildTechnicalRasterVectorExportPdf({
    sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X", whiteMode: { opacity: 1 },
  });
  assert.deepEqual(whiteModeDiagnostic, { status: "applied", whitenedFillCommandCount: 1, opacity: 1 });

  const reloaded = await PDFDocument.load(bytes);
  const page1 = reloaded.getPage(0);
  const pageResources = page1.node.lookup(PDFName.of("Resources")) as PDFDict;

  const outerText = resolveFormContentText(reloaded.context, pageResources, "FmA");
  assert.match(outerText, /\/FmB Do/u, "Form A's own 'Do' invocation of Form B is untouched — it carries no fill of its own");

  const outerDict = resolveFormDict(reloaded.context, pageResources, "FmA");
  const outerResources = outerDict.lookup(PDFName.of("Resources")) as PDFDict;
  const innerText = resolveFormContentText(reloaded.context, outerResources, "FmB");
  assert.match(innerText, /1 1 1 rg/u);
  assert.ok(!innerText.includes("0 1 0 rg"), "Form B's original green fill must be gone");
});

// ============================================================================
// 3) Form OUTSIDE the target OCG — never touched
// ============================================================================

async function buildFormOutsideTargetFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const ctx = doc.context;
  registerStandOcgCatalog(doc, page);

  const formRef = createFormStream(ctx, "0 0 1 rg 0 0 10 10 re f\n");
  const pageResources = page.node.lookup(PDFName.of("Resources"));
  assert.ok(pageResources instanceof PDFDict);
  addFormXObject(ctx, pageResources as PDFDict, "FmLogo", formRef);

  const contentText = "/FmLogo Do\n/OC /MC0 BDC\n1 0 0 rg 0 0 10 10 re f\nEMC\n";
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(new TextEncoder().encode(contentText), {})));
  return doc.save();
}

test("Form XObject OUTSIDE the target OCG (e.g. a logo) is never recolored — only the DIRECT fill inside the target span is whitened", async () => {
  const source = await buildFormOutsideTargetFixture();
  const { bytes, whiteModeDiagnostic } = await buildTechnicalRasterVectorExportPdf({
    sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X", whiteMode: { opacity: 1 },
  });
  assert.deepEqual(whiteModeDiagnostic, { status: "applied", whitenedFillCommandCount: 1, opacity: 1 });

  const reloaded = await PDFDocument.load(bytes);
  const page1 = reloaded.getPage(0);
  const pageResources = page1.node.lookup(PDFName.of("Resources")) as PDFDict;
  const formText = resolveFormContentText(reloaded.context, pageResources, "FmLogo");
  assert.match(formText, /0 0 1 rg/u, "the unrelated Form's own blue fill must survive completely untouched");

  const pageText = await readAllPage1ContentText(bytes);
  assert.match(pageText, /1 1 1 rg/u, "the direct fill INSIDE the target OCG is still whitened");
});

// ============================================================================
// 4) Shared Form (same Form referenced from target AND non-target content) — clone-on-write
// ============================================================================

async function buildSharedFormFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const ctx = doc.context;
  registerStandOcgCatalog(doc, page);

  const formRef = createFormStream(ctx, "1 0 0 rg 0 0 10 10 re f\n");
  const pageResources = page.node.lookup(PDFName.of("Resources"));
  assert.ok(pageResources instanceof PDFDict);
  addFormXObject(ctx, pageResources as PDFDict, "Fm1", formRef);

  const contentText = "/Fm1 Do\n/OC /MC0 BDC\n/Fm1 Do\nEMC\n";
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(new TextEncoder().encode(contentText), {})));
  return doc.save();
}

test("shared Form XObject (same Form referenced from target AND non-target content): the target usage is cloned and whitened, the OTHER usage keeps its original fill completely untouched", async () => {
  const source = await buildSharedFormFixture();
  const { bytes, whiteModeDiagnostic } = await buildTechnicalRasterVectorExportPdf({
    sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X", whiteMode: { opacity: 1 },
  });
  assert.equal(whiteModeDiagnostic.status, "applied");

  const reloaded = await PDFDocument.load(bytes);
  const page1 = reloaded.getPage(0);
  const pageResources = page1.node.lookup(PDFName.of("Resources")) as PDFDict;
  const pageText = await readAllPage1ContentText(bytes);
  const doCalls = [...pageText.matchAll(/\/(\S+)\s+Do/gu)].map((m) => m[1]!);
  assert.equal(doCalls.length, 2, `expected exactly 2 'Do' invocations, got: ${pageText}`);
  assert.equal(doCalls[0], "Fm1", "the OUTSIDE-target usage keeps the original resource name — never renamed");
  assert.notEqual(doCalls[1], "Fm1", "the INSIDE-target usage is redirected to a newly cloned resource name");

  const originalText = resolveFormContentText(reloaded.context, pageResources, doCalls[0]!);
  assert.match(originalText, /1 0 0 rg/u, "the non-target usage's Form content is completely untouched (still red) — never corrupted by the OTHER usage's whitening");

  const cloneText = resolveFormContentText(reloaded.context, pageResources, doCalls[1]!);
  assert.match(cloneText, /1 1 1 rg/u, "the target usage's CLONED Form content is whitened");

  // The two names must resolve to genuinely DIFFERENT objects, not the same ref under two names.
  const originalRef = resolveFormRef(pageResources, doCalls[0]!);
  const cloneRef = resolveFormRef(pageResources, doCalls[1]!);
  assert.notEqual(originalRef.toString(), cloneRef.toString());
});

// ============================================================================
// 5) Stroke preservation inside a Form
// ============================================================================

async function buildFormFillStrokeFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const ctx = doc.context;
  registerStandOcgCatalog(doc, page);

  const formRef = createFormStream(ctx, "1 0 0 rg 0 0 1 RG 2 w 20 20 100 60 re B\n");
  const pageResources = page.node.lookup(PDFName.of("Resources"));
  assert.ok(pageResources instanceof PDFDict);
  addFormXObject(ctx, pageResources as PDFDict, "Fm1", formRef);

  const contentText = "/OC /MC0 BDC\n/Fm1 Do\nEMC\n";
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(new TextEncoder().encode(contentText), {})));
  return doc.save();
}

test("stroke preservation inside a Form: fill becomes white, stroke color/width/paint operator are completely untouched", async () => {
  const source = await buildFormFillStrokeFixture();
  const { bytes, whiteModeDiagnostic } = await buildTechnicalRasterVectorExportPdf({
    sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X", whiteMode: { opacity: 1 },
  });
  assert.deepEqual(whiteModeDiagnostic, { status: "applied", whitenedFillCommandCount: 1, opacity: 1 });

  const reloaded = await PDFDocument.load(bytes);
  const page1 = reloaded.getPage(0);
  const pageResources = page1.node.lookup(PDFName.of("Resources")) as PDFDict;
  const formText = resolveFormContentText(reloaded.context, pageResources, "Fm1");
  assert.match(formText, /1 1 1 rg/u);
  assert.match(formText, /0 0 1 RG/u, "stroke color untouched");
  assert.match(formText, /2 w/u, "line width untouched");
  assert.match(formText, /\bB\b/u, "the combined fill+stroke paint operator itself is untouched — the stroke still paints");
});

// ============================================================================
// 6) Project opacity vs. a Form's OWN source transparency — must never multiply
// ============================================================================

async function buildFormWithSourceOpacityFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const ctx = doc.context;
  registerStandOcgCatalog(doc, page);

  const formResources = PDFDict.withContext(ctx);
  const extGStateDict = PDFDict.withContext(ctx);
  const sourceGsDict = PDFDict.withContext(ctx);
  sourceGsDict.set(PDFName.of("Type"), PDFName.of("ExtGState"));
  sourceGsDict.set(PDFName.of("ca"), PDFNumber.of(0.75));
  extGStateDict.set(PDFName.of("GSSource"), ctx.register(sourceGsDict));
  formResources.set(PDFName.of("ExtGState"), extGStateDict);

  const formRef = createFormStream(ctx, "/GSSource gs\n1 0 0 rg 0 0 10 10 re f\n", { resources: formResources });
  const pageResources = page.node.lookup(PDFName.of("Resources"));
  assert.ok(pageResources instanceof PDFDict);
  addFormXObject(ctx, pageResources as PDFDict, "Fm1", formRef);

  const contentText = "/OC /MC0 BDC\n/Fm1 Do\nEMC\n";
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(new TextEncoder().encode(contentText), {})));
  return doc.save();
}

test("project opacity vs. a Form's OWN source transparency: a Form with its OWN ca=0.75 ExtGState gets the PROJECT's opacity (60%) re-asserted immediately after — final result matches the project opacity exactly, never multiplied (0.75 x 0.6 = 0.45 would be WRONG)", async () => {
  const source = await buildFormWithSourceOpacityFixture();
  const { bytes, whiteModeDiagnostic } = await buildTechnicalRasterVectorExportPdf({
    sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X", whiteMode: { opacity: 0.6 },
  });
  assert.deepEqual(whiteModeDiagnostic, { status: "applied", whitenedFillCommandCount: 1, opacity: 0.6 });

  const reloaded = await PDFDocument.load(bytes);
  const page1 = reloaded.getPage(0);
  const pageResources = page1.node.lookup(PDFName.of("Resources")) as PDFDict;
  const formText = resolveFormContentText(reloaded.context, pageResources, "Fm1");
  assert.match(formText, /1 1 1 rg/u);

  const reassertMatch = /\/GSSource gs\s*\n\/(\S+) gs/u.exec(formText);
  assert.ok(reassertMatch, `expected the source's own 'gs' call preserved, with OUR OWN opacity 'gs' re-asserted immediately after it — got: ${formText}`);
  const ourGsName = reassertMatch![1]!;

  const formDict = resolveFormDict(reloaded.context, pageResources, "Fm1");
  const formOwnResources = formDict.lookup(PDFName.of("Resources")) as PDFDict;
  const extGStateDict = formOwnResources.lookup(PDFName.of("ExtGState")) as PDFDict;

  const ourGsRef = extGStateDict.get(PDFName.of(ourGsName));
  const ourGsDict = reloaded.context.lookup(ourGsRef as PDFRef) as PDFDict;
  assert.equal(ourGsDict.lookup(PDFName.of("ca"))?.toString(), "0.6", "must equal the PROJECT's own opacity fraction exactly — never 0.75 * 0.6 = 0.45");

  // Spec section 8: never strip arbitrary transparency belonging to unrelated content — the
  // source's own ExtGState is completely untouched, still declaring its own original ca.
  const sourceGsRef = extGStateDict.get(PDFName.of("GSSource"));
  const sourceGsDict = reloaded.context.lookup(sourceGsRef as PDFRef) as PDFDict;
  assert.equal(sourceGsDict.lookup(PDFName.of("ca"))?.toString(), "0.75");
});

// ============================================================================
// 7) Unsupported content reached via a target-scope Form — WHITE_MODE_UNSUPPORTED, no partial PDF
// ============================================================================

async function buildFormWithPatternFillFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const ctx = doc.context;
  registerStandOcgCatalog(doc, page);

  const formRef = createFormStream(ctx, "/Pattern cs /P1 scn 0 0 10 10 re f\n");
  const pageResources = page.node.lookup(PDFName.of("Resources"));
  assert.ok(pageResources instanceof PDFDict);
  addFormXObject(ctx, pageResources as PDFDict, "Fm1", formRef);

  const contentText = "/OC /MC0 BDC\n/Fm1 Do\nEMC\n";
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(new TextEncoder().encode(contentText), {})));
  return doc.save();
}

test("unsupported content reached via a target-scope Form (a Pattern fill): the WHOLE EXPORT fails explicitly with WHITE_MODE_UNSUPPORTED, never a partial/fallback PDF, and the source bytes are never mutated", async () => {
  const source = await buildFormWithPatternFillFixture();
  const copyBefore = Uint8Array.from(source);
  await assert.rejects(
    buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X", whiteMode: { opacity: 1 } }),
    (error: unknown) => {
      assert.ok(error instanceof TechnicalRasterVectorExportError);
      assert.equal(error.code, "WHITE_MODE_UNSUPPORTED");
      return true;
    },
  );
  assert.deepEqual(source, copyBefore, "source bytes must never be mutated even when the failure happens deep inside a recursed Form");
});

// ============================================================================
// 8) Cycle protection — a Form invoking itself must never recurse infinitely
// ============================================================================

async function buildCyclicFormFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const ctx = doc.context;
  registerStandOcgCatalog(doc, page);

  const formRef = createSelfReferencingFormStream(ctx);
  const pageResources = page.node.lookup(PDFName.of("Resources"));
  assert.ok(pageResources instanceof PDFDict);
  addFormXObject(ctx, pageResources as PDFDict, "FmSelf", formRef);

  const contentText = "/OC /MC0 BDC\n/FmSelf Do\nEMC\n";
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(new TextEncoder().encode(contentText), {})));
  return doc.save();
}

test("cycle protection: a Form XObject that invokes ITSELF (a malformed/self-referencing graph) fails safely with WHITE_MODE_UNSUPPORTED — never an infinite recursion/hang", async () => {
  const source = await buildCyclicFormFixture();
  await assert.rejects(
    buildTechnicalRasterVectorExportPdf({ sourcePdfBytes: source, page: 1, placements: [], legend: [], showLegend: false, headerLine: "X", whiteMode: { opacity: 1 } }),
    (error: unknown) => {
      assert.ok(error instanceof TechnicalRasterVectorExportError);
      assert.equal(error.code, "WHITE_MODE_UNSUPPORTED");
      return true;
    },
  );
});

// ============================================================================
// 9) COMBINED REAL-PRODUCTION REGRESSION (real acceptance batch, sections 21-25) — the exact
// combination that just failed manually: an H3-style source (a genuine page-level `/ca 0.76`
// ExtGState set immediately before invoking a stand's own Form XObject — real evidence, see
// domain/technicalRasterVectorWhiteMode.ts's own hasSourceGsInsideTarget doc) exported TOGETHER
// with white mode AND technical service placements AND realization underlines AND GENERÁTOR DATA.
// Whatever fixes 100%-white-mode grid-through-fill must never lose any of the other three.
// ============================================================================

/** Registers a real ExtGState (`/ca`/`/CA` both set — mirroring H3's own real per-stand dict) on the page's own /Resources/ExtGState, under `name`. */
function registerPageExtGState(ctx: PDFContext, page: ReturnType<PDFDocument["addPage"]>, name: string, ca: number): void {
  const resources = page.node.lookup(PDFName.of("Resources"));
  assert.ok(resources instanceof PDFDict);
  const gsDict = PDFDict.withContext(ctx);
  gsDict.set(PDFName.of("Type"), PDFName.of("ExtGState"));
  gsDict.set(PDFName.of("ca"), PDFNumber.of(ca));
  gsDict.set(PDFName.of("CA"), PDFNumber.of(ca));
  const existing = (resources as PDFDict).lookup(PDFName.of("ExtGState"));
  const extGStateDict = existing instanceof PDFDict ? existing : PDFDict.withContext(ctx);
  if (!(existing instanceof PDFDict)) (resources as PDFDict).set(PDFName.of("ExtGState"), extGStateDict);
  extGStateDict.set(PDFName.of(name), ctx.register(gsDict));
}

async function buildH3StyleCombinedFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const ctx = doc.context;
  registerStandOcgCatalog(doc, page);
  registerPageExtGState(ctx, page, "GSSource76", 0.76);

  // Fill+stroke, exactly like the real H3 Form content — proves stroke color/width survive AND the
  // fill both whitens AND keeps its own alpha uncorrupted by the neutralized page-level 0.76 source.
  const formRef = createFormStream(ctx, "1 0 0 rg 0 0 1 RG 2 w 20 20 100 60 re B\n");
  const pageResources = page.node.lookup(PDFName.of("Resources"));
  assert.ok(pageResources instanceof PDFDict);
  addFormXObject(ctx, pageResources as PDFDict, "Fm1", formRef);

  // The real H3 page-level shape: a per-stand gs (real ca/CA) set OUTSIDE the Form, immediately
  // before invoking it — this is exactly what must be neutralized for TRUE 100% white opacity.
  const contentText = "/OC /MC0 BDC\n/GSSource76 gs\n/Fm1 Do\nEMC\n";
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.stream(new TextEncoder().encode(contentText), {})));
  return doc.save();
}

test("COMBINED REAL-PRODUCTION REGRESSION: H3-style source (page-level ca=0.76 before a Form) + white mode 100% + technical placement + realization underline + GENERÁTOR DATA — ALL must survive together", async () => {
  const source = await buildH3StyleCombinedFixture();
  const placements: TechnicalRasterExportPlacementItem[] = [{
    standId: "s1", standNumber: "3A1", serviceId: "svc1", placementId: "p1",
    xNormalized: 0.4, yNormalized: 0.5,
    presentation: resolveTechnicalServicePresentation("electricity", "Do 3kW 230V"),
    category: "electricity",
  }];
  const { bytes, whiteModeDiagnostic } = await buildTechnicalRasterVectorExportPdf({
    sourcePdfBytes: source,
    page: 1,
    placements,
    legend: [],
    showLegend: false,
    headerLine: "X",
    whiteMode: { opacity: 1 },
    realizationUnderlines: [{ standId: "s1", xNormalized: 0.4, yNormalized: 0.5, widthNormalized: 0.08, color: "#2f8f4e" }],
  });
  assert.equal(whiteModeDiagnostic.status, "applied");

  const reloaded = await PDFDocument.load(bytes);
  const page1 = reloaded.getPage(0);
  const pageResources = page1.node.lookup(PDFName.of("Resources")) as PDFDict;

  // 1) The Form's own fill is whitened; its stroke (color, width, paint op) is completely untouched.
  const formText = resolveFormContentText(reloaded.context, pageResources, "Fm1");
  assert.match(formText, /1 1 1 rg/u);
  assert.match(formText, /0 0 1 RG/u, "stroke color untouched");
  assert.match(formText, /2 w/u, "line width untouched");

  // 2) The page-level source ca=0.76 (set right before the Form) is neutralized — our own gs is
  // reasserted immediately after it, so the compositing alpha the Form is invoked at is TRUE 100%,
  // never the source's own 0.76 (the actual H3 grid-through-fill root cause).
  const pageText = await readAllPage1ContentTextLocal(bytes);
  assert.match(pageText, /\/GSSource76 gs\s*\r?\n\/\S+ gs/u, "our own opacity gs must be reasserted IMMEDIATELY after the source's real ca=0.76 gs, before /Fm1 Do ever runs");

  // 3) GENERÁTOR DATA OCG: registered exactly once, alongside the ONE source OCG (STÁNKY ***).
  const ocProps = reloaded.catalog.lookup(PDFName.of("OCProperties")) as PDFDict;
  const ocgsArr = ocProps.lookup(PDFName.of("OCGs")) as PDFArray;
  assert.equal(ocgsArr.size(), 2, "the one source STÁNKY *** OCG + exactly one GENERÁTOR DATA OCG — never duplicated, never lost");

  // 4) The technical service marker's own vector fill (its real presentation color) is present.
  assert.match(pageText, /0\.702 0\.149 0\.118 rg/u, "the electricity marker's own real presentation color (#b3261e)");

  // 5) The realization underline's own stroke color is present.
  assert.match(pageText, /0\.18\d* 0\.56\d* 0\.30\d* RG/u, "the realization underline's own real color (#2f8f4e) as a stroke");
});

/** Local variant of the shared readAllPage1ContentText helper (this file has no such helper yet — the other Form XObject tests only ever needed the Form's OWN content, resolved via resolveFormContentText). */
async function readAllPage1ContentTextLocal(bytes: Uint8Array): Promise<string> {
  const reloaded = await PDFDocument.load(bytes);
  const page1 = reloaded.getPage(0);
  const contents = page1.node.Contents();
  const streams: PDFRawStream[] = [];
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i += 1) {
      const stream = reloaded.context.lookup(contents.get(i));
      if (stream instanceof PDFRawStream) streams.push(stream);
    }
  } else if (contents instanceof PDFRawStream) {
    streams.push(contents);
  }
  return streams.map((stream) => new TextDecoder("latin1").decode(decodePDFRawStream(stream).decode())).join("\n");
}
