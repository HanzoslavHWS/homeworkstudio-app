import test from "node:test";
import assert from "node:assert/strict";
import {
  activeToolLabel,
  FASCIA_HEIGHT_MM,
  pendingActionFromActiveTool,
  SELECT_TOOL,
  type PrintSurfaceActiveTool,
} from "../domain/printSurfaceActiveTool.ts";

test("select nástroj nic nevytváří", () => {
  assert.equal(pendingActionFromActiveTool(SELECT_TOOL), undefined);
  assert.equal(activeToolLabel(SELECT_TOOL), undefined);
});

test("catalog nástroj: opakované volání vrací STEJNÝ typeId+presetId (sticky) — 5 kliknutí = 5x stejná create akce", () => {
  const tool: PrintSurfaceActiveTool = { kind: "catalog", typeId: "panel", presetId: "Panel_S_100", label: "Panel stěnový 1 x 2,5 m" };
  const pendingActions = Array.from({ length: 5 }, () => pendingActionFromActiveTool(tool));
  for (const pending of pendingActions) {
    assert.deepEqual(pending, { mode: "create", typeId: "panel", presetId: "Panel_S_100" });
  }
  assert.equal(activeToolLabel(tool), "Panel stěnový 1 x 2,5 m");
});

test("fascia (límec): výška je vždy pevně 300 mm, šířka podle nástroje", () => {
  const tool: PrintSurfaceActiveTool = { kind: "fascia", widthMm: 3000 };
  const pending = pendingActionFromActiveTool(tool);
  assert.deepEqual(pending, { mode: "create", typeId: "fascia", customWidthMm: 3000, customHeightMm: FASCIA_HEIGHT_MM });
  assert.equal(FASCIA_HEIGHT_MM, 300);
});

test("fascia: změna šířky (3000 -> 5000) mezi kliknutími se projeví v další pending akci, nástroj zůstává aktivní", () => {
  const first = pendingActionFromActiveTool({ kind: "fascia", widthMm: 3000 });
  const second = pendingActionFromActiveTool({ kind: "fascia", widthMm: 5000 });
  assert.equal(first?.mode === "create" ? first.customWidthMm : undefined, 3000);
  assert.equal(second?.mode === "create" ? second.customWidthMm : undefined, 5000);
  assert.equal(first?.mode === "create" ? first.customHeightMm : undefined, FASCIA_HEIGHT_MM);
  assert.equal(second?.mode === "create" ? second.customHeightMm : undefined, FASCIA_HEIGHT_MM);
});

test("fascia: neplatná/nulová šířka nic nevytváří (chrání proti prázdnému inputu)", () => {
  assert.equal(pendingActionFromActiveTool({ kind: "fascia", widthMm: 0 }), undefined);
  assert.equal(pendingActionFromActiveTool({ kind: "fascia", widthMm: Number.NaN }), undefined);
  assert.equal(pendingActionFromActiveTool({ kind: "fascia", widthMm: -100 }), undefined);
});

test("custom (jiná plocha): šířka i výška se berou z nástroje", () => {
  const tool: PrintSurfaceActiveTool = { kind: "custom", widthMm: 1200, heightMm: 800 };
  const pending = pendingActionFromActiveTool(tool);
  assert.deepEqual(pending, { mode: "create", typeId: "custom", customWidthMm: 1200, customHeightMm: 800 });
  assert.equal(activeToolLabel(tool), "Jiná plocha — 1200 × 800 mm");
});

test("custom: neplatná šířka nebo výška nic nevytváří", () => {
  assert.equal(pendingActionFromActiveTool({ kind: "custom", widthMm: 1000, heightMm: 0 }), undefined);
  assert.equal(pendingActionFromActiveTool({ kind: "custom", widthMm: 0, heightMm: 1000 }), undefined);
});

test("Výběr (SELECT_TOOL) je stabilní konstanta reprezentující 'ukončit aktivní nástroj'", () => {
  assert.deepEqual(SELECT_TOOL, { kind: "select" });
});

test("link nástroj: nikdy nevytváří nový item, jen 'link' akci odkazující na existující itemId", () => {
  const tool: PrintSurfaceActiveTool = { kind: "link", itemId: "item-a", label: "A — Panel stěnový" };
  const pending = pendingActionFromActiveTool(tool);
  assert.deepEqual(pending, { mode: "link", itemId: "item-a" });
  assert.equal(activeToolLabel(tool), "Propojit s: A — Panel stěnový");
});
