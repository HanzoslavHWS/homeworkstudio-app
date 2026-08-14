import { useEffect, useMemo, useState } from "react";
import type { Currency, PricingEntryMode } from "../../domain/models";
import type { Exhibition, PriceList, RealizationCompany } from "../../domain/organizations";
import type { CatalogItemSummary } from "../../domain/catalogPricing";
import {
  buildBulkEdits,
  buildPricingEditPreview,
  filterPriceListsForAdmin,
  resolvedSalePriceForEdit,
  validateNewPriceListCode,
  type BulkPriceChange,
  type DuplicatePriceListDraft,
  type PricingEntryAdmin,
  type PricingEntryEdit,
  type PricingEntrySaveSummary,
  type PricingEntrySource,
  type PricingFilters,
  type PricingPreviewRow,
} from "../../domain/pricingAdmin";
import type { DuplicatePriceListResponse, RemoteApiPricingAdminRepository } from "../../lib/db/pricingAdmin.remoteApi.client";

const PRICE_MODE_LABELS: Record<PricingEntryMode, string> = {
  fixed: "Fixed",
  individual: "Individual",
  included: "Included",
};

function priceModeLabel(mode: PricingEntryMode): string {
  return PRICE_MODE_LABELS[mode];
}

function formatMoney(value: number | undefined, currency: Currency): string {
  return value === undefined ? "—" : `${value.toLocaleString("cs-CZ")} ${currency}`;
}

function catalogItemLabel(item: CatalogItemSummary | undefined, fallbackId: string): string {
  return item ? `${item.internalCode ?? "—"} · ${item.displayName}` : fallbackId;
}

function priceListLabel(list: PriceList | undefined, fallbackId: string): string {
  return list ? list.name : fallbackId;
}

export function eventIdForPriceList(priceList: PriceList, events: readonly Exhibition[]): string {
  if (priceList.eventId) return priceList.eventId;
  return events.find((event) => event.priceListIds.includes(priceList.id))?.id ?? "";
}

/** Section 6: decent, non-alarming — "Ručně upraveno" is a fact, not a warning. */
function SourceBadge({ source }: { source: PricingEntrySource }) {
  return <span className={`pricingSourceBadge ${source}`}>{source === "manual" ? "Ručně upraveno" : "Import"}</span>;
}

function SaveSummaryBanner({ summary, saving }: { summary: PricingEntrySaveSummary | null; saving: boolean }) {
  if (saving) return <span>Ukládám…</span>;
  if (!summary) return <span>Beze změn</span>;
  if (summary.failedCount === 0) return <span className="saveOk">Uloženo ({summary.succeededCount})</span>;
  return (
    <span className="saveError">
      Uloženo {summary.succeededCount}/{summary.results.length}, {summary.failedCount} selhalo: {summary.results.filter((result) => result.status === "error").map((result) => result.message).join("; ")}
    </span>
  );
}

/* ================================================================================= */
/* PRICE LIST DETAIL — real pricing_entries table + inline edit (section 2/3)        */
/* ================================================================================= */

export function PriceListPricingTable({
  priceList,
  entries,
  catalogItems,
  loading,
  onSaveEdits,
  onOpenDuplicate,
}: {
  priceList: PriceList;
  entries: readonly PricingEntryAdmin[];
  catalogItems: readonly CatalogItemSummary[];
  loading: boolean;
  onSaveEdits: (edits: readonly PricingEntryEdit[]) => Promise<PricingEntrySaveSummary>;
  onOpenDuplicate: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, { priceMode: PricingEntryMode; salePrice?: number }>>({});
  const [saving, setSaving] = useState(false);
  const [summary, setSummary] = useState<PricingEntrySaveSummary | null>(null);

  function draftFor(entry: PricingEntryAdmin) {
    return drafts[entry.id] ?? { priceMode: entry.priceMode, salePrice: entry.salePrice };
  }

  function updateDraft(entry: PricingEntryAdmin, patch: Partial<{ priceMode: PricingEntryMode; salePrice?: number }>) {
    setDrafts((current) => ({ ...current, [entry.id]: { ...draftFor(entry), ...patch } }));
    setSummary(null);
  }

  const dirtyEntries = entries.filter((entry) => {
    const draft = drafts[entry.id];
    return draft && (draft.priceMode !== entry.priceMode || draft.salePrice !== entry.salePrice);
  });

  async function saveChanges() {
    setSaving(true);
    const edits: PricingEntryEdit[] = dirtyEntries.map((entry) => ({
      catalogItemId: entry.catalogItemId,
      priceListId: entry.priceListId,
      eventId: entry.eventId,
      currency: entry.currency,
      priceMode: draftFor(entry).priceMode,
      salePrice: draftFor(entry).salePrice,
    }));
    try {
      const result = await onSaveEdits(edits);
      setSummary(result);
      const succeededIds = new Set(result.results.filter((row) => row.status === "ok").map((row) => `${row.catalogItemId}::${row.priceListId}`));
      setDrafts((current) => {
        const next = { ...current };
        for (const entry of dirtyEntries) {
          if (succeededIds.has(`${entry.catalogItemId}::${entry.priceListId}`)) delete next[entry.id];
        }
        return next;
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="pricingPriceListDetail">
      <div className="pricingSaveBar">
        <SaveSummaryBanner summary={summary} saving={saving} />
        <div style={{ display: "flex", gap: 10 }}>
          <button type="button" onClick={onOpenDuplicate}>Duplikovat ceník</button>
          <button type="button" className="primaryButton" onClick={() => void saveChanges()} disabled={dirtyEntries.length === 0 || saving}>Uložit změny{dirtyEntries.length > 0 ? ` (${dirtyEntries.length})` : ""}</button>
        </div>
      </div>
      {loading ? (
        <p className="workspaceEmpty">Načítám ceny…</p>
      ) : entries.length === 0 ? (
        <p className="workspaceEmpty">Tento ceník zatím nemá žádné cenové položky v databázi.</p>
      ) : (
        <table className="pricingEntriesTable">
          <thead>
            <tr><th>Kód</th><th>Položka</th><th>Jednotka</th><th>Původní cena</th><th>Aktuální cena</th><th>Price mode</th><th>Stav</th><th>Poslední změna</th></tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const item = catalogItems.find((candidate) => candidate.id === entry.catalogItemId);
              const draft = draftFor(entry);
              const dirty = drafts[entry.id] !== undefined && (draft.priceMode !== entry.priceMode || draft.salePrice !== entry.salePrice);
              return (
                <tr key={entry.id}>
                  <td>{item?.internalCode ?? "—"}</td>
                  <td>{item?.displayName ?? entry.catalogItemId}</td>
                  <td>{item?.unit ?? "—"}</td>
                  <td className="pricingCellStatic">{entry.sourcePrice !== undefined ? formatMoney(entry.sourcePrice, entry.currency) : "—"}</td>
                  <td>
                    {draft.priceMode === "fixed" ? (
                      <div className={`pricingCell ${dirty ? "pricingCellDirty" : ""}`}>
                        <input type="number" value={draft.salePrice ?? ""} onChange={(event) => updateDraft(entry, { salePrice: event.target.value === "" ? undefined : Number(event.target.value) })} placeholder="Cena není nastavena" />
                      </div>
                    ) : (
                      <span className="pricingCellStatic">{draft.priceMode === "included" ? "V ceně" : "Individuální"}</span>
                    )}
                  </td>
                  <td>
                    <select value={draft.priceMode} onChange={(event) => updateDraft(entry, { priceMode: event.target.value as PricingEntryMode })}>
                      <option value="fixed">Fixed</option>
                      <option value="individual">Individual</option>
                      <option value="included">Included</option>
                    </select>
                  </td>
                  <td><SourceBadge source={dirty ? "manual" : entry.source} /></td>
                  <td>{entry.updatedAt ? new Date(entry.updatedAt).toLocaleDateString("cs-CZ") : entry.createdAt ? new Date(entry.createdAt).toLocaleDateString("cs-CZ") : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="pricingAdminNotice">Katalogové položky, které v tomto ceníku ještě nemají cenu, se zde nezobrazují jako prázdné řádky — pro přidání nové ceny použijte Správa cen → Pricing Matrix pro danou položku a ceník {priceList.code}.</p>
    </section>
  );
}

/* ================================================================================= */
/* DUPLICATE PRICE LIST DIALOG (section 10/11/12)                                    */
/* ================================================================================= */

export function DuplicatePriceListDialog({
  sourcePriceList,
  sourceEntries,
  existingCodes,
  events,
  realizationCompanies,
  onConfirm,
  onClose,
}: {
  sourcePriceList: PriceList;
  sourceEntries: readonly PricingEntryAdmin[];
  existingCodes: readonly string[];
  events: readonly Exhibition[];
  realizationCompanies: readonly RealizationCompany[];
  onConfirm: (draft: DuplicatePriceListDraft) => Promise<DuplicatePriceListResponse>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<DuplicatePriceListDraft>({
    name: `${sourcePriceList.name} (kopie)`,
    code: `${sourcePriceList.code}-COPY`,
    year: sourcePriceList.year,
    edition: sourcePriceList.edition,
    eventId: sourcePriceList.eventId,
    currency: sourcePriceList.currency,
    realizationCompanyId: sourcePriceList.realizationCompanyId,
    validFrom: sourcePriceList.validFrom,
    validTo: sourcePriceList.validTo,
    active: true,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<DuplicatePriceListResponse | null>(null);

  const codeValidation = validateNewPriceListCode(existingCodes, draft.code);
  let codeIsValid = true;
  let codeErrorReason: string | undefined;
  if (codeValidation.ok === false) {
    codeIsValid = false;
    codeErrorReason = codeValidation.reason;
  }
  const willCopyCount = sourceEntries.filter((entry) => entry.currency === draft.currency || entry.priceMode !== "fixed").length;
  const willSkipCount = sourceEntries.length - willCopyCount;

  async function submit() {
    if (!codeIsValid) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await onConfirm(draft);
      setResult(response);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Duplikace ceníku selhala.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="adminModalOverlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="adminModalCard" onClick={(event) => event.stopPropagation()}>
        {result ? (
          <>
            <h2>Ceník zduplikován</h2>
            <p>Nový ceník <strong>{result.priceList.name}</strong> ({result.priceList.code}) byl vytvořen.</p>
            <p>Zkopírováno {result.copiedCount} cenových položek{result.skippedCount > 0 ? `, ${result.skippedCount} přeskočeno (jiná měna, fixní cenu nelze bezpečně zkopírovat)` : ""}.</p>
            {result.entriesError && <div className="adminModalError">{result.entriesError}</div>}
            {result.linkWarning && <div className="adminModalError">{result.linkWarning}</div>}
            <div className="adminModalActions"><button type="button" className="primaryButton" onClick={onClose}>Zavřít</button></div>
          </>
        ) : (
          <>
            <h2>Duplikovat ceník</h2>
            <p>Zdroj: {sourcePriceList.name} ({sourcePriceList.code}) — {sourceEntries.length} cenových položek.</p>
            <label><span>Nový název</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
            <div className="threeColumns">
              <label><span>Nový kód</span><input value={draft.code} onChange={(event) => setDraft({ ...draft, code: event.target.value })} /></label>
              <label><span>Rok</span><input type="number" value={draft.year} onChange={(event) => setDraft({ ...draft, year: Number(event.target.value) })} /></label>
              <label><span>Edice</span><input value={draft.edition ?? ""} onChange={(event) => setDraft({ ...draft, edition: event.target.value || undefined })} /></label>
            </div>
            <div className="twoColumns">
              <label><span>Event</span><select value={draft.eventId ?? ""} onChange={(event) => setDraft({ ...draft, eventId: event.target.value || undefined })}><option value="">Bez eventu</option>{events.map((event) => <option key={event.id} value={event.id}>{event.name}</option>)}</select></label>
              <label><span>Měna</span><select value={draft.currency} onChange={(event) => setDraft({ ...draft, currency: event.target.value as Currency })}><option value="CZK">CZK</option><option value="EUR">EUR</option></select></label>
            </div>
            <div className="twoColumns">
              <label><span>Platnost od</span><input type="date" value={draft.validFrom ?? ""} onChange={(event) => setDraft({ ...draft, validFrom: event.target.value || undefined })} /></label>
              <label><span>Platnost do</span><input type="date" value={draft.validTo ?? ""} onChange={(event) => setDraft({ ...draft, validTo: event.target.value || undefined })} /></label>
            </div>
            <label><span>Realizační společnost</span><select value={draft.realizationCompanyId ?? ""} onChange={(event) => setDraft({ ...draft, realizationCompanyId: event.target.value || undefined })}><option value="">Všechny</option>{realizationCompanies.filter((company) => company.active).map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label>
            <label className="checkLabel"><input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} /> Aktivní</label>
            <p><strong>Zkopíruje se {willCopyCount} cenových položek.</strong>{willSkipCount > 0 ? ` ${willSkipCount} se přeskočí (fixní cena v jiné měně by byla fabrikovaná).` : ""}</p>
            {!codeIsValid && <div className="adminModalError">{codeErrorReason}</div>}
            {error && <div className="adminModalError">{error}</div>}
            <div className="adminModalActions">
              <button type="button" onClick={onClose} disabled={submitting}>Zrušit</button>
              <button type="button" className="primaryButton" onClick={() => void submit()} disabled={submitting || !codeIsValid}>{submitting ? "Duplikuji…" : "Duplikovat ceník"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ================================================================================= */
/* SPRÁVA CEN — catalog picker + multi-select → Pricing Matrix (section 1/4/6/7)     */
/* ================================================================================= */

const EMPTY_FILTERS: PricingFilters = { year: "", eventIds: [], currency: "", priceListIds: [], priceMode: "" };

function PricingFiltersBar({ filters, onChange, priceLists, events }: { filters: PricingFilters; onChange: (filters: PricingFilters) => void; priceLists: readonly PriceList[]; events: readonly Exhibition[] }) {
  const years = [...new Set(priceLists.map((list) => list.year))].sort((a, b) => b - a);
  return (
    <div className="pricingFilters">
      <label><span>Rok</span><select value={filters.year} onChange={(event) => onChange({ ...filters, year: event.target.value })}><option value="">Vše</option>{years.map((year) => <option key={year} value={year}>{year}</option>)}</select></label>
      <label><span>Event</span><select multiple value={filters.eventIds} onChange={(event) => onChange({ ...filters, eventIds: [...event.target.selectedOptions].map((option) => option.value) })}>{events.map((event) => <option key={event.id} value={event.id}>{event.name}</option>)}</select></label>
      <label><span>Měna</span><select value={filters.currency} onChange={(event) => onChange({ ...filters, currency: event.target.value as PricingFilters["currency"] })}><option value="">Vše</option><option value="CZK">CZK</option><option value="EUR">EUR</option></select></label>
      <label><span>Ceník</span><select multiple value={filters.priceListIds} onChange={(event) => onChange({ ...filters, priceListIds: [...event.target.selectedOptions].map((option) => option.value) })}>{priceLists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}</select></label>
      <label><span>Price mode</span><select value={filters.priceMode} onChange={(event) => onChange({ ...filters, priceMode: event.target.value as PricingFilters["priceMode"] })}><option value="">Vše</option><option value="fixed">Fixed</option><option value="individual">Individual</option><option value="included">Included</option></select></label>
    </div>
  );
}

function BulkEditDialog({
  catalogItemIds,
  priceLists,
  events,
  catalogItems,
  entries,
  onApply,
  onClose,
}: {
  catalogItemIds: readonly string[];
  priceLists: readonly PriceList[];
  events: readonly Exhibition[];
  catalogItems: readonly CatalogItemSummary[];
  entries: readonly PricingEntryAdmin[];
  onApply: (edits: readonly PricingEntryEdit[]) => Promise<PricingEntrySaveSummary>;
  onClose: () => void;
}) {
  const currencies = [...new Set(priceLists.map((list) => list.currency))];
  const [priceMode, setPriceMode] = useState<PricingEntryMode>("fixed");
  const [salePriceByCurrency, setSalePriceByCurrency] = useState<Partial<Record<Currency, number>>>({});
  const [preview, setPreview] = useState<readonly PricingPreviewRow[] | null>(null);
  const [applying, setApplying] = useState(false);
  const [summary, setSummary] = useState<PricingEntrySaveSummary | null>(null);

  const change: BulkPriceChange = { priceMode, salePriceByCurrency };
  const targetPriceLists = priceLists.map((list) => ({ id: list.id, currency: list.currency, eventId: eventIdForPriceList(list, events) }));

  function showPreview() {
    const edits = buildBulkEdits(catalogItemIds, targetPriceLists, change);
    setPreview(buildPricingEditPreview(entries, edits, {
      catalogItem: (id) => catalogItemLabel(catalogItems.find((item) => item.id === id), id),
      priceList: (id) => priceListLabel(priceLists.find((list) => list.id === id), id),
    }));
  }

  async function confirm() {
    const edits = buildBulkEdits(catalogItemIds, targetPriceLists, change);
    setApplying(true);
    try {
      setSummary(await onApply(edits));
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="adminModalOverlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="adminModalCard" onClick={(event) => event.stopPropagation()}>
        <h2>Hromadná úprava cen</h2>
        <p>{catalogItemIds.length} komponent × {priceLists.length} ceníků vybraných v tabulce.</p>
        <label><span>Price mode</span><select value={priceMode} onChange={(event) => { setPriceMode(event.target.value as PricingEntryMode); setPreview(null); }}><option value="fixed">Fixed — nastavit cenu</option><option value="individual">Individual — bez pevné ceny</option><option value="included">Included — v ceně</option></select></label>
        {priceMode === "fixed" && (
          <div className="twoColumns">
            {currencies.map((currency) => (
              <label key={currency}><span>Cena {currency}</span><input type="number" value={salePriceByCurrency[currency] ?? ""} onChange={(event) => { setSalePriceByCurrency({ ...salePriceByCurrency, [currency]: event.target.value === "" ? undefined : Number(event.target.value) }); setPreview(null); }} placeholder={`Cena v ${currency} (ponechte prázdné pro přeskočení)`} /></label>
            ))}
          </div>
        )}
        {!summary && <div className="adminModalActions"><button type="button" onClick={onClose}>Zrušit</button><button type="button" onClick={showPreview}>Zobrazit náhled</button></div>}
        {preview && !summary && (
          <>
            <table className="pricingPreviewTable">
              <thead><tr><th>Položka</th><th>Ceník</th><th>Měna</th><th>Původní cena</th><th>Nová cena</th><th>Původní mode</th><th>Nový mode</th></tr></thead>
              <tbody>
                {preview.map((row) => (
                  <tr key={`${row.catalogItemId}::${row.priceListId}`}>
                    <td>{row.catalogItemLabel}</td>
                    <td>{row.priceListLabel}</td>
                    <td>{row.currency}</td>
                    <td>{row.before ? formatMoney(row.before.salePrice, row.currency) : <span className="pricingMissing">Missing</span>}</td>
                    <td>{formatMoney(row.after.salePrice, row.currency)}</td>
                    <td>{row.before ? priceModeLabel(row.before.priceMode) : "—"}</td>
                    <td>{priceModeLabel(row.after.priceMode)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.length === 0 && <p className="workspaceEmpty">Žádná buňka k úpravě — u Fixed zadejte alespoň jednu měnu.</p>}
            <div className="adminModalActions"><button type="button" onClick={onClose} disabled={applying}>Zrušit</button><button type="button" className="primaryButton" onClick={() => void confirm()} disabled={applying || preview.length === 0}>{applying ? "Ukládám…" : "Potvrdit a uložit"}</button></div>
          </>
        )}
        {summary && (
          <>
            <p><SaveSummaryBanner summary={summary} saving={false} /></p>
            <div className="adminModalActions"><button type="button" className="primaryButton" onClick={onClose}>Zavřít</button></div>
          </>
        )}
      </div>
    </div>
  );
}

function PricingMatrix({
  catalogItemIds,
  catalogItems,
  priceLists,
  events,
  entries,
  loading,
  onSaveEdits,
  onClose,
}: {
  catalogItemIds: readonly string[];
  catalogItems: readonly CatalogItemSummary[];
  priceLists: readonly PriceList[];
  events: readonly Exhibition[];
  entries: readonly PricingEntryAdmin[];
  loading: boolean;
  onSaveEdits: (edits: readonly PricingEntryEdit[]) => Promise<PricingEntrySaveSummary>;
  onClose: () => void;
}) {
  const [filters, setFilters] = useState<PricingFilters>(EMPTY_FILTERS);
  const [edited, setEdited] = useState<Map<string, PricingEntryEdit>>(new Map());
  const [saving, setSaving] = useState(false);
  const [summary, setSummary] = useState<PricingEntrySaveSummary | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);

  const columns = useMemo(() => {
    const list = filterPriceListsForAdmin(priceLists, events, filters);
    return filters.priceMode
      ? list.filter((priceList) => entries.some((entry) => entry.priceListId === priceList.id && entry.priceMode === filters.priceMode))
      : list;
  }, [priceLists, events, filters, entries]);

  function cellKey(catalogItemId: string, priceListId: string): string {
    return `${catalogItemId}::${priceListId}`;
  }

  function cellState(catalogItemId: string, priceList: PriceList) {
    const key = cellKey(catalogItemId, priceList.id);
    const pendingEdit = edited.get(key);
    const existing = entries.find((entry) => entry.catalogItemId === catalogItemId && entry.priceListId === priceList.id);
    const priceMode = pendingEdit?.priceMode ?? existing?.priceMode;
    const salePrice = pendingEdit ? resolvedSalePriceForEdit(pendingEdit) : existing?.salePrice;
    return {
      priceMode,
      salePrice,
      dirty: Boolean(pendingEdit),
      eventId: eventIdForPriceList(priceList, events),
      // Section 7: before→after — "original" always reflects the last SAVED state (entries),
      // never the in-progress local edit, so a dirty cell can show "bylo: X" beside the new
      // value the operator is currently typing.
      originalSalePrice: existing?.salePrice,
      originalPriceMode: existing?.priceMode,
      source: existing?.source,
    };
  }

  function updateCell(catalogItemId: string, priceList: PriceList, patch: Partial<{ priceMode: PricingEntryMode; salePrice?: number }>) {
    const key = cellKey(catalogItemId, priceList.id);
    const current = cellState(catalogItemId, priceList);
    const priceMode = patch.priceMode ?? current.priceMode ?? "fixed";
    const salePrice = "salePrice" in patch ? patch.salePrice : current.salePrice;
    setEdited((map) => new Map(map).set(key, { catalogItemId, priceListId: priceList.id, eventId: current.eventId, currency: priceList.currency, priceMode, salePrice }));
    setSummary(null);
  }

  async function saveChanges() {
    setSaving(true);
    const edits = [...edited.values()];
    try {
      const result = await onSaveEdits(edits);
      setSummary(result);
      const succeeded = new Set(result.results.filter((row) => row.status === "ok").map((row) => cellKey(row.catalogItemId, row.priceListId)));
      setEdited((map) => new Map([...map].filter(([key]) => !succeeded.has(key))));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="pricingMatrixSection">
      <div className="workspacePageHeader"><div><span className="eyebrow">SPRÁVA CEN</span><h1>Pricing Matrix</h1></div><button type="button" onClick={onClose}>← Zpět na výběr komponent</button></div>
      <PricingFiltersBar filters={filters} onChange={setFilters} priceLists={priceLists} events={events} />
      <div className="pricingSaveBar">
        <SaveSummaryBanner summary={summary} saving={saving} />
        <div style={{ display: "flex", gap: 10 }}>
          <button type="button" onClick={() => setBulkOpen(true)} disabled={columns.length === 0}>Hromadná úprava…</button>
          <button type="button" className="primaryButton" onClick={() => void saveChanges()} disabled={edited.size === 0 || saving}>Uložit změny{edited.size > 0 ? ` (${edited.size})` : ""}</button>
        </div>
      </div>
      {loading ? (
        <p className="workspaceEmpty">Načítám ceny…</p>
      ) : columns.length === 0 ? (
        <p className="workspaceEmpty">Filtrům neodpovídá žádný ceník. Upravte filtry nahoře.</p>
      ) : (
        <div className="pricingMatrixTable">
          <table>
            <thead>
              <tr>
                <th className="pricingMatrixRowLabel">Komponenta</th>
                {columns.map((list) => <th key={list.id}>{list.name}<br /><small>{list.currency}</small></th>)}
              </tr>
            </thead>
            <tbody>
              {catalogItemIds.map((catalogItemId) => {
                const item = catalogItems.find((candidate) => candidate.id === catalogItemId);
                return (
                  <tr key={catalogItemId}>
                    <td className="pricingMatrixRowLabel"><strong>{item?.internalCode ?? catalogItemId}</strong><span>{item?.displayName}</span></td>
                    {columns.map((priceList) => {
                      const cell = cellState(catalogItemId, priceList);
                      const disabled = !cell.eventId;
                      const beforeLabel = cell.originalSalePrice !== undefined ? formatMoney(cell.originalSalePrice, priceList.currency) : cell.originalPriceMode ? priceModeLabel(cell.originalPriceMode) : "Missing";
                      const tooltip = cell.source ? `Bylo: ${beforeLabel} (${cell.source === "manual" ? "ručně upraveno" : "import"})` : "Bylo: Missing";
                      return (
                        <td key={priceList.id}>
                          <div className={`pricingCell ${cell.dirty ? "pricingCellDirty" : ""} ${disabled ? "pricingCellDisabled" : ""}`} title={tooltip}>
                            {disabled ? (
                              <span className="pricingCellStatic" title="Ceník není přiřazen k žádnému eventu — nelze upravit.">nelze upravit</span>
                            ) : (
                              <>
                                {cell.source && <span className={`pricingSourceDot ${cell.source}`} aria-hidden="true" />}
                                <div className="pricingCellInputs">
                                  <select value={cell.priceMode ?? "fixed"} onChange={(event) => updateCell(catalogItemId, priceList, { priceMode: event.target.value as PricingEntryMode })}>
                                    <option value="fixed">Fixed</option>
                                    <option value="individual">Individual</option>
                                    <option value="included">Included</option>
                                  </select>
                                  {(cell.priceMode ?? "fixed") === "fixed" && (
                                    <input type="number" value={cell.salePrice ?? ""} onChange={(event) => updateCell(catalogItemId, priceList, { salePrice: event.target.value === "" ? undefined : Number(event.target.value) })} placeholder="—" />
                                  )}
                                  {cell.dirty && <small className="pricingCellBefore">bylo: {beforeLabel}</small>}
                                </div>
                              </>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {bulkOpen && (
        <BulkEditDialog
          catalogItemIds={catalogItemIds}
          priceLists={columns}
          events={events}
          catalogItems={catalogItems}
          entries={entries}
          onApply={onSaveEdits}
          onClose={() => setBulkOpen(false)}
        />
      )}
    </section>
  );
}

export function PricingAdminPage({
  catalogItems,
  priceLists,
  events,
  repository,
  initialCatalogItemId,
}: {
  catalogItems: readonly CatalogItemSummary[];
  priceLists: readonly PriceList[];
  events: readonly Exhibition[];
  repository: RemoteApiPricingAdminRepository;
  /** Section 17 — preselects the matrix for one item when navigated here from Component Administration's "Upravit ceny" action, instead of the normal checkbox multi-select flow. */
  initialCatalogItemId?: string;
}) {
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [matrixItemIds, setMatrixItemIds] = useState<readonly string[] | null>(null);
  const [entries, setEntries] = useState<readonly PricingEntryAdmin[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (initialCatalogItemId) void openMatrix([initialCatalogItemId]);
    // Deliberately only re-runs when the preselected id itself changes — openMatrix is stable
    // enough for this one-shot "arrived from elsewhere" trigger, matching the established
    // effect-driven fetch pattern elsewhere in this file (openMatrix/toggleSelected closures).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCatalogItemId]);

  const filteredItems = catalogItems.filter((item) => `${item.internalCode ?? ""} ${item.displayName} ${item.category ?? ""}`.toLocaleLowerCase("cs").includes(query.toLocaleLowerCase("cs")));

  function toggleSelected(id: string) {
    setSelectedIds((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]);
  }

  async function openMatrix(ids: readonly string[]) {
    setMatrixItemIds(ids);
    setLoading(true);
    try {
      setEntries(await repository.listEntries({ catalogItemIds: ids }));
    } finally {
      setLoading(false);
    }
  }

  async function saveEdits(edits: readonly PricingEntryEdit[]): Promise<PricingEntrySaveSummary> {
    const summary = await repository.saveEntries(edits);
    if (matrixItemIds) setEntries(await repository.listEntries({ catalogItemIds: matrixItemIds }));
    return summary;
  }

  if (matrixItemIds) {
    return (
      <div className="workspacePage">
        <PricingMatrix
          catalogItemIds={matrixItemIds}
          catalogItems={catalogItems}
          priceLists={priceLists}
          events={events}
          entries={entries}
          loading={loading}
          onSaveEdits={saveEdits}
          onClose={() => setMatrixItemIds(null)}
        />
      </div>
    );
  }

  return (
    <div className="workspacePage">
      <div className="workspacePageHeader"><div><span className="eyebrow">POKROČILÁ ADMINISTRACE</span><h1>Správa cen</h1></div></div>
      <p className="pricingAdminNotice">Toto je pokročilá administrace cen napříč ceníky — odděleně od běžného generátoru projektu, aby se omezilo riziko nechtěné hromadné změny cen.</p>
      <div className="adminFilters"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Hledat kód, název nebo kategorii…" /></div>
      <div className="pricingCatalogList">
        {filteredItems.map((item) => (
          <div className="pricingCatalogRow" key={item.id}>
            <input type="checkbox" checked={selectedIds.includes(item.id)} onChange={() => toggleSelected(item.id)} aria-label={`Vybrat ${item.displayName}`} />
            <div><strong>{item.internalCode ?? "—"}</strong> {item.displayName}</div>
            <span>{item.kind}</span>
            <span>{item.lifecycleStatus}</span>
            <button type="button" onClick={() => void openMatrix([item.id])}>Upravit ceny</button>
          </div>
        ))}
        {filteredItems.length === 0 && <p className="workspaceEmpty">Hledání neodpovídá žádná katalogová položka.</p>}
      </div>
      {selectedIds.length > 0 && (
        <div className="pricingSelectionBar">
          <span>{selectedIds.length} vybraných položek</span>
          <button type="button" className="primaryButton" onClick={() => void openMatrix(selectedIds)}>Upravit ceny vybraných</button>
        </div>
      )}
    </div>
  );
}
