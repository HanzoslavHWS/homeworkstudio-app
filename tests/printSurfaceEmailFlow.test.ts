import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// =========================================================================================
// PDF FINAL DESIGN + AI EMAIL WORKFLOW — this codebase has no DOM/component test runner (see
// tests/visualizationRenderUI.test.ts's own doc note), so React component behavior that can't be
// exercised as a pure function is verified as a SOURCE CONTRACT: regex assertions against the
// actual component source, the same established pattern used across this repo's UI test files.
// =========================================================================================

const exportPanelSource = readFileSync(new URL("../components/workflow/printSurfaces/PrintSurfaceExportPanel.tsx", import.meta.url), "utf8");
const emailsPageSource = readFileSync(new URL("../components/workflow/EmailsPage.tsx", import.meta.url), "utf8");
const boothGeneratorSource = readFileSync(new URL("../components/BoothGenerator.tsx", import.meta.url), "utf8");

function extractFunction(source: string, name: string): string {
  const match = source.match(new RegExp(`(?:function|async function) ${name}\\([\\s\\S]*?\\n  \\}\\n`, "u"));
  assert.ok(match, `expected to find function ${name}`);
  return match![0];
}

test("Prepare email reuses the current PDF when fresh, and regenerates first (generateAndUploadCurrentPdf) only when missing/stale, before building the email context", () => {
  const handleEmailHandoff = extractFunction(exportPanelSource, "handleEmailHandoff");
  assert.match(handleEmailHandoff, /pdfIsCurrent && project\.latestPdf/u);
  assert.match(handleEmailHandoff, /await generateAndUploadCurrentPdf\(\)/u);
  assert.match(handleEmailHandoff, /buildPrintSurfaceEmailContext\(/u);
});

test("StoredAsset filename matches the download/email filename: both come from the SAME `fileName` variable, never a second naming call", () => {
  const generate = extractFunction(exportPanelSource, "generateAndUploadCurrentPdf");
  assert.match(generate, /const fileName = buildPrintSurfaceExportFileName\(/u);
  assert.match(generate, /new File\(\[new Uint8Array\(bytes\)\], fileName,/u);
  assert.match(generate, /displayName: fileName/u);
});

test("email context is built from the SAME viewModel the PDF was rendered from (pdf.viewModel.rows), never re-derived independently from project.items", () => {
  const handoff = extractFunction(exportPanelSource, "handleEmailHandoff");
  assert.match(handoff, /rows: pdf\.viewModel\.rows/u);
  assert.doesNotMatch(handoff, /resolveDimension/u);
  assert.doesNotMatch(handoff, /items: project\.items/u);
});

test("company/event/realization/revision/exportId passed to the email context come from the export's own viewModel/record, not re-typed literals", () => {
  const handoff = extractFunction(exportPanelSource, "handleEmailHandoff");
  assert.match(handoff, /companyName: pdf\.viewModel\.companyName/u);
  assert.match(handoff, /projectName: pdf\.viewModel\.projectName/u);
  assert.match(handoff, /realizationCompanyName,/u);
  assert.match(handoff, /revision: nextPrintSurfaceExportRevision\(existingExports\.length\)/u);
  assert.match(handoff, /exportId: record\.id/u);
  assert.match(handoff, /pdfAssetStorageKey: pdf\.storageKey/u);
});

test("one current PDF per project: latestPdf reported via onPdfGenerated carries a stable fileName and a content fingerprint, never a per-export revision in its own shape", () => {
  const generate = extractFunction(exportPanelSource, "generateAndUploadCurrentPdf");
  assert.match(generate, /onPdfGenerated\(\{/u);
  assert.match(generate, /storageKey: asset\.storageKey/u);
  assert.match(generate, /projectFingerprint: buildPrintSurfaceProjectFingerprint\(project\)/u);
});

test("export button label reflects PDF state: none -> Vygenerovat, current -> Stáhnout, stale -> Aktualizovat", () => {
  assert.match(exportPanelSource, /const exportButtonLabel = !project\.latestPdf \? "Vygenerovat PDF" : pdfIsCurrent \? "Stáhnout PDF" : "Aktualizovat PDF";/u);
});

test("Stáhnout PDF (current) skips regeneration entirely — only a stale/missing PDF triggers generateAndUploadCurrentPdf", () => {
  const handleExportButtonClick = extractFunction(exportPanelSource, "handleExportButtonClick");
  assert.match(handleExportButtonClick, /pdfIsCurrent && project\.latestPdf\s*\n\s*\? \{ storageKey: project\.latestPdf\.storageKey, fileName: project\.latestPdf\.fileName \}\s*\n\s*: await generateAndUploadCurrentPdf\(\)/u);
});

test("downloaded filename always matches the logical PDF name: handleExportButtonClick passes pdf.fileName to getAssetDownloadUrl, never just the raw storageKey", () => {
  const handleExportButtonClick = extractFunction(exportPanelSource, "handleExportButtonClick");
  assert.match(handleExportButtonClick, /getAssetDownloadUrl\(pdf\.storageKey, pdf\.fileName\)/u);
});

test("mailto receives subject and body: openInOutlook builds a mailto: URL from the current AI result", () => {
  const openInOutlook = extractFunction(emailsPageSource, "openInOutlook");
  assert.match(openInOutlook, /mailto:\?subject=\$\{encodeURIComponent\(result\.subject\)\}&body=\$\{encodeURIComponent\(result\.body\)\}/u);
});

test("draft creation does NOT mark the print-surfaces project as sent: openInOutlook may read printSurfaceContext for the attachment, but never calls anything mark-sent-shaped, on the Graph path or the mailto fallback", () => {
  const openInOutlook = extractFunction(emailsPageSource, "openInOutlook");
  assert.doesNotMatch(openInOutlook, /markSent/u);
  assert.doesNotMatch(openInOutlook, /PrintSurfaceProjectStatus|status: ?"sent"/u);
  assert.match(openInOutlook, /mailto:\?subject=/u);
});

test("Otevřít v Outlooku attempts a real Outlook draft first (current PDF attached via printSurfaceContext) and falls back to mailto: only when that path fails/503s", () => {
  const openInOutlook = extractFunction(emailsPageSource, "openInOutlook");
  assert.match(openInOutlook, /fetch\("\/api\/emails\/outlook-draft"/u);
  assert.match(openInOutlook, /storageKey: printSurfaceContext\.pdfAssetStorageKey/u);
  assert.match(openInOutlook, /catch \{/u);
});

test("attachment card references the correct PDF asset: downloadPreparedPdf resolves the download URL from the handoff context's own pdfAssetStorageKey, and passes pdfFileName through so the browser saves it under the logical name, not the raw storageKey", () => {
  const download = extractFunction(emailsPageSource, "downloadPreparedPdf");
  assert.match(download, /printSurfaceContext\?\.pdfAssetStorageKey/u);
  assert.match(download, /getAssetDownloadUrl\(printSurfaceContext\.pdfAssetStorageKey, printSurfaceContext\.pdfFileName\)/u);
});

test("attachment card UI shows the filename and a manual-attach note near 'Otevřít v Outlooku', never claiming an automatic attachment", () => {
  assert.match(emailsPageSource, /PDF připraveno:/u);
  assert.match(emailsPageSource, /\{printSurfaceContext\.pdfFileName\}/u);
  assert.match(emailsPageSource, /PDF je připravené\. Po otevření Outlooku jej přiložte k e-mailu\./u);
});

test("confirm sent marks the correct export/project: handleMarkSent calls markSent with the last export-history record's own id, gated on one already existing", () => {
  const handleMarkSent = extractFunction(exportPanelSource, "handleMarkSent");
  assert.match(handleMarkSent, /if \(!lastExportId\) return;/u);
  assert.match(handleMarkSent, /exportRepository\.markSent\(lastExportId,/u);
  assert.match(handleMarkSent, /onMarkSent\(\);/u);
});

test("return-to-project retains sourceProjectId: EmailsPage passes the handoff context's own projectId back to onReturnToPrintSurfaces", () => {
  assert.match(emailsPageSource, /onClick=\{\(\) => onReturnToPrintSurfaces\(printSurfaceContext\.projectId\)\}/u);
});

test("BoothGenerator wires the return-to-project id through navigateWorkspace's printSurfaceProjectId payload, and clears it on any other navigation", () => {
  assert.match(boothGeneratorSource, /function handleReturnToPrintSurfaces\(projectId: string\) \{\s*navigateWorkspace\("printSurfaces", \{ printSurfaceProjectId: projectId \}\);/u);
  assert.match(boothGeneratorSource, /setPrintSurfaceProjectPreselect\(section === "printSurfaces" \? payload\?\.printSurfaceProjectId : undefined\);/u);
});

test("pricing UI is hidden: no 'Zahrnout do kalkulace' checkbox or price summary/toggle remain in the print-surfaces editor or export menu", () => {
  const inspectorSource = readFileSync(new URL("../components/workflow/printSurfaces/PrintSurfaceInspector.tsx", import.meta.url), "utf8");
  const editorSource = readFileSync(new URL("../components/workflow/printSurfaces/PrintSurfaceEditorPage.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(inspectorSource, /Zahrnout do kalkulace/u);
  assert.doesNotMatch(inspectorSource, /printSurfacePricingBlock/u);
  assert.doesNotMatch(editorSource, /printSurfacePriceSummary/u);
  assert.doesNotMatch(exportPanelSource, /Zobrazit ceny/u);
  assert.match(exportPanelSource, /showPrices: false/u);
});

test("project list exposes a current-PDF quick action (Stáhnout PDF) plus a freshness badge, without opening the editor or regenerating anything", () => {
  const listPageSource = readFileSync(new URL("../components/workflow/printSurfaces/PrintSurfaceProjectListPage.tsx", import.meta.url), "utf8");
  assert.match(listPageSource, /project\.latestPdf/u);
  assert.match(listPageSource, />Stáhnout PDF<\/button>/u);
  assert.match(listPageSource, /PDF aktuální/u);
  assert.match(listPageSource, /PDF není aktuální/u);
  // quick download only resolves the existing storageKey — it must never call buildPrintSurfacePdf/generate anything itself.
  const handleDownloadPdf = extractFunction(listPageSource, "handleDownloadPdf");
  assert.doesNotMatch(handleDownloadPdf, /buildPrintSurfacePdf|generateAndUpload/u);
  assert.match(handleDownloadPdf, /getAssetDownloadUrl\(storageKey, fileName\)/u);
});

test("AI prompt does not invent a missing deadline: the print-surfaces aiInstruction never mentions one itself, and it's steered through the SAME generic prompt builder whose NO_FABRICATION_RULE already forbids inventing dates/deadlines (see tests/emailAiPrompt.test.ts)", () => {
  const migrationSource = readFileSync(new URL("../supabase/migrations/20260907120000_print_surfaces_email_template.sql", import.meta.url), "utf8");
  assert.doesNotMatch(migrationSource, /deadline|lhůta|termín/iu);
  assert.match(emailsPageSource, /templateInstruction,\s*\n\s*eventContext:/u);
});

test("subject receives event/company context: the aiInstruction nudges a subject naming the event/company (never a hardcoded literal example), and generate() still posts the real eventContext alongside it", () => {
  const migrationSource = readFileSync(new URL("../supabase/migrations/20260907120000_print_surfaces_email_template.sql", import.meta.url), "utf8");
  assert.match(migrationSource, /subject line naming the event and the company/iu);
  assert.doesNotMatch(migrationSource, /Beauty Brand s\.r\.o\.|FOR BEAUTY 2026/u);
});

test("export menu is exactly the two documented actions (dynamic PDF-state label + Připravit e-mail) plus the separate confirm-sent action — no leftover browser print-preview action", () => {
  assert.match(exportPanelSource, /onClick=\{\(\) => void handleExportButtonClick\(\)\}>\{exportButtonLabel\}<\/button>/u);
  assert.match(exportPanelSource, />Připravit e-mail<\/button>/u);
  assert.doesNotMatch(exportPanelSource, /Tiskový přehled/u);
  assert.doesNotMatch(exportPanelSource, /window\.open\("", "_blank"\)/u);
});
