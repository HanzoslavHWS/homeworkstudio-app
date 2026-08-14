import type { Currency, Notes } from "./models.ts";
import type { StoredAsset } from "./assets.ts";

export type EventDeadline = Readonly<{
  id: string;
  name: string;
  date: string;
}>;

export type EventDocument = Readonly<{
  id: string;
  title: string;
  category: string;
  fileName: string;
  assetUrl?: string;
  asset?: StoredAsset;
  storageKey?: string;
  size?: number;
  mimeType: string;
  language?: "cs" | "en";
  active: boolean;
  createdAt?: string;
  availability: "temporary-session" | "persistent";
}>;

export type EventMediaMetadata = Readonly<{
  fileName: string;
  mimeType: string;
  size?: number;
  storageKey?: string;
  createdAt?: string;
  availability: "temporary-session" | "persistent";
}>;

export type Exhibition = Readonly<{
  id: string;
  slug: string;
  name: string;
  edition: string;
  year: number;
  venue: string;
  logoUrl: string;
  coverImageUrl: string;
  logoAsset?: StoredAsset;
  coverImageAsset?: StoredAsset;
  logoMetadata?: EventMediaMetadata;
  coverImageMetadata?: EventMediaMetadata;
  assemblyDate?: string;
  eventFrom?: string;
  eventTo?: string;
  disassemblyDate?: string;
  deadlines: readonly EventDeadline[];
  materialDataDeadline?: string;
  designApprovalDeadline?: string;
  documents: readonly EventDocument[];
  notes: Notes;
  importantInfo: string;
  defaultCurrency: Currency;
  priceListIds: readonly string[];
  defaultPriceListId?: string;
  realizationCompanyId?: string;
  active: boolean;
}>; 

export function normalizeEventDocument(
  document: Partial<EventDocument> & Pick<EventDocument, "id">,
): EventDocument {
  return {
    id: document.id,
    title: document.title ?? document.fileName ?? "Dokument",
    category: document.category ?? "other",
    fileName: document.fileName ?? "document",
    assetUrl: document.assetUrl,
    asset: document.asset,
    storageKey: document.storageKey ?? document.asset?.storageKey,
    size: document.size ?? document.asset?.size,
    mimeType: document.mimeType ?? "application/octet-stream",
    language: document.language,
    active: document.active ?? true,
    createdAt: document.createdAt,
    availability: document.storageKey || document.asset?.storageKey ? "persistent" : document.availability ?? "temporary-session",
  };
}

export function createEventDocumentFromAsset(
  asset: StoredAsset,
  defaults: Readonly<{ category?: string; language?: "cs" | "en" }> = {},
): EventDocument {
  return {
    id: asset.id,
    title: asset.originalFileName.replace(/\.[^.]+$/, ""),
    category: defaults.category ?? "other",
    fileName: asset.originalFileName,
    asset,
    storageKey: asset.storageKey,
    size: asset.size,
    mimeType: asset.mimeType,
    language: defaults.language,
    active: true,
    createdAt: asset.createdAt,
    availability: "persistent",
  };
}

export function createEventDocumentsFromFiles(
  files: readonly Pick<File, "name" | "type">[],
  defaults: Readonly<{ category?: string; language?: "cs" | "en" }> = {},
  createAssetUrl: (file: Pick<File, "name" | "type">) => string | undefined =
    () => undefined,
  now = new Date().toISOString(),
): readonly EventDocument[] {
  return files.map((file, index) => ({
    id: `event-document-${Date.now()}-${index}`,
    title: file.name.replace(/\.[^.]+$/, ""),
    category: defaults.category ?? "other",
    fileName: file.name,
    assetUrl: createAssetUrl(file),
    mimeType: file.type || "application/octet-stream",
    language: defaults.language,
    active: true,
    createdAt: now,
    availability: "temporary-session",
  }));
}

export function normalizeExhibition(
  event: Partial<Exhibition> & Pick<Exhibition, "id">,
): Exhibition {
  const slug = event.slug ?? event.id;
  return {
    id: event.id,
    slug,
    name: event.name ?? "Nová výstava",
    edition: event.edition ?? "",
    year: event.year ?? new Date().getFullYear(),
    venue: event.venue ?? "",
    logoUrl: event.logoUrl ?? eventLogoUrl(slug),
    coverImageUrl: event.coverImageUrl ?? eventCoverImageUrl(slug),
    logoAsset: event.logoAsset,
    coverImageAsset: event.coverImageAsset,
    logoMetadata: event.logoMetadata,
    coverImageMetadata: event.coverImageMetadata,
    assemblyDate: event.assemblyDate,
    eventFrom: event.eventFrom,
    eventTo: event.eventTo,
    disassemblyDate: event.disassemblyDate,
    deadlines: event.deadlines ?? [],
    materialDataDeadline: event.materialDataDeadline,
    designApprovalDeadline: event.designApprovalDeadline,
    documents: (event.documents ?? []).map(normalizeEventDocument),
    notes: event.notes ?? { internalNote: "", customerNote: "" },
    importantInfo: event.importantInfo ?? "",
    defaultCurrency: event.defaultCurrency ?? "CZK",
    priceListIds: event.priceListIds ?? [],
    defaultPriceListId: event.defaultPriceListId,
    realizationCompanyId: event.realizationCompanyId,
    active: event.active ?? true,
  };
}

export function eventHasUnsavedChanges(
  saved: Exhibition | undefined,
  draft: Exhibition | undefined,
): boolean {
  return JSON.stringify(saved ?? null) !== JSON.stringify(draft ?? null);
}

export type RealizationCompany = Readonly<{
  id: string;
  name: string;
  active: boolean;
}>;

export type PriceList = Readonly<{
  id: string;
  name: string;
  code: string;
  currency: Currency;
  year: number;
  edition?: string;
  realizationCompanyId?: string;
  validFrom?: string;
  validTo?: string;
  active: boolean;
}>;

/** Defensive defaults for a PriceList coming from a partial source (DB document JSONB, admin form draft) — mirrors normalizeExhibition(). */
export function normalizePriceList(
  priceList: Partial<PriceList> & Pick<PriceList, "id">,
): PriceList {
  return {
    id: priceList.id,
    name: priceList.name ?? "Nový ceník",
    code: priceList.code ?? priceList.id.toUpperCase(),
    currency: priceList.currency ?? "CZK",
    year: priceList.year ?? new Date().getFullYear(),
    edition: priceList.edition,
    realizationCompanyId: priceList.realizationCompanyId,
    validFrom: priceList.validFrom,
    validTo: priceList.validTo,
    active: priceList.active ?? true,
  };
}

/**
 * Section 5: makes "Event → default PriceList" an explicit, testable resolution instead
 * of just trusting the fields exist. Falls back to the first assigned price list when no
 * defaultPriceListId is set; returns undefined rather than guessing if neither resolves to
 * an actual PriceList the caller passed in (e.g. stale id after a price list was archived).
 */
export function resolveDefaultPriceList(
  event: Pick<Exhibition, "defaultPriceListId" | "priceListIds">,
  priceLists: readonly PriceList[],
): PriceList | undefined {
  const candidateId = event.defaultPriceListId ?? event.priceListIds[0];
  return candidateId ? priceLists.find((priceList) => priceList.id === candidateId) : undefined;
}

export function eventLogoUrl(slug: string): string {
  return `/events/${slug}/logo.png`;
}

export function eventCoverImageUrl(slug: string): string {
  return `/events/${slug}/cover.png`;
}
