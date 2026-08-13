"use client";

import type { ProjectRepository } from "../../domain/repository.ts";
import type { EventRepository } from "../../domain/eventRepository.ts";
import type { RemoteProjectRepository, RemoteEventRepository } from "../../domain/remotePersistence.ts";

export type LocalDataImportSummary = Readonly<{
  importedProjects: readonly string[];
  skippedProjects: readonly string[];
  importedEvents: readonly string[];
  skippedEvents: readonly string[];
}>;

/**
 * Section 8: legacy localStorage data is never imported automatically. This is the
 * service layer for a future explicit "Importovat lokální data" UI action — call it only
 * in direct response to a user click. Existing-in-DB records are always skipped (never
 * silently overwritten); re-running this after fixing conflicts is safe and idempotent,
 * since already-imported ids are skipped on the next pass too.
 */
export async function importLocalDataIntoDb(
  local: Readonly<{ projects: ProjectRepository; events: EventRepository }>,
  remote: Readonly<{ projects: RemoteProjectRepository; events: RemoteEventRepository }>,
): Promise<LocalDataImportSummary> {
  const [localProjects, localEvents, remoteProjects, remoteEvents] = await Promise.all([
    local.projects.list(),
    local.events.list(),
    remote.projects.list(),
    remote.events.list(),
  ]);
  const remoteProjectIds = new Set(remoteProjects.map((project) => project.id));
  const remoteEventIds = new Set(remoteEvents.map((event) => event.id));

  const importedProjects: string[] = [];
  const skippedProjects: string[] = [];
  for (const project of localProjects) {
    if (remoteProjectIds.has(project.id)) {
      skippedProjects.push(project.id);
      continue;
    }
    await remote.projects.saveWithRevision(project, null);
    importedProjects.push(project.id);
  }

  const importedEvents: string[] = [];
  const skippedEvents: string[] = [];
  for (const event of localEvents) {
    if (remoteEventIds.has(event.id)) {
      skippedEvents.push(event.id);
      continue;
    }
    await remote.events.saveWithRevision(event, null);
    importedEvents.push(event.id);
  }

  return { importedProjects, skippedProjects, importedEvents, skippedEvents };
}
