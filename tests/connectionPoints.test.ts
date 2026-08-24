import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveConnectionPointWorldDirectionDeg,
  resolveConnectionPointWorldPosition,
  resolvePlacedConnectionPoints,
} from "../domain/connectionPoints.ts";
import { adaptCatalogItemToComponentDefinition } from "../domain/generatorBoothComponents.ts";
import type { CatalogItemAdmin } from "../domain/catalogItemsAdmin.ts";
import type { ConnectionPoint } from "../domain/models.ts";

// A minimal Octanorm-style sloupek with 2 of its 8 sockets declared, purely as a TEST fixture —
// never written into any production/DB data by this session (see domain/models.ts's
// ConnectionPoint doc comment: no auto-population for real catalog rows).
const NORTH_SOCKET: ConnectionPoint = { id: "n", localPosition: { x: 0, y: 20 }, directionDeg: 90, role: "octanorm-column" };
const EAST_SOCKET: ConnectionPoint = { id: "e", localPosition: { x: 20, y: 0 }, directionDeg: 0, role: "octanorm-column" };

test("resolveConnectionPointWorldPosition: at rotationDeg=0, a local offset maps 1:1 onto world position relative to the component's anchor", () => {
  const component = { xMm: 1000, yMm: 1000, rotationDeg: 0 };
  assert.deepEqual(resolveConnectionPointWorldPosition(component, NORTH_SOCKET), { x: 1000, y: 1020 });
  assert.deepEqual(resolveConnectionPointWorldPosition(component, EAST_SOCKET), { x: 1020, y: 1000 });
});

test("resolveConnectionPointWorldPosition: rotating the component by 90° rotates the socket's world position with it", () => {
  const component = { xMm: 1000, yMm: 1000, rotationDeg: 90 };
  const world = resolveConnectionPointWorldPosition(component, EAST_SOCKET);
  // A local (20, 0) offset rotated 90° becomes (0, 20) before translation.
  assert.ok(Math.abs(world.x - 1000) < 1e-9);
  assert.ok(Math.abs(world.y - 1020) < 1e-9);
});

test("resolveConnectionPointWorldDirectionDeg: rotates the socket's own facing direction by the component's world rotation, normalized to [0,360)", () => {
  assert.equal(resolveConnectionPointWorldDirectionDeg({ rotationDeg: 0 }, NORTH_SOCKET), 90);
  assert.equal(resolveConnectionPointWorldDirectionDeg({ rotationDeg: 45 }, NORTH_SOCKET), 135);
  assert.equal(resolveConnectionPointWorldDirectionDeg({ rotationDeg: 315 }, NORTH_SOCKET), 45, "wraps around 360°");
});

test("resolvePlacedConnectionPoints: resolves every socket on a definition for one placed instance without mutating the original definitions", () => {
  const component = { xMm: 500, yMm: 500, rotationDeg: 0 };
  const resolved = resolvePlacedConnectionPoints(component, [NORTH_SOCKET, EAST_SOCKET]);
  assert.equal(resolved.length, 2);
  assert.deepEqual(resolved[0]!.worldPosition, { x: 500, y: 520 });
  assert.equal(resolved[0]!.id, "n");
  assert.equal(NORTH_SOCKET.localPosition.y, 20, "the source ConnectionPoint itself must be untouched");
});

// =========================================================================================
// Data-model passthrough: adaptCatalogItemToComponentDefinition never fabricates
// connectionPoints for a catalog row that doesn't declare any, and never drops/rewrites ones
// that ARE declared — see domain/generatorBoothComponents.ts.
// =========================================================================================

function sloupekAdmin(documentOverrides: Record<string, unknown> = {}): CatalogItemAdmin {
  return {
    id: "sloupek-uuid",
    internalCode: "BC-SLOUPEK-01",
    kind: "booth_component",
    lifecycleStatus: "active",
    displayName: "Sloupek 2500 mm",
    officialName: null,
    category: "Sloupky",
    unit: null,
    document: {
      widthMm: 40,
      depthMm: 40,
      heightMm: 2500,
      modelUrl: "sloupek.glb",
      sourceAssets: [{ id: "s1", kind: "sketchup", asset: { id: "s1a", storageKey: "sloupek.skp", originalFileName: "sloupek.skp", mimeType: "x", size: 1, createdAt: "2026-08-20T00:00:00.000Z", category: "catalog-source" } }],
      ...documentOverrides,
    },
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
}

test("NO AUTO-POPULATION: a booth_component with no connectionPoints declared on its document stays undefined — never fabricated from its name/kind", () => {
  const adapted = adaptCatalogItemToComponentDefinition(sloupekAdmin());
  assert.equal(adapted.connectionPoints, undefined);
});

test("an explicit connectionPoints array on the document passes through verbatim", () => {
  const adapted = adaptCatalogItemToComponentDefinition(sloupekAdmin({ connectionPoints: [NORTH_SOCKET, EAST_SOCKET] }));
  assert.deepEqual(adapted.connectionPoints, [NORTH_SOCKET, EAST_SOCKET]);
});
