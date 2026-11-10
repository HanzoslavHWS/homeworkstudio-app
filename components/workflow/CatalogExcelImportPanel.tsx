"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";

/**
 * Administrace → Katalog → Importovat Excel (V1-IMPORT-UI-01). The workbook of the catalog
 * template (catalog-template/1), sheets Produkty + Sluzby — the same server-side logic as the CLI.
 * File → preview (no write) → overview → explicit confirmation → result. The server decides
 * everything (rights, plan, counts); this panel only shows its answers. Changing the file drops the
 * preview; a page reload never starts an import.
 */
type ImportValue = string | number | boolean | null;
type Issue = { severity: "error" | "warning"; field?: string; message: string };
type Change = { field: string; labelCs: string; before: ImportValue; after: ImportValue };
type Row = { sheet: string; rowNumber: number; label: string; action: "create" | "update" | "unchanged" | "conflict"; itemId?: string; changes: Change[]; issues: Issue[] };
type Counts = { create: number; update: number; unchanged: number; conflict: number };
type SheetReport = { name: string; status: "imported" | "helper" | "empty" | "unsupported_with_data" | "unknown_with_data"; dataRows: number };
type Preview = {
  runId: string;
  status: string;
  fileName: string;
  fileSha256: string;
  fileSize: number;
  dataRows: number;
  expiresAt: string;
  templateFormat: string | null;
  environment: string | null;
  sheets: SheetReport[];
  issues: Issue[];
  summary: Counts & { warnings: number };
  bySheet: Record<string, Counts>;
  rows: Row[];
  canConfirm: boolean;
  blockReasons: string[];
  limits: { maxBytes: number; maxDataRows: number; previewValidMinutes: number };
  categoryNames: Record<string, string>;
};
type Outcome = { sheet: string; rowNumber: number; label: string; action: "create" | "update"; status: "written" | "failed" | "not_attempted"; itemId?: string; message?: string };
type Run = { id: string; status: string; fileName: string; fileSha256: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null; resultRows: Outcome[] | null; errorMessage: string | null; summary?: { summary?: Counts } };
type Phase = "idle" | "previewing" | "ready" | "confirming" | "done" | "error";

const ACTION_LABELS: Readonly<Record<Row["action"], string>> = { create: "Vytvořit", update: "Aktualizovat", unchanged: "Beze změny", conflict: "Konflikt" };
const RUN_STATUS_LABELS: Readonly<Record<string, string>> = { previewed: "náhled", no_changes: "beze změny", superseded: "nahrazen", running: "probíhá", succeeded: "dokončen", partial: "částečně (zastaven chybou)", failed: "selhal", interrupted: "přerušen" };
const OUTCOME_LABELS: Readonly<Record<Outcome["status"], string>> = { written: "Uloženo", failed: "Selhalo", not_attempted: "Neprovedeno" };
const SHEET_STATUS: Readonly<Record<SheetReport["status"], string>> = { imported: "importuje se", helper: "pomocný list (ignoruje se)", empty: "prázdný", unsupported_with_data: "NEPODPOROVANÝ list s daty", unknown_with_data: "NEZNÁMÝ list s daty" };

const show = (value: ImportValue) => (value === null ? "∅" : typeof value === "boolean" ? (value ? "ANO" : "NE") : String(value));
/** Category values are register ids — shown by their Czech name. */
const showField = (field: string, value: ImportValue, names: Readonly<Record<string, string>> | undefined) => (field === "category" && typeof value === "string" && names?.[value] ? `${names[value]} [${value}]` : show(value));
const formatDate = (value: string | null) => (value ? new Date(value).toLocaleString("cs-CZ", { dateStyle: "short", timeStyle: "medium" }) : "—");

async function send<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T & { error?: string; code?: string } }> {
  const response = await fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" }, ...init });
  const body = (await response.json().catch(() => ({ error: `Server odpověděl neočekávaně (HTTP ${response.status}).` }))) as T & { error?: string; code?: string };
  return { ok: response.ok, status: response.status, body };
}

export function CatalogExcelImportPanel({ onClose, onApplied }: Readonly<{ onClose: () => void; onApplied: () => void }>) {
  const [availability, setAvailability] = useState<{ enabled: boolean; reason: string | null; limits?: Preview["limits"] } | undefined>();
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [actionFilter, setActionFilter] = useState<"all" | "changes" | Row["action"] | "warnings">("changes");
  const [sheetFilter, setSheetFilter] = useState("all");
  const [run, setRun] = useState<Run | null>(null);
  const [recent, setRecent] = useState<Run[]>([]);
  const fileToken = useRef(0);
  // Synchronous guard: a double click fires twice before React re-renders the disabled button.
  const confirmingRef = useRef(false);

  async function loadRecent() {
    const result = await send<{ runs?: Run[] }>("/api/catalog-admin/excel-import/runs").catch(() => undefined);
    if (result?.ok) setRecent(result.body.runs ?? []);
  }

  useEffect(() => {
    void (async () => {
      const result = await send<{ enabled: boolean; reason: string | null; limits: Preview["limits"] }>("/api/catalog-admin/excel-import").catch(() => undefined);
      setAvailability(result?.ok ? result.body : { enabled: false, reason: result?.body.error ?? "Stav importu se nepodařilo zjistit." });
      if (result?.ok && result.body.enabled) void loadRecent();
    })();
  }, []);

  async function runPreview(nextFile: File) {
    const token = ++fileToken.current;
    setPhase("previewing");
    setError("");
    setPreview(null);
    setRun(null);
    setAcknowledged(false);
    const form = new FormData();
    form.set("file", nextFile);
    try {
      const result = await send<Preview>("/api/catalog-admin/excel-import/preview", { method: "POST", body: form });
      if (token !== fileToken.current) return; // a newer file was chosen meanwhile
      if (!result.ok) throw new Error(result.body.error ?? "Náhled se nepodařilo připravit.");
      setPreview(result.body);
      setActionFilter(result.body.summary.create + result.body.summary.update + result.body.summary.conflict > 0 ? "changes" : "all");
      setSheetFilter("all");
      setPhase("ready");
    } catch (cause) {
      if (token !== fileToken.current) return;
      setError(cause instanceof Error ? cause.message : "Náhled se nepodařilo připravit.");
      setPhase("error");
    }
  }

  async function pollRun(runId: string) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const result = await send<{ run?: Run }>(`/api/catalog-admin/excel-import/runs?id=${encodeURIComponent(runId)}`).catch(() => undefined);
      if (result?.ok && result.body.run) {
        setRun(result.body.run);
        if (result.body.run.status !== "running") return result.body.run;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return undefined;
  }

  async function confirm() {
    if (!file || !preview || !preview.canConfirm || !acknowledged || phase === "confirming" || confirmingRef.current) return;
    confirmingRef.current = true;
    setPhase("confirming");
    setError("");
    const form = new FormData();
    form.set("file", file);
    form.set("runId", preview.runId);
    try {
      const result = await send<{ run?: Run; written?: number }>("/api/catalog-admin/excel-import/confirm", { method: "POST", body: form });
      if (result.body.run) setRun(result.body.run);
      if (!result.ok) {
        setError(result.body.error ?? "Import se nepodařilo provést.");
        setPhase(result.body.run ? "done" : "error");
      } else {
        setPhase("done");
      }
      onApplied();
      void loadRecent();
    } catch {
      // Lost connection: the server may still be writing — never claim "nothing was saved".
      setError("Spojení se serverem se přerušilo. Ověřuji skutečný stav importu…");
      const final = await pollRun(preview.runId);
      setError(final ? "Spojení se přerušilo, stav importu byl dohledán na serveru (viz výsledek)." : "Stav importu se nepodařilo ověřit. Otevřete níže Poslední importy nebo připravte nový náhled.");
      setPhase("done");
      onApplied();
      void loadRecent();
    } finally {
      confirmingRef.current = false;
    }
  }

  const rows = useMemo(() => (preview?.rows ?? []).filter((row) => {
    if (sheetFilter !== "all" && row.sheet !== sheetFilter) return false;
    if (actionFilter === "all") return true;
    if (actionFilter === "changes") return row.action !== "unchanged" || row.issues.length > 0;
    if (actionFilter === "warnings") return row.issues.some((issue) => issue.severity === "warning");
    return row.action === actionFilter;
  }), [preview, actionFilter, sheetFilter]);

  const changes = preview ? preview.summary.create + preview.summary.update : 0;
  const outcomes = run?.resultRows ?? [];
  const outcomeCount = (status: Outcome["status"]) => outcomes.filter((outcome) => outcome.status === status).length;
  const unsupported = preview?.sheets.filter((sheet) => sheet.status === "unsupported_with_data" || sheet.status === "unknown_with_data") ?? [];

  return (
    <div className="catalogDetailSection adminDetail catalogImportPanel excelImportPanel rounded-xl border bg-card p-5">
      <h3 className="text-lg font-semibold tracking-normal normal-case text-foreground">Importovat Excel</h3>
      <p className="fieldHint">
        <strong>Nyní podporuje listy Produkty a Sluzby.</strong> Šablona katalogu (catalog-template/1). Pomocné listy Navod, Vzory, Ciselniky a _meta se ignorují; jiné listy s daty se ohlásí jako nepodporované a import zablokují. Prázdná buňka = beze změny, 0 / NE / FALSE jsou skutečné hodnoty, mazání jen značkou #SMAZAT. Položky, které v souboru nejsou, se nemažou ani nearchivují. Nové karty vznikají jako „K doplnění“.
      </p>
      {availability?.limits && <p className="fieldHint">Limit: nejvýše {availability.limits.maxBytes / 1024 / 1024} MB a {availability.limits.maxDataRows} datových řádků; náhled platí {availability.limits.previewValidMinutes} minut.</p>}
      {availability && !availability.enabled && <p className="uploadError" role="alert">{availability.reason}</p>}

      <div className="assetActions">
        <label className={`smallUploadButton${!availability?.enabled || phase === "confirming" ? " disabled" : ""}`}>
          {file ? "Vybrat jiný soubor" : "Vybrat soubor .xlsx"}
          <input
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            disabled={!availability?.enabled || phase === "confirming"}
            onChange={(event) => {
              const next = event.target.files?.[0];
              event.target.value = "";
              if (!next) return;
              setFile(next);
              void runPreview(next);
            }}
          />
        </label>
        {file && <span className="fieldHint">{file.name}</span>}
        <Button variant="outline" type="button" onClick={onClose} disabled={phase === "confirming"}>Zavřít</Button>
      </div>

      {phase === "previewing" && <p className="workspaceEmpty" role="status">Kontroluji soubor a připravuji náhled (nic se nezapisuje)…</p>}
      {error && <p className="uploadError" role="alert">{error}</p>}

      {preview && phase !== "previewing" && (
        <>
          <dl className="excelImportSummary">
            <div><dt>Soubor</dt><dd>{preview.fileName} <span className="fieldHint">({Math.round(preview.fileSize / 1024)} kB · SHA-256 {preview.fileSha256.slice(0, 12)}…)</span></dd></div>
            <div><dt>Šablona / prostředí</dt><dd>{preview.templateFormat ?? "—"} · {preview.environment ?? "—"}</dd></div>
            <div><dt>Datové řádky</dt><dd>{preview.dataRows}</dd></div>
            <div><dt>Vytvořit</dt><dd>{preview.summary.create}</dd></div>
            <div><dt>Aktualizovat</dt><dd>{preview.summary.update}</dd></div>
            <div><dt>Beze změny</dt><dd>{preview.summary.unchanged}</dd></div>
            <div><dt>Konflikty</dt><dd className={preview.summary.conflict ? "dirty" : ""}>{preview.summary.conflict}</dd></div>
            <div><dt>Upozornění</dt><dd>{preview.summary.warnings}</dd></div>
          </dl>

          <table className="excelImportTable excelImportSheets">
            <thead><tr><th>List</th><th>Stav</th><th>Řádky</th><th>Vytvořit</th><th>Aktualizovat</th><th>Beze změny</th><th>Konflikty</th></tr></thead>
            <tbody>
              {preview.sheets.filter((sheet) => sheet.status !== "helper").map((sheet) => {
                const counts = preview.bySheet[sheet.name];
                return (
                  <tr key={sheet.name} className={sheet.status.endsWith("with_data") ? "excelImportSheetBlocked" : ""}>
                    <td>{sheet.name}</td><td>{SHEET_STATUS[sheet.status]}</td><td>{sheet.dataRows}</td>
                    <td>{counts?.create ?? "—"}</td><td>{counts?.update ?? "—"}</td><td>{counts?.unchanged ?? "—"}</td><td>{counts?.conflict ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {(preview.issues.length > 0 || unsupported.length > 0) && (
            <ul className="excelImportIssues">
              {preview.issues.map((issue, index) => <li key={index} className={issue.severity}>{issue.severity === "error" ? "Chyba" : "Upozornění"}: {issue.message}</li>)}
            </ul>
          )}

          {changes === 0 && preview.summary.conflict === 0 && preview.blockReasons.length === 0 ? (
            <p className="excelImportAllSame" role="status">Vše je beze změny — nic se nezapíše.</p>
          ) : (
            <>
              <div className="adminFilters excelImportFilters">
                <label>
                  <span>Zobrazit</span>
                  <NativeSelect value={actionFilter} onChange={(event) => setActionFilter(event.target.value as typeof actionFilter)}>
                    <option value="changes">Změny, konflikty a upozornění</option>
                    <option value="all">Všechny řádky</option>
                    <option value="create">Vytvořit</option>
                    <option value="update">Aktualizovat</option>
                    <option value="unchanged">Beze změny</option>
                    <option value="conflict">Konflikty</option>
                    <option value="warnings">S upozorněním</option>
                  </NativeSelect>
                </label>
                <label>
                  <span>List</span>
                  <NativeSelect value={sheetFilter} onChange={(event) => setSheetFilter(event.target.value)}>
                    <option value="all">Všechny listy</option>
                    {Object.keys(preview.bySheet).map((sheet) => <option key={sheet} value={sheet}>{sheet}</option>)}
                  </NativeSelect>
                </label>
                <span className="fieldHint">{rows.length} z {preview.rows.length} řádků</span>
              </div>
              <div className="excelImportRows">
                {rows.length === 0 && <p className="fieldHint">Filtru neodpovídá žádný řádek.</p>}
                {rows.map((row) => {
                  const name = row.changes.find((change) => change.field === "display_name")?.after;
                  return (
                    <div key={`${row.sheet}-${row.rowNumber}`} className={`excelImportRow ${row.action}`}>
                      <div className="excelImportRowHead">
                        <span className="excelImportBadge">{ACTION_LABELS[row.action]}</span>
                        <span>{row.sheet} · ř. {row.rowNumber}</span>
                        <strong>{row.label}</strong>
                        {typeof name === "string" && <span>{name}</span>}
                      </div>
                      {row.action === "update" && row.changes.length > 0 && (
                        <table className="excelImportChanges">
                          <tbody>{row.changes.map((change) => <tr key={change.field}><th>{change.labelCs}</th><td className="before">{showField(change.field, change.before, preview.categoryNames)}</td><td>→</td><td className="after">{showField(change.field, change.after, preview.categoryNames)}</td></tr>)}</tbody>
                        </table>
                      )}
                      {row.action === "create" && <p className="fieldHint">{row.changes.filter((change) => change.field !== "generator_code" && change.field !== "abf_code" && change.field !== "display_name").map((change) => `${change.labelCs}: ${showField(change.field, change.after, preview.categoryNames)}`).join(" · ")}</p>}
                      {row.issues.length > 0 && <ul>{row.issues.map((issue, index) => <li key={index} className={issue.severity}>{issue.message}</li>)}</ul>}
                    </div>
                  );
                })}
              </div>

              {preview.blockReasons.length > 0 ? (
                <div className="uploadError" role="alert">
                  Import nelze potvrdit: {preview.blockReasons.join(" ")}
                </div>
              ) : (
                phase !== "done" && (
                  <div className="excelImportConfirm">
                    <p className="fieldHint">
                      Zápis proběhne po kartách (každá karta zvlášť, ne celá dávka najednou). Pokud jedna selže, import se zastaví a už uložené karty zůstanou uložené; výsledek uvidíte po řádcích. Před zápisem server znovu porovná soubor i katalog s tímto náhledem — pokud se mezitím cokoli změnilo, nic nezapíše.
                    </p>
                    <label className="checkLabel">
                      <input type="checkbox" checked={acknowledged} disabled={phase === "confirming"} onChange={(event) => setAcknowledged(event.target.checked)} />
                      Rozumím; zapsat {preview.summary.create} nových a {preview.summary.update} aktualizovaných karet do DEV.
                    </label>
                    <Button variant="default" type="button" onClick={() => void confirm()} disabled={!preview.canConfirm || !acknowledged || phase === "confirming"}>
                      {phase === "confirming" ? "Zapisuji… (nezavírejte stránku)" : `Potvrdit import (${changes} změn)`}
                    </Button>
                  </div>
                )
              )}
            </>
          )}
        </>
      )}

      {run && (
        <section className="excelImportResult" aria-live="polite">
          <h4>Výsledek importu — {RUN_STATUS_LABELS[run.status] ?? run.status}</h4>
          <p className="fieldHint">Uloženo {outcomeCount("written")} · selhalo {outcomeCount("failed")} · neprovedeno {outcomeCount("not_attempted")} · zahájeno {formatDate(run.startedAt)} · dokončeno {formatDate(run.finishedAt)}</p>
          {run.errorMessage && <p className="uploadError">{run.errorMessage}</p>}
          {(run.status === "partial" || run.status === "failed" || run.status === "interrupted") && (
            <p className="fieldHint">Původní zápis se znovu nespouští. Pro pokračování nahrajte soubor znovu — nový náhled vyjde ze skutečně uloženého stavu (uložené karty budou „beze změny“).</p>
          )}
          <table className="excelImportTable">
            <thead><tr><th>List</th><th>Řádek</th><th>Kód</th><th>Akce</th><th>Výsledek</th><th>Poznámka</th></tr></thead>
            <tbody>{outcomes.map((outcome) => <tr key={`${outcome.sheet}-${outcome.rowNumber}`} className={`excelImportOutcome ${outcome.status}`}><td>{outcome.sheet}</td><td>{outcome.rowNumber}</td><td>{outcome.label}</td><td>{ACTION_LABELS[outcome.action]}</td><td>{OUTCOME_LABELS[outcome.status]}</td><td>{outcome.message ?? ""}</td></tr>)}</tbody>
          </table>
        </section>
      )}

      {recent.length > 0 && (
        <details className="excelImportRecent">
          <summary>Poslední importy ({recent.length})</summary>
          <table className="excelImportTable">
            <thead><tr><th>Čas</th><th>Soubor</th><th>Stav</th><th>Výsledek</th></tr></thead>
            <tbody>{recent.map((entry) => <tr key={entry.id}><td>{formatDate(entry.createdAt)}</td><td>{entry.fileName}</td><td>{RUN_STATUS_LABELS[entry.status] ?? entry.status}</td><td>{entry.resultRows ? `${entry.resultRows.filter((row) => row.status === "written").length} uloženo / ${entry.resultRows.length}` : "—"}</td></tr>)}</tbody>
          </table>
        </details>
      )}
    </div>
  );
}
