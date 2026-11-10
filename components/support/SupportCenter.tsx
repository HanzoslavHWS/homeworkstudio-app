"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ActionBar, EmptyState, Field, LoadingState, Notice, PageHeader, SectionCard, StatusBadge } from "@/components/ui/workspace";
import {
  ARTICLE_KIND_LABELS_CS,
  ARTICLE_KINDS,
  ARTICLE_STATUS_LABELS_CS,
  ARTICLE_STATUSES,
  SUPPORT_AREAS,
  SUPPORT_LIMITS,
  TICKET_KIND_LABELS_CS,
  TICKET_KINDS,
  TICKET_STATUS_LABELS_CS,
  TICKET_STATUSES,
  NOTIFICATION_KIND_LABELS_CS,
  NOTIFICATION_STATUS_LABELS_CS,
  articleMatches,
  canChangeStatus,
  formatBytes,
  supportAreaLabel,
  videoEmbedOf,
  type ArticleKind,
  type ArticleStatus,
  type SupportRole,
  type TicketKind,
  type TicketStatus,
  type NotificationKind,
} from "../../domain/support";
import { attachmentUrl, localFile, localFileProblem, supportApi, uploadSupportFile, type LocalFile } from "../../lib/support/supportClient";
import { ArticleContent } from "./ArticleContent";
import { AttachmentPicker, pastedImages } from "./AttachmentPicker";

// ---------------------------------------------------------------------------------------------
// Types of the API answers
// ---------------------------------------------------------------------------------------------
export type ArticleView = { id: string; kind: ArticleKind; category: string; title: string; summary: string; body: string; areaKeys: string[]; forExternal: boolean; status: ArticleStatus; sortOrder: number; updatedAt: string; version?: number; updatedBy?: string | null };
type CommentView = { id: string; kind: "comment" | "suggestion"; body: string; status: "open" | "resolved"; hidden?: boolean; createdAt: string; author?: string; mine: boolean };
type AttachmentView = { id: string; fileName: string; mimeType: string; sizeBytes: number; kind: "image" | "video"; messageId: string | null };
type TicketSummary = { id: string; number: number; kind: TicketKind; subject: string; status: TicketStatus; createdAt: string; updatedAt: string; author: string; authorId?: string; assignee?: string | null; assigneeId?: string | null };
type TicketDetail = TicketSummary & { description: string; steps: string | null; expected: string | null; actual: string | null; context: Record<string, string>; mine: boolean; project: { id: string; name: string } | null; hasProject: boolean };
type MessageView = { id: string; visibility: "public" | "internal"; body: string; createdAt: string; author: string; mine: boolean };
type NotificationView = { id: string; kind: NotificationKind; recipient: string; status: string; attempts: number; sentAt: string | null; nextAttemptAt: string | null; error: string | null; createdAt: string };
export type NotificationsState = Readonly<{ active: boolean; reason?: string }>;
type EventView = { id: string; type: "created" | "status" | "reopened" | "assignee"; from: string | null; to: string | null; createdAt: string; actor: string };

const formatDate = (value: string | null | undefined) => (value ? new Date(value).toLocaleString("cs-CZ", { dateStyle: "short", timeStyle: "short" }) : "—");
const STATUS_TONE: Readonly<Record<TicketStatus, "info" | "warning" | "success" | "muted" | "neutral">> = { new: "info", in_progress: "neutral", waiting: "warning", resolved: "success", closed: "muted" };
const STATUS_SYMBOL: Readonly<Record<TicketStatus, string>> = { new: "●", in_progress: "◐", waiting: "!", resolved: "✓", closed: "○" };
const ARTICLE_TONE: Readonly<Record<ArticleStatus, "success" | "neutral" | "muted">> = { published: "success", draft: "neutral", archived: "muted" };

export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  return <StatusBadge tone={STATUS_TONE[status]} symbol={STATUS_SYMBOL[status]}>{TICKET_STATUS_LABELS_CS[status]}</StatusBadge>;
}

// ---------------------------------------------------------------------------------------------
// Routes inside the support area: navody[/id] · hlaseni[/id] · sprava[/clanky/id|novy] · sprava/hlaseni[/id]
// ---------------------------------------------------------------------------------------------
export type SupportRoute = string;
const segments = (route: SupportRoute) => route.split("/").filter(Boolean);

function SupportTabs({ route, role, counts, onNavigate }: { route: SupportRoute; role: SupportRole; counts: { newTickets: number; waitingForMe: number }; onNavigate: (route: SupportRoute) => void }) {
  const first = segments(route)[0] ?? "navody";
  const tabs = [
    { id: "navody", label: "Návody a FAQ", badge: 0 },
    { id: "hlaseni", label: "Moje hlášení", badge: counts.waitingForMe },
    ...(role === "manager" ? [{ id: "sprava", label: "Správa podpory", badge: counts.newTickets }] : []),
  ];
  return (
    <nav className="mb-5 flex gap-1 overflow-x-auto border-b" aria-label="Nápověda a podpora — části">
      {tabs.map((tab) => (
        <a
          key={tab.id}
          href={`#/podpora/${tab.id}`}
          aria-current={first === tab.id ? "page" : undefined}
          onClick={(event) => { if (event.metaKey || event.ctrlKey || event.shiftKey) return; event.preventDefault(); onNavigate(tab.id); }}
          className={cn("-mb-px inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-[15px] font-semibold whitespace-nowrap no-underline", first === tab.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
        >
          {tab.label}
          {tab.badge > 0 && <span className="rounded-full bg-info px-2 py-0.5 text-xs font-bold text-white" aria-label={tab.id === "sprava" ? `${tab.badge} nových hlášení` : `${tab.badge} hlášení čeká na vaše doplnění`}>{tab.badge}</span>}
        </a>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------------------------
// Návody a FAQ
// ---------------------------------------------------------------------------------------------
function useArticles(appKey: string, reloadKey: number) {
  const [articles, setArticles] = useState<ArticleView[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    supportApi<{ articles: ArticleView[] }>("articles", { query: { app: appKey } }).then(
      (body) => { if (!cancelled) { setArticles(body.articles); setError(""); } },
      (cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Návody se nepodařilo načíst."); },
    );
    return () => { cancelled = true; };
  }, [appKey, reloadKey]);
  return { articles, error };
}

function GuidesList({ appKey, role, onOpen, onReport }: { appKey: string; role: SupportRole; onOpen: (id: string) => void; onReport: () => void }) {
  const { articles, error } = useArticles(appKey, 0);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [kind, setKind] = useState("");
  const published = useMemo(() => (articles ?? []).filter((article) => article.status === "published"), [articles]);
  const categories = useMemo(() => [...new Set(published.map((article) => article.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "cs")), [published]);
  const shown = published.filter((article) => (!kind || article.kind === kind) && articleMatches(article, query, category));
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!articles) return <LoadingState label="Načítám návody…" />;
  return (
    <div className="grid gap-4">
      <div className="@container grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]" role="search">
        <Field id="guides-query" label="Hledat"><Input id="guides-query" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Název nebo text návodu" /></Field>
        <Field id="guides-category" label="Kategorie">
          <NativeSelect id="guides-category" value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="">Všechny kategorie</option>
            {categories.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
          </NativeSelect>
        </Field>
        <Field id="guides-kind" label="Druh">
          <NativeSelect id="guides-kind" value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="">Návody i FAQ</option>
            {ARTICLE_KINDS.map((entry) => <option key={entry} value={entry}>{ARTICLE_KIND_LABELS_CS[entry]}</option>)}
          </NativeSelect>
        </Field>
      </div>
      {shown.length === 0 ? (
        <EmptyState
          title={published.length ? "Hledání nic nenašlo" : "Zatím tu nejsou žádné návody"}
          description={published.length ? "Zkuste jiné slovo nebo kategorii." : role === "manager" ? "Návody a FAQ přidáte ve Správě podpory." : "Pokud si nevíte rady, napište nám — odpovíme v Moje hlášení."}
          action={<Button type="button" variant="outline" onClick={onReport}>Nahlásit problém nebo dotaz</Button>}
        />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {shown.map((article) => (
            <li key={article.id}>
              <button type="button" onClick={() => onOpen(article.id)} className="grid h-full w-full gap-1 rounded-xl border bg-card p-4 text-left transition-colors hover:border-foreground/40 focus-visible:ring-3 focus-visible:ring-ring/50">
                <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <StatusBadge tone="neutral">{ARTICLE_KIND_LABELS_CS[article.kind]}</StatusBadge>
                  {article.category && <span>{article.category}</span>}
                  {role !== "external" && article.forExternal && <span>· i pro externí</span>}
                </span>
                <strong className="text-base">{article.title}</strong>
                {article.summary && <span className="text-sm text-muted-foreground">{article.summary}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ArticleReader({ appKey, articleId, role, onBack }: { appKey: string; articleId: string; role: SupportRole; onBack: () => void }) {
  const [data, setData] = useState<{ article: ArticleView; comments: CommentView[] } | null>(null);
  const [error, setError] = useState("");
  const [comment, setComment] = useState({ kind: "comment" as "comment" | "suggestion", body: "" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const load = useCallback(() => {
    supportApi<{ article: ArticleView; comments: CommentView[] }>("articles/get", { query: { app: appKey, id: articleId } }).then(setData, (cause) => setError(cause instanceof Error ? cause.message : "Návod se nepodařilo načíst."));
  }, [appKey, articleId]);
  useEffect(load, [load]);

  async function send() {
    setBusy(true);
    setNotice("");
    try {
      await supportApi("articles/comments", { body: { app: appKey, articleId, kind: comment.kind, body: comment.body } });
      setComment({ ...comment, body: "" });
      setNotice(comment.kind === "suggestion" ? "Návrh opravy odeslán správci." : "Komentář uložen.");
      load();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Komentář se nepodařilo uložit.");
    } finally {
      setBusy(false);
    }
  }

  if (error) return <div className="grid gap-3"><Button type="button" variant="ghost" className="-ml-2 justify-self-start" onClick={onBack}>← Zpět na návody</Button><Notice tone="error">{error}</Notice></div>;
  if (!data) return <LoadingState label="Načítám návod…" />;
  const { article } = data;
  return (
    <div className="grid gap-4">
      <Button type="button" variant="ghost" className="-ml-2 justify-self-start" onClick={onBack}>← Zpět na návody</Button>
      <SectionCard>
        <p className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <StatusBadge tone="neutral">{ARTICLE_KIND_LABELS_CS[article.kind]}</StatusBadge>
          {article.category && <span>{article.category}</span>}
          {article.status !== "published" && <StatusBadge tone={ARTICLE_TONE[article.status]}>{ARTICLE_STATUS_LABELS_CS[article.status]}</StatusBadge>}
          <span>· aktualizováno {formatDate(article.updatedAt)}</span>
        </p>
        <h2 className="mb-2 text-2xl font-bold tracking-tight">{article.title}</h2>
        {article.summary && <p className="mb-4 text-muted-foreground">{article.summary}</p>}
        <ArticleContent appKey={appKey} body={article.body} />
      </SectionCard>
      <SectionCard title="Komentáře a návrhy oprav" description="Komentář uvidí ostatní uživatelé aplikace, návrh opravy zpracuje správce.">
        {data.comments.length === 0 ? <p className="text-sm text-muted-foreground">Zatím bez komentářů.</p> : (
          <ul className="mb-4 grid gap-2">
            {data.comments.map((entry) => (
              <li key={entry.id} className="rounded-lg border p-3 text-sm">
                <p className="mb-1 text-xs text-muted-foreground">{entry.author ?? "—"} · {formatDate(entry.createdAt)} · {entry.kind === "suggestion" ? "návrh opravy" : "komentář"}{entry.status === "resolved" ? " · vyřešeno" : ""}</p>
                <p className="whitespace-pre-wrap">{entry.body}</p>
              </li>
            ))}
          </ul>
        )}
        {article.status === "published" && (
          <div className="grid gap-2">
            <div className="grid gap-2 sm:grid-cols-[200px_minmax(0,1fr)]">
              <Field id="comment-kind" label="Druh">
                <NativeSelect id="comment-kind" value={comment.kind} onChange={(event) => setComment({ ...comment, kind: event.target.value as "comment" | "suggestion" })}>
                  <option value="comment">Komentář</option>
                  <option value="suggestion">Návrh opravy</option>
                </NativeSelect>
              </Field>
              <Field id="comment-body" label="Text"><Textarea id="comment-body" rows={2} value={comment.body} onChange={(event) => setComment({ ...comment, body: event.target.value })} /></Field>
            </div>
            <ActionBar className="justify-end"><Button type="button" variant="outline" disabled={busy || !comment.body.trim()} onClick={() => void send()}>{busy ? "Ukládám…" : "Odeslat"}</Button></ActionBar>
            {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
          </div>
        )}
      </SectionCard>
      {role === "manager" && <p className="text-sm text-muted-foreground">Úpravy, historii verzí a moderování komentářů najdete ve Správě podpory.</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Hlášení: list and detail (author view and manager view)
// ---------------------------------------------------------------------------------------------
function TicketsTable({ tickets, onOpen, manager }: { tickets: readonly TicketSummary[]; onOpen: (id: string) => void; manager: boolean }) {
  return (
    <>
    {/* phone: cards with the status up front (the table needs ~760 px); the utility "hidden" is reserved for legacy CSS */}
    <ul className="grid gap-2 sm:[display:none]" aria-label="Hlášení">
      {tickets.map((ticket) => (
        <li key={ticket.id}>
          <button type="button" onClick={() => onOpen(ticket.id)} className="grid w-full gap-1.5 rounded-xl border bg-card p-3 text-left focus-visible:ring-3 focus-visible:ring-ring/50">
            <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span className="font-mono">#{ticket.number}</span><TicketStatusBadge status={ticket.status} /><span>{TICKET_KIND_LABELS_CS[ticket.kind]}</span></span>
            <strong className="text-[15px]">{ticket.subject}</strong>
            <span className="text-xs text-muted-foreground">{manager ? `${ticket.author} · ` : ""}{formatDate(ticket.updatedAt)}</span>
          </button>
        </li>
      ))}
    </ul>
    <div className="overflow-hidden rounded-xl border bg-card max-sm:[display:none]">
      <Table className="min-w-[760px]">
        <TableHeader className="bg-muted/60">
          <TableRow className="hover:bg-transparent">
            <TableHead className="pl-4 text-muted-foreground">Číslo</TableHead>
            <TableHead className="text-muted-foreground">Předmět</TableHead>
            <TableHead className="text-muted-foreground">Druh</TableHead>
            <TableHead className="text-muted-foreground">Stav</TableHead>
            {manager && <TableHead className="text-muted-foreground">Autor</TableHead>}
            {manager && <TableHead className="text-muted-foreground">Řešitel</TableHead>}
            <TableHead className="pr-4 text-muted-foreground">Změna</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tickets.map((ticket) => (
            <TableRow key={ticket.id} className="cursor-pointer" onClick={(event) => { if (!(event.target as HTMLElement).closest("button")) onOpen(ticket.id); }}>
              <TableCell className="pl-4 font-mono text-[13px]">#{ticket.number}</TableCell>
              <TableCell className="whitespace-normal"><button type="button" className="text-left font-semibold underline-offset-4 hover:underline" onClick={() => onOpen(ticket.id)}>{ticket.subject}</button></TableCell>
              <TableCell>{TICKET_KIND_LABELS_CS[ticket.kind]}</TableCell>
              <TableCell><TicketStatusBadge status={ticket.status} /></TableCell>
              {manager && <TableCell>{ticket.author}</TableCell>}
              {manager && <TableCell>{ticket.assignee ?? "—"}</TableCell>}
              <TableCell className="pr-4 text-muted-foreground">{formatDate(ticket.updatedAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
    </>
  );
}

function MyTickets({ appKey, onOpen, onReport, reloadKey }: { appKey: string; onOpen: (id: string) => void; onReport: () => void; reloadKey: number }) {
  const [tickets, setTickets] = useState<TicketSummary[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    supportApi<{ tickets: TicketSummary[] }>("tickets", { query: { app: appKey, scope: "mine" } }).then((body) => setTickets(body.tickets), (cause) => setError(cause instanceof Error ? cause.message : "Hlášení se nepodařilo načíst."));
  }, [appKey, reloadKey]);
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!tickets) return <LoadingState label="Načítám hlášení…" />;
  const waiting = tickets.filter((ticket) => ticket.status === "waiting").length;
  return (
    <div className="grid gap-3">
      {waiting > 0 && <Notice tone="warning" title="Čeká na vaše doplnění">{waiting === 1 ? "Jedno hlášení" : `${waiting} hlášení`} čeká na vaši odpověď.</Notice>}
      {tickets.length === 0 ? <EmptyState title="Zatím žádná hlášení" description="Chybu, návrh nebo dotaz pošlete tlačítkem Nahlásit chybu." action={<Button type="button" onClick={onReport}>Nahlásit chybu</Button>} /> : <TicketsTable tickets={tickets} onOpen={onOpen} manager={false} />}
    </div>
  );
}

function AttachmentList({ appKey, attachments }: { appKey: string; attachments: readonly AttachmentView[] }) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    for (const attachment of attachments) {
      if (attachment.kind !== "image") continue;
      attachmentUrl(appKey, attachment.id).then((url) => { if (!cancelled) setUrls((current) => ({ ...current, [attachment.id]: url })); }, () => undefined);
    }
    return () => { cancelled = true; };
  }, [appKey, attachments]);
  if (!attachments.length) return null;
  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {attachments.map((attachment) => (
        <li key={attachment.id} className="grid min-w-0 gap-1 rounded-lg border p-2">
          {attachment.kind === "image" && urls[attachment.id] ? <a href={urls[attachment.id]} target="_blank" rel="noopener noreferrer"><img src={urls[attachment.id]} alt={attachment.fileName} className="h-24 w-full rounded bg-muted object-contain" /></a> : <span className="grid h-24 place-items-center rounded bg-muted text-xs text-muted-foreground">{attachment.kind === "video" ? "Video" : "Obrázek"}</span>}
          <span className="truncate text-xs" title={attachment.fileName}>{attachment.fileName}</span>
          <Button type="button" size="sm" variant="ghost" className="justify-self-start" onClick={() => void attachmentUrl(appKey, attachment.id, true).then((url) => window.open(url, "_blank", "noopener"))}>Stáhnout ({formatBytes(attachment.sizeBytes)})</Button>
        </li>
      ))}
    </ul>
  );
}

const EVENT_TEXT = (event: EventView) => {
  if (event.type === "created") return "Hlášení vytvořeno";
  if (event.type === "assignee") return `Řešitel: ${event.to ?? "nikdo"}${event.from ? ` (dříve ${event.from})` : ""}`;
  const status = (value: string | null) => (value && value in TICKET_STATUS_LABELS_CS ? TICKET_STATUS_LABELS_CS[value as TicketStatus] : value ?? "—");
  return `${event.type === "reopened" ? "Znovu otevřeno" : "Stav"}: ${status(event.from)} → ${status(event.to)}`;
};

function TicketDetailView({ appKey, ticketId, manager, onBack, onChanged }: { appKey: string; ticketId: string; manager: boolean; onBack: () => void; onChanged: () => void }) {
  const [data, setData] = useState<{ ticket: TicketDetail; messages: MessageView[]; events: EventView[]; attachments: AttachmentView[]; assignees?: { id: string; name: string }[]; notifications?: NotificationView[]; missingNotifications?: number } | null>(null);
  const [error, setError] = useState("");
  const [reply, setReply] = useState({ body: "", visibility: "public" as "public" | "internal" });
  const [files, setFiles] = useState<readonly LocalFile[]>([]);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const requestId = useRef(crypto.randomUUID());
  const uploaded = useRef(new Map<string, string>());
  const sending = useRef(false);
  const [status, setStatus] = useState<TicketStatus>("new");
  const [assignee, setAssignee] = useState("");

  const load = useCallback(async () => {
    try {
      const body = await supportApi<NonNullable<typeof data>>("tickets/get", { query: { app: appKey, id: ticketId } });
      setData(body);
      setStatus(body.ticket.status);
      setAssignee(body.ticket.assigneeId ?? "");
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Hlášení se nepodařilo načíst.");
    }
  }, [appKey, ticketId]);
  useEffect(() => { void load(); }, [load]);

  async function sendReply() {
    if (sending.current) return;
    sending.current = true;
    setBusy("reply");
    setNotice("");
    try {
      const attachmentIds: string[] = [];
      for (const entry of files) {
        const id = uploaded.current.get(entry.key) ?? (await uploadSupportFile(appKey, "ticket", entry.file));
        uploaded.current.set(entry.key, id);
        attachmentIds.push(id);
      }
      await supportApi("tickets/reply", { body: { app: appKey, ticketId, clientRequestId: requestId.current, body: reply.body, visibility: reply.visibility, attachmentIds } });
      for (const entry of files) URL.revokeObjectURL(entry.previewUrl);
      setReply({ ...reply, body: "" });
      setFiles([]);
      requestId.current = crypto.randomUUID();
      uploaded.current = new Map();
      setNotice(reply.visibility === "internal" ? "Interní poznámka uložena (autor ji nevidí)." : "Odpověď odeslána.");
      await load();
      onChanged();
    } catch (cause) {
      setNotice(`${cause instanceof Error ? cause.message : "Odpověď se nepodařilo odeslat."} Text zůstal zachovaný.`);
    } finally {
      sending.current = false;
      setBusy("");
    }
  }

  async function requeue() {
    setBusy("requeue");
    setNotice("");
    try {
      const result = await supportApi<{ events: number; messages: number }>("notifications/requeue", { body: { app: appKey, ticketId } });
      setNotice(result.events ? `Doplněno upozornění: ${result.messages} (událostí ${result.events}).` : "Nic nechybělo.");
      await load();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Upozornění se nepodařilo zařadit.");
    } finally {
      setBusy("");
    }
  }

  async function saveState() {
    if (!data) return;
    setBusy("state");
    setNotice("");
    try {
      await supportApi("tickets/update", { body: { app: appKey, ticketId, expectedUpdatedAt: data.ticket.updatedAt, ...(status !== data.ticket.status ? { status } : {}), ...(assignee !== (data.ticket.assigneeId ?? "") ? { assigneeId: assignee || null } : {}) } });
      setNotice("Uloženo.");
      await load();
      onChanged();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Změnu se nepodařilo uložit.");
    } finally {
      setBusy("");
    }
  }

  function onPaste(event: React.ClipboardEvent) {
    const images = pastedImages(event).filter((file) => !localFileProblem(file));
    if (!images.length) return;
    event.preventDefault();
    setFiles([...files, ...images.slice(0, Math.max(0, SUPPORT_LIMITS.messageAttachments - files.length)).map((file) => localFile(file))]);
  }

  if (error) return <div className="grid gap-3"><Button type="button" variant="ghost" className="-ml-2 justify-self-start" onClick={onBack}>← Zpět</Button><Notice tone="error">{error}</Notice></div>;
  if (!data) return <LoadingState label="Načítám hlášení…" />;
  const { ticket } = data;
  const reportAttachments = data.attachments.filter((attachment) => attachment.messageId === null);
  const stateDirty = status !== ticket.status || assignee !== (ticket.assigneeId ?? "");
  const closedForAuthor = ticket.status === "closed" && !manager;
  return (
    <div className="grid gap-4">
      <Button type="button" variant="ghost" className="-ml-2 justify-self-start" onClick={onBack}>← Zpět na hlášení</Button>
      <SectionCard>
        <p className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">#{ticket.number}</span>
          <TicketStatusBadge status={ticket.status} />
          <span>{TICKET_KIND_LABELS_CS[ticket.kind]}</span>
          <span>· {ticket.author}, {formatDate(ticket.createdAt)}</span>
        </p>
        <h2 className="mb-3 text-2xl font-bold tracking-tight">{ticket.subject}</h2>
        <div className="grid gap-3 text-sm">
          <p className="whitespace-pre-wrap">{ticket.description}</p>
          {ticket.steps && <div><strong className="block text-xs text-muted-foreground">Kroky k zopakování</strong><p className="whitespace-pre-wrap">{ticket.steps}</p></div>}
          {(ticket.expected || ticket.actual) && (
            <div className="grid gap-3 sm:grid-cols-2">
              {ticket.expected && <div><strong className="block text-xs text-muted-foreground">Očekávaný výsledek</strong><p className="whitespace-pre-wrap">{ticket.expected}</p></div>}
              {ticket.actual && <div><strong className="block text-xs text-muted-foreground">Skutečný výsledek</strong><p className="whitespace-pre-wrap">{ticket.actual}</p></div>}
            </div>
          )}
          <AttachmentList appKey={appKey} attachments={reportAttachments} />
          <details className="rounded-lg border bg-muted/40 p-3 text-xs">
            <summary className="cursor-pointer font-medium">Kontext</summary>
            <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">Oblast</dt><dd>{supportAreaLabel(String(ticket.context.area ?? ""))}</dd>
              <dt className="text-muted-foreground">Cesta</dt><dd className="break-all">{String(ticket.context.path ?? "—")}</dd>
              <dt className="text-muted-foreground">Verze</dt><dd>{String(ticket.context.appVersion ?? "—")}</dd>
              <dt className="text-muted-foreground">Prohlížeč</dt><dd>{String(ticket.context.browser ?? "—")}</dd>
              <dt className="text-muted-foreground">Okno</dt><dd>{String(ticket.context.viewport ?? "—")}</dd>
              {ticket.hasProject && <><dt className="text-muted-foreground">Zakázka</dt><dd>{ticket.project ? ticket.project.name : "připojená (nemáte k ní přístup)"}</dd></>}
            </dl>
          </details>
        </div>
      </SectionCard>

      {manager && (
        <SectionCard title="Stav a řešitel">
          <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
            <Field id="ticket-status" label="Stav">
              <NativeSelect id="ticket-status" value={status} onChange={(event) => setStatus(event.target.value as TicketStatus)}>
                {TICKET_STATUSES.filter((candidate) => candidate === ticket.status || canChangeStatus(ticket.status, candidate)).map((candidate) => <option key={candidate} value={candidate}>{TICKET_STATUS_LABELS_CS[candidate]}{candidate !== ticket.status && (ticket.status === "resolved" || ticket.status === "closed") && candidate === "in_progress" ? " (znovu otevřít)" : ""}</option>)}
              </NativeSelect>
            </Field>
            <Field id="ticket-assignee" label="Řešitel">
              <NativeSelect id="ticket-assignee" value={assignee} onChange={(event) => setAssignee(event.target.value)}>
                <option value="">Nepřiřazeno</option>
                {(data.assignees ?? []).map((admin) => <option key={admin.id} value={admin.id}>{admin.name}</option>)}
              </NativeSelect>
            </Field>
            <Button type="button" disabled={!stateDirty || busy !== ""} onClick={() => void saveState()}>{busy === "state" ? "Ukládám…" : "Uložit"}</Button>
          </div>
        </SectionCard>
      )}

      <SectionCard title="Konverzace" onPaste={onPaste}>
        {data.messages.length === 0 ? <p className="mb-3 text-sm text-muted-foreground">Zatím bez odpovědí.</p> : (
          <ul className="mb-4 grid gap-2">
            {data.messages.map((message) => (
              <li key={message.id} className={cn("rounded-lg border p-3 text-sm", message.visibility === "internal" && "border-warning/40 bg-warning-soft")}>
                <p className="mb-1 text-xs text-muted-foreground">{message.author} · {formatDate(message.createdAt)}{message.visibility === "internal" ? " · interní poznámka (autor hlášení ji nevidí)" : ""}</p>
                <p className="whitespace-pre-wrap">{message.body}</p>
                <div className="mt-2"><AttachmentList appKey={appKey} attachments={data.attachments.filter((attachment) => attachment.messageId === message.id)} /></div>
              </li>
            ))}
          </ul>
        )}
        {closedForAuthor ? <p className="text-sm text-muted-foreground">Hlášení je uzavřené. Pokud problém trvá, založte nové.</p> : (
          <div className="grid gap-2">
            {manager && (
              <ActionBar role="group" aria-label="Druh odpovědi">
                <Button type="button" size="sm" variant={reply.visibility === "public" ? "default" : "outline"} aria-pressed={reply.visibility === "public"} onClick={() => setReply({ ...reply, visibility: "public" })}>Odpověď autorovi</Button>
                <Button type="button" size="sm" variant={reply.visibility === "internal" ? "default" : "outline"} aria-pressed={reply.visibility === "internal"} onClick={() => setReply({ ...reply, visibility: "internal" })}>Interní poznámka</Button>
              </ActionBar>
            )}
            <Field id="ticket-reply" label={reply.visibility === "internal" ? "Interní poznámka (jen pro správce)" : ticket.mine && ticket.status === "waiting" ? "Doplnění pro správce" : "Odpověď"}>
              <Textarea id="ticket-reply" rows={3} value={reply.body} onChange={(event) => setReply({ ...reply, body: event.target.value })} />
            </Field>
            <AttachmentPicker idPrefix="reply" files={files} onChange={setFiles} max={SUPPORT_LIMITS.messageAttachments} disabled={busy !== ""} />
            <ActionBar className="justify-end"><Button type="button" disabled={busy !== "" || !reply.body.trim()} onClick={() => void sendReply()}>{busy === "reply" ? "Odesílám…" : reply.visibility === "internal" ? "Uložit poznámku" : "Odeslat"}</Button></ActionBar>
          </div>
        )}
        {notice && <p role="status" className="mt-2 text-sm text-muted-foreground">{notice}</p>}
      </SectionCard>

      <SectionCard title="Historie">
        <ol className="grid gap-1 text-sm">
          {data.events.map((event) => <li key={event.id}><span className="text-muted-foreground">{formatDate(event.createdAt)} · {event.actor}:</span> {EVENT_TEXT(event)}</li>)}
        </ol>
      </SectionCard>

      {manager && data.notifications && (
        <SectionCard title="E-mailová upozornění" description="Jen pro správce. E-mail obsahuje číslo, předmět a odkaz — text odpovědí, interní poznámky ani přílohy neposílá.">
          {Boolean(data.missingNotifications) && (
            <Notice tone="warning" title="Chybí záznam upozornění">
              {data.missingNotifications === 1 ? "U jedné události" : `U ${data.missingNotifications} událostí`} posledních 7 dní se upozornění nezařadilo (např. výpadek databáze při uložení). Doplnění zařadí jen tyto události — hlášení ani jiná upozornění se neopakují.{" "}
              <Button type="button" size="sm" variant="outline" disabled={busy !== ""} onClick={() => void requeue()}>{busy === "requeue" ? "Doplňuji…" : "Doplnit chybějící upozornění"}</Button>
            </Notice>
          )}
          {data.notifications.length === 0 ? <p className="text-sm text-muted-foreground">K tomuto hlášení se zatím nic neposílalo.</p> : (
            <ul className="grid gap-1 text-sm">
              {data.notifications.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-baseline gap-x-2">
                  <StatusBadge tone={entry.status === "sent" ? "success" : entry.status === "failed" ? "warning" : entry.status === "skipped" ? "muted" : "neutral"}>{NOTIFICATION_STATUS_LABELS_CS[entry.status] ?? entry.status}</StatusBadge>
                  <span>{NOTIFICATION_KIND_LABELS_CS[entry.kind]} → {entry.recipient}</span>
                  <span className="text-muted-foreground">
                    {entry.sentAt ? formatDate(entry.sentAt) : formatDate(entry.createdAt)}
                    {entry.attempts > 1 ? ` · pokusů ${entry.attempts}` : ""}
                    {entry.status === "failed" && entry.nextAttemptAt ? ` · další pokus ${formatDate(entry.nextAttemptAt)}` : ""}
                    {entry.error ? ` · ${entry.error}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Správa podpory: articles (editor, versions, comments) and every report of the app
// ---------------------------------------------------------------------------------------------
type EditorDraft = { kind: ArticleKind; category: string; title: string; summary: string; body: string; areaKeys: string[]; forExternal: boolean; status: ArticleStatus; sortOrder: number };
const emptyDraft: EditorDraft = { kind: "guide", category: "", title: "", summary: "", body: "", areaKeys: [], forExternal: false, status: "draft", sortOrder: 0 };

function ArticleEditor({ appKey, articleId, onBack, onCreated }: { appKey: string; articleId: string | null; onBack: () => void; onCreated: (id: string) => void }) {
  const [draft, setDraft] = useState<EditorDraft>(emptyDraft);
  const [version, setVersion] = useState(0);
  const [loaded, setLoaded] = useState(articleId === null);
  const [saved, setSaved] = useState<EditorDraft>(emptyDraft);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "warning"; text: string } | null>(null);
  const [preview, setPreview] = useState(false);
  const [videoLink, setVideoLink] = useState("");
  const [versions, setVersions] = useState<{ version: number; createdAt: string; author: string; snapshot: EditorDraft }[] | null>(null);
  const [shownVersion, setShownVersion] = useState<number | null>(null);
  const [comments, setComments] = useState<CommentView[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const currentId = useRef<string | null>(articleId);

  const load = useCallback(async (id: string) => {
    const body = await supportApi<{ article: ArticleView & { version: number }; comments: CommentView[] }>("articles/get", { query: { app: appKey, id } });
    const next: EditorDraft = { kind: body.article.kind, category: body.article.category, title: body.article.title, summary: body.article.summary, body: body.article.body, areaKeys: body.article.areaKeys, forExternal: body.article.forExternal, status: body.article.status, sortOrder: body.article.sortOrder };
    setDraft(next);
    setSaved(next);
    setVersion(body.article.version);
    setComments(body.comments);
    setLoaded(true);
    const history = await supportApi<{ versions: { version: number; createdAt: string; author: string; snapshot: EditorDraft }[] }>("articles/versions", { query: { app: appKey, id } });
    setVersions(history.versions);
  }, [appKey]);
  useEffect(() => { if (articleId) void load(articleId).catch((cause) => setNotice({ tone: "error", text: cause instanceof Error ? cause.message : "Článek se nepodařilo načíst." })); }, [articleId, load]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function save() {
    setBusy("save");
    setNotice(null);
    try {
      const response = await supportApi<{ article: ArticleView & { version: number } }>("articles/save", { body: { app: appKey, id: currentId.current, expectedVersion: version, ...draft } });
      if (!currentId.current) onCreated(response.article.id); // the address now names the article (reload, Back)
      currentId.current = response.article.id;
      await load(response.article.id);
      setNotice({ tone: "success", text: `Uloženo jako verze ${response.article.version}.` });
    } catch (cause) {
      const stale = (cause as { code?: string }).code === "stale";
      setNotice({ tone: stale ? "warning" : "error", text: cause instanceof Error ? cause.message : "Článek se nepodařilo uložit." });
    } finally {
      setBusy("");
    }
  }

  async function restore(target: number) {
    if (!currentId.current) return;
    setBusy("restore");
    setNotice(null);
    try {
      const response = await supportApi<{ article: { version: number } }>("articles/restore", { body: { app: appKey, id: currentId.current, version: target, expectedVersion: version } });
      await load(currentId.current);
      setShownVersion(null);
      setNotice({ tone: "success", text: `Verze ${target} obnovena jako nová verze ${response.article.version}.` });
    } catch (cause) {
      setNotice({ tone: "error", text: cause instanceof Error ? cause.message : "Verzi se nepodařilo obnovit." });
    } finally {
      setBusy("");
    }
  }

  async function addMedia(fileList: FileList | null) {
    const file = fileList?.[0];
    if (!file) return;
    const problem = localFileProblem(file);
    if (problem) {
      setNotice({ tone: "error", text: problem });
      return;
    }
    setBusy("upload");
    try {
      const id = await uploadSupportFile(appKey, "article", file);
      const line = file.type.startsWith("video/") ? `!video[${file.name}](příloha:${id})` : `![${file.name}](příloha:${id})`;
      setDraft((current) => ({ ...current, body: `${current.body.trimEnd()}\n\n${line}\n` }));
      setNotice({ tone: "success", text: "Soubor nahrán a vložen na konec textu. K článku se připojí uložením." });
    } catch (cause) {
      setNotice({ tone: "error", text: cause instanceof Error ? cause.message : "Soubor se nepodařilo nahrát." });
    } finally {
      setBusy("");
    }
  }

  async function moderate(id: string, patch: { status?: "open" | "resolved"; hidden?: boolean }) {
    await supportApi("articles/comments/moderate", { body: { app: appKey, commentId: id, ...patch } });
    if (currentId.current) await load(currentId.current);
  }

  if (!loaded) return <LoadingState label="Načítám článek…" />;
  const shown = versions?.find((entry) => entry.version === shownVersion);
  return (
    <div className="grid gap-4">
      <Button type="button" variant="ghost" className="-ml-2 justify-self-start" onClick={onBack}>← Zpět na články</Button>
      <SectionCard title={currentId.current ? `Upravit článek (verze ${version})` : "Nový článek"} actions={<Button type="button" disabled={busy !== "" || !draft.title.trim() || !dirty} onClick={() => void save()}>{busy === "save" ? "Ukládám…" : "Uložit"}</Button>}>
        {notice && <Notice tone={notice.tone}>{notice.text}{(notice.tone === "warning" && currentId.current) && <> {" "}<Button type="button" variant="link" className="h-auto p-0" onClick={() => void load(currentId.current!)}>Načíst aktuální verzi</Button></>}</Notice>}
        <div className="@container grid gap-4">
          <div className="grid gap-3 @2xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
            <Field id="article-title" label="Název *"><Input id="article-title" value={draft.title} maxLength={200} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></Field>
            <Field id="article-kind" label="Druh">
              <NativeSelect id="article-kind" value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as ArticleKind })}>{ARTICLE_KINDS.map((kind) => <option key={kind} value={kind}>{ARTICLE_KIND_LABELS_CS[kind]}</option>)}</NativeSelect>
            </Field>
            <Field id="article-status" label="Stav">
              <NativeSelect id="article-status" value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as ArticleStatus })}>{ARTICLE_STATUSES.map((status) => <option key={status} value={status}>{ARTICLE_STATUS_LABELS_CS[status]}</option>)}</NativeSelect>
            </Field>
          </div>
          <div className="grid gap-3 @2xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Field id="article-category" label="Kategorie"><Input id="article-category" value={draft.category} maxLength={80} onChange={(event) => setDraft({ ...draft, category: event.target.value })} placeholder="např. Katalog" /></Field>
            <Field id="article-order" label="Pořadí"><Input id="article-order" type="number" value={draft.sortOrder} onChange={(event) => setDraft({ ...draft, sortOrder: Number(event.target.value) || 0 })} /></Field>
          </div>
          <Field id="article-summary" label="Krátký úvod"><Textarea id="article-summary" rows={2} maxLength={600} value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} /></Field>
          <div className="grid gap-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor="article-body" className="text-[13px] font-semibold text-muted-foreground">Obsah</Label>
              <ActionBar>
                <Button type="button" size="sm" variant={preview ? "outline" : "default"} aria-pressed={!preview} onClick={() => setPreview(false)}>Text</Button>
                <Button type="button" size="sm" variant={preview ? "default" : "outline"} aria-pressed={preview} onClick={() => setPreview(true)}>Náhled</Button>
              </ActionBar>
            </div>
            {preview ? <div className="min-h-40 rounded-lg border p-4"><ArticleContent appKey={appKey} body={draft.body} /></div> : <Textarea id="article-body" rows={14} className="font-mono text-[13px]" value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} />}
            <p className="text-xs text-muted-foreground">„## Nadpis“, „### Podnadpis“, „- odrážka“, „1. krok“, **tučně**, _kurzíva_, [odkaz](https://… nebo /abf…). HTML ani vložené rámce se nepovolují.</p>
            <ActionBar>
              <Button type="button" size="sm" variant="outline" disabled={busy !== ""} onClick={() => fileRef.current?.click()}>{busy === "upload" ? "Nahrávám…" : "Vložit obrázek nebo video"}</Button>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm" className="sr-only" tabIndex={-1} onChange={(event) => { void addMedia(event.target.files); event.target.value = ""; }} />
              <Input aria-label="Odkaz na video YouTube nebo Vimeo" className="max-w-xs" value={videoLink} onChange={(event) => setVideoLink(event.target.value)} placeholder="https://youtu.be/…" />
              <Button type="button" size="sm" variant="outline" disabled={!videoEmbedOf(videoLink)} onClick={() => { setDraft({ ...draft, body: `${draft.body.trimEnd()}\n\n!video[Video](${videoLink.trim()})\n` }); setVideoLink(""); }}>Vložit video odkazem</Button>
            </ActionBar>
            <p className="text-xs text-muted-foreground">Video odkazem jen z YouTube nebo Vimeo (přehrávač sestaví aplikace). Soubory: obrázky do {formatBytes(SUPPORT_LIMITS.imageBytes)}, videa do {formatBytes(SUPPORT_LIMITS.videoBytes)}, nejvýš {SUPPORT_LIMITS.articleAttachments} na článek.</p>
          </div>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-[13px] font-semibold text-muted-foreground">Kontextová nápověda — části aplikace</legend>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {SUPPORT_AREAS.map((area) => (
                <div key={area.key} className="flex items-center gap-2">
                  <Checkbox id={`article-area-${area.key}`} checked={draft.areaKeys.includes(area.key)} onCheckedChange={(checked) => setDraft((current) => ({ ...current, areaKeys: checked === true ? [...current.areaKeys, area.key] : current.areaKeys.filter((key) => key !== area.key) }))} />
                  <Label htmlFor={`article-area-${area.key}`} className="font-normal">{area.label}</Label>
                </div>
              ))}
            </div>
          </fieldset>
          <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft p-3">
            <Checkbox id="article-external" checked={draft.forExternal} onCheckedChange={(checked) => setDraft({ ...draft, forExternal: checked === true })} />
            <Label htmlFor="article-external" className="grid gap-0.5 font-normal">
              <span className="font-medium">Určeno i pro externí uživatele</span>
              <span className="text-xs">Zaškrtněte jen u obecných návodů. Nikdy u administrace, cen nebo neveřejných postupů — externí účet pak článek ani jeho přílohy neuvidí.</span>
            </Label>
          </div>
        </div>
      </SectionCard>

      {currentId.current && (
        <SectionCard title="Historie verzí" description="Každé uložení je nová verze. Obnovení starší verze vytvoří další novou verzi — historie se nepřepisuje.">
          {!versions ? <LoadingState rows={1} /> : (
            <ul className="grid gap-1 text-sm">
              {versions.map((entry) => (
                <li key={entry.version} className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2">
                  <strong>Verze {entry.version}</strong>
                  <span className="text-muted-foreground">{entry.author} · {formatDate(entry.createdAt)} · {ARTICLE_STATUS_LABELS_CS[entry.snapshot.status]}</span>
                  <span className="ml-auto flex gap-1">
                    <Button type="button" size="sm" variant="ghost" onClick={() => setShownVersion(shownVersion === entry.version ? null : entry.version)}>{shownVersion === entry.version ? "Skrýt" : "Zobrazit"}</Button>
                    {entry.version !== version && <Button type="button" size="sm" variant="outline" disabled={busy !== "" || dirty} onClick={() => void restore(entry.version)}>Obnovit jako novou verzi</Button>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {dirty && <p className="mt-2 text-xs text-muted-foreground">Před obnovením verze uložte nebo zahoďte rozpracované změny.</p>}
          {shown && <div className="mt-3 rounded-lg border bg-muted/30 p-4"><h3 className="mb-2 text-lg font-semibold">{shown.snapshot.title}</h3><ArticleContent appKey={appKey} body={shown.snapshot.body} /></div>}
        </SectionCard>
      )}

      {currentId.current && (
        <SectionCard title="Komentáře a návrhy oprav">
          {comments.length === 0 ? <p className="text-sm text-muted-foreground">Zatím bez komentářů.</p> : (
            <ul className="grid gap-2">
              {comments.map((entry) => (
                <li key={entry.id} className={cn("rounded-lg border p-3 text-sm", entry.hidden && "opacity-60")}>
                  <p className="mb-1 text-xs text-muted-foreground">{entry.author} · {formatDate(entry.createdAt)} · {entry.kind === "suggestion" ? "návrh opravy" : "komentář"}{entry.status === "resolved" ? " · vyřešeno" : ""}{entry.hidden ? " · skryto" : ""}</p>
                  <p className="whitespace-pre-wrap">{entry.body}</p>
                  <ActionBar className="mt-2">
                    <Button type="button" size="sm" variant="outline" onClick={() => void moderate(entry.id, { status: entry.status === "resolved" ? "open" : "resolved" })}>{entry.status === "resolved" ? "Znovu otevřít" : "Označit jako vyřešené"}</Button>
                    <Button type="button" size="sm" variant={entry.hidden ? "outline" : "destructive"} onClick={() => void moderate(entry.id, { hidden: !entry.hidden })}>{entry.hidden ? "Zobrazit" : "Skrýt"}</Button>
                  </ActionBar>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}
    </div>
  );
}

function ManageArticles({ appKey, onOpen }: { appKey: string; onOpen: (id: string | "novy") => void }) {
  const { articles, error } = useArticles(appKey, 0);
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!articles) return <LoadingState label="Načítám články…" />;
  return (
    <div className="grid gap-3">
      <ActionBar className="justify-end"><Button type="button" onClick={() => onOpen("novy")}>+ Nový článek</Button></ActionBar>
      {articles.length === 0 ? <EmptyState title="Zatím žádné články" description="Vytvořte první návod nebo FAQ. Koncept uživatelé nevidí, dokud ho nepublikujete." /> : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table className="min-w-[760px]">
            <TableHeader className="bg-muted/60">
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4 text-muted-foreground">Název</TableHead>
                <TableHead className="text-muted-foreground">Druh</TableHead>
                <TableHead className="text-muted-foreground">Kategorie</TableHead>
                <TableHead className="text-muted-foreground">Stav</TableHead>
                <TableHead className="text-muted-foreground">Pro externí</TableHead>
                <TableHead className="pr-4 text-muted-foreground">Upraveno</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {articles.map((article) => (
                <TableRow key={article.id} className="cursor-pointer" onClick={(event) => { if (!(event.target as HTMLElement).closest("button")) onOpen(article.id); }}>
                  <TableCell className="pl-4 whitespace-normal"><button type="button" className="text-left font-semibold underline-offset-4 hover:underline" onClick={() => onOpen(article.id)}>{article.title}</button></TableCell>
                  <TableCell>{ARTICLE_KIND_LABELS_CS[article.kind]}</TableCell>
                  <TableCell>{article.category || "—"}</TableCell>
                  <TableCell><StatusBadge tone={ARTICLE_TONE[article.status]}>{ARTICLE_STATUS_LABELS_CS[article.status]}</StatusBadge></TableCell>
                  <TableCell>{article.forExternal ? "Ano" : "Ne"}</TableCell>
                  <TableCell className="pr-4 text-muted-foreground">{formatDate(article.updatedAt)}{article.updatedBy ? ` · ${article.updatedBy}` : ""}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function ManageTickets({ appKey, onOpen, reloadKey }: { appKey: string; onOpen: (id: string) => void; reloadKey: number }) {
  const [tickets, setTickets] = useState<TicketSummary[] | null>(null);
  const [error, setError] = useState("");
  const [filters, setFilters] = useState({ status: "", kind: "", author: "" });
  useEffect(() => {
    supportApi<{ tickets: TicketSummary[] }>("tickets", { query: { app: appKey, scope: "all" } }).then((body) => setTickets(body.tickets), (cause) => setError(cause instanceof Error ? cause.message : "Hlášení se nepodařilo načíst."));
  }, [appKey, reloadKey]);
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!tickets) return <LoadingState label="Načítám hlášení…" />;
  const authors = [...new Map(tickets.map((ticket) => [ticket.authorId ?? "", ticket.author])).entries()].filter(([id]) => id).sort((a, b) => a[1].localeCompare(b[1], "cs"));
  const shown = tickets.filter((ticket) => (!filters.status || ticket.status === filters.status) && (!filters.kind || ticket.kind === filters.kind) && (!filters.author || ticket.authorId === filters.author));
  return (
    <div className="grid gap-3">
      <div className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-3" role="search">
        <Field id="manage-status" label="Stav"><NativeSelect id="manage-status" value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}><option value="">Všechny</option>{TICKET_STATUSES.map((status) => <option key={status} value={status}>{TICKET_STATUS_LABELS_CS[status]} ({tickets.filter((ticket) => ticket.status === status).length})</option>)}</NativeSelect></Field>
        <Field id="manage-kind" label="Druh"><NativeSelect id="manage-kind" value={filters.kind} onChange={(event) => setFilters({ ...filters, kind: event.target.value })}><option value="">Všechny</option>{TICKET_KINDS.map((kind) => <option key={kind} value={kind}>{TICKET_KIND_LABELS_CS[kind]}</option>)}</NativeSelect></Field>
        <Field id="manage-author" label="Autor"><NativeSelect id="manage-author" value={filters.author} onChange={(event) => setFilters({ ...filters, author: event.target.value })}><option value="">Všichni</option>{authors.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</NativeSelect></Field>
      </div>
      {shown.length === 0 ? <EmptyState title="Žádná hlášení" description={tickets.length ? "Filtrům neodpovídá žádné hlášení." : "Uživatelé zatím nic nenahlásili."} /> : <TicketsTable tickets={shown} onOpen={onOpen} manager />}
    </div>
  );
}

function NotificationsInactive({ state }: { state?: NotificationsState }) {
  if (!state || state.active) return null;
  return (
    <Notice tone="warning" title="E-mailová upozornění nejsou aktivní">
      {state.reason} Nová hlášení, odpovědi ani změny stavu se nikomu neposílají e-mailem — vše je vidět jen v aplikaci. Nastavení: docs/SUPPORT.md, kapitola E-mailová upozornění.
    </Notice>
  );
}

function ManageView({ appKey, route, onNavigate, reloadKey, onChanged, notifications }: { appKey: string; route: SupportRoute; onNavigate: (route: SupportRoute) => void; reloadKey: number; onChanged: () => void; notifications?: NotificationsState }) {
  // an article created in the open editor keeps that editor (and its "Uloženo" notice) when the address switches to its id
  const [createdHere, setCreatedHere] = useState<Readonly<Record<string, string>>>({});
  const parts = segments(route);
  const area = parts[1] === "hlaseni" ? "hlaseni" : "clanky";
  if (area === "clanky" && parts[2]) {
    return (
      <ArticleEditor
        key={createdHere[parts[2]] ?? parts[2]}
        appKey={appKey}
        articleId={parts[2] === "novy" ? null : parts[2]}
        onBack={() => onNavigate("sprava/clanky")}
        onCreated={(id) => { setCreatedHere((current) => ({ ...current, [id]: "novy" })); onNavigate(`sprava/clanky/${id}`); }}
      />
    );
  }
  if (area === "hlaseni" && parts[2]) {
    return (
      <div className="grid gap-4">
        <NotificationsInactive state={notifications} />
        <TicketDetailView key={parts[2]} appKey={appKey} ticketId={parts[2]} manager onBack={() => onNavigate("sprava/hlaseni")} onChanged={onChanged} />
      </div>
    );
  }
  return (
    <div className="grid gap-4">
      <NotificationsInactive state={notifications} />
      <ActionBar role="group" aria-label="Správa podpory">
        <Button type="button" variant={area === "clanky" ? "default" : "outline"} aria-pressed={area === "clanky"} onClick={() => onNavigate("sprava/clanky")}>Návody a FAQ</Button>
        <Button type="button" variant={area === "hlaseni" ? "default" : "outline"} aria-pressed={area === "hlaseni"} onClick={() => onNavigate("sprava/hlaseni")}>Hlášení</Button>
      </ActionBar>
      {area === "clanky" ? <ManageArticles appKey={appKey} onOpen={(id) => onNavigate(`sprava/clanky/${id}`)} /> : <ManageTickets appKey={appKey} reloadKey={reloadKey} onOpen={(id) => onNavigate(`sprava/hlaseni/${id}`)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------
/**
 * Nápověda a podpora of one application (V1-SUPPORT-01): Návody a FAQ · Moje hlášení · Správa podpory
 * (managers). The server decides every answer; this page only shows what it gets. Navigation stays
 * inside the page — nothing else of the application is closed.
 */
export function SupportCenter({ appKey, role, route, onNavigate, onReport, reloadKey, counts, onChanged, notifications }: Readonly<{
  appKey: string;
  role: SupportRole;
  route: SupportRoute;
  onNavigate: (route: SupportRoute) => void;
  onReport: () => void;
  reloadKey: number;
  counts: { newTickets: number; waitingForMe: number };
  onChanged: () => void;
  /** Managers: whether support e-mails go out (V1-SUPPORT-02). */
  notifications?: NotificationsState;
}>) {
  const parts = segments(route);
  const first = parts[0] === "hlaseni" || (parts[0] === "sprava" && role === "manager") ? parts[0] : "navody";
  return (
    <div data-ui="support" className="mx-auto w-full max-w-[1200px] px-4 pt-6 pb-16 text-foreground sm:px-8">
      <PageHeader eyebrow="ABF Generator" title="Nápověda a podpora" description="Návody, odpovědi na časté dotazy a vaše hlášení chyb a návrhů." actions={<Button type="button" onClick={onReport}>Nahlásit chybu</Button>} />
      <SupportTabs route={route} role={role} counts={counts} onNavigate={onNavigate} />
      {first === "navody" && (parts[1] ? <ArticleReader key={parts[1]} appKey={appKey} articleId={parts[1]} role={role} onBack={() => onNavigate("navody")} /> : <GuidesList appKey={appKey} role={role} onReport={onReport} onOpen={(id) => onNavigate(`navody/${id}`)} />)}
      {first === "hlaseni" && (parts[1] ? <TicketDetailView key={parts[1]} appKey={appKey} ticketId={parts[1]} manager={false} onBack={() => onNavigate("hlaseni")} onChanged={onChanged} /> : <MyTickets appKey={appKey} reloadKey={reloadKey} onReport={onReport} onOpen={(id) => onNavigate(`hlaseni/${id}`)} />)}
      {first === "sprava" && <ManageView appKey={appKey} route={route} onNavigate={onNavigate} reloadKey={reloadKey} onChanged={onChanged} notifications={notifications} />}
    </div>
  );
}
