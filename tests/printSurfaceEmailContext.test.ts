import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPrintSurfaceEmailContext,
  buildPrintSurfaceEmailFreeText,
  PRINT_SURFACE_EMAIL_TEMPLATE_NAME,
} from "../domain/printSurfaceEmailContext.ts";
import type { PrintSurfaceItem, PrintSurfaceItemDimensionResolution } from "../domain/printSurfaceProject.ts";
import type { PrintSurfacePreset } from "../domain/printSurfacePreset.ts";

function makeItem(overrides: Partial<PrintSurfaceItem> = {}): PrintSurfaceItem {
  return {
    id: overrides.id ?? "item-1",
    label: overrides.label ?? "A",
    typeId: overrides.typeId ?? "panel",
    note: overrides.note ?? "",
    presetId: overrides.presetId,
    includeInCalculation: overrides.includeInCalculation ?? false,
  };
}

const AVAILABLE: PrintSurfaceItemDimensionResolution = { status: "available", widthMm: 950, heightMm: 2340, source: "catalog" };
const PRESETS: readonly PrintSurfacePreset[] = [{ id: "Panel_S_100", typeId: "panel", name: "Panel stěnový 1 x 2,5 m", isActive: true }];

// =========================================================================================
// Print Surfaces V5 (spec section 17): email handoff context — reuses the EXISTING E-maily
// module (EmailsPage.tsx), never a second composer; never implies a real send happened.
// =========================================================================================

test("context obsahuje správnou firmu/event/realizačku/projekt", () => {
  const context = buildPrintSurfaceEmailContext({
    companyName: "ACME s.r.o.",
    eventId: "event-1",
    eventName: "FOR BEAUTY",
    realizationCompanyName: "Creativ Expo",
    projectName: "Stánek XY",
    items: [makeItem({ id: "a", label: "A", presetId: "Panel_S_100" })],
    presets: PRESETS,
    resolveDimension: () => AVAILABLE,
    revision: 1,
  });
  assert.equal(context.companyName, "ACME s.r.o.");
  assert.equal(context.eventId, "event-1");
  assert.equal(context.eventName, "FOR BEAUTY");
  assert.equal(context.realizationCompanyName, "Creativ Expo");
  assert.equal(context.projectName, "Stánek XY");
  assert.equal(context.itemCount, 1);
  assert.deepEqual(context.itemSummaries, ["A — Panel stěnový 1 x 2,5 m — 950 × 2340 mm"]);
});

test("revize se předává správně do kontextu i do freeText seedu", () => {
  const context = buildPrintSurfaceEmailContext({
    companyName: "ACME", projectName: "X", items: [], presets: [], resolveDimension: () => AVAILABLE, revision: 4,
  });
  assert.equal(context.revision, 4);
  assert.match(buildPrintSurfaceEmailFreeText(context), /R4/);
});

test("language context: default je cs, ale libovolný jiný kód se předá beze změny (nikdy neblokuje ostatní jazyky)", () => {
  const defaultLang = buildPrintSurfaceEmailContext({ companyName: "ACME", projectName: "X", items: [], presets: [], resolveDimension: () => AVAILABLE, revision: 1 });
  assert.equal(defaultLang.languageCode, "cs");
  const german = buildPrintSurfaceEmailContext({ companyName: "ACME", projectName: "X", items: [], presets: [], resolveDimension: () => AVAILABLE, revision: 1, languageCode: "de" });
  assert.equal(german.languageCode, "de");
});

test("PDF export != sent: buildPrintSurfaceEmailContext/freeText nikdy netvrdí, že e-mail byl odeslán — jen že příloha je (ne)dostupná", () => {
  const withAttachment = buildPrintSurfaceEmailContext({
    companyName: "ACME", projectName: "X", items: [], presets: [], resolveDimension: () => AVAILABLE, revision: 1, attachmentFileName: "stanek-xy-R1.pdf",
  });
  assert.equal(withAttachment.attachmentAvailable, true);
  const freeText = buildPrintSurfaceEmailFreeText(withAttachment);
  assert.doesNotMatch(freeText, /odesláno|bylo zasláno|sent successfully/iu);
  assert.match(freeText, /ručně přiložte/u);
});

test("email draft/handoff != sent: bez přílohy freeText výslovně žádá vygenerování/přiložení PDF, nikdy nepředstírá hotovo", () => {
  const withoutAttachment = buildPrintSurfaceEmailContext({
    companyName: "ACME", projectName: "X", items: [], presets: [], resolveDimension: () => AVAILABLE, revision: 1,
  });
  assert.equal(withoutAttachment.attachmentAvailable, false);
  assert.match(buildPrintSurfaceEmailFreeText(withoutAttachment), /vygenerujte a přiložte ručně/u);
});

test("reuse existing Email module infrastructure: a stable template NAME is exported for EmailsPage to preselect the system template by, no second composer type exists", () => {
  assert.equal(PRINT_SURFACE_EMAIL_TEMPLATE_NAME, "Podklady k tiskovým plochám");
});

test("itemSummaries je prázdné pole pro projekt bez ploch, freeText to zvládne beze pádu", () => {
  const context = buildPrintSurfaceEmailContext({ companyName: "ACME", projectName: "X", items: [], presets: [], resolveDimension: () => AVAILABLE, revision: 1 });
  assert.deepEqual(context.itemSummaries, []);
  assert.equal(typeof buildPrintSurfaceEmailFreeText(context), "string");
});
