"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog, Field, Notice } from "@/components/ui/workspace";
import { SUPPORT_LIMITS, TICKET_KIND_LABELS_CS, TICKET_KINDS, supportAreaLabel, ticketDraftProblem, type TicketKind } from "../../domain/support";
import { currentClientContext, localFile, localFileProblem, supportApi, uploadSupportFile, type LocalFile } from "../../lib/support/supportClient";
import { AttachmentPicker, pastedImages } from "./AttachmentPicker";

type Draft = { kind: TicketKind; subject: string; description: string; steps: string; expected: string; actual: string; linkProject: boolean };
const EMPTY: Draft = { kind: "bug", subject: "", description: "", steps: "", expected: "", actual: "", linkProject: false };

/**
 * "Nahlásit chybu" (V1-SUPPORT-01). A dialog over the current screen — nothing in the app is closed
 * or reloaded, so an unsaved project or form stays as it was. The draft survives closing the dialog
 * and a failed send; one submission id makes a double click or a retry create only one report.
 */
export function ReportDialog({ open, onOpenChange, appKey, area, author, project, onCreated }: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appKey: string;
  area: string;
  author: string;
  /** The saved project currently open (optional link). */
  project?: Readonly<{ id: string; name: string }>;
  onCreated: (ticket: Readonly<{ id: string; number: number }>) => void;
}>) {
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
  const [context, setContext] = useState(() => currentClientContext(area));
  useEffect(() => { if (open) setContext(currentClientContext(area)); }, [open, area]);

  const dirty = Boolean(draft.subject.trim() || draft.description.trim() || draft.steps.trim() || files.length);
  const problem = ticketDraftProblem(draft);

  function reset() {
    for (const entry of files) URL.revokeObjectURL(entry.previewUrl);
    setDraft(EMPTY);
    setFiles([]);
    setError("");
    setDone(null);
    requestId.current = crypto.randomUUID();
    uploaded.current = new Map();
  }

  function requestClose() {
    if (done) {
      reset();
      onOpenChange(false);
    } else onOpenChange(false); // the draft stays for later; "Zahodit" discards it explicitly
  }

  async function submit() {
    if (submitting.current || problem) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const attachmentIds: string[] = [];
      for (const entry of files) {
        const known = uploaded.current.get(entry.key);
        const id = known ?? (await uploadSupportFile(appKey, "ticket", entry.file));
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
      onCreated(response.ticket);
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : "Hlášení se nepodařilo odeslat."} Rozepsaný text zůstal zachovaný.`);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  function onPaste(event: React.ClipboardEvent) {
    const images = pastedImages(event);
    if (!images.length) return;
    event.preventDefault();
    const ok = images.filter((file) => !localFileProblem(file)).slice(0, Math.max(0, SUPPORT_LIMITS.ticketAttachments - files.length));
    setFiles([...files, ...ok.map((file) => localFile(file))]);
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => { if (!next) requestClose(); }}>
        <DialogContent className="max-h-[94vh] w-[calc(100vw-1rem)] overflow-y-auto sm:max-w-2xl" onPaste={onPaste}>
          <DialogHeader>
            <DialogTitle>{done ? `Hlášení #${done.number} odesláno` : "Nahlásit chybu nebo návrh"}</DialogTitle>
            <DialogDescription>{done ? "Stav a odpovědi najdete v Nápovědě a podpoře → Moje hlášení." : "Rozpracovaná práce v aplikaci zůstává otevřená — formulář ji nijak nemění."}</DialogDescription>
          </DialogHeader>
          {done ? (
            <Notice tone="success" title={`Číslo hlášení: #${done.number}`}>Děkujeme. Správce aplikace hlášení uvidí v Správě podpory.</Notice>
          ) : (
            <div className="grid gap-4">
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
                <AttachmentPicker idPrefix="report" files={files} onChange={setFiles} max={SUPPORT_LIMITS.ticketAttachments} disabled={busy} />
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
                <summary className="cursor-pointer font-medium">Automaticky připojený kontext</summary>
                <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">Aplikace</dt><dd>ABF Generator (verzi doplní server)</dd>
                  <dt className="text-muted-foreground">Oblast</dt><dd>{supportAreaLabel(context.area)}</dd>
                  <dt className="text-muted-foreground">Cesta</dt><dd className="break-all">{context.path}</dd>
                  <dt className="text-muted-foreground">Prohlížeč</dt><dd>{context.browser}</dd>
                  <dt className="text-muted-foreground">Okno</dt><dd>{context.viewport}</dd>
                  <dt className="text-muted-foreground">Autor</dt><dd>{author}</dd>
                  <dt className="text-muted-foreground">Čas</dt><dd>při odeslání</dd>
                </dl>
                <p className="mt-2 text-xs text-muted-foreground">Nepřipojuje se obsah formulářů, projektů, konzole ani síťové požadavky.</p>
              </details>
              {error && <Notice tone="error">{error}</Notice>}
            </div>
          )}
          <DialogFooter>
            {done ? (
              <Button type="button" onClick={() => { reset(); onOpenChange(false); }}>Hotovo</Button>
            ) : (
              <>
                {dirty && <Button type="button" variant="ghost" className="sm:mr-auto" onClick={() => setConfirmDiscard(true)} disabled={busy}>Zahodit</Button>}
                <Button type="button" variant="outline" onClick={requestClose} disabled={busy}>Zavřít</Button>
                <Button type="button" onClick={() => void submit()} disabled={busy || Boolean(problem)} title={problem}>{busy ? "Odesílám…" : "Odeslat hlášení"}</Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmDiscard}
        title="Zahodit rozepsané hlášení?"
        description="Text i přílohy se smažou z tohoto prohlížeče."
        choices={[{ label: "Zahodit", value: "discard", destructive: true }]}
        onChoose={() => { setConfirmDiscard(false); reset(); onOpenChange(false); }}
        onCancel={() => setConfirmDiscard(false)}
      />
    </>
  );
}
