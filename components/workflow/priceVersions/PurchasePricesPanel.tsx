"use client";

import { useEffect, useMemo, useState } from "react";
import type { PriceListVersion, PublishCheck, PurchaseEntryInput, PurchasePriceEntry } from "../../../domain/priceVersions";
import { isPriceVersionConflict, purchasePriceVersionsApi, type PurchasePriceRegister } from "../../../lib/db/priceVersions.remoteApi.client";
import type { PricingCatalogItem } from "../../../lib/db/priceVersions.supabase";
import { comparePriceItemsByCode, matchesPriceItemSearch } from "../../../domain/priceVersions";
import { amountText, ItemCodeCell, ListForm, PublishCheckView, StatusBadge, VersionActions, VersionHeaderForm, VersionTable, versionTitle } from "./PriceVersionParts";

const EMPTY: PurchasePriceRegister = { lists: [], versions: [], links: [], companies: [], items: [] };

function itemLabel(item: PricingCatalogItem | undefined, fallback: string): string {
  if (!item) return fallback;
  const code = item.abfCode ?? item.internalCode;
  return `${code ? `${code} · ` : ""}${item.displayName}`;
}

type Api = ReturnType<typeof purchasePriceVersionsApi>;

/**
 * Nákupní ceník (V1-DATA-05) — INTERNAL. Loaded only from /api/purchase-prices (own permission
 * prices.purchase.*), never from the sale routes, the customer catalog or any export. One shared
 * versioned list for the realization firms linked to it (Creativ Expo, Gendai, MAC Praha today).
 */
export function PurchasePricesPanel({ actorName }: { actorName?: string }) {
  const api = useMemo(() => purchasePriceVersionsApi(() => actorName), [actorName]);
  const [register, setRegister] = useState<PurchasePriceRegister>(EMPTY);
  const [loadError, setLoadError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [selectedListId, setSelectedListId] = useState<string | undefined>();
  const [editingList, setEditingList] = useState<"new" | "edit" | undefined>();
  const [selectedVersionId, setSelectedVersionId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [check, setCheck] = useState<PublishCheck | null>(null);

  async function reload() {
    try {
      const next = await api.load();
      setRegister(next);
      setLoadError("");
      setSelectedListId((current) => current ?? next.lists[0]?.id);
      if (next.lists.length === 0) setEditingList("new");
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : "Nákupní ceníky se nepodařilo načíst.");
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(action: () => Promise<unknown>, success: string, after?: (result: unknown) => void) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await action();
      setMessage(success);
      await reload();
      after?.(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Akce se nezdařila.");
      if (isPriceVersionConflict(caught)) await reload();
    } finally {
      setBusy(false);
    }
  }

  const list = register.lists.find((candidate) => candidate.id === selectedListId);
  const versions = register.versions.filter((version) => version.priceListId === selectedListId);
  const version = versions.find((candidate) => candidate.id === selectedVersionId);

  if (!loaded) return <p className="workspaceEmpty">Načítám…</p>;
  return (
    <>
      <p className="temporaryNotice">Interní údaje. Nákupní ceny se nikdy nezobrazují v zákaznickém katalogu, nabídce ani zákaznických exportech. Podle aktuální smlouvy mají Creativ Expo, Gendai a MAC Praha stejné nákupní ceny, proto stačí jeden společný ceník. Názvy, kódy a jednotky firem zůstávají v aliasech katalogu.</p>
      {loadError && <p className="uploadError">{loadError}</p>}
      <div className="adminSplit">
        <div className="adminList">
          {register.lists.map((candidate) => (
            <button key={candidate.id} type="button" className={candidate.id === selectedListId ? "active" : ""} onClick={() => { setSelectedListId(candidate.id); setSelectedVersionId(undefined); setEditingList(undefined); setCheck(null); }}>
              <strong>{candidate.name}{candidate.isActive ? "" : " (neaktivní)"}</strong>
              <span>{candidate.code}</span>
            </button>
          ))}
          <button type="button" onClick={() => setEditingList("new")}><strong>+ Nový nákupní ceník</strong><span>pro smluvní výjimku</span></button>
        </div>
        <div className="priceVersionsMain">
          {editingList && (
            <ListForm
              kinds={["purchase"]}
              initial={editingList === "edit" ? list : undefined}
              onCancel={() => setEditingList(undefined)}
              onSave={async (draft) => {
                const saved = await api.saveList(draft);
                await reload();
                setSelectedListId(saved.id);
                setEditingList(undefined);
              }}
            />
          )}
          {!editingList && list && (
            <section className="adminDetail">
              <div className="eventForm">
                <div className="priceVersionListHeader">
                  <div><h2>{list.name}</h2><p className="fieldHint">{list.code}{list.note ? ` · ${list.note}` : ""}</p></div>
                  <div className="assetActions">
                    <button type="button" className="secondaryButton" onClick={() => setEditingList("edit")}>Upravit ceník</button>
                    <button type="button" className="primaryButton" disabled={busy} onClick={() => run(() => api.createVersion(list.id), "Vznikl nový prázdný koncept.", (id) => setSelectedVersionId(id as string))}>+ Nová prázdná verze</button>
                  </div>
                </div>
                <h3>Realizační firmy nakupující podle tohoto ceníku</h3>
                {register.companies.length === 0 && <p className="fieldHint">Zatím není založená žádná realizační firma (Administrace → Realizační firmy).</p>}
                <div className="priceVersionCompanies">
                  {register.companies.map((company) => {
                    const link = register.links.find((candidate) => candidate.realizationCompanyId === company.id && candidate.isActive);
                    const linkedHere = link?.priceListId === list.id;
                    const linkedElsewhere = Boolean(link) && !linkedHere;
                    return (
                      <label key={company.id} className="checkLabel">
                        <input type="checkbox" checked={linkedHere} disabled={busy || linkedElsewhere} onChange={(event) => run(() => api.linkCompany(list.id, company.id, event.target.checked), event.target.checked ? `${company.name} nakupuje podle tohoto ceníku.` : `${company.name} byla od ceníku odpojena.`)} />
                        {company.name}{company.isActive ? "" : " (neaktivní)"}{linkedElsewhere ? ` — nakupuje podle ${register.lists.find((candidate) => candidate.id === link!.priceListId)?.name ?? "jiného ceníku"}` : ""}
                      </label>
                    );
                  })}
                </div>
                <VersionTable versions={versions} selectedId={selectedVersionId} onSelect={(id) => { setSelectedVersionId(id); setCheck(null); setMessage(""); setError(""); }} />
                {message && <p className="saveOk">{message}</p>}
                {error && <p className="uploadError">{error}</p>}
              </div>
            </section>
          )}
          {!editingList && list && version && (
            <section className="adminDetail">
              <div className="eventForm">
                <div className="priceVersionListHeader">
                  <div><h2>{list.name} · {versionTitle(version)}</h2><StatusBadge status={version.status} /></div>
                  <VersionActions
                    version={version}
                    busy={busy}
                    onCheck={() => run(async () => setCheck(await api.checkPublish(version.id)), "Kontrola proběhla.")}
                    onPublish={() => {
                      if (!window.confirm(`Publikovat ${versionTitle(version)}? Publikovaná verze už nepůjde změnit.`)) return;
                      void run(async () => {
                        const result = await api.publishVersion(version.id, version.revision);
                        setCheck({ errors: [], warnings: result.warnings });
                      }, "Verze byla publikována.");
                    }}
                    onDelete={() => {
                      if (!window.confirm("Smazat tento koncept?")) return;
                      void run(() => api.deleteVersion(version.id, version.revision), "Koncept byl smazán.", () => setSelectedVersionId(undefined));
                    }}
                    onArchive={() => {
                      if (!window.confirm("Archivovat verzi?")) return;
                      void run(() => api.archiveVersion(version.id, version.revision), "Verze byla archivována.");
                    }}
                    onCopy={() => run(() => api.createVersion(list.id, { id: version.id, revision: version.revision }), "Vznikla nová verze jako kopie.", (id) => setSelectedVersionId(id as string))}
                  />
                </div>
                <PublishCheckView check={check} />
                <PurchaseVersionEditor key={version.id} version={version} items={register.items} api={api} onChanged={reload} />
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}

type RowDraft = Readonly<{ key: string; catalogItemId: string; purchaseCzk: string; unitCode: string; note: string }>;

let rowCounter = 0;

function PurchaseVersionEditor({ version, items, api, onChanged }: { version: PriceListVersion; items: readonly PricingCatalogItem[]; api: Api; onChanged: () => Promise<void> }) {
  const [rows, setRows] = useState<readonly RowDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [newItemId, setNewItemId] = useState("");
  const [filter, setFilter] = useState("");
  const [revision, setRevision] = useState(version.revision);
  const [reloadKey, setReloadKey] = useState(0);
  const editable = version.status === "draft";
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.loadRows(version.id).then((loaded) => {
      if (cancelled) return;
      setRevision(loaded.version.revision);
      setError("");
      setRows(loaded.entries.map((entry: PurchasePriceEntry) => ({ key: entry.id, catalogItemId: entry.catalogItemId, purchaseCzk: amountText(entry.purchaseCzk), unitCode: entry.unitCode ?? "", note: entry.note ?? "" })));
      setDirty(false);
    }).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Nákupní ceny se nepodařilo načíst.")).finally(() => setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [version.id, version.status, api, reloadKey]);

  function patch(key: string, change: Partial<RowDraft>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      const result = await api.saveRows(version.id, revision, rows.map((row) => ({ catalogItemId: row.catalogItemId, purchaseCzk: row.purchaseCzk, unitCode: row.unitCode || undefined, note: row.note || undefined })) as unknown as PurchaseEntryInput[]);
      setRevision(result.revision);
      setDirty(false);
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Nákupní ceny se nepodařilo uložit.");
      if (isPriceVersionConflict(caught)) setConflict(true);
    } finally {
      setSaving(false);
    }
  }

  const used = new Set(rows.map((row) => row.catalogItemId));
  return (
    <>
      {conflict && <div className="priceVersionConflict"><strong>Konflikt úprav — nic nebylo uloženo.</strong><button type="button" className="secondaryButton" onClick={() => { if (!dirty || window.confirm("Načíst aktuální stav? Vaše neuložené změny se zahodí.")) { setConflict(false); setReloadKey((key) => key + 1); void onChanged(); } }}>Načíst aktuální stav</button></div>}
      <VersionHeaderForm version={{ ...version, revision }} showEur={false} onSave={async (header) => { try { const result = await api.updateVersion(version.id, revision, header); setRevision(result.revision); await onChanged(); } catch (caught) { if (isPriceVersionConflict(caught)) setConflict(true); throw caught; } }} />
      <div className="eventSaveBar">
        <span className={dirty ? "dirty" : "saved"}>{saving ? "Ukládám…" : dirty ? "Neuložené změny" : editable ? "Uloženo" : "Publikovaná verze je jen pro čtení"}</span>
        {editable && <button type="button" className="primaryButton" onClick={save} disabled={!dirty || saving}>Uložit nákupní ceny</button>}
      </div>
      {error && <p className="uploadError">{error}</p>}
      {!loading && <div className="adminFilters"><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Hledat podle ABF / generátorového kódu nebo názvu…" /></div>}
      {loading ? <p className="workspaceEmpty">Načítám…</p> : (
        <table className="priceVersionTable priceVersionRows">
          <thead><tr><th className="priceItemCodeHead">Kód</th><th>Položka</th><th>Nákupní cena Kč bez DPH</th><th>Jednotka</th><th>Poznámka</th>{editable && <th />}</tr></thead>
          <tbody>
            {rows.filter((row) => matchesPriceItemSearch(itemById.get(row.catalogItemId), filter)).slice().sort((a, b) => comparePriceItemsByCode(itemById.get(a.catalogItemId), itemById.get(b.catalogItemId))).map((row) => (
              <tr key={row.key}>
                <ItemCodeCell item={itemById.get(row.catalogItemId)} />
                <td>{itemById.get(row.catalogItemId)?.displayName ?? row.catalogItemId}</td>
                <td><input value={row.purchaseCzk} onChange={(event) => patch(row.key, { purchaseCzk: event.target.value })} disabled={!editable} inputMode="decimal" /></td>
                <td><input value={row.unitCode} onChange={(event) => patch(row.key, { unitCode: event.target.value })} disabled={!editable} className="priceVersionUnit" /></td>
                <td><input value={row.note} onChange={(event) => patch(row.key, { note: event.target.value })} disabled={!editable} /></td>
                {editable && <td><button type="button" className="linkButton" onClick={() => { setRows((current) => current.filter((candidate) => candidate.key !== row.key)); setDirty(true); }}>Odebrat</button></td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editable && (
        <div className="priceVersionAddRow">
          <select value={newItemId} onChange={(event) => setNewItemId(event.target.value)}>
            <option value="">— vyberte položku katalogu —</option>
            {items.filter((item) => item.lifecycleStatus !== "archived").map((item) => <option key={item.id} value={item.id} disabled={used.has(item.id)}>{itemLabel(item, item.id)}</option>)}
          </select>
          <button type="button" className="secondaryButton" disabled={!newItemId} onClick={() => { const item = itemById.get(newItemId); setRows([...rows, { key: `new-${++rowCounter}`, catalogItemId: newItemId, purchaseCzk: "", unitCode: item?.unitCode ?? "", note: "" }]); setNewItemId(""); setDirty(true); }}>+ Přidat položku</button>
        </div>
      )}
    </>
  );
}
