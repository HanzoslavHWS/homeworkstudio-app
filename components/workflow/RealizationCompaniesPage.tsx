"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  RealizationCompany,
  RealizationCompanyAliasInput,
  RealizationCompanyAliasKind,
  RealizationCompanyCardInput,
  RealizationCompanyContact,
} from "../../domain/realizationCompany";
import { normalizeCompanyName, realizationReferenceLabel, resolveRealizationReference, UNSPECIFIED_REALIZATION_COMPANY_LABEL } from "../../domain/realizationCompanyIdentity";
import { realizationCompanyAdminApi, type RealizationCompanyRegister } from "../../lib/db/realizationCompanyRepository.remoteApi.client";

type Draft = Readonly<{ id?: string; source?: RealizationCompany["source"]; card: RealizationCompanyCardInput; aliases: readonly RealizationCompanyAliasInput[] }>;

const EMPTY_CARD: RealizationCompanyCardInput = { name: "", isActive: true, contacts: [] };
const ALIAS_KIND_LABELS: Record<RealizationCompanyAliasKind, string> = { alternative: "Alternativní", historical: "Historický" };

function draftFor(company: RealizationCompany, register: RealizationCompanyRegister): Draft {
  return {
    id: company.id,
    source: company.source,
    card: {
      name: company.name,
      legalName: company.legalName,
      abraName: company.abraName,
      ico: company.ico,
      dic: company.dic,
      contacts: company.contacts ?? [],
      note: company.note,
      isActive: company.isActive,
    },
    aliases: register.aliases
      .filter((alias) => alias.realizationCompanyId === company.id && alias.isActive)
      .map((alias) => ({ id: alias.id, alias: alias.alias, kind: alias.kind, note: alias.note })),
  };
}

/**
 * Administrace → Realizační firmy (V1-DATA-02). One card per real firm; firms are deactivated,
 * never deleted. "Ostatní / neurčeno" is not a firm (see domain/realizationCompanyIdentity.ts), and
 * the old placeholder ids are listed read-only — decision A2 keeps them unmapped.
 */
export function RealizationCompaniesPage() {
  const [register, setRegister] = useState<RealizationCompanyRegister>({ companies: [], aliases: [], legacyIds: [] });
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [showInactive, setShowInactive] = useState(true);
  const [draft, setDraft] = useState<Draft | undefined>(undefined);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");

  async function reload(selectId?: string) {
    try {
      const next = await realizationCompanyAdminApi.load();
      setRegister(next);
      setLoadError("");
      const selected = selectId ? next.companies.find((company) => company.id === selectId) : undefined;
      if (selected) setDraft(draftFor(selected, next));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Realizační firmy se nepodařilo načíst.");
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  const filtered = useMemo(() => {
    const key = normalizeCompanyName(query);
    return register.companies.filter((company) => {
      if (!showInactive && !company.isActive) return false;
      if (!key) return true;
      const names = [company.name, company.legalName, company.abraName, company.ico, ...register.aliases.filter((alias) => alias.realizationCompanyId === company.id).map((alias) => alias.alias)];
      return names.some((name) => name && normalizeCompanyName(name).includes(key));
    });
  }, [register, query, showInactive]);

  function confirmDiscard(): boolean {
    return !dirty || window.confirm("Máte neuložené změny. Opravdu chcete pokračovat?");
  }

  function select(company: RealizationCompany) {
    if (!confirmDiscard()) return;
    setDraft(draftFor(company, register));
    setDirty(false);
    setSaveError("");
    setSavedMessage("");
  }

  function startNew() {
    if (!confirmDiscard()) return;
    setDraft({ card: EMPTY_CARD, aliases: [] });
    setDirty(false);
    setSaveError("");
    setSavedMessage("");
  }

  function updateCard(patch: Partial<RealizationCompanyCardInput>) {
    setDraft((current) => (current ? { ...current, card: { ...current.card, ...patch } } : current));
    setDirty(true);
    setSavedMessage("");
  }

  function updateContacts(contacts: readonly RealizationCompanyContact[]) {
    updateCard({ contacts });
  }

  function updateAliases(aliases: readonly RealizationCompanyAliasInput[]) {
    setDraft((current) => (current ? { ...current, aliases } : current));
    setDirty(true);
    setSavedMessage("");
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    setSaveError("");
    try {
      const company = draft.id
        ? await realizationCompanyAdminApi.update(draft.id, draft.card, draft.aliases)
        : await realizationCompanyAdminApi.create(draft.card, draft.aliases);
      setDirty(false);
      setSavedMessage(draft.id ? "Karta firmy byla uložena." : `Firma byla založena s ID ${company.id}.`);
      await reload(company.id);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Kartu firmy se nepodařilo uložit.");
    } finally {
      setSaving(false);
    }
  }

  const contacts = draft?.card.contacts ?? [];
  return <div className="workspacePage">
    <div className="workspacePageHeader"><div><span className="eyebrow">ADMINISTRACE</span><h1>Realizační firmy</h1></div><button className="primaryButton" onClick={startNew}>+ Nová firma</button></div>
    <p className="temporaryNotice">Jedna karta = jedna skutečná firma. Firmy se nemažou, jen deaktivují. „{UNSPECIFIED_REALIZATION_COMPANY_LABEL}“ není firma: znamená, že realizačka není přiřazená. Firmy se automaticky neslučují — stejný název nebo alternativní název nemůže mít víc firem.</p>
    {loadError && <p className="uploadError">{loadError}</p>}
    <div className="adminFilters">
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Hledat podle názvu, právního názvu, ABRA, IČO nebo alternativního názvu…" />
      <label className="checkLabel"><input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} /> Zobrazit neaktivní</label>
    </div>
    <div className="adminSplit">
      <div className="adminList">
        {filtered.length === 0 && <p className="workspaceEmpty">Žádné firmy.</p>}
        {filtered.map((company) => <button key={company.id} className={company.id === draft?.id ? "active" : ""} onClick={() => select(company)}>
          <strong>{company.name}{company.isActive ? "" : " (neaktivní)"}</strong>
          <span>{company.legalName ?? company.id}{company.ico ? ` · IČO ${company.ico}` : ""}</span>
        </button>)}
      </div>
      {draft && <section className="adminDetail">
        <div className="eventSaveBar">
          <span className={dirty ? "dirty" : "saved"}>{saving ? "Ukládám…" : dirty ? "Neuložené změny" : draft.id ? "Uloženo" : "Nová firma"}{saveError && <small className="uploadError">{saveError}</small>}{savedMessage && <small>{savedMessage}</small>}</span>
          <button type="button" className="primaryButton" onClick={save} disabled={saving || (!dirty && Boolean(draft.id))}>{draft.id ? "Uložit změny" : "Založit firmu"}</button>
        </div>
        <div className="eventForm">
          <div className="twoColumns">
            <label><span>Interní ID</span><input value={draft.id ?? "přidělí se při založení"} readOnly disabled /></label>
            <label><span>Zdroj</span><input value={draft.source === "manual" ? "Založena ručně" : draft.id ? "Import tiskových ploch" : "Ruční založení"} readOnly disabled /></label>
          </div>
          <label><span>Pracovní / zobrazovaný název *</span><input value={draft.card.name} onChange={(event) => updateCard({ name: event.target.value })} /></label>
          <div className="twoColumns">
            <label><span>Oficiální právní název</span><input value={draft.card.legalName ?? ""} onChange={(event) => updateCard({ legalName: event.target.value })} placeholder="např. CREATIV EXPO, s.r.o." /></label>
            <label><span>Název v ABRA</span><input value={draft.card.abraName ?? ""} onChange={(event) => updateCard({ abraName: event.target.value })} /></label>
          </div>
          <div className="twoColumns">
            <label><span>IČO</span><input value={draft.card.ico ?? ""} onChange={(event) => updateCard({ ico: event.target.value })} inputMode="numeric" /></label>
            <label><span>DIČ</span><input value={draft.card.dic ?? ""} onChange={(event) => updateCard({ dic: event.target.value })} placeholder="CZ12345678" /></label>
          </div>
          <label className="checkLabel"><input type="checkbox" checked={draft.card.isActive} onChange={(event) => updateCard({ isActive: event.target.checked })} /> Aktivní firma</label>

          <section className="deadlineEditor">
            <div><strong>Alternativní a historické názvy</strong><button type="button" onClick={() => updateAliases([...draft.aliases, { alias: "", kind: "alternative" }])}>+ Přidat</button></div>
            {draft.aliases.length === 0 && <p className="fieldHint">Např. název z ABF sestavy („R: …“) nebo dřívější název firmy.</p>}
            {draft.aliases.map((alias, index) => <div key={alias.id ?? `new-${index}`}>
              <input value={alias.alias} onChange={(event) => updateAliases(draft.aliases.map((item, itemIndex) => itemIndex === index ? { ...item, alias: event.target.value } : item))} placeholder="Název" />
              <select value={alias.kind} onChange={(event) => updateAliases(draft.aliases.map((item, itemIndex) => itemIndex === index ? { ...item, kind: event.target.value as RealizationCompanyAliasKind } : item))}>
                {(Object.keys(ALIAS_KIND_LABELS) as RealizationCompanyAliasKind[]).map((kind) => <option key={kind} value={kind}>{ALIAS_KIND_LABELS[kind]}</option>)}
              </select>
              <button type="button" onClick={() => updateAliases(draft.aliases.filter((_, itemIndex) => itemIndex !== index))}>Odebrat</button>
            </div>)}
          </section>

          <section className="deadlineEditor">
            <div><strong>Kontakty</strong><button type="button" onClick={() => updateContacts([...contacts, { id: `contact-${Date.now()}` }])}>+ Přidat</button></div>
            {contacts.map((contact) => <div key={contact.id}>
              <input value={contact.name ?? ""} onChange={(event) => updateContacts(contacts.map((item) => item.id === contact.id ? { ...item, name: event.target.value } : item))} placeholder="Jméno" />
              <input value={contact.role ?? ""} onChange={(event) => updateContacts(contacts.map((item) => item.id === contact.id ? { ...item, role: event.target.value } : item))} placeholder="Role" />
              <input value={contact.email ?? ""} onChange={(event) => updateContacts(contacts.map((item) => item.id === contact.id ? { ...item, email: event.target.value } : item))} placeholder="E-mail" type="email" />
              <input value={contact.phone ?? ""} onChange={(event) => updateContacts(contacts.map((item) => item.id === contact.id ? { ...item, phone: event.target.value } : item))} placeholder="Telefon" />
              <button type="button" onClick={() => updateContacts(contacts.filter((item) => item.id !== contact.id))}>Odebrat</button>
            </div>)}
          </section>

          <label><span>Interní poznámka</span><textarea value={draft.card.note ?? ""} onChange={(event) => updateCard({ note: event.target.value })} /></label>
        </div>
      </section>}
    </div>

    <section className="adminDetail">
      <h2>Historické identifikátory</h2>
      <p className="fieldHint">Starší projekty, veletrhy a ceníky mají uložené tyto hodnoty. Uložená data se nepřepisují a výrobní rozměry se počítají stejně jako dřív.</p>
      <table className="dataTable">
        <thead><tr><th>Identifikátor</th><th>Význam</th><th>Podklad</th></tr></thead>
        <tbody>{register.legacyIds.map((legacy) => <tr key={legacy.legacyId}>
          <td><code>{legacy.legacyId}</code></td>
          <td>{realizationReferenceLabel(resolveRealizationReference(legacy.legacyId, register.companies, register.legacyIds))}</td>
          <td>{legacy.evidence ?? ""}</td>
        </tr>)}</tbody>
      </table>
    </section>
  </div>;
}
