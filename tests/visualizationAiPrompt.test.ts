import assert from "node:assert/strict";
import test from "node:test";
import { buildEnvironmentPrompt, buildSceneMetadataForAi, type BuildSceneMetadataInput } from "../domain/visualizationAiPrompt.ts";

const PRIVATE_MARKERS = ["9999", "hanz.private@example.com", "+420 777 000 111", "TAJNA INTERNI POZNAMKA", "purchasePrice"];

function fixtureInput(overrides: Partial<BuildSceneMetadataInput> = {}): BuildSceneMetadataInput {
  return {
    eventName: "Beauty 2026",
    footprintMm: { widthMm: 2000, depthMm: 2000 },
    cameraPosition: [0, 1.6, 3],
    cameraTarget: [0, 1, 0],
    floorType: "Šedý koberec",
    materialsSummary: ["Bílá konstrukce", "Dubová dýha"],
    objectCategoryCounts: { "booth-construction": 4, artwork: 2, furniture: 3, "booth-floor": 1 },
    ...overrides,
  };
}

// =========================================================================================
// Visualization v3 — prompt builder privacy (report sections 11/38): NEVER pricing/email/
// phone/internal notes, only image/control inputs + necessary visual metadata.
// =========================================================================================

test("PRIVACY: BuildSceneMetadataInput structurally has no field for pricing/contact/notes — the type itself is the enforcement", () => {
  const input = fixtureInput();
  const keys = Object.keys(input);
  assert.deepEqual(keys.sort(), [
    "cameraPosition", "cameraTarget", "eventName", "floorType", "footprintMm", "materialsSummary", "objectCategoryCounts",
  ].sort());
  assert.ok(!keys.some((key) => /price|pricing|email|phone|note|contact/iu.test(key)));
});

test("PRIVACY: curated metadata + built prompt never contain recognizable private strings, even when environmentIntent is user-authored free text", () => {
  const metadata = buildSceneMetadataForAi(fixtureInput({ environmentIntent: "Bright and airy, morning light" }));
  const prompt = buildEnvironmentPrompt({ metadata, environmentPreset: "clean-hall", peoplePreset: "few", lightingPreset: "neutral" });
  const serialized = JSON.stringify({ metadata, prompt });
  for (const marker of PRIVATE_MARKERS) {
    assert.doesNotMatch(serialized, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
});

test("METADATA: camera summary derives from position/target, never exposes a raw matrix or internal field names", () => {
  const metadata = buildSceneMetadataForAi(fixtureInput());
  assert.match(metadata.cameraSummary, /camera at \(0\.00, 1\.60, 3\.00\)/u);
  assert.match(metadata.cameraSummary, /looking toward \(0\.00, 1\.00, 0\.00\)/u);
});

test("METADATA: protectedObjectCount is the sum of all category counts", () => {
  const metadata = buildSceneMetadataForAi(fixtureInput());
  assert.equal(metadata.protectedObjectCount, 4 + 2 + 3 + 1);
});

test("PROMPT STRUCTURE: all 5 sections (GOAL/LOCKED/EDITABLE/STYLE/CAMERA) are present and non-empty", () => {
  const metadata = buildSceneMetadataForAi(fixtureInput());
  const prompt = buildEnvironmentPrompt({ metadata, environmentPreset: "modern-hall", peoplePreset: "typical", lightingPreset: "warm" });
  for (const section of [prompt.goal, prompt.lockedContent, prompt.editableContent, prompt.style, prompt.camera]) {
    assert.ok(section.length > 0);
  }
});

test("PROMPT LOCKED CONTENT: explicitly states booth/furniture/artwork/logo/text/color/perspective are authoritative", () => {
  const metadata = buildSceneMetadataForAi(fixtureInput());
  const prompt = buildEnvironmentPrompt({ metadata, environmentPreset: "clean-hall", peoplePreset: "none", lightingPreset: "cool" });
  assert.match(prompt.lockedContent, /authoritative/u);
  assert.match(prompt.lockedContent, /must not be redesigned/u);
});

test("PROMPT PEOPLE: editable-content section reflects the peoplePreset label and constrains people to the environment only", () => {
  const metadata = buildSceneMetadataForAi(fixtureInput());
  const prompt = buildEnvironmentPrompt({ metadata, environmentPreset: "clean-hall", peoplePreset: "typical", lightingPreset: "neutral" });
  assert.match(prompt.editableContent, /Běžný provoz/u);
  assert.match(prompt.editableContent, /never inside or overlapping the booth/u);
});

test("PROMPT CAMERA: preserves framing instruction and includes the camera summary", () => {
  const metadata = buildSceneMetadataForAi(fixtureInput());
  const prompt = buildEnvironmentPrompt({ metadata, environmentPreset: "clean-hall", peoplePreset: "none", lightingPreset: "neutral" });
  assert.match(prompt.camera, /Preserve the supplied framing/u);
  assert.match(prompt.camera, /Never reframe/u);
});

test("PROMPT POLISH (v3.3b): strengthened environment instructions land in the SAME 5 fields — no new section, no architecture change", () => {
  const metadata = buildSceneMetadataForAi(fixtureInput());
  const prompt = buildEnvironmentPrompt({ metadata, environmentPreset: "clean-hall", peoplePreset: "none", lightingPreset: "neutral" });
  assert.match(prompt.goal, /photorealistic/iu);
  assert.match(prompt.goal, /trade-show hall/iu);
  assert.match(prompt.camera, /exact camera perspective/iu);
  assert.match(prompt.editableContent, /naturally/iu);
  assert.match(prompt.editableContent, /contact shadows/iu);
  assert.match(prompt.lockedContent, /duplicated/iu);
  assert.match(prompt.lockedContent, /altered/iu);
  assert.deepEqual(Object.keys(prompt).sort(), ["camera", "editableContent", "goal", "lockedContent", "style"], "still exactly the same 5 fields");
});
