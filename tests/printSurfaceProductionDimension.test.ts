import test from "node:test";
import assert from "node:assert/strict";
import {
  findDuplicateProductionDimensionKeys,
  resolvePrintSurfaceProductionDimension,
  type PrintSurfaceProductionDimension,
} from "../domain/printSurfaceProductionDimension.ts";

const DIMENSIONS: readonly PrintSurfaceProductionDimension[] = [
  { realizationCompanyId: "company-a", presetId: "panel-standard", status: "available", widthMm: 950, heightMm: 2340 },
  { realizationCompanyId: "company-b", presetId: "panel-standard", status: "available", widthMm: 1000, heightMm: 2300 },
  { realizationCompanyId: "company-a", presetId: "fascia-standard", status: "available", widthMm: 300, heightMm: 950 },
  { realizationCompanyId: "company-c", presetId: "panel-standard", status: "unavailable" },
];

test("resolver: existující kombinace realizačka + preset vrátí available s rozměrem", () => {
  const result = resolvePrintSurfaceProductionDimension(
    { realizationCompanyId: "company-a", presetId: "panel-standard" },
    DIMENSIONS,
  );
  assert.equal(result.status, "available");
  assert.equal(result.status === "available" && result.widthMm, 950);
  assert.equal(result.status === "available" && result.heightMm, 2340);
});

test("resolver: kombinace bez záznamu vrátí not_defined (bez hádání rozměru)", () => {
  const result = resolvePrintSurfaceProductionDimension(
    { realizationCompanyId: "company-a", presetId: "unknown-preset" },
    DIMENSIONS,
  );
  assert.equal(result.status, "not_defined");
});

test("resolver: explicitně nedostupná kombinace (NO/NO) vrátí unavailable, nikdy ne 0x0 nebo not_defined", () => {
  const result = resolvePrintSurfaceProductionDimension(
    { realizationCompanyId: "company-c", presetId: "panel-standard" },
    DIMENSIONS,
  );
  assert.equal(result.status, "unavailable");
  assert.equal("widthMm" in result, false);
  assert.equal("heightMm" in result, false);
});

test("resolver: stejný preset má rozdílné rozměry pro dvě realizačky", () => {
  const forA = resolvePrintSurfaceProductionDimension({ realizationCompanyId: "company-a", presetId: "panel-standard" }, DIMENSIONS);
  const forB = resolvePrintSurfaceProductionDimension({ realizationCompanyId: "company-b", presetId: "panel-standard" }, DIMENSIONS);
  assert.equal(forA.status === "available" && forA.widthMm, 950);
  assert.equal(forB.status === "available" && forB.widthMm, 1000);
});

test("resolver: změna realizationCompanyId změní resolved dimension pro stejný preset (available -> unavailable)", () => {
  const forA = resolvePrintSurfaceProductionDimension({ realizationCompanyId: "company-a", presetId: "panel-standard" }, DIMENSIONS);
  const forC = resolvePrintSurfaceProductionDimension({ realizationCompanyId: "company-c", presetId: "panel-standard" }, DIMENSIONS);
  assert.equal(forA.status, "available");
  assert.equal(forC.status, "unavailable");
});

test("resolver: neexistující preset (a chybějící realizačka/preset) vrátí bezpečný not_defined stav, nikdy nehodí chybu", () => {
  const withoutPreset = resolvePrintSurfaceProductionDimension({ realizationCompanyId: "company-a", presetId: undefined }, DIMENSIONS);
  assert.equal(withoutPreset.status, "not_defined");
  const withoutCompany = resolvePrintSurfaceProductionDimension({ realizationCompanyId: undefined, presetId: "panel-standard" }, DIMENSIONS);
  assert.equal(withoutCompany.status, "not_defined");
  const unknownPreset = resolvePrintSurfaceProductionDimension({ realizationCompanyId: "company-a", presetId: "does-not-exist" }, DIMENSIONS);
  assert.equal(unknownPreset.status, "not_defined");
});

test("resolver: prázdný seznam rozměrů vrátí not_defined (počáteční stav před importem)", () => {
  const result = resolvePrintSurfaceProductionDimension({ realizationCompanyId: "company-a", presetId: "panel-standard" }, []);
  assert.equal(result.status, "not_defined");
});

test("findDuplicateProductionDimensionKeys: detekuje duplicitní kombinaci realizationCompanyId + presetId", () => {
  const withDuplicate: readonly PrintSurfaceProductionDimension[] = [
    ...DIMENSIONS,
    { realizationCompanyId: "company-a", presetId: "panel-standard", status: "available", widthMm: 999, heightMm: 999, note: "duplicitní řádek" },
  ];
  const duplicates = findDuplicateProductionDimensionKeys(withDuplicate);
  assert.deepEqual(duplicates, [{ realizationCompanyId: "company-a", presetId: "panel-standard" }]);
});

test("findDuplicateProductionDimensionKeys: bez duplicit vrací prázdné pole", () => {
  assert.deepEqual(findDuplicateProductionDimensionKeys(DIMENSIONS), []);
});
