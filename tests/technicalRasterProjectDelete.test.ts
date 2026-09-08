import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { withoutTechnicalRasterProject, type TechnicalRasterProjectSummary } from "../domain/technicalRaster.ts";

// =========================================================================================
// Technické rastry — project list "delete project" regression tests (spec batch 6, UI section
// 35-45, 52). ROOT CAUSE of the delete action being invisible in the real browser (confirmed by
// reading the actual rendered CSS, not by re-trusting an earlier report — spec section 37): the
// project list reuses .printSurfaceTable, which sets `overflow: hidden` (shared with
// PrintSurfaceProjectListPage.tsx / PrintSurfaceList.tsx, load-bearing there for the table's own
// rounded-corner clipping — so it can't just be removed). A `position: absolute` popup menu inside
// that container rendered into the DOM but was ALWAYS clipped away, even though the "⋯" trigger
// button itself was perfectly visible. Fixed by rendering the popup through a React portal into
// document.body as `position: fixed`, computed from the trigger's own getBoundingClientRect() —
// entirely outside the clipped ancestor.
//
// This repo's test runner has no JSX/DOM transform (same constraint as every other
// TechnicalRasterCanvas-adjacent regression test in this suite), so this file combines (a) a real
// unit test of the pure list-removal helper, and (b) precise source-level guards pinning the exact
// structural facts the portal fix depends on, so a later edit can't silently reintroduce the
// overflow-hidden clipping bug.
// =========================================================================================

async function readListPageSource(): Promise<string> {
  return readFile(new URL("../components/workflow/technicalRasters/TechnicalRasterProjectListPage.tsx", import.meta.url), "utf8");
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
