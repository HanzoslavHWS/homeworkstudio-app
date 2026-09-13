/**
 * Technické rastry — corrective batch (white mode / Form XObject support) section 16: runs the REAL
 * production export pipeline (buildTechnicalRasterVectorExportPdf) with white mode requested against
 * BOTH real fixtures — Hala 1.pdf (FOR DECOR, the working control) and
 * "Hala 3_2026- ver.12_NOVY_3.pdf" (FOR BEAUTY, the real regression case) — and reports the actual
 * whiteModeDiagnostic result plus structural proof of what changed. Skip-safe; never required by
 * `npm test`; never depends on a real file being present.
 *
 * Usage: node --no-warnings scripts/technicalRasterWhiteModeRealDiagnostic.ts
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFArray, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { buildTechnicalRasterVectorExportPdf } from "../lib/technicalRasterVectorPdf.ts";

const repoRoot = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const importDir = path.join(repoRoot, "_IMPORT");

function section(title: string): void {
  console.log("\n" + "=".repeat(78));
  console.log(title);
  console.log("=".repeat(78));
}

async function fullPageContentText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);
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
  return streams.map((s) => Buffer.from(decodePDFRawStream(s).decode()).toString("latin1")).join("\n");
}

async function diagnoseFile(filePath: string, label: string, opacity: number): Promise<void> {
  section(`${label} — ${path.basename(filePath)} (Krytí bílé = ${Math.round(opacity * 100)}%)`);
  const sourcePdfBytes = new Uint8Array(await readFile(filePath));
  try {
    const { bytes, whiteModeDiagnostic } = await buildTechnicalRasterVectorExportPdf({
      sourcePdfBytes,
      page: 1,
      placements: [],
      legend: [],
      showLegend: false,
      headerLine: "X",
      whiteMode: { opacity },
    });
    console.log("whiteModeDiagnostic:", whiteModeDiagnostic);
    if (whiteModeDiagnostic.status === "applied") {
      const text = await fullPageContentText(bytes);
      const whiteFillCount = (text.match(/1 1 1 rg/gu) ?? []).length;
      const gsCount = (text.match(/\/TechRasterWhite\s+gs/gu) ?? []).length;
      console.log(`Occurrences of "1 1 1 rg" (whitened fills) in exported content: ${whiteFillCount}`);
      console.log(`Occurrences of "/TechRasterWhite gs" (opacity wrap) in exported content: ${gsCount}`);
    }
  } catch (error) {
    console.log("EXPORT THREW:", error);
  }
}

async function main(): Promise<void> {
  const hala1 = path.join(importDir, "Hala 1.pdf");
  const hala3 = path.join(importDir, "Hala 3_2026- ver.12_NOVY_3.pdf");

  if (existsSync(hala1)) {
    await diagnoseFile(hala1, "WORKING CONTROL (FOR DECOR)", 1);
    await diagnoseFile(hala1, "WORKING CONTROL (FOR DECOR)", 0.75);
  } else console.log(`${hala1} not found — skipping.`);

  if (existsSync(hala3)) {
    await diagnoseFile(hala3, "FAILING REGRESSION (FOR BEAUTY)", 1);
    await diagnoseFile(hala3, "FAILING REGRESSION (FOR BEAUTY)", 0.75);
  } else console.log(`${hala3} not found — skipping.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
