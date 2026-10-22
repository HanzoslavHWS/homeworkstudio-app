"use client";

import type { CatalogPackageItem } from "../../domain/catalogPackages.ts";
import type { CatalogVariantSet } from "../../domain/catalogVariants.ts";
import type { KitLineSelection } from "../../domain/catalogKitPricing.ts";
import type { Currency } from "../../domain/models.ts";
import type {
  EventPriceAssignment,
  PriceCategory,
  PriceListVersion,
  PriceTrack,
  PriceSurcharge,
  PriceVersionHeaderInput,
  PublishCheck,
  PurchaseEntryInput,
  PurchaseListCompany,
  PurchasePriceEntry,
  SaleEntryInput,
  SalePriceEntry,
  SalePriceListKind,
  SurchargeInput,
  TrackCoverage,
  VersionedKitPriceResult,
  VersionedPriceList,
  VersionedPriceResult,
} from "../../domain/priceVersions.ts";
import type { PricingCatalogItem, PricingCompany, PricingEvent } from "./priceVersions.supabase.ts";
import { RemoteApiUnavailableError } from "./projectRepository.remoteApi.client.ts";

/** Somebody else changed the version (or the event assignment) first. Nothing was saved; reload. */
export class PriceVersionConflictClientError extends RemoteApiUnavailableError {
  readonly currentRevision?: number;
  constructor(message: string, currentRevision?: number) {
    super(409, message);
    this.name = "PriceVersionConflictClientError";
    if (currentRevision !== undefined) this.currentRevision = currentRevision;
  }
}

export function isPriceVersionConflict(error: unknown): error is PriceVersionConflictClientError {
  return error instanceof PriceVersionConflictClientError;
}

async function readJson<T>(response: Response, fallbackMessage: string): Promise<T> {
  if (!response.ok) {
    let message = fallbackMessage;
    let conflict = false;
    let currentRevision: number | undefined;
    try {
      const body = (await response.json()) as { error?: string; conflict?: boolean; currentRevision?: number };
      if (body.error) message = body.error;
      conflict = body.conflict === true;
      currentRevision = body.currentRevision;
    } catch {
      // body wasn't JSON — keep the fallback message
    }
    if (conflict) throw new PriceVersionConflictClientError(message, currentRevision);
    throw new RemoteApiUnavailableError(response.status, message);
  }
  return (await response.json()) as T;
}

const get = <T>(url: string, fallback: string) => fetch(url, { method: "GET", credentials: "same-origin" }).then((response) => readJson<T>(response, fallback));
const post = <T>(url: string, body: unknown, fallback: string) =>
  fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((response) => readJson<T>(response, fallback));

export type SalePriceRegister = Readonly<{
  lists: readonly VersionedPriceList[];
  versions: readonly PriceListVersion[];
  events: readonly PricingEvent[];
  assignments: readonly EventPriceAssignment[];
  items: readonly PricingCatalogItem[];
  variantSets: readonly CatalogVariantSet[];
  kitLines: readonly CatalogPackageItem[];
  /** Per sale version: how many rows / surcharges cannot be priced in each track. */
  coverage: Readonly<Record<string, TrackCoverage>>;
}>;

export type PurchasePriceRegister = Readonly<{
  lists: readonly VersionedPriceList[];
  versions: readonly PriceListVersion[];
  links: readonly PurchaseListCompany[];
  companies: readonly PricingCompany[];
  items: readonly PricingCatalogItem[];
}>;

export type ListDraft = Readonly<{ id?: string; code: string; name: string; kind: VersionedPriceList["kind"]; isActive: boolean; note?: string }>;

export type ResolveRequest = Readonly<{
  /** Always explicit: CZK, EUR_SK or EUR_WORLD. */
  priceTrack: PriceTrack;
  eventId?: string;
  baseVersionId?: string;
  electricityVersionId?: string;
  items?: readonly Readonly<{ catalogItemId: string; variantId?: string }>[];
  kitItemId?: string;
  selections?: readonly KitLineSelection[];
}>;

export type ResolveResponse = Readonly<{
  track: PriceTrack;
  currency: Currency;
  versionIds: Partial<Record<SalePriceListKind, string>>;
  results: readonly Readonly<{ catalogItemId: string; variantId?: string; result: VersionedPriceResult }>[];
  kit?: VersionedKitPriceResult;
}>;

function versionActions(base: string, actor: () => string | undefined) {
  const act = <T = { ok: true }>(body: Record<string, unknown>, fallback: string) => post<T>(base, { ...body, actor: actor() }, fallback);
  return {
    saveList: (list: ListDraft) => act<{ list: VersionedPriceList }>({ action: "saveList", list }, "Ceník se nepodařilo uložit.").then((body) => body.list),
    /** basedOn: the source version and the revision the user saw (a draft source must not have moved). */
    createVersion: (priceListId: string, basedOn?: Readonly<{ id: string; revision: number }>) =>
      act<{ versionId: string }>({ action: "createVersion", priceListId, basedOnVersionId: basedOn?.id, basedOnRevision: basedOn?.revision }, "Verzi se nepodařilo vytvořit.").then((body) => body.versionId),
    updateVersion: (versionId: string, expectedRevision: number, header: PriceVersionHeaderInput) =>
      act<{ ok: true; revision: number }>({ action: "updateVersion", versionId, expectedRevision, header }, "Hlavičku verze se nepodařilo uložit."),
    deleteVersion: (versionId: string, expectedRevision: number) => act({ action: "deleteVersion", versionId, expectedRevision }, "Koncept se nepodařilo smazat."),
    checkPublish: (versionId: string) => act<PublishCheck>({ action: "checkPublish", versionId }, "Kontrolu verze se nepodařilo provést."),
    publishVersion: (versionId: string, expectedRevision: number) =>
      act<{ ok: true; revision: number; warnings: readonly string[] }>({ action: "publishVersion", versionId, expectedRevision }, "Verzi se nepodařilo publikovat."),
    archiveVersion: (versionId: string, expectedRevision: number) => act({ action: "archiveVersion", versionId, expectedRevision }, "Verzi se nepodařilo archivovat."),
  };
}

/** Sale price lists (/api/price-versions). Never returns a purchase price. */
export function salePriceVersionsApi(actor: () => string | undefined = () => undefined) {
  return {
    load: () => get<SalePriceRegister>("/api/price-versions", "Ceníky se nepodařilo načíst."),
    ...versionActions("/api/price-versions", actor),
    loadRows: (versionId: string) =>
      get<{ version: PriceListVersion; list: VersionedPriceList; entries: readonly SalePriceEntry[]; surcharges: readonly PriceSurcharge[] }>(
        `/api/price-versions/rows?versionId=${encodeURIComponent(versionId)}`,
        "Řádky ceníku se nepodařilo načíst.",
      ),
    saveRows: (versionId: string, expectedRevision: number, entries: readonly SaleEntryInput[], surcharges: readonly SurchargeInput[]) =>
      post<{ ok: true; revision: number }>("/api/price-versions/rows", { versionId, expectedRevision, entries, surcharges }, "Řádky ceníku se nepodařilo uložit."),
    /** expectedCurrentVersionId = the assignment the user saw (null = none); a change in between is a conflict. */
    assign: (eventId: string, listKind: SalePriceListKind, versionId: string | null, expectedCurrentVersionId: string | null, note?: string) =>
      post<{ ok: true }>("/api/price-versions", { action: "assign", eventId, listKind, versionId, expectedCurrentVersionId, note, actor: actor() }, "Přiřazení se nepodařilo uložit."),
    setPriceCategory: (catalogItemId: string, priceCategory: PriceCategory) =>
      post<{ ok: true }>("/api/price-versions", { action: "setPriceCategory", catalogItemId, priceCategory }, "Kategorii se nepodařilo uložit."),
    resolve: (request: ResolveRequest) => post<ResolveResponse>("/api/price-versions/resolve", request, "Cenu se nepodařilo vypočítat."),
  };
}

/** Purchase price list (/api/purchase-prices) — internal only, separate permission. */
export function purchasePriceVersionsApi(actor: () => string | undefined = () => undefined) {
  return {
    load: () => get<PurchasePriceRegister>("/api/purchase-prices", "Nákupní ceníky se nepodařilo načíst."),
    ...versionActions("/api/purchase-prices", actor),
    loadRows: (versionId: string) =>
      get<{ version: PriceListVersion; list: VersionedPriceList; entries: readonly PurchasePriceEntry[] }>(
        `/api/purchase-prices/rows?versionId=${encodeURIComponent(versionId)}`,
        "Nákupní ceny se nepodařilo načíst.",
      ),
    saveRows: (versionId: string, expectedRevision: number, entries: readonly PurchaseEntryInput[]) =>
      post<{ ok: true; revision: number }>("/api/purchase-prices/rows", { versionId, expectedRevision, entries }, "Nákupní ceny se nepodařilo uložit."),
    linkCompany: (priceListId: string, realizationCompanyId: string, isActive: boolean) =>
      post<{ ok: true }>("/api/purchase-prices", { action: "linkCompany", priceListId, realizationCompanyId, isActive }, "Vazbu firmy se nepodařilo uložit."),
  };
}
