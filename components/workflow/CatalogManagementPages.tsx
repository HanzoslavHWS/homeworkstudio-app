import { useEffect, useRef, useState, type DragEvent } from "react";
import { realizationCompanies } from "../../data/organizations";
import {
  eventCoverImageUrl,
  createEventDocumentFromAsset,
  eventHasUnsavedChanges,
  eventLogoUrl,
  type EventDocument,
  type Exhibition,
  type PriceList,
} from "../../domain/organizations";
import type { StoredAsset } from "../../domain/assets";
import { getAssetDownloadUrl, uploadAsset, type UploadProgress } from "../../lib/storage/assetClient";
import { useAssetUrl } from "../../hooks/useAssetUrl";
import { ConcurrencyConflictError } from "../../lib/db/concurrency";

export function EventLogo({ event, compact = false }: { event?: Exhibition; compact?: boolean }) {
  return <EventMediaPreview asset={event?.logoAsset} url={event?.logoUrl} label="Logo výstavy" compact={compact} />;
}

function EventMediaPreview({ asset, url, label, compact = false, onOpen }: { asset?: StoredAsset; url?: string; label: string; compact?: boolean; onOpen?: (url: string) => void }) {
  const [failed, setFailed] = useState("");
  const resolved = useAssetUrl(asset, url);
  const available = Boolean(resolved.url && failed !== resolved.url);
  return <button type="button" className={`eventMediaPreview ${compact ? "compact" : ""}`} onClick={() => resolved.url && onOpen?.(resolved.url)} disabled={!available || !onOpen}>{available ? <img src={resolved.url} alt={label} onError={() => setFailed(resolved.url!)} /> : <span>{resolved.loading ? "Načítám…" : label}</span>}</button>;
}

export function EventsPage({ events, priceLists, onChange, onSave, onDirtyChange }: { events: readonly Exhibition[]; priceLists: readonly PriceList[]; onChange: (events: Exhibition[]) => void; onSave: (event: Exhibition) => Promise<void>; onDirtyChange?: (dirty: boolean) => void }) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(events[0]?.id ?? "");
  const [adding, setAdding] = useState(false);
  const [lightbox, setLightbox] = useState<{ url: string; label: string } | null>(null);
  const [documentCategory, setDocumentCategory] = useState("other");
  const [documentLanguage, setDocumentLanguage] = useState<"" | "cs" | "en">("");
  const [saveState, setSaveState] = useState<"saved" | "saving" | "dirty">("saved");
  const [uploadStates, setUploadStates] = useState<Record<string, UploadProgress>>({});
  const retryFilesRef = useRef(new Map<string, File>());
  const savedEventsRef = useRef(new Map(events.map((event) => [event.id, event])));
  const selected = events.find((event) => event.id === selectedId);
  const filtered = events.filter((event) => `${event.name} ${event.slug} ${event.venue} ${event.year}`.toLocaleLowerCase("cs").includes(query.toLocaleLowerCase("cs")));
  const update = (patch: Partial<Exhibition>) => selected && onChange(events.map((event) => event.id === selected.id ? { ...event, ...patch } : event));
  const dirty = eventHasUnsavedChanges(savedEventsRef.current.get(selectedId), selected);

  useEffect(() => {
    setSaveState(dirty ? "dirty" : "saved");
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  function selectEvent(id: string) {
    if (id === selectedId) return;
    if (dirty && !window.confirm("Máte neuložené změny. Opravdu chcete pokračovat?")) return;
    setSelectedId(id);
  }

  function addEvent() {
    const id = `event-${Date.now()}`;
    const created: Exhibition = {
      id,
      slug: id,
      name: "Nová výstava",
      edition: "",
      year: new Date().getFullYear(),
      venue: "",
      logoUrl: eventLogoUrl(id),
      coverImageUrl: eventCoverImageUrl(id),
      deadlines: [],
      materialDataDeadline: "",
      designApprovalDeadline: "",
      documents: [],
      notes: { internalNote: "", customerNote: "" },
      importantInfo: "",
      defaultCurrency: "CZK",
      priceListIds: [],
      realizationCompanyId: "default",
      active: true,
    };
    onChange([...events, created]);
    setSelectedId(id);
    setAdding(false);
  }

  async function persistentMedia(kind: "logo" | "cover", file?: File) {
    if (!file) return;
    if (!selected) return;
    retryFilesRef.current.set(kind, file);
    try {
      const asset = await uploadAsset(file, { category: kind === "logo" ? "event-logo" : "event-cover", ownerId: selected.slug || selected.id }, (state) => setUploadStates((current) => ({ ...current, [kind]: state })));
      const metadata = { fileName: file.name, mimeType: asset.mimeType, size: asset.size, storageKey: asset.storageKey, createdAt: asset.createdAt, availability: "persistent" as const };
      update(kind === "logo" ? { logoAsset: asset, logoUrl: "", logoMetadata: metadata } : { coverImageAsset: asset, coverImageUrl: "", coverImageMetadata: metadata });
      retryFilesRef.current.delete(kind);
    } catch { /* state is rendered next to the uploader */ }
  }

  async function addDocuments(files?: FileList | readonly File[]) {
    if (!selected || !files?.length) return;
    const batch = Array.from(files);
    const results = await Promise.allSettled(batch.map(async (file, index) => {
      const key = `document-${index}-${file.name}`;
      retryFilesRef.current.set(key, file);
      const asset = await uploadAsset(file, { category: "event-document", ownerId: selected.slug || selected.id }, (state) => setUploadStates((current) => ({ ...current, [key]: state })));
      retryFilesRef.current.delete(key);
      return createEventDocumentFromAsset(asset, { category: documentCategory, language: documentLanguage || undefined });
    }));
    const documents = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (documents.length) update({ documents: [...selected.documents, ...documents] });
  }

  function dropDocuments(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    addDocuments(event.dataTransfer.files);
  }

  async function openDocument(document: EventDocument) {
    try {
      const url = document.storageKey ? await getAssetDownloadUrl(document.storageKey) : document.assetUrl;
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      setUploadStates((current) => ({ ...current, [`open-${document.id}`]: { state: "error", percent: 0, message: error instanceof Error ? error.message : "Dokument nelze otevřít." } }));
    }
  }

  async function saveSelected() {
    if (!selected) return;
    setSaveState("saving");
    try {
      await onSave(selected);
      savedEventsRef.current.set(selected.id, selected);
      setSaveState("saved");
      onDirtyChange?.(false);
    } catch (error) {
      setSaveState("dirty");
      const message = error instanceof ConcurrencyConflictError
        ? "Data byla mezitím změněna jinde. Obnovte stránku před uložením."
        : "Event se nepodařilo uložit. Uploadovaná data v R2 zůstávají bezpečně zachována.";
      setUploadStates((current) => ({ ...current, save: { state: "error", percent: 0, message } }));
    }
  }

  return <div className="workspacePage">
    <div className="workspacePageHeader"><div><span className="eyebrow">ADMINISTRACE</span><h1>Výstavy / eventy</h1></div><button className="primaryButton" onClick={() => setAdding(true)}>+ Přidat event</button></div>
    <div className="adminFilters"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Hledat výstavu, slug, místo nebo rok…" /></div>
    {adding && <div className="inlineCreate"><span>Nový event použije předvídatelné cesty logo.png a cover.png.</span><button onClick={addEvent}>Vytvořit lokální event</button></div>}
    <div className="adminSplit"><div className="adminList">{filtered.map((event) => <button key={event.id} className={event.id === selectedId ? "active" : ""} onClick={() => selectEvent(event.id)}><strong>{event.name}</strong><span>{event.year} · {event.venue || "Místo neuvedeno"}</span></button>)}</div>
      {selected && <section className="adminDetail eventDetail">
        <div className="eventSaveBar"><span className={saveState}>{saveState === "dirty" ? "Neuložené změny" : saveState === "saving" ? "Ukládám…" : "Uloženo"}{uploadStates.save?.message && <small className="uploadError">{uploadStates.save.message}</small>}</span><button type="button" className="primaryButton" onClick={saveSelected} disabled={!dirty || saveState === "saving"}>Uložit změny</button></div>
        <div className="eventMediaArea">
          <MediaEditor label="Logo" asset={selected.logoAsset} url={selected.logoUrl} progress={uploadStates.logo} onOpen={(url) => setLightbox({ url, label: "Logo" })} onFile={(file) => persistentMedia("logo", file)} onRetry={() => persistentMedia("logo", retryFilesRef.current.get("logo"))} onRemove={() => update({ logoUrl: "", logoAsset: undefined, logoMetadata: undefined })} />
          <MediaEditor label="Cover / banner" asset={selected.coverImageAsset} url={selected.coverImageUrl} progress={uploadStates.cover} wide onOpen={(url) => setLightbox({ url, label: "Cover" })} onFile={(file) => persistentMedia("cover", file)} onRetry={() => persistentMedia("cover", retryFilesRef.current.get("cover"))} onRemove={() => update({ coverImageUrl: "", coverImageAsset: undefined, coverImageMetadata: undefined })} />
        </div>
        <p className="temporaryNotice">Nová média se ukládají přímo do privátního R2. Odstranění zde odebere bezpečně metadata; fyzický objekt zůstává zachován do zavedení globálního reference trackingu.</p>
        <div className="eventForm">
          <label><span>Název</span><input value={selected.name} onChange={(event) => update({ name: event.target.value })} /></label>
          <div className="threeColumns"><label><span>Slug</span><input value={selected.slug} onChange={(event) => { const slug = event.target.value; update({ slug, logoUrl: eventLogoUrl(slug), coverImageUrl: eventCoverImageUrl(slug) }); }} /></label><label><span>Rok</span><input type="number" value={selected.year} onChange={(event) => update({ year: Number(event.target.value) })} /></label><label><span>Edice</span><input value={selected.edition} onChange={(event) => update({ edition: event.target.value })} /></label></div>
          <label><span>Místo konání</span><input value={selected.venue} onChange={(event) => update({ venue: event.target.value })} /></label>
          <div className="fourColumns"><DateField label="Montáž" value={selected.assemblyDate} onChange={(assemblyDate) => update({ assemblyDate })} /><DateField label="Od" value={selected.eventFrom} onChange={(eventFrom) => update({ eventFrom })} /><DateField label="Do" value={selected.eventTo} onChange={(eventTo) => update({ eventTo })} /><DateField label="Demontáž" value={selected.disassemblyDate} onChange={(disassemblyDate) => update({ disassemblyDate })} /></div>
          <div className="twoColumns"><DateField label="Deadline dodání materiálů / dat" value={selected.materialDataDeadline} onChange={(materialDataDeadline) => update({ materialDataDeadline })} /><DateField label="Deadline odsouhlasení návrhu stavby" value={selected.designApprovalDeadline} onChange={(designApprovalDeadline) => update({ designApprovalDeadline })} /></div>
          <div className="deadlineEditor"><div><strong>Další deadline</strong><button type="button" onClick={() => update({ deadlines: [...selected.deadlines, { id: `deadline-${Date.now()}`, name: "Nový deadline", date: "" }] })}>+ Přidat</button></div>{selected.deadlines.map((deadline) => <div key={deadline.id}><input value={deadline.name} onChange={(event) => update({ deadlines: selected.deadlines.map((item) => item.id === deadline.id ? { ...item, name: event.target.value } : item) })} /><input type="date" value={deadline.date} onChange={(event) => update({ deadlines: selected.deadlines.map((item) => item.id === deadline.id ? { ...item, date: event.target.value } : item) })} /></div>)}</div>
          <div className="twoColumns"><label><span>Realizačka</span><select value={selected.realizationCompanyId ?? "default"} onChange={(event) => update({ realizationCompanyId: event.target.value })}>{realizationCompanies.filter((company) => company.active).map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label><label><span>Výchozí ceník</span><select value={selected.defaultPriceListId ?? ""} onChange={(event) => update({ defaultPriceListId: event.target.value || undefined })}><option value="">Bez výchozího ceníku</option>{priceLists.filter((list) => selected.priceListIds.includes(list.id)).map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}</select></label></div>
          <label><span>Dostupné ceníky</span><select multiple value={[...selected.priceListIds]} onChange={(event) => { const priceListIds = [...event.target.selectedOptions].map((option) => option.value); update({ priceListIds, defaultPriceListId: priceListIds.includes(selected.defaultPriceListId ?? "") ? selected.defaultPriceListId : priceListIds[0] }); }}>{priceLists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}</select></label>
          <label><span>Důležité informace</span><textarea value={selected.importantInfo} onChange={(event) => update({ importantInfo: event.target.value })} /></label>
          <label><span>Interní poznámky</span><textarea value={selected.notes.internalNote} onChange={(event) => update({ notes: { ...selected.notes, internalNote: event.target.value } })} /></label>
          <section className="eventDocuments"><div className="eventDocumentsHeader"><div><strong>Dokumenty pro vystavovatele</strong><small>Multi-upload ukládá soubory do R2; title, kategorie, jazyk a aktivita zůstávají samostatně editovatelné.</small></div><label className="smallUploadButton">+ Přidat dokumenty<input type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.txt" onChange={(event) => { void addDocuments(event.target.files ?? undefined); event.target.value = ""; }} /></label></div><div className="eventDocumentDefaults"><label><span>Výchozí kategorie dávky</span><select value={documentCategory} onChange={(event) => setDocumentCategory(event.target.value)}><option value="application">Přihláška</option><option value="technical">Technické podmínky</option><option value="manual">Manuál</option><option value="instructions">Instrukce</option><option value="other">Ostatní</option></select></label><label><span>Výchozí jazyk</span><select value={documentLanguage} onChange={(event) => setDocumentLanguage(event.target.value as typeof documentLanguage)}><option value="">Neuveden</option><option value="cs">Čeština</option><option value="en">English</option></select></label></div><div className="eventDocumentDropzone" onDragOver={(event) => event.preventDefault()} onDrop={dropDocuments}>Přetáhněte sem více dokumentů najednou</div><UploadBatchStatus states={uploadStates} onRetry={() => void addDocuments([...retryFilesRef.current].filter(([key]) => key.startsWith("document-")).map(([, file]) => file))} />{selected.documents.length ? selected.documents.map((document) => <div className="eventDocumentRow" key={document.id}><div><input value={document.title} onChange={(event) => update({ documents: selected.documents.map((item) => item.id === document.id ? { ...item, title: event.target.value } : item) })} /><select value={document.category} onChange={(event) => update({ documents: selected.documents.map((item) => item.id === document.id ? { ...item, category: event.target.value } : item) })}><option value="application">Přihláška</option><option value="technical">Technické podmínky</option><option value="manual">Manuál</option><option value="instructions">Instrukce</option><option value="other">Ostatní</option></select><select value={document.language ?? ""} onChange={(event) => update({ documents: selected.documents.map((item) => item.id === document.id ? { ...item, language: (event.target.value || undefined) as EventDocument["language"] } : item) })}><option value="">—</option><option value="cs">CS</option><option value="en">EN</option></select><label className="checkLabel"><input type="checkbox" checked={document.active} onChange={(event) => update({ documents: selected.documents.map((item) => item.id === document.id ? { ...item, active: event.target.checked } : item) })} /> Aktivní</label></div><span>{document.fileName} · {document.size ? `${formatFileSize(document.size)} · ` : ""}{document.mimeType} · {document.storageKey ? "R2" : document.availability === "temporary-session" ? "legacy dočasné" : "legacy uložené"}</span><div className="eventDocumentActions"><button type="button" onClick={() => void openDocument(document)}>Otevřít</button><button type="button" onClick={() => update({ documents: selected.documents.filter((item) => item.id !== document.id) })}>Odebrat</button></div>{uploadStates[`open-${document.id}`]?.message && <small className="uploadError">{uploadStates[`open-${document.id}`]?.message}</small>}</div>) : <p className="workspaceEmpty">Bez dokumentů.</p>}</section>
          <label className="checkLabel"><input type="checkbox" checked={selected.active} onChange={(event) => update({ active: event.target.checked })} /> Aktivní event</label>
        </div>
      </section>}
    </div>
    {lightbox && <div className="eventMediaLightbox" role="dialog" aria-modal="true" onClick={() => setLightbox(null)}><div onClick={(event) => event.stopPropagation()}><button onClick={() => setLightbox(null)} aria-label="Zavřít">×</button><img src={lightbox.url} alt={lightbox.label} /></div></div>}
  </div>;
}

function MediaEditor({ label, asset, url, progress, wide, onOpen, onFile, onRetry, onRemove }: { label: string; asset?: StoredAsset; url?: string; progress?: UploadProgress; wide?: boolean; onOpen: (url: string) => void; onFile: (file?: File) => void; onRetry: () => void; onRemove: () => void }) {
  const present = Boolean(asset || url);
  return <div className={`eventMediaEditor ${wide ? "wide" : ""}`}><span>{label}</span><EventMediaPreview asset={asset} url={url} label={label} onOpen={onOpen} /><div><label className="smallUploadButton">{present ? "Změnit" : "Nahrát"}<input type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/svg+xml" onChange={(event) => { onFile(event.target.files?.[0]); event.target.value = ""; }} /></label>{present && <button type="button" onClick={onRemove}>Odstranit</button>}</div>{progress && <div className={`assetUploadState ${progress.state}`}><progress max="100" value={progress.percent} /><span>{progress.state === "uploading" ? `Nahrávám ${progress.percent} %` : progress.state === "success" ? "Nahráno do R2" : progress.message}</span>{progress.state === "error" && <button type="button" onClick={onRetry}>Zkusit znovu</button>}</div>}</div>;
}

function UploadBatchStatus({ states, onRetry }: { states: Readonly<Record<string, UploadProgress>>; onRetry: () => void }) {
  const documentStates = Object.entries(states).filter(([key]) => key.startsWith("document-"));
  if (!documentStates.length) return null;
  const errors = documentStates.filter(([, state]) => state.state === "error");
  const uploading = documentStates.filter(([, state]) => state.state === "uploading");
  return <div className={`assetUploadState ${errors.length ? "error" : uploading.length ? "uploading" : "success"}`}><span>{errors.length ? `${errors.length} souborů se nepodařilo nahrát.` : uploading.length ? `Nahrávám ${uploading.length} souborů…` : "Dokumenty byly nahrány do R2."}</span>{errors.length > 0 && <button type="button" onClick={onRetry}>Opakovat neúspěšné</button>}</div>;
}

function formatFileSize(size: number): string {
  return size < 1_000_000 ? `${Math.round(size / 1000)} kB` : `${(size / 1_000_000).toFixed(1)} MB`;
}

export function PriceListsPage({ priceLists, onChange, onSave }: { priceLists: readonly PriceList[]; onChange: (lists: PriceList[]) => void; onSave?: (priceList: PriceList) => Promise<PriceList> }) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(priceLists[0]?.id ?? "");
  const [saveState, setSaveState] = useState<"saved" | "saving" | "dirty">("saved");
  const [saveErrorMessage, setSaveErrorMessage] = useState("");
  const savedListsRef = useRef(new Map(priceLists.map((list) => [list.id, list])));
  const selected = priceLists.find((item) => item.id === selectedId);
  const filtered = priceLists.filter((item) => `${item.name} ${item.code} ${item.year} ${item.edition ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  const update = (patch: Partial<PriceList>) => selected && onChange(priceLists.map((item) => item.id === selected.id ? { ...item, ...patch } : item));
  const dirty = Boolean(selected) && JSON.stringify(savedListsRef.current.get(selectedId) ?? null) !== JSON.stringify(selected ?? null);

  useEffect(() => {
    setSaveState(dirty ? "dirty" : "saved");
  }, [dirty]);

  function add() { const id = `price-list-${Date.now()}`; const created: PriceList = { id, name: `Nový ceník ${new Date().getFullYear()}`, code: id.toUpperCase(), currency: "CZK", year: new Date().getFullYear(), active: true }; onChange([...priceLists, created]); setSelectedId(id); }

  function selectList(id: string) {
    if (id === selectedId) return;
    if (dirty && !window.confirm("Máte neuložené změny. Opravdu chcete pokračovat?")) return;
    setSelectedId(id);
  }

  async function saveSelected() {
    if (!selected || !onSave) return;
    setSaveState("saving");
    setSaveErrorMessage("");
    try {
      const saved = await onSave(selected);
      savedListsRef.current.delete(selected.id);
      savedListsRef.current.set(saved.id, saved);
      if (saved.id !== selected.id) setSelectedId(saved.id);
      setSaveState("saved");
    } catch (error) {
      setSaveState("dirty");
      setSaveErrorMessage(error instanceof Error ? error.message : "Ceník se nepodařilo uložit.");
    }
  }

  return <div className="workspacePage"><div className="workspacePageHeader"><div><span className="eyebrow">ADMINISTRACE</span><h1>Ceníky</h1></div><button className="primaryButton" onClick={add}>+ Přidat ceník</button></div><div className="adminFilters"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Hledat ceník, kód, edici nebo rok…" /></div><div className="adminSplit"><div className="adminList">{filtered.map((list) => <button key={list.id} className={list.id === selectedId ? "active" : ""} onClick={() => selectList(list.id)}><strong>{list.name}</strong><span>{list.code} · {list.year} · {list.active ? "Aktivní" : "Archiv"}</span></button>)}</div>{selected && <section className="adminDetail eventForm">{onSave && <div className="eventSaveBar"><span className={saveState}>{saveState === "dirty" ? "Neuložené změny" : saveState === "saving" ? "Ukládám…" : "Uloženo"}{saveErrorMessage && <small className="uploadError">{saveErrorMessage}</small>}</span><button type="button" className="primaryButton" onClick={saveSelected} disabled={!dirty || saveState === "saving"}>Uložit změny</button></div>}<label><span>Název</span><input value={selected.name} onChange={(event) => update({ name: event.target.value })} /></label><div className="threeColumns"><label><span>Kód</span><input value={selected.code} onChange={(event) => update({ code: event.target.value })} /></label><label><span>Rok</span><input type="number" value={selected.year} onChange={(event) => update({ year: Number(event.target.value) })} /></label><label><span>Edice</span><input value={selected.edition ?? ""} onChange={(event) => update({ edition: event.target.value || undefined })} /></label></div><div className="twoColumns"><label><span>Měna</span><select value={selected.currency} onChange={(event) => update({ currency: event.target.value as PriceList["currency"] })}><option>CZK</option><option>EUR</option></select></label><label><span>Realizačka</span><select value={selected.realizationCompanyId ?? ""} onChange={(event) => update({ realizationCompanyId: event.target.value || undefined })}><option value="">Všechny</option>{realizationCompanies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label></div><div className="twoColumns"><DateField label="Platnost od" value={selected.validFrom} onChange={(validFrom) => update({ validFrom })} /><DateField label="Platnost do" value={selected.validTo} onChange={(validTo) => update({ validTo })} /></div><label className="checkLabel"><input type="checkbox" checked={selected.active} onChange={(event) => update({ active: event.target.checked })} /> Aktivní; vypnuté ceníky zůstávají v archivu</label></section>}</div></div>;
}

function DateField({ label, value, onChange }: { label: string; value?: string; onChange: (value: string | undefined) => void }) {
  return <label><span>{label}</span><input type="date" value={value ?? ""} onChange={(event) => onChange(event.target.value || undefined)} /></label>;
}
