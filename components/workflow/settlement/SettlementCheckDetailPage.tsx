"use client";

import { useEffect, useMemo, useState } from "react";
import type { Exhibition } from "../../../domain/organizations";
import {
  countProblems,
  effectiveStandKey,
  emptyRowCounts,
  SETTLEMENT_CHECK_STATUSES,
  SETTLEMENT_CHECK_STATUS_LABELS_CS,
  SETTLEMENT_DECISION_LABELS_CS,
  SETTLEMENT_DECISIONS,
  SETTLEMENT_RESULT_STATUS_LABELS_CS,
  type SettlementAbfItem,
  type SettlementCatalogItem,
  type SettlementCheckStatus,
  type SettlementDecision,
  type SettlementDecisionValue,
  type SettlementFileFormat,
  type SettlementImportFile,
  type SettlementParser,
  type SettlementResultStatus,
  type SettlementSide,
  type SettlementStand,
  type SettlementVendorItem,
} from "../../../domain/settlementCheck";
import { matchesRowFilter, SETTLEMENT_ROW_FILTER_LABELS_CS, SETTLEMENT_ROW_FILTERS, type SettlementRowFilter } from "../../../domain/settlementComparison";
import type { SettlementCheckDetail, SettlementResultRow, SettlementStandHeader } from "../../../domain/settlementService";
import type { PdfTextItem } from "../../../domain/technicalReportTableParsing";
import { SettlementApiError, type RemoteApiSettlementClient, type SettlementDictionary } from "../../../lib/db/settlementCheck.remoteApi.client";
import { CatalogItemPicker, SettlementDictionaryTab, SettlementRulesTab } from "./SettlementDictionaryPanels";

type VendorParserOption = Readonly<{ id: SettlementParser; label: string; formats: readonly SettlementFileFormat[] }>;
type Tab = "stands" | "files" | "dictionary" | "rules";
type Selection = Readonly<{ kind: "stand"; key: string }> | Readonly<{ kind: "unassigned"; standId: string }>;

const TAB_LABELS: Readonly<Record<Tab, string>> = { stands: "Stánky a porovnání", files: "Soubory a import", dictionary: "Slovník názvů", rules: "Pravidla realizačky" };

export function formatQuantity(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("cs-CZ", { maximumFractionDigits: 4 });
}

function sideQuantity(quantity: number | null, unit: string | null, lineCount: number): string {
  if (lineCount === 0) return "—";
  if (quantity === null) return "nelze sečíst";
  return `${formatQuantity(quantity)} ${unit ?? ""}`.trim();
}

/** pdf.js runs only in the browser (same split as Technické rastry): extract the text layer here, parse it on the server. */
async function extractPdfText(file: File): Promise<readonly PdfTextItem[]> {
  const [{ loadPdfDocument }, { extractPdfTextItems }] = await Promise.all([import("../../../lib/pdf/pdfDocumentLoader"), import("../../../lib/pdf/pdfTextExtraction")]);
  const document = await loadPdfDocument({ data: await file.arrayBuffer() });
  try {
    return await extractPdfTextItems(document);
  } finally {
    await document.destroy();
  }
}

export function SettlementCheckDetailPage({
  client,
  checkId,
  events,
  actorName,
  vendorParsers,
  onBack,
}: {
  client: RemoteApiSettlementClient;
  checkId: string;
  events: readonly Exhibition[];
  actorName: string;
  vendorParsers: readonly VendorParserOption[];
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<SettlementCheckDetail | null>(null);
  const [dictionary, setDictionary] = useState<SettlementDictionary>({ catalogItems: [], catalogNames: [], mappings: [] });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("stands");
  const [actor, setActor] = useState(actorName);

  async function reload() {
    const next = await client.get(checkId);
    setDetail(next);
    setDictionary(await client.dictionary(next.check.realizationCompanyId));
  }

  useEffect(() => {
    reload().catch((cause) => setError(cause instanceof Error ? cause.message : "Kontrolu se nepodařilo načíst."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkId]);

  /** Every write: run it, then re-read the check (the server has already recomputed). An error never leaves stale "saved" UI. */
  async function run(action: () => Promise<unknown>, successNotice = ""): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await reload();
      if (successNotice) setNotice(successNotice);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Akce se nezdařila.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!detail) {
    return (
      <div className="workspacePage">
        <button type="button" className="textButton" onClick={onBack}>← Zpět na kontroly</button>
        {error ? <p className="uploadError">{error}</p> : <p className="workspaceEmpty">Načítám kontrolu…</p>}
      </div>
    );
  }

  const { check } = detail;
  const eventName = events.find((event) => event.id === check.eventId)?.name ?? check.eventId;
  const isClosed = check.status === "closed";

  return (
    <div className="workspacePage settlementPage">
      <button type="button" className="textButton" onClick={onBack}>← Zpět na kontroly</button>
      <div className="workspacePageHeader">
        <div>
          <span className="eyebrow">KONTROLA VYÚČTOVÁNÍ</span>
          <h1>{eventName}</h1>
          <p>
            {check.realizationCompanyName}
            {check.lastComparedAt ? ` · porovnáno ${new Date(check.lastComparedAt).toLocaleString("cs-CZ")}` : " · zatím bez porovnání"}
          </p>
        </div>
        <div className="settlementHeaderControls">
          <label>
            <span>Stav kontroly</span>
            <select value={check.status} disabled={busy} onChange={(event) => void run(() => client.update(check.id, { status: event.target.value as SettlementCheckStatus }))}>
              {SETTLEMENT_CHECK_STATUSES.map((status) => <option key={status} value={status}>{SETTLEMENT_CHECK_STATUS_LABELS_CS[status]}</option>)}
            </select>
          </label>
          <label>
            <span>Vaše jméno</span>
            <input value={actor} onChange={(event) => setActor(event.target.value)} placeholder="pro záznam rozhodnutí" />
          </label>
          <button type="button" disabled={busy} onClick={() => void run(() => client.recompute(check.id), "Porovnání bylo přepočítáno z uložených dat.")}>{busy ? "Pracuji…" : "Přepočítat porovnání"}</button>
        </div>
      </div>

      {isClosed && <p className="temporaryNotice">Kontrola je uzavřená — importy, přiřazení a rozhodnutí jsou zamčené. Pro úpravy změňte stav.</p>}
      {error && <p className="uploadError" role="alert">{error}</p>}
      {notice && <p className="settlementNotice">{notice}</p>}

      <div className="settlementTabs" role="tablist">
        {(Object.keys(TAB_LABELS) as Tab[]).map((key) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? "active" : undefined} onClick={() => setTab(key)}>{TAB_LABELS[key]}</button>
        ))}
      </div>

      {tab === "stands" && <StandsTab detail={detail} dictionary={dictionary} client={client} busy={busy} actor={actor} run={run} onOpenFiles={() => setTab("files")} />}
      {tab === "files" && <FilesTab detail={detail} client={client} busy={busy} actor={actor} vendorParsers={vendorParsers} run={run} setError={setError} />}
      {tab === "dictionary" && <SettlementDictionaryTab check={check} dictionary={dictionary} client={client} busy={busy} run={run} />}
      {tab === "rules" && <SettlementRulesTab check={check} eventName={eventName} catalogItems={dictionary.catalogItems} client={client} busy={busy} actor={actor} run={run} />}
    </div>
  );
}

type Run = (action: () => Promise<unknown>, successNotice?: string) => Promise<boolean>;

// ============================================================================
// Files and import
// ============================================================================

type PendingConflict = Readonly<{ side: SettlementSide; file: File; pdfTextItems?: readonly PdfTextItem[]; message: string }>;

function FilesTab({
  detail,
  client,
  busy,
  actor,
  vendorParsers,
  run,
  setError,
}: {
  detail: SettlementCheckDetail;
  client: RemoteApiSettlementClient;
  busy: boolean;
  actor: string;
  vendorParsers: readonly VendorParserOption[];
  run: Run;
  setError: (message: string) => void;
}) {
  const [parser, setParser] = useState<SettlementParser | "">(vendorParsers[0]?.id ?? "");
  const [conflict, setConflict] = useState<PendingConflict | undefined>(undefined);
  const { check, files } = detail;

  async function upload(side: SettlementSide, file: File, mode?: "replace" | "add", knownPdfText?: readonly PdfTextItem[]) {
    let pdfTextItems = knownPdfText;
    await run(async () => {
      if (side === "abf" && file.name.toLocaleLowerCase("cs").endsWith(".pdf") && !pdfTextItems) pdfTextItems = await extractPdfText(file);
      try {
        await client.importFile({ checkId: check.id, side, file, mode, parser: side === "vendor" && parser ? parser : undefined, pdfTextItems, actorName: actor || undefined });
        setConflict(undefined);
      } catch (cause) {
        if (cause instanceof SettlementApiError && cause.code === "same_name_file") {
          setConflict({ side, file, pdfTextItems, message: cause.message });
          return;
        }
        throw cause;
      }
    }, undefined);
  }

  function onPick(side: SettlementSide, input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    setError("");
    void upload(side, file);
  }

  const visibleFiles = (side: SettlementSide) => files.filter((file) => file.side === side);

  return (
    <div className="settlementFiles">
      {conflict && (
        <div className="workflowCard settlementConflict" role="alertdialog">
          <strong>Soubor se stejným jménem už je naimportovaný</strong>
          <p>{conflict.message}</p>
          <div className="printSurfaceCreateFormActions">
            <button type="button" disabled={busy} onClick={() => void upload(conflict.side, conflict.file, "replace", conflict.pdfTextItems)}>Nahradit původní verzi</button>
            <button type="button" disabled={busy} onClick={() => void upload(conflict.side, conflict.file, "add", conflict.pdfTextItems)}>Přidat jako další soubor</button>
            <button type="button" disabled={busy} onClick={() => setConflict(undefined)}>Zrušit</button>
          </div>
        </div>
      )}

      <div className="settlementFileColumns">
        <div className="workflowCard">
          <div className="workflowCardHeader"><div><span>STRANA ABF</span><strong>Objednávky ABF</strong></div></div>
          <p className="workflowMuted">Sestava „5. Stavby – tisk vše katalog“ pro tuto realizační firmu. XLSX je spolehlivější; PDF s textovou vrstvou je náhradní zdroj.</p>
          <label className="settlementUpload">
            <input type="file" accept=".xlsx,.xlsm,.pdf" disabled={busy || check.status === "closed"} onChange={(event) => onPick("abf", event.target)} />
          </label>
          <FileList files={visibleFiles("abf")} busy={busy} onDelete={(file) => void run(() => client.deleteFile(check.id, file.id))} />
        </div>

        <div className="workflowCard">
          <div className="workflowCardHeader"><div><span>STRANA REALIZAČKY</span><strong>Vyúčtování — {check.realizationCompanyName}</strong></div></div>
          <p className="workflowMuted">Jeden soubor za halu; do stejné kontroly lze nahrát více souborů (hala 3, hala 4…).</p>
          <label className="settlementField">
            <span>Formát vyúčtování</span>
            <select value={parser} onChange={(event) => setParser(event.target.value as SettlementParser)}>
              {vendorParsers.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
          <label className="settlementUpload">
            <input type="file" accept=".xlsx,.xlsm" disabled={busy || check.status === "closed" || vendorParsers.length === 0} onChange={(event) => onPick("vendor", event.target)} />
          </label>
          <FileList files={visibleFiles("vendor")} busy={busy} onDelete={(file) => void run(() => client.deleteFile(check.id, file.id))} />
        </div>
      </div>
    </div>
  );
}

function FileList({ files, busy, onDelete }: { files: readonly SettlementImportFile[]; busy: boolean; onDelete: (file: SettlementImportFile) => void }) {
  if (files.length === 0) return <p className="workspaceEmpty">Zatím žádný soubor.</p>;
  return (
    <div className="settlementFileList">
      {files.map((file) => {
        const warnings = file.summary.warnings.filter((warning) => warning.severity === "warning");
        const infos = file.summary.warnings.filter((warning) => warning.severity === "info");
        return (
          <div key={file.id} className={file.status === "imported" ? "settlementFile" : "settlementFile superseded"}>
            <div className="settlementFileHead">
              <strong>{file.fileName}</strong>
              <em className="settlementBadge">{file.status === "imported" ? file.format.toUpperCase() : file.status === "superseded" ? "nahrazeno novější verzí" : "nedokončený import"}</em>
              {file.status !== "superseded" && (
                <button type="button" className="textButton dangerText" disabled={busy} onClick={() => { if (window.confirm(`Odebrat soubor „${file.fileName}“ z kontroly? Jeho importované řádky se smažou a porovnání se přepočítá.`)) onDelete(file); }}>Odebrat</button>
              )}
            </div>
            <small>
              {new Date(file.importedAt).toLocaleString("cs-CZ")} · {file.summary.standCount} stánků · {file.summary.itemCount} {file.side === "abf" ? "objednaných položek" : "účtovaných položek"}
              {file.side === "vendor" ? ` · ${file.summary.templateRowCount} nevyplněných řádků šablony (uloženo, neporovnává se)` : ""}
              {file.summary.unassignedCount > 0 ? ` · ${file.summary.unassignedCount} nepřiřazených` : ""}
            </small>
            {warnings.length > 0 && (
              <details open className="settlementWarnings">
                <summary>{warnings.length} upozornění importu</summary>
                <ul>{warnings.map((warning, index) => <li key={index}>{warning.message}</li>)}</ul>
              </details>
            )}
            {infos.length > 0 && (
              <details className="settlementWarnings info">
                <summary>{infos.length} informací</summary>
                <ul>{infos.map((info, index) => <li key={index}>{info.message}</li>)}</ul>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ============================================================================
// Stands overview + comparison
// ============================================================================

type Lookups = Readonly<{
  rowsByStand: ReadonlyMap<string, readonly SettlementResultRow[]>;
  abfById: ReadonlyMap<string, SettlementAbfItem>;
  vendorById: ReadonlyMap<string, SettlementVendorItem>;
  standById: ReadonlyMap<string, SettlementStand>;
  fileById: ReadonlyMap<string, SettlementImportFile>;
  decisionByKey: ReadonlyMap<string, SettlementDecision>;
  catalogById: ReadonlyMap<string, SettlementCatalogItem>;
  vendorItemsByStand: ReadonlyMap<string, readonly SettlementVendorItem[]>;
  abfItemsByStand: ReadonlyMap<string, readonly SettlementAbfItem[]>;
}>;

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return map;
}

function StandsTab({
  detail,
  dictionary,
  client,
  busy,
  actor,
  run,
  onOpenFiles,
}: {
  detail: SettlementCheckDetail;
  dictionary: SettlementDictionary;
  client: RemoteApiSettlementClient;
  busy: boolean;
  actor: string;
  run: Run;
  onOpenFiles: () => void;
}) {
  const [filter, setFilter] = useState<SettlementRowFilter>("all");
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<Selection | undefined>(undefined);

  const lookups: Lookups = useMemo(() => ({
    rowsByStand: groupBy(detail.results, (row) => row.standKey),
    abfById: new Map(detail.abfItems.map((item) => [item.id, item])),
    vendorById: new Map(detail.vendorItems.map((item) => [item.id, item])),
    standById: new Map(detail.stands.map((stand) => [stand.id, stand])),
    fileById: new Map(detail.files.map((file) => [file.id, file])),
    decisionByKey: new Map(detail.decisions.map((decision) => [`${decision.standKey}|${decision.rowKey}`, decision])),
    catalogById: new Map(dictionary.catalogItems.map((item) => [item.id, item])),
    vendorItemsByStand: groupBy(detail.vendorItems, (item) => item.standId),
    abfItemsByStand: groupBy(detail.abfItems, (item) => item.standId),
  }), [detail, dictionary]);

  const needle = query.trim().toLocaleLowerCase("cs");
  const stands = detail.standIndex.filter((stand) => {
    const rows = lookups.rowsByStand.get(stand.standKey) ?? [];
    if (filter !== "all" && !rows.some((row) => matchesRowFilter(row.status, filter))) return false;
    if (!needle) return true;
    return `${stand.displayNumber} ${stand.standKey} ${stand.abfExhibitorName ?? ""} ${stand.vendorExhibitorName ?? ""}`.toLocaleLowerCase("cs").includes(needle);
  });

  const unassigned = detail.stands.filter((stand) => !effectiveStandKey(stand));
  const unassignedVendorBilled = unassigned.filter((stand) => stand.side === "vendor" && lookups.vendorItemsByStand.has(stand.id));
  const unassignedVendorEmpty = unassigned.filter((stand) => stand.side === "vendor" && !lookups.vendorItemsByStand.has(stand.id));
  const unassignedAbf = unassigned.filter((stand) => stand.side === "abf");

  const totals = detail.check.summary?.rowCounts ?? emptyRowCounts();
  const filterCount = (candidate: SettlementRowFilter) => (candidate === "all"
    ? detail.results.length
    : candidate === "unclear" ? totals.unclear + totals.requires_rule : totals[candidate as SettlementResultStatus]);

  if (detail.files.filter((file) => file.status === "imported").length === 0) {
    return (
      <div className="workflowCard">
        <p className="workspaceEmpty">Kontrola zatím nemá žádný importovaný soubor.</p>
        <button type="button" onClick={onOpenFiles}>Nahrát objednávky ABF a vyúčtování</button>
      </div>
    );
  }

  const selectedStand = selection?.kind === "stand" ? detail.standIndex.find((stand) => stand.standKey === selection.key) : undefined;
  const selectedUnassigned = selection?.kind === "unassigned" ? lookups.standById.get(selection.standId) : undefined;

  const group = (title: string, matchState: SettlementStandHeader["matchState"]) => {
    const members = stands.filter((stand) => stand.matchState === matchState);
    if (members.length === 0) return null;
    return (
      <div className="settlementStandGroup">
        <h3>{title} <small>{members.length}</small></h3>
        {members.map((stand) => {
          const counts = emptyRowCounts();
          for (const row of lookups.rowsByStand.get(stand.standKey) ?? []) counts[row.status] += 1;
          const problems = countProblems(counts);
          const active = selection?.kind === "stand" && selection.key === stand.standKey;
          return (
            <button key={stand.standKey} type="button" className={active ? "settlementStandItem active" : "settlementStandItem"} onClick={() => setSelection({ kind: "stand", key: stand.standKey })}>
              <strong>{stand.displayNumber}</strong>
              <span>{stand.abfExhibitorName ?? stand.vendorExhibitorName ?? "—"}</span>
              <em className={problems > 0 ? "settlementBadge settlement-difference" : "settlementBadge settlement-match"} title={problems > 0 ? `${counts.difference} rozdílů · ${counts.only_abf} pouze ABF · ${counts.only_vendor} pouze realizačka · ${counts.unclear + counts.requires_rule} nejasných` : "Bez otevřených problémů"}>
                {problems > 0 ? problems : "✓"}
              </em>
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <div>
      <div className="settlementFilters">
        {SETTLEMENT_ROW_FILTERS.map((candidate) => (
          <button key={candidate} type="button" className={filter === candidate ? "active" : undefined} onClick={() => setFilter(candidate)}>
            {SETTLEMENT_ROW_FILTER_LABELS_CS[candidate]} <small>{filterCount(candidate)}</small>
          </button>
        ))}
        {totals.out_of_scope > 0 && <span className="workflowMuted">+ {totals.out_of_scope} mimo rozsah (podle pravidel)</span>}
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Hledat stánek nebo vystavovatele…" />
      </div>

      <div className="settlementSplit">
        <aside className="settlementStandList">
          {group("Spárované stánky", "matched")}
          {group("Pouze v objednávkách ABF", "abf_only")}
          {group("Pouze ve vyúčtování realizačky", "vendor_only")}
          {stands.length === 0 && <p className="workspaceEmpty">Žádný stánek neodpovídá filtru.</p>}

          {(unassignedVendorBilled.length > 0 || unassignedAbf.length > 0 || unassignedVendorEmpty.length > 0) && (
            <div className="settlementStandGroup">
              <h3>Nepřiřazené / Ostatní <small>{unassignedVendorBilled.length + unassignedAbf.length}</small></h3>
              {[...unassignedVendorBilled, ...unassignedAbf].map((stand) => (
                <button key={stand.id} type="button" className={selection?.kind === "unassigned" && selection.standId === stand.id ? "settlementStandItem active" : "settlementStandItem"} onClick={() => setSelection({ kind: "unassigned", standId: stand.id })}>
                  <strong>{stand.label}</strong>
                  <span>{stand.side === "vendor" ? stand.title ?? "záložka vyúčtování" : stand.exhibitorName ?? "objednávka ABF"}</span>
                  <em className="settlementBadge settlement-unclear">{(stand.side === "vendor" ? lookups.vendorItemsByStand.get(stand.id) : lookups.abfItemsByStand.get(stand.id))?.length ?? 0}</em>
                </button>
              ))}
              {unassignedVendorEmpty.length > 0 && (
                <details className="settlementEmptyTemplates">
                  <summary>{unassignedVendorEmpty.length} nevyplněných záložek šablony</summary>
                  <p>Záložky bez jediné účtované položky: {unassignedVendorEmpty.map((stand) => stand.label).join(", ")}. Jsou uložené, do porovnání nevstupují.</p>
                </details>
              )}
            </div>
          )}
        </aside>

        <section className="settlementStandDetail">
          {!selectedStand && !selectedUnassigned && <p className="workspaceEmpty">Vyberte stánek vlevo.</p>}
          {selectedStand && (
            <StandDetail
              key={selectedStand.standKey}
              stand={selectedStand}
              detail={detail}
              dictionary={dictionary}
              lookups={lookups}
              filter={filter}
              client={client}
              busy={busy}
              actor={actor}
              run={run}
            />
          )}
          {selectedUnassigned && (
            <UnassignedDetail key={selectedUnassigned.id} stand={selectedUnassigned} detail={detail} lookups={lookups} client={client} busy={busy} run={run} onAssigned={() => setSelection(undefined)} />
          )}
        </section>
      </div>
    </div>
  );
}

function sourceLabel(file: SettlementImportFile | undefined, parts: readonly (string | null)[]): string {
  return [file?.fileName ?? "neznámý soubor", ...parts.filter(Boolean)].join(" · ");
}

function StandDetail({
  stand,
  detail,
  dictionary,
  lookups,
  filter,
  client,
  busy,
  actor,
  run,
}: {
  stand: SettlementStandHeader;
  detail: SettlementCheckDetail;
  dictionary: SettlementDictionary;
  lookups: Lookups;
  filter: SettlementRowFilter;
  client: RemoteApiSettlementClient;
  busy: boolean;
  actor: string;
  run: Run;
}) {
  const [openRowKey, setOpenRowKey] = useState<string | undefined>(undefined);
  const [sourceSheet, setSourceSheet] = useState<Readonly<{ standId: string; rows: readonly SettlementVendorItem[] }> | undefined>(undefined);
  const [sourceError, setSourceError] = useState("");

  const allRows = lookups.rowsByStand.get(stand.standKey) ?? [];
  const rows = allRows.filter((row) => matchesRowFilter(row.status, filter));
  const sourceStands = detail.stands.filter((candidate) => effectiveStandKey(candidate) === stand.standKey);
  const abfStands = sourceStands.filter((candidate) => candidate.side === "abf");
  const vendorStands = sourceStands.filter((candidate) => candidate.side === "vendor");

  async function showSourceSheet(standId: string) {
    setSourceError("");
    try {
      setSourceSheet({ standId, rows: await client.sourceRows(detail.check.id, standId) });
    } catch (cause) {
      setSourceError(cause instanceof Error ? cause.message : "Původní list se nepodařilo načíst.");
    }
  }

  return (
    <div>
      <div className="settlementStandHead">
        <h2>Stánek {stand.displayNumber}</h2>
        <p>
          {stand.matchState === "abf_only" && <em className="settlementBadge settlement-only_abf">Stánek je jen v objednávkách ABF</em>}
          {stand.matchState === "vendor_only" && <em className="settlementBadge settlement-only_vendor">Stánek je jen ve vyúčtování realizačky</em>}
        </p>
        <dl>
          <dt>ABF</dt>
          <dd>{abfStands.length === 0 ? "—" : abfStands.map((source) => `${source.exhibitorName ?? "?"} · doklad ${source.documentNumber ?? "?"} · ${lookups.fileById.get(source.fileId)?.fileName ?? ""}`).join(" | ")}</dd>
          <dt>Realizačka</dt>
          <dd>
            {vendorStands.length === 0 ? "—" : vendorStands.map((source) => (
              <span key={source.id}>
                {source.title ?? source.label} · záložka „{source.label}“ · {lookups.fileById.get(source.fileId)?.fileName ?? ""}{source.manualStandKey ? " · přiřazeno ručně" : ""}{" "}
                <button type="button" className="textButton" onClick={() => void showSourceSheet(source.id)}>Zobrazit celý původní list</button>{" "}
                {source.manualStandKey && (
                  <button type="button" className="textButton dangerText" disabled={busy || detail.check.status === "closed"} onClick={() => void run(() => client.assignStand(detail.check.id, source.id, ""), "Ruční přiřazení zrušeno — záložka je zpět mezi nepřiřazenými.")}>Zrušit ruční přiřazení</button>
                )}{" "}
              </span>
            ))}
          </dd>
        </dl>
      </div>

      {sourceError && <p className="uploadError">{sourceError}</p>}
      {sourceSheet && <SourceSheet rows={sourceSheet.rows} onClose={() => setSourceSheet(undefined)} />}

      <div className="printSurfaceTable">
        <div className="settlementRow printSurfaceTableHeader">
          <span>Položka</span><span>ABF</span><span>Realizačka</span><span>Rozdíl</span><span>Stav</span><span />
        </div>
        {rows.length === 0 && <p className="workspaceEmpty">{allRows.length === 0 ? "Stánek nemá žádnou položku k porovnání." : "Žádná položka neodpovídá filtru."}</p>}
        {rows.map((row) => {
          const decision = lookups.decisionByKey.get(`${stand.standKey}|${row.rowKey}`);
          const open = openRowKey === row.rowKey;
          return (
            <div key={row.rowKey} className="settlementRowGroup">
              <div className="settlementRow" onClick={() => setOpenRowKey(open ? undefined : row.rowKey)}>
                <span>
                  <strong>{row.label}</strong>
                  {row.abfCode && <small> {row.abfCode}</small>}
                  {decision?.decision && <small className="settlementDecisionMark"> · {SETTLEMENT_DECISION_LABELS_CS[decision.decision]}</small>}
                </span>
                <span>{sideQuantity(row.abfQuantity, row.abfUnit, row.abfLineIds.length)}</span>
                <span>{sideQuantity(row.vendorQuantity, row.vendorUnit, row.vendorLineIds.length)}</span>
                <span className={row.difference ? "settlementProblemCount" : undefined}>{row.difference === null ? "—" : `${row.difference > 0 ? "+" : ""}${formatQuantity(row.difference)}`}</span>
                <span><em className={`settlementBadge settlement-${row.status}`}>{SETTLEMENT_RESULT_STATUS_LABELS_CS[row.status]}</em></span>
                <span aria-hidden>{open ? "▾" : "▸"}</span>
              </div>
              {open && (
                <RowDetail row={row} standKey={stand.standKey} decision={decision} detail={detail} dictionary={dictionary} lookups={lookups} client={client} busy={busy} actor={actor} run={run} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RowDetail({
  row,
  standKey,
  decision,
  detail,
  dictionary,
  lookups,
  client,
  busy,
  actor,
  run,
}: {
  row: SettlementResultRow;
  standKey: string;
  decision: SettlementDecision | undefined;
  detail: SettlementCheckDetail;
  dictionary: SettlementDictionary;
  lookups: Lookups;
  client: RemoteApiSettlementClient;
  busy: boolean;
  actor: string;
  run: Run;
}) {
  const { check } = detail;
  const abfLines = row.abfLineIds.map((id) => lookups.abfById.get(id)).filter((line): line is SettlementAbfItem => Boolean(line));
  const vendorLines = row.vendorLineIds.map((id) => lookups.vendorById.get(id)).filter((line): line is SettlementVendorItem => Boolean(line));
  const firstVendor = vendorLines[0];
  const firstAbf = abfLines[0];
  const existingMapping = firstVendor ? dictionary.mappings.find((mapping) => mapping.normalizedText === firstVendor.normalizedName) : undefined;

  const [vendorItemId, setVendorItemId] = useState(existingMapping?.catalogItemId ?? row.catalogItemId ?? "");
  const [vendorUnit, setVendorUnit] = useState(existingMapping?.unit ?? "");
  const [abfItemId, setAbfItemId] = useState(row.explanation.candidateCatalogItemIds[0] ?? "");
  const [decisionValue, setDecisionValue] = useState<SettlementDecisionValue | "">(decision?.decision ?? "");
  const [decisionNote, setDecisionNote] = useState(decision?.note ?? "");
  const locked = busy || check.status === "closed";

  const canMapVendor = vendorLines.length > 0 && (row.rowKey.startsWith("vendor:") || row.status === "requires_rule" || row.status === "unclear");
  const canMapAbf = row.rowKey.startsWith("abf:") && abfLines.length > 0;
  const canMarkOutOfScope = abfLines.length > 0 && vendorLines.length === 0 && (row.status === "only_abf" || row.status === "unclear");

  return (
    <div className="settlementRowDetail">
      {row.explanation.reasons.length > 0 && <ul className="settlementReasons">{row.explanation.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}

      <div className="settlementSources">
        <div>
          <h4>Původní řádky objednávky ABF</h4>
          {abfLines.length === 0 && <p className="workflowMuted">Žádný.</p>}
          {abfLines.map((line) => {
            const source = lookups.standById.get(line.standId);
            return (
              <p key={line.id}>
                <strong>{line.rawName}</strong> — {line.quantityRaw || "bez množství"} {line.unitRaw ?? ""}
                {line.note && <><br /><span>Poznámka: {line.note}</span></>}
                <br /><small>{sourceLabel(lookups.fileById.get(line.fileId), [source?.documentNumber ? `doklad ${source.documentNumber}` : null, line.sourcePage ? `strana ${line.sourcePage}` : line.sourceRow ? `řádek ${line.sourceRow}` : null])}</small>
              </p>
            );
          })}
        </div>
        <div>
          <h4>Původní řádky vyúčtování realizačky</h4>
          {vendorLines.length === 0 && <p className="workflowMuted">Žádný.</p>}
          {vendorLines.map((line) => (
            <p key={line.id}>
              <strong>{line.rawName}</strong> — {line.quantityRaw || "bez množství"} {line.unit ?? ""}{line.unitSource === "default" ? " (jednotka v textu není, bráno jako kusy)" : ""}
              {line.unitPrice !== null && <span> · {formatQuantity(line.unitPrice)} Kč/j.</span>}
              {line.note && <><br /><span>Poznámka: {line.note}</span></>}
              <br /><small>{sourceLabel(lookups.fileById.get(line.fileId), [`záložka „${line.sourceSheet}“`, `řádek ${line.sourceRow}`])}</small>
            </p>
          ))}
        </div>
      </div>

      {canMapVendor && firstVendor && (
        <div className="settlementAction">
          <h4>Slovník realizačky: „{firstVendor.rawName}“ = komponenta</h4>
          <div className="settlementActionRow">
            <CatalogItemPicker items={dictionary.catalogItems} value={vendorItemId} onChange={setVendorItemId} disabled={locked} />
            <input value={vendorUnit} onChange={(event) => setVendorUnit(event.target.value)} placeholder={`jednotka (z textu: ${firstVendor.unit ?? "?"})`} disabled={locked} className="settlementUnitInput" />
            <button
              type="button"
              disabled={locked || !vendorItemId}
              onClick={() => void run(() => client.saveMapping({ realizationCompanyId: check.realizationCompanyId, sourceText: firstVendor.rawName, catalogItemId: vendorItemId, unit: vendorUnit.trim() || null, status: "confirmed", recomputeCheckId: check.id }), "Mapování potvrzeno a uloženo do slovníku realizačky — platí i pro další importy této firmy.")}
            >
              Potvrdit mapování
            </button>
          </div>
          <small>Platí pro všechny akce firmy {check.realizationCompanyName}. Jednotku vyplňte jen tehdy, když text položky jednotku neuvádí správně.</small>
        </div>
      )}

      {canMapAbf && firstAbf && (
        <div className="settlementAction">
          <h4>Název ABF „{firstAbf.rawName}“ = komponenta</h4>
          <div className="settlementActionRow">
            <CatalogItemPicker items={dictionary.catalogItems} value={abfItemId} onChange={setAbfItemId} disabled={locked} />
            <button
              type="button"
              disabled={locked || !abfItemId}
              onClick={() => void run(() => client.addCatalogName({ catalogItemId: abfItemId, nameType: "abf_alternative", name: firstAbf.rawName, recomputeCheckId: check.id }), "Název uložen ke komponentě jako alternativní název ABF.")}
            >
              Přiřadit název ke komponentě
            </button>
          </div>
          <small>Uloží se jako alternativní název ABF u vybrané komponenty. Existující kódy a názvy katalogu se nemění.</small>
        </div>
      )}

      {canMarkOutOfScope && firstAbf && (
        <div className="settlementAction">
          <h4>Realizačka tuto položku neúčtuje</h4>
          <div className="settlementActionRow">
            <button
              type="button"
              disabled={locked}
              onClick={() => {
                if (!actor.trim()) { window.alert("Vyplňte nahoře své jméno — pravidlo musí mít autora, který ho ověřil."); return; }
                if (!window.confirm(`Vytvořit pro firmu ${check.realizationCompanyName} pravidlo „${row.label} — mimo rozsah“?\n\nPoložka se pak u všech stánků a akcí této firmy přestane hlásit jako „Pouze ABF“, pokud ji realizačka neúčtuje.`)) return;
                void run(() => client.createRule({
                  realizationCompanyId: check.realizationCompanyId,
                  rule: {
                    ruleType: "out_of_scope",
                    name: `${row.label} — mimo rozsah`,
                    explanation: `Položku „${row.label}“ firma ${check.realizationCompanyName} nedodává ani neúčtuje (např. služba ABF), proto se v kontrole neporovnává.`,
                    definition: row.catalogItemId ? { catalogItemId: row.catalogItemId } : { abfName: firstAbf.rawName },
                  },
                  activate: true,
                  actorName: actor.trim(),
                  recomputeCheckId: check.id,
                }), "Pravidlo vytvořeno a aktivováno. Najdete ho v záložce Pravidla realizačky.");
              }}
            >
              Označit jako mimo rozsah
            </button>
          </div>
          <small>Vytvoří dohledatelné pravidlo (záložka Pravidla realizačky), které lze kdykoli vypnout.</small>
        </div>
      )}

      <div className="settlementAction">
        <h4>Ruční rozhodnutí</h4>
        <div className="settlementActionRow">
          <select value={decisionValue} onChange={(event) => setDecisionValue(event.target.value as SettlementDecisionValue | "")} disabled={locked}>
            <option value="">— bez rozhodnutí —</option>
            {SETTLEMENT_DECISIONS.map((value) => <option key={value} value={value}>{SETTLEMENT_DECISION_LABELS_CS[value]}</option>)}
          </select>
          <input value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} placeholder="poznámka" disabled={locked} className="settlementWideInput" />
          <button type="button" disabled={locked} onClick={() => void run(() => client.saveDecision({ checkId: check.id, standKey, rowKey: row.rowKey, decision: decisionValue || null, note: decisionNote, actorName: actor.trim() || undefined }))}>Uložit</button>
        </div>
        {decision && <small>Naposledy uloženo {new Date(decision.updatedAt).toLocaleString("cs-CZ")}{decision.createdBy ? ` · ${decision.createdBy}` : ""}. Rozhodnutí zůstává i po přepočtu a novém importu.</small>}
      </div>
    </div>
  );
}

/** The complete original vendor sheet — every template row, billed rows highlighted. */
function SourceSheet({ rows, onClose }: { rows: readonly SettlementVendorItem[]; onClose: () => void }) {
  const billed = rows.filter((row) => row.isBilled).length;
  return (
    <div className="workflowCard settlementSourceSheet">
      <div className="workflowCardHeader">
        <div><span>PŮVODNÍ IMPORT</span><strong>Záložka „{rows[0]?.sourceSheet ?? ""}“ — {rows.length} řádků, z toho {billed} účtovaných</strong></div>
        <button type="button" onClick={onClose}>Zavřít</button>
      </div>
      <table className="pricingPreviewTable">
        <thead><tr><th>Řádek</th><th>Položka</th><th>Cena/j.</th><th>Množství</th><th>Cena</th><th>Poznámka</th></tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={row.isBilled ? "settlementBilledRow" : "settlementTemplateRow"}>
              <td>{row.sourceRow}</td>
              <td>{row.rawName}</td>
              <td>{formatQuantity(row.unitPrice)}</td>
              <td>{row.quantityRaw}</td>
              <td>{formatQuantity(row.lineTotal)}</td>
              <td>{row.note ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UnassignedDetail({
  stand,
  detail,
  lookups,
  client,
  busy,
  run,
  onAssigned,
}: {
  stand: SettlementStand;
  detail: SettlementCheckDetail;
  lookups: Lookups;
  client: RemoteApiSettlementClient;
  busy: boolean;
  run: Run;
  onAssigned: () => void;
}) {
  const [standNumber, setStandNumber] = useState("");
  const file = lookups.fileById.get(stand.fileId);
  const vendorLines = lookups.vendorItemsByStand.get(stand.id) ?? [];
  const abfLines = lookups.abfItemsByStand.get(stand.id) ?? [];
  const locked = busy || detail.check.status === "closed";

  return (
    <div>
      <div className="settlementStandHead">
        <h2>{stand.side === "vendor" ? `Záložka „${stand.label}“` : `Objednávka ABF „${stand.label}“`}</h2>
        <p><em className="settlementBadge settlement-unclear">Nepřiřazeno ke stánku</em> {stand.unassignedReason ?? ""}</p>
        <dl>
          <dt>Nadpis</dt><dd>{stand.title ?? stand.exhibitorName ?? "—"}</dd>
          <dt>Zdroj</dt><dd>{file?.fileName ?? "—"}{stand.documentNumber ? ` · doklad ${stand.documentNumber}` : ""}</dd>
        </dl>
      </div>

      <div className="settlementAction">
        <h4>Přiřadit ke stánku ručně</h4>
        <div className="settlementActionRow">
          <input value={standNumber} onChange={(event) => setStandNumber(event.target.value)} placeholder="číslo stánku, např. 4C1" disabled={locked} />
          <button type="button" disabled={locked || !standNumber.trim()} onClick={() => void run(() => client.assignStand(detail.check.id, stand.id, standNumber.trim()), `Přiřazeno ke stánku ${standNumber.trim()}.`).then((ok) => { if (ok) onAssigned(); })}>Přiřadit</button>
        </div>
        <small>Položky se pak porovnají se stánkem, který zadáte. Bez přiřazení zůstávají zde a do porovnání nevstupují — číslo stánku se nikdy nedoplňuje automaticky.</small>
      </div>

      <div className="printSurfaceTable">
        <div className="settlementRow printSurfaceTableHeader"><span>Položka</span><span>Množství</span><span>Jednotka</span><span>Řádek</span><span>Poznámka</span><span /></div>
        {vendorLines.map((line) => (
          <div key={line.id} className="settlementRow">
            <span><strong>{line.rawName}</strong></span><span>{line.quantityRaw}</span><span>{line.unit ?? "—"}</span><span>{line.sourceRow}</span><span>{line.note ?? ""}</span><span />
          </div>
        ))}
        {abfLines.map((line) => (
          <div key={line.id} className="settlementRow">
            <span><strong>{line.rawName}</strong></span><span>{line.quantityRaw}</span><span>{line.unitRaw ?? "—"}</span><span>{line.sourcePage ? `str. ${line.sourcePage}` : line.sourceRow ?? ""}</span><span>{line.note ?? ""}</span><span />
          </div>
        ))}
      </div>
    </div>
  );
}
