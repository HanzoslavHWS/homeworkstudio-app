import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { withoutTechnicalRasterProject, type TechnicalRasterProjectSummary } from "../domain/technicalRaster.ts";

// =========================================================================================
// Technické rastry — project list "delete project" regression tests (spec batch 6, UI section
// 35-45, 52; re-diagnosed in a CORRECTIVE BATCH after real manual acceptance still found the AKCE
// column visually empty). TWO separate, sequential root causes have been found and fixed here —
// both are guarded below so neither can silently regress:
//
//   1. (earlier batch) The POPUP MENU LIST was `position: absolute` inside `.printSurfaceTable`,
//      which sets `overflow: hidden` (shared with PrintSurfaceProjectListPage.tsx/
//      PrintSurfaceList.tsx, load-bearing there for the table's own rounded-corner clipping — so it
//      can't just be removed) — the popup rendered into the DOM but was always clipped away. Fixed
//      by rendering it through a React portal into document.body as `position: fixed`, computed
//      from the trigger's own getBoundingClientRect().
//   2. (THIS corrective batch — the actual remaining cause of "AKCE is empty") The "⋯" TRIGGER
//      BUTTON ITSELF lives inside the ROW's own CSS Grid (`.printSurfaceProjectRow`), never inside
//      the portal — fix #1 never touched it. That shared grid class's own `grid-template-columns`
//      (9 tracks sized for PrintSurfaceProjectListPage.tsx's own columns) has a real minimum total
//      width of roughly 1120px — comfortably wider than many real content-area widths once a
//      sidebar nav is accounted for — and since the same `.printSurfaceTable` ancestor has
//      `overflow: hidden` with no horizontal scrollbar, a too-narrow container simply CLIPS the
//      grid's own overflow, and the LAST column ("Akce", holding the trigger button) disappears
//      first. Fixed with a dedicated, narrower `grid-template-columns` for
//      `.technicalRasterProjectTable .printSurfaceProjectRow` (app/globals.css) sized for this
//      table's actual 9 columns, plus `overflow-x: auto` on the table itself as a safety net (never
//      touching `overflow-y`, which stays `hidden` — preserving the rounded-corner clipping
//      `.printSurfaceTable`'s own comment describes) for any viewport narrower than that.
//
// This repo's test runner has no JSX/DOM transform (same constraint as every other
// TechnicalRasterCanvas-adjacent regression test in this suite), so this file combines (a) a real
// unit test of the pure list-removal helper, and (b) precise source-level guards (component JSX +
// the actual CSS file) pinning the exact structural facts both fixes depend on.
// =========================================================================================

async function readListPageSource(): Promise<string> {
  return readFile(new URL("../components/workflow/technicalRasters/TechnicalRasterProjectListPage.tsx", import.meta.url), "utf8");
}

async function readGlobalsCss(): Promise<string> {
  return readFile(new URL("../app/globals.css", import.meta.url), "utf8");
}

function makeSummary(id: string, name = id): TechnicalRasterProjectSummary {
  return { id, name, hasRaster: false, standCount: 0, unassignedCount: 0, ambiguousCount: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}

test("delete removes exactly the matching project from a local list (success path) — withoutTechnicalRasterProject", () => {
  const projects = [makeSummary("p1"), makeSummary("p2"), makeSummary("p3")];
  const result = withoutTechnicalRasterProject(projects, "p2");
  assert.deepEqual(result.map((p) => p.id), ["p1", "p3"]);
});

test("source guard: the delete action is part of EVERY project row's render path — one <button> per row, not conditionally omitted", async () => {
  const source = await readListPageSource();
  assert.match(source, /projects\.map\(\(project\) => \(/u, "rows are rendered via .map(), so the trigger button below is emitted for every project");
  assert.match(source, /className="technicalRasterProjectRowMenuTrigger"/u);
  assert.match(source, /aria-label=\{`Další akce – \$\{project\.name\}`\}/u, "the trigger is scoped to THIS row's own project, not a stale/shared one");
});

test("source guard: the popup menu is rendered through a React portal into document.body, NOT position:absolute inside the clipped table — this is the actual fix for the invisible-menu bug", async () => {
  const source = await readListPageSource();
  assert.match(source, /import \{ createPortal \} from "react-dom";/u);
  assert.match(source, /createPortal\(/u);
  assert.match(source, /document\.body,?\s*\)/u, "the portal target must be document.body — anything still inside .printSurfaceTable would be clipped again");
  assert.match(source, /position:\s*"fixed"/u, "position: fixed (not absolute) — computed from the trigger's own getBoundingClientRect(), immune to the ancestor's overflow: hidden");
});

test("source guard: menu position is computed from the trigger's own getBoundingClientRect(), not a guess", async () => {
  const source = await readListPageSource();
  assert.match(source, /getBoundingClientRect\(\)/u);
  assert.match(source, /menuAnchorRect\.bottom/u);
});

test("source guard: existing repository.delete() is used — no new endpoint/backend path introduced by this batch", async () => {
  const source = await readListPageSource();
  assert.match(source, /projectRepository\.delete\(project\.id\)/u);
  assert.ok(!source.includes("fetch(\"/api/technical-rasters/projects/delete-v2\""), "no new/duplicate backend path");
});

test("source guard: window.confirm() is used for the delete confirmation, with the exact requested Czech message shape", async () => {
  const source = await readListPageSource();
  assert.match(source, /window\.confirm\(`Opravdu chcete smazat projekt „\$\{project\.name\}“\?/u);
  assert.match(source, /Projekt a jeho uložená data budou odstraněny\./u);
});

test("source guard: deletingId both drives the pending label and guards against a double submit (re-entrant call bails out first)", async () => {
  const source = await readListPageSource();
  const fnStart = source.indexOf("async function handleDeleteProject(");
  const fnEnd = source.indexOf("\n  }\n", fnStart);
  const body = source.slice(fnStart, fnEnd);
  assert.match(body, /if \(deletingId\) return;/u, "double-submit guard must be the very first check");
  assert.match(source, /\{deletingId === (menuProject|project)\.id \? "Mazání…" : "Smazat projekt"\}/u);
});

test("source guard: on failure the project is never removed from local state (setProjects is only called inside the try block, after a successful delete)", async () => {
  const source = await readListPageSource();
  const fnStart = source.indexOf("async function handleDeleteProject(");
  const fnEnd = source.indexOf("\n  }\n", fnStart);
  const body = source.slice(fnStart, fnEnd);
  const catchStart = body.indexOf("} catch (error) {");
  const catchBody = body.slice(catchStart);
  assert.ok(!catchBody.includes("setProjects("), "the catch block must never call setProjects — a failed delete leaves the local list untouched");
  assert.match(catchBody, /setDeleteError\(/u);
});

test("source guard: cancelling window.confirm() returns immediately, before deletingId/setProjects/repository.delete are ever touched", async () => {
  const source = await readListPageSource();
  const fnStart = source.indexOf("async function handleDeleteProject(");
  const confirmLine = source.indexOf("if (!window.confirm(", fnStart);
  const setDeletingIdLine = source.indexOf("setDeletingId(project.id)", fnStart);
  assert.ok(confirmLine > 0 && setDeletingIdLine > confirmLine, "the confirm() check must run BEFORE any state-changing call");
});

// =========================================================================================
// CORRECTIVE BATCH — root cause #2 (the ACTUAL remaining reason AKCE was empty): the row's own
// grid-template-columns overflowed a real, narrower content area, clipping the trigger button
// itself (never the popup, which the earlier portal fix already handles correctly).
// =========================================================================================

test("CSS guard: the technical-raster table has its OWN, narrower grid-template-columns override — never silently falls back to the shared .printSurfaceProjectRow's wider (print-surface-sized) column widths, which is what clipped the AKCE column off-screen", async () => {
  const css = await readGlobalsCss();
  assert.match(css, /\.technicalRasterProjectTable \.printSurfaceProjectRow\s*\{[^}]*grid-template-columns:/u, "a dedicated, more specific selector must override the shared row's column widths for this table");
});

test("CSS guard: the technical-raster table has a horizontal-scroll safety net (overflow-x: auto) — AKCE must be reachable (by scrolling) even in a viewport narrower than this table's own minimum width, never silently clipped again", async () => {
  const css = await readGlobalsCss();
  assert.match(css, /\.technicalRasterProjectTable\s*\{[^}]*overflow-x:\s*auto/u);
});

test("CSS guard: the horizontal-scroll fix never touches overflow-y — the shared .printSurfaceTable's own rounded-corner row-background clipping (vertical) must stay completely intact", async () => {
  const css = await readGlobalsCss();
  const ruleMatch = /\.technicalRasterProjectTable\s*\{([^}]*)\}/u.exec(css);
  assert.ok(ruleMatch, "expected a .technicalRasterProjectTable rule block");
  assert.ok(!ruleMatch![1].includes("overflow-y"), "must never override overflow-y — only overflow-x, to preserve the shared table's own vertical clipping");
  assert.ok(!ruleMatch![1].includes("overflow:"), "must never set the 'overflow' shorthand here, which would also reset overflow-y back to visible/auto");
});
