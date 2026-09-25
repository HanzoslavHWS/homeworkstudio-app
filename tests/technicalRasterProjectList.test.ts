import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { handleTechnicalRasterProjectSave } from "../app/api/technical-rasters/projects/save/route.ts";
import { createSessionToken } from "../lib/auth/session.ts";
import type { EventIdResolver } from "../lib/db/eventIdValidation.server.ts";
import { resolveCanonicalEventId } from "../domain/eventIdentity.ts";
import {
  assignStandManually,
  createDefaultRasterSettings,
  createTechnicalRasterProject,
  mergeTechnicalRasterImport,
  placeTechnicalService,
  summarizeTechnicalRasterProject,
  type ParsedTechnicalReport,
  type TechnicalRasterProject,
  type TechnicalRasterProjectCreateInput,
  type TechnicalRasterProjectRepository,
  type TechnicalRasterProjectSummary,
} from "../domain/technicalRaster.ts";
import {
  buildTechnicalRasterProjectFilterOptions,
  DEFAULT_TECHNICAL_RASTER_PROJECT_LIST_VIEW,
  filterAndSortTechnicalRasterProjects,
  PROJECT_FILTER_ALL,
  PROJECT_FILTER_NONE,
  projectHallFilterKey,
  replaceTechnicalRasterProjectSummary,
  resolveEditableEventId,
  updateTechnicalRasterProjectMetadata,
  validateTechnicalRasterProjectMetadata,
  withTechnicalRasterProjectMetadata,
  type TechnicalRasterProjectListView,
} from "../domain/technicalRasterProjectList.ts";
import type { StoredAsset } from "../domain/assets.ts";

// =========================================================================================
// Production-workflow batch, part A — Technical Raster project metadata editing + list
// filtering/sorting. No DOM test library in this repo (see tests/technicalRasterProjectDelete.test.ts),
// so behavior is tested through the pure domain module the list page delegates to, plus source
// guards pinning the page's wiring.
// =========================================================================================

const EVENTS = [
  { id: "beauty", name: "FOR BEAUTY" },
  { id: "decor", name: "FOR DECOR" },
  { id: "arch", name: "FOR ARCH" },
];
const KNOWN_EVENT_IDS = new Set(EVENTS.map((event) => event.id));

function makeAsset(id: string): StoredAsset {
  return { id, storageKey: `technical-rasters/p1/source/${id}.pdf`, originalFileName: `${id}.pdf`, mimeType: "application/pdf", size: 100, createdAt: "2026-01-01T00:00:00.000Z", category: "technical-raster-source" };
}

/** A project with REAL content in every persisted area — raster asset, layers, labels, settings, an import, a matched stand with a placement. */
function buildRichProject(): TechnicalRasterProject {
  let project = createTechnicalRasterProject({ name: "FOR DECOR — Hala 1", eventId: "decor", hall: "Hala 1" }, "project-1");
  project = { ...project, sourceRasterAsset: makeAsset("raster"), rasterLayers: [{ id: "layer-1", name: "Stánky", defaultVisible: true }], rasterSettings: { ...createDefaultRasterSettings(), viewMode: "work", sourceLayerTextScales: { "layer-1": 0.7 } } };
  const report: ParsedTechnicalReport = {
    category: "electricity",
    rows: [{ standNumber: "1A21", services: [{ category: "electricity", externalLabel: "Do 3kW 230V", quantity: 2, rawValue: "2", sourcePage: 1 }], notes: [] }],
    warnings: [],
  };
  project = mergeTechnicalRasterImport(
    project,
    { id: "imp-1", category: "electricity", filename: "el.pdf", asset: makeAsset("imp"), importedAt: "2026-01-01T00:00:00.000Z", parserVersion: "v1", parseStatus: "ok", standsFound: 1, servicesFound: 1, warnings: [] },
    report,
    () => ({ status: "unresolved_product" as const }),
  );
  const standId = project.stands[0]!.id;
  project = assignStandManually(project, standId, { page: 1, anchorXNormalized: 0.2, anchorYNormalized: 0.3 });
  project = placeTechnicalService(project, standId, project.stands[0]!.services[0]!.id, { page: 1, xNormalized: 0.4, yNormalized: 0.5 });
  return project;
}

/** In-memory repository with the same get/save/list contract as the Supabase one; `failSave` simulates a backend failure. */
function memoryRepository(initial: readonly TechnicalRasterProject[], options: { failSave?: boolean } = {}) {
  const rows = new Map(initial.map((project) => [project.id, structuredClone(project)]));
  let saveCalls = 0;
  const repository: TechnicalRasterProjectRepository = {
    async list() { return [...rows.values()].map(summarizeTechnicalRasterProject); },
    async get(id) { const row = rows.get(id); return row ? structuredClone(row) : undefined; },
    async create(input: TechnicalRasterProjectCreateInput) { const project = createTechnicalRasterProject(input, `p-${rows.size + 1}`); rows.set(project.id, project); return project; },
    async save(project) {
      saveCalls += 1;
      if (options.failSave) throw new Error("Uložení projektu technického rastru selhalo.");
      const updated = { ...structuredClone(project), updatedAt: "2026-03-01T00:00:00.000Z" };
      rows.set(project.id, updated);
      return structuredClone(updated);
    },
    async delete(id) { rows.delete(id); },
  };
  return { repository, rows, saveCalls: () => saveCalls };
}

function summary(id: string, overrides: Partial<TechnicalRasterProjectSummary> = {}): TechnicalRasterProjectSummary {
  return { id, name: id, hasRaster: true, standCount: 0, unassignedCount: 0, ambiguousCount: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...overrides };
}

async function readListPageSource(): Promise<string> {
  return readFile(new URL("../components/workflow/technicalRasters/TechnicalRasterProjectListPage.tsx", import.meta.url), "utf8");
}

// =========================================================================================
// Project editing
// =========================================================================================

test("EDIT: validate requires a name; trims values; empty event/hall become undefined", () => {
  assert.deepEqual(validateTechnicalRasterProjectMetadata({ name: "   ", eventId: "beauty", hall: "Hala 3" }), { ok: false, message: "Zadejte název projektu." });
  assert.deepEqual(validateTechnicalRasterProjectMetadata({ name: "  X ", eventId: " ", hall: "  Hala 3 " }), { ok: true, value: { name: "X", eventId: undefined, hall: "Hala 3" } });
});

test("EDIT: withTechnicalRasterProjectMetadata changes ONLY name/event/hall — id and every piece of raster/project data stay identical", () => {
  const project = buildRichProject();
  const edited = withTechnicalRasterProjectMetadata(project, { name: "FOR BEAUTY — Hala 3", eventId: "beauty", hall: "Hala 3" });
  assert.equal(edited.id, project.id);
  assert.equal(edited.name, "FOR BEAUTY — Hala 3");
  assert.equal(edited.eventId, "beauty");
  assert.equal(edited.hall, "Hala 3");
  const { name: _n1, eventId: _e1, hall: _h1, ...restBefore } = project;
  const { name: _n2, eventId: _e2, hall: _h2, ...restAfter } = edited;
  assert.deepEqual(restAfter, restBefore, "raster asset, layers, settings, labels, imports, stands, placements, timestamps unchanged");
  assert.equal(edited.stands, project.stands, "stands carried over by reference — nothing rematched");
});

test("EDIT: updateTechnicalRasterProjectMetadata persists name, event and hall through the existing get()+save(), keeps the id, and a refresh (list/get) returns the edited values", async () => {
  const original = buildRichProject();
  const { repository, rows } = memoryRepository([original]);
  const saved = await updateTechnicalRasterProjectMetadata(repository, original.id, { name: "FOR BEAUTY — Hala 3", eventId: "beauty", hall: "Hala 3" });
  assert.equal(saved.id, original.id, "project id unchanged — never recreated");
  assert.equal(rows.size, 1, "no second project was created");

  const refreshedList = await repository.list();
  assert.deepEqual(refreshedList.map((p) => [p.id, p.name, p.eventId, p.hall]), [[original.id, "FOR BEAUTY — Hala 3", "beauty", "Hala 3"]]);
  const refreshed = (await repository.get(original.id))!;
  assert.deepEqual(refreshed.stands, original.stands, "imported services, matching and placements preserved");
  assert.deepEqual(refreshed.imports, original.imports);
  assert.deepEqual(refreshed.rasterSettings, original.rasterSettings, "raster/text-scale settings preserved");
  assert.deepEqual(refreshed.rasterLayers, original.rasterLayers);
  assert.deepEqual(refreshed.sourceRasterAsset, original.sourceRasterAsset, "raster never re-imported");
});

test("EDIT: an invalid name never reaches save()", async () => {
  const { repository, saveCalls } = memoryRepository([buildRichProject()]);
  await assert.rejects(updateTechnicalRasterProjectMetadata(repository, "project-1", { name: "  " }), /Zadejte název projektu/u);
  assert.equal(saveCalls(), 0);
});

test("EDIT: a failed save rejects and leaves the persisted project exactly as it was", async () => {
  const original = buildRichProject();
  const { repository, rows } = memoryRepository([original], { failSave: true });
  await assert.rejects(updateTechnicalRasterProjectMetadata(repository, original.id, { name: "Nový", eventId: "beauty", hall: "Hala 3" }), /selhalo/u);
  const stored = rows.get(original.id)!;
  assert.equal(stored.name, original.name);
  assert.equal(stored.eventId, original.eventId);
  assert.equal(stored.hall, original.hall);
});

test("EDIT: an unknown project id rejects without saving", async () => {
  const { repository, saveCalls } = memoryRepository([]);
  await assert.rejects(updateTechnicalRasterProjectMetadata(repository, "missing", { name: "X" }), /nebyl nalezen/u);
  assert.equal(saveCalls(), 0);
});

test("EDIT: replaceTechnicalRasterProjectSummary swaps the edited row in place (same position, other rows untouched)", () => {
  const list = [summary("a"), summary("b", { name: "Old" }), summary("c")];
  const updated = replaceTechnicalRasterProjectSummary(list, summary("b", { name: "New", hall: "Hala 3" }));
  assert.deepEqual(updated.map((p) => [p.id, p.name]), [["a", "a"], ["b", "New"], ["c", "c"]]);
  assert.equal(updated[0], list[0]);
});

// ---- event canonical id -----------------------------------------------------------------

test("EVENT: the dialog preselects the CANONICAL id for a stored legacy alias, keeps a canonical id as-is, never drops an unknown id", () => {
  assert.equal(resolveEditableEventId("for-beauty-autumn-2026", KNOWN_EVENT_IDS), "beauty");
  assert.equal(resolveEditableEventId("decor", KNOWN_EVENT_IDS), "decor");
  assert.equal(resolveEditableEventId(undefined, KNOWN_EVENT_IDS), "");
  assert.equal(resolveEditableEventId("mystery-event", KNOWN_EVENT_IDS), "mystery-event");
  assert.equal(resolveEditableEventId("for-beauty-autumn-2026", KNOWN_EVENT_IDS), resolveCanonicalEventId("for-beauty-autumn-2026", KNOWN_EVENT_IDS), "same resolver as the save route");
});

/** A client-side repository whose save() goes through the REAL save route handler (auth + event resolver), backed by an in-memory store. */
async function routeBackedRepository(initial: TechnicalRasterProject) {
  const secret = "technical-raster-project-list-test-secret-32ch";
  (process.env as Record<string, string | undefined>).APP_SESSION_SECRET = secret;
  const token = await createSessionToken(secret);
  const inner = memoryRepository([initial]);
  const resolverFactory = (): EventIdResolver => async (eventId) => {
    const resolved = resolveCanonicalEventId(eventId, KNOWN_EVENT_IDS);
    if (!eventId?.trim()) return { ok: true, eventId: undefined };
    return resolved ? { ok: true, eventId: resolved } : { ok: false, message: "Vybraný veletrh není v databázi." };
  };
  const repository: TechnicalRasterProjectRepository = {
    ...inner.repository,
    async save(project) {
      const request = new NextRequest("http://localhost/api/technical-rasters/projects/save", {
        method: "POST",
        headers: { Cookie: `homeworkstudio_session=${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ project }),
      });
      const response = await handleTechnicalRasterProjectSave(request, () => inner.repository, resolverFactory);
      const body = (await response.json()) as { project?: TechnicalRasterProject; error?: string };
      if (!response.ok || !body.project) throw new Error(body.error ?? "save failed");
      return body.project;
    },
  };
  return { repository, rows: inner.rows };
}

test("EVENT: changing the event through the real save route persists the CANONICAL id — a legacy edition id is normalized to 'beauty', never stored as-is", async () => {
  const original = buildRichProject();
  const { repository, rows } = await routeBackedRepository(original);
  const saved = await updateTechnicalRasterProjectMetadata(repository, original.id, { name: original.name, eventId: "for-beauty-autumn-2026", hall: original.hall });
  assert.equal(saved.eventId, "beauty");
  assert.equal(rows.get(original.id)!.eventId, "beauty");
  assert.equal(rows.get(original.id)!.id, original.id);
});

test("EVENT: an unresolvable event is rejected by the save route and the stored project keeps its previous event", async () => {
  const original = buildRichProject();
  const { repository, rows } = await routeBackedRepository(original);
  await assert.rejects(updateTechnicalRasterProjectMetadata(repository, original.id, { name: original.name, eventId: "no-such-event" }), /není v databázi/u);
  assert.equal(rows.get(original.id)!.eventId, "decor");
});

// ---- hall -------------------------------------------------------------------------------

test("HALL: changing the hall persists it and never touches stand matching / raster labels", async () => {
  const original = buildRichProject();
  const { repository } = memoryRepository([original]);
  const saved = await updateTechnicalRasterProjectMetadata(repository, original.id, { name: original.name, eventId: original.eventId, hall: "Hala 4" });
  assert.equal(saved.hall, "Hala 4");
  assert.deepEqual(saved.stands.map((stand) => stand.placement), original.stands.map((stand) => stand.placement));
  assert.deepEqual(saved.rasterStandLabels, original.rasterStandLabels);
});

test("HALL: clearing the hall stores undefined (no hall)", async () => {
  const { repository } = memoryRepository([buildRichProject()]);
  const saved = await updateTechnicalRasterProjectMetadata(repository, "project-1", { name: "X", eventId: "decor", hall: "   " });
  assert.equal(saved.hall, undefined);
});

// =========================================================================================
// Filtering / sorting
// =========================================================================================

const LIST: readonly TechnicalRasterProjectSummary[] = [
  summary("decor-h1", { name: "Decor hala 1", eventId: "decor", hall: "Hala 1", updatedAt: "2026-01-03T00:00:00.000Z" }),
  summary("beauty-h3", { name: "Beauty hala 3", eventId: "beauty", hall: "Hala 3", updatedAt: "2026-01-05T00:00:00.000Z" }),
  summary("beauty-h4", { name: "Beauty hala 4", eventId: "beauty", hall: "Hala 4", updatedAt: "2026-01-01T00:00:00.000Z" }),
  summary("legacy-beauty-h3", { name: "Àrchiv beauty", eventId: "for-beauty-autumn-2026", hall: " hala  3 ", updatedAt: "2026-01-02T00:00:00.000Z" }),
  summary("no-meta", { name: "Zkušební", updatedAt: "2026-01-04T00:00:00.000Z" }),
];

function view(overrides: Partial<TechnicalRasterProjectListView>): TechnicalRasterProjectListView {
  return { ...DEFAULT_TECHNICAL_RASTER_PROJECT_LIST_VIEW, ...overrides };
}
function ids(projects: readonly TechnicalRasterProjectSummary[]): string[] {
  return projects.map((project) => project.id);
}

test("FILTER: options are derived from the loaded projects (labels from the event catalog, canonical ids as values) — never a hardcoded list", () => {
  const options = buildTechnicalRasterProjectFilterOptions(LIST, EVENTS);
  assert.deepEqual(options.events, [{ value: "beauty", label: "FOR BEAUTY" }, { value: "decor", label: "FOR DECOR" }, { value: PROJECT_FILTER_NONE, label: "Bez veletrhu" }], "arch has no project -> not offered; legacy alias folds into beauty");
  assert.deepEqual(options.halls.map((option) => option.label), ["Hala 1", "Hala 3", "Hala 4", "Bez haly"], "' hala  3 ' folds into 'Hala 3' by stable key");
});

test("FILTER: event filter matches by canonical id (legacy alias included)", () => {
  assert.deepEqual(ids(filterAndSortTechnicalRasterProjects(LIST, view({ eventFilter: "beauty" }), KNOWN_EVENT_IDS)).sort(), ["beauty-h3", "beauty-h4", "legacy-beauty-h3"]);
});

test("FILTER: hall filter matches by normalized hall key", () => {
  assert.deepEqual(ids(filterAndSortTechnicalRasterProjects(LIST, view({ hallFilter: projectHallFilterKey("Hala 3") }), KNOWN_EVENT_IDS)).sort(), ["beauty-h3", "legacy-beauty-h3"]);
});

test("FILTER: event + hall combine (FOR BEAUTY + Hala 4 -> only that project)", () => {
  assert.deepEqual(ids(filterAndSortTechnicalRasterProjects(LIST, view({ eventFilter: "beauty", hallFilter: projectHallFilterKey("Hala 4") }), KNOWN_EVENT_IDS)), ["beauty-h4"]);
});

test("FILTER: clearing the event keeps the hall filter; clearing the hall keeps the event filter", () => {
  const hall3 = projectHallFilterKey("Hala 3");
  assert.deepEqual(ids(filterAndSortTechnicalRasterProjects(LIST, view({ eventFilter: PROJECT_FILTER_ALL, hallFilter: hall3 }), KNOWN_EVENT_IDS)).sort(), ["beauty-h3", "legacy-beauty-h3"]);
  assert.deepEqual(ids(filterAndSortTechnicalRasterProjects(LIST, view({ eventFilter: "decor", hallFilter: PROJECT_FILTER_ALL }), KNOWN_EVENT_IDS)), ["decor-h1"]);
});

test("FILTER: 'Všechny' on both returns every project; 'Bez veletrhu'/'Bez haly' match projects missing that value", () => {
  assert.equal(filterAndSortTechnicalRasterProjects(LIST, view({}), KNOWN_EVENT_IDS).length, LIST.length);
  assert.deepEqual(ids(filterAndSortTechnicalRasterProjects(LIST, view({ eventFilter: PROJECT_FILTER_NONE }), KNOWN_EVENT_IDS)), ["no-meta"]);
  assert.deepEqual(ids(filterAndSortTechnicalRasterProjects(LIST, view({ hallFilter: PROJECT_FILTER_NONE }), KNOWN_EVENT_IDS)), ["no-meta"]);
});

test("SORT: default 'Nejnovější' is updatedAt desc (the repository's own existing order); 'Nejstarší' is the reverse", () => {
  assert.equal(DEFAULT_TECHNICAL_RASTER_PROJECT_LIST_VIEW.sort, "newest");
  assert.deepEqual(ids(filterAndSortTechnicalRasterProjects(LIST, view({ sort: "newest" }), KNOWN_EVENT_IDS)), ["beauty-h3", "no-meta", "decor-h1", "legacy-beauty-h3", "beauty-h4"]);
  assert.deepEqual(ids(filterAndSortTechnicalRasterProjects(LIST, view({ sort: "oldest" }), KNOWN_EVENT_IDS)), ["beauty-h4", "legacy-beauty-h3", "decor-h1", "no-meta", "beauty-h3"]);
});

test("SORT: 'Název A–Z' / 'Název Z–A' use Czech collation", () => {
  assert.deepEqual(ids(filterAndSortTechnicalRasterProjects(LIST, view({ sort: "nameAsc" }), KNOWN_EVENT_IDS)), ["legacy-beauty-h3", "beauty-h3", "beauty-h4", "decor-h1", "no-meta"]);
  assert.deepEqual(ids(filterAndSortTechnicalRasterProjects(LIST, view({ sort: "nameDesc" }), KNOWN_EVENT_IDS)), ["no-meta", "decor-h1", "beauty-h4", "beauty-h3", "legacy-beauty-h3"]);
});

test("SORT + FILTER: filtering happens before sorting and the input list is never mutated", () => {
  const before = ids(LIST);
  assert.deepEqual(ids(filterAndSortTechnicalRasterProjects(LIST, view({ eventFilter: "beauty", sort: "oldest" }), KNOWN_EVENT_IDS)), ["beauty-h4", "legacy-beauty-h3", "beauty-h3"]);
  assert.deepEqual(ids(LIST), before);
});

test("EDIT + FILTER: an edited project immediately enters/leaves the ACTIVE filter result (filters are not reset)", () => {
  const active = view({ eventFilter: "beauty", hallFilter: projectHallFilterKey("Hala 3") });
  assert.ok(!ids(filterAndSortTechnicalRasterProjects(LIST, active, KNOWN_EVENT_IDS)).includes("decor-h1"));
  const afterEdit = replaceTechnicalRasterProjectSummary(LIST, { ...LIST[0]!, eventId: "beauty", hall: "Hala 3" });
  assert.ok(ids(filterAndSortTechnicalRasterProjects(afterEdit, active, KNOWN_EVENT_IDS)).includes("decor-h1"), "FOR DECOR/Hala 1 -> FOR BEAUTY/Hala 3 now appears");
  const movedAway = replaceTechnicalRasterProjectSummary(LIST, { ...LIST[1]!, eventId: "decor", hall: "Hala 1" });
  assert.ok(!ids(filterAndSortTechnicalRasterProjects(movedAway, active, KNOWN_EVENT_IDS)).includes("beauty-h3"), "and a project edited away disappears");
});

test("EMPTY STATES: 'no project matches the filters' is distinct from 'no projects at all'", async () => {
  assert.equal(filterAndSortTechnicalRasterProjects(LIST, view({ eventFilter: "arch" }), KNOWN_EVENT_IDS).length, 0);
  const source = await readListPageSource();
  assert.match(source, /projects && projects\.length === 0 && <p className="workspaceEmpty">Zatím není vytvořený žádný projekt technického rastru\.<\/p>/u);
  assert.match(source, /projects && projects\.length > 0 && visibleProjects\.length === 0 && \(\s*<p className="workspaceEmpty">Žádný projekt neodpovídá zvoleným filtrům\.<\/p>/u);
});

// =========================================================================================
// List page wiring (source guards)
// =========================================================================================

test("SOURCE: every row renders a VISIBLE edit button in AKCE (with accessible label/title) next to the existing ⋯ menu trigger", async () => {
  const source = await readListPageSource();
  const rowStart = source.indexOf("{visibleProjects.map((project) => (");
  assert.ok(rowStart > 0, "rows render from the filtered+sorted list");
  const row = source.slice(rowStart, source.indexOf("))}", rowStart));
  assert.match(row, /className="technicalRasterProjectRowEditButton"/u);
  assert.match(row, /aria-label=\{`Upravit projekt – \$\{project\.name\}`\}/u);
  assert.match(row, /title="Upravit projekt"/u);
  assert.match(row, /onClick=\{\(\) => openEditDialog\(project\)\}/u);
  assert.ok(row.indexOf("technicalRasterProjectRowEditButton") < row.indexOf("technicalRasterProjectRowMenuTrigger"), "edit sits before the ⋯ trigger in the same AKCE cell");
  assert.ok(!/:hover[^{]*technicalRasterProjectRowEditButton[^{]*\{[^}]*display:\s*none/u.test(await readFile(new URL("../app/globals.css", import.meta.url), "utf8")), "edit is never hover-only");
});

test("SOURCE: the ⋯ menu offers both Upravit projekt and the unchanged Smazat projekt", async () => {
  const source = await readListPageSource();
  assert.match(source, /onClick=\{\(\) => openEditDialog\(menuProject\)\}>Upravit projekt</u);
  assert.match(source, /onClick=\{\(\) => void handleDeleteProject\(menuProject\)\}/u);
});

test("SOURCE: the edit dialog is populated from the existing project (event via the canonical resolver) and has Název projektu / Veletrh / Hala + Zrušit / Uložit", async () => {
  const source = await readListPageSource();
  const open = source.slice(source.indexOf("function openEditDialog("), source.indexOf("function closeEditDialog("));
  assert.match(open, /setEditName\(project\.name\)/u);
  assert.match(open, /setEditEventId\(resolveEditableEventId\(project\.eventId, knownEventIds\)\)/u);
  assert.match(open, /setEditHall\(project\.hall \?\? ""\)/u);
  for (const text of ["<span>Název projektu</span>", "<span>Veletrh</span>", "<span>Hala</span>", ">Zrušit</button>", "\"Uložit\""]) {
    assert.ok(source.slice(source.indexOf("{editingProject && (")).includes(text), `dialog contains ${text}`);
  }
  assert.match(source, /role="dialog"/u);
  assert.match(source, /aria-modal="true"/u);
});

test("SOURCE: Zrušit closes the dialog without saving; Uložit goes through updateTechnicalRasterProjectMetadata and never creates a project", async () => {
  const source = await readListPageSource();
  const close = source.slice(source.indexOf("function closeEditDialog("), source.indexOf("async function handleEditSubmit("));
  assert.ok(!close.includes("projectRepository") && !close.includes("updateTechnicalRasterProjectMetadata"), "cancel never persists");
  const submit = source.slice(source.indexOf("async function handleEditSubmit("), source.indexOf("function openCreateForm("));
  assert.match(submit, /updateTechnicalRasterProjectMetadata\(projectRepository, editingProject\.id, input\)/u);
  assert.ok(!submit.includes("projectRepository.create("), "editing never recreates the project");
  const catchBody = submit.slice(submit.indexOf("} catch (error) {"));
  assert.ok(!catchBody.includes("setProjects(") && !catchBody.includes("setEditingProject(undefined)"), "a failed save keeps the list values and the dialog open");
  assert.match(catchBody, /setEditError\(/u);
  assert.ok(!submit.includes("setListView("), "editing never resets the active filters");
});

test("SOURCE: filter bar has Veletrh / Hala (each defaulting to 'Všechny') and Řazení selects, all feeding filterAndSortTechnicalRasterProjects", async () => {
  const source = await readListPageSource();
  assert.match(source, /className="technicalRasterProjectFilters"/u);
  assert.equal((source.match(/<option value="">Všechny<\/option>/gu) ?? []).length, 2);
  assert.match(source, /TECHNICAL_RASTER_PROJECT_SORT_OPTIONS\.map/u);
  assert.match(source, /filterAndSortTechnicalRasterProjects\(projects, listView, knownEventIds\)/u);
});
