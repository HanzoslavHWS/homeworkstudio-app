import assert from "node:assert/strict";
import test from "node:test";
import {
  canConfirmPlot,
  createRectanglePlotPolygon,
  isPlotConfirmed,
  resolvePlotStatus,
  type PlotPolygon,
} from "../domain/plot.ts";
import { createProjectRecord, normalizeProjectRecord } from "../domain/project.ts";

// =========================================================================================
// Turn 5, sections 1-3/26-27: DRAW -> CONFIRM -> LOCK for the plot polygon itself.
// =========================================================================================

test("PLOT LOCK: a valid polygon can be confirmed; an invalid one cannot", () => {
  const valid = createRectanglePlotPolygon(4000, 3000);
  assert.equal(canConfirmPlot(valid), true);

  const tooFewPoints: PlotPolygon = [{ x: 0, y: 0 }, { x: 1000, y: 0 }];
  assert.equal(canConfirmPlot(tooFewPoints), false);

  assert.equal(canConfirmPlot(undefined), false, "no polygon at all can never be confirmed");
});

test("PLOT LOCK: resolvePlotStatus defaults undefined to draft, never silently confirmed", () => {
  assert.equal(resolvePlotStatus(undefined), "draft");
  assert.equal(resolvePlotStatus("draft"), "draft");
  assert.equal(resolvePlotStatus("confirmed"), "confirmed");
  assert.equal(isPlotConfirmed(undefined), false);
  assert.equal(isPlotConfirmed("confirmed"), true);
});

test("PLOT LOCK: status round-trips through save/reload via ProjectRecord (no DB migration — plain JSONB field)", () => {
  const plot = createRectanglePlotPolygon(4000, 3000);
  const saved = createProjectRecord({
    id: "plot-lock-test",
    projectType: "individualni",
    individualPlotPolygon: plot,
    individualPlotStatus: "confirmed",
  });
  assert.equal(saved.individualPlotStatus, "confirmed");

  const reloaded = normalizeProjectRecord(saved);
  assert.equal(reloaded.individualPlotStatus, "confirmed", "confirmed status survives a save/reload cycle");
  assert.deepEqual(reloaded.individualPlotPolygon, plot);
});

test("PLOT LOCK: a project saved before locking existed (no individualPlotStatus field) resolves to draft on load, never confirmed", () => {
  const legacyProject = createProjectRecord({
    id: "legacy-plot-project",
    projectType: "individualni",
    individualPlotPolygon: createRectanglePlotPolygon(3000, 3000),
    // individualPlotStatus intentionally omitted — simulates a pre-lock-foundation save.
  });
  assert.equal(legacyProject.individualPlotStatus, undefined);
  assert.equal(resolvePlotStatus(legacyProject.individualPlotStatus), "draft");
});
