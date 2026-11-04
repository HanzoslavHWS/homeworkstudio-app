"use client";

import { useEffect, useMemo, useState } from "react";
import type { KitLineSelection } from "../../../domain/catalogKitPricing";
import {
  convertCzkToEur,
  currentEventAssignment,
  EUR_MODE_LABELS_CS,
  EUR_SK_MODES,
  eurWorldOf,
  PRICE_TRACK_LABELS_CS,
  PRICE_TRACKS,
  eventAssignmentHistory,
  eventsUsingVersion,
  MISSING_REASON_LABELS_CS,
  PRICE_CATEGORY_LABELS_CS,
  PRICE_LIST_KIND_LABELS_CS,
  SALE_PRICE_LIST_KINDS,
  SALE_PRICE_MODE_LABELS_CS,
  SALE_PRICE_MODES,
  surchargeKey,
  comparePriceItemsByCode,
  matchesPriceItemSearch,
  uncoveredTracks,
  coverageWarningText,
  type EurSkMode,
  type PriceTrack,
  type EurRule,
  type PriceCategory,
  type PriceListVersion,
  type PriceSurcharge,
  type PublishCheck,
  type SaleEntryInput,
  type SalePriceEntry,
  type SalePriceListKind,
  type SalePriceMode,
  type SurchargeInput,
  type VersionedPriceResult,
} from "../../../domain/priceVersions";
import { isPriceVersionConflict, salePriceVersionsApi, type ResolveResponse, type SalePriceRegister } from "../../../lib/db/priceVersions.remoteApi.client";
import type { PricingCatalogItem } from "../../../lib/db/priceVersions.supabase";
import { PurchasePricesPanel } from "./PurchasePricesPanel";
import {
  amountText,
  formatAmount,
  ItemCodeCell,
  ListForm,
  parseAmountText,
  PublishCheckView,
  StatusBadge,
  VersionActions,
  VersionHeaderForm,
  VersionTable,
  versionTitle,
} from "./PriceVersionParts";

type Tab = "sale" | "events" | "electricity" | "test" | "purchase";

/** Opening the page from a catalog card ("Otevřít v ceníku"): which list/version to show, filtered to the item. Navigation only — nothing is written. */
export type PriceVersionsPreselect = Readonly<{ tab: "sale" | "purchase"; listId?: string; versionId?: string; itemFilter?: string }>;

const TAB_LABELS: Readonly<Record<Tab, string>> = {
  sale: "Prodejní ceníky",
  events: "Veletrhy – přiřazení verzí",
  electricity: "Služby elektřiny",
  test: "Zkušební výpočet",
  purchase: "Nákupní ceník (interní)",
};

const EMPTY_REGISTER: SalePriceRegister = { lists: [], versions: [], events: [], assignments: [], items: [], variantSets: [], kitLines: [], coverage: {} };

/** Name without the code (the code has its own column). */
function itemName(item: PricingCatalogItem | undefined, fallback = "—"): string {
  return item ? `${item.displayName}${item.lifecycleStatus === "archived" ? " (archivováno)" : ""}` : fallback;
}

type RowSort = Readonly<{ key: "code" | "name"; direction: 1 | -1 }>;

function SortHeader({ label, sortKey, sort, onSort, className }: { label: string; sortKey: RowSort["key"]; sort: RowSort; onSort: (sort: RowSort) => void; className?: string }) {
  const active = sort.key === sortKey;
  return (
    <th className={className} aria-sort={active ? (sort.direction === 1 ? "ascending" : "descending") : "none"}>
      <button type="button" className="linkButton priceSortButton" onClick={() => onSort({ key: sortKey, direction: active ? (sort.direction === 1 ? -1 : 1) : 1 })}>
        {label}{active ? (sort.direction === 1 ? " ▲" : " ▼") : ""}
      </button>
    </th>
  );
}

function itemLabel(item: PricingCatalogItem | undefined, fallback = "—"): string {
  if (!item) return fallback;
  const code = item.abfCode ?? item.internalCode;
  return `${code ? `${code} · ` : ""}${item.displayName}${item.lifecycleStatus === "archived" ? " (archivováno)" : ""}`;
}

/**
 * Administrace → Ceníky (verze) — V1-DATA-05. Sale price lists with versions, explicit event
 * assignment, electricity category, a test calculation, and — in its own tab, own API and own
 * permission — the internal purchase price list. The legacy "Ceníky" / "Správa cen" pages are
 * unchanged and keep serving the generator until V1-DATA-07.
 */
export function PriceVersionsPage({ actorName, preselect }: { actorName?: string; preselect?: PriceVersionsPreselect }) {
  const api = useMemo(() => salePriceVersionsApi(() => actorName), [actorName]);
  const [tab, setTab] = useState<Tab>(preselect?.tab ?? "sale");
  const salePreselect = preselect?.tab === "sale" ? preselect : undefined;
  const [register, setRegister] = useState<SalePriceRegister>(EMPTY_REGISTER);
  const [loadError, setLoadError] = useState("");
  const [loaded, setLoaded] = useState(false);

  async function reload() {
    try {
      setRegister(await api.load());
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Ceníky se nepodařilo načíst.");
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="workspacePage priceVersionsPage">
      <div className="workspacePageHeader"><div><span className="eyebrow">ADMINISTRACE</span><h1>Ceníky (verze)</h1></div></div>
      <p className="temporaryNotice">Ceny jsou vždy bez DPH. Publikovaná verze je neměnná, oprava = nová verze. Veletrh používá jen výslovně přiřazenou verzi; datum konání ani publikace nové verze ceny veletrhu nemění. Generátor a stávající projekty zatím počítají ze starých ceníků (napojení přijde ve V1-DATA-07).</p>
      {loadError && <p className="uploadError">{loadError}</p>}
      <div className="variantSetsTabs">
        {(Object.keys(TAB_LABELS) as Tab[]).map((key) => (
          <button key={key} type="button" className={tab === key ? "primaryButton" : "secondaryButton"} onClick={() => setTab(key)}>{TAB_LABELS[key]}</button>
        ))}
      </div>
      {!loaded && <p className="workspaceEmpty">Načítám…</p>}
      {loaded && tab === "sale" && <SaleListsTab register={register} api={api} onChanged={reload} preselect={salePreselect} />}
      {loaded && tab === "events" && <EventAssignmentsTab register={register} api={api} onChanged={reload} />}
      {loaded && tab === "electricity" && <ElectricityCategoryTab register={register} api={api} onChanged={reload} />}
      {loaded && tab === "test" && <TestResolveTab register={register} api={api} />}
      {tab === "purchase" && <PurchasePricesPanel actorName={actorName} preselect={preselect?.tab === "purchase" ? preselect : undefined} />}
    </div>
  );
}

type SaleApi = ReturnType<typeof salePriceVersionsApi>;

// ============================================================================
// Sale lists and versions
// ============================================================================

function SaleListsTab({ register, api, onChanged, preselect }: { register: SalePriceRegister; api: SaleApi; onChanged: () => Promise<void>; preselect?: PriceVersionsPreselect }) {
  const [selectedListId, setSelectedListId] = useState<string | undefined>(preselect?.listId && register.lists.some((candidate) => candidate.id === preselect.listId) ? preselect.listId : register.lists[0]?.id);
  const [editingList, setEditingList] = useState<"new" | "edit" | undefined>(register.lists.length ? undefined : "new");
  const [selectedVersionId, setSelectedVersionId] = useState<string | undefined>(preselect?.versionId);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [check, setCheck] = useState<PublishCheck | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);

  const list = register.lists.find((candidate) => candidate.id === selectedListId);
  const versions = register.versions.filter((version) => version.priceListId === selectedListId);
  const version = versions.find((candidate) => candidate.id === selectedVersionId);
  const eventName = (id: string) => register.events.find((event) => event.id === id)?.name ?? id;

  async function run(action: () => Promise<unknown>, success: string, after?: (result: unknown) => void) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await action();
      setMessage(success);
      await onChanged();
      after?.(result);
    } catch (caught) {
      if (isPriceVersionConflict(caught)) {
        // Somebody else changed the version first: nothing was written; show the current state.
        setError(`${caught.message} Zobrazuji aktuální stav.`);
        await onChanged();
      } else {
        setError(caught instanceof Error ? caught.message : "Akce se nezdařila.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="adminSplit">
      <div className="adminList">
        {register.lists.map((candidate) => (
          <button key={candidate.id} type="button" className={candidate.id === selectedListId ? "active" : ""} onClick={() => { setSelectedListId(candidate.id); setSelectedVersionId(undefined); setEditingList(undefined); setCheck(null); }}>
            <strong>{candidate.name}{candidate.isActive ? "" : " (neaktivní)"}</strong>
            <span>{candidate.code} · {PRICE_LIST_KIND_LABELS_CS[candidate.kind]}</span>
          </button>
        ))}
        <button type="button" onClick={() => setEditingList("new")}><strong>+ Nový prodejní ceník</strong><span>základní nebo elektřina</span></button>
      </div>
      <div className="priceVersionsMain">
        {editingList && (
          <ListForm
            kinds={SALE_PRICE_LIST_KINDS}
            initial={editingList === "edit" ? list : undefined}
            onCancel={() => setEditingList(undefined)}
            onSave={async (draft) => {
              const saved = await api.saveList(draft);
              await onChanged();
              setSelectedListId(saved.id);
              setEditingList(undefined);
            }}
          />
        )}
        {!editingList && list && (
          <section className="adminDetail">
            <div className="eventForm">
              <div className="priceVersionListHeader">
                <div><h2>{list.name}</h2><p className="fieldHint">{list.code} · {PRICE_LIST_KIND_LABELS_CS[list.kind]}{list.note ? ` · ${list.note}` : ""}</p></div>
                <div className="assetActions">
                  <button type="button" className="secondaryButton" onClick={() => setEditingList("edit")}>Upravit ceník</button>
                  <button type="button" className="primaryButton" disabled={busy} onClick={() => run(() => api.createVersion(list.id), "Vznikl nový prázdný koncept.", (id) => setSelectedVersionId(id as string))}>+ Nová prázdná verze</button>
                </div>
              </div>
              {list.kind === "electricity" && <p className="fieldHint">Ceník elektřiny smí obsahovat jen položky kategorie Elektřina (záložka Služby elektřiny). Položka, která v něm chybí, se vezme ze základního ceníku veletrhu.</p>}
              <VersionTable versions={versions} selectedId={selectedVersionId} usage={(id) => eventsUsingVersion(register.assignments, id).map(eventName)} gaps={(id) => uncoveredTracks(register.coverage[id])} onSelect={(id) => { setSelectedVersionId(id); setCheck(null); setMessage(""); setError(""); }} />
              {message && <p className="saveOk">{message}</p>}
              {error && <p className="uploadError">{error}</p>}
            </div>
          </section>
        )}
        {!editingList && list && version && (
          <section className="adminDetail">
            <div className="eventForm">
              <div className="priceVersionListHeader">
                <div><h2>{list.name} · {versionTitle(version)}</h2><StatusBadge status={version.status} />{version.basedOnVersionId && <span className="fieldHint"> vychází z {versionTitle(register.versions.find((candidate) => candidate.id === version.basedOnVersionId) ?? { versionNo: 0 })}</span>}</div>
                <VersionActions
                  version={version}
                  busy={busy || editorDirty}
                  onCheck={() => run(async () => setCheck(await api.checkPublish(version.id)), "Kontrola proběhla.")}
                  onPublish={() => {
                    if (!window.confirm(`Publikovat ${versionTitle(version)}? Publikovaná verze už nepůjde změnit.`)) return;
                    void run(async () => {
                      const result = await api.publishVersion(version.id, version.revision);
                      setCheck({ errors: [], warnings: result.warnings });
                    }, "Verze byla publikována. Veletrhům se nic nezměnilo, dokud jim ji výslovně nepřiřadíte.");
                  }}
                  onDelete={() => {
                    if (!window.confirm("Smazat tento koncept?")) return;
                    void run(() => api.deleteVersion(version.id, version.revision), "Koncept byl smazán.", () => setSelectedVersionId(undefined));
                  }}
                  onArchive={() => {
                    if (!window.confirm("Archivovat verzi? Veletrhy, které ji mají přiřazenou, ji používají dál; nově ji přiřadit nepůjde.")) return;
                    void run(() => api.archiveVersion(version.id, version.revision), "Verze byla archivována.");
                  }}
                  onCopy={() => run(() => api.createVersion(list.id, { id: version.id, revision: version.revision }), "Vznikla nová verze jako kopie. Upravte ji a publikujte.", (id) => setSelectedVersionId(id as string))}
                />
              </div>
              {editorDirty && <p className="fieldHint">Akce verze jsou zablokované, dokud neuložíte nebo nezahodíte změny řádků — jinak by se publikoval nebo zkopíroval jiný stav, než vidíte.</p>}
              <PublishCheckView check={check} />
              <p className="fieldHint">Revize konceptu: {version.revision}. Každé uložení ověří, že koncept mezitím nezměnil nikdo jiný.</p>
              <SaleVersionEditor key={version.id} version={version} register={register} api={api} onChanged={onChanged} onDirtyChange={setEditorDirty} initialFilter={version.id === preselect?.versionId ? preselect.itemFilter : undefined} />
            </div>
          </section>
        )}
        {!editingList && !list && <p className="workspaceEmpty">Založte první prodejní ceník.</p>}
      </div>
    </div>
  );
}

type EntryDraft = Readonly<{
  key: string;
  catalogItemId: string;
  variantId: string;
  /** Product line (e.g. REVEXPO) — never together with variantId. */
  variantSeries: string;
  priceMode: SalePriceMode;
  saleCzk: string;
  /** EUR_SK: derived from CZK, or manual (saleEur). */
  eurMode: EurSkMode;
  saleEur: string;
  /** EUR_WORLD: own fixed price. */
  saleEurWorld: string;
  unitCode: string;
  note: string;
}>;

type SurchargeDraft = Readonly<{
  key: string;
  target: string;
  amountCzk: string;
  eurMode: EurSkMode;
  amountEur: string;
  amountEurWorld: string;
  note: string;
}>;

let draftCounter = 0;
const nextKey = () => `row-${++draftCounter}`;

function entryToDraft(entry: SalePriceEntry): EntryDraft {
  return {
    key: entry.id,
    catalogItemId: entry.catalogItemId,
    variantId: entry.variantId ?? "",
    variantSeries: entry.variantSeries ?? "",
    priceMode: entry.priceMode,
    saleCzk: amountText(entry.saleCzk),
    // Legacy direct rows: their EUR price is EUR_WORLD and EUR_SK is derived (same as the resolver).
    eurMode: entry.eurMode === "manual" ? "manual" : "derived",
    saleEur: entry.eurMode === "manual" ? amountText(entry.saleEur) : "",
    saleEurWorld: amountText(eurWorldOf({ czk: entry.saleCzk, eurMode: entry.eurMode, eur: entry.saleEur, eurWorld: entry.saleEurWorld })),
    unitCode: entry.unitCode ?? "",
    note: entry.note ?? "",
  };
}

function draftToEntryInput(draft: EntryDraft): Record<string, unknown> {
  return {
    catalogItemId: draft.catalogItemId,
    variantId: draft.variantId || undefined,
    variantSeries: draft.variantId ? undefined : draft.variantSeries || undefined,
    priceMode: draft.priceMode,
    saleCzk: draft.priceMode === "fixed" ? draft.saleCzk : undefined,
    eurMode: draft.priceMode === "fixed" ? draft.eurMode : "none",
    saleEur: draft.priceMode === "fixed" && draft.eurMode === "manual" ? draft.saleEur : undefined,
    saleEurWorld: draft.priceMode === "fixed" ? draft.saleEurWorld : undefined,
    unitCode: draft.unitCode || undefined,
    note: draft.note || undefined,
  };
}

/** Surcharge targets are encoded as their identity key (surchargeKey) so a select can carry them. */
function surchargeTargetOf(surcharge: Pick<PriceSurcharge, "targetKind" | "variantId" | "kitItemId" | "lineKey" | "substituteItemId" | "substituteVariantId">): string {
  return surchargeKey(surcharge);
}

function surchargeFromTarget(target: string): Partial<SurchargeInput> {
  const [targetKind, variantId, kitItemId, lineKey, substituteItemId, substituteVariantId] = target.split("|");
  if (targetKind === "variant") return { targetKind: "variant", variantId };
  return { targetKind: "substitute", kitItemId, lineKey, substituteItemId, ...(substituteVariantId ? { substituteVariantId } : {}) };
}

/** EUR_SK cell: mode (přepočet / ruční) and the effective value. Depends on CZK and the rate only. */
function EurSkCell({ czk, mode, eur, rule, disabled, onMode, onEur }: { czk: string; mode: EurSkMode; eur: string; rule: EurRule; disabled: boolean; onMode: (mode: EurSkMode) => void; onEur: (value: string) => void }) {
  const czkValue = parseAmountText(czk);
  const derived = czkValue !== undefined && rule.eurRate > 0 ? convertCzkToEur(czkValue, rule) : undefined;
  return (
    <span className="priceVersionEurInput">
      <select value={mode} disabled={disabled} onChange={(event) => { const next = event.target.value as EurSkMode; onMode(next); if (next === "manual" && !eur && derived !== undefined) onEur(amountText(derived)); }}>
        {EUR_SK_MODES.map((option) => <option key={option} value={option}>{EUR_MODE_LABELS_CS[option]}</option>)}
      </select>
      {mode === "derived"
        ? <strong title={czkValue !== undefined ? `${czkValue} / ${rule.eurRate} = ${(czkValue / rule.eurRate).toFixed(4)}` : ""}>{formatAmount(derived, "EUR")}</strong>
        : <input value={eur} onChange={(event) => onEur(event.target.value)} disabled={disabled} inputMode="decimal" />}
      {mode === "manual" && <small className="fieldHint">ruční cena · přepočet by dal {formatAmount(derived, "EUR")}</small>}
    </span>
  );
}

function SaleVersionEditor({ version, register, api, onChanged, onDirtyChange, initialFilter }: { version: PriceListVersion; register: SalePriceRegister; api: SaleApi; onChanged: () => Promise<void>; onDirtyChange?: (dirty: boolean) => void; initialFilter?: string }) {
  const [entries, setEntries] = useState<readonly EntryDraft[]>([]);
  /** Revision the loaded rows belong to; every save states it (optimistic concurrency). */
  const [revision, setRevision] = useState(version.revision);
  const [conflict, setConflict] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [surcharges, setSurcharges] = useState<readonly SurchargeDraft[]>([]);
  const [rule, setRule] = useState<EurRule>(version);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [filter, setFilter] = useState(initialFilter ?? "");
  const [sort, setSort] = useState<RowSort>({ key: "code", direction: 1 });
  const [newItemId, setNewItemId] = useState("");
  const editable = version.status === "draft";
  const itemById = useMemo(() => new Map(register.items.map((item) => [item.id, item])), [register.items]);
  const allVariants = useMemo(() => register.variantSets.flatMap((set) => set.variants.map((variant) => ({ ...variant, setName: set.name }))), [register.variantSets]);

  useEffect(() => {
    setRule(version);
  }, [version]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  // Rows reload only when another version is opened or its status changes — never on a register
  // reload (e.g. after saving the header), so unsaved row edits survive.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.loadRows(version.id).then((rows) => {
      if (cancelled) return;
      setRevision(rows.version.revision);
      setRule(rows.version);
      setConflict("");
      setEntries(rows.entries.map(entryToDraft).sort((a, b) => itemLabel(itemById.get(a.catalogItemId)).localeCompare(itemLabel(itemById.get(b.catalogItemId)), "cs")));
      setSurcharges(rows.surcharges.map((surcharge) => ({ key: surcharge.id, target: surchargeTargetOf(surcharge), amountCzk: amountText(surcharge.amountCzk), eurMode: surcharge.eurMode === "manual" ? "manual" : "derived", amountEur: surcharge.eurMode === "manual" ? amountText(surcharge.amountEur) : "", amountEurWorld: amountText(eurWorldOf({ czk: surcharge.amountCzk, eurMode: surcharge.eurMode, eur: surcharge.amountEur, eurWorld: surcharge.amountEurWorld })), note: surcharge.note ?? "" })));
      setDirty(false);
      setError("");
    }).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Řádky se nepodařilo načíst.")).finally(() => setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version.id, version.status, api, reloadKey]);

  const surchargeTargets = useMemo(() => {
    const targets: { value: string; label: string }[] = [];
    for (const set of register.variantSets) {
      for (const variant of set.variants) {
        if (variant.surchargeRule !== "fixed" && variant.surchargeRule !== "per_unit") continue;
        targets.push({ value: surchargeTargetOf({ targetKind: "variant", variantId: variant.id }), label: `Varianta: ${set.name} · ${variant.name} (${variant.surchargeRule === "per_unit" ? `za ${variant.surchargeUnitCode ?? "jednotku"}` : "pevný"})` });
      }
    }
    for (const line of register.kitLines) {
      for (const substitute of line.substitutes ?? []) {
        if (substitute.surchargeRule !== "fixed" && substitute.surchargeRule !== "per_unit") continue;
        const variant = allVariants.find((candidate) => candidate.id === substitute.substituteVariantId);
        targets.push({
          value: surchargeTargetOf({ targetKind: "substitute", kitItemId: line.packageItemId, lineKey: line.lineKey, substituteItemId: substitute.substituteItemId, substituteVariantId: substitute.substituteVariantId }),
          label: `Náhrada: ${itemLabel(itemById.get(line.packageItemId))} · řádek ${line.lineKey} → ${itemLabel(itemById.get(substitute.substituteItemId))}${variant ? ` (${variant.name})` : ""} (${substitute.surchargeRule === "per_unit" ? `za ${substitute.surchargeUnitCode ?? "jednotku"}` : "pevný"})`,
        });
      }
    }
    return targets;
  }, [register.variantSets, register.kitLines, allVariants, itemById]);

  function patchEntry(key: string, patch: Partial<EntryDraft>) {
    setEntries((current) => current.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)));
    setDirty(true);
    setSaved("");
  }

  function patchSurcharge(key: string, patch: Partial<SurchargeDraft>) {
    setSurcharges((current) => current.map((surcharge) => (surcharge.key === key ? { ...surcharge, ...patch } : surcharge)));
    setDirty(true);
    setSaved("");
  }

  function addEntry() {
    const item = itemById.get(newItemId);
    if (!item) return;
    setEntries((current) => [...current, { key: nextKey(), catalogItemId: item.id, variantId: "", variantSeries: "", priceMode: "fixed", saleCzk: "", eurMode: "derived", saleEur: "", saleEurWorld: "", unitCode: item.unitCode ?? "", note: "" }]);
    setNewItemId("");
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      const result = await api.saveRows(
        version.id,
        revision,
        entries.map(draftToEntryInput) as unknown as SaleEntryInput[],
        surcharges.map((surcharge) => ({
          ...surchargeFromTarget(surcharge.target),
          amountCzk: surcharge.amountCzk,
          eurMode: surcharge.eurMode,
          amountEur: surcharge.eurMode === "manual" ? surcharge.amountEur : undefined,
          amountEurWorld: surcharge.amountEurWorld,
          note: surcharge.note || undefined,
        })) as unknown as SurchargeInput[],
      );
      setRevision(result.revision);
      setDirty(false);
      setSaved("Řádky verze byly uloženy.");
      await onChanged();
    } catch (caught) {
      if (isPriceVersionConflict(caught)) setConflict(caught.message);
      else setError(caught instanceof Error ? caught.message : "Řádky se nepodařilo uložit.");
    } finally {
      setSaving(false);
    }
  }

  // Display only: filtering and ordering never change the saved rows.
  const variantName = (id: string) => allVariants.find((variant) => variant.id === id)?.name ?? "";
  const visibleEntries = entries
    .filter((entry) => matchesPriceItemSearch(itemById.get(entry.catalogItemId), filter))
    .slice()
    .sort((a, b) => {
      const itemA = itemById.get(a.catalogItemId);
      const itemB = itemById.get(b.catalogItemId);
      const primary = sort.key === "code" ? comparePriceItemsByCode(itemA, itemB) : (itemA?.displayName ?? "").localeCompare(itemB?.displayName ?? "", "cs") || comparePriceItemsByCode(itemA, itemB);
      return sort.direction * primary || variantName(a.variantId).localeCompare(variantName(b.variantId), "cs");
    });
  const usedItemIds = new Set(entries.filter((entry) => !entry.variantId && !entry.variantSeries).map((entry) => entry.catalogItemId));

  return (
    <>
      {conflict && (
        <div className="priceVersionConflict">
          <strong>Konflikt úprav — nic nebylo uloženo.</strong>
          <p>{conflict} Vaše rozpracované hodnoty zůstávají zobrazené, abyste si je mohli opsat.</p>
          <button type="button" className="secondaryButton" onClick={() => { if (!dirty || window.confirm("Načíst aktuální stav? Vaše neuložené změny se zahodí.")) { setReloadKey((key) => key + 1); void onChanged(); } }}>Načíst aktuální stav</button>
        </div>
      )}
      <VersionHeaderForm
        version={{ ...version, revision }}
        showEur
        onRuleChange={setRule}
        onSave={async (header) => {
          try {
            const result = await api.updateVersion(version.id, revision, header);
            setRevision(result.revision);
            await onChanged();
          } catch (caught) {
            if (isPriceVersionConflict(caught)) setConflict(caught.message);
            throw caught;
          }
        }}
      />
      <div className="eventSaveBar">
        <span className={dirty ? "dirty" : "saved"}>{saving ? "Ukládám…" : dirty ? "Neuložené změny řádků" : editable ? "Řádky uloženy" : "Publikovaná verze je jen pro čtení"}{saved && <small>{saved}</small>}</span>
        {editable && <button type="button" className="primaryButton" onClick={save} disabled={!dirty || saving}>Uložit řádky</button>}
      </div>
      {error && <p className="uploadError">{error}</p>}
      {loading ? <p className="workspaceEmpty">Načítám řádky…</p> : (
        <>
          <h3>Ceny položek ({entries.length})</h3>
          <div className="adminFilters"><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Hledat podle ABF / generátorového kódu nebo názvu…" /></div>
          <div className="priceVersionTableWrap">
            <table className="priceVersionTable priceVersionRows">
              <thead><tr><SortHeader label="Kód" sortKey="code" sort={sort} onSort={setSort} className="priceItemCodeHead" /><SortHeader label="Položka" sortKey="name" sort={sort} onSort={setSort} /><th>Varianta</th><th>Režim</th><th className="priceTrackHead">CZK</th><th className="priceTrackHead">EUR SK · kurz {rule.eurRate.toLocaleString("cs-CZ")}</th><th className="priceTrackHead">EUR WORLD</th><th>Jedn.</th><th>Poznámka</th>{editable && <th />}</tr></thead>
              <tbody>
                {visibleEntries.map((entry) => {
                  const variants = allVariants.filter((variant) => variant.priceItemId === entry.catalogItemId);
                  // Product lines of this card's colours (REVEXPO …): one price for the whole line.
                  const seriesOptions = [...new Set(variants.flatMap((variant) => (variant.series ? [variant.series] : [])))];
                  const scopeValue = entry.variantId ? `variant:${entry.variantId}` : entry.variantSeries ? `series:${entry.variantSeries}` : "";
                  return (
                    <tr key={entry.key}>
                      <ItemCodeCell item={itemById.get(entry.catalogItemId)} />
                      <td>{itemName(itemById.get(entry.catalogItemId), entry.catalogItemId)}</td>
                      <td>
                        <select
                          aria-label="Varianta"
                          value={scopeValue}
                          onChange={(event) => {
                            const [kind, id] = [event.target.value.slice(0, event.target.value.indexOf(":")), event.target.value.slice(event.target.value.indexOf(":") + 1)];
                            patchEntry(entry.key, kind === "variant" ? { variantId: id, variantSeries: "" } : kind === "series" ? { variantId: "", variantSeries: id } : { variantId: "", variantSeries: "" });
                          }}
                          disabled={!editable || variants.length === 0}
                        >
                          <option value="">všechny varianty</option>
                          {seriesOptions.map((series) => <option key={series} value={`series:${series}`}>řada {series} (všechny její barvy)</option>)}
                          {variants.map((variant) => <option key={variant.id} value={`variant:${variant.id}`}>{variant.setName} · {variant.name}</option>)}
                        </select>
                      </td>
                      <td>
                        <select value={entry.priceMode} onChange={(event) => patchEntry(entry.key, { priceMode: event.target.value as SalePriceMode })} disabled={!editable}>
                          {SALE_PRICE_MODES.map((mode) => <option key={mode} value={mode}>{SALE_PRICE_MODE_LABELS_CS[mode]}</option>)}
                        </select>
                      </td>
                      <td className="priceTrackCell"><input value={entry.priceMode === "fixed" ? entry.saleCzk : ""} onChange={(event) => patchEntry(entry.key, { saleCzk: event.target.value })} disabled={!editable || entry.priceMode !== "fixed"} inputMode="decimal" /></td>
                      <td className="priceTrackCell">{entry.priceMode === "fixed" ? <EurSkCell czk={entry.saleCzk} mode={entry.eurMode} eur={entry.saleEur} rule={rule} disabled={!editable} onMode={(mode) => patchEntry(entry.key, { eurMode: mode })} onEur={(value) => patchEntry(entry.key, { saleEur: value })} /> : <span className="fieldHint">{SALE_PRICE_MODE_LABELS_CS[entry.priceMode]}</span>}</td>
                      <td className="priceTrackCell">{entry.priceMode === "fixed" ? <input value={entry.saleEurWorld} onChange={(event) => patchEntry(entry.key, { saleEurWorld: event.target.value })} disabled={!editable} inputMode="decimal" placeholder="povinné" /> : <span className="fieldHint">—</span>}</td>
                      <td><input value={entry.unitCode} onChange={(event) => patchEntry(entry.key, { unitCode: event.target.value })} disabled={!editable} className="priceVersionUnit" /></td>
                      <td><input value={entry.note} onChange={(event) => patchEntry(entry.key, { note: event.target.value })} disabled={!editable} /></td>
                      {editable && <td><button type="button" className="linkButton" onClick={() => { setEntries((current) => current.filter((candidate) => candidate.key !== entry.key)); setDirty(true); }}>Odebrat</button></td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {editable && (
            <div className="priceVersionAddRow">
              <select value={newItemId} onChange={(event) => setNewItemId(event.target.value)}>
                <option value="">— vyberte položku katalogu —</option>
                {register.items.filter((item) => item.lifecycleStatus !== "archived").map((item) => (
                  <option key={item.id} value={item.id} disabled={usedItemIds.has(item.id) && !allVariants.some((variant) => variant.priceItemId === item.id)}>
                    {itemLabel(item)}{item.priceCategory === "electricity" ? " · elektřina" : ""}
                  </option>
                ))}
              </select>
              <button type="button" className="secondaryButton" onClick={addEntry} disabled={!newItemId}>+ Přidat položku</button>
            </div>
          )}

          <h3>Doplatky variant a náhrad v kompletech ({surcharges.length})</h3>
          <p className="fieldHint">Jen pro pravidla „Pevný doplatek“ a „Doplatek za jednotku“. Pravidlo „Rozdíl ceny“ částku nepotřebuje: spočítá se z cen položek této verze, záporný rozdíl je 0.</p>
          {surcharges.length > 0 && (
            <table className="priceVersionTable priceVersionRows">
              <thead><tr><th>Varianta / náhrada</th><th className="priceTrackHead">CZK</th><th className="priceTrackHead">EUR SK</th><th className="priceTrackHead">EUR WORLD</th><th>Poznámka</th>{editable && <th />}</tr></thead>
              <tbody>
                {surcharges.map((surcharge) => (
                  <tr key={surcharge.key}>
                    <td>
                      <select value={surcharge.target} onChange={(event) => patchSurcharge(surcharge.key, { target: event.target.value })} disabled={!editable}>
                        {!surchargeTargets.some((target) => target.value === surcharge.target) && <option value={surcharge.target}>(položka už v katalogu nemá toto pravidlo)</option>}
                        {surchargeTargets.map((target) => <option key={target.value} value={target.value}>{target.label}</option>)}
                      </select>
                    </td>
                    <td className="priceTrackCell"><input value={surcharge.amountCzk} onChange={(event) => patchSurcharge(surcharge.key, { amountCzk: event.target.value })} disabled={!editable} inputMode="decimal" /></td>
                    <td className="priceTrackCell"><EurSkCell czk={surcharge.amountCzk} mode={surcharge.eurMode} eur={surcharge.amountEur} rule={rule} disabled={!editable} onMode={(mode) => patchSurcharge(surcharge.key, { eurMode: mode })} onEur={(value) => patchSurcharge(surcharge.key, { amountEur: value })} /></td>
                    <td className="priceTrackCell"><input value={surcharge.amountEurWorld} onChange={(event) => patchSurcharge(surcharge.key, { amountEurWorld: event.target.value })} disabled={!editable} inputMode="decimal" placeholder="povinné" /></td>
                    <td><input value={surcharge.note} onChange={(event) => patchSurcharge(surcharge.key, { note: event.target.value })} disabled={!editable} /></td>
                    {editable && <td><button type="button" className="linkButton" onClick={() => { setSurcharges((current) => current.filter((candidate) => candidate.key !== surcharge.key)); setDirty(true); }}>Odebrat</button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {editable && (
            <div className="priceVersionAddRow">
              <button
                type="button"
                className="secondaryButton"
                disabled={surchargeTargets.length === 0}
                onClick={() => {
                  const free = surchargeTargets.find((target) => !surcharges.some((surcharge) => surcharge.target === target.value));
                  if (!free) return;
                  setSurcharges((current) => [...current, { key: nextKey(), target: free.value, amountCzk: "", eurMode: "derived", amountEur: "", amountEurWorld: "", note: "" }]);
                  setDirty(true);
                }}
              >+ Přidat doplatek</button>
              {surchargeTargets.length === 0 && <span className="fieldHint">V katalogu není varianta ani náhrada s pevným doplatkem nebo doplatkem za jednotku.</span>}
            </div>
          )}
        </>
      )}
    </>
  );
}

// ============================================================================
// Event assignments
// ============================================================================

function EventAssignmentsTab({ register, api, onChanged }: { register: SalePriceRegister; api: SaleApi; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [historyFor, setHistoryFor] = useState<string | undefined>();
  const listById = new Map(register.lists.map((list) => [list.id, list]));
  const versionById = new Map(register.versions.map((version) => [version.id, version]));
  const assignable = (kind: SalePriceListKind) => register.versions.filter((version) => version.status === "published" && listById.get(version.priceListId)?.kind === kind);
  const versionLabel = (id: string | undefined) => {
    const version = id ? versionById.get(id) : undefined;
    if (!version) return "—";
    return `${listById.get(version.priceListId)?.name ?? "?"} · ${versionTitle(version)}${version.status === "archived" ? " (archivováno)" : ""}`;
  };

  async function assign(eventId: string, kind: SalePriceListKind, versionId: string) {
    const current = currentEventAssignment(register.assignments, eventId, kind);
    if ((current?.priceListVersionId ?? "") === versionId) return;
    const gaps = versionId ? coverageWarning(versionId) : "";
    if (!window.confirm(versionId ? `Přiřadit veletrhu verzi „${versionLabel(versionId)}“?${gaps ? `\n\nUpozornění: ${gaps}` : ""}` : "Zrušit přiřazení? Veletrh pak nebude mít ceny tohoto druhu (k nacenění).")) return;
    setBusy(true);
    setError("");
    try {
      await api.assign(eventId, kind, versionId || null, current?.priceListVersionId ?? null);
      setMessage("Přiřazení bylo uloženo. Předchozí přiřazení zůstává v historii.");
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Přiřazení se nepodařilo uložit.");
      if (isPriceVersionConflict(caught)) await onChanged();
    } finally {
      setBusy(false);
    }
  }

  /** Tracks the version cannot price completely — e.g. EUR WORLD in versions published before the three-price correction. */
  function coverageWarning(versionId: string): string {
    return coverageWarningText(register.coverage[versionId]);
  }


  if (register.events.length === 0) return <p className="workspaceEmpty">Zatím není založený žádný veletrh. Založte jej v sekci Výstavy / eventy.</p>;
  return (
    <section className="adminDetail">
      <div className="eventForm">
        <p className="fieldHint">Každý veletrh má výslovně přiřazenou verzi základního ceníku a případně ceníku elektřiny. Lze přiřadit jen publikovanou verzi, a to bez ohledu na její evidenční platnost (např. zářijovému veletrhu verzi platnou do června). Publikace nové verze přiřazení nemění.</p>
        {message && <p className="saveOk">{message}</p>}
        {error && <p className="uploadError">{error}</p>}
        <table className="priceVersionTable">
          <thead><tr><th>Veletrh</th><th>Termín</th><th>Základní ceník</th><th>Ceník elektřiny</th><th /></tr></thead>
          <tbody>
            {register.events.map((event) => (
              <tr key={event.id}>
                <td><strong>{event.name}</strong>{event.active ? "" : " (neaktivní)"}<br /><small className="fieldHint">{event.id}</small></td>
                <td>{event.startDate ? new Date(`${event.startDate}T00:00:00`).toLocaleDateString("cs-CZ") : "—"}</td>
                {SALE_PRICE_LIST_KINDS.map((kind) => {
                  const current = currentEventAssignment(register.assignments, event.id, kind);
                  const options = assignable(kind);
                  return (
                    <td key={kind}>
                      <select value={current?.priceListVersionId ?? ""} disabled={busy} onChange={(change) => void assign(event.id, kind, change.target.value)}>
                        <option value="">— nepřiřazeno —</option>
                        {current && !options.some((version) => version.id === current.priceListVersionId) && <option value={current.priceListVersionId}>{versionLabel(current.priceListVersionId)}</option>}
                        {options.map((version) => <option key={version.id} value={version.id}>{versionLabel(version.id)}{uncoveredTracks(register.coverage[version.id]).length ? ` ⚠ neúplné: ${uncoveredTracks(register.coverage[version.id]).join(", ")}` : ""}</option>)}
                      </select>
                      {current && coverageWarning(current.priceListVersionId) && <small className="dangerText priceVersionCoverage">⚠ {coverageWarning(current.priceListVersionId)}</small>}
                    </td>
                  );
                })}
                <td><button type="button" className="linkButton" onClick={() => setHistoryFor(historyFor === event.id ? undefined : event.id)}>Historie</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {historyFor && (
          <div>
            <h3>Historie přiřazení · {register.events.find((event) => event.id === historyFor)?.name}</h3>
            <table className="priceVersionTable">
              <thead><tr><th>Druh</th><th>Verze</th><th>Přiřazeno</th><th>Ukončeno</th><th>Poznámka</th></tr></thead>
              <tbody>
                {eventAssignmentHistory(register.assignments, historyFor).map((assignment) => (
                  <tr key={assignment.id}>
                    <td>{PRICE_LIST_KIND_LABELS_CS[assignment.listKind]}</td>
                    <td>{versionLabel(assignment.priceListVersionId)}</td>
                    <td>{new Date(assignment.assignedAt).toLocaleString("cs-CZ")}{assignment.assignedBy ? ` · ${assignment.assignedBy}` : ""}</td>
                    <td>{assignment.replacedAt ? new Date(assignment.replacedAt).toLocaleString("cs-CZ") : "platí"}</td>
                    <td>{assignment.note ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

// ============================================================================
// Electricity category
// ============================================================================

function ElectricityCategoryTab({ register, api, onChanged }: { register: SalePriceRegister; api: SaleApi; onChanged: () => Promise<void> }) {
  const [busyId, setBusyId] = useState<string | undefined>();
  const [error, setError] = useState("");
  const [showAll, setShowAll] = useState(false);
  const items = register.items.filter((item) => showAll || item.itemType === "SERVICE" || item.priceCategory === "electricity");

  async function setCategory(itemId: string, category: PriceCategory) {
    setBusyId(itemId);
    setError("");
    try {
      await api.setPriceCategory(itemId, category);
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Kategorii se nepodařilo uložit.");
    } finally {
      setBusyId(undefined);
    }
  }

  return (
    <section className="adminDetail">
      <div className="eventForm">
        <p className="fieldHint">Služby elektřiny se rozlišují kategorií, ne prefixem ABF kódu. Položka kategorie Elektřina se na veletrhu cení z jeho ceníku elektřiny; když v něm chybí, ze základního ceníku. Při zavedení byly jednorázově označeny služby s ABF kódem L + 2 znaky.</p>
        <label className="checkLabel"><input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} /> Zobrazit všechny karty, nejen služby</label>
        {error && <p className="uploadError">{error}</p>}
        <table className="priceVersionTable">
          <thead><tr><th>Položka</th><th>Typ</th><th>Kategorie ceny</th></tr></thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{itemLabel(item)}</td>
                <td>{item.itemType}</td>
                <td>
                  <select value={item.priceCategory} disabled={busyId === item.id} onChange={(event) => void setCategory(item.id, event.target.value as PriceCategory)}>
                    {(Object.keys(PRICE_CATEGORY_LABELS_CS) as PriceCategory[]).map((category) => <option key={category} value={category}>{PRICE_CATEGORY_LABELS_CS[category]}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ============================================================================
// Test calculation
// ============================================================================

function ResultCell({ result }: { result: VersionedPriceResult }) {
  if (result.status === "priced") return <strong>{formatAmount(result.amountNet, result.currency)}</strong>;
  if (result.status === "included") return <span>Zahrnuto (0)</span>;
  if (result.status === "individual") return <span className="dangerText">Cena na dotaz</span>;
  return <span className="dangerText">K nacenění{result.missingReason ? ` — ${MISSING_REASON_LABELS_CS[result.missingReason]}` : ""}</span>;
}

function OriginCell({ result, register }: { result: VersionedPriceResult; register: SalePriceRegister }) {
  const origin = result.origin;
  if (!origin) return <span className="fieldHint">—</span>;
  const list = register.lists.find((candidate) => candidate.id === origin.listId);
  return (
    <span>
      {list?.name ?? origin.listCode} · v{origin.versionNo}
      {origin.versionStatus !== "published" ? ` (${origin.versionStatus === "draft" ? "koncept" : "archiv"})` : ""}
      {origin.variantSpecific ? " · cena varianty" : ""}
      {result.currency === "EUR" && origin.eurSource ? ` · ${origin.eurSource === "derived" ? `přepočet kurzem ${origin.eurRate.toLocaleString("cs-CZ")}` : origin.eurSource === "manual" ? `RUČNÍ cena EUR SK (přepočet by dal ${formatAmount(origin.derivedEur, "EUR")})` : "pevná cena EUR WORLD"}` : ""}
    </span>
  );
}

function TestResolveTab({ register, api }: { register: SalePriceRegister; api: SaleApi }) {
  const [source, setSource] = useState<"event" | "versions">(register.events.length ? "event" : "versions");
  const [eventId, setEventId] = useState(register.events[0]?.id ?? "");
  const [baseVersionId, setBaseVersionId] = useState("");
  const [electricityVersionId, setElectricityVersionId] = useState("");
  const [track, setTrack] = useState<PriceTrack>("CZK");
  const [requested, setRequested] = useState<readonly { catalogItemId: string; variantId?: string }[]>([]);
  const [itemId, setItemId] = useState("");
  const [variantId, setVariantId] = useState("");
  const [kitItemId, setKitItemId] = useState("");
  const [selections, setSelections] = useState<Record<string, KitLineSelection>>({});
  const [response, setResponse] = useState<ResolveResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const itemById = new Map(register.items.map((item) => [item.id, item]));
  const listById = new Map(register.lists.map((list) => [list.id, list]));
  const allVariants = register.variantSets.flatMap((set) => set.variants.map((variant) => ({ ...variant, setName: set.name })));
  const kits = register.items.filter((item) => register.kitLines.some((line) => line.packageItemId === item.id));
  const kitLines = register.kitLines.filter((line) => line.packageItemId === kitItemId);
  const versionsOf = (kind: SalePriceListKind) => register.versions.filter((version) => listById.get(version.priceListId)?.kind === kind && version.status !== "archived");

  async function calculate() {
    setBusy(true);
    setError("");
    try {
      setResponse(await api.resolve({
        priceTrack: track,
        ...(source === "event" ? { eventId } : { baseVersionId: baseVersionId || undefined, electricityVersionId: electricityVersionId || undefined }),
        items: requested,
        ...(kitItemId ? { kitItemId, selections: Object.values(selections) } : {}),
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Výpočet se nezdařil.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="adminDetail">
      <div className="eventForm">
        <p className="fieldHint">Ukáže, jakou cenu by systém vrátil. Podle veletrhu se použije jen jeho aktuální přiřazení (nikdy datum). Výběrem verzí lze vyzkoušet i koncept před publikací. Nic se neukládá.</p>
        <div className="twoColumns">
          <label><span>Zdroj cen</span>
            <select value={source} onChange={(event) => setSource(event.target.value as "event" | "versions")}>
              <option value="event">Přiřazení veletrhu</option>
              <option value="versions">Vybrané verze (i koncept)</option>
            </select>
          </label>
          <label><span>Cenový režim (volí se výslovně)</span>
            <select value={track} onChange={(event) => setTrack(event.target.value as PriceTrack)}>{PRICE_TRACKS.map((option) => <option key={option} value={option}>{PRICE_TRACK_LABELS_CS[option]}</option>)}</select>
          </label>
        </div>
        {source === "event" ? (
          <label><span>Veletrh</span>
            <select value={eventId} onChange={(event) => setEventId(event.target.value)}>
              {register.events.map((event) => <option key={event.id} value={event.id}>{event.name} ({event.id})</option>)}
            </select>
          </label>
        ) : (
          <div className="twoColumns">
            <label><span>Základní ceník</span>
              <select value={baseVersionId} onChange={(event) => setBaseVersionId(event.target.value)}>
                <option value="">— žádný —</option>
                {versionsOf("base").map((version) => <option key={version.id} value={version.id}>{listById.get(version.priceListId)?.name} · {versionTitle(version)} ({version.status === "draft" ? "koncept" : "publikováno"})</option>)}
              </select>
            </label>
            <label><span>Ceník elektřiny</span>
              <select value={electricityVersionId} onChange={(event) => setElectricityVersionId(event.target.value)}>
                <option value="">— žádný —</option>
                {versionsOf("electricity").map((version) => <option key={version.id} value={version.id}>{listById.get(version.priceListId)?.name} · {versionTitle(version)} ({version.status === "draft" ? "koncept" : "publikováno"})</option>)}
              </select>
            </label>
          </div>
        )}
        <div className="priceVersionAddRow">
          <select value={itemId} onChange={(event) => { setItemId(event.target.value); setVariantId(""); }}>
            <option value="">— položka —</option>
            {register.items.map((item) => <option key={item.id} value={item.id}>{itemLabel(item)}</option>)}
          </select>
          <select value={variantId} onChange={(event) => setVariantId(event.target.value)} disabled={!allVariants.some((variant) => variant.priceItemId === itemId)}>
            <option value="">bez varianty</option>
            {allVariants.filter((variant) => variant.priceItemId === itemId).map((variant) => <option key={variant.id} value={variant.id}>{variant.setName} · {variant.name}</option>)}
          </select>
          <button type="button" className="secondaryButton" disabled={!itemId} onClick={() => { setRequested([...requested, { catalogItemId: itemId, ...(variantId ? { variantId } : {}) }]); setItemId(""); setVariantId(""); }}>+ Přidat</button>
        </div>
        <label><span>Komplet / stánek (volitelně)</span>
          <select value={kitItemId} onChange={(event) => { setKitItemId(event.target.value); setSelections({}); }}>
            <option value="">— bez kompletu —</option>
            {kits.map((kit) => <option key={kit.id} value={kit.id}>{itemLabel(kit)}</option>)}
          </select>
        </label>
        {kitLines.filter((line) => line.lineKind === "item" && ((line.substitutes ?? []).length > 0 || line.variantSetId)).map((line) => {
          const setVariants = register.variantSets.find((set) => set.id === line.variantSetId)?.variants ?? [];
          const selection = selections[line.lineKey];
          const value = selection?.substituteItemId ? `sub|${selection.substituteItemId}|${selection.substituteVariantId ?? ""}` : selection?.variantId ? `var|${selection.variantId}` : "";
          return (
            <label key={line.lineKey}><span>Řádek {line.lineKey}: {itemLabel(itemById.get(line.childItemId ?? ""))}</span>
              <select value={value} onChange={(event) => {
                const [kind, first, second] = event.target.value.split("|");
                const next = { ...selections };
                if (!kind) delete next[line.lineKey];
                else next[line.lineKey] = kind === "sub" ? { lineKey: line.lineKey, substituteItemId: first!, ...(second ? { substituteVariantId: second } : {}) } : { lineKey: line.lineKey, variantId: first! };
                setSelections(next);
              }}>
                <option value="">výchozí</option>
                {setVariants.filter((variant) => variant.isActive && variant.id !== line.defaultVariantId).map((variant) => <option key={variant.id} value={`var|${variant.id}`}>Barva: {variant.name}</option>)}
                {(line.substitutes ?? []).filter((substitute) => substitute.isActive !== false).map((substitute) => <option key={`${substitute.substituteItemId}-${substitute.substituteVariantId ?? ""}`} value={`sub|${substitute.substituteItemId}|${substitute.substituteVariantId ?? ""}`}>Náhrada: {itemLabel(itemById.get(substitute.substituteItemId))}</option>)}
              </select>
              {/* A substitute without a fixed colour (e.g. M04) takes any colour of the line swatch book; an agreement-only card needs a reason. */}
              {selection?.substituteItemId && !(line.substitutes ?? []).some((substitute) => substitute.substituteItemId === selection.substituteItemId && substitute.substituteVariantId) && setVariants.length > 0 && (
                <select aria-label="Barva náhrady" value={selection.substituteVariantId ?? ""} onChange={(event) => setSelections({ ...selections, [line.lineKey]: { ...selection, substituteVariantId: event.target.value || undefined } })}>
                  <option value="">— barva —</option>
                  {setVariants.filter((variant) => variant.isActive).map((variant) => <option key={variant.id} value={variant.id}>Barva: {variant.name}</option>)}
                </select>
              )}
              {selection?.substituteItemId && (
                <input aria-label="Důvod náhrady" value={selection.reason ?? ""} onChange={(event) => setSelections({ ...selections, [line.lineKey]: { ...selection, reason: event.target.value } })} placeholder="Důvod / dohoda (povinné u položek jen na dohodu, např. M04)" />
              )}
            </label>
          );
        })}
        <div className="assetActions">
          <button type="button" className="primaryButton" disabled={busy || (requested.length === 0 && !kitItemId)} onClick={calculate}>{busy ? "Počítám…" : "Spočítat"}</button>
          {requested.length > 0 && <button type="button" className="secondaryButton" onClick={() => { setRequested([]); setResponse(null); }}>Vyčistit položky</button>}
        </div>
        {error && <p className="uploadError">{error}</p>}
        {requested.length > 0 && (
          <table className="priceVersionTable">
            <thead><tr><th>Položka</th><th>Varianta</th><th>Cena bez DPH</th><th>Původ ceny</th></tr></thead>
            <tbody>
              {requested.map((entry, index) => {
                const result = response?.results[index]?.result;
                return (
                  <tr key={`${entry.catalogItemId}-${entry.variantId ?? ""}-${index}`}>
                    <td>{itemLabel(itemById.get(entry.catalogItemId))}</td>
                    <td>{allVariants.find((variant) => variant.id === entry.variantId)?.name ?? "—"}</td>
                    <td>{result ? <ResultCell result={result} /> : "—"}</td>
                    <td>{result ? <OriginCell result={result} register={register} /> : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {response?.kit && (
          <div>
            <h3>Komplet: {itemLabel(itemById.get(kitItemId))}</h3>
            <p>Cena kompletu: <ResultCell result={response.kit.kitPrice} /> · <OriginCell result={response.kit.kitPrice} register={register} /></p>
            <table className="priceVersionTable">
              <thead><tr><th>Řádek</th><th>Komponenta</th><th>Množství</th><th>Stav</th><th>Cena řádku</th><th>Doplatek</th><th>Celkem</th></tr></thead>
              <tbody>
                {response.kit.lines.map((line) => (
                  <tr key={line.lineKey}>
                    <td>{line.lineKey}</td>
                    <td>{line.label ?? itemLabel(itemById.get(line.effectiveItemId ?? ""))}{line.substituted ? " (náhrada)" : ""}{line.variantId ? ` · ${allVariants.find((variant) => variant.id === line.variantId)?.name ?? ""}` : ""}{line.agreement ? ` · dohoda: ${line.agreement.reason}` : ""}</td>
                    <td>{line.quantity} {line.unitCode ?? ""}</td>
                    <td>{line.status === "included" ? "v ceně kompletu" : line.status === "priced" ? "účtováno" : line.status === "individual" ? "na dotaz" : "k nacenění"}</td>
                    <td>{formatAmount(line.baseNet, response.currency)}</td>
                    <td>{line.surcharge ? `${formatAmount(line.surcharge.amountNet, response.currency)}${line.surcharge.reason === "floor_zero" ? " (levnější volba, bez dobropisu)" : line.surcharge.reason ? " (chybí částka)" : ""}` : "—"}</td>
                    <td>{formatAmount(line.totalNet, response.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* Without the kit's own price the total is not a price at all — never shown as "0 Kč". */}
            {response.kit.kitPrice.status === "missing" || response.kit.kitPrice.status === "individual"
              ? <p><strong>Celkem bez DPH: K nacenění</strong><span className="dangerText"> · cena kompletu v této verzi chybí{response.kit.totalNet ? ` · známé příplatky ${formatAmount(response.kit.totalNet, response.currency)}` : ""}</span></p>
              : <p><strong>Celkem bez DPH: {formatAmount(response.kit.totalNet, response.currency)}</strong>{response.kit.needsQuote ? <span className="dangerText"> · obsahuje položky k nacenění, cena není úplná</span> : ""}</p>}
            {response.kit.issues.map((issue) => <p key={issue} className="fieldHint">⚠ {issue}</p>)}
          </div>
        )}
      </div>
    </section>
  );
}
