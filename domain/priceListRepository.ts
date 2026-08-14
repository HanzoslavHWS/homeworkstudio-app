import { normalizePriceList, type PriceList } from "./organizations.ts";
import type { KeyValueStorage } from "./repository.ts";

/**
 * Plain (non-revision) contract — unlike EventRepository/ProjectRepository, price_lists has
 * no revision column in the DB schema (see the init migration), so there is no
 * optimistic-concurrency variant to extend here.
 */
export interface PriceListRepository {
  list(): Promise<readonly PriceList[]>;
  save(priceList: PriceList): Promise<PriceList>;
}

export class LocalPriceListRepository implements PriceListRepository {
  static readonly storageKey = "homeworkstudio.priceLists.v1";
  private readonly storage: KeyValueStorage;
  private readonly seeds: readonly PriceList[];

  constructor(storage: KeyValueStorage, seeds: readonly PriceList[] = []) {
    this.storage = storage;
    this.seeds = seeds;
  }

  async list(): Promise<readonly PriceList[]> {
    const raw = this.storage.getItem(LocalPriceListRepository.storageKey);
    if (!raw) return this.seeds.map((priceList) => normalizePriceList(priceList));
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.map((priceList) => normalizePriceList(priceList))
        : this.seeds.map((priceList) => normalizePriceList(priceList));
    } catch {
      return this.seeds.map((priceList) => normalizePriceList(priceList));
    }
  }

  async save(priceList: PriceList): Promise<PriceList> {
    const normalized = normalizePriceList(priceList);
    const current = [...(await this.list())];
    const next = current.some((item) => item.id === normalized.id)
      ? current.map((item) => (item.id === normalized.id ? normalized : item))
      : [...current, normalized];
    this.storage.setItem(LocalPriceListRepository.storageKey, JSON.stringify(next));
    return normalized;
  }
}
