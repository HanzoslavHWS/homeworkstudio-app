"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { ActionBar, ConfirmDialog, Field, Notice, PageHeader } from "@/components/ui/workspace";
import { SUPPORT_LIMITS, TICKET_KIND_LABELS_CS, TICKET_KINDS, supportAreaLabel, ticketDraftProblem, type ClientContext, type TicketKind } from "../../domain/support";
import { announceReportCreated, clearReportHandoff, handleFromHash, readReportHandoff, reportFormStorage, type ReportHandoff } from "../../lib/support/reportHandoff";
import { localFile, localFileProblem, supportApi, uploadSupportFile, type LocalFile } from "../../lib/support/supportClient";
import { AttachmentPicker } from "./AttachmentPicker";

type Draft = { kind: TicketKind; subject: string; description: string; steps: string; expected: string; actual: string; linkProject: boolean };
const EMPTY: Draft = { kind: "bug", subject: "", description: "", steps: "", expected: "", actual: "", linkProject: false };
const DRAFT_KEY = (handle: string | null) => `hws-support-draft:${handle ?? "bez-kontextu"}`;

/** Without the original page's context the report says so — it never names this form's own address. */
const unknownContext = (): ClientContext => ({ area: "abf.general", path: "", browser: "", viewport: "" });

/**
 * "Nahlásit chybu" in its own tab (V1-SUPPORT-03). The original tab is never touched: its context
 * (area, safe path, browser, window) comes through reportHandoff.ts. From here the user can take a
 * screenshot of that original tab (the browser's picker offers the other tabs; this one is excluded),
 * paste an image (Ctrl+V), attach a file and edit / redact screenshots. The text of the draft survives a
 * reload of this tab; one submission id makes a double click or a retry create only one report.
 */
export function ReportPage({ appKey, appName, appUrl, author }: Readonly<{ appKey: string; appName: string; appUrl: string; author: string }>) {
  const [handle, setHandle] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<ReportHandoff | undefined>();
  const [ready, setReady] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [files, setFiles] = useState<readonly LocalFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ id: string; number: number } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const requestId = useRef<string>(crypto.randomUUID());
  // files already uploaded in an earlier (failed) attempt are not uploaded twice
  const uploaded = useRef(new Map<string, string>());
  // a second click in the same tick sees the old "busy" state — this ref stops it before it uploads anything
  const submitting = useRef(false);
  const filesRef = useRef(files);
  filesRef.current = files;

  useEffect(() => {
    const found = handleFromHash(window.location.hash);
    setHandle(found);
    setHandoff(readReportHandoff(reportFormStorage(), found, appKey, Date.now()));
    try {
      const saved = window.sessionStorage.getItem(DRAFT_KEY(found));
      if (saved) setDraft({ ...EMPTY, ...(JSON.parse(saved) as Partial<Draft>) });
    } catch {
      // no stored draft
    }
    setReady(true);
  }, [appKey]);

  // the text (never files) survives a reload of this tab
  useEffect(() => {
    if (!ready || done) return;
    try {
      window.sessionStorage.setItem(DRAFT_KEY(handle), JSON.stringify(draft));
    } catch {
      // storage unavailable
    }
  }, [draft, handle, ready, done]);

  // Ctrl+V anywhere on the page adds pasted images (text paste into a field stays normal)
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const images = [...(event.clipboardData?.items ?? [])].flatMap((item) => (item.kind === "file" && item.type.startsWith("image/") ? [item.getAsFile()!].filter(Boolean) : []));
      if (!images.length || done) return;
      event.preventDefault();
      const room = Math.max(0, SUPPORT_LIMITS.ticketAttachments - filesRef.current.length);
      setFiles([...filesRef.current, ...images.filter((file) => !localFileProblem(file)).slice(0, room).map((file) => localFile(file))]);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [done]);

  const context = handoff?.context ?? unknownContext();
  const project = handoff?.project;
  const problem = ticketDraftProblem(draft);
  const dirty = Boolean(draft.subject.trim() || draft.description.trim() || draft.steps.trim() || files.length);

  function reset() {
    for (const entry of files) URL.revokeObjectURL(entry.previewUrl);
    setDraft(EMPTY);
    setFiles([]);
    setError("");
    requestId.current = crypto.randomUUID();
    uploaded.current = new Map();
    try {
      window.sessionStorage.removeItem(DRAFT_KEY(handle));
    } catch {
      // ignore
    }
  }

  async function submit() {
    if (submitting.current || problem) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const attachmentIds: string[] = [];
      for (const entry of files) {
        const id = uploaded.current.get(entry.key) ?? (await uploadSupportFile(appKey, "ticket", entry.file));
        uploaded.current.set(entry.key, id);
        attachmentIds.push(id);
      }
      const response = await supportApi<{ ticket: { id: string; number: number } }>("tickets/create", {
        body: {
          app: appKey, clientRequestId: requestId.current, kind: draft.kind, subject: draft.subject, description: draft.description,
          ...(draft.kind === "bug" ? { steps: draft.steps, expected: draft.expected, actual: draft.actual } : {}),
          ...(draft.linkProject && project ? { projectId: project.id } : {}),
          context, attachmentIds,
        },
      });
      setDone(response.ticket);
      reset();
      clearReportHandoff(reportFormStorage(), handle);
      announceReportCreated();
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : "Hlášení se nepodařilo odeslat."} Rozepsaný text zůstal zachovaný.`);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  if (done) {
    return (
      <main data-ui="report" className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-8">
        <div className="mx-auto grid w-full max-w-2xl gap-4">
          <PageHeader eyebrow={appName} title={`Hlášení #${done.number} odesláno`} description="Děkujeme. Stav a odpovědi najdete v Nápovědě a podpoře → Moje hlášení." />
          <Notice tone="success" title={`Číslo hlášení: #${done.number}`}>Původní karta aplikace zůstala otevřená beze změny — tuto kartu můžete zavřít.</Notice>
          <ActionBar>
            <Button type="button" onClick={() => window.close()}>Zavřít kartu</Button>
            <Button type="button" variant="outline" onClick={() => { window.location.href = `${appUrl}#/podpora/hlaseni/${done.id}`; }}>Zobrazit hlášení</Button>
            <Button type="button" variant="ghost" onClick={() => { setDone(null); }}>Nahlásit další</Button>
          </ActionBar>
        </div>
      </main>
    );
  }

  return (
    <main data-ui="report" className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-8">
      <div className="mx-auto grid w-full max-w-2xl gap-4">
        <PageHeader eyebrow={appName} title="Nahlásit chybu nebo návrh" description="Formulář je v samostatné kartě — původní stránka i rozpracovaná práce zůstávají otevřené beze změny." />
        {ready && !handoff && <Notice tone="warning" title="Kontext původní stránky není k dispozici">Formulář nebyl otevřen tlačítkem Nahlásit chybu (nebo od otevření uplynuly víc než 2 hodiny). Popište prosím, kde se problém objevil.</Notice>}
        <div className="grid gap-4 rounded-xl border bg-card p-4 sm:p-5">
          <div className="grid gap-3 sm:grid-cols-[200px_minmax(0,1fr)]">
            <Field id="report-kind" label="Druh">
              <NativeSelect id="report-kind" value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as TicketKind })}>
                {TICKET_KINDS.map((kind) => <option key={kind} value={kind}>{TICKET_KIND_LABELS_CS[kind]}</option>)}
              </NativeSelect>
            </Field>
            <Field id="report-subject" label="Předmět *">
              <Input id="report-subject" value={draft.subject} maxLength={160} onChange={(event) => setDraft({ ...draft, subject: event.target.value })} />
            </Field>
          </div>
          <Field id="report-description" label="Popis *">
            <Textarea id="report-description" rows={4} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
          </Field>
          {draft.kind === "bug" && (
            <div className="grid gap-3">
              <Field id="report-steps" label="Kroky k zopakování (nepovinné)">
                <Textarea id="report-steps" rows={3} value={draft.steps} onChange={(event) => setDraft({ ...draft, steps: event.target.value })} placeholder={"1. Otevřu…\n2. Kliknu na…"} />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field id="report-expected" label="Očekávaný výsledek">
                  <Textarea id="report-expected" rows={2} value={draft.expected} onChange={(event) => setDraft({ ...draft, expected: event.target.value })} />
                </Field>
                <Field id="report-actual" label="Skutečný výsledek">
                  <Textarea id="report-actual" rows={2} value={draft.actual} onChange={(event) => setDraft({ ...draft, actual: event.target.value })} />
                </Field>
              </div>
            </div>
          )}
          <div className="grid gap-1.5">
            <span className="text-[13px] font-semibold text-muted-foreground">Přílohy a snímky obrazovky</span>
            <AttachmentPicker idPrefix="report" files={files} onChange={setFiles} max={SUPPORT_LIMITS.ticketAttachments} disabled={busy} captureLabel="Snímek původní karty" captureHint="V nabídce prohlížeče vyberte kartu s aplikací, ve které jste problém viděli. Tato karta s formulářem se v nabídce nezobrazuje." />
          </div>
          {project && (
            <div className="flex items-start gap-2">
              <Checkbox id="report-project" checked={draft.linkProject} onCheckedChange={(checked) => setDraft({ ...draft, linkProject: checked === true })} />
              <Label htmlFor="report-project" className="grid gap-0.5 font-normal">
                <span>Připojit zakázku „{project.name}“</span>
                <span className="text-xs text-muted-foreground">Uloží se jen odkaz. Obsah zakázky uvidí jen ti, kdo k ní už mají přístup.</span>
              </Label>
            </div>
          )}
          <details className="rounded-lg border bg-muted/40 p-3 text-sm">
            <summary className="cursor-pointer font-medium">Automaticky připojený kontext (původní stránka)</summary>
            <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Aplikace</dt><dd>{appName} (verzi doplní server)</dd>
              <dt className="text-muted-foreground">Oblast</dt><dd>{handoff ? supportAreaLabel(context.area) : "neznámá"}</dd>
              <dt className="text-muted-foreground">Cesta</dt><dd className="break-all">{context.path || "neznámá"}</dd>
              <dt className="text-muted-foreground">Prohlížeč</dt><dd>{context.browser || "—"}</dd>
              <dt className="text-muted-foreground">Okno</dt><dd>{context.viewport || "—"}</dd>
              <dt className="text-muted-foreground">Autor</dt><dd>{author}</dd>
              <dt className="text-muted-foreground">Čas</dt><dd>při odeslání</dd>
            </dl>
            <p className="mt-2 text-xs text-muted-foreground">Nepřipojuje se obsah formulářů, projektů, konzole ani síťové požadavky.</p>
          </details>
          {error && <Notice tone="error">{error}</Notice>}
          <ActionBar className="justify-end">
            {dirty && <Button type="button" variant="ghost" className="sm:mr-auto" onClick={() => setConfirmDiscard(true)} disabled={busy}>Zahodit</Button>}
            <Button type="button" onClick={() => void submit()} disabled={busy || Boolean(problem)} title={problem}>{busy ? "Odesílám…" : "Odeslat hlášení"}</Button>
          </ActionBar>
        </div>
      </div>
      <ConfirmDialog
        open={confirmDiscard}
        title="Zahodit rozepsané hlášení?"
        description="Text i přílohy se smažou z této karty."
        choices={[{ label: "Zahodit", value: "discard", destructive: true }]}
        onChoose={() => { setConfirmDiscard(false); reset(); }}
        onCancel={() => setConfirmDiscard(false)}
      />
    </main>
  );
}
