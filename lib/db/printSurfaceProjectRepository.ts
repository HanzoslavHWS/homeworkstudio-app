import type { PrintSurfaceProject } from "../../domain/printSurfaceProject.ts";

/**
 * A single working "Tiskové plochy" draft is persisted at a time for this MVP phase (matches the
 * DoD: open the tab, work on one project, come back to it). `save`/`clear` are async so a future
 * DB-backed implementation (multi-project list, real accounts) is a drop-in swap for
 * lib/db/printSurfaceProjectRepository.localStorage.client.ts without touching PrintSurfacesPage.
 */
export interface PrintSurfaceProjectRepository {
  load(): Promise<PrintSurfaceProject | null>;
  save(project: PrintSurfaceProject): Promise<void>;
  clear(): Promise<void>;
}
