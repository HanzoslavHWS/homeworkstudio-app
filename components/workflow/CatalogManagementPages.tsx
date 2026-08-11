import { useEffect, useRef, useState, type DragEvent } from "react";
import { realizationCompanies } from "../../data/organizations";
import {
  eventCoverImageUrl,
  createEventDocumentsFromFiles,
  eventHasUnsavedChanges,
  eventLogoUrl,
  type EventDocument,
  type Exhibition,
  type PriceList,
} from "../../domain/organizations";

export function EventLogo({ event, compact = false }: { event?: Exhibition; compact?: boolean }) {
  return <EventMediaPreview url={event?.logoUrl} label="Logo výstavy" compact={compact} />;
}

function EventMediaPreview({ url, label, compact = false, onOpen }: { url?: string; label: string; compact?: boolean; onOpen?: () => void }) {
  const [failed, setFailed] = useState("");
  const available = Boolean(url && failed !== url);
  return <button type="button" className={`eventMediaPreview ${compact ? "compact" : ""}`} onClick={onOpen} disabled={!available || !onOpen}>{available ? <img src={url} alt={label} onError={() => setFailed(url!)} /> : <span>{label}</span>}</button>;
}

export function EventsPage({ events, priceLists, onChange, onSave, onDirtyChange }: { events: readonly Exhibition[]; priceLists: readonly PriceList[]; onChange: (events: Exhibition[]) => void; onSave: (event: Exhibition) => Promise<void>; onDirtyChange?: (dirty: boolean) => void }) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(events[0]?.id ?? "");
  const [adding, setAdding] = useState(false);
  const [lightbox, setLightbox] = useState<{ url: string; label: string } | null>(null);
  const [documentCategory, setDocumentCategory] = useState("other");
  const [documentLanguage, setDocumentLanguage] = useState<"" | "cs" | "en">("");
  const [saveState, setSaveState] = useState<"saved" | "saving" | "dirty">("saved");
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

  function temporaryMedia(field: "logoUrl" | "coverImageUrl", file?: File) {
    if (!file) return;
    const metadata = { fileName: file.name, mimeType: file.type || "application/octet-stream", availability: "temporary-session" as const };
    update({ [field]: URL.createObjectURL(file), [field === "logoUrl" ? "logoMetadata" : "coverImageMetadata"]: metadata });
  }

  function addDocuments(files?: FileList | readonly File[]) {
    if (!selected || !files?.length) return;
    const documents = createEventDocumentsFromFiles(
      Array.from(files),
      { category: documentCategory, language: documentLanguage || undefined },
      (file) => URL.createObjectURL(file as File),
    );
    update({ documents: [...selected.documents, ...documents] });
  }

  function dropDocuments(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    addDocuments(event.dataTransfer.files);
  }

  async function saveSelected() {
    if (!selected) return;
    setSaveState("saving");
    await onSave(selected);
    savedEventsRef.current.set(selected.id, selected);
    setSaveState("saved");
    onDirtyChange?.(false);
  }

  return <div className="workspacePage">
    <div className="workspacePageHeader"><div><span className="eyebrow">ADMINISTRACE</span><h1>Výstavy / eventy</h1></div><button className="primaryButton" onClick={() => setAdding(true)}>+ Přidat event</button></div>
    <div className="adminFilters"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Hledat výstavu, slug, místo nebo rok…" /></div>
    {adding && <div className="inlineCreate"><span>Nový event použije předvídatelné cesty logo.png a cover.png.</span><button onClick={addEvent}>Vytvořit lokální event</button></div>}
    <div className="adminSplit"><div className="adminList">{filtered.map((event) => <button key={event.id} className={event.id === selectedId ? "active" : ""} onClick={() => selectEvent(event.id)}><strong>{event.name}</strong><span>{event.year} · {event.venue || "Místo neuvedeno"}</span></button>)}</div>
      {selected && <section className="adminDetail eventDetail">
        <div className="eventSaveBar"><span className={saveState}>{saveState === "dirty" ? "Neuložené změny" : saveState === "saving" ? "Ukládám…" : "Uloženo"}</span><button type="button" className="primaryButton" onClick={saveSelected} disabled={!dirty || saveState === "saving"}>Uložit změny</button></div>
        <div className="eventMediaArea">
          <MediaEditor label="Logo" url={selected.logoUrl} onOpen={() => selected.logoUrl && setLightbox({ url: selected.logoUrl, label: "Logo" })} onFile={(file) => temporaryMedia("logoUrl", file)} onRemove={() => update({ logoUrl: "" })} />
          <MediaEditor label="Cover / banner" url={selected.coverImageUrl} wide onOpen={() => selected.coverImageUrl && setLightbox({ url: selected.coverImageUrl, label: "Cover" })} onFile={(file) => temporaryMedia("coverImageUrl", file)} onRemove={() => update({ coverImageUrl: "" })} />
        </div>
        <p className="temporaryNotice">Nahraná média jsou pouze dočasný náhled aktuální relace. Trvalé uložení čeká na AssetStorageProvider.</p>
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
          <section className="eventDocuments"><div className="eventDocumentsHeader"><div><strong>Dokumenty pro vystavovatele</strong><small>Soubor je zatím uložen pouze dočasně a po reloadu nebude dostupný. Metadata po uložení zůstanou.</small></div><label className="smallUploadButton">+ Přidat dokumenty<input type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.txt" onChange={(event) => { addDocuments(event.target.files ?? undefined); event.target.value = ""; }} /></label></div><div className="eventDocumentDefaults"><label><span>Výchozí kategorie dávky</span><select value={documentCategory} onChange={(event) => setDocumentCategory(event.target.value)}><option value="application">Přihláška</option><option value="technical">Technické podmínky</option><option value="manual">Manuál</option><option value="instructions">Instrukce</option><option value="other">Ostatní</option></select></label><label><span>Výchozí jazyk</span><select value={documentLanguage} onChange={(event) => setDocumentLanguage(event.target.value as typeof documentLanguage)}><option value="">Neuveden</option><option value="cs">Čeština</option><option value="en">English</option></select></label></div><div className="eventDocumentDropzone" onDragOver={(event) => event.preventDefault()} onDrop={dropDocuments}>Přetáhněte sem více dokumentů najednou</div>{selected.documents.length ? selected.documents.map((document) => <div className="eventDocumentRow" key={document.id}><div><input value={document.title} onChange={(event) => update({ documents: selected.documents.map((item) => item.id === document.id ? { ...item, title: event.target.value } : item) })} /><select value={document.category} onChange={(event) => update({ documents: selected.documents.map((item) => item.id === document.id ? { ...item, category: event.target.value } : item) })}><option value="application">Přihláška</option><option value="technical">Technické podmínky</option><option value="manual">Manuál</option><option value="instructions">Instrukce</option><option value="other">Ostatní</option></select><select value={document.language ?? ""} onChange={(event) => update({ documents: selected.documents.map((item) => item.id === document.id ? { ...item, language: (event.target.value || undefined) as EventDocument["language"] } : item) })}><option value="">—</option><option value="cs">CS</option><option value="en">EN</option></select><label className="checkLabel"><input type="checkbox" checked={document.active} onChange={(event) => update({ documents: selected.documents.map((item) => item.id === document.id ? { ...item, active: event.target.checked } : item) })} /> Aktivní</label></div><span>{document.fileName} · {document.mimeType} · {document.availability === "temporary-session" ? "dočasné" : "uložené"}</span><button onClick={() => update({ documents: selected.documents.filter((item) => item.id !== document.id) })}>Odebrat</button></div>) : <p className="workspaceEmpty">Bez dokumentů.</p>}</section>
          <label className="checkLabel"><input type="checkbox" checked={selected.active} onChange={(event) => update({ active: event.target.checked })} /> Aktivní event</label>
        </div>
      </section>}
    </div>
    {lightbox && <div className="eventMediaLightbox" role="dialog" aria-modal="true" onClick={() => setLightbox(null)}><div onClick={(event) => event.stopPropagation()}><button onClick={() => setLightbox(null)} aria-label="Zavřít">×</button><img src={lightbox.url} alt={lightbox.label} /></div></div>}
  </div>;
}

function MediaEditor({ label, url, wide, onOpen, onFile, onRemove }: { label: string; url?: string; wide?: boolean; onOpen: () => void; onFile: (file?: File) => void; onRemove: () => void }) {
  return <div className={`eventMediaEditor ${wide ? "wide" : ""}`}><span>{label}</span><EventMediaPreview url={url} label={label} onOpen={onOpen} /><div><label className="smallUploadButton">{url ? "Změnit" : "Nahrát"}<input type="file" accept="image/*" onChange={(event) => { onFile(event.target.files?.[0]); event.target.value = ""; }} /></label>{url && <button type="button" onClick={onRemove}>Odstranit</button>}</div></div>;
}

export function PriceListsPage({ priceLists, onChange }: { priceLists: readonly PriceList[]; onChange: (lists: PriceList[]) => void }) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(priceLists[0]?.id ?? "");
  const selected = priceLists.find((item) => item.id === selectedId);
  const filtered = priceLists.filter((item) => `${item.name} ${item.code} ${item.year} ${item.edition ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  const update = (patch: Partial<PriceList>) => selected && onChange(priceLists.map((item) => item.id === selected.id ? { ...item, ...patch } : item));
  function add() { const id = `price-list-${Date.now()}`; const created: PriceList = { id, name: `Nový ceník ${new Date().getFullYear()}`, code: id.toUpperCase(), currency: "CZK", year: new Date().getFullYear(), active: true }; onChange([...priceLists, created]); setSelectedId(id); }
  return <div className="workspacePage"><div className="workspacePageHeader"><div><span className="eyebrow">ADMINISTRACE</span><h1>Ceníky</h1></div><button className="primaryButton" onClick={add}>+ Přidat ceník</button></div><div className="adminFilters"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Hledat ceník, kód, edici nebo rok…" /></div><div className="adminSplit"><div className="adminList">{filtered.map((list) => <button key={list.id} className={list.id === selectedId ? "active" : ""} onClick={() => setSelectedId(list.id)}><strong>{list.name}</strong><span>{list.code} · {list.year} · {list.active ? "Aktivní" : "Archiv"}</span></button>)}</div>{selected && <section className="adminDetail eventForm"><label><span>Název</span><input value={selected.name} onChange={(event) => update({ name: event.target.value })} /></label><div className="threeColumns"><label><span>Kód</span><input value={selected.code} onChange={(event) => update({ code: event.target.value })} /></label><label><span>Rok</span><input type="number" value={selected.year} onChange={(event) => update({ year: Number(event.target.value) })} /></label><label><span>Edice</span><input value={selected.edition ?? ""} onChange={(event) => update({ edition: event.target.value || undefined })} /></label></div><div className="twoColumns"><label><span>Měna</span><select value={selected.currency} onChange={(event) => update({ currency: event.target.value as PriceList["currency"] })}><option>CZK</option><option>EUR</option></select></label><label><span>Realizačka</span><select value={selected.realizationCompanyId ?? ""} onChange={(event) => update({ realizationCompanyId: event.target.value || undefined })}><option value="">Všechny</option>{realizationCompanies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label></div><div className="twoColumns"><DateField label="Platnost od" value={selected.validFrom} onChange={(validFrom) => update({ validFrom })} /><DateField label="Platnost do" value={selected.validTo} onChange={(validTo) => update({ validTo })} /></div><label className="checkLabel"><input type="checkbox" checked={selected.active} onChange={(event) => update({ active: event.target.checked })} /> Aktivní; vypnuté ceníky zůstávají v archivu</label></section>}</div></div>;
}

function DateField({ label, value, onChange }: { label: string; value?: string; onChange: (value: string | undefined) => void }) {
  return <label><span>{label}</span><input type="date" value={value ?? ""} onChange={(event) => onChange(event.target.value || undefined)} /></label>;
}
