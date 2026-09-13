/**
 * Technické rastry — CORRECTIVE BATCH (real production, H3 100% white / grid-through-fill). Real
 * manual acceptance: at Krytí bílé = 100%, H3 stand interiors show light-gray hall raster grid
 * lines THROUGH the white fill (both in the editor and in the exported PDF) — H1 shows no such
 * artifact. Earlier inspection already confirmed H3's Form XObjects carry no real `ca`/`CA` alpha,
 * so this is NOT a transparency issue. The leading hypothesis: the hall "RASTR" (grid/background)
 * OCG's own content is painted AFTER (on top of) the "STÁNKY" OCG's stand fills in H3's page
 * content stream, so even a fully opaque white stand fill gets grid lines drawn back over it —
 * whereas H1 draws them in the opposite order (or the grid simply never crosses stand interiors).
 *
 * This script reports, for BOTH real fixtures: every OCG layer name in catalog order, and for each
 * one, EVERY byte-offset range its own `/OC <name> BDC ... EMC` marked-content span(s) occupy in
 * the page's single merged content stream — so the RELATIVE PAINT ORDER of any two named layers is
 * directly readable (a span that starts at a LATER offset paints on top of one that ends earlier).
 * Also reports each layer's own operator mix (stroke-heavy vs fill-heavy) as a hint for identifying
 * which one is the grid/background layer without hardcoding a name — spec explicitly forbids
 * hardcoding H3-specific names/order, since H4 must work generically.
 *
 * Skip-safe: never depends on the real fixtures being present, never required by `npm test`.
 * Usage: node --no-warnings --experimental-strip-types scripts/technicalRasterWhiteModeDrawOrderDiagnostic.ts
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, PDFRef, PDFHexString, PDFString, decodePDFRawStream } from "pdf-lib";

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

type Span = Readonly<{ start: number; end: number }>;

/** Extracts every top-level `/OC /<propName> BDC ... EMC` span for propName, tracking nested BDC/BMC depth so a NESTED unrelated marked-content group inside the target doesn't prematurely close it. Returns byte offsets into `fullText`. */
function extractSpansForProperty(fullText: string, propName: string): Span[] {
  const spans: Span[] = [];
  const tokenPattern = /(\/OC)\s+\/(\S+)\s+BDC|\bBMC\b|\bEMC\b/gu;
  let depth = 0;
  let targetDepth = -1;
  let spanStart = -1;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(fullText))) {
    const token = match[0];
    if (token === "BMC") { depth += 1; continue; }
    if (token.endsWith("BDC")) {
      depth += 1;
      const name = match[2];
      if (match[1] === "/OC" && name === propName && targetDepth === -1) {
        targetDepth = depth;
        spanStart = tokenPattern.lastIndex;
      }
      continue;
    }
    if (token === "EMC") {
      if (targetDepth === depth) {
        spans.push({ start: spanStart, end: match.index });
        targetDepth = -1;
      }
      depth -= 1;
      continue;
    }
  }
  return spans;
}

function analyzeOperatorMix(text: string): Readonly<{ strokeOps: number; fillOps: number; doInvocations: number; totalBytes: number }> {
  const strokeOps = (text.match(/(?:^|\s)(S|s)(?=\s|$)/gu) ?? []).length;
  const fillOps = (text.match(/(?:^|\s)(f\*?|F|B\*?|b\*?)(?=\s|$)/gu) ?? []).length;
  const doInvocations = (text.match(/\/\S+\s+Do\b/gu) ?? []).length;
  return { strokeOps, fillOps, doInvocations, totalBytes: text.length };
}

async function diagnoseFile(filePath: string, label: string): Promise<void> {
  section(`${label} — ${path.basename(filePath)}`);
  const bytes = await readFile(filePath);
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const page = doc.getPage(0);

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
  console.log(`Total OCG layers (catalog order): ${layerNames.length}`);
  layerNames.forEach((l, i) => console.log(`  [${i}] "${l.name}"`));

  const resources = page.node.Resources();
  const refToPropName = new Map<string, string>();
  if (resources) {
    const props = resources.lookup(PDFName.of("Properties"));
    if (props instanceof PDFDict) {
      for (const key of props.keys()) {
        const ref = props.get(key);
        if (ref instanceof PDFRef) refToPropName.set(ref.toString(), key.decodeText());
      }
    }
  }

  const contentBytes = await readAllPageContentBytes(doc, page);
  const fullText = Buffer.from(contentBytes).toString("latin1");
  console.log(`Page content stream total length: ${fullText.length} bytes`);

  const report: { name: string; propName: string; spans: Span[]; mix: ReturnType<typeof analyzeOperatorMix> }[] = [];
  for (const layer of layerNames) {
    const propName = refToPropName.get(layer.ref.toString());
    if (!propName) { console.log(`  "${layer.name}": no /Resources/Properties key on page 1 (never tagged in THIS page's content) — skipping`); continue; }
    const spans = extractSpansForProperty(fullText, propName);
    const mixedText = spans.map((s) => fullText.slice(s.start, s.end)).join("");
    const mix = analyzeOperatorMix(mixedText);
    report.push({ name: layer.name, propName, spans, mix });
  }

  console.log("\nPer-layer paint-order + operator-mix report (ordered by FIRST span start offset — i.e. actual paint order in the page content stream):");
  const ordered = [...report].filter((r) => r.spans.length > 0).sort((a, b) => a.spans[0]!.start - b.spans[0]!.start);
  for (const r of ordered) {
    const first = r.spans[0]!;
    const last = r.spans[r.spans.length - 1]!;
    console.log(
      `  "${r.name}" (prop /${r.propName}): ${r.spans.length} span(s), byte range [${first.start} .. ${last.end}], ` +
      `strokeOps=${r.mix.strokeOps}, fillOps=${r.mix.fillOps}, Do=${r.mix.doInvocations}, ` +
      `mix=${r.mix.fillOps > r.mix.strokeOps ? "fill-heavy" : r.mix.strokeOps > r.mix.fillOps ? "stroke-heavy (likely grid/outline layer)" : "mixed"}`,
    );
  }

  // Identify the two layers of interest generically: the fill-heaviest layer (likely stands) vs the
  // stroke-heaviest layer with the LARGEST span (likely the hall grid/background) — never by name.
  const byFillHeavy = [...report].filter((r) => r.spans.length > 0).sort((a, b) => b.mix.fillOps - a.mix.fillOps);
  const byStrokeHeavy = [...report].filter((r) => r.spans.length > 0).sort((a, b) => b.mix.strokeOps - a.mix.strokeOps);
  const likelyStands = byFillHeavy[0];
  const likelyGrid = byStrokeHeavy[0];
  if (likelyStands && likelyGrid && likelyStands.name !== likelyGrid.name) {
    const standsFirstStart = likelyStands.spans[0]!.start;
    const standsLastEnd = likelyStands.spans[likelyStands.spans.length - 1]!.end;
    const gridFirstStart = likelyGrid.spans[0]!.start;
    const gridLastEnd = likelyGrid.spans[likelyGrid.spans.length - 1]!.end;
    console.log(`\nLikely STAND layer (most fill ops): "${likelyStands.name}", byte range [${standsFirstStart}..${standsLastEnd}]`);
    console.log(`Likely GRID/background layer (most stroke ops): "${likelyGrid.name}", byte range [${gridFirstStart}..${gridLastEnd}]`);
    if (gridFirstStart > standsLastEnd) {
      console.log(`=> GRID layer is painted ENTIRELY AFTER the STAND layer (grid-on-top order) — consistent with "grid lines show through white stand fill".`);
    } else if (gridLastEnd < standsFirstStart) {
      console.log(`=> GRID layer is painted ENTIRELY BEFORE the STAND layer (stands-on-top order) — grid should NOT show through opaque stand fills.`);
    } else {
      console.log(`=> GRID and STAND layer spans INTERLEAVE in the content stream (multiple alternating spans) — order is per-span, not a single global order.`);
    }
  }
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
