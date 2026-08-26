import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const globalsCss = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const planExportSource = readFileSync(new URL("../lib/planExport.ts", import.meta.url), "utf8");
const workflowStepsSource = readFileSync(new URL("../components/workflow/WorkflowSteps.tsx", import.meta.url), "utf8");
const graphicsExportPanelSource = readFileSync(new URL("../components/workflow/GraphicsExportPanel.tsx", import.meta.url), "utf8");

// =========================================================================================
// Graphics Export v1.1 root cause: #customer-calculation and #graphics-export-document were
// BOTH always present in the Export step's DOM, and the shared @media print visibility rule
// made both visible on EVERY print regardless of which button was clicked — so a Graphics
// Export printout also contained the whole customer calculation (booth/furniture pricing,
// technical visuals, VAT table, project total). Fixed via an explicit data-print-target
// attribute scoping every print rule — never a z-index/position hack.
// =========================================================================================

test("PRINT TARGET MECHANISM: app/globals.css scopes BOTH documents' print visibility under body[data-print-target=...] — never an unconditional #id selector", () => {
  const printBlock = globalsCss.match(/@media print \{[\s\S]*?\n\}/u);
  assert.ok(printBlock, "expected to find the @media print block");
  assert.doesNotMatch(printBlock![0], /^\s*#customer-calculation,\s*$/mu, "must not have a bare, target-unscoped #customer-calculation visibility rule");
  assert.match(printBlock![0], /body\[data-print-target="customer-calculation"\] #customer-calculation/u);
  assert.match(printBlock![0], /body\[data-print-target="graphics-export"\] #graphics-export-document/u);
});

test("PRINT TARGET MECHANISM: neither document's ACTUAL CSS RULE references the other's id — customer-calculation's selector/declaration lines never mention graphics-export-document and vice versa (doc-comment prose describing the fix is not a rule)", () => {
  const printBlock = globalsCss.match(/@media print \{[\s\S]*?\n\}/u)![0];
  const ruleLines = printBlock.split("\n").filter((line) => /[{};]/u.test(line) && !line.trim().startsWith("*") && !line.trim().startsWith("/*"));
  const customerCalcLines = ruleLines.filter((line) => line.includes("customer-calculation"));
  const graphicsExportLines = ruleLines.filter((line) => line.includes("graphics-export-document"));
  assert.ok(customerCalcLines.length > 0 && graphicsExportLines.length > 0, "sanity: both rule sets actually exist");
  assert.ok(customerCalcLines.every((line) => !line.includes("graphics-export-document")));
  assert.ok(graphicsExportLines.every((line) => !line.includes("#customer-calculation")));
});

test("PRINT TARGET HELPER: printDocument() sets data-print-target before calling window.print() — never a bare window.print() left in either caller", () => {
  assert.match(planExportSource, /document\.body\.dataset\.printTarget = target/u);
  assert.match(planExportSource, /window\.print\(\)/u);
  assert.doesNotMatch(workflowStepsSource, /onClick=\{\(\) => window\.print\(\)\}/u);
  assert.doesNotMatch(graphicsExportPanelSource, /onClick=\{\(\) => window\.print\(\)\}/u);
});

test("CUSTOMER CALCULATION BUTTON: uses printDocument(\"customer-calculation\")", () => {
  assert.match(workflowStepsSource, /printDocument\("customer-calculation"\)/u);
});

test("GRAPHICS EXPORT BUTTON: uses printDocument(\"graphics-export\")", () => {
  assert.match(graphicsExportPanelSource, /printDocument\("graphics-export"\)/u);
});

test("NO Z-INDEX/POSITION HACK: the print isolation fix is visibility/display-based only — no actual z-index CSS DECLARATION (the doc comment's prose mentioning the word doesn't count)", () => {
  const printBlock = globalsCss.match(/@media print \{[\s\S]*?\n\}/u)![0];
  assert.doesNotMatch(printBlock, /z-index\s*:/u);
});

test("GRAPHICS EXPORT CONTENT: GraphicsExportPanel's printable document never references booth/furniture pricing rows, VAT, or the customer calculation view model — it only renders graphics export rows", () => {
  assert.doesNotMatch(graphicsExportPanelSource, /calculationExport|CustomerCalculationViewModel|calculation\.priceRows|totals\.vat|totals\.gross/u);
});

test("GRAPHICS EXPORT CONTENT: the printable graphics-export-document article contains no booth/furniture/technical-visual section — only graphicsExportDocumentGroup cards built from GraphicsExportRow", () => {
  const article = graphicsExportPanelSource.match(/<article id="graphics-export-document"[\s\S]*?\n      <\/article>/u);
  assert.ok(article, "expected to find the graphics-export-document article");
  assert.doesNotMatch(article![0], /boothPrice|groupedFurniture|priceRows|calculationImages/u);
});
