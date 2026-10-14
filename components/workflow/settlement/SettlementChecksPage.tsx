"use client";

import { useEffect, useRef, useState } from "react";
import type { Exhibition } from "../../../domain/organizations";
import { countProblems, SETTLEMENT_CHECK_STATUS_LABELS_CS, type SettlementCheck } from "../../../domain/settlementCheck";
import { RemoteApiSettlementClient, SettlementApiError, type SettlementListResponse } from "../../../lib/db/settlementCheck.remoteApi.client";
import { SettlementCheckDetailPage } from "./SettlementCheckDetailPage";

/**
 * Kontrola vyúčtování — list of checks + "Nová kontrola". One check = one event + one realization
 * company; further files (another hall) are uploaded into the same check, never a second check.
 */
export function SettlementChecksPage({ events, actorName }: { events: readonly Exhibition[]; actorName: string }) {
  const clientRef = useRef(new RemoteApiSettlementClient());
  const [data, setData] = useState<SettlementListResponse | null>(null);
  const [error, setError] = useState("");
  const [openCheckId, setOpenCheckId] = useState<string | undefined>(undefined);

  const [showCreate, setShowCreate] = useState(false);
  const [eventId, setEventId] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [note, setNote] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  function reload() {
    clientRef.current.list().then((next) => { setData(next); setError(""); }).catch((cause) => setError(cause instanceof Error ? cause.message : "Kontroly se nepodařilo načíst."));
  }

  useEffect(() => { reload(); }, []);

  const eventName = (id: string) => events.find((event) => event.id === id)?.name ?? id;

  async function handleCreate() {
    if (!eventId || !companyId || isCreating) return;
    setIsCreating(true);
    setCreateError("");
    try {
      const check = await clientRef.current.create({ eventId, realizationCompanyId: companyId, note: note.trim() || undefined, actorName: actorName || undefined });
      setShowCreate(false);
      setNote("");
      setOpenCheckId(check.id);
    } catch (cause) {
      // The check for this event + company already exists: open it instead of leaving a dead end.
      const existingId = cause instanceof SettlementApiError && cause.code === "check_exists" ? (cause.details as { checkId?: string } | null)?.checkId : undefined;
      if (existingId) {
        setShowCreate(false);
        setOpenCheckId(existingId);
      } else {
        setCreateError(cause instanceof Error ? cause.message : "Kontrolu se nepodařilo vytvořit.");
      }
    } finally {
      setIsCreating(false);
    }
  }

  async function handleDelete(check: SettlementCheck) {
    if (!window.confirm(`Opravdu smazat kontrolu „${eventName(check.eventId)} — ${check.realizationCompanyName}“?\n\nSmažou se její importované soubory, výsledky a rozhodnutí. Slovník názvů realizačky a pravidla zůstanou.`)) return;
    try {
      await clientRef.current.delete(check.id);
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kontrolu se nepodařilo smazat.");
    }
  }

  if (openCheckId) {
    return (
      <SettlementCheckDetailPage
        client={clientRef.current}
        checkId={openCheckId}
        events={events}
        actorName={actorName}
        vendorParsers={data?.vendorParsers ?? []}
        onBack={() => { setOpenCheckId(undefined); reload(); }}
      />
    );
  }

  const activeCompanies = (data?.companies ?? []).filter((company) => company.isActive);

  return (
    <div className="workspacePage">
      <div className="workspacePageHeader">
        <div>
          <span className="eyebrow">KONTROLA VYÚČTOVÁNÍ</span>
          <h1>Kontrola vyúčtování</h1>
          <p>Porovnání objednávek ABF s vyúčtováním realizační firmy — množství komponent podle čísla stánku.</p>
        </div>
        <button type="button" className="primaryButton" onClick={() => { setShowCreate(true); setCreateError(""); }}>+ Nová kontrola</button>
      </div>

      {showCreate && (
        <div className="workflowCard printSurfaceCreateForm">
          <div className="workflowCardHeader">
            <div><span>NOVÁ KONTROLA</span><strong>Akce a realizační firma</strong></div>
          </div>
          {createError && <p className="uploadError">{createError}</p>}
          {data && activeCompanies.length === 0 && (
            <p className="temporaryNotice">V databázi není žádná realizační firma. Firmy se zakládají importem katalogu v modulu Tiskové plochy — tento modul je záměrně nevytváří.</p>
          )}
          <div className="workspaceFormRow">
            <label>
              <span>Akce</span>
              <select value={eventId} onChange={(event) => setEventId(event.target.value)}>
                <option value="">— Vyberte akci —</option>
                {events.map((event) => <option key={event.id} value={event.id}>{event.name}</option>)}
              </select>
            </label>
            <label>
              <span>Realizační firma</span>
              <select value={companyId} onChange={(event) => setCompanyId(event.target.value)}>
                <option value="">— Vyberte firmu —</option>
                {activeCompanies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
              </select>
            </label>
            <label className="settlementWide"><span>Poznámka</span><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="nepovinné" /></label>
          </div>
          <div className="printSurfaceCreateFormActions">
            <button type="button" className="primaryButton" onClick={() => void handleCreate()} disabled={!eventId || !companyId || isCreating}>{isCreating ? "Vytvářím…" : "Vytvořit a otevřít"}</button>
            <button type="button" onClick={() => setShowCreate(false)} disabled={isCreating}>Zrušit</button>
          </div>
        </div>
      )}

      {error && <p className="uploadError">{error}</p>}
      {!data && !error && <p className="workspaceEmpty">Načítám kontroly…</p>}
      {data && data.checks.length === 0 && <p className="workspaceEmpty">Zatím není vytvořená žádná kontrola vyúčtování.</p>}

      {data && data.checks.length > 0 && (
        <div className="printSurfaceTable">
          <div className="settlementCheckRow printSurfaceTableHeader">
            <span>Akce</span>
            <span>Realizační firma</span>
            <span>Stav</span>
            <span>Stánků</span>
            <span>Otevřených problémů</span>
            <span>Vytvořeno</span>
            <span>Poslední úprava</span>
            <span>Akce</span>
          </div>
          {data.checks.map((check) => {
            const problems = check.summary ? countProblems(check.summary.rowCounts) + check.summary.unassignedVendorSheetCount + check.summary.unassignedAbfStandCount : null;
            return (
              <div key={check.id} className="settlementCheckRow" onClick={() => setOpenCheckId(check.id)}>
                <span><strong>{eventName(check.eventId)}</strong></span>
                <span>{check.realizationCompanyName}</span>
                <span><em className={`settlementBadge settlementCheck-${check.status}`}>{SETTLEMENT_CHECK_STATUS_LABELS_CS[check.status]}</em></span>
                <span>{check.summary ? check.summary.standCount : "—"}</span>
                <span className={problems ? "settlementProblemCount" : undefined}>{problems ?? "—"}</span>
                <span>{new Date(check.createdAt).toLocaleDateString("cs-CZ")}</span>
                <span>{new Date(check.updatedAt).toLocaleString("cs-CZ")}</span>
                <span onClick={(event) => event.stopPropagation()}>
                  <button type="button" className="textButton dangerText" onClick={() => void handleDelete(check)}>Smazat</button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
