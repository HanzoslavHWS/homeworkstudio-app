import test from "node:test";
import assert from "node:assert/strict";
import {
  findDuplicateProductionDimensionKeys,
  resolvePrintSurfaceProductionDimension,
  type PrintSurfaceProductionDimension,
} from "../domain/printSurfaceProductionDimension.ts";

const DIMENSIONS: readonly PrintSurfaceProductionDimension[] = [
  { realizationCompanyId: "company-a", presetId: "panel-standard", widthMm: 950, heightMm: 2340 },
  { realizationCompanyId: "company-b", presetId: "panel-standard", widthMm: 1000, heightMm: 2300 },
  { realizationCompanyId: "company-a", presetId: "fascia-standard", widthMm: 300, heightMm: 950 },
];

test("resolver: existující kombinace realizačka + preset vrátí found s rozměrem", () => {
  const result = resolvePrintSurfaceProductionDimension(
    { realizationCompanyId: "company-a", presetId: "panel-standard" },
    DIMENSIONS,
  );
  assert.equal(result.status, "found");
  assert.equal(result.status === "found" && result.dimension.widthMm, 950);
  assert.equal(result.status === "found" && result.dimension.heightMm, 2340);
});

test("resolver: neexistující kombinace vrátí not_found (bez hádání rozměru)", () => {
  const result = resolvePrintSurfaceProductionDimension(
    { realizationCompanyId: "company-c", presetId: "panel-standard" },
    DIMENSIONS,
  );
  assert.equal(result.status, "not_found");
});

test("resolver: stejný preset má rozdílné rozměry pro dvě realizačky", () => {
  const forA = resolvePrintSurfaceProductionDimension({ realizationCompanyId: "company-a", presetId: "panel-standard" }, DIMENSIONS);
  const forB = resolvePrintSurfaceProductionDimension({ realizationCompanyId: "company-b", presetId: "panel-standard" }, DIMENSIONS);
  assert.equal(forA.status === "found" && forA.dimension.widthMm, 950);
  assert.equal(forB.status === "found" && forB.dimension.widthMm, 1000);
});

test("resolver: změna realizationCompanyId změní resolved dimension pro stejný preset", () => {
  const input1 = { realizationCompanyId: "company-a", presetId: "panel-standard" };
  const input2 = { ...input1, realizationCompanyId: "company-b" };
  const result1 = resolvePrintSurfaceProductionDimension(input1, DIMENSIONS);
  const result2 = resolvePrintSurfaceProductionDimension(input2, DIMENSIONS);
  assert.notDeepEqual(result1, result2);
});

test("resolver: neexistující/undefined presetId vrátí bezpečný not_found stav, nikdy nehodí chybu", () => {
  const withoutPreset = resolvePrintSurfaceProductionDimension({ realizationCompanyId: "company-a", presetId: undefined }, DIMENSIONS);
  assert.equal(withoutPreset.status, "not_found");
  const withoutCompany = resolvePrintSurfaceProductionDimension({ realizationCompanyId: undefined, presetId: "panel-standard" }, DIMENSIONS);
  assert.equal(withoutCompany.status, "not_found");
  const bothMissing = resolvePrintSurfaceProductionDimension({ realizationCompanyId: undefined, presetId: undefined }, DIMENSIONS);
  assert.equal(bothMissing.status, "not_found");
});

test("resolver: prázdný seznam rozměrů vrátí not_found (počáteční stav před importem)", () => {
  const result = resolvePrintSurfaceProductionDimension({ realizationCompanyId: "company-a", presetId: "panel-standard" }, []);
  assert.equal(result.status, "not_found");
});

test("findDuplicateProductionDimensionKeys: detekuje duplicitní kombinaci realizationCompanyId + presetId", () => {
  const withDuplicate: readonly PrintSurfaceProductionDimension[] = [
    ...DIMENSIONS,
    { realizationCompanyId: "company-a", presetId: "panel-standard", widthMm: 999, heightMm: 999, note: "duplicitní řádek" },
  ];
  const duplicates = findDuplicateProductionDimensionKeys(withDuplicate);
  assert.deepEqual(duplicates, [{ realizationCompanyId: "company-a", presetId: "panel-standard" }]);
});

test("findDuplicateProductionDimensionKeys: bez duplicit vrací prázdné pole", () => {
  assert.deepEqual(findDuplicateProductionDimensionKeys(DIMENSIONS), []);
});
