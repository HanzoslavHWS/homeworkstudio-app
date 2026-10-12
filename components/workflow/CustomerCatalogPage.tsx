"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CatalogItemAdmin } from "../../domain/catalogItemsAdmin";
import type { PricingEntrySummary } from "../../domain/catalogPricing";
import {
  CUSTOMER_CATALOG_ITEM_TYPES,
  CUSTOMER_CATALOG_PRICE_NOTE,
  CUSTOMER_CATALOG_TYPE_LABELS_CS,
  DEFAULT_CUSTOMER_CATALOG_EXPORT_OPTIONS,
  DEFAULT_CUSTOMER_CATALOG_TITLE,
  buildCustomerCatalogDocument,
  buildCustomerCatalogEntries,
  buildCustomerCatalogFileName,
  catalogCardCodeLine,
  catalogCardPriceLine,
  catalogCategoryKey,
  eventPriceListsForCurrency,
  filterCustomerCatalogEntries,
  formatCatalogPrice,
  orderCustomerCatalogCategories,
  resolveCatalogPriceList,
  sortCustomerCatalogEntries,
  type CustomerCatalogCard,
  type CustomerCatalogDocument,
  type CustomerCatalogEntry,
  type CustomerCatalogExportOptions,
  type CustomerCatalogItemType,
  type CustomerCatalogPreset,
  type CustomerCatalogPresetConfig,
  type CustomerCatalogPresetRepository,
} from "../../domain/customerCatalog";
import { eventHasCuratedLogoAsset, resolveEventBranding } from "../../domain/eventBranding";
import type { Currency } from "../../domain/models";
import type { Exhibition, PriceList } from "../../domain/organizations";
import {
  CUSTOMER_CATALOG_PDF_IMAGE_BOX_MM,
  CUSTOMER_CATALOG_PDF_LOGO_BOX_MM,
  buildCustomerCatalogPdf,
  type CustomerCatalogPdfBranding,
} from "../../lib/customerCatalogPdf";
import { resolveContainRect } from "../../lib/pdf/imageRect";
import { loadImageElement, type LoadedImageDataUrl } from "../../lib/pdf/loadImageDataUrl";
import { prepareImageForPdf } from "../../lib/pdf/prepareImageForPdf";
import { getAssetDownloadUrl } from "../../lib/storage/assetClient";
import { useAssetUrl } from "../../hooks/useAssetUrl";

/** Catalog photos sit in boxes a few centimetres across — enough for a sharp print, a fraction of the original file. */
const CATALOG_PDF_IMAGE_DPI = 220;
const CATALOG_PDF_JPEG_QUALITY = 0.86;
const IMAGE_BATCH_SIZE = 6;

const OPTION_LABELS: readonly Readonly<{ key: keyof CustomerCatalogExportOptions; label: string }>[] = [
  { key: "showPrices", label: "Ceny" },
  { key: "showAbfCode", label: "ABF kód" },
  { key: "showDescription", label: "Krátký popis" },
  { key: "showDimensions", label: "Rozměry" },
  { key: "showUnit", label: "Jednotka" },
  { key: "showTechnicalParameters", label: "Technické parametry" },
  { key: "showPackageContents", label: "Obsah stánku" },
  { key: "showInternalCode", label: "Interní kód" },
];

function entryPriceLabel(entry: CustomerCatalogEntry): string {
  switch (entry.price.status) {
    case "fixed":
      return formatCatalogPrice(entry.price.amount, entry.price.currency);
    case "individual":
      return "Cena na vyžádání";
    case "included":
      return "V ceně";
    default:
      return "Cena není nastavena";
  }
}

/** Fits an already-decoded image to the box the PDF draws it in; falls back to native resolution, then to "no image" — never throws. */
function prepareForBox(element: HTMLImageElement, box: Readonly<{ widthMm: number; heightMm: number }>, format: "JPEG" | "PNG"): LoadedImageDataUrl | undefined {
  const originalWidthPx = element.naturalWidth;
  const originalHeightPx = element.naturalHeight;
  const fitted = resolveContainRect({ x: 0, y: 0, width: box.widthMm, height: box.heightMm }, originalWidthPx, originalHeightPx);
  const base = { element, originalWidthPx, originalHeightPx, renderedWidthMm: fitted.width, renderedHeightMm: fitted.height, format, dpi: CATALOG_PDF_IMAGE_DPI, quality: CATALOG_PDF_JPEG_QUALITY };
  const prepared = prepareImageForPdf(base) ?? prepareImageForPdf({ ...base, nativeResolution: true });
  return prepared ? { dataUrl: prepared.dataUrl, widthPx: prepared.widthPx, heightPx: prepared.heightPx, format: prepared.format } : undefined;
}

function downloadPdf(bytes: Uint8Array, fileName: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function CustomerCatalogPage({
  catalogRepository,
  pricingRepository,
  presetRepository,
  events,
  priceLists,
}: {
  /** Read-only here — the catalog never writes catalog items. */
  catalogRepository: Readonly<{ list(): Promise<readonly CatalogItemAdmin[]> }>;
  pricingRepository: Readonly<{ listPricingEntries(priceListId: string): Promise<readonly PricingEntrySummary[]> }>;
  presetRepository: CustomerCatalogPresetRepository;
  events: readonly Exhibition[];
  priceLists: readonly PriceList[];
}) {
  const [items, setItems] = useState<readonly CatalogItemAdmin[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [eventId, setEventId] = useState("");
  const [currency, setCurrency] = useState<Currency>("CZK");
  const [preferredPriceListId, setPreferredPriceListId] = useState<string | undefined>(undefined);
  const [pricing, setPricing] = useState<Readonly<{ priceListId: string; entries: readonly PricingEntrySummary[] }> | undefined>(undefined);
  const [pricingError, setPricingError] = useState("");
  const [itemType, setItemType] = useState<CustomerCatalogItemType | "">("");
  const [category, setCategory] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [options, setOptions] = useState<CustomerCatalogExportOptions>(DEFAULT_CUSTOMER_CATALOG_EXPORT_OPTIONS);
  const [categoryOrder, setCategoryOrder] = useState<readonly string[]>([]);
  const [title, setTitle] = useState("");
  const [imageUrls, setImageUrls] = useState<Readonly<Record<string, string>>>({});
  const [presets, setPresets] = useState<readonly CustomerCatalogPreset[]>([]);
  const [presetId, setPresetId] = useState("");
  const [presetName, setPresetName] = useState("");
  const [presetMessage, setPresetMessage] = useState("");
  const [presetBusy, setPresetBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState("");

  const event = events.find((candidate) => candidate.id === eventId);
  const priceListCandidates = useMemo(() => eventPriceListsForCurrency(event, priceLists, currency), [event, priceLists, currency]);
  const priceList = useMemo(() => resolveCatalogPriceList(event, priceLists, currency, preferredPriceListId), [event, priceLists, currency, preferredPriceListId]);
  const priceListId = priceList?.id;
  // Same precedence as the PDF cover: the uploaded logo, else the static per-event file.
  const previewLogo = useAssetUrl(event?.logoAsset, event?.logoUrl);

  // First visit: start from the first active event and its default currency. Runs once — an
  // explicit "Bez veletrhu" choice afterwards is respected.
  const eventDefaultedRef = useRef(false);
  useEffect(() => {
    if (eventDefaultedRef.current || events.length === 0) return;
    eventDefaultedRef.current = true;
    const initial = events.find((candidate) => candidate.active) ?? events[0]!;
    setEventId(initial.id);
    setCurrency(initial.defaultCurrency);
  }, [events]);

  const selectionDefaultedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    catalogRepository
      .list()
      .then((loaded) => {
        if (cancelled) return;
        setItems(loaded);
        setLoadError("");
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "Katalog se nepodařilo načíst z databáze.");
      });
    return () => {
      cancelled = true;
    };
  }, [catalogRepository]);

  useEffect(() => {
    let cancelled = false;
    presetRepository
      .list()
      .then((loaded) => {
        if (!cancelled) setPresets(loaded);
      })
      .catch((error) => {
        if (!cancelled) setPresetMessage(error instanceof Error ? error.message : "Uložené konfigurace se nepodařilo načíst.");
      });
    return () => {
      cancelled = true;
    };
  }, [presetRepository]);

  useEffect(() => {
    setPricingError("");
    if (!priceListId) return;
    let cancelled = false;
    pricingRepository
      .listPricingEntries(priceListId)
      .then((entries) => {
        if (!cancelled) setPricing({ priceListId, entries });
      })
      .catch((error) => {
        if (!cancelled) setPricingError(error instanceof Error ? error.message : "Ceny se nepodařilo načíst z databáze.");
      });
    return () => {
      cancelled = true;
    };
  }, [pricingRepository, priceListId]);

  // Entries of a previously chosen price list are never shown against the current one.
  const pricingEntries = pricing && pricing.priceListId === priceListId ? pricing.entries : undefined;
  const pricesLoading = Boolean(priceListId) && !pricingEntries && !pricingError;

  const entries = useMemo(
    () => buildCustomerCatalogEntries(items ?? [], { event, priceList, currency, entries: pricingEntries ?? [] }),
    [items, event, priceList, currency, pricingEntries],
  );
  const sortedEntries = useMemo(() => sortCustomerCatalogEntries(entries, categoryOrder), [entries, categoryOrder]);
  const categories = useMemo(() => orderCustomerCatalogCategories(entries, categoryOrder), [entries, categoryOrder]);
  const visibleEntries = useMemo(() => filterCustomerCatalogEntries(sortedEntries, { itemType, category, query }), [sortedEntries, itemType, category, query]);
  const selectedEntries = useMemo(() => sortedEntries.filter((entry) => selectedIds.has(entry.id)), [sortedEntries, selectedIds]);
  const selectedCategories = useMemo(() => orderCustomerCatalogCategories(selectedEntries, categoryOrder), [selectedEntries, categoryOrder]);
  const catalogDocument = useMemo(
    () => buildCustomerCatalogDocument({ entries: selectedEntries, options, currency, event, categoryOrder, title }),
    [selectedEntries, options, currency, event, categoryOrder, title],
  );

  // A fresh page starts with the whole published catalog selected.
  useEffect(() => {
    if (selectionDefaultedRef.current || !items) return;
    selectionDefaultedRef.current = true;
    setSelectedIds(new Set(entries.map((entry) => entry.id)));
  }, [items, entries]);

  // Signed download URLs for stored images, resolved once per asset. A failure simply leaves the
  // entry without an image (placeholder) — never an error for the whole page.
  const resolvedAssetUrlsRef = useRef(new Map<string, string | null>());
  useEffect(() => {
    let cancelled = false;
    const cache = resolvedAssetUrlsRef.current;
    const publish = () => {
      if (cancelled) return;
      const next: Record<string, string> = {};
      for (const entry of entries) {
        const url = entry.imageAsset ? cache.get(entry.imageAsset.storageKey) : entry.imageUrl;
        if (url) next[entry.id] = url;
      }
      setImageUrls(next);
    };
    const pending = [...new Set(entries.flatMap((entry) => (entry.imageAsset && !cache.has(entry.imageAsset.storageKey) ? [entry.imageAsset.storageKey] : [])))];
    publish();
    void Promise.all(
      pending.map(async (storageKey) => {
        try {
          cache.set(storageKey, await getAssetDownloadUrl(storageKey));
        } catch {
          cache.set(storageKey, null);
        }
      }),
    ).then(() => {
      if (pending.length > 0) publish();
    });
    return () => {
      cancelled = true;
    };
  }, [entries]);

  function setSelection(ids: readonly string[], checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  function moveCategory(key: string, direction: -1 | 1) {
    const keys = categories.map((entry) => entry.key);
    const shown = selectedCategories.map((entry) => entry.key);
    const neighbour = shown[shown.indexOf(key) + direction];
    if (neighbour === undefined) return;
    const from = keys.indexOf(key);
    const to = keys.indexOf(neighbour);
    keys.splice(from, 1);
    keys.splice(to, 0, key);
    setCategoryOrder(keys);
  }

  function currentConfig(): CustomerCatalogPresetConfig {
    return {
      ...(eventId ? { eventId } : {}),
      ...(priceListId ? { priceListId } : {}),
      currency,
      itemType,
      ...(category !== undefined ? { category } : {}),
      selectedItemIds: [...selectedIds],
      options,
      categoryOrder,
      ...(title.trim() ? { title: title.trim() } : {}),
    };
  }

  function applyPreset(preset: CustomerCatalogPreset) {
    const config = preset.config;
    eventDefaultedRef.current = true;
    selectionDefaultedRef.current = true;
    setEventId(config.eventId && events.some((candidate) => candidate.id === config.eventId) ? config.eventId : "");
    setCurrency(config.currency);
    setPreferredPriceListId(config.priceListId);
    setItemType(config.itemType);
    setCategory(config.category);
    setQuery("");
    setSelectedIds(new Set(config.selectedItemIds));
    setOptions(config.options);
    setCategoryOrder(config.categoryOrder);
    setTitle(config.title ?? "");
    setPresetName(preset.name);
  }

  async function handlePresetSave(asNew: boolean) {
    setPresetBusy(true);
    setPresetMessage("");
    try {
      const saved = await presetRepository.save({ ...(!asNew && presetId ? { id: presetId } : {}), name: presetName, config: currentConfig() });
      setPresets((current) => [...current.filter((preset) => preset.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name, "cs")));
      setPresetId(saved.id);
      setPresetMessage("Konfigurace uložena.");
    } catch (error) {
      setPresetMessage(error instanceof Error ? error.message : "Uložení konfigurace selhalo.");
    } finally {
      setPresetBusy(false);
    }
  }

  async function handlePresetDelete() {
    const preset = presets.find((candidate) => candidate.id === presetId);
    if (!preset || !window.confirm(`Smazat uloženou konfiguraci „${preset.name}“?`)) return;
    setPresetBusy(true);
    setPresetMessage("");
    try {
      await presetRepository.delete(preset.id);
      setPresets((current) => current.filter((candidate) => candidate.id !== preset.id));
      setPresetId("");
    } catch (error) {
      setPresetMessage(error instanceof Error ? error.message : "Smazání konfigurace selhalo.");
    } finally {
      setPresetBusy(false);
    }
  }

  async function loadCardImages(cards: readonly CustomerCatalogCard[]): Promise<Map<string, LoadedImageDataUrl>> {
    const images = new Map<string, LoadedImageDataUrl>();
    const withImage = cards.filter((card) => card.hasImage && imageUrls[card.id]);
    for (let start = 0; start < withImage.length; start += IMAGE_BATCH_SIZE) {
      await Promise.all(
        withImage.slice(start, start + IMAGE_BATCH_SIZE).map(async (card) => {
          const element = await loadImageElement(imageUrls[card.id]!);
          const prepared = element ? prepareForBox(element, CUSTOMER_CATALOG_PDF_IMAGE_BOX_MM[card.layout], "JPEG") : undefined;
          if (prepared) images.set(card.id, prepared);
        }),
      );
    }
    return images;
  }

  async function loadEventLogo(): Promise<CustomerCatalogPdfBranding> {
    if (!event) return {};
    let curatedUrl: string | undefined;
    if (eventHasCuratedLogoAsset(event)) {
      try {
        curatedUrl = await getAssetDownloadUrl(event.logoAsset.storageKey);
      } catch {
        curatedUrl = undefined;
      }
    }
    const logoUrl = resolveEventBranding(event, curatedUrl).logoUrl;
    const element = logoUrl ? await loadImageElement(logoUrl) : undefined;
    const eventLogo = element ? prepareForBox(element, CUSTOMER_CATALOG_PDF_LOGO_BOX_MM, "PNG") : undefined;
    return eventLogo ? { eventLogo } : {};
  }

  async function handleExport() {
    if (exportBusy || catalogDocument.itemCount === 0) return;
    setExportBusy(true);
    setExportError("");
    try {
      const [images, branding] = await Promise.all([loadCardImages(catalogDocument.sections.flatMap((section) => section.cards)), loadEventLogo()]);
      const bytes = await buildCustomerCatalogPdf(catalogDocument, images, branding);
      downloadPdf(bytes, buildCustomerCatalogFileName({ eventName: event?.name, currency }));
    } catch (error) {
      console.error("Customer catalog PDF export failed", error);
      setExportError("Vytvoření PDF katalogu se nezdařilo.");
    } finally {
      setExportBusy(false);
    }
  }

  const allVisibleSelected = visibleEntries.length > 0 && visibleEntries.every((entry) => selectedIds.has(entry.id));
  const missingPriceIds = selectedEntries.filter((entry) => entry.price.status === "missing").map((entry) => entry.id);
  const visibleByCategory = orderCustomerCatalogCategories(visibleEntries, categoryOrder).map((entry) => ({
    ...entry,
    entries: visibleEntries.filter((candidate) => catalogCategoryKey(candidate) === entry.key),
  }));

  return (
    <div className="workspacePage customerCatalogPage">
      <div className="workspacePageHeader">
        <div>
          <span className="eyebrow">PREZENTAČNÍ VÝSTUP</span>
          <h1>Katalog</h1>
          <p>Zákaznický katalog produktů, služeb a stánků. Položky, kódy a ceny se spravují v Katalogu komponent a ve Správě cen — tady se jen vybírá, co půjde do PDF.</p>
        </div>
        {items && <span className="catalogAdminCount">{selectedEntries.length} vybráno / {entries.length} publikováno</span>}
      </div>

      {loadError && <p className="uploadError persistenceBanner">Katalog se nepodařilo načíst z databáze: {loadError}</p>}
      {!items && !loadError && <p className="workspaceEmpty">Načítám katalog z databáze…</p>}

      {items && (
        <>
          <div className="customerCatalogContext">
            <label>
              <span>Veletrh</span>
              <select
                value={eventId}
                onChange={(changeEvent) => {
                  const next = events.find((candidate) => candidate.id === changeEvent.target.value);
                  setEventId(changeEvent.target.value);
                  setPreferredPriceListId(undefined);
                  if (next) setCurrency(next.defaultCurrency);
                }}
              >
                <option value="">Bez veletrhu (bez cen)</option>
                {events.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>{candidate.name}{candidate.active ? "" : " (neaktivní)"}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Měna</span>
              <select value={currency} onChange={(changeEvent) => { setCurrency(changeEvent.target.value as Currency); setPreferredPriceListId(undefined); }}>
                <option value="CZK">CZK</option>
                <option value="EUR">EUR</option>
              </select>
            </label>
            <label>
              <span>Ceník</span>
              <select value={priceListId ?? ""} onChange={(changeEvent) => setPreferredPriceListId(changeEvent.target.value || undefined)} disabled={priceListCandidates.length < 2}>
                {priceListCandidates.length === 0 && <option value="">— žádný ceník v {currency} —</option>}
                {priceListCandidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>{candidate.name} ({candidate.code})</option>
                ))}
              </select>
            </label>
            <label>
              <span>Nadpis katalogu</span>
              <input value={title} maxLength={120} onChange={(changeEvent) => setTitle(changeEvent.target.value)} placeholder={DEFAULT_CUSTOMER_CATALOG_TITLE} />
            </label>
          </div>

          {event && !priceList && (
            <p className="temporaryNotice persistenceBanner">
              Veletrh „{event.name}“ nemá přiřazený aktivní ceník v {currency}. Ceny v této měně proto nejsou k dispozici — mezi měnami se nic nepřepočítává.
            </p>
          )}
          {pricingError && <p className="uploadError persistenceBanner">{pricingError}</p>}

          <div className="customerCatalogPresets">
            <select
              value={presetId}
              onChange={(changeEvent) => {
                setPresetId(changeEvent.target.value);
                setPresetMessage("");
                const preset = presets.find((candidate) => candidate.id === changeEvent.target.value);
                if (preset) applyPreset(preset);
              }}
            >
              <option value="">Uložené konfigurace…</option>
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>{preset.name}</option>
              ))}
            </select>
            <input value={presetName} maxLength={120} onChange={(changeEvent) => setPresetName(changeEvent.target.value)} placeholder="Název konfigurace (např. FOR BEAUTY 2026 – kompletní katalog)" />
            {presetId && <button type="button" className="secondaryButton" disabled={presetBusy || !presetName.trim()} onClick={() => void handlePresetSave(false)}>Uložit změny</button>}
            <button type="button" className="secondaryButton" disabled={presetBusy || !presetName.trim()} onClick={() => void handlePresetSave(true)}>Uložit jako novou</button>
            {presetId && <button type="button" className="dangerText" disabled={presetBusy} onClick={() => void handlePresetDelete()}>Smazat</button>}
            {presetMessage && <small className="fieldHint">{presetMessage}</small>}
          </div>

          <div className="customerCatalogSplit">
            <section className="customerCatalogPicker">
              <div className="adminFilters customerCatalogFilters">
                <input value={query} onChange={(changeEvent) => setQuery(changeEvent.target.value)} placeholder="Hledat název nebo ABF kód…" />
                <select value={itemType} onChange={(changeEvent) => setItemType(changeEvent.target.value as CustomerCatalogItemType | "")}>
                  <option value="">Typ: vše</option>
                  {CUSTOMER_CATALOG_ITEM_TYPES.map((value) => (
                    <option key={value} value={value}>{CUSTOMER_CATALOG_TYPE_LABELS_CS[value]}</option>
                  ))}
                </select>
                <select value={category === undefined ? "__all" : category} onChange={(changeEvent) => setCategory(changeEvent.target.value === "__all" ? undefined : changeEvent.target.value)}>
                  <option value="__all">Kategorie: vše</option>
                  {categories.map((entry) => (
                    <option key={entry.key} value={entry.key}>{entry.label} ({entry.count})</option>
                  ))}
                </select>
              </div>

              <div className="catalogBulkBar">
                <label className="checkboxRow">
                  <input type="checkbox" checked={allVisibleSelected} onChange={(changeEvent) => setSelection(visibleEntries.map((entry) => entry.id), changeEvent.target.checked)} />
                  Označit vše zobrazené ({visibleEntries.length})
                </label>
                <button type="button" className="secondaryButton" disabled={selectedIds.size === 0} onClick={() => setSelectedIds(new Set())}>Zrušit celý výběr</button>
                {pricesLoading && <small className="fieldHint">Načítám ceny…</small>}
              </div>

              {entries.length === 0 && (
                <p className="workspaceEmpty">
                  V katalogu zatím není publikovaná žádná položka. Zapněte „Zobrazovat v katalogu“ u produktů, služeb a stánků v Katalogu komponent (sekce Publikace v katalogu).
                </p>
              )}
              {entries.length > 0 && visibleEntries.length === 0 && <p className="workspaceEmpty">Filtru neodpovídá žádná položka.</p>}

              {visibleByCategory.map((group) => {
                const ids = group.entries.map((entry) => entry.id);
                return (
                  <div key={group.key} className="customerCatalogGroup">
                    <label className="checkboxRow customerCatalogGroupHeader">
                      <input type="checkbox" checked={ids.every((id) => selectedIds.has(id))} onChange={(changeEvent) => setSelection(ids, changeEvent.target.checked)} />
                      <strong>{group.label}</strong>
                      <span>{ids.filter((id) => selectedIds.has(id)).length} / {ids.length}</span>
                    </label>
                    {group.entries.map((entry) => (
                      <label key={entry.id} className={selectedIds.has(entry.id) ? "customerCatalogRow selected" : "customerCatalogRow"}>
                        <input type="checkbox" checked={selectedIds.has(entry.id)} onChange={(changeEvent) => setSelection([entry.id], changeEvent.target.checked)} />
                        <CatalogThumbnail url={imageUrls[entry.id]} />
                        <span className="customerCatalogRowName">
                          <strong>{entry.name}</strong>
                          <small>{[CUSTOMER_CATALOG_TYPE_LABELS_CS[entry.itemType], entry.categoryLabel, entry.abfCode ? `ABF ${entry.abfCode}` : undefined].filter(Boolean).join(" · ")}</small>
                        </span>
                        <span className={entry.price.status === "missing" ? "customerCatalogRowPrice missing" : "customerCatalogRowPrice"}>
                          {pricesLoading ? "…" : entryPriceLabel(entry)}
                        </span>
                      </label>
                    ))}
                  </div>
                );
              })}
            </section>

            <section className="customerCatalogOutput">
              <div className="customerCatalogOptions">
                <h3>Údaje v PDF</h3>
                <div className="customerCatalogOptionGrid">
                  {OPTION_LABELS.map((option) => (
                    <label key={option.key} className="checkboxRow">
                      <input type="checkbox" checked={options[option.key]} onChange={(changeEvent) => setOptions({ ...options, [option.key]: changeEvent.target.checked })} />
                      {option.label}
                    </label>
                  ))}
                </div>
                <p className="fieldHint">Všechny ceny jsou bez DPH. Interní kód je pro zákazníka ve výchozím stavu vypnutý.</p>
              </div>

              {selectedCategories.length > 1 && (
                <div className="customerCatalogOptions">
                  <h3>Pořadí kategorií</h3>
                  {selectedCategories.map((entry, index) => (
                    <div key={entry.key} className="customerCatalogOrderRow">
                      <span>{index + 1}. {entry.label} ({entry.count})</span>
                      <button type="button" className="secondaryButton" disabled={index === 0} onClick={() => moveCategory(entry.key, -1)} aria-label={`Posunout kategorii ${entry.label} výš`}>↑</button>
                      <button type="button" className="secondaryButton" disabled={index === selectedCategories.length - 1} onClick={() => moveCategory(entry.key, 1)} aria-label={`Posunout kategorii ${entry.label} níž`}>↓</button>
                    </div>
                  ))}
                  <p className="fieldHint">Pořadí položek uvnitř kategorie určuje pole „Pořadí“ v Katalogu komponent, jinak název.</p>
                </div>
              )}

              {options.showPrices && missingPriceIds.length > 0 && !pricesLoading && (
                <div className="customerCatalogWarning">
                  <strong>{missingPriceIds.length} vybraných položek nemá pro tento veletrh a měnu cenu.</strong>
                  <span>V PDF zůstanou bez ceny. Můžete je ponechat, vypnout ceny, nebo je z výběru odebrat.</span>
                  <div className="assetActions">
                    <button type="button" className="secondaryButton" onClick={() => setOptions({ ...options, showPrices: false })}>Vypnout ceny</button>
                    <button type="button" className="secondaryButton" onClick={() => setSelection(missingPriceIds, false)}>Odebrat položky bez ceny</button>
                  </div>
                </div>
              )}

              <div className="customerCatalogExportBar">
                <button type="button" className="primaryButton" disabled={exportBusy || catalogDocument.itemCount === 0 || pricesLoading} onClick={() => void handleExport()}>
                  {exportBusy ? "Připravuji PDF…" : "Exportovat PDF"}
                </button>
                <small className="fieldHint">{buildCustomerCatalogFileName({ eventName: event?.name, currency })}</small>
              </div>
              {exportError && <p className="uploadError">{exportError}</p>}

              <h3 className="customerCatalogPreviewTitle">Náhled</h3>
              <CustomerCatalogPreview catalog={catalogDocument} imageUrls={imageUrls} logoUrl={previewLogo.url} />
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function CatalogThumbnail({ url }: { url: string | undefined }) {
  const [failedUrl, setFailedUrl] = useState<string | undefined>(undefined);
  return (
    <span className="catalogThumbnailCell">
      {url && failedUrl !== url ? <img className="catalogThumbnailImg" src={url} alt="" onError={() => setFailedUrl(url)} /> : <span className="catalogThumbnailPlaceholder" aria-hidden="true" />}
    </span>
  );
}

/** An image that failed to load behaves exactly like a missing one: the placeholder, never a broken icon. */
function PreviewImage({ url, placeholder }: { url: string | undefined; placeholder: string }) {
  const [failedUrl, setFailedUrl] = useState<string | undefined>(undefined);
  if (!url || failedUrl === url) return <span className="ccImagePlaceholder">{placeholder}</span>;
  return <img src={url} alt="" onError={() => setFailedUrl(url)} />;
}

function PreviewCard({ card, imageUrl }: { card: CustomerCatalogCard; imageUrl: string | undefined }) {
  const codeLine = catalogCardCodeLine(card);
  const priceLine = catalogCardPriceLine(card);
  const showThumbnail = card.layout !== "service" || Boolean(card.hasImage && imageUrl);
  return (
    <article className={`ccCard ccCard-${card.layout}`}>
      {showThumbnail && (
        <div className="ccCardImage">
          <PreviewImage url={card.hasImage ? imageUrl : undefined} placeholder={card.layout === "booth" ? "Vizualizace není k dispozici" : "Bez fotografie"} />
        </div>
      )}
      <div className="ccCardBody">
        <h4>{card.name}</h4>
        {codeLine && <span className="ccCode">{codeLine}</span>}
        {card.layout === "booth" && card.dimensionsLabel && <p className="ccBoothSize">Rozměr: {card.dimensionsLabel}</p>}
        {card.description && <p>{card.description}</p>}
        {card.layout !== "booth" && card.dimensionsLabel && <p>Rozměry: {card.dimensionsLabel}</p>}
        {card.contents.length > 0 && (
          <div className="ccContents">
            <strong>Obsahuje:</strong>
            <ul>{card.contents.map((line, index) => <li key={index}>{line}</li>)}</ul>
          </div>
        )}
        {card.parameters.map((parameter, index) => <p key={index}>{parameter.key}: {parameter.value}</p>)}
        {priceLine && <p className="ccPrice">{card.layout === "booth" && card.priceLabel ? `Cena celku: ${priceLine}` : priceLine}</p>}
        {card.priceMissing && <p className="ccPriceMissing">Cena není nastavena — v PDF bez ceny</p>}
      </div>
    </article>
  );
}

/** Live preview of the same CustomerCatalogDocument the PDF renderer draws — same sections, order, cards and switched-on fields. Not paginated. */
function CustomerCatalogPreview({ catalog, imageUrls, logoUrl }: { catalog: CustomerCatalogDocument; imageUrls: Readonly<Record<string, string>>; logoUrl: string | undefined }) {
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | undefined>(undefined);
  return (
    <div className="customerCatalogPreview">
      <div className="ccSheet ccCover">
        {logoUrl && failedLogoUrl !== logoUrl && <img className="ccCoverLogo" src={logoUrl} alt="" onError={() => setFailedLogoUrl(logoUrl)} />}
        <div className="ccCoverTitle">
          <span className="ccCoverAccent" />
          <h2>{catalog.title}</h2>
          {catalog.eventName && <strong>{catalog.eventName}</strong>}
          <span>{[catalog.eventDateRange, catalog.eventVenue].filter(Boolean).join("  ·  ")}</span>
        </div>
        <div className="ccCoverFooter">
          <strong>HOMEWORK STUDIO</strong>
          {catalog.showPrices && <span>Ceny v {catalog.currency} bez DPH</span>}
        </div>
      </div>

      {catalog.itemCount === 0 ? (
        <p className="workspaceEmpty">Vyberte položky, které mají být v katalogu.</p>
      ) : (
        <div className="ccSheet">
          {catalog.sections.map((section) => (
            <section key={section.categoryKey} className="ccSection">
              <h3>{section.title}</h3>
              <div className="ccGrid">
                {section.cards.map((card) => <PreviewCard key={card.id} card={card} imageUrl={imageUrls[card.id]} />)}
              </div>
            </section>
          ))}
          {catalog.showPrices && <p className="ccFootnote">{CUSTOMER_CATALOG_PRICE_NOTE}</p>}
        </div>
      )}
    </div>
  );
}
