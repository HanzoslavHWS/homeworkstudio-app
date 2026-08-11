import { normalizeProjectRecord, type ProjectRecord } from "./project.ts";

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ProjectRepository {
  list(): Promise<readonly ProjectRecord[]>;
  get(id: string): Promise<ProjectRecord | undefined>;
  save(project: ProjectRecord): Promise<ProjectRecord>;
  delete(id: string): Promise<void>;
}

export class LocalProjectRepository implements ProjectRepository {
  static readonly storageKey = "homeworkstudio.projects.v1";
  private readonly storage: KeyValueStorage;

  constructor(storage: KeyValueStorage) {
    this.storage = storage;
  }

  async list(): Promise<readonly ProjectRecord[]> {
    return this.read().sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  async get(id: string): Promise<ProjectRecord | undefined> {
    return this.read().find((project) => project.id === id);
  }

  async save(project: ProjectRecord): Promise<ProjectRecord> {
    const projects = this.read();
    const next = projects.some((item) => item.id === project.id)
      ? projects.map((item) => (item.id === project.id ? project : item))
      : [...projects, project];
    this.storage.setItem(LocalProjectRepository.storageKey, JSON.stringify(next));
    return project;
  }

  async delete(id: string): Promise<void> {
    const next = this.read().filter((project) => project.id !== id);
    this.storage.setItem(LocalProjectRepository.storageKey, JSON.stringify(next));
  }

  private read(): ProjectRecord[] {
    const raw = this.storage.getItem(LocalProjectRepository.storageKey);
    if (!raw) return [];
    try {
      const value = JSON.parse(raw);
      return Array.isArray(value)
        ? value.map((project) => normalizeProjectRecord(project))
        : [];
    } catch {
      return [];
    }
  }
}
