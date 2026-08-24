import assert from "node:assert/strict";
import test from "node:test";

import { boothTypes } from "../data/booths.ts";
import { componentCatalog, placeComponent } from "../data/components.ts";
import { toggleVisibility } from "../domain/visibility.ts";
import { isPlacementValid } from "../geometry/placement.ts";

const booth = boothTypes.find((item) => item.id === "koje-2x2");

if (!booth) {
  throw new Error("Testovací definice Koje 2 × 2 nebyla nalezena.");
}

test("toggle visibility nemění world position objektu", () => {
  const component = placeComponent(
    componentCatalog.chair,
    "chair-visibility",
    725,
    1425,
  );
  const hiddenComponent = toggleVisibility(component);

  assert.equal(hiddenComponent.visible, false);
  assert.equal(hiddenComponent.xMm, component.xMm);
  assert.equal(hiddenComponent.yMm, component.yMm);
  assert.equal(hiddenComponent.rotationDeg, component.rotationDeg);
});

test("skrytá konstrukce odstraní také hard collision", () => {
  const visuallyHiddenBooth = {
    ...booth,
    visible: false,
  };

  assert.equal(
    isPlacementValid(
      visuallyHiddenBooth,
      { widthMm: 200, depthMm: 200 },
      { x: 100, y: 1500, rotationDeg: 0 },
    ),
    true,
  );
});

test("hidden HWS side assembly removes only its hard obstacle", () => {
  const furniture = { widthMm: 200, depthMm: 200 };
  const rearLeft = { x: 100, y: 1500, rotationDeg: 0 };

  assert.equal(isPlacementValid(booth, furniture, rearLeft), false);
  assert.equal(
    isPlacementValid(booth, furniture, rearLeft, {
      HWS_ASM_LEFT_WALL: false,
    }),
    true,
  );
  assert.equal(
    isPlacementValid(booth, furniture, rearLeft, {
      HWS_ASM_RIGHT_WALL: false,
    }),
    false,
  );
});

test("skrytý mobiliář zůstává v projektových datech", () => {
  const component = placeComponent(
    componentCatalog.cabinet,
    "cabinet-visibility",
    1100,
    1400,
  );
  const projectComponents = [toggleVisibility(component)];

  assert.equal(projectComponents.length, 1);
  assert.equal(projectComponents[0]?.id, component.id);
  assert.equal(projectComponents[0]?.visible, false);
  assert.equal(projectComponents[0]?.xMm, 1100);
  assert.equal(projectComponents[0]?.yMm, 1400);
});
