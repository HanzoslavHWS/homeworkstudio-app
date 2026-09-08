import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// =========================================================================================
// Technické rastry — regression test for "HLAVNÍ PDF CANVAS JE ÚPLNĚ PRÁZDNÝ" (hotfix batch 2).
//
// ROOT CAUSE: components/workflow/technicalRasters/TechnicalRasterCanvas.tsx keeps its loaded
// pdf.js document in a REF (documentRef), not React state — a slow async load must never force
// extra re-renders while pending. The actual page.render() call lives in a SEPARATE useEffect,
// gated purely by React's documented dependency-array contract: on every render, each dependency
// is compared to its value on the PREVIOUS render with Object.is; the effect body only re-runs if
// at least one dependency differs (or on mount).
//
// A real first-time upload produces this exact sequence (traced from
// TechnicalRasterEditorPage.tsx's handleRasterFileSelected + its rasterUrl-fetch effect, and
// TechnicalRasterCanvas.tsx's own two effects):
//   1. mount, no raster yet (activePage=1, renderKey=0, whiteModeStandLayerId=undefined).
//   2. Upload finishes SYNCHRONOUSLY: project.rasterLayers + rasterSettings.viewMode ("work" by
//      default) are set in the SAME updateProject() call, so whiteModeStandLayerId flips from
//      undefined to a real layer id on this render. pdfUrl is still undefined at this point
//      (getAssetDownloadUrl() hasn't resolved yet), so <canvas> isn't even mounted yet.
//   3. pdfUrl resolves asynchronously -> <canvas> finally mounts. But whiteModeStandLayerId
//      already changed back in step 2 and activePage/renderKey never changed — so NONE of the
//      render effect's own dependencies differ on THIS render.
//   4. loadPdfDocument(pdfUrl)'s promise resolves asynchronously (this is a SEPARATE effect, keyed
//      only on [pdfUrl]) — documentRef.current is now set and canvasRef.current is already
//      attached from step 3, so page.render() COULD run... but with the pre-fix dependency array
//      [activePage, renderKey, whiteModeStandLayerId], nothing changed on this render either.
//
// Result (pre-fix): the render effect fires exactly twice (mount, and once more when
// whiteModeStandLayerId first resolves) and NEVER AGAIN — both times with documentRef.current
// still null — so page.render() is never called. Data-only UI (stand count, OCG layer list) comes
// from other code paths and looks fine; only the canvas itself stays blank.
//
// FIX: a `documentVersion` counter, bumped exactly when loadPdfDocument's promise resolves, was
// added to the render effect's dependency array. Step 4 above then legitimately changes a
// dependency, so the effect reruns with both documentRef.current and canvasRef.current ready.
//
// This repo's test runner has no JSX/DOM transform (no test here imports a .tsx file directly),
// so this file does not mount the real component. Instead it (a) implements React's own
// documented per-index Object.is dependency comparison as a tiny, generic scheduler and replays
// the exact real-world sequence above against BOTH the pre-fix and the fixed dependency shape, and
// (b) pins the actual source file so the fix can't be silently reverted by editing the deps array
// back down to three values.
// =========================================================================================

type DepsSnapshot = readonly unknown[];

/** React's documented useEffect re-run rule (a fixed-size deps array, so a length change is not a real case and is treated as "changed" rather than specially handled). */
function makeEffectScheduler(onFire: () => void) {
  let previous: DepsSnapshot | undefined;
  return function commitRender(deps: DepsSnapshot): void {
    const changed = !previous || previous.length !== deps.length || deps.some((value, index) => !Object.is(value, previous![index]));
    previous = deps;
    if (changed) onFire();
  };
}

test("BUG REPRODUCTION: the pre-fix 3-value dependency array [activePage, renderKey, whiteModeStandLayerId] never re-fires once the document load resolves after the canvas already mounted", () => {
  let renderCount = 0;
  const commit = makeEffectScheduler(() => { renderCount += 1; });

  commit([1, 0, undefined]); // step 1: mount, nothing uploaded yet
  commit([1, 0, "46R"]); // step 2: upload finishes synchronously, whiteModeStandLayerId resolves, pdfUrl still unset
  commit([1, 0, "46R"]); // step 3: pdfUrl resolves, canvas mounts, but no tracked dep changed
  const rendersBeforeDocumentReady = renderCount;

  commit([1, 0, "46R"]); // step 4: loadPdfDocument resolves — nothing in this array changed
  assert.equal(renderCount, rendersBeforeDocumentReady, "reproduces the blank-canvas bug: document readiness is invisible to a 3-value dependency array that already settled beforehand");
});

test("FIX: adding documentVersion makes the render effect fire exactly when the async document load resolves, even though none of the other three values change on that render", () => {
  let renderCount = 0;
  const commit = makeEffectScheduler(() => { renderCount += 1; });

  commit([1, 0, undefined, 0]); // step 1: mount
  commit([1, 0, "46R", 0]); // step 2: upload finishes synchronously
  commit([1, 0, "46R", 0]); // step 3: pdfUrl resolves, canvas mounts
  const rendersBeforeDocumentReady = renderCount;

  commit([1, 0, "46R", 1]); // step 4: loadPdfDocument resolves -> documentVersion bumped
  assert.equal(renderCount, rendersBeforeDocumentReady + 1, "documentVersion changing is what makes the effect rerun once the document is actually ready");
});

test("source guard: TechnicalRasterCanvas's render effect dependency array still includes documentVersion (prevents silently reintroducing the blank-canvas bug by trimming the deps array back down)", async () => {
  const source = await readFile(
    new URL("../components/workflow/technicalRasters/TechnicalRasterCanvas.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /\}, \[activePage, renderKey, whiteModeStandLayerId, whiteFillOpacity, documentVersion, renderScaleTrigger\]\);/u,
    "the render effect's dependency array must include documentVersion — see TechnicalRasterCanvas.tsx's own comment on documentVersion for why",
  );
  assert.match(
    source,
    /setDocumentVersion\(\(version\) => version \+ 1\)/u,
    "documentVersion must actually be bumped when loadPdfDocument's promise resolves, not just declared",
  );
});
