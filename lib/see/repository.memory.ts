import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
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
import type { SeeAccessGrant, SeeRepository, SeeViewInput } from "./repository.ts";

type State = {
  projects: Record<string, SeeProject>;
  scenes: Record<string, SeeScene>;
  annotations: Record<string, SeeAnnotation>;
  files: Record<string, SeeFile>;
  publications: Record<string, SeePublication>;
  grants: Record<string, SeeAccessGrant>;
  pinFailures: { publicationId: string; clientHash: string; at: string }[];
  views: { publicationId: string; visitorHash: string; at: string }[];
};

function emptyState(): State {
  return { projects: {}, scenes: {}, annotations: {}, files: {}, publications: {}, grants: {}, pinFailures: [], views: [] };
}

/**
 * In-memory SeeRepository with the same rules as the Supabase one. Used by the automated tests and
 * by the explicit LOCAL DEV mode (SEE_BACKEND=local, never in production), where `persistFile`
 * keeps the data in a git-ignored JSON file so a dev server restart does not lose it.
 */
export class MemorySeeRepository implements SeeRepository {
  private _state: State;
  private readonly persistFile?: string;
  private readonly now: () => Date;
  private loadedMtimeMs = 0;

  constructor(options: Readonly<{ persistFile?: string; now?: () => Date }> = {}) {
    this.persistFile = options.persistFile;
    this.now = options.now ?? (() => new Date());
    this._state = emptyState();
    this.reloadIfChanged();
  }

  /**
   * Local dev: next dev may run proxy.ts and route handlers in different module instances, each
   * with its own repository object — re-read the JSON file whenever another instance wrote it.
   */
  private reloadIfChanged() {
    if (!this.persistFile || !existsSync(this.persistFile)) return;
    const mtimeMs = statSync(this.persistFile).mtimeMs;
    if (mtimeMs === this.loadedMtimeMs) return;
    this._state = { ...emptyState(), ...JSON.parse(readFileSync(this.persistFile, "utf8")) as State };
    this.loadedMtimeMs = mtimeMs;
  }

  private get state(): State {
    this.reloadIfChanged();
    return this._state;
  }

  private persist() {
    if (!this.persistFile) return;
    mkdirSync(path.dirname(this.persistFile), { recursive: true });
    writeFileSync(this.persistFile, JSON.stringify(this._state, null, 1));
    this.loadedMtimeMs = statSync(this.persistFile).mtimeMs;
  }

  async listProjects(query: SeeProjectListQuery) {
    const search = query.search?.trim().toLocaleLowerCase("cs");
    const all = Object.values(this.state.projects)
      .filter((project) => (query.status && query.status !== "all" ? project.status === query.status : project.status !== "deleted"))
      .filter((project) => !search || `${project.name} ${project.description}`.toLocaleLowerCase("cs").includes(search))
      .map((project) => this.summary(project))
      .filter((summary) => !query.publication || query.publication === "all" || (summary.publication?.status ?? "draft") === query.publication)
      .sort((left, right) => right.project.updatedAt.localeCompare(left.project.updatedAt));
    return { items: all.slice(query.offset, query.offset + query.limit), total: all.length };
  }

  private summary(project: SeeProject): SeeProjectSummary {
    const publication = Object.values(this.state.publications).find((entry) => entry.projectId === project.id);
    return {
      project,
      sceneCount: Object.values(this.state.scenes).filter((scene) => scene.projectId === project.id).length,
      documentCount: Object.values(this.state.files).filter((file) => file.projectId === project.id && file.kind === "document" && file.status === "ready" && !file.deletedAt).length,
      publication: publication && {
        shareSlug: publication.shareSlug,
        mode: publication.mode,
        status: publication.status,
        publishedAt: publication.publishedAt,
        viewCount: publication.viewCount,
        lastViewedAt: publication.lastViewedAt,
      },
    };
  }

  async getProject(projectId: string) {
    return this.state.projects[projectId];
  }

  async getAggregate(projectId: string): Promise<SeeProjectAggregate | undefined> {
    const project = this.state.projects[projectId];
    if (!project) return undefined;
    const scenes = Object.values(this.state.scenes).filter((scene) => scene.projectId === projectId).sort((left, right) => left.sortOrder - right.sortOrder);
    const sceneIds = new Set(scenes.map((scene) => scene.id));
    return {
      project,
      scenes,
      annotations: Object.values(this.state.annotations).filter((annotation) => sceneIds.has(annotation.sceneId)).sort((left, right) => left.sortOrder - right.sortOrder),
      files: Object.values(this.state.files).filter((file) => file.projectId === projectId).sort((left, right) => left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt)),
      publication: Object.values(this.state.publications).find((publication) => publication.projectId === projectId),
    };
  }

  private insert<K extends "projects" | "scenes" | "annotations" | "files" | "publications" | "grants">(table: K, row: State[K][string]) {
    if (this.state[table][row.id]) throw new Error(`duplicate key ${table}.${row.id}`);
    (this.state[table] as Record<string, unknown>)[row.id] = structuredClone(row);
    this.persist();
  }

  private update<K extends "projects" | "scenes" | "annotations" | "files" | "publications">(table: K, row: State[K][string]) {
    if (!this.state[table][row.id]) throw new Error(`missing row ${table}.${row.id}`);
    (this.state[table] as Record<string, unknown>)[row.id] = structuredClone({ ...row, updatedAt: this.now().toISOString() });
    this.persist();
  }

  async insertProject(project: SeeProject) { this.insert("projects", project); }
  async updateProject(project: SeeProject) { this.update("projects", project); }
  async insertScene(scene: SeeScene) { this.insert("scenes", scene); }
  async updateScene(scene: SeeScene) { this.update("scenes", scene); }

  async deleteScene(sceneId: string) {
    delete this.state.scenes[sceneId];
    for (const annotation of Object.values(this.state.annotations)) {
      if (annotation.sceneId === sceneId) delete this.state.annotations[annotation.id];
    }
    for (const file of Object.values(this.state.files)) {
      if (file.sceneIds.includes(sceneId)) this.state.files[file.id] = { ...file, sceneIds: file.sceneIds.filter((id) => id !== sceneId) };
    }
    this.persist();
  }

  async insertAnnotation(annotation: SeeAnnotation) { this.insert("annotations", annotation); }
  async updateAnnotation(annotation: SeeAnnotation) { this.update("annotations", annotation); }
  async deleteAnnotation(annotationId: string) { delete this.state.annotations[annotationId]; this.persist(); }

  async getFile(fileId: string) { return this.state.files[fileId]; }
  async insertFile(file: SeeFile) { this.insert("files", file); }
  async updateFile(file: SeeFile) {
    const existing = this.state.files[file.id];
    this.update("files", existing ? { ...file, storageKey: existing.storageKey } : file);
  }

  async updateFileStorageKey(fileId: string, storageKey: string, expectedKey: string) {
    const existing = this.state.files[fileId];
    if (!existing) throw new Error(`missing row files.${fileId}`);
    if (existing.storageKey !== expectedKey) return false;
    if (Object.values(this.state.files).some((file) => file.id !== fileId && file.storageKey === storageKey)) throw new Error("duplicate storage key");
    this.state.files[fileId] = { ...existing, storageKey, updatedAt: this.now().toISOString() };
    this.persist();
    return true;
  }

  async getPublicationByProject(projectId: string) {
    return Object.values(this.state.publications).find((publication) => publication.projectId === projectId);
  }

  async getPublicationBySlug(shareSlug: string) {
    return Object.values(this.state.publications).find((publication) => publication.shareSlug === shareSlug);
  }

  async insertPublication(publication: SeePublication) {
    if (Object.values(this.state.publications).some((entry) => entry.projectId === publication.projectId || entry.shareSlug === publication.shareSlug)) {
      throw new Error("duplicate publication");
    }
    this.insert("publications", publication);
  }

  async updatePublication(publication: SeePublication) {
    if (Object.values(this.state.publications).some((entry) => entry.id !== publication.id && entry.shareSlug === publication.shareSlug)) {
      throw new Error("duplicate share slug");
    }
    this.update("publications", publication);
  }

  async insertGrant(grant: SeeAccessGrant) { this.insert("grants", grant); }

  async getGrantByTokenHash(tokenHash: string) {
    return Object.values(this.state.grants).find((grant) => grant.tokenHash === tokenHash);
  }

  async revokeGrants(publicationId: string, revokedAt: string) {
    for (const grant of Object.values(this.state.grants)) {
      if (grant.publicationId === publicationId && !grant.revokedAt) this.state.grants[grant.id] = { ...grant, revokedAt };
    }
    this.persist();
  }

  async countPinFailures(publicationId: string, sinceIso: string, clientHash?: string) {
    return this.state.pinFailures.filter((entry) => entry.publicationId === publicationId && entry.at >= sinceIso && (!clientHash || entry.clientHash === clientHash)).length;
  }

  async insertPinFailure(publicationId: string, clientHash: string, atIso: string) {
    this.state.pinFailures.push({ publicationId, clientHash, at: atIso });
    this.persist();
  }

  async recordView(input: SeeViewInput) {
    const now = this.now();
    const since = new Date(now.getTime() - input.dedupeSeconds * 1000).toISOString();
    if (this.state.views.some((view) => view.publicationId === input.publicationId && view.visitorHash === input.visitorHash && view.at > since)) return false;
    this.state.views.push({ publicationId: input.publicationId, visitorHash: input.visitorHash, at: now.toISOString() });
    const publication = this.state.publications[input.publicationId];
    if (publication) this.state.publications[publication.id] = { ...publication, viewCount: publication.viewCount + 1, lastViewedAt: now.toISOString() };
    this.persist();
    return true;
  }
}
