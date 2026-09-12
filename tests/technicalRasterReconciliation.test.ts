import assert from "node:assert/strict";
import test from "node:test";
import {
  reconcileTechnicalReportAndCatalog,
  resolveCanonicalServiceVariant,
  type TechnicalReconciliationMention,
} from "../domain/technicalRasterReconciliation.ts";

function mention(overrides: Partial<TechnicalReconciliationMention> = {}): TechnicalReconciliationMention {
  return { standNumber: "3C09", category: "electricity", externalLabel: "Do 2kW 230V", quantity: 1, ...overrides };
}

// ============================================================================
// Corrective batch section 8 — supplemental PDF reconciliation/dedup engine.
// ============================================================================

test("canonical variant: two differently-worded real electricity labels for the SAME fact normalize to the SAME variant (spec's own example pair)", () => {
  const a = resolveCanonicalServiceVariant("electricity", "Do 2 kW 230V");
  const b = resolveCanonicalServiceVariant("electricity", "ELEKTRICKÁ ENERGIE - PŘÍKON DO 2 kW/230");
  assert.equal(a, b);
});

test("canonical variant: different kW values are DIFFERENT variants, never merged", () => {
  assert.notEqual(resolveCanonicalServiceVariant("electricity", "Do 2kW 230V"), resolveCanonicalServiceVariant("electricity", "Do 5kW 230V"));
});

test("SHODA: same stand/category/variant/quantity in both sources", () => {
  const report = [mention({ quantity: 1 })];
  const catalog = [mention({ externalLabel: "ELEKTRICKÁ ENERGIE - PŘÍKON DO 2 kW/230", quantity: 1 })];
  const outcomes = reconcileTechnicalReportAndCatalog(report, catalog);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.status, "shoda");
});

test("only_report: report mentions it, catalog never does", () => {
  const outcomes = reconcileTechnicalReportAndCatalog([mention()], []);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.status, "only_report");
});

test("only_catalog: catalog mentions it, no primary report does", () => {
  const outcomes = reconcileTechnicalReportAndCatalog([], [mention()]);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.status, "only_catalog");
});

test("quantity mismatch: same variant, different quantities — never silently averaged/summed/picked", () => {
  const outcomes = reconcileTechnicalReportAndCatalog([mention({ quantity: 1 })], [mention({ quantity: 2 })]);
  assert.equal(outcomes.length, 1);
  assert.deepEqual(outcomes[0], { status: "quantity_mismatch", standNumber: "3C09", category: "electricity", variant: "2kw", reportQuantity: 1, catalogQuantity: 2 });
});

test("KONFLIKT: report = 2 kW, katalog = 5 kW (spec's own example) — never reported as two unrelated 'only' rows", () => {
  const outcomes = reconcileTechnicalReportAndCatalog(
    [mention({ externalLabel: "Do 2kW 230V" })],
    [mention({ externalLabel: "Do 5kW 230V" })],
  );
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.status, "conflict");
  if (outcomes[0]!.status === "conflict") {
    assert.equal(outcomes[0]!.reason, "different_variant");
  }
});

test("KONFLIKT: report = 2 kW, katalog = BEZ ELEKTRICKÉ ENERGIE (spec's own example) — catalog negation overrides plain dedup", () => {
  const outcomes = reconcileTechnicalReportAndCatalog(
    [mention({ externalLabel: "Do 2kW 230V" })],
    [mention({ externalLabel: "BEZ ELEKTRICKÉ ENERGIE", negated: true })],
  );
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.status, "conflict");
  if (outcomes[0]!.status === "conflict") assert.equal(outcomes[0]!.reason, "catalog_negates_report");
});

test("a catalog negation the report AGREES with (report also never mentions the category) produces NO finding at all — agreement is not a review item", () => {
  const outcomes = reconcileTechnicalReportAndCatalog([], [mention({ externalLabel: "BEZ ELEKTRICKÉ ENERGIE", negated: true })]);
  assert.equal(outcomes.length, 0);
});

test("a stand with TWO real point services (electricity + internet) reconciles each category independently", () => {
  const report = [mention(), mention({ category: "internet", externalLabel: "Pevná IP" })];
  const catalog = [mention({ externalLabel: "ELEKTRICKÁ ENERGIE - PŘÍKON DO 2 kW/230" }), mention({ category: "internet", externalLabel: "Pevná IP" })];
  const outcomes = reconcileTechnicalReportAndCatalog(report, catalog);
  assert.equal(outcomes.length, 2);
  assert.ok(outcomes.every((outcome) => outcome.status === "shoda"));
});

test("multiple report rows for the SAME variant are summed before comparison, never overwritten by the last one seen", () => {
  const report = [mention({ quantity: 1 }), mention({ quantity: 1 })];
  const catalog = [mention({ quantity: 2 })];
  const outcomes = reconcileTechnicalReportAndCatalog(report, catalog);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.status, "shoda");
});

test("stand numbers are matched via the SAME normalization the rest of the app uses (normalizeStandNumber — whitespace-insensitive, never a raw exact-string stand key)", () => {
  const outcomes = reconcileTechnicalReportAndCatalog(
    [mention({ standNumber: " 3 C 09 " })],
    [mention({ standNumber: "3C09", externalLabel: "ELEKTRICKÁ ENERGIE - PŘÍKON DO 2 kW/230" })],
  );
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.status, "shoda");
});

test("a genuinely unknown category still dedupes via normalized (never raw exact-string) label text", () => {
  const outcomes = reconcileTechnicalReportAndCatalog(
    [mention({ category: "other", externalLabel: "  Nějaká Služba  " })],
    [mention({ category: "other", externalLabel: "nějaká služba" })],
  );
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.status, "shoda");
});

test("empty inputs never crash and produce no findings", () => {
  assert.deepEqual(reconcileTechnicalReportAndCatalog([], []), []);
});

// ============================================================================
// REAL-FIXTURE REGRESSION (corrective batch 3rd, section 14) — reverses the earlier batch's
// decision below: the previous batch treated report "Lednicový okruh" vs catalog "NOČNÍ PROUD" as a
// genuine conflict, since this app had no confirmed proof they were the same real service. Further
// real manual acceptance (stand 1B05, "Decor 26 - elektrická energie.pdf" vs the real
// "5. Stavby - tisk vše katalog" export) confirmed they in fact ARE this ABF catalog's own two
// names for the exact same refrigerated-circuit variant — the false conflict is now fixed via an
// ABF-vocabulary-specific alias (`isAbfNightCurrentRefrigeratedCatalogLabel` in
// domain/technicalRasterReconciliation.ts), scoped to reconciliation only, never touching the
// shared LIVE presentation resolver a report's own label still renders through.
// ============================================================================

test("REAL FIXTURE CASE (1B05): report 'Lednicový okruh' vs catalog 'ELEKTRICKÁ ENERGIE - NOČNÍ PROUD (LEDNI...' (the real, OCR-truncated wording) for the SAME stand is now SHODA, never a false conflict", () => {
  const outcomes = reconcileTechnicalReportAndCatalog(
    [mention({ standNumber: "1B05", externalLabel: "Lednicový okruh" })],
    [mention({ standNumber: "1B05", externalLabel: "ELEKTRICKÁ ENERGIE - NOČNÍ PROUD (LEDNI" })],
  );
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.status, "shoda");
});

test("canonical variant: 'NOČNÍ PROUD' wording (plain, parenthesized, and the real OCR-truncated catalog form) all resolve to the SAME electricity variant as 'Lednicový okruh'", () => {
  const base = resolveCanonicalServiceVariant("electricity", "Lednicový okruh");
  assert.equal(base, "refrigerated");
  assert.equal(resolveCanonicalServiceVariant("electricity", "NOČNÍ PROUD"), base);
  assert.equal(resolveCanonicalServiceVariant("electricity", "NOČNÍ PROUD (LEDNICOVÝ OKRUH)"), base);
  assert.equal(resolveCanonicalServiceVariant("electricity", "ELEKTRICKÁ ENERGIE - NOČNÍ PROUD (LEDNI"), base);
});

// ============================================================================
// REAL-FIXTURE REGRESSION (corrective batch 3rd, section 13) — stand 1C01: report "denni uklid",
// catalog "uklid denni" (word order reversed) — the SAME real cleaning service, previously a false
// CONFLICT since word order affected the normalized comparison key.
// ============================================================================

test("REAL FIXTURE CASE (1C01): report 'denni uklid' vs catalog 'uklid denni' (reversed word order) is SHODA, never a false conflict", () => {
  const outcomes = reconcileTechnicalReportAndCatalog(
    [mention({ standNumber: "1C01", category: "cleaning", externalLabel: "denni uklid" })],
    [mention({ standNumber: "1C01", category: "cleaning", externalLabel: "uklid denni" })],
  );
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]!.status, "shoda");
});

test("canonical variant: cleaning word order never affects the canonical variant, but a genuinely different cleaning service is still distinct", () => {
  assert.equal(resolveCanonicalServiceVariant("cleaning", "denni uklid"), resolveCanonicalServiceVariant("cleaning", "uklid denni"));
  assert.equal(resolveCanonicalServiceVariant("cleaning", "denní úklid"), resolveCanonicalServiceVariant("cleaning", "úklid denní"));
  assert.notEqual(resolveCanonicalServiceVariant("cleaning", "denni uklid"), resolveCanonicalServiceVariant("cleaning", "generální úklid"));
});
