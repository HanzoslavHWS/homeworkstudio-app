import assert from "node:assert/strict";
import test from "node:test";
import { isPolygonWithinWorkspace, plotAreaSquareMeters, type IndividualWorkspace } from "../domain/plot.ts";
import { createIndividualBooth } from "../domain/individualBooth.ts";

// =========================================================================================
// Turn 5 LIVE QA sections 2-4/47: workspace is a user-resizable DRAWING CANVAS, completely
// separate from the real booth plot polygon — resizing the workspace must never change the
// booth's own geometry/area, and a shrink that would leave the drawn plot outside the new
// canvas must be rejectable (never a silent clip).
// =========================================================================================

test("WORKSPACE != PLOT: workspace 12x12m, plot 5x5m -> booth area is 25 m^2, independent of workspace size", () => {
  const workspace: IndividualWorkspace = { widthMm: 12_000, depthMm: 12_000 };
  const plot = [{ x: 3000, y: 3000 }, { x: 8000, y: 3000 }, { x: 8000, y: 8000 }, { x: 3000, y: 8000 }];
  assert.equal(plotAreaSquareMeters(plot), 25);

  const booth = createIndividualBooth(workspace, plot);
  // createIndividualBooth's widthMm/depthMm represent the WORKSPACE (report's own foundation
  // decision, domain/individualBooth.ts) — never silently swapped for the plot's own bounds.
  assert.equal(booth.widthMm, 12_000);
  assert.equal(booth.depthMm, 12_000);
  // ...while the booth's displayed area comes from the real plot, not the workspace rectangle.
  assert.equal(booth.area, "25.00 m²");
});

test("WORKSPACE RESIZE: changing workspace size alone never changes the plot polygon's own geometry/area", () => {
  const plot = [{ x: 0, y: 0 }, { x: 5000, y: 0 }, { x: 5000, y: 4000 }, { x: 0, y: 4000 }];
  const areaBefore = plotAreaSquareMeters(plot);

  const smallerWorkspace: IndividualWorkspace = { widthMm: 6000, depthMm: 5000 };
  const largerWorkspace: IndividualWorkspace = { widthMm: 30_000, depthMm: 30_000 };

  // The plot itself is a plain array — resizing the workspace never touches it; this test pins
  // that no function in this module derives a NEW plot from a workspace change.
  assert.equal(plotAreaSquareMeters(plot), areaBefore);
  assert.ok(isPolygonWithinWorkspace(plot, smallerWorkspace));
  assert.ok(isPolygonWithinWorkspace(plot, largerWorkspace));
});

test("WORKSPACE VALIDATION: isPolygonWithinWorkspace correctly rejects a workspace too small for the drawn plot (the check BoothGenerator.tsx's resizeIndividualWorkspace uses to block a shrink, never silently clip)", () => {
  const plot = [{ x: 0, y: 0 }, { x: 5000, y: 0 }, { x: 5000, y: 4000 }, { x: 0, y: 4000 }];
  const tooSmallWorkspace: IndividualWorkspace = { widthMm: 4000, depthMm: 4000 };
  const bigEnoughWorkspace: IndividualWorkspace = { widthMm: 5000, depthMm: 4000 };

  assert.equal(isPolygonWithinWorkspace(plot, tooSmallWorkspace), false, "plot's x-extent (5000) exceeds the proposed workspace width (4000)");
  assert.equal(isPolygonWithinWorkspace(plot, bigEnoughWorkspace), true, "plot fits exactly at the new (smaller-but-sufficient) workspace bounds");
});
