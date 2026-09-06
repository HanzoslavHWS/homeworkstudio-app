import test from "node:test";
import assert from "node:assert/strict";
import {
  productGroupForPreset,
  presetsForProductGroup,
  productsForGroup,
} from "../domain/printSurfaceProductGroup.ts";
import type { PrintSurfacePreset } from "../domain/printSurfacePreset.ts";

const PRESETS: readonly PrintSurfacePreset[] = [
  { id: "Panel_S_100", typeId: "panel", name: "Panel stěnový 1 x 2,5 m", isActive: true },
  { id: "Panel_S_Dvere", typeId: "panel_above_door", name: "Panel naddveřní (nad shrnovačky)", isActive: true },
  { id: "Vitrina_100x100_Celo", typeId: "showcase", name: "Čelo", isActive: true, parentId: "Vitrina_100x100", parentName: "Vitrína prosklená 1 x 1 x 2,5 m" },
  { id: "Vitrina_100x100_Bok", typeId: "showcase", name: "Bok", isActive: true, parentId: "Vitrina_100x100", parentName: "Vitrína prosklená 1 x 1 x 2,5 m" },
  { id: "Pult_100x50_v_Celo", typeId: "counter_front", name: "Čelo", isActive: true, parentId: "Pult_100x50_v", parentName: "Pult 1 x 0,5 x 1,1 m" },
  { id: "Pult_100x50_v_Bok", typeId: "counter_side", name: "Bok", isActive: true, parentId: "Pult_100x50_v", parentName: "Pult 1 x 0,5 x 1,1 m" },
  { id: "Pult_Vit_100x50_Celo", typeId: "counter_front", name: "Čelo", isActive: true, parentId: "Pult_Vit_100x50", parentName: "Pultová vitrína 1 x 0,5 x 0,8 m" },
  { id: "Pult_Vit_100x50_Bok", typeId: "counter_side", name: "Bok", isActive: true, parentId: "Pult_Vit_100x50", parentName: "Pultová vitrína 1 x 0,5 x 0,8 m" },
  { id: "Panel_Old", typeId: "panel", name: "Starý panel", isActive: false },
];

test("productGroupForPreset: panel a panel_above_door -> panel", () => {
  assert.equal(productGroupForPreset(PRESETS[0]!), "panel"); // Panel_S_100
  assert.equal(productGroupForPreset(PRESETS[1]!), "panel"); // Panel_S_Dvere
});

test("productGroupForPreset: showcase -> vitrína", () => {
  assert.equal(productGroupForPreset(PRESETS[2]!), "showcase");
});

test("productGroupForPreset: counter_front/counter_side rozlišuje Pult vs Pultová vitrína podle parentName", () => {
  assert.equal(productGroupForPreset(PRESETS[4]!), "counter"); // Pult_100x50_v_Celo
  assert.equal(productGroupForPreset(PRESETS[6]!), "counter_showcase"); // Pult_Vit_100x50_Celo
});

test("presetsForProductGroup: vrací jen aktivní presety patřící do skupiny", () => {
  const panelGroup = presetsForProductGroup(PRESETS, "panel");
  assert.deepEqual(panelGroup.map((p) => p.id), ["Panel_S_100", "Panel_S_Dvere"]); // Panel_Old (isActive:false) vyloučen
});

test("presetsForProductGroup: fascia a custom nejsou nikdy katalogové — vždy prázdné pole", () => {
  assert.deepEqual(presetsForProductGroup(PRESETS, "fascia"), []);
  assert.deepEqual(presetsForProductGroup(PRESETS, "custom"), []);
});

test("productsForGroup: Pult seskupí Čelo/Bok pod jeden produkt (parent), nezamíchá s Pultovou vitrínou", () => {
  const products = productsForGroup(PRESETS, "counter");
  assert.equal(products.length, 1);
  assert.equal(products[0]?.label, "Pult 1 x 0,5 x 1,1 m");
  assert.deepEqual(products[0]?.presets.map((p) => p.name), ["Čelo", "Bok"]);
});

test("productsForGroup: Pultová vitrína je oddělená skupina od Pultu", () => {
  const products = productsForGroup(PRESETS, "counter_showcase");
  assert.equal(products.length, 1);
  assert.equal(products[0]?.label, "Pultová vitrína 1 x 0,5 x 0,8 m");
});

test("productsForGroup: Panel (bez parenta) — jeden produkt na preset, drill-down zůstává plochý", () => {
  const products = productsForGroup(PRESETS, "panel");
  assert.equal(products.length, 2);
  assert.deepEqual(products.map((p) => p.presets.length), [1, 1]);
});

test("productsForGroup: Vitrína seskupí Čelo/Bok pod svůj produkt", () => {
  const products = productsForGroup(PRESETS, "showcase");
  assert.equal(products.length, 1);
  assert.equal(products[0]?.label, "Vitrína prosklená 1 x 1 x 2,5 m");
  assert.equal(products[0]?.presets.length, 2);
});
