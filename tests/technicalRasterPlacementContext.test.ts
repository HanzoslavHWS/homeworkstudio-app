import assert from "node:assert/strict";
import test from "node:test";
import { computePlacementPointProgress } from "../domain/technicalRasterPlacementContext.ts";
import type { TechnicalService } from "../domain/technicalRaster.ts";

// =========================================================================================
// Manual acceptance batch, section 6/7 — "Bod X / Y" in the PRÁVĚ UMISŤUJI context block. Real
// manual testing found the previous single-line banner left qty>1 services ambiguous ("is my next
// click point 1 or point 2?"). These tests pin the exact numbering rule.
// =========================================================================================

function service(overrides: Partial<TechnicalService> = {}): TechnicalService {
  return {
    id: "svc-1",
    category: "electricity",
    externalLabel: "Do 6kW 230V",
    quantity: 1,
    rawValue: "6kW",
    sourceImportId: "import-1",
    sourcePage: 1,
    status: "resolved",
    ...overrides,
  };
}

test("place mode, qty=1, 0 placements -> Bod 1 / 1 (the next point about to be created)", () => {
  const progress = computePlacementPointProgress(service({ quantity: 1, placements: [] }), "place");
  assert.deepEqual(progress, { pointIndex: 1, pointTotal: 1 });
});

test("place mode, qty=2, 0 placements -> Bod 1 / 2", () => {
  const progress = computePlacementPointProgress(service({ quantity: 2, placements: [] }), "place");
  assert.deepEqual(progress, { pointIndex: 1, pointTotal: 2 });
});

test("place mode, qty=2, 1 placement already exists -> Bod 2 / 2 (auto-advance's own second click)", () => {
  const progress = computePlacementPointProgress(
    service({ quantity: 2, placements: [{ id: "p1", page: 1, xNormalized: 0.1, yNormalized: 0.1, createdAt: "2026-01-01T00:00:00.000Z" }] }),
    "place",
  );
  assert.deepEqual(progress, { pointIndex: 2, pointTotal: 2 });
});

test("place mode never reports an index PAST pointTotal, even against stale/over-quantity data", () => {
  const progress = computePlacementPointProgress(
    service({
      quantity: 1,
      placements: [
        { id: "p1", page: 1, xNormalized: 0.1, yNormalized: 0.1, createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "p2", page: 1, xNormalized: 0.2, yNormalized: 0.2, createdAt: "2026-01-01T00:00:00.000Z" },
      ],
    }),
    "place",
  );
  assert.equal(progress.pointIndex, 1, "clamped to pointTotal, never 3");
});

test("move mode -> pointIndex is the 1-based position of the placement actually being moved, not a 'next new point' count", () => {
  const svc = service({
    quantity: 3,
    placements: [
      { id: "p1", page: 1, xNormalized: 0.1, yNormalized: 0.1, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "p2", page: 1, xNormalized: 0.2, yNormalized: 0.2, createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "p3", page: 1, xNormalized: 0.3, yNormalized: 0.3, createdAt: "2026-01-01T00:00:00.000Z" },
    ],
  });
  assert.deepEqual(computePlacementPointProgress(svc, "move", "p1"), { pointIndex: 1, pointTotal: 3 });
  assert.deepEqual(computePlacementPointProgress(svc, "move", "p2"), { pointIndex: 2, pointTotal: 3 });
  assert.deepEqual(computePlacementPointProgress(svc, "move", "p3"), { pointIndex: 3, pointTotal: 3 });
});

test("move mode with an unknown placementId falls back to 1, never 0/NaN", () => {
  const svc = service({ quantity: 1, placements: [{ id: "p1", page: 1, xNormalized: 0.1, yNormalized: 0.1, createdAt: "2026-01-01T00:00:00.000Z" }] });
  const progress = computePlacementPointProgress(svc, "move", "does-not-exist");
  assert.equal(progress.pointIndex, 1);
  assert.ok(Number.isFinite(progress.pointIndex));
});
