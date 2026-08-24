import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { boothTypes } from "../data/booths.ts";
import { componentCatalog, placeComponent } from "../data/components.ts";
import {
  cameraStateFromView,
  placedComponentToViewerTransform,
  resolveBoothAssemblyVisibility,
} from "../domain/cad3d.ts";
import {
  createProjectRecord,
  normalizeProjectRecord,
} from "../domain/project.ts";
import { saveCameraView } from "../domain/workflow.ts";
import {
  createVisualizationCameraPresets,
  moveVisualizationView,
  renameVisualizationView,
} from "../domain/visualization.ts";

const p86 = boothTypes.find((booth) => booth.internalCode === "P86")!;

test("Visualization 3D reads the live project scene and the shared component transform path", () => {
  const workflowSource = readFileSync(
    "components/workflow/WorkflowSteps.tsx",
    "utf8",
  );
  const viewerSource = readFileSync(
    "components/configurator/BoothCadViewer.tsx",
    "utf8",
  );
  assert.match(workflowSource, /components=\{project\.sceneObjects\}/u);
  assert.match(workflowSource, /constructionVisibility=\{project\.constructionVisibility\}/u);
  assert.match(workflowSource, /printSurfaceAssignments=\{project\.printSurfaceAssignments\}/u);
  assert.match(workflowSource, /graphicsFiles=\{project\.graphicsFiles\}/u);
  assert.match(viewerSource, /placedComponentToViewerTransform\(component\)/u);
  assert.match(viewerSource, /applyPrintArtworkOverlays\(/u);

  const component = placeComponent(componentCatalog.chair, "m57-live", 348, 389);
  const editorTransform = placedComponentToViewerTransform(component);
  const visualizationTransform = placedComponentToViewerTransform(component);
  assert.deepEqual(visualizationTransform, editorTransform);
});

test("saved camera views stay camera-only while live artwork is re-applied from current project state", () => {
  const workflowSource = readFileSync("components/workflow/WorkflowSteps.tsx", "utf8");
  const viewerSource = readFileSync("components/configurator/BoothCadViewer.tsx", "utf8");
  assert.match(workflowSource, /visualizationCameraControlsRef\.current\?\.applyView\(view\)/u);
  assert.match(workflowSource, /printSurfaceAssignments=\{project\.printSurfaceAssignments\}/u);
  assert.match(workflowSource, /graphicsFiles=\{project\.graphicsFiles\}/u);
  assert.match(viewerSource, /\[boothSceneRevision, graphicsFiles, printSurfaceAssignments, printSurfaces\]/u);
  assert.doesNotMatch(workflowSource, /view\.(graphicsFiles|printSurfaceAssignments)/u);
});

test("technical snapshot renders the decorated Three scene instead of 2D artwork compositing", () => {
  const viewerSource = readFileSync("components/configurator/BoothCadViewer.tsx", "utf8");
  const decoratorSource = readFileSync("lib/printArtworkOverlays.ts", "utf8");
  assert.match(viewerSource, /applyPrintArtworkOverlays\([\s\S]*?scene:\s*loaded\.scene/u);
  assert.match(viewerSource, /captureRef\.current = \(\) => \{[\s\S]*?renderer\.render\(scene, camera\)[\s\S]*?toDataURL\("image\/png"\)/u);
  assert.match(decoratorSource, /target\.add\(overlay\)/u);
  assert.doesNotMatch(viewerSource, /drawImage|CanvasRenderingContext2D|composite/u);
});

test("VisualizationView stores and restores exact perspective camera position and target", () => {
  const view = saveCameraView({
    name: "Pohled 1",
    position: [3.25, 2.75, 4.5],
    target: [0, 1.1, 0],
    fov: 41,
    order: 0,
  }, "2026-08-24T12:00:00.000Z");
  const restored = cameraStateFromView(view, 38);

  assert.deepEqual(restored.position, { x: 3.25, y: 2.75, z: 4.5 });
  assert.deepEqual(restored.target, { x: 0, y: 1.1, z: 0 });
  assert.equal(restored.fov, 41);
  assert.equal(view.projectionMode, "perspective");
  assert.equal(view.type, "3d");
  assert.equal(view.createdAt, "2026-08-24T12:00:00.000Z");
});

test("Visualization camera and configurator camera use independent controller instances", () => {
  const generatorSource = readFileSync("components/BoothGenerator.tsx", "utf8");
  const workflowSource = readFileSync("components/workflow/WorkflowSteps.tsx", "utf8");
  assert.match(generatorSource, /booth3DCameraControlsRef/u);
  assert.match(workflowSource, /visualizationCameraControlsRef/u);
  assert.doesNotMatch(
    generatorSource.slice(
      generatorSource.indexOf("editorView === \"3d\""),
      generatorSource.indexOf("</section>", generatorSource.indexOf("editorView === \"3d\"")),
    ),
    /visualizationViews|onSaveView|onDeleteView/u,
  );
});

test("canonical Visualization presets face P86 from its open -Y/front side", () => {
  const presets = createVisualizationCameraPresets({
    widthMm: 2000,
    depthMm: 2000,
    heightMm: 2500,
    originConvention: p86.boothAsset?.originConvention,
  });
  const main = presets.find((view) => view.name === "Hlavní")!;
  const left = presets.find((view) => view.name === "Levý")!;
  const right = presets.find((view) => view.name === "Pravý")!;
  const top = presets.find((view) => view.name === "Nadhled")!;

  assert.ok(main.position[2] > main.target[2], "+Three Z is canonical open front (-WORLD Y)");
  assert.ok(left.position[0] < left.target[0]);
  assert.ok(right.position[0] > right.target[0]);
  assert.equal(left.position[2] > left.target[2], true);
  assert.equal(right.position[2] > right.target[2], true);
  assert.ok(top.position[1] > top.target[1]);
  assert.ok(Math.abs(top.position[0] - top.target[0]) < 1e-12);
});

test("saved view is camera-only: assembly visibility and later furniture movement stay live", () => {
  const view = saveCameraView({
    name: "Pohled 1",
    position: [0, 3, 5],
    target: [0, 1, 0],
    order: 0,
  });
  assert.equal("sceneObjects" in view, false);
  assert.equal("constructionVisibility" in view, false);

  const hiddenLeft = resolveBoothAssemblyVisibility(
    p86.boothAsset!.assemblies,
    { HWS_ASM_LEFT_WALL: false },
  );
  assert.equal(hiddenLeft.HWS_ASM_LEFT_WALL, false);

  const before = placeComponent(componentCatalog.chair, "m57-moving", 348, 389);
  const after = { ...before, xMm: 900, yMm: 1200 };
  assert.notDeepEqual(
    placedComponentToViewerTransform(after),
    placedComponentToViewerTransform(before),
  );
  assert.deepEqual(view.position, [0, 3, 5]);
  assert.deepEqual(view.target, [0, 1, 0]);
});

test("Visualization views persist, rename and reorder as project data", () => {
  const first = saveCameraView({ name: "Pohled 1", position: [0, 3, 5], target: [0, 1, 0], order: 0 });
  const second = saveCameraView({ name: "Pohled 2", position: [4, 3, 4], target: [0, 1, 0], order: 1 });
  const project = createProjectRecord({ id: "visualization-project", visualizationViews: [first, second] });
  const reloaded = normalizeProjectRecord(JSON.parse(JSON.stringify(project)));
  assert.deepEqual(reloaded.visualizationViews, [first, second]);

  const renamed = renameVisualizationView(first, "Hlavní klientský");
  assert.equal(renamed.name, "Hlavní klientský");
  assert.deepEqual(
    moveVisualizationView([renamed, second], second.id, -1).map((view) => [view.name, view.order]),
    [["Pohled 2", 0], ["Hlavní klientský", 1]],
  );
});

test("legacy project without views defaults to [] and legacy savedViews upgrade in place", () => {
  const empty = normalizeProjectRecord({ id: "legacy-empty", schemaVersion: 4 });
  assert.deepEqual(empty.visualizationViews, []);

  const migrated = normalizeProjectRecord({
    id: "legacy-camera",
    schemaVersion: 4,
    savedViews: [{
      id: "legacy-view",
      name: "Starý pohled",
      position: [3, 3, 5],
      target: [0, 1, 0],
      fov: 38,
      createdAt: "2026-08-20T10:00:00.000Z",
    }],
  });
  assert.equal(migrated.visualizationViews.length, 1);
  assert.equal(migrated.visualizationViews[0]?.type, "3d");
  assert.equal(migrated.visualizationViews[0]?.projectionMode, "perspective");
  assert.equal(migrated.visualizationViews[0]?.order, 0);
  assert.equal(migrated.savedViews, undefined);
});
