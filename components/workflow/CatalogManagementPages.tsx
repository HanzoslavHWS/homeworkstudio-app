import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { realizationCompanies } from "../../data/organizations";
import {
  eventCoverImageUrl,
  createEventDocumentFromAsset,
  eventHasUnsavedChanges,
  eventLogoUrl,
  type EventDeadline,
  type EventDocument,
  type Exhibition,
  type PriceList,
} from "../../domain/organizations";
import type { StoredAsset } from "../../domain/assets";
import { getAssetDownloadUrl, uploadAsset, type UploadProgress } from "../../lib/storage/assetClient";
import { useAssetUrl } from "../../hooks/useAssetUrl";
import { ConcurrencyConflictError } from "../../lib/db/concurrency";
import type { CatalogItemSummary } from "../../domain/catalogPricing";
import type { PricingEntryAdmin } from "../../domain/pricingAdmin";
import type { RemoteApiPricingAdminRepository } from "../../lib/db/pricingAdmin.remoteApi.client";
import { DuplicatePriceListDialog, PriceListPricingTable } from "./PricingAdminPages";
import { EventPricingSection, EventSettingsSections } from "./events/EventSettingsSections";
import {
  EVENT_DEADLINE_AUDIENCE_LABELS_CS,
  EVENT_DEADLINE_AUDIENCES,
  EVENT_DEADLINE_KIND_LABELS_CS,
  EVENT_DEADLINE_KINDS,
  EVENT_SHORT_CODE_EXAMPLE,
  eventDateWarnings,
  eventShortCodeIssue,
  normalizeEventShortCode,
} from "../../domain/eventAdmin";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/ui/workspace";

export function EventLogo({ event, compact = false }: { event?: Exhibition; compact?: boolean }) {
  return <EventMediaPreview asset={event?.logoAsset} url={event?.logoUrl} label="Logo výstavy" compact={compact} />;
}

function EventMediaPreview({ asset, url, label, compact = false, onOpen }: { asset?: StoredAsset; url?: string; label: string; compact?: boolean; onOpen?: (url: string) => void }) {
  const [failed, setFailed] = useState("");
  const resolved = useAssetUrl(asset, url);
  const available = Boolean(resolved.url && failed !== resolved.url);
  return <button type="button" className={`eventMediaPreview ${compact ? "compact" : ""}`} onClick={() => resolved.url && onOpen?.(resolved.url)} disabled={!available || !onOpen}>{available ? <img src={resolved.url} alt={label} onError={() => setFailed(resolved.url!)} /> : <span>{resolved.loading ? "Načítám…" : label}</span>}</button>;
}

export function EventsPage({ events, priceLists, onChange, onSave, onDirtyChange, initialSelectedId, renderEventExtras, actorName }: { events: readonly Exhibition[]; priceLists: readonly PriceList[]; onChange: (events: Exhibition[]) => void; onSave: (event: Exhibition) => Promise<Exhibition | void>; /** Name recorded with price list assignments. */ actorName?: string; onDirtyChange?: (dirty: boolean) => void; /** Opens this event instead of the first one (e.g. from a task's "Otevřít akci"). */ initialSelectedId?: string; /** Extra per-event content under the save bar (the Úkoly summary). */ renderEventExtras?: (eventId: string) => ReactNode }) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(initialSelectedId && events.some((event) => event.id === initialSelectedId) ? initialSelectedId : events[0]?.id ?? "");
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
      const stored = await onSave(selected);
      savedEventsRef.current.set(selected.id, stored || selected);
      setSaveState("saved");
      onDirtyChange?.(false);
    } catch (error) {
      setSaveState("dirty");
      const message = error instanceof ConcurrencyConflictError
        ? "Data byla mezitím změněna jinde. Obnovte stránku před uložením."
        : error instanceof Error && error.message && !/^HTTP/u.test(error.message)
          ? error.message
          : "Event se nepodařilo uložit. Uploadovaná data v R2 zůstávají bezpečně zachována.";
      setUploadStates((current) => ({ ...current, save: { state: "error", percent: 0, message } }));
    }
  }

  return <div className="adminPage">
    <PageHeader title="Výstavy / eventy" actions={<><Button variant="default" onClick={() => setAdding(true)}>+ Přidat event</Button></>} />
    <div className="adminFilters"><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Hledat výstavu, slug, místo nebo rok…" /></div>
    {adding && <div className="inlineCreate"><span>Nový event použije předvídatelné cesty logo.png a cover.png.</span><Button type="button" variant="outline" onClick={addEvent}>Vytvořit lokální event</Button></div>}
    <div className="adminSplit"><div className="adminList">{filtered.map((event) => <button key={event.id} className={event.id === selectedId ? "active" : ""} onClick={() => selectEvent(event.id)}><strong>{event.name}</strong><span>{event.year} · {event.venue || "Místo neuvedeno"}</span></button>)}</div>
      {selected && <section className="adminDetail eventDetail min-w-0">
        <div className="eventSaveBar"><span className={saveState}>{saveState === "dirty" ? "Neuložené změny" : saveState === "saving" ? "Ukládám…" : "Uloženo"}{uploadStates.save?.message && <small className="uploadError">{uploadStates.save.message}</small>}</span><Button variant="default" type="button" onClick={saveSelected} disabled={!dirty || saveState === "saving"}>Uložit změny</Button></div>
        {renderEventExtras?.(selected.id)}
        <div className="eventMediaArea grid-cols-1 sm:grid-cols-[minmax(150px,.65fr)_minmax(240px,1.35fr)]">
          <MediaEditor label="Logo" asset={selected.logoAsset} url={selected.logoUrl} progress={uploadStates.logo} onOpen={(url) => setLightbox({ url, label: "Logo" })} onFile={(file) => persistentMedia("logo", file)} onRetry={() => persistentMedia("logo", retryFilesRef.current.get("logo"))} onRemove={() => update({ logoUrl: "", logoAsset: undefined, logoMetadata: undefined })} />
          <MediaEditor label="Cover / banner" asset={selected.coverImageAsset} url={selected.coverImageUrl} progress={uploadStates.cover} wide onOpen={(url) => setLightbox({ url, label: "Cover" })} onFile={(file) => persistentMedia("cover", file)} onRetry={() => persistentMedia("cover", retryFilesRef.current.get("cover"))} onRemove={() => update({ coverImageUrl: "", coverImageAsset: undefined, coverImageMetadata: undefined })} />
        </div>
        <p className="mb-4 max-w-5xl text-sm text-muted-foreground">Nová média se ukládají přímo do privátního R2. Odstranění zde odebere bezpečně metadata; fyzický objekt zůstává zachován do zavedení globálního reference trackingu.</p>
        <div className="eventForm min-w-0 grid-cols-[minmax(0,1fr)]">
          <label><span>Název</span><Input value={selected.name} onChange={(event) => update({ name: event.target.value })} /></label>
          <div className="threeColumns grid-cols-1 sm:grid-cols-3"><label><span>Slug</span><Input value={selected.slug} onChange={(event) => { const slug = event.target.value; update({ slug, logoUrl: eventLogoUrl(slug), coverImageUrl: eventCoverImageUrl(slug) }); }} /></label><label><span>Rok</span><Input type="number" value={selected.year} onChange={(event) => update({ year: Number(event.target.value) })} /></label><label><span>Edice</span><Input value={selected.edition} onChange={(event) => update({ edition: event.target.value })} /></label></div>
          <ShortCodeField value={selected.shortCode} savedValue={savedEventsRef.current.get(selected.id)?.shortCode} onChange={(shortCode) => update({ shortCode })} />
          <label><span>Místo konání</span><Input value={selected.venue} onChange={(event) => update({ venue: event.target.value })} /></label>
          <div className="fourColumns grid-cols-2 md:grid-cols-4"><DateField label="Montáž" value={selected.assemblyDate} onChange={(assemblyDate) => update({ assemblyDate })} /><DateField label="Od" value={selected.eventFrom} onChange={(eventFrom) => update({ eventFrom })} /><DateField label="Do" value={selected.eventTo} onChange={(eventTo) => update({ eventTo })} /><DateField label="Demontáž" value={selected.disassemblyDate} onChange={(disassemblyDate) => update({ disassemblyDate })} /></div>
          <div className="twoColumns grid-cols-1 sm:grid-cols-2"><DateField label="Deadline dodání materiálů / dat" value={selected.materialDataDeadline} onChange={(materialDataDeadline) => update({ materialDataDeadline })} /><DateField label="Deadline odsouhlasení návrhu stavby" value={selected.designApprovalDeadline} onChange={(designApprovalDeadline) => update({ designApprovalDeadline })} /></div>
          {eventDateWarnings(selected).map((warning) => <p key={warning} className="fieldHint">⚠ {warning}</p>)}
          <DeadlinesEditor deadlines={selected.deadlines} onChange={(deadlines) => update({ deadlines })} />
          <EventSettingsSections key={`settings-${selected.id}-${savedEventsRef.current.has(selected.id) ? "saved" : "new"}`} eventId={selected.id} legacyRealizationCompanyId={selected.realizationCompanyId} />
          <EventPricingSection key={`pricing-${selected.id}-${savedEventsRef.current.has(selected.id) ? "saved" : "new"}`} eventId={selected.id} actorName={actorName} />
          <section className="eventSettingsSection eventLegacySection">
          <h3>Starší ceníky (generátor, do V1-DATA-07)</h3>
          <p className="fieldHint">Stávající projekty a generátor zatím počítají z těchto ceníků. Ponecháno kvůli kompatibilitě, nové ceny se přiřazují výše.</p>
          <div className="twoColumns grid-cols-1 sm:grid-cols-2"><label><span>Výchozí ceník</span><NativeSelect value={selected.defaultPriceListId ?? ""} onChange={(event) => update({ defaultPriceListId: event.target.value || undefined })}><option value="">Bez výchozího ceníku</option>{priceLists.filter((list) => selected.priceListIds.includes(list.id)).map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}</NativeSelect></label></div>
          <label><span>Dostupné ceníky</span><select multiple value={[...selected.priceListIds]} onChange={(event) => { const priceListIds = [...event.target.selectedOptions].map((option) => option.value); update({ priceListIds, defaultPriceListId: priceListIds.includes(selected.defaultPriceListId ?? "") ? selected.defaultPriceListId : priceListIds[0] }); }}>{priceLists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}</select></label>
          </section>
          <label><span>Důležité informace</span><Textarea value={selected.importantInfo} onChange={(event) => update({ importantInfo: event.target.value })} /></label>
          <label><span>Interní poznámky</span><Textarea value={selected.notes.internalNote} onChange={(event) => update({ notes: { ...selected.notes, internalNote: event.target.value } })} /></label>
          <section className="eventDocuments"><div className="eventDocumentsHeader"><div><strong>Dokumenty pro vystavovatele</strong><small>Multi-upload ukládá soubory do R2; title, kategorie, jazyk a aktivita zůstávají samostatně editovatelné.</small></div><label className="smallUploadButton">+ Přidat dokumenty<input type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.txt" onChange={(event) => { void addDocuments(event.target.files ?? undefined); event.target.value = ""; }} /></label></div><div className="eventDocumentDefaults"><label><span>Výchozí kategorie dávky</span><NativeSelect value={documentCategory} onChange={(event) => setDocumentCategory(event.target.value)}><option value="application">Přihláška</option><option value="technical">Technické podmínky</option><option value="manual">Manuál</option><option value="instructions">Instrukce</option><option value="other">Ostatní</option></NativeSelect></label><label><span>Výchozí jazyk</span><NativeSelect value={documentLanguage} onChange={(event) => setDocumentLanguage(event.target.value as typeof documentLanguage)}><option value="">Neuveden</option><option value="cs">Čeština</option><option value="en">English</option></NativeSelect></label></div><div className="eventDocumentDropzone" onDragOver={(event) => event.preventDefault()} onDrop={dropDocuments}>Přetáhněte sem více dokumentů najednou</div><UploadBatchStatus states={uploadStates} onRetry={() => void addDocuments([...retryFilesRef.current].filter(([key]) => key.startsWith("document-")).map(([, file]) => file))} />{selected.documents.length ? selected.documents.map((document) => <div className="eventDocumentRow" key={document.id}><div><Input value={document.title} onChange={(event) => update({ documents: selected.documents.map((item) => item.id === document.id ? { ...item, title: event.target.value } : item) })} /><NativeSelect value={document.category} onChange={(event) => update({ documents: selected.documents.map((item) => item.id === document.id ? { ...item, category: event.target.value } : item) })}><option value="application">Přihláška</option><option value="technical">Technické podmínky</option><option value="manual">Manuál</option><option value="instructions">Instrukce</option><option value="other">Ostatní</option></NativeSelect><NativeSelect value={document.language ?? ""} onChange={(event) => update({ documents: selected.documents.map((item) => item.id === document.id ? { ...item, language: (event.target.value || undefined) as EventDocument["language"] } : item) })}><option value="">—</option><option value="cs">CS</option><option value="en">EN</option></NativeSelect><label className="checkLabel"><input type="checkbox" checked={document.active} onChange={(event) => update({ documents: selected.documents.map((item) => item.id === document.id ? { ...item, active: event.target.checked } : item) })} /> Aktivní</label></div><span>{document.fileName} · {document.size ? `${formatFileSize(document.size)} · ` : ""}{document.mimeType} · {document.storageKey ? "R2" : document.availability === "temporary-session" ? "legacy dočasné" : "legacy uložené"}</span><div className="eventDocumentActions"><Button variant="outline" size="sm" type="button" onClick={() => void openDocument(document)}>Otevřít</Button><Button variant="outline" size="sm" type="button" onClick={() => update({ documents: selected.documents.filter((item) => item.id !== document.id) })}>Odebrat</Button></div>{uploadStates[`open-${document.id}`]?.message && <small className="uploadError">{uploadStates[`open-${document.id}`]?.message}</small>}</div>) : <p className="workspaceEmpty">Bez dokumentů.</p>}</section>
          <label className="checkLabel"><input type="checkbox" checked={selected.active} onChange={(event) => update({ active: event.target.checked })} /> Aktivní event</label>
        </div>
      </section>}
    </div>
    {lightbox && <div className="eventMediaLightbox" role="dialog" aria-modal="true" onClick={() => setLightbox(null)}><div onClick={(event) => event.stopPropagation()}><Button variant="outline" size="sm" onClick={() => setLightbox(null)} aria-label="Zavřít">×</Button><img src={lightbox.url} alt={lightbox.label} /></div></div>}
  </div>;
}

function MediaEditor({ label, asset, url, progress, wide, onOpen, onFile, onRetry, onRemove }: { label: string; asset?: StoredAsset; url?: string; progress?: UploadProgress; wide?: boolean; onOpen: (url: string) => void; onFile: (file?: File) => void; onRetry: () => void; onRemove: () => void }) {
  const present = Boolean(asset || url);
  return <div className={`eventMediaEditor ${wide ? "wide" : ""}`}><span>{label}</span><EventMediaPreview asset={asset} url={url} label={label} onOpen={onOpen} /><div><label className="smallUploadButton">{present ? "Změnit" : "Nahrát"}<input type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/svg+xml" onChange={(event) => { onFile(event.target.files?.[0]); event.target.value = ""; }} /></label>{present && <Button variant="outline" size="sm" type="button" onClick={onRemove}>Odstranit</Button>}</div>{progress && <div className={`assetUploadState ${progress.state}`}><progress max="100" value={progress.percent} /><span>{progress.state === "uploading" ? `Nahrávám ${progress.percent} %` : progress.state === "success" ? "Nahráno do R2" : progress.message}</span>{progress.state === "error" && <Button variant="outline" size="sm" type="button" onClick={onRetry}>Zkusit znovu</Button>}</div>}</div>;
}

function UploadBatchStatus({ states, onRetry }: { states: Readonly<Record<string, UploadProgress>>; onRetry: () => void }) {
  const documentStates = Object.entries(states).filter(([key]) => key.startsWith("document-"));
  if (!documentStates.length) return null;
  const errors = documentStates.filter(([, state]) => state.state === "error");
  const uploading = documentStates.filter(([, state]) => state.state === "uploading");
  return <div className={`assetUploadState ${errors.length ? "error" : uploading.length ? "uploading" : "success"}`}><span>{errors.length ? `${errors.length} souborů se nepodařilo nahrát.` : uploading.length ? `Nahrávám ${uploading.length} souborů…` : "Dokumenty byly nahrány do R2."}</span>{errors.length > 0 && <Button variant="outline" size="sm" type="button" onClick={onRetry}>Opakovat neúspěšné</Button>}</div>;
}

function formatFileSize(size: number): string {
  return size < 1_000_000 ? `${Math.round(size / 1000)} kB` : `${(size / 1_000_000).toFixed(1)} MB`;
}

export function PriceListsPage({ priceLists, events, catalogItems, pricingAdminRepository, onChange, onSave }: { priceLists: readonly PriceList[]; events: readonly Exhibition[]; catalogItems: readonly CatalogItemSummary[]; pricingAdminRepository: RemoteApiPricingAdminRepository; onChange: (lists: PriceList[]) => void; onSave?: (priceList: PriceList) => Promise<PriceList> }) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(priceLists[0]?.id ?? "");
  const [saveState, setSaveState] = useState<"saved" | "saving" | "dirty">("saved");
  const [saveErrorMessage, setSaveErrorMessage] = useState("");
  const [entries, setEntries] = useState<readonly PricingEntryAdmin[]>([]);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const savedListsRef = useRef(new Map(priceLists.map((list) => [list.id, list])));
  const selected = priceLists.find((item) => item.id === selectedId);
  const filtered = priceLists.filter((item) => `${item.name} ${item.code} ${item.year} ${item.edition ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  const update = (patch: Partial<PriceList>) => selected && onChange(priceLists.map((item) => item.id === selected.id ? { ...item, ...patch } : item));
  const dirty = Boolean(selected) && JSON.stringify(savedListsRef.current.get(selectedId) ?? null) !== JSON.stringify(selected ?? null);
  const selectedEvent = selected ? events.find((event) => event.id === selected.eventId || event.priceListIds.includes(selected.id)) : undefined;

  useEffect(() => {
    setSaveState(dirty ? "dirty" : "saved");
  }, [dirty]);

  useEffect(() => {
    if (!selectedId) { setEntries([]); return; }
    let cancelled = false;
    setEntriesLoading(true);
    pricingAdminRepository.listEntries({ priceListIds: [selectedId] })
      .then((result) => { if (!cancelled) setEntries(result); })
      .catch(() => { if (!cancelled) setEntries([]); })
      .finally(() => { if (!cancelled) setEntriesLoading(false); });
    return () => { cancelled = true; };
  }, [selectedId, pricingAdminRepository]);

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

  return <div className="adminPage"><PageHeader title="Ceníky" actions={<><Button variant="default" onClick={add}>+ Přidat ceník</Button></>} /><div className="adminFilters"><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Hledat ceník, kód, edici nebo rok…" /></div><div className="adminSplit"><div className="adminList">{filtered.map((list) => <button key={list.id} className={list.id === selectedId ? "active" : ""} onClick={() => selectList(list.id)}><strong>{list.name}</strong><span>{list.code} · {list.year} · {list.active ? "Aktivní" : "Archiv"}</span></button>)}</div>{selected && <section className="adminDetail eventForm min-w-0 grid-cols-[minmax(0,1fr)]">{onSave && <div className="eventSaveBar"><span className={saveState}>{saveState === "dirty" ? "Neuložené změny" : saveState === "saving" ? "Ukládám…" : "Uloženo"}{saveErrorMessage && <small className="uploadError">{saveErrorMessage}</small>}</span><Button variant="default" type="button" onClick={saveSelected} disabled={!dirty || saveState === "saving"}>Uložit změny</Button></div>}<label><span>Název</span><Input value={selected.name} onChange={(event) => update({ name: event.target.value })} /></label><div className="threeColumns grid-cols-1 sm:grid-cols-3"><label><span>Kód</span><Input value={selected.code} onChange={(event) => update({ code: event.target.value })} /></label><label><span>Rok</span><Input type="number" value={selected.year} onChange={(event) => update({ year: Number(event.target.value) })} /></label><label><span>Edice</span><Input value={selected.edition ?? ""} onChange={(event) => update({ edition: event.target.value || undefined })} /></label></div><div className="twoColumns grid-cols-1 sm:grid-cols-2"><label><span>Měna</span><NativeSelect value={selected.currency} onChange={(event) => update({ currency: event.target.value as PriceList["currency"] })}><option>CZK</option><option>EUR</option></NativeSelect></label><label><span>Event</span><Input value={selectedEvent?.name ?? "Nepřiřazeno k žádnému eventu"} readOnly disabled /></label></div><div className="twoColumns grid-cols-1 sm:grid-cols-2"><label><span>Realizačka</span><NativeSelect value={selected.realizationCompanyId ?? ""} onChange={(event) => update({ realizationCompanyId: event.target.value || undefined })}><option value="">Všechny</option>{realizationCompanies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</NativeSelect></label><label><span>Stav</span><label className="checkLabel"><input type="checkbox" checked={selected.active} onChange={(event) => update({ active: event.target.checked })} /> Aktivní; vypnuté ceníky zůstávají v archivu</label></label></div><div className="twoColumns grid-cols-1 sm:grid-cols-2"><DateField label="Platnost od" value={selected.validFrom} onChange={(validFrom) => update({ validFrom })} /><DateField label="Platnost do" value={selected.validTo} onChange={(validTo) => update({ validTo })} /></div>
    <PriceListPricingTable
      priceList={selected}
      entries={entries}
      catalogItems={catalogItems}
      loading={entriesLoading}
      onSaveEdits={(edits) => pricingAdminRepository.saveEntries(edits)}
      onOpenDuplicate={() => setDuplicateOpen(true)}
    />
    {duplicateOpen && <DuplicatePriceListDialog
      sourcePriceList={selected}
      sourceEntries={entries}
      existingCodes={priceLists.map((list) => list.code)}
      events={events}
      realizationCompanies={realizationCompanies}
      onConfirm={(draft) => pricingAdminRepository.duplicatePriceList(selected.id, draft)}
      onClose={() => setDuplicateOpen(false)}
    />}
  </section>}</div></div>;
}

function DateField({ label, value, onChange }: { label: string; value?: string; onChange: (value: string | undefined) => void }) {
  return <label><span>{label}</span><Input type="date" value={value ?? ""} onChange={(event) => onChange(event.target.value || undefined)} /></label>;
}

/** Optional stable short code (V1-DATA-06). Editable until first saved, then fixed. */
function ShortCodeField({ value, savedValue, onChange }: { value?: string; savedValue?: string; onChange: (value: string | undefined) => void }) {
  const issue = eventShortCodeIssue(normalizeEventShortCode(value));
  if (savedValue) {
    return <label><span>Kód veletrhu</span><Input value={savedValue} readOnly disabled /><small className="fieldHint">Uložený kód je neměnný (změna jen řízeným postupem).</small></label>;
  }
  return (
    <label>
      <span>Kód veletrhu (nepovinný)</span>
      <Input value={value ?? ""} placeholder={`např. ${EVENT_SHORT_CODE_EXAMPLE}`} onChange={(event) => onChange(event.target.value.toUpperCase() || undefined)} />
      {issue ? <small className="uploadError">{issue}</small> : <small className="fieldHint">Stabilní krátký kód pro složky a budoucí zakázky. Nezávisí na názvu ani na cestě na disku; po uložení ho už nelze změnit.</small>}
    </label>
  );
}

/** Free-form deadlines with an optional type and audience (V1-DATA-06). */
function DeadlinesEditor({ deadlines, onChange }: { deadlines: Exhibition["deadlines"]; onChange: (deadlines: Exhibition["deadlines"]) => void }) {
  const patch = (id: string, change: Partial<EventDeadline>) => onChange(deadlines.map((item) => (item.id === id ? { ...item, ...change } : item)));
  return (
    <div className="deadlineEditor eventDeadlines">
      <div><strong>Další uzávěrky</strong><Button variant="outline" size="sm" type="button" onClick={() => onChange([...deadlines, { id: `deadline-${Date.now()}`, name: "Nová uzávěrka", date: "" }])}>+ Přidat</Button></div>
      {deadlines.map((deadline) => (
        <div key={deadline.id} className="eventDeadlineRow">
          <Input value={deadline.name} onChange={(event) => patch(deadline.id, { name: event.target.value })} />
          <Input type="date" value={deadline.date} onChange={(event) => patch(deadline.id, { date: event.target.value })} />
          <NativeSelect value={deadline.kind ?? ""} onChange={(event) => patch(deadline.id, { kind: (event.target.value || undefined) as EventDeadline["kind"] })}>
            <option value="">Typ —</option>
            {EVENT_DEADLINE_KINDS.map((kind) => <option key={kind} value={kind}>{EVENT_DEADLINE_KIND_LABELS_CS[kind]}</option>)}
          </NativeSelect>
          <NativeSelect value={deadline.audience ?? ""} onChange={(event) => patch(deadline.id, { audience: (event.target.value || undefined) as EventDeadline["audience"] })}>
            <option value="">Pro koho —</option>
            {EVENT_DEADLINE_AUDIENCES.map((audience) => <option key={audience} value={audience}>{EVENT_DEADLINE_AUDIENCE_LABELS_CS[audience]}</option>)}
          </NativeSelect>
          <Button variant="outline" size="sm" type="button" onClick={() => { if (window.confirm(`Odebrat uzávěrku „${deadline.name}“?`)) onChange(deadlines.filter((item) => item.id !== deadline.id)); }}>Odebrat</Button>
        </div>
      ))}
    </div>
  );
}
