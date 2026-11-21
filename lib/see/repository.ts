import type {
  SeeAnnotation,
  SeeFile,
  SeeProject,
  SeeProjectAggregate,
  SeeProjectListQuery,
  SeeProjectSummary,
  SeePublication,
  SeeScene,
} from "../../domain/seeProject.ts";

export type SeeAccessGrant = Readonly<{
  id: string;
  publicationId: string;
  tokenHash: string;
  accessEpoch: number;
  expiresAt: string;
  revokedAt?: string;
  createdAt: string;
}>;

export type SeeViewInput = Readonly<{
  publicationId: string;
  projectId: string;
  visitorHash: string;
  embed: boolean;
  dedupeSeconds: number;
}>;

/**
 * Persistence of the HWS SEE module (own `see_*` tables, never ABF tables). Implementations:
 * SupabaseSeeRepository (production) and MemorySeeRepository (tests + explicit local dev mode).
 */
export interface SeeRepository {
  listProjects(query: SeeProjectListQuery): Promise<Readonly<{ items: readonly SeeProjectSummary[]; total: number }>>;
  getProject(projectId: string): Promise<SeeProject | undefined>;
  getAggregate(projectId: string): Promise<SeeProjectAggregate | undefined>;
  insertProject(project: SeeProject): Promise<void>;
  updateProject(project: SeeProject): Promise<void>;

  insertScene(scene: SeeScene): Promise<void>;
  updateScene(scene: SeeScene): Promise<void>;
  deleteScene(sceneId: string): Promise<void>;

  insertAnnotation(annotation: SeeAnnotation): Promise<void>;
  updateAnnotation(annotation: SeeAnnotation): Promise<void>;
  deleteAnnotation(annotationId: string): Promise<void>;

  getFile(fileId: string): Promise<SeeFile | undefined>;
  insertFile(file: SeeFile): Promise<void>;
  /** Also replaces the file's scene links (see_file_scene_links) with file.sceneIds. Never changes storageKey. */
  updateFile(file: SeeFile): Promise<void>;
  /**
   * Re-keying (immediate invalidation of issued signed URLs): point the file at a new object, but
   * ONLY if it still points at `expectedKey` (compare-and-set). Returns false when another request
   * re-keyed it first — the caller then discards its own copy instead of corrupting the record.
   */
  updateFileStorageKey(fileId: string, storageKey: string, expectedKey: string): Promise<boolean>;

  getPublicationByProject(projectId: string): Promise<SeePublication | undefined>;
  getPublicationBySlug(shareSlug: string): Promise<SeePublication | undefined>;
  insertPublication(publication: SeePublication): Promise<void>;
  updatePublication(publication: SeePublication): Promise<void>;

  insertGrant(grant: SeeAccessGrant): Promise<void>;
  getGrantByTokenHash(tokenHash: string): Promise<SeeAccessGrant | undefined>;
  revokeGrants(publicationId: string, revokedAt: string): Promise<void>;

  countPinFailures(publicationId: string, sinceIso: string, clientHash?: string): Promise<number>;
  insertPinFailure(publicationId: string, clientHash: string, atIso: string): Promise<void>;

  /** Counts one real open unless the same hashed visitor opened it within dedupeSeconds. */
  recordView(input: SeeViewInput): Promise<boolean>;
}
