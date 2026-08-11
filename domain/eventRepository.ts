import {
  normalizeExhibition,
  type Exhibition,
} from "./organizations.ts";
import type { KeyValueStorage } from "./repository.ts";

export interface EventRepository {
  list(): Promise<readonly Exhibition[]>;
  save(event: Exhibition): Promise<Exhibition>;
}

export class LocalEventRepository implements EventRepository {
  static readonly storageKey = "homeworkstudio.events.v1";
  private readonly storage: KeyValueStorage;
  private readonly seeds: readonly Exhibition[];

  constructor(
    storage: KeyValueStorage,
    seeds: readonly Exhibition[] = [],
  ) {
    this.storage = storage;
    this.seeds = seeds;
  }

  async list(): Promise<readonly Exhibition[]> {
    const raw = this.storage.getItem(LocalEventRepository.storageKey);
    if (!raw) return this.seeds.map((event) => normalizeExhibition(event));
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.map((event) => normalizeExhibition(event))
        : this.seeds.map((event) => normalizeExhibition(event));
    } catch {
      return this.seeds.map((event) => normalizeExhibition(event));
    }
  }

  async save(event: Exhibition): Promise<Exhibition> {
    const normalized = normalizeExhibition(event);
    const current = [...(await this.list())];
    const next = current.some((item) => item.id === normalized.id)
      ? current.map((item) => (item.id === normalized.id ? normalized : item))
      : [...current, normalized];
    this.storage.setItem(
      LocalEventRepository.storageKey,
      JSON.stringify(next.map(stripTemporaryBinaryReferences)),
    );
    return normalized;
  }
}

function stripTemporaryBinaryReferences(event: Exhibition): Exhibition {
  return {
    ...event,
    logoUrl: event.logoUrl.startsWith("blob:") ? "" : event.logoUrl,
    coverImageUrl: event.coverImageUrl.startsWith("blob:")
      ? ""
      : event.coverImageUrl,
    documents: event.documents.map((document) =>
      document.availability === "temporary-session"
        ? { ...document, assetUrl: undefined }
        : document,
    ),
  };
}
