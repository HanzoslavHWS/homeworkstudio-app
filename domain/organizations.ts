import type { Currency, Notes } from "./models.ts";

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
  mimeType: string;
  language?: "cs" | "en";
  active: boolean;
  createdAt?: string;
  availability: "temporary-session" | "persistent";
}>;

export type EventMediaMetadata = Readonly<{
  fileName: string;
  mimeType: string;
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
    mimeType: document.mimeType ?? "application/octet-stream",
    language: document.language,
    active: document.active ?? true,
    createdAt: document.createdAt,
    availability: document.availability ?? "temporary-session",
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

export function eventLogoUrl(slug: string): string {
  return `/events/${slug}/logo.png`;
}

export function eventCoverImageUrl(slug: string): string {
  return `/events/${slug}/cover.png`;
}
