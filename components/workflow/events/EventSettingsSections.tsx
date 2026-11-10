"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  buildStandardEventPaths,
  customValuesLostByStandard,
  EVENT_PATH_MODE_LABELS_CS,
  EVENT_PATH_ROLE_LABELS_CS,
  EVENT_SUBFOLDER_ROLES,
  inferEventPathMode,
  legacyRealizationLabel,
  normalizeEventPaths,
  resolveEventPath,
  STANDARD_EVENT_FOLDERS,
  validateEventPaths,
  validateRealizationLinks,
  type EventPathMapping,
  type EventPathMode,
  type EventRealizationLink,
  type EventSubfolderRole,
  type RealizationCompanyOption,
} from "../../../domain/eventAdmin";
import {
  coverageWarningText,
  currentEventAssignment,
  eventAssignmentHistory,
  PRICE_LIST_KIND_LABELS_CS,
  SALE_PRICE_LIST_KINDS,
  type SalePriceListKind,
} from "../../../domain/priceVersions";
import { EventConfigConflictClientError, EventNotSavedClientError, eventConfigApi, type EventConfigResponse } from "../../../lib/db/eventConfig.remoteApi.client";
import { isPriceVersionConflict, salePriceVersionsApi, type SalePriceRegister } from "../../../lib/db/priceVersions.remoteApi.client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

/**
 * V1-DATA-06 sections of the event card: one list of realization firms, folder paths for the future
 * Organizer, and the assigned price list versions (V1-DATA-05). Each section saves on its own and
 * is protected against concurrent edits; the card document (name, dates, documents…) is unchanged.
 */

type LoadState = Readonly<{ status: "loading" } | { status: "notSaved" } | { status: "error"; message: string } | { status: "ready"; config: EventConfigResponse }>;

/** Realization firms + folder paths share one config revision, so they live in one loader. */
export function EventSettingsSections({ eventId, legacyRealizationCompanyId }: { eventId: string; legacyRealizationCompanyId?: string }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [revision, setRevision] = useState(1);

  const reload = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const config = await eventConfigApi.load(eventId);
      setRevision(config.configRevision);
      setState({ status: "ready", config });
    } catch (error) {
      if (error instanceof EventNotSavedClientError) setState({ status: "notSaved" });
      else setState({ status: "error", message: error instanceof Error ? error.message : "Nastavení veletrhu se nepodařilo načíst." });
    }
  }, [eventId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (state.status === "loading") return <p className="fieldHint">Načítám nastavení veletrhu…</p>;
  if (state.status === "notSaved") return <p className="fieldHint eventSettingsNotice">Realizační firmy a složky na disku lze nastavit po prvním uložení veletrhu.</p>;
  if (state.status === "error") return <p className="uploadError">{state.message} <Button variant="link" type="button" onClick={() => void reload()}>Zkusit znovu</Button></p>;
  return (
    <>
      <RealizationSection
        key={`realization-${eventId}`}
        eventId={eventId}
        revision={revision}
        onRevision={setRevision}
        onReload={reload}
        initialLinks={state.config.realizationLinks}
        companies={state.config.companies}
        legacyRealizationCompanyId={legacyRealizationCompanyId}
      />
      <PathsSection key={`paths-${eventId}`} eventId={eventId} revision={revision} onRevision={setRevision} onReload={reload} initialPaths={state.config.pathMappings} />
    </>
  );
}

type SectionProps = Readonly<{ eventId: string; revision: number; onRevision: (revision: number) => void; onReload: () => Promise<void> }>;

function SaveBar({ dirty, saving, message, error, conflict, onSave, onReload }: { dirty: boolean; saving: boolean; message: string; error: string; conflict: boolean; onSave: () => void; onReload: () => void }) {
  return (
    <div className="eventSectionBar">
      <span className={dirty ? "dirty" : "saved"}>{saving ? "Ukládám…" : dirty ? "Neuložené změny" : "Uloženo"}</span>
      {message && <small className="saveOk">{message}</small>}
      {error && <small className="uploadError">{error}</small>}
      {conflict && <Button variant="outline" type="button" onClick={() => { if (!dirty || window.confirm("Načíst aktuální stav? Vaše neuložené změny v této části se zahodí.")) onReload(); }}>Načíst aktuální stav</Button>}
      <Button variant="default" type="button" disabled={!dirty || saving} onClick={onSave}>Uložit</Button>
    </div>
  );
}

function RealizationSection({ eventId, revision, onRevision, onReload, initialLinks, companies, legacyRealizationCompanyId }: SectionProps & {
  initialLinks: readonly EventRealizationLink[];
  companies: readonly RealizationCompanyOption[];
  legacyRealizationCompanyId?: string;
}) {
  const [links, setLinks] = useState<readonly EventRealizationLink[]>(initialLinks);
  const [saved, setSaved] = useState<readonly EventRealizationLink[]>(initialLinks);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [adding, setAdding] = useState("");
  const dirty = JSON.stringify(links) !== JSON.stringify(saved);
  const companyById = new Map(companies.map((company) => [company.id, company]));
  const check = useMemo(() => validateRealizationLinks(links, companies), [links, companies]);
  const available = companies.filter((company) => company.isActive && !links.some((link) => link.realizationCompanyId === company.id));

  function change(next: readonly EventRealizationLink[]) {
    setLinks(next);
    setMessage("");
    setError("");
  }

  async function save() {
    if (check.errors.length) {
      setError(check.errors[0]!);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const result = await eventConfigApi.saveRealization(eventId, revision, links);
      onRevision(result.configRevision);
      setSaved(links);
      setConflict(false);
      setMessage("Realizační firmy uloženy.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Uložení se nezdařilo.");
      setConflict(caught instanceof EventConfigConflictClientError);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="eventSettingsSection min-w-0">
      <h3>Realizační firmy</h3>
      <p className="fieldHint">Firmy, které na veletrhu realizují stánky (včetně jejich grafiky a zapojení elektřiny uvnitř stánku; hlavní přívod zajišťuje areál). Výchozí realizačka jen předvyplní nový úkol — stánkům se nepřiřazuje automaticky.</p>
      <p className="eventLegacyValue">
        <strong>Historická hodnota (starý generátor a ceny, do V1-DATA-07):</strong> {legacyRealizationLabel(legacyRealizationCompanyId, companies)}
        <small className="fieldHint"> — zachovává se beze změny a nepřevádí se na firmu.</small>
      </p>
      <div className="eventRealizationList">
        {links.length === 0 && <span className="fieldHint">Zatím bez realizační firmy.</span>}
        {links.map((link) => (
          <div key={link.realizationCompanyId} className="eventRealizationRow">
            <span>{companyById.get(link.realizationCompanyId)?.name ?? link.realizationCompanyId}{companyById.get(link.realizationCompanyId)?.isActive === false ? " (v evidenci neaktivní)" : ""}</span>
            <label className="checkLabel">
              <input
                type="checkbox"
                checked={link.isDefault}
                onChange={(event) => change(links.map((candidate) => ({ ...candidate, isDefault: candidate.realizationCompanyId === link.realizationCompanyId ? event.target.checked : false })))}
              /> výchozí
            </label>
            <Input className="eventRealizationNote" value={link.note ?? ""} placeholder="Poznámka" onChange={(event) => change(links.map((candidate) => (candidate.realizationCompanyId === link.realizationCompanyId ? { ...candidate, note: event.target.value || undefined } : candidate)))} />
            <Button variant="link" type="button" onClick={() => change(links.filter((candidate) => candidate.realizationCompanyId !== link.realizationCompanyId))}>Odebrat</Button>
          </div>
        ))}
        {available.length > 0 && (
          <div className="eventRealizationRow">
            <NativeSelect value={adding} onChange={(event) => setAdding(event.target.value)}>
              <option value="">— přidat realizační firmu —</option>
              {available.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
            </NativeSelect>
            <Button variant="outline" type="button" disabled={!adding} onClick={() => { change([...links, { realizationCompanyId: adding, isDefault: links.length === 0 }]); setAdding(""); }}>Přidat</Button>
          </div>
        )}
      </div>
      <p className="fieldHint">Odebraná firma zůstává v historii veletrhu (deaktivuje se, nemaže).</p>
      {companies.length === 0 && <p className="fieldHint">V evidenci zatím nejsou realizační firmy (Administrace → Realizační firmy).</p>}
      {check.warnings.map((warning) => <p key={warning} className="fieldHint">⚠ {warning}</p>)}
      <SaveBar dirty={dirty} saving={saving} message={message} error={error} conflict={conflict} onSave={() => void save()} onReload={() => void onReload()} />
    </section>
  );
}

type SubfolderDraft = Partial<Record<EventSubfolderRole, string>>;

function subfoldersOf(paths: readonly EventPathMapping[]): SubfolderDraft {
  return Object.fromEntries(paths.filter((path) => path.role !== "event_root").map((path) => [path.role, path.path])) as SubfolderDraft;
}

/** What would be stored: the standard (root + nine standard names) or the custom values (empty subfolder = root, not stored). */
function pathsPayload(mode: EventPathMode, root: string, custom: SubfolderDraft): EventPathMapping[] {
  if (mode === "standard") return [...buildStandardEventPaths(root.trim())];
  const subfolders = EVENT_SUBFOLDER_ROLES.filter((role) => custom[role]?.trim()).map((role) => ({ role, path: custom[role]! }));
  return [...(root.trim() ? [{ role: "event_root" as const, path: root }] : []), ...subfolders];
}

function PathsSection({ eventId, revision, onRevision, onReload, initialPaths }: SectionProps & { initialPaths: readonly EventPathMapping[] }) {
  const initialRoot = initialPaths.find((path) => path.role === "event_root")?.path ?? "";
  const [mode, setMode] = useState<EventPathMode>(() => inferEventPathMode(initialPaths));
  const [root, setRoot] = useState(initialRoot);
  const [custom, setCustom] = useState<SubfolderDraft>(() => subfoldersOf(initialPaths));
  const [savedPayload, setSavedPayload] = useState(() => JSON.stringify(normalizeEventPaths(initialPaths)));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const payload = pathsPayload(mode, root, custom);
  const normalized = normalizeEventPaths(payload);
  const issues = validateEventPaths(normalized);
  const dirty = JSON.stringify(normalized) !== savedPayload;
  const rootPreview = resolveEventPath("event_root", normalized);

  function switchMode(next: EventPathMode) {
    if (next === mode) return;
    if (next === "standard") {
      const lost = customValuesLostByStandard(custom);
      if (lost.length && !window.confirm(`Standard nahradí vlastní cesty (${lost.map((role) => EVENT_PATH_ROLE_LABELS_CS[role]).join(", ")}) standardními názvy. Uloží se to až tlačítkem Uložit; přepnutím zpět na Vlastní nastavení je do té doby vrátíte. Pokračovat?`)) return;
    } else if (EVENT_SUBFOLDER_ROLES.every((role) => !custom[role]?.trim())) {
      // Convenient start of a custom setup: the standard names, freely editable or clearable.
      setCustom({ ...STANDARD_EVENT_FOLDERS });
    }
    setMode(next);
    setMessage("");
  }

  async function save() {
    if (Object.keys(issues).length) {
      setError(Object.values(issues)[0]!);
      return;
    }
    if (normalized.length === 0 && savedPayload !== "[]" && !window.confirm("Kořenová složka je prázdná — nastavení složek veletrhu se odstraní (bude nenakonfigurováno). Pokračovat?")) return;
    setSaving(true);
    setError("");
    try {
      const result = await eventConfigApi.savePaths(eventId, revision, normalized);
      onRevision(result.configRevision);
      setSavedPayload(JSON.stringify(result.paths));
      setRoot(result.paths.find((path) => path.role === "event_root")?.path ?? "");
      if (mode === "custom") setCustom(subfoldersOf(result.paths));
      setConflict(false);
      setMessage("Složky uloženy.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Uložení se nezdařilo.");
      setConflict(caught instanceof EventConfigConflictClientError);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="eventSettingsSection min-w-0">
      <h3>Složky na disku (pro budoucí Organizer)</h3>
      <p className="fieldHint">Aplikace jen ukládá cesty — na disk nepřistupuje, složky nevytváří, nic nekopíruje ani nepřejmenovává.</p>
      <div className="eventPathModes" role="radiogroup" aria-label="Režim složek">
        {(["standard", "custom"] as const).map((option) => (
          <label key={option} className="checkLabel">
            <input type="radio" name={`path-mode-${eventId}`} checked={mode === option} onChange={() => switchMode(option)} /> {EVENT_PATH_MODE_LABELS_CS[option]}
          </label>
        ))}
      </div>
      <label className="eventPathRow">
        <span>{EVENT_PATH_ROLE_LABELS_CS.event_root}</span>
        <Input value={root} placeholder="např. C:\HWS_TEST\TEST_BEAUTY_2026_P nebo P:\…" onChange={(event) => { setRoot(event.target.value); setMessage(""); }} />
        {issues.event_root ? <small className="uploadError">{issues.event_root}</small> : !root.trim() ? <small className="fieldHint">Prázdná kořenová složka = nenakonfigurováno.</small> : null}
      </label>
      <div className="overflow-x-auto"><table className="priceVersionTable eventPathTable">
        <thead><tr><th>Složka</th><th>{mode === "standard" ? "Standardní podsložka" : "Cesta (relativní k kořeni nebo úplná)"}</th><th>Výsledná cesta</th></tr></thead>
        <tbody>
          {EVENT_SUBFOLDER_ROLES.map((role) => {
            const value = mode === "standard" ? STANDARD_EVENT_FOLDERS[role] : custom[role] ?? "";
            const preview = resolveEventPath(role, normalized);
            return (
              <tr key={role}>
                <td>{EVENT_PATH_ROLE_LABELS_CS[role]}</td>
                <td>
                  {mode === "standard"
                    ? <code>{value}</code>
                    : <Input value={value} placeholder="prázdné = kořenová složka" onChange={(event) => { setCustom({ ...custom, [role]: event.target.value }); setMessage(""); }} />}
                  {issues[role] ? <small className="uploadError"> {issues[role]}</small> : null}
                </td>
                <td className="eventPathPreview">{preview ? <code>{preview}</code> : <span className="fieldHint">nenakonfigurováno</span>}{preview && preview === rootPreview && mode === "custom" ? <small className="fieldHint"> (kořenová složka)</small> : null}</td>
              </tr>
            );
          })}
        </tbody>
      </table></div>
      <SaveBar dirty={dirty} saving={saving} message={message} error={error} conflict={conflict} onSave={() => void save()} onReload={() => void onReload()} />
    </section>
  );
}

/** Assigned price list versions of this event (V1-DATA-05 API; history and concurrency kept). */
export function EventPricingSection({ eventId, actorName }: { eventId: string; actorName?: string }) {
  const api = useMemo(() => salePriceVersionsApi(() => actorName), [actorName]);
  const [register, setRegister] = useState<SalePriceRegister | undefined>();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const reload = useCallback(async () => {
    try {
      setRegister(await api.load());
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Ceníky se nepodařilo načíst.");
    }
  }, [api]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!register) return <section className="eventSettingsSection min-w-0"><h3>Ceníky</h3>{error ? <p className="uploadError">{error}</p> : <p className="fieldHint">Načítám…</p>}</section>;
  const listById = new Map(register.lists.map((list) => [list.id, list]));
  const versionById = new Map(register.versions.map((version) => [version.id, version]));
  const label = (versionId: string | undefined) => {
    const version = versionId ? versionById.get(versionId) : undefined;
    return version ? `${listById.get(version.priceListId)?.name ?? "?"} · v${version.versionNo}${version.label ? ` · ${version.label}` : ""}${version.status === "archived" ? " (archivováno)" : ""}` : "—";
  };
  const known = register.events.some((event) => event.id === eventId);

  async function assign(kind: SalePriceListKind, versionId: string) {
    const current = currentEventAssignment(register!.assignments, eventId, kind);
    if ((current?.priceListVersionId ?? "") === versionId) return;
    const warning = versionId ? coverageWarningText(register!.coverage[versionId]) : "";
    if (!window.confirm(versionId ? `Přiřadit veletrhu verzi „${label(versionId)}“?${warning ? `\n\nUpozornění: ${warning}` : ""}` : "Zrušit přiřazení? Veletrh pak nebude mít ceny tohoto druhu (k nacenění).")) return;
    setBusy(true);
    setError("");
    try {
      await api.assign(eventId, kind, versionId || null, current?.priceListVersionId ?? null);
      setMessage("Přiřazení uloženo. Předchozí zůstává v historii.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Přiřazení se nepodařilo uložit.");
      if (!isPriceVersionConflict(caught)) return;
    } finally {
      setBusy(false);
      await reload();
    }
  }

  return (
    <section className="eventSettingsSection min-w-0">
      <h3>Ceníky (verze)</h3>
      <p className="fieldHint">Veletrh používá jen výslovně přiřazenou publikovanou verzi. Datum konání ani publikace nové verze ji nemění.</p>
      {!known && <p className="fieldHint">Veletrh ještě není uložený.</p>}
      {known && (
        <div className="eventPricingRows">
          {SALE_PRICE_LIST_KINDS.map((kind) => {
            const current = currentEventAssignment(register.assignments, eventId, kind);
            const options = register.versions.filter((version) => version.status === "published" && listById.get(version.priceListId)?.kind === kind);
            const warning = current ? coverageWarningText(register.coverage[current.priceListVersionId]) : "";
            return (
              <label key={kind} className="eventPathRow">
                <span>{PRICE_LIST_KIND_LABELS_CS[kind]}</span>
                <NativeSelect value={current?.priceListVersionId ?? ""} disabled={busy} onChange={(event) => void assign(kind, event.target.value)}>
                  <option value="">— nepřiřazeno —</option>
                  {current && !options.some((version) => version.id === current.priceListVersionId) && <option value={current.priceListVersionId}>{label(current.priceListVersionId)}</option>}
                  {options.map((version) => <option key={version.id} value={version.id}>{label(version.id)}</option>)}
                </NativeSelect>
                {warning && <small className="dangerText">⚠ {warning}</small>}
              </label>
            );
          })}
        </div>
      )}
      {message && <p className="saveOk">{message}</p>}
      {error && <p className="uploadError">{error}</p>}
      {known && <Button variant="link" type="button" onClick={() => setShowHistory(!showHistory)}>{showHistory ? "Skrýt historii" : "Historie přiřazení"}</Button>}
      {showHistory && (
        <ul className="eventPricingHistory">
          {eventAssignmentHistory(register.assignments, eventId).map((assignment) => (
            <li key={assignment.id}>{PRICE_LIST_KIND_LABELS_CS[assignment.listKind]}: {label(assignment.priceListVersionId)} · {new Date(assignment.assignedAt).toLocaleString("cs-CZ")}{assignment.replacedAt ? ` → ukončeno ${new Date(assignment.replacedAt).toLocaleString("cs-CZ")}` : " · platí"}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
