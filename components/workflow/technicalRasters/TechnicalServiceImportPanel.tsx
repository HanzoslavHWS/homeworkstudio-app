"use client";

import { useState } from "react";
import { TECHNICAL_SERVICE_CATEGORIES, technicalServiceCategoryLabel } from "../../../domain/technicalServiceCatalog";
import type { ParsedTechnicalReport, TechnicalRasterImport } from "../../../domain/technicalRaster";
import { getTechnicalReportParser, detectLikelyTechnicalReportCategory } from "../../../domain/technicalReportParsers";
import { loadPdfDocument } from "../../../lib/pdf/pdfDocumentLoader";
import { extractPdfTextItems } from "../../../lib/pdf/pdfTextExtraction";

export type PendingTechnicalImport = Readonly<{
  category: string;
  file: File;
  report: ParsedTechnicalReport;
  /** Set when an import of this SAME category already exists — user must explicitly confirm replacing it (spec section 24). */
  replaceImportId?: string;
}>;

/**
 * "Nahrát technický výjezd" (spec section 8/9): user picks a category (manual — autodetection is
 * only ever a hint, spec section 8) and a PDF, which is parsed IMMEDIATELY client-side (no upload
 * yet) so parse stats/warnings can be reviewed before anything is committed (spec section 25:
 * "Fail loudly, not silently" — every problem is shown, nothing is silently dropped).
 */
export function TechnicalServiceImportPanel({
  existingImportsByCategory,
  onPendingImportReady,
}: {
  existingImportsByCategory: ReadonlyMap<string, TechnicalRasterImport>;
  onPendingImportReady: (pending: PendingTechnicalImport) => void;
}) {
  const [category, setCategory] = useState(TECHNICAL_SERVICE_CATEGORIES[0]!.id);
  const [isParsing, setIsParsing] = useState(false);
  const [error, setError] = useState("");
  const [detectedHint, setDetectedHint] = useState<string | undefined>(undefined);

  async function handleFileSelected(file: File) {
    setError("");
    setDetectedHint(undefined);
    setIsParsing(true);
    try {
      const buffer = await file.arrayBuffer();
      const document = await loadPdfDocument({ data: buffer });
      let items;
      try {
        items = await extractPdfTextItems(document);
      } finally {
        // A short-lived, never-stored document used only for this one-time parse preview — must
        // be destroyed here or its worker/WASM resources leak (spec batch 2.5 section 21).
        void document.destroy();
      }

      const sampleText = items.slice(0, 200).map((item) => item.str).join(" ");
      const hint = detectLikelyTechnicalReportCategory(sampleText);
      if (hint && hint !== category) setDetectedHint(hint);

      const parser = getTechnicalReportParser(category);
      if (!parser) throw new Error(`Pro kategorii "${technicalServiceCategoryLabel(category)}" zatím neexistuje parser.`);
      const report = parser.parse(items);

      const existing = existingImportsByCategory.get(category);
      onPendingImportReady({ category, file, report, replaceImportId: existing?.id });
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : "PDF se nepodařilo zpracovat.");
    } finally {
      setIsParsing(false);
    }
  }

  return (
    <div className="workflowCard technicalServiceImportPanel">
      <div className="workflowCardHeader"><div><span>IMPORT</span><strong>Nahrát technický výjezd</strong></div></div>
      <div className="workspaceFormRow">
        <label>
          <span>Typ</span>
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            {TECHNICAL_SERVICE_CATEGORIES.map((option) => <option key={option.id} value={option.id}>{option.labelCz}</option>)}
          </select>
        </label>
        <label className="filePicker">
          <span>{isParsing ? "Zpracovávám…" : "Vybrat PDF"}</span>
          <input
            type="file"
            accept="application/pdf"
            disabled={isParsing}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleFileSelected(file);
              event.target.value = "";
            }}
          />
        </label>
      </div>
      {detectedHint && <p className="fieldHint">Podle obsahu PDF vypadá spíš jako: {technicalServiceCategoryLabel(detectedHint)} — zkontrolujte vybraný typ.</p>}
      {existingImportsByCategory.has(category) && <p className="fieldHint">Pro tuto kategorii už existuje dřívější import — nahrání nového PDF nabídne jeho nahrazení.</p>}
      {error && <p className="uploadError">{error}</p>}
    </div>
  );
}
