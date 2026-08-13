import type { BoothType, ComponentDefinition } from "./models.ts";
import type { ProjectRecord, ProjectStage } from "./project.ts";

function normalized(value: string | undefined): string {
  return (value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function matchesProjectSearch(
  project: ProjectRecord,
  query: string,
  fairName = "",
  boothName = "",
): boolean {
  const needle = normalized(query.trim());
  if (!needle) return true;
  return [project.company, project.name, project.boothNumber, fairName, boothName, project.contact.name]
    .some((value) => normalized(value).includes(needle));
}

export function filterProjects(
  projects: readonly ProjectRecord[],
  filters: {
    query?: string;
    fairId?: string;
    stage?: ProjectStage | "";
    requiresAction?: "" | "yes" | "no";
    mode?: ProjectRecord["mode"] | "";
    fairName?: (id: string) => string;
    boothName?: (id: string) => string;
  },
): readonly ProjectRecord[] {
  return projects.filter((project) =>
    matchesProjectSearch(project, filters.query ?? "", filters.fairName?.(project.fairId), filters.boothName?.(project.boothId)) &&
    (!filters.fairId || project.fairId === filters.fairId) &&
    (!filters.stage || project.stage === filters.stage) &&
    (!filters.mode || project.mode === filters.mode) &&
    (!filters.requiresAction || project.requiresAction === (filters.requiresAction === "yes"))
  );
}

export function matchesBoothSearch(booth: BoothType, query: string): boolean {
  const needle = normalized(query.trim());
  return !needle || [booth.internalCode, booth.code, booth.name, booth.size, booth.category]
    .some((value) => normalized(value).includes(needle));
}

export function matchesCatalogSearch(item: ComponentDefinition, query: string): boolean {
  const needle = normalized(query.trim());
  return !needle || [item.internalCode, item.displayName, item.name, item.officialName, item.category]
    .some((value) => normalized(value).includes(needle));
}
