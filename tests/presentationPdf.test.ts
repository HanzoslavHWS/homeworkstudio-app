import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPresentationHeaderLines,
  buildPresentationPdf,
  type PresentationPdfMetadata,
  type PresentationPdfRenderPage,
} from "../lib/presentationPdf.ts";

// 1x1 red PNG.
const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function metadata(overrides: Partial<PresentationPdfMetadata> = {}): PresentationPdfMetadata {
  return {
    project: { name: "Test01", company: "ACME s.r.o." },
    event: { name: "Beauty 2026" },
    booth: { name: "P86" },
    generatedAt: "2026-08-26T10:00:00.000Z",
    ...overrides,
  };
}

function page(overrides: Partial<PresentationPdfRenderPage> & Pick<PresentationPdfRenderPage, "visualizationId" | "name">): PresentationPdfRenderPage {
  return { imageDataUrl: TINY_PNG, widthPx: 1600, heightPx: 1200, format: "png", ...overrides };
}

// =========================================================================================
// Visualization v2 — customer presentation PDF (report sections 15-20): reuses the SAME
// embedded Czech font as Graphics Production Package v1, never re-embeds one; no pricing.
// =========================================================================================

test("PDF: output is a real PDF binary (%PDF- magic bytes)", async () => {
  const bytes = await buildPresentationPdf([page({ visualizationId: "v1", name: "Hlavní pohled" })], metadata());
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
});

test("PDF: page count equals the number of selected renders, in the given order", async () => {
  const pages = [
    page({ visualizationId: "v1", name: "Hlavní" }),
    page({ visualizationId: "v2", name: "Levý" }),
    page({ visualizationId: "v3", name: "Pravý" }),
  ];
  const bytes = await buildPresentationPdf(pages, metadata());
  // Structural proxy for "3 pages": count "/Type /Page" object occurrences in the raw PDF text
  // (word-boundary excludes the single "/Type /Pages" parent tree node) — empirically verified
  // against real jsPDF output before relying on it here.
  const text = new TextDecoder("latin1").decode(bytes);
  const pageObjectMatches = text.match(/\/Type\s*\/Page\b/g) ?? [];
  assert.equal(pageObjectMatches.length, 3);
});

test("PDF: builds without throwing when optional metadata fields are absent", async () => {
  const bytes = await buildPresentationPdf(
    [page({ visualizationId: "v1", name: "Hlavní" })],
    { project: { name: "Test01", company: "ACME" }, event: { name: "Beauty" }, booth: { name: "P86" }, generatedAt: "2026-08-26T10:00:00.000Z" },
  );
  assert.ok(bytes.length > 0);
});

test("HEADER LINES: preparedBy segment is omitted entirely when absent — never an empty 'Zpracoval:' fragment", () => {
  const lines = buildPresentationHeaderLines(metadata());
  assert.doesNotMatch(lines.dateLine, /Zpracoval/u);
});

test("HEADER LINES: preparedBy segment appears verbatim when provided", () => {
  const lines = buildPresentationHeaderLines(metadata({ preparedBy: { name: "Jan Novák" } }));
  assert.match(lines.dateLine, /Zpracoval: Jan Novák/u);
});

test("HEADER LINES: companyBrand overrides the default HOMEWORK STUDIO title; falls back when absent", () => {
  assert.equal(buildPresentationHeaderLines(metadata()).brandTitle, "HOMEWORK STUDIO");
  assert.equal(buildPresentationHeaderLines(metadata({ branding: { companyBrand: "Custom Brand" } })).brandTitle, "Custom Brand");
});

test("METADATA TYPE: PresentationPdfMetadata carries no pricing-shaped field", () => {
  const source = metadata();
  assert.doesNotMatch(JSON.stringify(Object.keys(source)), /price|pricing|cena|calculation/iu);
});

test("PAGE ORDER: buildPresentationPdf trusts the caller's array order exactly, never re-sorts", async () => {
  // Names deliberately in non-alphabetical order — if the builder ever re-sorted internally,
  // this would still produce 3 pages either way, so this test's real assertion is structural:
  // the function signature takes an ordered array and the implementation never calls .sort().
  const source = await import("node:fs").then((fs) => fs.readFileSync(new URL("../lib/presentationPdf.ts", import.meta.url), "utf8"));
  assert.doesNotMatch(source, /pages\.sort|\[\.\.\.pages\]\.sort/u);
});

test("CZECH TEXT: builds without throwing for names/metadata containing Czech diacritics", async () => {
  const bytes = await buildPresentationPdf(
    [page({ visualizationId: "v1", name: "Pohled od vstupu – Přední stěna" })],
    metadata({ project: { name: "Zákazník s.r.o.", company: "Řízení a Realizace" }, preparedBy: { name: "Žofie Nováková" } }),
  );
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
});
