import test from "node:test";
import assert from "node:assert/strict";
import { buildPrintSurfaceExportFileName } from "../domain/printSurfaceExport.ts";

// =========================================================================================
// Real-usage follow-up (spec section 4): one STABLE human-readable filename per project — the
// project's own NAME, never companyName, and never a revision (one current PDF artifact, so
// every regeneration of the SAME project must produce the exact same filename).
// =========================================================================================

test("event + projectName produce the exact documented pattern", () => {
  const name = buildPrintSurfaceExportFileName({ eventName: "FOR BEAUTY", projectName: "Test 001" });
  assert.equal(name, "Tiskove_plochy_FOR_BEAUTY_Test_001.pdf");
});

test("filename uses projectName, never companyName", () => {
  const name = buildPrintSurfaceExportFileName({ eventName: "FOR BEAUTY", projectName: "Stánek XY" });
  assert.match(name, /Stanek_XY/u);
});

test("filename never contains a revision segment", () => {
  const name = buildPrintSurfaceExportFileName({ eventName: "FOR BEAUTY", projectName: "Test 001" });
  assert.doesNotMatch(name, /_R\d/iu);
  assert.doesNotMatch(name, /revision/iu);
});

test("the SAME inputs always produce the SAME filename — no regeneration counter, one current artifact per project", () => {
  const first = buildPrintSurfaceExportFileName({ eventName: "FOR BEAUTY", projectName: "Test 001" });
  const second = buildPrintSurfaceExportFileName({ eventName: "FOR BEAUTY", projectName: "Test 001" });
  assert.equal(first, second);
});

test("Czech diacritics are sanitized to plain ASCII, same convention as Graphics Export", () => {
  const name = buildPrintSurfaceExportFileName({ eventName: "FOR ARCH", projectName: "Krásná Žížala s.r.o." });
  assert.doesNotMatch(name, /[áéíóúýčďěňřšťůž]/iu);
  assert.match(name, /Krasna_Zizala/u);
});

test("unsafe filesystem characters and duplicate whitespace are removed/collapsed", () => {
  const name = buildPrintSurfaceExportFileName({ eventName: 'FOR: BEAUTY/2026', projectName: "A   B\\C" });
  assert.doesNotMatch(name, /[/\\:*?"<>|]/u);
  assert.doesNotMatch(name, /__/u);
});

test("a missing event or project name is simply omitted, never a literal 'undefined' or a double underscore", () => {
  const noEvent = buildPrintSurfaceExportFileName({ projectName: "Test 001" });
  assert.equal(noEvent, "Tiskove_plochy_Test_001.pdf");
  const neitherNamed = buildPrintSurfaceExportFileName({});
  assert.equal(neitherNamed, "Tiskove_plochy.pdf");
  assert.doesNotMatch(neitherNamed, /undefined/iu);
  assert.doesNotMatch(neitherNamed, /__/u);
});

test("always ends in .pdf and always starts with the fixed Tiskove_plochy prefix", () => {
  const name = buildPrintSurfaceExportFileName({ eventName: "X", projectName: "Y" });
  assert.ok(name.startsWith("Tiskove_plochy_"));
  assert.ok(name.endsWith(".pdf"));
});
