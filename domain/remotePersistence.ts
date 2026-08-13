import type { ProjectRecord } from "./project.ts";
import type { ProjectRepository } from "./repository.ts";
import type { Exhibition } from "./organizations.ts";
import type { EventRepository } from "./eventRepository.ts";

/**
 * Pure type contracts shared by BOTH the server-only Supabase-backed repositories
 * (lib/db/*.supabase.ts) and the browser-safe fetch-based repositories
 * (lib/db/*.remoteApi.client.ts). Living here — not in a "*.supabase.ts" file — means a
 * client component can `import type` this without any risk of pulling
 * @supabase/supabase-js (or any server code) into the browser bundle.
 */

export type PersistedProjectRecord = ProjectRecord & Readonly<{ revision: number }>;

/** Extends ProjectRepository (stays source-compatible with LocalProjectRepository) with revision-aware optimistic concurrency — section 36. */
export interface RemoteProjectRepository extends ProjectRepository {
  getWithRevision(id: string): Promise<PersistedProjectRecord | undefined>;
  /** expectedRevision must be null only when creating a brand-new row; otherwise it must match the current revision or this rejects with a conflict. */
  saveWithRevision(project: ProjectRecord, expectedRevision: number | null): Promise<PersistedProjectRecord>;
}

export type PersistedExhibition = Exhibition & Readonly<{ revision: number }>;

/** Extends EventRepository (stays source-compatible with LocalEventRepository) with revision-aware optimistic concurrency. */
export interface RemoteEventRepository extends EventRepository {
  getWithRevision(id: string): Promise<PersistedExhibition | undefined>;
  saveWithRevision(event: Exhibition, expectedRevision: number | null): Promise<PersistedExhibition>;
}
