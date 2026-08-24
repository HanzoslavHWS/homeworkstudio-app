import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const scenePanelSource = readFileSync(new URL("../components/configurator/ScenePanel.tsx", import.meta.url), "utf8");
const boothGeneratorSource = readFileSync(new URL("../components/BoothGenerator.tsx", import.meta.url), "utf8");

// =========================================================================================
// Turn 5, sections 21-22: Individual flooring is handled exclusively via the Podlaha step's
// floorZones — the classic configurator's legacy single-carpet <select> must be hidden for
// Individual projects, while staying fully visible/functional for Typovka (unchanged).
// =========================================================================================

test("CARPET UI: ScenePanel accepts a showFloorControl prop (default true) that gates the whole legacy 'Podlaha' tree group, not just the <select> inside it", () => {
  assert.match(scenePanelSource, /showFloorControl\?:\s*boolean;/u);
  const podlahaGroup = scenePanelSource.match(/\{props\.showFloorControl !== false && <div className="sceneTreeGroup">[\s\S]*?<\/div>\}/u);
  assert.ok(podlahaGroup, "expected the legacy Podlaha tree group to be gated by showFloorControl");
  assert.match(podlahaGroup![0], /sceneFloorControl/u);
});

test("CARPET UI: BoothGenerator.tsx wires showFloorControl to false ONLY for Individual projects — Typovka keeps the legacy control", () => {
  const call = boothGeneratorSource.match(/<ScenePanel[\s\S]*?\/>/u);
  assert.ok(call, "expected to find the <ScenePanel> call site");
  assert.match(call![0], /showFloorControl=\{type !== "individualni"\}/u);
});

test("CARPET UI: the legacy carpet plumbing (carpetVariants/carpetFinishId/onCarpetFinishChange) is still passed through unconditionally — the control is HIDDEN for Individual, not removed/broken for Typovka", () => {
  const call = boothGeneratorSource.match(/<ScenePanel[\s\S]*?\/>/u);
  assert.ok(call);
  assert.match(call![0], /carpetVariants=\{selectedBooth\.carpetVariants\}/u);
  assert.match(call![0], /carpetFinishId=\{carpetFinishId\}/u);
  assert.match(call![0], /onCarpetFinishChange=\{setCarpetFinishId\}/u);
});
