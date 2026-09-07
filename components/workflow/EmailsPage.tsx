"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  listEmailAiLanguagesByTier,
  listEmailAiTones,
  listEmailAiRewriteActions,
  findEmailAiLanguage,
  DEFAULT_EMAIL_AI_LANGUAGE_CODE,
  DEFAULT_EMAIL_AI_TONE_ID,
} from "../../domain/emailAiConfig";
import type { EmailTemplate, EmailTemplateEditInput, EmailTemplateRepository } from "../../domain/emailTemplate";
import { nextHistorySaveAction, type EmailHistoryEntry, type EmailHistoryRepository, type EmailHistorySaveInput } from "../../domain/emailHistory";
import { buildEmailEventContext } from "../../domain/emailEventContext";
import type { Exhibition } from "../../domain/organizations";
import { buildPrintSurfaceEmailAdditionalContext, buildPrintSurfaceEmailFreeText, PRINT_SURFACE_EMAIL_TEMPLATE_NAME, type PrintSurfaceEmailContext } from "../../domain/printSurfaceEmailContext";
import { getAssetDownloadUrl } from "../../lib/storage/assetClient";

type EmailResult = Readonly<{ subject: string; body: string }>;
type EmailsView = "compose" | "history" | "templates";

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error || fallback;
  } catch {
    return fallback;
  }
}

function languageLabel(code: string): string {
  return findEmailAiLanguage(code)?.label ?? code;
}

function formatHistoryTimestamp(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * "E-maily" — a project-independent AI assistant: rough free text in, a polished, editable
 * professional email out. Deliberately no required setup steps before generating — language,
 * tone, event and recipient are all optional/defaulted, matching the spec's "open, write, click
 * Vytvořit e-mail" workflow.
 */
export function EmailsPage({
  templateRepository,
  historyRepository,
  events,
  initialCompose,
  onReturnToPrintSurfaces,
}: {
  templateRepository: EmailTemplateRepository;
  historyRepository: EmailHistoryRepository;
  events: readonly Exhibition[];
  /** A handoff from another module (currently only print-surfaces) prefilling the compose view. `nonce` changes on every new handoff so the same context object can be reapplied even if unchanged; consumed exactly once per nonce (see the effects below), never reapplied on a plain revisit to this tab. */
  initialCompose?: Readonly<{ context: PrintSurfaceEmailContext; nonce: number }>;
  /** Switches back to the Tiskové plochy tab and reopens the project this handoff came from (spec section 22's "sourceProjectId" — PrintSurfaceEmailContext.projectId doubles as that reference). Implemented at the BoothGenerator level; absent when this page is used outside that wiring. */
  onReturnToPrintSurfaces?: (projectId: string) => void;
}) {
  const languageTiers = listEmailAiLanguagesByTier();
  const tones = listEmailAiTones();
  const rewriteActions = listEmailAiRewriteActions();

  const [view, setView] = useState<EmailsView>("compose");

  // ---- compose inputs ----
  const [freeText, setFreeText] = useState("");
  const [languageCode, setLanguageCode] = useState(DEFAULT_EMAIL_AI_LANGUAGE_CODE);
  const [toneId, setToneId] = useState(DEFAULT_EMAIL_AI_TONE_ID);
  const [eventId, setEventId] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [templateInstruction, setTemplateInstruction] = useState<string | undefined>(undefined);
  const [activeTemplateId, setActiveTemplateId] = useState<string | undefined>(undefined);
  // The print-surfaces handoff context, kept visible for the whole compose session (context
  // banner + attachment card below) — NOT cleared by generate()/rewrite(), only when the user
  // moves on to an unrelated email (reuseFromHistory) or a fresh handoff nonce arrives.
  const [printSurfaceContext, setPrintSurfaceContext] = useState<PrintSurfaceEmailContext | undefined>(undefined);
  const [pdfDownloadError, setPdfDownloadError] = useState("");

  const selectedEvent = useMemo(() => events.find((event) => event.id === eventId), [events, eventId]);

  // ---- result + generation/rewrite ----
  const [result, setResult] = useState<EmailResult | null>(null);
  const [sourceInputForResult, setSourceInputForResult] = useState<string | undefined>(undefined);
  const [isGenerating, setIsGenerating] = useState(false);
  const [rewritingActionId, setRewritingActionId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState("");

  // ---- history ----
  const [currentHistoryId, setCurrentHistoryId] = useState<string | undefined>(undefined);
  const [isSavingHistory, setIsSavingHistory] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<readonly EmailHistoryEntry[] | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | undefined>(undefined);

  // ---- templates ----
  const [templates, setTemplates] = useState<readonly EmailTemplate[] | null>(null);
  const [templatesError, setTemplatesError] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [showTemplateForm, setShowTemplateForm] = useState(false);
  const [editingTemplateId, setEditingTemplateId] = useState<string | undefined>(undefined);
  const [templateFormName, setTemplateFormName] = useState("");
  const [templateFormFreeText, setTemplateFormFreeText] = useState("");
  const [templateFormInstruction, setTemplateFormInstruction] = useState("");
  const [isSavingTemplate, setIsSavingTemplate] = useState(false);

  useEffect(() => {
    let cancelled = false;
    templateRepository
      .list()
      .then((loaded) => { if (!cancelled) setTemplates(loaded); })
      .catch((loadError) => { if (!cancelled) setTemplatesError(loadError instanceof Error ? loadError.message : "Vzory e-mailů se nepodařilo načíst."); });
    return () => { cancelled = true; };
  }, [templateRepository]);

  useEffect(() => {
    let cancelled = false;
    historyRepository
      .list()
      .then((loaded) => { if (!cancelled) setHistoryEntries(loaded); })
      .catch((loadError) => { if (!cancelled) setHistoryError(loadError instanceof Error ? loadError.message : "Historie e-mailů se nepodařilo načíst."); });
    return () => { cancelled = true; };
  }, [historyRepository]);

  const appliedComposeNonceRef = useRef<number | undefined>(undefined);

  // Section 9: applies eventId/freeText/language from the print-surfaces handoff — a fresh
  // working email, same as a manual "Vytvořit e-mail" start (never touches currentHistoryId=
  // something stale). Gated on `nonce` (not the context object identity) so the exact same
  // context can be reapplied for a second handoff of the same project.
  useEffect(() => {
    if (!initialCompose) return;
    const { context } = initialCompose;
    setEventId(context.eventId ?? "");
    setFreeText(buildPrintSurfaceEmailFreeText(context));
    if (findEmailAiLanguage(context.languageCode)) setLanguageCode(context.languageCode);
    setResult(null);
    setSourceInputForResult(undefined);
    setCurrentHistoryId(undefined);
    setPrintSurfaceContext(context);
    setPdfDownloadError("");
    setView("compose");
  }, [initialCompose?.nonce]);

  // Preselects the print-surfaces system template (see the migration) once both the handoff and
  // the template list are available — whichever resolves later. Runs at most once per nonce (the
  // ref guard), so it never re-fires just because `templates` reloads for an unrelated reason.
  useEffect(() => {
    if (!initialCompose || !templates) return;
    if (appliedComposeNonceRef.current === initialCompose.nonce) return;
    const template = templates.find((item) => item.scope === "system" && item.name === PRINT_SURFACE_EMAIL_TEMPLATE_NAME);
    if (!template) return;
    appliedComposeNonceRef.current = initialCompose.nonce;
    loadTemplate(template.id);
  }, [initialCompose, templates]);

  function showConfirmation(message: string) {
    setConfirmation(message);
    window.setTimeout(() => setConfirmation(""), 4000);
  }

  async function generate() {
    if (!freeText.trim() || isGenerating) return;
    setIsGenerating(true);
    setError("");
    try {
      const response = await fetch("/api/emails/ai-generate", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          freeText,
          languageCode,
          toneId,
          templateInstruction,
          eventContext: selectedEvent ? buildEmailEventContext(selectedEvent) : undefined,
          recipientName: recipientName.trim() || undefined,
          additionalContext: printSurfaceContext ? buildPrintSurfaceEmailAdditionalContext(printSurfaceContext) : undefined,
        }),
      });
      if (!response.ok) {
        setError(await readErrorMessage(response, "Vytvoření e-mailu se nezdařilo."));
        return;
      }
      const body = (await response.json()) as { subject: string; body: string };
      setResult({ subject: body.subject, body: body.body });
      setSourceInputForResult(freeText);
      setCurrentHistoryId(undefined); // a fresh generate always starts a new working email (section 12)
    } catch {
      setError("Vytvoření e-mailu se nezdařilo.");
    } finally {
      setIsGenerating(false);
    }
  }

  async function rewrite(actionId: string) {
    if (!result || rewritingActionId) return;
    setRewritingActionId(actionId);
    setError("");
    try {
      const response = await fetch("/api/emails/ai-rewrite", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: result.subject, body: result.body, actionId, languageCode }),
      });
      if (!response.ok) {
        setError(await readErrorMessage(response, "Úprava e-mailu se nezdařila."));
        return;
      }
      const body = (await response.json()) as { subject: string; body: string };
      setResult({ subject: body.subject, body: body.body });
      // rewrite never touches currentHistoryId (section 19) — it keeps updating the same in-progress record on the next save.
    } catch {
      setError("Úprava e-mailu se nezdařila.");
    } finally {
      setRewritingActionId(null);
    }
  }

  function loadTemplate(id: string) {
    setSelectedTemplateId(id);
    const template = (templates ?? []).find((item) => item.id === id);
    if (!template) {
      setTemplateInstruction(undefined);
      setActiveTemplateId(undefined);
      return;
    }
    if (template.freeText) setFreeText(template.freeText);
    if (template.languageCode) setLanguageCode(template.languageCode);
    if (template.toneId) setToneId(template.toneId);
    setTemplateInstruction(template.aiInstruction);
    setActiveTemplateId(template.id);
    setCurrentHistoryId(undefined); // loading a template starts a new working email
  }

  function openTemplateFormForCreate(seedFromCompose: boolean) {
    setEditingTemplateId(undefined);
    setTemplateFormName("");
    setTemplateFormFreeText(seedFromCompose ? freeText : "");
    setTemplateFormInstruction(seedFromCompose ? (templateInstruction ?? "") : "");
    setShowTemplateForm(true);
  }

  function openTemplateFormForEdit(template: EmailTemplate) {
    setEditingTemplateId(template.id);
    setTemplateFormName(template.name);
    setTemplateFormFreeText(template.freeText ?? "");
    setTemplateFormInstruction(template.aiInstruction ?? "");
    setShowTemplateForm(true);
  }

  async function submitTemplateForm() {
    if (!templateFormName.trim() || isSavingTemplate) return;
    setIsSavingTemplate(true);
    setTemplatesError("");
    const edit: EmailTemplateEditInput = {
      name: templateFormName.trim(),
      freeText: templateFormFreeText.trim() || undefined,
      aiInstruction: templateFormInstruction.trim() || undefined,
      languageCode,
      toneId,
    };
    try {
      const saved = editingTemplateId
        ? await templateRepository.update(editingTemplateId, edit)
        : await templateRepository.create(edit);
      setTemplates((current) => {
        const list = current ?? [];
        return list.some((item) => item.id === saved.id) ? list.map((item) => (item.id === saved.id ? saved : item)) : [saved, ...list];
      });
      setShowTemplateForm(false);
      setEditingTemplateId(undefined);
    } catch (saveError) {
      setTemplatesError(saveError instanceof Error ? saveError.message : "Uložení vzoru se nezdařilo.");
    } finally {
      setIsSavingTemplate(false);
    }
  }

  async function deleteTemplate(template: EmailTemplate) {
    if (template.scope === "system") return;
    if (!window.confirm(`Opravdu smazat vzor „${template.name}“?`)) return;
    try {
      await templateRepository.delete(template.id);
      setTemplates((current) => (current ?? []).filter((item) => item.id !== template.id));
    } catch (deleteError) {
      setTemplatesError(deleteError instanceof Error ? deleteError.message : "Smazání vzoru se nezdařilo.");
    }
  }

  function useTemplate(template: EmailTemplate) {
    loadTemplate(template.id);
    setView("compose");
  }

  async function saveOrUpdateHistory(): Promise<EmailHistoryEntry | undefined> {
    if (!result) return undefined;
    setIsSavingHistory(true);
    try {
      const input: EmailHistorySaveInput = {
        eventId: selectedEvent?.id,
        eventNameSnapshot: selectedEvent?.name,
        recipientName: recipientName.trim() || undefined,
        language: languageCode,
        tone: toneId,
        subject: result.subject,
        body: result.body,
        sourceInput: sourceInputForResult,
        templateId: activeTemplateId,
      };
      const decision = nextHistorySaveAction(currentHistoryId);
      const saved = decision.action === "create" ? await historyRepository.create(input) : await historyRepository.update(decision.id, input);
      setCurrentHistoryId(saved.id);
      setHistoryEntries((current) => {
        const list = current ?? [];
        return list.some((item) => item.id === saved.id) ? list.map((item) => (item.id === saved.id ? saved : item)) : [saved, ...list];
      });
      return saved;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Uložení do historie selhalo.");
      return undefined;
    } finally {
      setIsSavingHistory(false);
    }
  }

  async function copyToClipboard(full: boolean) {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(full ? `Předmět: ${result.subject}\n\n${result.body}` : result.body);
    } catch {
      setError("Kopírování do schránky se nezdařilo.");
      return;
    }
    const saved = await saveOrUpdateHistory();
    showConfirmation(saved ? "Zkopírováno a uloženo do historie" : "Zkopírováno");
  }

  /**
   * Target workflow (spec section 13): create a real Outlook draft (current PDF auto-attached)
   * and open it via its webLink — never marking anything as sent, that stays a separate explicit
   * action. Until a real EmailOutlookDraftProvider is connected (see
   * lib/mail/outlookDraftProvider.server.ts — always 503 today), this transparently falls back to
   * the existing mailto: behavior (spec section 14) — same button, no UI change needed once a
   * real provider exists.
   */
  async function openInOutlook() {
    if (!result) return;
    await saveOrUpdateHistory();
    try {
      const response = await fetch("/api/emails/outlook-draft", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: result.subject,
          body: result.body,
          recipient: recipientName.trim() || undefined,
          attachments: printSurfaceContext?.pdfAssetStorageKey && printSurfaceContext.pdfFileName
            ? [{ fileName: printSurfaceContext.pdfFileName, contentType: "application/pdf", storageKey: printSurfaceContext.pdfAssetStorageKey }]
            : undefined,
        }),
      });
      if (response.ok) {
        const draft = (await response.json()) as { draftId: string; webLink: string };
        window.open(draft.webLink, "_blank");
        return;
      }
    } catch {
      // falls through to mailto: below
    }
    window.location.href = `mailto:?subject=${encodeURIComponent(result.subject)}&body=${encodeURIComponent(result.body)}`;
  }

  async function manualSaveToHistory() {
    const saved = await saveOrUpdateHistory();
    if (saved) showConfirmation("Uloženo do historie");
  }

  function reuseFromHistory(entry: EmailHistoryEntry) {
    setResult({ subject: entry.subject, body: entry.body });
    setEventId(entry.eventId ?? "");
    setRecipientName(entry.recipientName ?? "");
    if (findEmailAiLanguage(entry.language)) setLanguageCode(entry.language);
    if (entry.tone) setToneId(entry.tone);
    setFreeText(entry.sourceInput ?? "");
    setSourceInputForResult(entry.sourceInput);
    setActiveTemplateId(entry.templateId);
    setCurrentHistoryId(undefined); // a reused email becomes a new working copy (section 16)
    setPrintSurfaceContext(undefined); // an unrelated email from history is no longer the print-surfaces handoff
    setView("compose");
  }

  async function downloadPreparedPdf() {
    if (!printSurfaceContext?.pdfAssetStorageKey) return;
    setPdfDownloadError("");
    try {
      const downloadUrl = await getAssetDownloadUrl(printSurfaceContext.pdfAssetStorageKey);
      window.open(downloadUrl, "_blank");
    } catch {
      setPdfDownloadError("Stažení PDF se nezdařilo.");
    }
  }

  function openHistoryEntryInOutlook(entry: EmailHistoryEntry) {
    window.location.href = `mailto:?subject=${encodeURIComponent(entry.subject)}&body=${encodeURIComponent(entry.body)}`;
  }

  async function copyHistoryEntry(entry: EmailHistoryEntry) {
    try {
      await navigator.clipboard.writeText(entry.body);
      showConfirmation("Zkopírováno");
    } catch {
      setHistoryError("Kopírování do schránky se nezdařilo.");
    }
  }

  async function deleteHistoryEntry(entry: EmailHistoryEntry) {
    if (!window.confirm("Opravdu smazat tento záznam historie?")) return;
    try {
      await historyRepository.delete(entry.id);
      setHistoryEntries((current) => (current ?? []).filter((item) => item.id !== entry.id));
      if (selectedHistoryId === entry.id) setSelectedHistoryId(undefined);
    } catch (deleteError) {
      setHistoryError(deleteError instanceof Error ? deleteError.message : "Smazání záznamu se nezdařilo.");
    }
  }

  const selectedHistoryEntry = (historyEntries ?? []).find((entry) => entry.id === selectedHistoryId);
  const systemTemplates = (templates ?? []).filter((template) => template.scope === "system");
  const userTemplates = (templates ?? []).filter((template) => template.scope === "user");

  return (
    <div className="workspacePage">
      <div className="workspacePageHeader">
        <div>
          <span className="eyebrow">AI POMOCNÍK</span>
          <h1>E-maily</h1>
        </div>
      </div>

      <div className="adminCategoryTabs">
        <button type="button" className={view === "compose" ? "active" : ""} onClick={() => setView("compose")}>Nový e-mail</button>
        <button type="button" className={view === "history" ? "active" : ""} onClick={() => setView("history")}>Historie</button>
        <button type="button" className={view === "templates" ? "active" : ""} onClick={() => setView("templates")}>Šablony</button>
      </div>

      {error && <p className="uploadError persistenceBanner">{error}</p>}
      {confirmation && <p className="emailsConfirmation">{confirmation}</p>}

      {view === "compose" && (
        <>
          {printSurfaceContext && (
            <div className="emailsPrintSurfaceContext">
              <div className="emailsPrintSurfaceContextHeader">
                <span>KONTEXT</span>
                <strong>
                  Tiskové plochy
                  {printSurfaceContext.companyName ? ` – ${printSurfaceContext.companyName}` : ""}
                  {printSurfaceContext.eventName ? ` – ${printSurfaceContext.eventName}` : ""}
                </strong>
                {onReturnToPrintSurfaces && (
                  <button type="button" className="textButton" onClick={() => onReturnToPrintSurfaces(printSurfaceContext.projectId)}>← Zpět na Tiskové plochy</button>
                )}
              </div>
              {printSurfaceContext.pdfFileName && (
                <div className="emailsAttachmentCard">
                  <span>PDF připraveno:</span>
                  <strong>{printSurfaceContext.pdfFileName}</strong>
                  <button type="button" onClick={() => void downloadPreparedPdf()} disabled={!printSurfaceContext.pdfAssetStorageKey}>Stáhnout PDF</button>
                </div>
              )}
              {pdfDownloadError && <p className="uploadError">{pdfDownloadError}</p>}
            </div>
          )}

          <div className="emailsTopRow">
            <label>
              <span>Event / veletrh</span>
              <select value={eventId} onChange={(event) => setEventId(event.target.value)}>
                <option value="">— Bez eventu —</option>
                {events.map((event) => (
                  <option key={event.id} value={event.id}>{event.name}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Jméno / oslovení</span>
              <input value={recipientName} onChange={(changeEvent) => setRecipientName(changeEvent.target.value)} placeholder="např. paní Nováková" />
            </label>
            <label>
              <span>Jazyk e-mailu</span>
              <select value={languageCode} onChange={(event) => setLanguageCode(event.target.value)}>
                {languageTiers.primary.map((language) => (
                  <option key={language.code} value={language.code}>{language.label}</option>
                ))}
                {languageTiers.more.length > 0 && (
                  <optgroup label="Další jazyky / More languages">
                    {languageTiers.more.map((language) => (
                      <option key={language.code} value={language.code}>{language.label}</option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>
            <label>
              <span>Styl</span>
              <select value={toneId} onChange={(event) => setToneId(event.target.value)}>
                {tones.map((tone) => (
                  <option key={tone.id} value={tone.id}>{tone.label}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="emailsWorkspace">
            <section className="workflowCard emailsPane">
              <div className="workflowCardHeader">
                <div>
                  <span>ZADÁNÍ</span>
                  <strong>Co chcete napsat?</strong>
                </div>
              </div>

              <div className="emailsTemplateBar">
                <select value={selectedTemplateId} onChange={(event) => loadTemplate(event.target.value)} disabled={!templates || templates.length === 0}>
                  <option value="">{templates && templates.length > 0 ? "Načíst vzor…" : "Žádné vzory"}</option>
                  {systemTemplates.length > 0 && (
                    <optgroup label="Systémové vzory">
                      {systemTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
                    </optgroup>
                  )}
                  {userTemplates.length > 0 && (
                    <optgroup label="Moje vzory">
                      {userTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
                    </optgroup>
                  )}
                </select>
                <button type="button" onClick={() => openTemplateFormForCreate(true)}>Uložit jako vzor</button>
              </div>
              {templatesError && <p className="uploadError">{templatesError}</p>}
              {templateInstruction && <p className="fieldHint">Instrukce vzoru pro AI: {templateInstruction}</p>}

              <textarea
                className="emailsFreeText"
                value={freeText}
                onChange={(event) => setFreeText(event.target.value)}
                placeholder="Napište volně, jak vás to napadne — nemusíte dodržovat pravopis ani formulaci…"
                rows={10}
              />

              <button type="button" className="primaryButton emailsCreateButton" onClick={generate} disabled={!freeText.trim() || isGenerating}>
                {isGenerating ? "Vytvářím…" : "Vytvořit e-mail"}
              </button>
            </section>

            <section className="workflowCard emailsPane">
              <div className="workflowCardHeader">
                <div>
                  <span>VÝSLEDEK</span>
                  <strong>E-mail</strong>
                </div>
              </div>

              {!result && <p className="workspaceEmpty">Zatím nic nevytvořeno — napište zadání vlevo a klikněte na „Vytvořit e-mail“.</p>}

              {result && (
                <>
                  <label><span>Předmět</span><input value={result.subject} onChange={(event) => setResult({ ...result, subject: event.target.value })} /></label>
                  <label><span>Text e-mailu</span><textarea className="emailsResultBody" value={result.body} onChange={(event) => setResult({ ...result, body: event.target.value })} rows={14} /></label>

                  <div className="emailsQuickActions">
                    {rewriteActions.map((action) => (
                      <button key={action.id} type="button" onClick={() => rewrite(action.id)} disabled={rewritingActionId !== null}>
                        {rewritingActionId === action.id ? "…" : action.label}
                      </button>
                    ))}
                  </div>

                  <div className="emailsResultActions">
                    <button type="button" className="primaryButton" onClick={() => copyToClipboard(false)} disabled={isSavingHistory}>Kopírovat</button>
                    <button type="button" onClick={() => copyToClipboard(true)} disabled={isSavingHistory}>Kopírovat vše</button>
                    <button type="button" className="primaryButton" onClick={openInOutlook} disabled={isSavingHistory}>Otevřít v Outlooku</button>
                    <button type="button" className="textButton" onClick={manualSaveToHistory} disabled={isSavingHistory}>Uložit do historie</button>
                  </div>
                  {printSurfaceContext?.pdfFileName && (
                    <p className="fieldHint">PDF je připravené. Po otevření Outlooku jej přiložte k e-mailu.</p>
                  )}
                </>
              )}
            </section>
          </div>
        </>
      )}

      {view === "history" && (
        <div className="emailsHistoryLayout">
          <div className="emailsHistoryList">
            {historyError && <p className="uploadError">{historyError}</p>}
            {!historyEntries && !historyError && <p className="workspaceEmpty">Načítám historii…</p>}
            {historyEntries && historyEntries.length === 0 && <p className="workspaceEmpty">Historie je zatím prázdná.</p>}
            {(historyEntries ?? []).map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={entry.id === selectedHistoryId ? "emailsHistoryRow active" : "emailsHistoryRow"}
                onClick={() => setSelectedHistoryId(entry.id)}
              >
                <span className="emailsHistoryRowTime">{formatHistoryTimestamp(entry.createdAt)}</span>
                <strong>{entry.subject || "(bez předmětu)"}</strong>
                <span className="emailsHistoryRowMeta">
                  {entry.eventNameSnapshot ?? "Bez eventu"}
                  {entry.recipientName ? ` · ${entry.recipientName}` : ""}
                  {` · ${languageLabel(entry.language)}`}
                </span>
              </button>
            ))}
          </div>

          <div className="workflowCard emailsHistoryDetail">
            {!selectedHistoryEntry && <p className="workspaceEmpty">Vyberte záznam vlevo.</p>}
            {selectedHistoryEntry && (
              <>
                <label><span>Předmět</span><input value={selectedHistoryEntry.subject} readOnly /></label>
                <label><span>Text e-mailu</span><textarea className="emailsResultBody" value={selectedHistoryEntry.body} readOnly rows={12} /></label>
                {selectedHistoryEntry.sourceInput && <label><span>Původní zadání</span><textarea value={selectedHistoryEntry.sourceInput} readOnly rows={4} /></label>}
                <p className="fieldHint">
                  {selectedHistoryEntry.eventNameSnapshot ? `Event: ${selectedHistoryEntry.eventNameSnapshot}` : "Bez eventu"}
                  {selectedHistoryEntry.recipientName ? ` · Oslovení: ${selectedHistoryEntry.recipientName}` : ""}
                  {` · Jazyk: ${languageLabel(selectedHistoryEntry.language)}`}
                  {selectedHistoryEntry.tone ? ` · Styl: ${selectedHistoryEntry.tone}` : ""}
                </p>
                <div className="emailsResultActions">
                  <button type="button" className="primaryButton" onClick={() => openHistoryEntryInOutlook(selectedHistoryEntry)}>Otevřít v Outlooku</button>
                  <button type="button" onClick={() => copyHistoryEntry(selectedHistoryEntry)}>Kopírovat</button>
                  <button type="button" onClick={() => reuseFromHistory(selectedHistoryEntry)}>Znovu použít</button>
                  <button type="button" className="textButton" onClick={() => deleteHistoryEntry(selectedHistoryEntry)}>Smazat</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {view === "templates" && (
        <div className="emailsTemplatesView">
          {templatesError && <p className="uploadError">{templatesError}</p>}

          <div className="workflowCardHeader">
            <div><span>SYSTÉMOVÉ VZORY</span><strong>Dostupné všem</strong></div>
          </div>
          <ul className="emailsTemplateList">
            {systemTemplates.map((template) => (
              <li key={template.id}>
                <div><strong>{template.name}</strong>{template.aiInstruction && <p className="fieldHint">{template.aiInstruction}</p>}</div>
                <button type="button" onClick={() => useTemplate(template)}>Použít</button>
              </li>
            ))}
            {systemTemplates.length === 0 && <li className="workspaceEmpty">Žádné systémové vzory.</li>}
          </ul>

          <div className="workflowCardHeader">
            <div><span>MOJE VZORY</span><strong>Vlastní vzory</strong></div>
            <button type="button" className="primaryButton" onClick={() => openTemplateFormForCreate(false)}>+ Nový vzor</button>
          </div>
          <ul className="emailsTemplateList">
            {userTemplates.map((template) => (
              <li key={template.id}>
                <div><strong>{template.name}</strong>{template.aiInstruction && <p className="fieldHint">{template.aiInstruction}</p>}</div>
                <div className="emailsTemplateListActions">
                  <button type="button" onClick={() => useTemplate(template)}>Použít</button>
                  <button type="button" onClick={() => openTemplateFormForEdit(template)}>Upravit</button>
                  <button type="button" className="textButton" onClick={() => deleteTemplate(template)}>Smazat</button>
                </div>
              </li>
            ))}
            {userTemplates.length === 0 && <li className="workspaceEmpty">Zatím žádné vlastní vzory.</li>}
          </ul>

          {showTemplateForm && (
            <div className="emailsSaveTemplateForm">
              <label><span>Název vzoru</span><input value={templateFormName} onChange={(event) => setTemplateFormName(event.target.value)} placeholder="např. Zaslání kalkulace" /></label>
              <label><span>Ukázkový text (volitelné)</span><textarea value={templateFormFreeText} onChange={(event) => setTemplateFormFreeText(event.target.value)} /></label>
              <label><span>Instrukce pro AI (volitelné)</span><textarea value={templateFormInstruction} onChange={(event) => setTemplateFormInstruction(event.target.value)} placeholder="např. vždy uveď, že se jedná o předběžnou nabídku" /></label>
              <div className="emailsSaveTemplateActions">
                <button type="button" className="primaryButton" onClick={submitTemplateForm} disabled={!templateFormName.trim() || isSavingTemplate}>{isSavingTemplate ? "Ukládám…" : editingTemplateId ? "Uložit změny" : "Uložit"}</button>
                <button type="button" onClick={() => setShowTemplateForm(false)}>Zrušit</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
