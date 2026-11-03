"use client";

import { useEffect, useMemo, useState } from "react";
import {
  cardPurchaseListChoice,
  cardPurchasePrice,
  cardSaleListChoice,
  cardSalePrices,
  defaultCardVersion,
  type CardListChoice,
  type CardPriceCell,
} from "../../domain/catalogCardPrices";
import {
  EUR_ROUNDING_MODE_LABELS_CS,
  MISSING_REASON_LABELS_CS,
  PRICE_TRACKS,
  PRICE_LIST_KIND_LABELS_CS,
  PRICE_VERSION_STATUS_LABELS_CS,
  type EventPriceAssignment,
  type PriceListVersion,
  type PriceTrack,
  type VersionedPriceResult,
  type PurchasePriceEntry,
  type SalePriceEntry,
  type VersionedPriceList,
} from "../../domain/priceVersions";
import { purchasePriceVersionsApi, salePriceVersionsApi } from "../../lib/db/priceVersions.remoteApi.client";
import type { PricingCatalogItem, PricingEvent } from "../../lib/db/priceVersions.supabase";
import { formatAmount, versionTitle } from "./priceVersions/PriceVersionParts";
import type { PriceVersionsPreselect } from "./priceVersions/PriceVersionsPage";

type SaleSource = Readonly<{
  lists: readonly VersionedPriceList[];
  versions: readonly PriceListVersion[];
  items: readonly PricingCatalogItem[];
  events: readonly PricingEvent[];
  assignments: readonly EventPriceAssignment[];
}>;
type PurchaseSource = Readonly<{ lists: readonly VersionedPriceList[]; versions: readonly PriceListVersion[] }>;

function versionOptionLabel(version: PriceListVersion): string {
  const validity = version.validFrom ? ` · od ${new Date(`${version.validFrom}T00:00:00`).toLocaleDateString("cs-CZ")}` : "";
  return `${versionTitle(version)} · ${PRICE_VERSION_STATUS_LABELS_CS[version.status]}${validity}`;
}

function CellValue({ cell, currency }: { cell: CardPriceCell; currency: "CZK" | "EUR" }) {
  if (cell.status === "missing") return <strong className="pricingMissing">K nacenění</strong>;
  if (cell.status === "individual") return <strong>Individuálně</strong>;
  if (cell.status === "included") return <strong>V ceně</strong>;
  return <strong>{formatAmount(cell.amount, currency)}</strong>;
}

/**
 * List + version chosen for VIEWING only (component state; never saved on the card, never assigned
 * to an event, never written to a price list). The list comes from the card's own classification;
 * only the version is a free choice.
 */
function useVersionSelection(choice: CardListChoice | undefined, versions: readonly PriceListVersion[]) {
  const [listId, setListId] = useState<string | undefined>();
  const [versionId, setVersionId] = useState<string | undefined>();
  useEffect(() => {
    if (!choice || choice.lists.length === 0) return;
    if (listId && choice.lists.some((list) => list.id === listId)) return;
    const first = choice.lists[0]!;
    setListId(first.id);
    setVersionId(defaultCardVersion(versions, first.id)?.id);
  }, [choice, versions, listId]);
  const listVersions = useMemo(() => versions.filter((version) => version.priceListId === listId).slice().sort((a, b) => b.versionNo - a.versionNo), [versions, listId]);
  return {
    list: choice?.lists.find((list) => list.id === listId),
    listId,
    version: listVersions.find((candidate) => candidate.id === versionId),
    versions: listVersions,
    selectList: (id: string) => { setListId(id); setVersionId(defaultCardVersion(versions, id)?.id); },
    select: (id: string, version: string) => { setListId(id); setVersionId(version); },
    selectVersion: setVersionId,
  };
}

/** Fixed source (one list of the right kind) or a picker limited to lists of that kind. */
function ListSource({ choice, listId, onSelect, label, sourceLabel }: { choice: CardListChoice; listId: string | undefined; onSelect: (id: string) => void; label: string; sourceLabel?: string }) {
  if (choice.locked) {
    const list = choice.lists[0];
    const name = list ? `${list.name}${list.isActive ? "" : " — neaktivní"}` : "—";
    return (
      <span className="catalogCardFixedSource" title={sourceLabel ? `Název ceníku v databázi: ${name} (spravuje se v Ceníky (verze) → Nákupní ceník → Upravit ceník)` : "Určeno cenovou kategorií komponenty — nelze přepnout na nesouvisející ceník."}>
        <span aria-hidden="true">🔒</span> {sourceLabel ?? name}
        {sourceLabel && list && <small className="fieldHint"> · {list.name}</small>}
      </span>
    );
  }
  return (
    <select aria-label={label} value={listId ?? ""} onChange={(event) => onSelect(event.target.value)}>
      {choice.lists.map((list) => <option key={list.id} value={list.id}>{list.name} ({list.code}){list.isActive ? "" : " — neaktivní"}</option>)}
    </select>
  );
}

/**
 * Katalogová karta → Ceny. Read-only overview of the card's prices. The sale price list is decided
 * by the card's pricing classification (price_category: electricity → electricity list, otherwise
 * the base sale list); only its version is chosen here, directly or as "the version assigned to an
 * event". The shared purchase price list is a fixed source with its own, independent version choice.
 * Prices are edited only in Administrace → Ceníky (verze); the old base prices stay as history.
 */
export function CatalogCardPrices({
  refreshKey,
  catalogItemId,
  itemFilter,
  legacy,
  onOpenPriceVersion,
  onOpenLegacyPricing,
}: {
  /** Changes when the card is saved (e.g. a new service type → price category): reloads the price classification. */
  refreshKey?: string;
  catalogItemId: string;
  /** Code (or name) the price list editor is filtered to when opened from here. */
  itemFilter: string;
  legacy: Readonly<{ czk: number | null; eur: number | null }>;
  onOpenPriceVersion?: (preselect: PriceVersionsPreselect) => void;
  onOpenLegacyPricing: () => void;
}) {
  const saleApi = useMemo(() => salePriceVersionsApi(), []);
  const purchaseApi = useMemo(() => purchasePriceVersionsApi(), []);
  const [sale, setSale] = useState<SaleSource | undefined>();
  const [purchase, setPurchase] = useState<PurchaseSource | undefined>();
  const [saleError, setSaleError] = useState("");
  const [purchaseError, setPurchaseError] = useState("");
  const [saleRows, setSaleRows] = useState<Readonly<Record<string, readonly SalePriceEntry[]>>>({});
  const [purchaseRows, setPurchaseRows] = useState<Readonly<Record<string, readonly PurchasePriceEntry[]>>>({});
  const [eventId, setEventId] = useState("");
  const [eventResults, setEventResults] = useState<Readonly<Partial<Record<PriceTrack, VersionedPriceResult>>> | undefined>();
  const [eventError, setEventError] = useState("");

  useEffect(() => {
    let cancelled = false;
    saleApi.load().then((register) => { if (!cancelled) setSale({ lists: register.lists, versions: register.versions, items: register.items, events: register.events, assignments: register.assignments }); }).catch((error) => { if (!cancelled) setSaleError(error instanceof Error ? error.message : "Prodejní ceníky se nepodařilo načíst."); });
    purchaseApi.load().then((register) => { if (!cancelled) setPurchase({ lists: register.lists, versions: register.versions }); }).catch((error) => { if (!cancelled) setPurchaseError(error instanceof Error ? error.message : "Nákupní ceník se nepodařilo načíst."); });
    return () => { cancelled = true; };
  }, [saleApi, purchaseApi, refreshKey]);

  const priceCategory = sale?.items.find((item) => item.id === catalogItemId)?.priceCategory;
  const saleChoice = useMemo(() => (sale ? cardSaleListChoice(priceCategory, sale.lists) : undefined), [sale, priceCategory]);
  const purchaseChoice = useMemo(() => (purchase ? cardPurchaseListChoice(purchase.lists) : undefined), [purchase]);
  const saleSelection = useVersionSelection(saleChoice, sale?.versions ?? []);
  const purchaseSelection = useVersionSelection(purchaseChoice, purchase?.versions ?? []);
  const saleVersion = saleSelection.version;
  const purchaseVersion = purchaseSelection.version;

  useEffect(() => {
    if (!saleVersion || saleRows[saleVersion.id]) return;
    let cancelled = false;
    saleApi.loadRows(saleVersion.id).then((rows) => { if (!cancelled) setSaleRows((current) => ({ ...current, [saleVersion.id]: rows.entries })); }).catch((error) => { if (!cancelled) setSaleError(error instanceof Error ? error.message : "Řádky ceníku se nepodařilo načíst."); });
    return () => { cancelled = true; };
  }, [saleApi, saleVersion, saleRows]);

  useEffect(() => {
    if (!purchaseVersion || purchaseRows[purchaseVersion.id]) return;
    let cancelled = false;
    purchaseApi.loadRows(purchaseVersion.id).then((rows) => { if (!cancelled) setPurchaseRows((current) => ({ ...current, [purchaseVersion.id]: rows.entries })); }).catch((error) => { if (!cancelled) setPurchaseError(error instanceof Error ? error.message : "Nákupní ceny se nepodařilo načíst."); });
    return () => { cancelled = true; };
  }, [purchaseApi, purchaseVersion, purchaseRows]);

  const salePrices = saleVersion && saleRows[saleVersion.id] ? cardSalePrices(saleVersion, saleRows[saleVersion.id]!, catalogItemId) : undefined;
  const purchasePrice = purchaseVersion && purchaseRows[purchaseVersion.id] ? cardPurchasePrice(purchaseVersion, purchaseRows[purchaseVersion.id]!, catalogItemId) : undefined;

  /**
   * "Cena podle veletrhu": the price exactly as the approved V1-DATA-05 resolver gives it for the
   * event's CURRENT assignments (/api/price-versions/resolve — read only). For an electricity
   * service that includes the approved fallback to the event's base price list when the event has
   * no electricity list or the item is not in it; the source of every price is shown.
   */
  useEffect(() => {
    setEventResults(undefined);
    setEventError("");
    if (!eventId) return;
    let cancelled = false;
    Promise.all(PRICE_TRACKS.map((priceTrack) => saleApi.resolve({ priceTrack, eventId, items: [{ catalogItemId }] }).then((response) => [priceTrack, response.results[0]?.result] as const)))
      .then((entries) => { if (!cancelled) setEventResults(Object.fromEntries(entries.filter(([, result]) => result))); })
      .catch((error) => { if (!cancelled) setEventError(error instanceof Error ? error.message : "Cenu pro veletrh se nepodařilo zjistit."); });
    return () => { cancelled = true; };
  }, [saleApi, eventId, catalogItemId, refreshKey]);

  const eventOrigin = eventResults ? PRICE_TRACKS.map((track) => eventResults[track]?.origin).find(Boolean) : undefined;
  const eventOriginList = eventOrigin ? sale?.lists.find((list) => list.id === eventOrigin.listId) : undefined;
  const eventFallbackToBase = Boolean(eventOrigin && saleChoice?.kind === "electricity" && eventOrigin.listKind === "base");

  function openButton(tab: "sale" | "purchase", listId: string | undefined, version: PriceListVersion | undefined) {
    if (!onOpenPriceVersion || !listId) return null;
    const editable = version?.status === "draft";
    return (
      <button type="button" className="smallUploadButton" onClick={() => onOpenPriceVersion({ tab, listId, ...(version ? { versionId: version.id } : {}), itemFilter })}>
        {editable ? "Upravit cenu v ceníku" : "Otevřít v ceníku"}
      </button>
    );
  }

  const kindLabel = saleChoice ? PRICE_LIST_KIND_LABELS_CS[saleChoice.kind] : "Prodejní ceník";
  const activeEvents = (sale?.events ?? []).filter((event) => event.active);

  return (
    <section className="catalogDetailSection catalogCardPrices">
      <h3>Ceny</h3>
      <p className="fieldHint">Všechny ceny jsou bez DPH. Zdrojem cen jsou verzované ceníky — výběr verze slouží jen k prohlížení a nic neukládá (kartu, ceník, veletrh ani projekt nemění).</p>

      <div className="catalogCardPriceBlock">
        <h4>Prodejní ceny <span className="fieldHint">· {kindLabel}{priceCategory === "electricity" ? " (cenová kategorie Elektřina)" : priceCategory ? " (cenová kategorie Standardní)" : ""}</span></h4>
        {saleError && <p className="uploadError">{saleError}</p>}
        {!sale && !saleError && <p className="fieldHint">Načítám…</p>}
        {saleChoice?.warning && <p className="uploadError">{saleChoice.warning}</p>}
        {saleChoice && saleChoice.lists.length > 0 && (
          <div className="catalogCardPricePickers">
            <ListSource choice={saleChoice} listId={saleSelection.listId} onSelect={saleSelection.selectList} label="Prodejní ceník" />
            <select aria-label="Verze prodejního ceníku" value={saleVersion?.id ?? ""} onChange={(event) => saleSelection.selectVersion(event.target.value)} disabled={saleSelection.versions.length === 0}>
              {saleSelection.versions.length === 0 && <option value="">Ceník nemá žádnou verzi</option>}
              {saleSelection.versions.map((version) => <option key={version.id} value={version.id}>{versionOptionLabel(version)}</option>)}
            </select>
          </div>
        )}
        {saleVersion && (
          <dl>
            <div><dt>Prodejní cena CZK</dt><dd>{salePrices ? <CellValue cell={salePrices.czk} currency="CZK" /> : "…"}</dd></div>
            <div>
              <dt>Prodejní cena EUR SK</dt>
              <dd>
                {salePrices ? <CellValue cell={salePrices.eurSk} currency="EUR" /> : "…"}
                {salePrices?.eurSk.status === "priced" && (
                  <small className="fieldHint">
                    {salePrices.eurSk.source === "manual"
                      ? ` ruční cena v ceníku · přepočet kurzem ${saleVersion.eurRate.toLocaleString("cs-CZ")} by dal ${formatAmount(salePrices.eurSk.derivedAmount, "EUR")}`
                      : ` přepočet z CZK kurzem ${saleVersion.eurRate.toLocaleString("cs-CZ")} · zaokrouhlení ${EUR_ROUNDING_MODE_LABELS_CS[saleVersion.eurRoundingMode].toLowerCase()} na ${saleVersion.eurRoundingStep.toLocaleString("cs-CZ")} €`}
                  </small>
                )}
              </dd>
            </div>
            <div><dt>Prodejní cena EUR WORLD</dt><dd>{salePrices ? <CellValue cell={salePrices.eurWorld} currency="EUR" /> : "…"}</dd></div>
          </dl>
        )}
        {salePrices && !salePrices.hasEntry && <p className="fieldHint">Komponenta v této verzi ceníku nemá řádek.</p>}
        <div className="assetActions">
          {openButton("sale", saleSelection.listId, saleVersion)}
          {saleVersion && saleVersion.status !== "draft" && <span className="fieldHint">Verze je {saleVersion.status === "published" ? "publikovaná" : "archivovaná"} a neměnná — v ceníku ji lze jen prohlížet; změna ceny = nová verze (v ceníku „Kopírovat do nové verze“).</span>}
        </div>
        {saleChoice && saleChoice.lists.length > 0 && activeEvents.length > 0 && (
          <div className="catalogCardEventContext">
            <label>
              Cena podle veletrhu
              <select value={eventId} onChange={(event) => setEventId(event.target.value)}>
                <option value="">— zvolit veletrh (jen náhled) —</option>
                {activeEvents.map((event) => <option key={event.id} value={event.id}>{event.name}{event.year ? ` ${event.year}` : ""}</option>)}
              </select>
            </label>
            {eventError && <small className="uploadError">{eventError}</small>}
            {eventId && !eventResults && !eventError && <small className="fieldHint">Načítám…</small>}
            {eventResults && (
              <>
                <dl>
                  {PRICE_TRACKS.map((track) => {
                    const result = eventResults[track];
                    return (
                      <div key={track}>
                        <dt>{track === "CZK" ? "CZK" : track === "EUR_SK" ? "EUR SK" : "EUR WORLD"}</dt>
                        <dd>
                          {!result || result.status === "missing" ? <strong className="pricingMissing">K nacenění</strong> : result.status === "individual" ? <strong>Individuálně</strong> : result.status === "included" ? <strong>V ceně</strong> : <strong>{formatAmount(result.amountNet, result.currency)}</strong>}
                          {result?.status === "missing" && result.missingReason && <small className="fieldHint"> {MISSING_REASON_LABELS_CS[result.missingReason]}</small>}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
                {eventOrigin && <small className="fieldHint">Zdroj: {eventOriginList?.name ?? eventOrigin.listCode} · v{eventOrigin.versionNo} (verze přiřazená veletrhu).</small>}
                {eventFallbackToBase && <small className="fieldWarning">Veletrh nemá ceník elektřiny, nebo v něm služba chybí — podle schváleného pravidla V1-DATA-05 se cena bere ze základního ceníku veletrhu.</small>}
              </>
            )}
          </div>
        )}
      </div>

      <div className="catalogCardPriceBlock">
        <h4>Nákupní cena (interní)</h4>
        <p className="fieldHint">Společný nákupní ceník pro realizační firmy, ABF a ostatní dodavatele. Nákupní cena není povinná.</p>
        {purchaseError && <p className="uploadError">{purchaseError}</p>}
        {!purchase && !purchaseError && <p className="fieldHint">Načítám…</p>}
        {purchaseChoice?.warning && <p className="fieldHint">{purchaseChoice.warning}</p>}
        {purchaseChoice && purchaseChoice.lists.length > 0 && (
          <div className="catalogCardPricePickers">
            <ListSource choice={purchaseChoice} listId={purchaseSelection.listId} onSelect={purchaseSelection.selectList} label="Nákupní ceník" sourceLabel="Společný nákupní ceník" />
            <select aria-label="Verze nákupního ceníku" value={purchaseVersion?.id ?? ""} onChange={(event) => purchaseSelection.selectVersion(event.target.value)} disabled={purchaseSelection.versions.length === 0}>
              {purchaseSelection.versions.length === 0 && <option value="">Ceník nemá žádnou verzi</option>}
              {purchaseSelection.versions.map((version) => <option key={version.id} value={version.id}>{versionOptionLabel(version)}</option>)}
            </select>
          </div>
        )}
        {purchaseVersion && (
          <dl>
            <div>
              <dt>Nákupní cena CZK</dt>
              <dd>
                {/* Not mandatory: missing = "Nezadáno" (unknown), never 0 Kč; an explicit 0 stays 0 Kč. */}
                {purchasePrice ? (purchasePrice.status === "priced" ? <strong>{formatAmount(purchasePrice.amount, "CZK")}</strong> : <strong className="purchaseNotEntered">Nezadáno</strong>) : "…"}
                {purchasePrice && purchasePrice.variantRowCount > 0 && <small className="fieldHint"> + {purchasePrice.variantRowCount} cen pro varianty (v ceníku)</small>}
              </dd>
            </div>
          </dl>
        )}
        <div className="assetActions">{openButton("purchase", purchaseSelection.listId, purchaseVersion)}</div>
      </div>

      <details className="catalogCardLegacyPrices">
        <summary>Historické ceny starého generátoru</summary>
        <p className="fieldHint">Údaje z doby před verzovanými ceníky. Zůstávají uložené kvůli kompatibilitě starého výpočtu, nejsou to aktuální ceny.</p>
        <dl>
          <div><dt>Base cena CZK</dt><dd>{legacy.czk !== null ? `${legacy.czk.toLocaleString("cs-CZ")} Kč` : "není nastavena"}</dd></div>
          <div><dt>Base cena EUR</dt><dd>{legacy.eur !== null ? `${legacy.eur.toLocaleString("cs-CZ")} €` : "není nastavena"}</dd></div>
        </dl>
        <button type="button" className="linkButton" onClick={onOpenLegacyPricing}>Otevřít starou správu cen</button>
      </details>
    </section>
  );
}
