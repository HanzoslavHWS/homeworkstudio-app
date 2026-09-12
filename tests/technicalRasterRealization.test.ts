import assert from "node:assert/strict";
import test from "node:test";
import {
  TECHNICAL_REALIZATION_GROUPS,
  resolveTechnicalRealizationGroup,
  technicalRealizationGroupInfo,
} from "../domain/technicalRasterRealization.ts";

// ============================================================================
// Corrective batch section 9/10 — realizace canonical grouping + central colors.
// ============================================================================

test("GENDAI resolves regardless of case", () => {
  assert.equal(resolveTechnicalRealizationGroup("GENDAI"), "gendai");
  assert.equal(resolveTechnicalRealizationGroup("Gendai"), "gendai");
});

test("CREATIV EXPO: both real spelling variants from the spec normalize to the SAME group, never treated as two different companies", () => {
  assert.equal(resolveTechnicalRealizationGroup("CREATIV EXPO, s.r.o."), "creativExpo");
  assert.equal(resolveTechnicalRealizationGroup("Creative Expo s.r.o."), "creativExpo");
});

test("MAC PRAHA resolves case/format variants", () => {
  assert.equal(resolveTechnicalRealizationGroup("Mac Praha"), "macPraha");
  assert.equal(resolveTechnicalRealizationGroup("MAC PRAHA s.r.o."), "macPraha");
});

test("Elseya spol. s r.o. => OSTATNÍ", () => {
  assert.equal(resolveTechnicalRealizationGroup("Elseya spol. s r.o."), "ostatni");
});

test("Agentura M-S-P, s.r.o. => OSTATNÍ", () => {
  assert.equal(resolveTechnicalRealizationGroup("Agentura M-S-P, s.r.o."), "ostatni");
});

test("missing/empty R: => OSTATNÍ, never a crash", () => {
  assert.equal(resolveTechnicalRealizationGroup(undefined), "ostatni");
  assert.equal(resolveTechnicalRealizationGroup(""), "ostatni");
  assert.equal(resolveTechnicalRealizationGroup("   "), "ostatni");
});

test("a genuinely unknown/future realization company => OSTATNÍ, never a 5th invented group", () => {
  assert.equal(resolveTechnicalRealizationGroup("Nová Firma s.r.o."), "ostatni");
});

test("colors are centralized: every group has exactly one hex color, all distinct", () => {
  const colors = TECHNICAL_REALIZATION_GROUPS.map((group) => group.color);
  assert.equal(new Set(colors).size, colors.length);
  for (const color of colors) assert.match(color, /^#[0-9a-f]{6}$/iu);
});

test("technicalRealizationGroupInfo returns the matching central entry for every group id", () => {
  for (const group of TECHNICAL_REALIZATION_GROUPS) {
    assert.equal(technicalRealizationGroupInfo(group.id).id, group.id);
  }
});
