import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGraphicsFileDisplayName,
  buildSurfaceExportFileName,
  extensionOf,
  printSurfaceHumanLabel,
  sanitizeFileNameSegment,
} from "../domain/graphicsFileNaming.ts";
import { P86_CANONICAL_PRINT_SURFACES, P86_FASCIA_PRINT_SURFACE } from "../domain/printSurfaces.ts";
import type { PrintSurface } from "../domain/models.ts";

const backWall01Front = P86_CANONICAL_PRINT_SURFACES.find((surface) => surface.id === "back-wall-01-front")!;
const backWall01Back = P86_CANONICAL_PRINT_SURFACES.find((surface) => surface.id === "back-wall-01-back")!;
const leftWall01Front = P86_CANONICAL_PRINT_SURFACES.find((surface) => surface.id === "left-wall-01-front")!;
const rightWall01Front = P86_CANONICAL_PRINT_SURFACES.find((surface) => surface.id === "right-wall-01-front")!;

// =========================================================================================
// Graphics Export v1, section 1/6/12/13: surface-based human-readable naming, generic over any
// PrintSurface (never a P86 id lookup table).
// =========================================================================================

test("NAMING: buildGraphicsFileDisplayName matches the exact examples from the report for every P86 surface family", () => {
  assert.equal(buildGraphicsFileDisplayName(backWall01Front, "png"), "Zadni_stena_Panel_01_Predni.png");
  assert.equal(buildGraphicsFileDisplayName(backWall01Back, "png"), "Zadni_stena_Panel_01_Zadni.png");
  assert.equal(buildGraphicsFileDisplayName(leftWall01Front, "png"), "Leva_stena_Panel_01_Predni.png");
  assert.equal(buildGraphicsFileDisplayName(rightWall01Front, "png"), "Prava_stena_Panel_01_Predni.png");
  assert.equal(buildGraphicsFileDisplayName(P86_FASCIA_PRINT_SURFACE, "pdf"), "Limec_Predni.pdf");
});

test("NAMING: generic over a surface with NO P86 id at all — a future 'Pult' component names correctly with zero new naming code", () => {
  const counterSurface: PrintSurface = {
    id: "counter-front-01",
    name: "Čelo",
    widthMm: 900,
    heightMm: 1100,
    active: true,
    group: { id: "counter", name: "Pult", order: 9 },
    sceneBinding: { nodeName: "HWS_COUNTER__FRONT", face: "front", coordinateSpace: "node-local", localNormalAxis: "-y" },
  };
  assert.equal(buildGraphicsFileDisplayName(counterSurface, "png"), "Pult_Celo_Predni.png");
});

test("NAMING: printSurfaceHumanLabel produces the on-screen Czech label", () => {
  assert.equal(printSurfaceHumanLabel(backWall01Front), "Zadní stěna – Panel 1 – Přední");
  assert.equal(printSurfaceHumanLabel(P86_FASCIA_PRINT_SURFACE), "Límec – Přední");
});

test("SANITIZER: strips Czech diacritics to plain ASCII without dropping the letters", () => {
  assert.equal(sanitizeFileNameSegment("Zadní stěna"), "Zadni_stena");
  assert.equal(sanitizeFileNameSegment("Přední"), "Predni");
  assert.equal(sanitizeFileNameSegment("Límec"), "Limec");
});

test("SANITIZER: removes filesystem-invalid characters", () => {
  const dirty = 'a/b\\c:d*e?f"g<h>i|j';
  const clean = sanitizeFileNameSegment(dirty);
  for (const forbidden of ["/", "\\", ":", "*", "?", '"', "<", ">", "|"]) {
    assert.ok(!clean.includes(forbidden), `expected "${forbidden}" to be stripped`);
  }
});

test("SANITIZER: never inserts a random UUID — output is deterministic for the same input", () => {
  assert.equal(sanitizeFileNameSegment("Zadní stěna – Panel 1"), sanitizeFileNameSegment("Zadní stěna – Panel 1"));
});

test("EXTENSION: extensionOf preserves the real source extension, buildSurfaceExportFileName uses it (not a fixed/assumed one)", () => {
  assert.equal(extensionOf("01.png"), "png");
  assert.equal(extensionOf("scan.PDF"), "pdf");
  assert.equal(extensionOf("no-extension"), "");
  assert.equal(buildSurfaceExportFileName(P86_FASCIA_PRINT_SURFACE, "01.pdf"), "Limec_Predni.pdf");
  assert.equal(buildSurfaceExportFileName(backWall01Front, "photo.JPG"), "Zadni_stena_Panel_01_Predni.jpg");
});
