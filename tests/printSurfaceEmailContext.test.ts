import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPrintSurfaceEmailAdditionalContext,
  buildPrintSurfaceEmailContext,
  buildPrintSurfaceEmailFreeText,
  PRINT_SURFACE_EMAIL_TEMPLATE_NAME,
} from "../domain/printSurfaceEmailContext.ts";
import type { PrintSurfaceExportRow } from "../domain/printSurfaceExport.ts";

function makeRow(overrides: Partial<PrintSurfaceExportRow> = {}): PrintSurfaceExportRow {
  return {
    label: overrides.label ?? "A",
    typeLabel: overrides.typeLabel ?? "Panel",
    surfaceName: overrides.surfaceName ?? "Panel stěnový 1 x 2,5 m",
    dimensionLabel: overrides.dimensionLabel ?? "950 × 2340 mm",
    quantity: overrides.quantity ?? 1,
    note: overrides.note ?? "",
    viewLabel: overrides.viewLabel ?? "Pohled 1",
  };
}

// =========================================================================================
// PDF FINAL DESIGN + AI EMAIL WORKFLOW (spec sections 13/24): email handoff context — reuses the
// EXISTING E-maily module (EmailsPage.tsx), never a second composer; never implies a real send
// happened; surfaces come from the SAME rows the PDF table renders (never re-derived).
// =========================================================================================

test("context obsahuje správnou firmu/event/realizačku/projekt/projectId", () => {
  const context = buildPrintSurfaceEmailContext({
    projectId: "project-1",
    companyName: "ACME s.r.o.",
    eventId: "event-1",
    eventName: "FOR BEAUTY",
    realizationCompanyName: "Creativ Expo",
    projectName: "Stánek XY",
    rows: [makeRow({ label: "A" })],
    revision: 1,
  });
  assert.equal(context.projectId, "project-1");
  assert.equal(context.companyName, "ACME s.r.o.");
  assert.equal(context.eventId, "event-1");
  assert.equal(context.eventName, "FOR BEAUTY");
  assert.equal(context.realizationCompanyName, "Creativ Expo");
  assert.equal(context.projectName, "Stánek XY");
  assert.equal(context.numberOfSurfaces, 1);
  assert.deepEqual(context.surfaces, [
    { label: "A", type: "Panel", displayName: "Panel stěnový 1 x 2,5 m", productionDimension: "950 × 2340 mm", quantity: 1, note: "" },
  ]);
});

test("revize se předává do kontextu (audit metadata), ale už není součástí viditelného freeText seedu", () => {
  const context = buildPrintSurfaceEmailContext({
    projectId: "p", companyName: "ACME", projectName: "X", rows: [], revision: 4,
  });
  assert.equal(context.revision, 4);
  assert.doesNotMatch(buildPrintSurfaceEmailFreeText(context), /revize|R4\b/iu);
});

test("language context: default je cs, ale libovolný jiný kód se předá beze změny (nikdy neblokuje ostatní jazyky)", () => {
  const defaultLang = buildPrintSurfaceEmailContext({ projectId: "p", companyName: "ACME", projectName: "X", rows: [], revision: 1 });
  assert.equal(defaultLang.languageCode, "cs");
  const german = buildPrintSurfaceEmailContext({ projectId: "p", companyName: "ACME", projectName: "X", rows: [], revision: 1, languageCode: "de" });
  assert.equal(german.languageCode, "de");
});

test("PDF export != sent: buildPrintSurfaceEmailContext/freeText nikdy netvrdí, že e-mail byl odeslán", () => {
  const withAttachment = buildPrintSurfaceEmailContext({
    projectId: "p", companyName: "ACME", projectName: "X", rows: [], revision: 1, pdfFileName: "Tiskove_plochy_X.pdf", pdfAssetStorageKey: "key/1",
  });
  assert.equal(withAttachment.attachmentAvailable, true);
  const freeText = buildPrintSurfaceEmailFreeText(withAttachment);
  assert.doesNotMatch(freeText, /odesláno|bylo zasláno|sent successfully/iu);
});

test("real-usage follow-up section 3: freeText NEVER contains a manual-attach instruction — attaching the file is a UI-only fact (EmailsPage), regardless of whether attachmentAvailable is true or false", () => {
  const withAttachment = buildPrintSurfaceEmailContext({
    projectId: "p", companyName: "ACME", projectName: "X", rows: [], revision: 1, pdfFileName: "Tiskove_plochy_X.pdf", pdfAssetStorageKey: "key/1",
  });
  const withoutAttachment = buildPrintSurfaceEmailContext({ projectId: "p", companyName: "ACME", projectName: "X", rows: [], revision: 1 });
  for (const context of [withAttachment, withoutAttachment]) {
    const freeText = buildPrintSurfaceEmailFreeText(context);
    assert.doesNotMatch(freeText, /přiložte|přiložit|attach/iu);
  }
});

test("reuse existing Email module infrastructure: a stable template NAME is exported for EmailsPage to preselect the system template by, no second composer type exists", () => {
  assert.equal(PRINT_SURFACE_EMAIL_TEMPLATE_NAME, "Podklady k tiskovým plochám");
});

test("numberOfSurfaces/surfaces jsou prázdné pro projekt bez ploch, freeText to zvládne beze pádu", () => {
  const context = buildPrintSurfaceEmailContext({ projectId: "p", companyName: "ACME", projectName: "X", rows: [], revision: 1 });
  assert.equal(context.numberOfSurfaces, 0);
  assert.deepEqual(context.surfaces, []);
  assert.equal(typeof buildPrintSurfaceEmailFreeText(context), "string");
});

test("surfaces obsahují množství a poznámku (structured data), ale viditelný freeText seed je nikdy nezobrazí", () => {
  const context = buildPrintSurfaceEmailContext({
    projectId: "p", companyName: "ACME", projectName: "X", revision: 1,
    rows: [makeRow({ label: "B", quantity: 3, note: "lepší papír" })],
  });
  assert.equal(context.surfaces[0]?.quantity, 3);
  assert.equal(context.surfaces[0]?.note, "lepší papír");
  const freeText = buildPrintSurfaceEmailFreeText(context);
  assert.doesNotMatch(freeText, /3 ks/u);
  assert.doesNotMatch(freeText, /lepší papír/u);
});

// =========================================================================================
// Real-usage follow-up sections 1/2/3: the visible seed never lists A/B/C surfaces or instructs
// manual attachment, but the SAME data stays available to the AI as structured grounding context.
// =========================================================================================

test("email visible seed neobsahuje seznam A/B/C ploch, ani jejich označení, i když je projekt obsahuje", () => {
  const context = buildPrintSurfaceEmailContext({
    projectId: "p", companyName: "ACME", projectName: "Stánek XY", eventName: "FOR BEAUTY", revision: 1,
    rows: [makeRow({ label: "A" }), makeRow({ label: "B" }), makeRow({ label: "C" })],
  });
  const freeText = buildPrintSurfaceEmailFreeText(context);
  assert.doesNotMatch(freeText, /^-\s*[A-Z]\s*—/mu);
  assert.doesNotMatch(freeText, /Tiskové plochy:/u);
});

test("structured AI context (additionalContext) seznam ploch STÁLE obsahuje — dostupné AI ke groundingu, i když se v seedu nezobrazuje", () => {
  const context = buildPrintSurfaceEmailContext({
    projectId: "p", companyName: "ACME", projectName: "Stánek XY", revision: 1,
    rows: [makeRow({ label: "A", quantity: 2, note: "matná fólie" }), makeRow({ label: "B" })],
  });
  const additionalContext = buildPrintSurfaceEmailAdditionalContext(context);
  assert.equal(additionalContext.length, 2);
  assert.match(additionalContext[0]!, /^A —/u);
  assert.match(additionalContext[0]!, /2 ks/u);
  assert.match(additionalContext[0]!, /matná fólie/u);
  assert.match(additionalContext[1]!, /^B —/u);
});

test("nový zjednodušený email intent zmiňuje projekt/event a přílohu s přehledem, bez seznamu a bez manuální instrukce k přiložení", () => {
  const context = buildPrintSurfaceEmailContext({
    projectId: "p", companyName: "ACME", projectName: "Stánek XY", eventName: "FOR BEAUTY", revision: 1,
    rows: [makeRow({ label: "A" })],
  });
  const freeText = buildPrintSurfaceEmailFreeText(context);
  assert.match(freeText, /Stánek XY/u);
  assert.match(freeText, /FOR BEAUTY/u);
  assert.match(freeText, /přehled/iu);
  assert.doesNotMatch(freeText, /přiložte|přiložit/iu);
  assert.doesNotMatch(freeText, /^-\s/mu);
});

test("exportId/pdfAssetStorageKey se předávají beze změny — vážou handoff na konkrétní export history záznam a StoredAsset", () => {
  const context = buildPrintSurfaceEmailContext({
    projectId: "p", companyName: "ACME", projectName: "X", rows: [], revision: 1,
    exportId: "export-1", pdfAssetStorageKey: "storage/key-1", pdfFileName: "Tiskove_plochy_R01.pdf",
  });
  assert.equal(context.exportId, "export-1");
  assert.equal(context.pdfAssetStorageKey, "storage/key-1");
  assert.equal(context.pdfFileName, "Tiskove_plochy_R01.pdf");
});
