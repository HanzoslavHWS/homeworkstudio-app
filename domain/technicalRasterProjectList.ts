/**
 * Technické rastry — project LIST management (production-workflow batch, part A): metadata editing
 * (name / event / hall) plus the list page's event/hall filters and sorting. Pure and
 * framework-free, so TechnicalRasterProjectListPage.tsx only wires state to these functions.
 *
 * METADATA EDITING is deliberately NOT a new persistence path: `updateTechnicalRasterProjectMetadata`
 * loads the FULL project through the existing repository `get()`, replaces only name/eventId/hall
 * via `withTechnicalRasterProjectMetadata`, and writes it back through the existing `save()` — the
 * same "save persists the whole project, caller applies a pure with* helper first" convention
 * domain/technicalRaster.ts's repository doc describes. Raster asset, layers, settings, imports,
 * stands, services and placements round-trip untouched; the project id never changes; the save
 * route's own event resolver still canonicalizes `eventId` (legacy alias -> canonical id).
 *
 * HALL is plain project metadata (`TechnicalRasterProject.hall`, a free-text label). Stand matching
 * and hall scope are derived from the RASTER's own labels (domain/technicalRasterHallScope.ts) and
 * never read `project.hall`, so editing it never rematches or reinterprets anything.
 */
import { resolveCanonicalEventId } from "./eventIdentity.ts";
import type { TechnicalRasterProject, TechnicalRasterProjectRepository, TechnicalRasterProjectSummary } from "./technicalRaster.ts";

// ============================================================================
// Metadata editing
// ============================================================================

export type TechnicalRasterProjectMetadataInput = Readonly<{
  name: string;
  /** Empty string / undefined = no event. */
  eventId?: string;
  /** Empty string / undefined = no hall. */
  hall?: string;
}>;

export type TechnicalRasterProjectMetadata = Readonly<{ name: string; eventId?: string; hall?: string }>;

export type TechnicalRasterProjectMetadataValidation =
  | { readonly ok: true; readonly value: TechnicalRasterProjectMetadata }
  | { readonly ok: false; readonly message: string };

/** Same rules as project creation: a name is required, event and hall are optional (trimmed, empty -> undefined). */
export function validateTechnicalRasterProjectMetadata(input: TechnicalRasterProjectMetadataInput): TechnicalRasterProjectMetadataValidation {
  const name = input.name.trim();
  if (!name) return { ok: false, message: "Zadejte název projektu." };
  const eventId = input.eventId?.trim() || undefined;
  const hall = input.hall?.trim() || undefined;
  return { ok: true, value: { name, eventId, hall } };
}

/** Replaces ONLY name/eventId/hall — every other field (id, raster, imports, stands, settings, ...) is carried over by reference. */
export function withTechnicalRasterProjectMetadata(project: TechnicalRasterProject, metadata: TechnicalRasterProjectMetadata): TechnicalRasterProject {
  return { ...project, name: metadata.name, eventId: metadata.eventId, hall: metadata.hall };
}

/**
 * Load -> apply metadata -> save, through the existing repository. Throws on validation failure,
 * a missing project, or a failed save — the caller keeps its previous displayed values in that case.
 */
export async function updateTechnicalRasterProjectMetadata(
  repository: TechnicalRasterProjectRepository,
  projectId: string,
  input: TechnicalRasterProjectMetadataInput,
): Promise<TechnicalRasterProject> {
  const validation = validateTechnicalRasterProjectMetadata(input);
  if (validation.ok === false) throw new Error(validation.message);
  const current = await repository.get(projectId);
  if (!current) throw new Error("Projekt nebyl nalezen.");
  return repository.save(withTechnicalRasterProjectMetadata(current, validation.value));
}

/** Swaps one already-loaded summary for its updated version, keeping list position — the list page's immediate post-save update. */
export function replaceTechnicalRasterProjectSummary(
  projects: readonly TechnicalRasterProjectSummary[],
  updated: TechnicalRasterProjectSummary,
): readonly TechnicalRasterProjectSummary[] {
  return projects.map((project) => (project.id === updated.id ? updated : project));
}

/**
 * The event id the edit dialog should preselect for an existing project: the canonical id when the
 * stored one is canonical or a documented legacy alias (resolveCanonicalEventId — the same resolver
 * the save route uses), otherwise the stored id unchanged so an unknown value is never silently dropped.
 */
export function resolveEditableEventId(storedEventId: string | undefined, knownEventIds: Iterable<string>): string {
  if (!storedEventId) return "";
  return resolveCanonicalEventId(storedEventId, knownEventIds) ?? storedEventId;
}

// ============================================================================
// Filtering
// ============================================================================

/** Filter value meaning "no filter" (UI label "Všechny"). */
export const PROJECT_FILTER_ALL = "";
/** Filter value matching projects with no event / no hall set. */
export const PROJECT_FILTER_NONE = "__none__";

/** Stable filter key for a project's event: canonical id when resolvable, raw id otherwise, PROJECT_FILTER_NONE when unset. */
export function projectEventFilterKey(eventId: string | undefined, knownEventIds: ReadonlySet<string>): string {
  const trimmed = eventId?.trim();
  if (!trimmed) return PROJECT_FILTER_NONE;
  return resolveCanonicalEventId(trimmed, knownEventIds) ?? trimmed;
}

/** Stable filter key for a hall label — "Hala 3", " hala  3 " and "HALA 3" share one key. PROJECT_FILTER_NONE when unset. */
export function projectHallFilterKey(hall: string | undefined): string {
  const normalized = (hall ?? "").trim().replace(/\s+/gu, " ").toLocaleLowerCase("cs");
  return normalized || PROJECT_FILTER_NONE;
}

export type ProjectFilterOption = Readonly<{ value: string; label: string }>;

export type TechnicalRasterProjectFilterOptions = Readonly<{
  events: readonly ProjectFilterOption[];
  halls: readonly ProjectFilterOption[];
}>;

type EventLike = Readonly<{ id: string; name: string }>;

/**
 * Filter choices derived from the LOADED projects only (never a hardcoded list) — labels come from
 * the existing event catalog, halls keep the first-seen display spelling. A "Bez veletrhu"/"Bez haly"
 * option is appended only when some project actually lacks that value.
 */
export function buildTechnicalRasterProjectFilterOptions(
  projects: readonly TechnicalRasterProjectSummary[],
  events: readonly EventLike[],
): TechnicalRasterProjectFilterOptions {
  const knownEventIds = new Set(events.map((event) => event.id));
  const eventLabels = new Map<string, string>();
  const hallLabels = new Map<string, string>();
  for (const project of projects) {
    const eventKey = projectEventFilterKey(project.eventId, knownEventIds);
    if (!eventLabels.has(eventKey) && eventKey !== PROJECT_FILTER_NONE) {
      eventLabels.set(eventKey, events.find((event) => event.id === eventKey)?.name ?? eventKey);
    }
    const hallKey = projectHallFilterKey(project.hall);
    if (!hallLabels.has(hallKey) && hallKey !== PROJECT_FILTER_NONE) hallLabels.set(hallKey, project.hall!.trim().replace(/\s+/gu, " "));
  }
  const byLabel = (a: ProjectFilterOption, b: ProjectFilterOption) => a.label.localeCompare(b.label, "cs", { numeric: true, sensitivity: "base" });
  const eventOptions = [...eventLabels].map(([value, label]) => ({ value, label })).sort(byLabel);
  const hallOptions = [...hallLabels].map(([value, label]) => ({ value, label })).sort(byLabel);
  if (projects.some((project) => projectEventFilterKey(project.eventId, knownEventIds) === PROJECT_FILTER_NONE)) eventOptions.push({ value: PROJECT_FILTER_NONE, label: "Bez veletrhu" });
  if (projects.some((project) => projectHallFilterKey(project.hall) === PROJECT_FILTER_NONE)) hallOptions.push({ value: PROJECT_FILTER_NONE, label: "Bez haly" });
  return { events: eventOptions, halls: hallOptions };
}

// ============================================================================
// Sorting
// ============================================================================

export type TechnicalRasterProjectSort = "newest" | "oldest" | "nameAsc" | "nameDesc";

/** "Nejnovější" is the default and matches the repository's own list order (updated_at desc). */
export const DEFAULT_TECHNICAL_RASTER_PROJECT_SORT: TechnicalRasterProjectSort = "newest";

export const TECHNICAL_RASTER_PROJECT_SORT_OPTIONS: readonly Readonly<{ value: TechnicalRasterProjectSort; label: string }>[] = [
  { value: "newest", label: "Nejnovější" },
  { value: "oldest", label: "Nejstarší" },
  { value: "nameAsc", label: "Název A–Z" },
  { value: "nameDesc", label: "Název Z–A" },
];

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function compareProjects(sort: TechnicalRasterProjectSort) {
  return (a: TechnicalRasterProjectSummary, b: TechnicalRasterProjectSummary): number => {
    switch (sort) {
      case "oldest": return timestamp(a.updatedAt) - timestamp(b.updatedAt);
      case "nameAsc": return a.name.localeCompare(b.name, "cs", { numeric: true, sensitivity: "base" });
      case "nameDesc": return b.name.localeCompare(a.name, "cs", { numeric: true, sensitivity: "base" });
      case "newest":
      default: return timestamp(b.updatedAt) - timestamp(a.updatedAt);
    }
  };
}

export type TechnicalRasterProjectListView = Readonly<{
  eventFilter: string;
  hallFilter: string;
  sort: TechnicalRasterProjectSort;
}>;

export const DEFAULT_TECHNICAL_RASTER_PROJECT_LIST_VIEW: TechnicalRasterProjectListView = {
  eventFilter: PROJECT_FILTER_ALL,
  hallFilter: PROJECT_FILTER_ALL,
  sort: DEFAULT_TECHNICAL_RASTER_PROJECT_SORT,
};

/** projects -> event filter -> hall filter -> sort. Never mutates its input; filters compare stable keys, never display strings. */
export function filterAndSortTechnicalRasterProjects(
  projects: readonly TechnicalRasterProjectSummary[],
  view: TechnicalRasterProjectListView,
  knownEventIds: ReadonlySet<string>,
): readonly TechnicalRasterProjectSummary[] {
  return projects
    .filter((project) => view.eventFilter === PROJECT_FILTER_ALL || projectEventFilterKey(project.eventId, knownEventIds) === view.eventFilter)
    .filter((project) => view.hallFilter === PROJECT_FILTER_ALL || projectHallFilterKey(project.hall) === view.hallFilter)
    .sort(compareProjects(view.sort));
}
