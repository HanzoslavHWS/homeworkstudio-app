import assert from "node:assert/strict";
import test from "node:test";
import { assembleVisualizationZipEntries } from "../lib/visualizationRenderDownloads.ts";
import {
  buildVisualizationPackageName,
  buildVisualizationRenderFileName,
  deduplicateRenderFileNames,
} from "../domain/visualizationRender.ts";

const TINY_PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

// =========================================================================================
// Visualization v2 — individual/bulk render downloads (report sections 21/22/37).
// =========================================================================================

test("FILENAME: individual render filename matches buildVisualizationRenderFileName exactly", () => {
  const fileName = buildVisualizationRenderFileName({ eventName: "Beauty", projectName: "Test01", viewName: "Hlavní", extension: "jpg" });
  assert.equal(fileName, "FOR_BEAUTY_Test01_Hlavni.jpg");
});

test("PACKAGE NAME: FOR_<EVENT>_<PROJECT>_VIZUALIZACE, same sanitizer as Graphics Production Package", () => {
  assert.equal(buildVisualizationPackageName({ eventName: "Beauty", projectName: "Test01" }), "FOR_BEAUTY_Test01_VIZUALIZACE");
});

test("ZIP: contains one entry per selected render, correctly namespaced under the package folder", () => {
  const result = assembleVisualizationZipEntries("FOR_BEAUTY_Test01_VIZUALIZACE", [
    { fileName: "FOR_BEAUTY_Test01_Hlavni.jpg", dataUrl: TINY_PNG_DATA_URL },
    { fileName: "FOR_BEAUTY_Test01_Levy.jpg", dataUrl: TINY_PNG_DATA_URL },
  ]);
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  assert.deepEqual(result.entries.map((entry) => entry.path), [
    "FOR_BEAUTY_Test01_VIZUALIZACE/FOR_BEAUTY_Test01_Hlavni.jpg",
    "FOR_BEAUTY_Test01_VIZUALIZACE/FOR_BEAUTY_Test01_Levy.jpg",
  ]);
});

test("ZIP: optionally embeds presentation.pdf alongside the renders", () => {
  const result = assembleVisualizationZipEntries(
    "FOR_BEAUTY_Test01_VIZUALIZACE",
    [{ fileName: "FOR_BEAUTY_Test01_Hlavni.jpg", dataUrl: TINY_PNG_DATA_URL }],
    { fileName: "presentation.pdf", bytes: new Uint8Array([1, 2, 3]) },
  );
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  const pdfEntry = result.entries.find((entry) => entry.path.endsWith("presentation.pdf"));
  assert.ok(pdfEntry);
  assert.deepEqual(pdfEntry!.data, new Uint8Array([1, 2, 3]));
});

test("DEDUP: duplicate view names produce deterministically deduplicated -2/-3 filenames, never overwriting each other", () => {
  const files = [
    { viewId: "v1", fileName: "FOR_BEAUTY_Test01_Vstup.jpg" },
    { viewId: "v2", fileName: "FOR_BEAUTY_Test01_Vstup.jpg" },
  ];
  const deduped = deduplicateRenderFileNames(files);
  const result = assembleVisualizationZipEntries("FOR_BEAUTY_Test01_VIZUALIZACE", deduped.map((file) => ({ fileName: file.fileName, dataUrl: TINY_PNG_DATA_URL })));
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  const paths = result.entries.map((entry) => entry.path);
  assert.equal(new Set(paths).size, paths.length, "no two entries share a path — nothing was silently overwritten");
});

test("FAILURE: a render with no resolvable image data fails the whole ZIP build explicitly, never a silently incomplete ZIP", () => {
  const result = assembleVisualizationZipEntries("FOR_BEAUTY_Test01_VIZUALIZACE", [
    { fileName: "FOR_BEAUTY_Test01_Hlavni.jpg", dataUrl: TINY_PNG_DATA_URL },
    { fileName: "FOR_BEAUTY_Test01_Levy.jpg", dataUrl: undefined },
  ]);
  assert.equal(result.ok, false);
  if (result.ok !== false) return;
  assert.deepEqual(result.failedFiles, ["FOR_BEAUTY_Test01_Levy.jpg"]);
});
