import test from "node:test";
import assert from "node:assert/strict";
import { presetsForType, findPreset, type PrintSurfacePreset } from "../domain/printSurfacePreset.ts";
import { changePrintSurfaceItemType, updatePrintSurfaceItemType, type PrintSurfaceItem } from "../domain/printSurfaceProject.ts";

const PANEL_STANDARD: PrintSurfacePreset = { id: "panel-standard", typeId: "panel", name: "Panel standard", isActive: true };
const PANEL_NARROW: PrintSurfacePreset = { id: "panel-narrow", typeId: "panel", name: "Panel úzký", isActive: true };
const PANEL_INACTIVE: PrintSurfacePreset = { id: "panel-old", typeId: "panel", name: "Panel (starý)", isActive: false };
const FASCIA_STANDARD: PrintSurfacePreset = { id: "fascia-standard", typeId: "fascia", name: "Límec standard", isActive: true };

const PRESETS: readonly PrintSurfacePreset[] = [PANEL_STANDARD, PANEL_NARROW, PANEL_INACTIVE, FASCIA_STANDARD];

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

test("presetsForType: vrací pouze aktivní presety patřící danému typu", () => {
  const result = presetsForType(PRESETS, "panel");
  assert.deepEqual(result.map((preset) => preset.id), ["panel-standard", "panel-narrow"]);
});

test("presetsForType: pro typ bez presetů vrací prázdné pole", () => {
  assert.deepEqual(presetsForType(PRESETS, "counter_front"), []);
});

test("findPreset: najde preset podle id, jinak undefined", () => {
  assert.equal(findPreset(PRESETS, "fascia-standard")?.name, "Límec standard");
  assert.equal(findPreset(PRESETS, "missing"), undefined);
  assert.equal(findPreset(PRESETS, undefined), undefined);
});

test("changePrintSurfaceItemType: preset zůstává, pokud patří k novému typu", () => {
  // hypoteticky: item je "panel" s presetem panel-standard, změna na jiný typ panelu-kompatibilní preset zůstává jen pokud typeId sedí
  const item = makeItem({ typeId: "panel", presetId: "panel-standard" });
  const changed = changePrintSurfaceItemType(item, "panel", PRESETS);
  assert.equal(changed.presetId, "panel-standard");
  assert.equal(changed.typeId, "panel");
});

test("changePrintSurfaceItemType: reset presetu, pokud aktuální preset nepatří k novému typu", () => {
  const item = makeItem({ typeId: "panel", presetId: "panel-standard" });
  const changed = changePrintSurfaceItemType(item, "fascia", PRESETS);
  assert.equal(changed.typeId, "fascia");
  assert.equal(changed.presetId, undefined);
});

test("changePrintSurfaceItemType: bez presetu zůstává beze změny presetId při změně typu", () => {
  const item = makeItem({ typeId: "panel", presetId: undefined });
  const changed = changePrintSurfaceItemType(item, "fascia", PRESETS);
  assert.equal(changed.presetId, undefined);
});

test("updatePrintSurfaceItemType: mění typ a resetuje preset jen u cílové položky, ostatní zůstávají beze změny", () => {
  const items = [
    makeItem({ id: "a", typeId: "panel", presetId: "panel-standard" }),
    makeItem({ id: "b", typeId: "fascia", presetId: "fascia-standard" }),
  ];
  const next = updatePrintSurfaceItemType(items, "a", "fascia", PRESETS);
  assert.equal(next.find((item) => item.id === "a")?.typeId, "fascia");
  assert.equal(next.find((item) => item.id === "a")?.presetId, undefined);
  // druhá položka nedotčena
  assert.equal(next.find((item) => item.id === "b")?.typeId, "fascia");
  assert.equal(next.find((item) => item.id === "b")?.presetId, "fascia-standard");
});
