/**
 * Technické rastry — corrective batch (white mode / Form XObject support) section 16: real-file
 * structural diagnostic confirming (or rejecting) the suspected root cause for why white mode works
 * on Hala 1 (FOR DECOR) but not on Hala 3 (FOR BEAUTY). Entirely SKIP-SAFE — never required by
 * `npm test`, only ever reads local gitignored `_IMPORT/` fixtures.
 *
 * Usage: node --no-warnings scripts/technicalRasterWhiteModeFormXObjectDiagnostic.ts
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, PDFRef, PDFHexString, PDFString, PDFNumber, decodePDFRawStream } from "pdf-lib";

const repoRoot = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const importDir = path.join(repoRoot, "_IMPORT");

function section(title: string): void {
  console.log("\n" + "=".repeat(78));
  console.log(title);
  console.log("=".repeat(78));
}

function decodeText(value: unknown): string | undefined {
  if (value instanceof PDFHexString || value instanceof PDFString) return value.decodeText();
  return undefined;
}

const STAND_LAYER_ALIASES = ["stanky", "stands", "booth", "expozice"];
function normalizeLayerName(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/gu, "").replace(/[^a-z0-9]/giu, "").toLowerCase();
}

async function readAllPageContentBytes(doc: PDFDocument, page: ReturnType<PDFDocument["getPage"]>): Promise<Uint8Array> {
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
  const chunks = streams.map((s) => decodePDFRawStream(s).decode());
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.length; }
  return merged;
}

/** Extremely small, purpose-built (never the production tokenizer) line/token scan — good enough to count operators for a diagnostic report, not to actually rewrite anything. */
function analyzeContentStream(text: string): Readonly<{
  fillColorOps: number;
  fillPaintOps: number;
  doInvocations: readonly string[];
  gsInvocations: readonly string[];
}> {
  const fillColorOps = (text.match(/(?:^|\s)(?:\d[\d.]*\s+){0,3}\d[\d.]*\s+(rg|g|k)\s/gu) ?? []).length
    + (text.match(/\/\S+\s+(?:\d[\d.]*\s+)*scn\s/gu) ?? []).length
    + (text.match(/(?:\d[\d.]*\s+){1,4}sc\s/gu) ?? []).length;
  const fillPaintOps = (text.match(/(?:^|\s)(f\*?|F|B\*?|b\*?)(?=\s|$)/gu) ?? []).length;
  const doInvocations = [...text.matchAll(/\/(\S+)\s+Do\b/gu)].map((m) => m[1]!);
  const gsInvocations = [...text.matchAll(/\/(\S+)\s+gs\b/gu)].map((m) => m[1]!);
  return { fillColorOps, fillPaintOps, doInvocations, gsInvocations };
}

/** Extracts the substring(s) of `fullText` between a `/OC /<propName> BDC` and its matching `EMC`, tracking nested BDC/BMC depth with a simple counter (good enough for a diagnostic — never used for the real rewrite). */
function extractTargetSpans(fullText: string, propNames: ReadonlySet<string>): string[] {
  const spans: string[] = [];
  const tokenPattern = /\/(\S+)\s+\/(\S+)\s+BDC|\/(\S+)\s+BDC|\bBMC\b|\bEMC\b/gu;
  let depth = 0;
  let targetDepth = -1;
  let spanStart = -1;
  let match: RegExpExecArray | null;
  const bdcFullPattern = /(\/OC)\s+\/(\S+)\s+BDC|BMC|EMC/gu;
  while ((match = bdcFullPattern.exec(fullText))) {
    const token = match[0];
    if (token === "BMC") { depth += 1; continue; }
    if (token.endsWith("BDC")) {
      depth += 1;
      const propName = match[2];
      if (match[1] === "/OC" && propName && propNames.has(propName) && targetDepth === -1) {
        targetDepth = depth;
        spanStart = bdcFullPattern.lastIndex;
      }
      continue;
    }
    if (token === "EMC") {
      if (targetDepth === depth) {
        spans.push(fullText.slice(spanStart, match.index));
        targetDepth = -1;
      }
      depth -= 1;
      continue;
    }
  }
  return spans;
}

async function diagnoseFile(filePath: string, label: string): Promise<void> {
  section(`${label} — ${path.basename(filePath)}`);
  const bytes = await readFile(filePath);
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const page = doc.getPage(0);

  // 1) Find the stand-layer OCG by name, exactly like domain/technicalRasterWhiteModeOperators.ts's own detectStandLayerId.
  const ocProps = doc.catalog.lookup(PDFName.of("OCProperties"));
  const layerNames: { ref: PDFRef; name: string }[] = [];
  if (ocProps instanceof PDFDict) {
    const ocgsArr = ocProps.lookup(PDFName.of("OCGs"));
    if (ocgsArr instanceof PDFArray) {
      for (let i = 0; i < ocgsArr.size(); i += 1) {
        const ref = ocgsArr.get(i);
        if (!(ref instanceof PDFRef)) continue;
        const ocg = doc.context.lookup(ref);
        const name = ocg instanceof PDFDict ? decodeText(ocg.lookup(PDFName.of("Name"))) : undefined;
        if (name) layerNames.push({ ref, name });
      }
    }
  }
  console.log(`Total OCG layers found: ${layerNames.length}`);
  console.log("Layer names:", layerNames.map((l) => l.name).join(" | "));
  const standLayer = layerNames.find((l) => STAND_LAYER_ALIASES.some((alias) => normalizeLayerName(l.name).includes(alias)));
  if (!standLayer) { console.log("NO stand layer detected by name — cannot continue diagnostic for this file."); return; }
  console.log(`Target stand OCG: "${standLayer.name}" (ref ${standLayer.ref.toString()})`);

  // 2) Resolve which /Resources/Properties key(s) on page 1 point at that OCG ref.
  const resources = page.node.Resources();
  const propNames = new Set<string>();
  if (resources) {
    const props = resources.lookup(PDFName.of("Properties"));
    if (props instanceof PDFDict) {
      for (const key of props.keys()) {
        const ref = props.get(key);
        if (ref instanceof PDFRef && ref.toString() === standLayer.ref.toString()) propNames.add(key.decodeText());
      }
    }
  }
  console.log(`Page 1 /Resources/Properties key(s) mapping to this OCG: ${[...propNames].join(", ") || "(none found)"}`);
  if (propNames.size === 0) { console.log("Cannot locate the OCG's own property key on page 1 — stopping."); return; }

  // 3) Read the FULL page content stream and extract the target OCG's own marked-content span(s).
  const contentBytes = await readAllPageContentBytes(doc, page);
  const fullText = Buffer.from(contentBytes).toString("latin1");
  const spans = extractTargetSpans(fullText, propNames);
  console.log(`Target OCG marked-content span(s) found in page content: ${spans.length}`);

  let totalDirectFillOps = 0;
  let totalDirectPaintOps = 0;
  const allDoNames = new Set<string>();
  for (const span of spans) {
    const analysis = analyzeContentStream(span);
    totalDirectFillOps += analysis.fillColorOps;
    totalDirectPaintOps += analysis.fillPaintOps;
    for (const name of analysis.doInvocations) allDoNames.add(name);
  }
  console.log(`Direct fill-color operators inside target span(s): ${totalDirectFillOps}`);
  console.log(`Direct fill-paint operators inside target span(s): ${totalDirectPaintOps}`);
  console.log(`Form XObject ("Do") invocations inside target span(s): ${allDoNames.size} distinct name(s): ${[...allDoNames].join(", ") || "(none)"}`);

  // 4) Check whether any of those XObject names are ALSO invoked OUTSIDE the target span (shared usage).
  const allDoInWholePage = new Set([...fullText.matchAll(/\/(\S+)\s+Do\b/gu)].map((m) => m[1]!));
  const outsideOnly = [...allDoInWholePage].filter((name) => !spans.some((s) => new RegExp(`/${name}\\s+Do\\b`, "u").test(s)));
  console.log(`Total distinct Form XObject invocations anywhere on page 1: ${allDoInWholePage.size}`);
  console.log(`Names invoked ONLY outside the target span: ${outsideOnly.length}`);

  // 5) For each XObject reached from the target span, resolve it and inspect subtype/matrix/bbox/group/resources/content.
  const xobjectDict = resources?.lookup(PDFName.of("XObject"));
  let nestedFormCount = 0;
  for (const name of allDoNames) {
    if (!(xobjectDict instanceof PDFDict)) continue;
    const ref = xobjectDict.get(PDFName.of(name));
    const xobj = ref ? doc.context.lookup(ref) : undefined;
    if (!(xobj instanceof PDFRawStream)) { console.log(`  /${name}: could not resolve as a stream`); continue; }
    const dict = xobj.dict;
    const subtype = dict.lookup(PDFName.of("Subtype"));
    const subtypeName = subtype instanceof PDFName ? subtype.asString() : "?";
    const matrix = dict.lookup(PDFName.of("Matrix"));
    const bbox = dict.lookup(PDFName.of("BBox"));
    const group = dict.lookup(PDFName.of("Group"));
    let groupInfo = "(none)";
    if (group instanceof PDFDict) {
      const groupSubtype = group.lookup(PDFName.of("S"));
      const isTransparency = groupSubtype instanceof PDFName && groupSubtype.asString() === "Transparency";
      const ca = group.lookup(PDFName.of("CA"));
      groupInfo = `S=${groupSubtype instanceof PDFName ? groupSubtype.asString() : "?"}${isTransparency ? " (TRANSPARENCY GROUP)" : ""}`;
      void ca;
    }
    const formResources = dict.lookup(PDFName.of("Resources"));
    const hasOwnResources = formResources instanceof PDFDict;
    const formBytes = decodePDFRawStream(xobj).decode();
    const formText = Buffer.from(formBytes).toString("latin1");
    const formAnalysis = analyzeContentStream(formText);
    if (formAnalysis.doInvocations.length > 0) nestedFormCount += formAnalysis.doInvocations.length;
    console.log(`  /${name}: Subtype=${subtypeName}, Matrix=${matrix ? "present" : "(identity/absent)"}, BBox=${bbox ? "present" : "(absent)"}, Group=${groupInfo}, ownResources=${hasOwnResources}`);
    console.log(`     content: fillColorOps=${formAnalysis.fillColorOps}, fillPaintOps=${formAnalysis.fillPaintOps}, nested Do=${formAnalysis.doInvocations.length} (${formAnalysis.doInvocations.join(",") || "-"}), gs=${formAnalysis.gsInvocations.join(",") || "(none)"}`);
    // ExtGState detail, if referenced.
    for (const gsName of formAnalysis.gsInvocations) {
      const formRes = formResources instanceof PDFDict ? formResources : resources;
      const extGStateDict = formRes?.lookup(PDFName.of("ExtGState"));
      if (extGStateDict instanceof PDFDict) {
        const gsRef = extGStateDict.get(PDFName.of(gsName));
        const gsObj = gsRef ? doc.context.lookup(gsRef) : undefined;
        if (gsObj instanceof PDFDict) {
          const ca = gsObj.lookup(PDFName.of("ca"));
          const CA = gsObj.lookup(PDFName.of("CA"));
          console.log(`       ExtGState /${gsName}: ca(non-stroking alpha)=${ca instanceof PDFNumber ? ca.asNumber() : "?"}, CA(stroking alpha)=${CA instanceof PDFNumber ? CA.asNumber() : "?"}`);
        }
      }
    }
  }
  console.log(`Nested Form XObject invocations (forms invoked FROM forms reached by the target span): ${nestedFormCount}`);
}

async function main(): Promise<void> {
  const hala1 = path.join(importDir, "Hala 1.pdf");
  const hala3 = path.join(importDir, "Hala 3_2026- ver.12_NOVY_3.pdf");

  if (existsSync(hala1)) await diagnoseFile(hala1, "WORKING CONTROL (FOR DECOR)");
  else console.log(`${hala1} not found — skipping.`);

  if (existsSync(hala3)) await diagnoseFile(hala3, "FAILING REGRESSION (FOR BEAUTY)");
  else console.log(`${hala3} not found — skipping.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
