import { NextResponse, type NextRequest } from "next/server.js";
import packageJson from "../../package.json" with { type: "json" };
import {
  ARTICLE_KINDS,
  ARTICLE_STATUSES,
  ATTACHMENT_TYPES,
  SUPPORT_LIMITS,
  attachmentProblem,
  canChangeStatus,
  canManageSupport,
  canReadArticle,
  canReadComment,
  canReadTicket,
  isSupportAppKey,
  isSupportAreaKey,
  referencedAttachmentIds,
  safeFileName,
  sanitizeClientContext,
  sniffAttachmentType,
  supportRoleOf,
  ticketDraftProblem,
  visibleMessages,
  TICKET_STATUSES,
  type ArticleKind,
  type ArticleStatus,
  type AttachmentMime,
  type SupportAppKey,
  type SupportRole,
  type TicketKind,
  type TicketStatus,
} from "../../domain/support.ts";
import { SupabaseConfigurationError } from "../db/supabase.server.ts";
import { AuthSchemaNotMigratedError, type AuthUser } from "../auth/authStore.server.ts";
import { authenticateAccount, authorizeProject, forbiddenResponse } from "../auth/requestAuth.ts";
import { R2ConfigurationError } from "../storage/r2Config.ts";
import { supportFiles } from "./supportFiles.server.ts";
import { missingTicketNotifications, queueSupportNotifications, requeueTicketNotifications, scheduleSupportDispatch, supportNotificationState } from "./supportNotifications.server.ts";
import { SupportConflictError, SupportSchemaNotMigratedError, supportStore, type ArticleInput, type ArticleRecord, type AttachmentRecord, type TicketRecord } from "./supportStore.supabase.ts";

/**
 * V1-SUPPORT-01 — API of the in-app support. Every handler: active account → support enabled for
 * the application → the account's MEMBERSHIP ROLE in that application (manager / member /
 * external), on every request (a removed membership, a role change or a deactivation applies to an
 * already open session). The shared HomeworkStudio administrator flag alone opens nothing.
 * Internal notes and their attachments never leave the server for anyone but a manager. Files are
 * served only as short-lived presigned URLs after the owner (article / report / message) was checked.
 */
type Support = Readonly<{ user: AuthUser; role: SupportRole; appKey: SupportAppKey }>;
type SupportDecision = Readonly<{ ok: true; support: Support }> | Readonly<{ ok: false; response: NextResponse }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const DOWNLOAD_SECONDS = 300;
const UPLOAD_SECONDS = 600;

export const noSupportAccess = () => NextResponse.json({ error: "K podpoře této aplikace nemáte přístup.", code: "no_app_access" }, { status: 403 });

export async function authorizeSupport(request: NextRequest, appKey: unknown): Promise<SupportDecision> {
  const decision = await authenticateAccount(request);
  if (decision.ok === false) return decision;
  if (!isSupportAppKey(appKey)) return { ok: false, response: NextResponse.json({ error: "Podpora této aplikace zatím není dostupná.", code: "support_unavailable" }, { status: 404 }) };
  const role = supportRoleOf(appKey, decision.auth.user.apps[appKey]);
  if (!role) return { ok: false, response: noSupportAccess() };
  return { ok: true, support: { user: decision.auth.user, role, appKey } };
}

async function readJson(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
const appOf = (request: NextRequest) => new URL(request.url).searchParams.get("app");
const param = (request: NextRequest, name: string) => new URL(request.url).searchParams.get(name) ?? "";
const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");
const notFound = (what = "Záznam") => NextResponse.json({ error: `${what} neexistuje nebo k němu nemáte přístup.`, code: "not_found" }, { status: 404 });

function errorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof SupportConflictError) return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
  if (error instanceof SupportSchemaNotMigratedError || error instanceof AuthSchemaNotMigratedError || error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message, code: "config" }, { status: 503 });
  if (error instanceof R2ConfigurationError) return NextResponse.json({ error: error.message, code: "storage_config" }, { status: 503 });
  console.error(`Support: ${fallback}`, error instanceof Error ? error.message : error);
  return NextResponse.json({ error: fallback }, { status: 502 });
}

const appVersion = () => `${(packageJson as { version?: string }).version ?? "?"}${process.env.VERCEL_GIT_COMMIT_SHA ? ` (${process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7)})` : ""}`;

// ---------------------------------------------------------------------------------------------
// Summary (counters)
// ---------------------------------------------------------------------------------------------
export async function handleSupportSummary(request: NextRequest): Promise<NextResponse> {
  const decision = await authorizeSupport(request, appOf(request));
  if (decision.ok === false) return decision.response;
  const { user, role, appKey } = decision.support;
  try {
    const store = supportStore();
    const tickets = await store.listTickets(appKey, canManageSupport(role) ? undefined : user.id);
    // every open client polls this: due e-mail retries go out after the response (V1-SUPPORT-02)
    scheduleSupportDispatch(request, undefined, 10);
    return NextResponse.json({
      role,
      newTickets: canManageSupport(role) ? tickets.filter((ticket) => ticket.status === "new").length : 0,
      waitingForMe: tickets.filter((ticket) => ticket.authorId === user.id && ticket.status === "waiting").length,
      ...(canManageSupport(role) ? { notifications: supportNotificationState() } : {}),
    });
  } catch (error) {
    return errorResponse(error, "Přehled podpory se nepodařilo načíst.");
  }
}

// ---------------------------------------------------------------------------------------------
// Articles
// ---------------------------------------------------------------------------------------------
function articleView(article: ArticleRecord, names: ReadonlyMap<string, string>, manager: boolean) {
  return {
    id: article.id, kind: article.kind, category: article.category, title: article.title, summary: article.summary, body: article.body,
    areaKeys: article.areaKeys, forExternal: article.forExternal, status: article.status, sortOrder: article.sortOrder, updatedAt: article.updatedAt,
    ...(manager ? { version: article.version, updatedBy: article.updatedBy ? names.get(article.updatedBy) ?? null : null, createdAt: article.createdAt } : {}),
  };
}

/** Articles the account may read (managers: every article of the app, for management). */
export async function handleArticlesList(request: NextRequest): Promise<NextResponse> {
  const decision = await authorizeSupport(request, appOf(request));
  if (decision.ok === false) return decision.response;
  const { role, appKey } = decision.support;
  try {
    const store = supportStore();
    const manager = canManageSupport(role);
    const articles = (await store.listArticles(appKey)).filter((article) => canReadArticle(role, article));
    const names = manager ? await store.accountNames(articles.flatMap((article) => (article.updatedBy ? [article.updatedBy] : []))) : new Map<string, string>();
    return NextResponse.json({ articles: articles.map((article) => articleView(article, names, manager)), role });
  } catch (error) {
    return errorResponse(error, "Návody se nepodařilo načíst.");
  }
}

function attachmentView(attachment: AttachmentRecord) {
  return { id: attachment.id, fileName: attachment.fileName, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes, kind: ATTACHMENT_TYPES[attachment.mimeType].kind, messageId: attachment.messageId };
}

export async function handleArticleGet(request: NextRequest): Promise<NextResponse> {
  const decision = await authorizeSupport(request, appOf(request));
  if (decision.ok === false) return decision.response;
  const { user, role, appKey } = decision.support;
  try {
    const store = supportStore();
    const article = await store.getArticle(param(request, "id"));
    if (!article || article.appKey !== appKey || !canReadArticle(role, article)) return notFound("Návod");
    const manager = canManageSupport(role);
    const [comments, attachments] = await Promise.all([store.listComments(article.id), store.listAttachments({ articleId: article.id })]);
    const visible = comments.filter((comment) => canReadComment(role, { hidden: comment.hidden, authorId: comment.authorId ?? "" }, user.id));
    const names = await store.accountNames([...visible.map((comment) => comment.authorId ?? ""), article.updatedBy ?? ""]);
    return NextResponse.json({
      article: articleView(article, names, manager),
      attachments: attachments.map(attachmentView),
      comments: visible.map((comment) => ({ id: comment.id, kind: comment.kind, body: comment.body, status: comment.status, ...(manager ? { hidden: comment.hidden } : {}), createdAt: comment.createdAt, author: comment.authorId ? names.get(comment.authorId) ?? "—" : "—", mine: comment.authorId === user.id })),
    });
  } catch (error) {
    return errorResponse(error, "Návod se nepodařilo načíst.");
  }
}

function parseArticleInput(body: Record<string, unknown>): Readonly<{ ok: true; article: ArticleInput }> | Readonly<{ ok: false; error: string }> {
  const kind = body.kind as ArticleKind;
  const status = body.status as ArticleStatus;
  if (!ARTICLE_KINDS.includes(kind)) return { ok: false, error: "Zvolte druh: Návod nebo FAQ." };
  if (!ARTICLE_STATUSES.includes(status)) return { ok: false, error: "Neplatný stav článku." };
  const title = text(body.title, 200).trim();
  if (!title) return { ok: false, error: "Vyplňte název." };
  const areaKeys = Array.isArray(body.areaKeys) ? [...new Set(body.areaKeys.filter(isSupportAreaKey))] : [];
  const sortOrder = Number.isInteger(body.sortOrder) ? Math.max(-10000, Math.min(10000, body.sortOrder as number)) : 0;
  const bodyText = text(body.body, 60000);
  if (typeof body.body === "string" && body.body.length > 60000) return { ok: false, error: "Obsah je příliš dlouhý (nejvýš 60 000 znaků)." };
  return { ok: true, article: { kind, status, title, category: text(body.category, 80).trim(), summary: text(body.summary, 600).trim(), body: bodyText, areaKeys, forExternal: body.forExternal === true, sortOrder } };
}

/** Attachment ids: verified uploads of this manager in this app, plus those the article already has. */
async function newArticleAttachmentIds(article: ArticleInput, articleId: string | null, support: Support): Promise<readonly string[] | string> {
  const store = supportStore();
  const referenced = referencedAttachmentIds(article.body);
  const existing = articleId ? new Set((await store.listAttachments({ articleId })).map((attachment) => attachment.id)) : new Set<string>();
  const fresh = referenced.filter((id) => !existing.has(id));
  if (existing.size + fresh.length > SUPPORT_LIMITS.articleAttachments) return `Článek může mít nejvýš ${SUPPORT_LIMITS.articleAttachments} příloh.`;
  for (const id of fresh) {
    const attachment = await store.getAttachment(id);
    if (!attachment || attachment.appKey !== support.appKey || attachment.uploadedBy !== support.user.id || attachment.status !== "verified") return "Obsah odkazuje na přílohu, která není nahraná (nebo patří jinam). Nahrajte ji znovu.";
  }
  return fresh;
}

export async function handleArticleSave(request: NextRequest): Promise<NextResponse> {
  const body = await readJson(request);
  const decision = await authorizeSupport(request, body.app);
  if (decision.ok === false) return decision.response;
  const { support } = decision;
  if (!canManageSupport(support.role)) return forbiddenResponse("Návody spravuje jen správce aplikace.");
  const parsed = parseArticleInput(body);
  if (parsed.ok === false) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const id = isUuid(body.id) ? body.id : null;
  try {
    const store = supportStore();
    if (id) {
      const current = await store.getArticle(id);
      if (!current || current.appKey !== support.appKey) return notFound("Návod");
    }
    const attachmentIds = await newArticleAttachmentIds(parsed.article, id, support);
    if (typeof attachmentIds === "string") return NextResponse.json({ error: attachmentIds, code: "attachment_not_ready" }, { status: 409 });
    const saved = await store.saveArticle({ id, appKey: support.appKey, actorId: support.user.id, expectedVersion: Number(body.expectedVersion) || 0, article: parsed.article, attachmentIds });
    if (!saved) return NextResponse.json({ error: "Článek mezitím upravil někdo jiný. Načtěte aktuální verzi a změny zopakujte.", code: "stale" }, { status: 409 });
    const article = await store.getArticle(saved);
    return NextResponse.json({ article: article ? articleView(article, new Map(), true) : null }, { status: id ? 200 : 201 });
  } catch (error) {
    return errorResponse(error, "Článek se nepodařilo uložit.");
  }
}

export async function handleArticleVersions(request: NextRequest): Promise<NextResponse> {
  const decision = await authorizeSupport(request, appOf(request));
  if (decision.ok === false) return decision.response;
  if (!canManageSupport(decision.support.role)) return forbiddenResponse("Historii návodů vidí jen správce aplikace.");
  try {
    const store = supportStore();
    const article = await store.getArticle(param(request, "id"));
    if (!article || article.appKey !== decision.support.appKey) return notFound("Návod");
    const versions = await store.listVersions(article.id);
    const names = await store.accountNames(versions.map((version) => version.createdBy ?? ""));
    return NextResponse.json({ currentVersion: article.version, versions: versions.map((version) => ({ ...version, author: version.createdBy ? names.get(version.createdBy) ?? "—" : "—" })) });
  } catch (error) {
    return errorResponse(error, "Historii se nepodařilo načíst.");
  }
}

/** Restores an older version as a NEW version (history is never rewritten). */
export async function handleArticleRestore(request: NextRequest): Promise<NextResponse> {
  const body = await readJson(request);
  const decision = await authorizeSupport(request, body.app);
  if (decision.ok === false) return decision.response;
  const { support } = decision;
  if (!canManageSupport(support.role)) return forbiddenResponse("Návody spravuje jen správce aplikace.");
  try {
    const store = supportStore();
    const article = isUuid(body.id) ? await store.getArticle(body.id) : undefined;
    if (!article || article.appKey !== support.appKey) return notFound("Návod");
    const version = (await store.listVersions(article.id)).find((entry) => entry.version === Number(body.version));
    if (!version) return notFound("Verze");
    // attachments of the old text must still belong to the article
    const owned = new Set((await store.listAttachments({ articleId: article.id })).map((attachment) => attachment.id));
    if (referencedAttachmentIds(version.snapshot.body).some((id) => !owned.has(id))) return NextResponse.json({ error: "Starší verze odkazuje na přílohu, která už u článku není.", code: "attachment_missing" }, { status: 409 });
    const saved = await store.saveArticle({ id: article.id, appKey: support.appKey, actorId: support.user.id, expectedVersion: Number(body.expectedVersion) || 0, article: version.snapshot, attachmentIds: [] });
    if (!saved) return NextResponse.json({ error: "Článek mezitím upravil někdo jiný. Načtěte aktuální verzi.", code: "stale" }, { status: 409 });
    const restored = await store.getArticle(saved);
    return NextResponse.json({ article: restored ? articleView(restored, new Map(), true) : null, restoredFrom: version.version });
  } catch (error) {
    return errorResponse(error, "Verzi se nepodařilo obnovit.");
  }
}

export async function handleCommentCreate(request: NextRequest): Promise<NextResponse> {
  const body = await readJson(request);
  const decision = await authorizeSupport(request, body.app);
  if (decision.ok === false) return decision.response;
  const { user, role, appKey } = decision.support;
  const kind = body.kind === "suggestion" ? "suggestion" : "comment";
  const message = text(body.body, 4000).trim();
  if (!message) return NextResponse.json({ error: "Napište komentář." }, { status: 400 });
  try {
    const store = supportStore();
    const article = isUuid(body.articleId) ? await store.getArticle(body.articleId) : undefined;
    if (!article || article.appKey !== appKey || !canReadArticle(role, article) || article.status !== "published") return notFound("Návod");
    const comment = await store.addComment({ articleId: article.id, authorId: user.id, kind, body: message });
    return NextResponse.json({ comment: { id: comment.id, kind: comment.kind, body: comment.body, status: comment.status, createdAt: comment.createdAt, mine: true } }, { status: 201 });
  } catch (error) {
    return errorResponse(error, "Komentář se nepodařilo uložit.");
  }
}

export async function handleCommentModerate(request: NextRequest): Promise<NextResponse> {
  const body = await readJson(request);
  const decision = await authorizeSupport(request, body.app);
  if (decision.ok === false) return decision.response;
  const { support } = decision;
  if (!canManageSupport(support.role)) return forbiddenResponse("Komentáře spravuje jen správce aplikace.");
  try {
    const store = supportStore();
    const comment = isUuid(body.commentId) ? await store.getComment(body.commentId) : undefined;
    const article = comment ? await store.getArticle(comment.articleId) : undefined;
    if (!comment || !article || article.appKey !== support.appKey) return notFound("Komentář");
    await store.moderateComment(comment.id, { ...(body.status === "resolved" || body.status === "open" ? { status: body.status } : {}), ...(typeof body.hidden === "boolean" ? { hidden: body.hidden } : {}) }, support.user.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error, "Komentář se nepodařilo upravit.");
  }
}

// ---------------------------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------------------------
function ticketSummary(ticket: TicketRecord, names: ReadonlyMap<string, string>, manager: boolean) {
  return {
    id: ticket.id, number: ticket.number, kind: ticket.kind, subject: ticket.subject, status: ticket.status, createdAt: ticket.createdAt, updatedAt: ticket.updatedAt,
    author: ticket.authorId ? names.get(ticket.authorId) ?? "—" : "—",
    ...(manager ? { authorId: ticket.authorId, assignee: ticket.assigneeId ? names.get(ticket.assigneeId) ?? "—" : null, assigneeId: ticket.assigneeId } : {}),
  };
}

/** scope=mine (everyone) or scope=all (managers: every report of the app). */
export async function handleTicketsList(request: NextRequest): Promise<NextResponse> {
  const decision = await authorizeSupport(request, appOf(request));
  if (decision.ok === false) return decision.response;
  const { user, role, appKey } = decision.support;
  const all = param(request, "scope") === "all";
  if (all && !canManageSupport(role)) return forbiddenResponse("Všechna hlášení vidí jen správce aplikace.");
  try {
    const store = supportStore();
    const tickets = await store.listTickets(appKey, all ? undefined : user.id);
    const names = await store.accountNames(tickets.flatMap((ticket) => [ticket.authorId ?? "", ticket.assigneeId ?? ""]));
    return NextResponse.json({ tickets: tickets.map((ticket) => ticketSummary(ticket, names, all)) });
  } catch (error) {
    return errorResponse(error, "Hlášení se nepodařilo načíst.");
  }
}

export async function handleTicketGet(request: NextRequest): Promise<NextResponse> {
  const decision = await authorizeSupport(request, appOf(request));
  if (decision.ok === false) return decision.response;
  const { user, role, appKey } = decision.support;
  try {
    const store = supportStore();
    const ticket = await store.getTicket(param(request, "id"));
    if (!ticket || ticket.appKey !== appKey || !canReadTicket(role, { authorId: ticket.authorId ?? "" }, user.id)) return notFound("Hlášení");
    const manager = canManageSupport(role);
    const [messages, events, attachments, admins] = await Promise.all([store.listMessages(ticket.id), store.listEvents(ticket.id), store.listAttachments({ ticketId: ticket.id }), manager ? store.activeAppAdmins(appKey) : Promise.resolve([])]);
    const shown = visibleMessages(role, messages);
    const shownIds = new Set(shown.map((message) => message.id));
    // attachments of internal notes stay on the server for non-managers
    const files = attachments.filter((attachment) => attachment.messageId === null || shownIds.has(attachment.messageId));
    const names = await store.accountNames([ticket.authorId ?? "", ticket.assigneeId ?? "", ...shown.map((message) => message.authorId ?? ""), ...events.map((event) => event.actorId ?? ""), ...events.filter((event) => event.type === "assignee").flatMap((event) => [event.fromValue ?? "", event.toValue ?? ""])]);
    let project: { id: string; name: string } | null = null;
    if (ticket.projectId && appKey === "abf") {
      const access = await authorizeProject(request, ticket.projectId, "read");
      if (access.ok) project = { id: ticket.projectId, name: (await store.projectName(ticket.projectId)) ?? ticket.projectId };
    }
    return NextResponse.json({
      ticket: { ...ticketSummary(ticket, names, manager), description: ticket.description, steps: ticket.steps, expected: ticket.expected, actual: ticket.actual, context: ticket.context, mine: ticket.authorId === user.id, project, hasProject: Boolean(ticket.projectId) },
      messages: shown.map((message) => ({ id: message.id, visibility: message.visibility, body: message.body, createdAt: message.createdAt, author: message.authorId ? names.get(message.authorId) ?? "—" : "—", mine: message.authorId === user.id })),
      events: events.map((event) => ({ id: event.id, type: event.type, from: event.type === "assignee" ? (event.fromValue ? names.get(event.fromValue) ?? "—" : null) : event.fromValue, to: event.type === "assignee" ? (event.toValue ? names.get(event.toValue) ?? "—" : null) : event.toValue, createdAt: event.createdAt, actor: event.actorId ? names.get(event.actorId) ?? "—" : "—" })),
      attachments: files.map(attachmentView),
      ...(manager ? { assignees: admins, notifications: await notificationLog(ticket.id), missingNotifications: (await missingTicketNotifications(ticket)).length } : {}),
    });
  } catch (error) {
    return errorResponse(error, "Hlášení se nepodařilo načíst.");
  }
}

/** Managers only: what was e-mailed about the report, to whom and how it went (V1-SUPPORT-02). */
async function notificationLog(ticketId: string) {
  const store = supportStore();
  const rows = await store.listNotifications(ticketId);
  const names = await store.accountNames(rows.map((row) => row.recipientId));
  return rows.map((row) => ({ id: row.id, kind: row.kind, recipient: names.get(row.recipientId) ?? "—", status: row.status, attempts: row.attempts, sentAt: row.sentAt, nextAttemptAt: row.nextAttemptAt, error: row.lastError, createdAt: row.createdAt }));
}

/** Ids of verified uploads of this account in this app (checked again in the database transaction). */
async function checkUploads(ids: unknown, support: Support, max: number, maxBytes?: number): Promise<readonly string[] | NextResponse> {
  if (ids !== undefined && !Array.isArray(ids)) return NextResponse.json({ error: "Neplatné přílohy." }, { status: 400 });
  const list = [...new Set(((ids ?? []) as unknown[]).filter(isUuid))];
  if (list.length > max) return NextResponse.json({ error: `Nejvýš ${max} příloh.` }, { status: 400 });
  let total = 0;
  for (const id of list) {
    const attachment = await supportStore().getAttachment(id);
    if (!attachment || attachment.appKey !== support.appKey || attachment.uploadedBy !== support.user.id || attachment.status !== "verified") {
      return NextResponse.json({ error: "Některá příloha není nahraná a ověřená — nahrajte ji znovu. Text hlášení zůstal zachovaný.", code: "attachment_not_ready" }, { status: 409 });
    }
    total += attachment.sizeBytes;
  }
  if (maxBytes && total > maxBytes) return NextResponse.json({ error: `Přílohy jsou dohromady větší než ${Math.round(maxBytes / 1024 / 1024)} MB.` }, { status: 400 });
  return list;
}

export async function handleTicketCreate(request: NextRequest): Promise<NextResponse> {
  const body = await readJson(request);
  const decision = await authorizeSupport(request, body.app);
  if (decision.ok === false) return decision.response;
  const { support } = decision;
  if (!isUuid(body.clientRequestId)) return NextResponse.json({ error: "Chybí identifikátor odeslání." }, { status: 400 });
  const draft = { kind: body.kind as TicketKind, subject: text(body.subject, 400), description: text(body.description, 9000), steps: text(body.steps, 9000), expected: text(body.expected, 9000), actual: text(body.actual, 9000) };
  const problem = ticketDraftProblem(draft);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  const clientRequestId = body.clientRequestId;
  const created = async (id: string) => {
    const ticket = await supportStore().getTicket(id);
    if (ticket) {
      // queued once per (event, recipient) — a repeated submission queues nothing new; sent after the response
      await queueSupportNotifications({ ticket, actorId: support.user.id, event: { type: "created" }, eventKey: `created:${ticket.id}` });
      scheduleSupportDispatch(request, [ticket.id]);
    }
    return NextResponse.json({ ticket: ticket ? { id: ticket.id, number: ticket.number, status: ticket.status } : { id } }, { status: 201 });
  };
  let attachmentIds: readonly string[];
  try {
    // a repeated submission (double click, retry after a lost answer) returns the report already created —
    // also when its attachments were attached by the first request in the meantime
    const earlier = await supportStore().findTicketByRequest(support.user.id, clientRequestId);
    if (earlier) return await created(earlier);
    const checked = await checkUploads(body.attachmentIds, support, SUPPORT_LIMITS.ticketAttachments, SUPPORT_LIMITS.ticketTotalBytes);
    if (checked instanceof NextResponse) {
      const raced = await supportStore().findTicketByRequest(support.user.id, clientRequestId);
      return raced ? await created(raced) : checked;
    }
    attachmentIds = checked;
  } catch (error) {
    return errorResponse(error, "Hlášení se nepodařilo uložit — text zůstal zachovaný, zkuste to znovu.");
  }
  let projectId: string | null = null;
  if (typeof body.projectId === "string" && body.projectId) {
    if (support.appKey !== "abf") return NextResponse.json({ error: "Zakázku lze připojit jen v ABF." }, { status: 400 });
    // linking a project needs the author's own access to it; the report never exposes the project's content
    const access = await authorizeProject(request, body.projectId, "read");
    if (access.ok === false) return NextResponse.json({ error: "K této zakázce nemáte přístup.", code: "project_forbidden" }, { status: 403 });
    projectId = body.projectId;
  }
  const context = { ...sanitizeClientContext(body.context), app: support.appKey, appVersion: appVersion() };
  try {
    const store = supportStore();
    const id = await store.createTicket({ appKey: support.appKey, authorId: support.user.id, clientRequestId, kind: draft.kind, subject: draft.subject.trim(), description: draft.description, steps: draft.kind === "bug" ? draft.steps : "", expected: draft.kind === "bug" ? draft.expected : "", actual: draft.kind === "bug" ? draft.actual : "", projectId, context, attachmentIds });
    return await created(id);
  } catch (error) {
    return errorResponse(error, "Hlášení se nepodařilo uložit — text zůstal zachovaný, zkuste to znovu.");
  }
}

export async function handleTicketReply(request: NextRequest): Promise<NextResponse> {
  const body = await readJson(request);
  const decision = await authorizeSupport(request, body.app);
  if (decision.ok === false) return decision.response;
  const { support } = decision;
  const visibility = body.visibility === "internal" ? "internal" : "public";
  if (visibility === "internal" && !canManageSupport(support.role)) return forbiddenResponse("Interní poznámky píše jen správce aplikace.");
  if (!isUuid(body.clientRequestId)) return NextResponse.json({ error: "Chybí identifikátor odeslání." }, { status: 400 });
  const message = text(body.body, 9000).trim();
  if (!message || message.length > 8000) return NextResponse.json({ error: "Napište odpověď (nejvýš 8000 znaků)." }, { status: 400 });
  try {
    const store = supportStore();
    const ticket = isUuid(body.ticketId) ? await store.getTicket(body.ticketId) : undefined;
    if (!ticket || ticket.appKey !== support.appKey || !canReadTicket(support.role, { authorId: ticket.authorId ?? "" }, support.user.id)) return notFound("Hlášení");
    const earlier = await store.findMessageByRequest(support.user.id, body.clientRequestId);
    const replied = async (messageId: string) => {
      await queueSupportNotifications({ ticket, actorId: support.user.id, event: { type: "message", visibility }, eventKey: `message:${messageId}` });
      scheduleSupportDispatch(request, [ticket.id]);
      return NextResponse.json({ messageId }, { status: 201 });
    };
    if (earlier) return await replied(earlier);
    if (ticket.status === "closed" && !canManageSupport(support.role)) return NextResponse.json({ error: "Hlášení je uzavřené. Pokud problém trvá, založte nové.", code: "closed" }, { status: 409 });
    const attachmentIds = await checkUploads(body.attachmentIds, support, SUPPORT_LIMITS.messageAttachments, SUPPORT_LIMITS.ticketTotalBytes);
    if (attachmentIds instanceof NextResponse) {
      const raced = await store.findMessageByRequest(support.user.id, body.clientRequestId);
      return raced ? await replied(raced) : attachmentIds;
    }
    const id = await store.addMessage({ ticketId: ticket.id, authorId: support.user.id, clientRequestId: body.clientRequestId, visibility, body: message, attachmentIds, authorIsReporter: ticket.authorId === support.user.id });
    return await replied(id);
  } catch (error) {
    return errorResponse(error, "Odpověď se nepodařilo uložit — text zůstal zachovaný.");
  }
}

export async function handleTicketUpdate(request: NextRequest): Promise<NextResponse> {
  const body = await readJson(request);
  const decision = await authorizeSupport(request, body.app);
  if (decision.ok === false) return decision.response;
  const { support } = decision;
  if (!canManageSupport(support.role)) return forbiddenResponse("Stav a řešitele mění jen správce aplikace.");
  try {
    const store = supportStore();
    const ticket = isUuid(body.ticketId) ? await store.getTicket(body.ticketId) : undefined;
    if (!ticket || ticket.appKey !== support.appKey) return notFound("Hlášení");
    const patch: { status?: TicketStatus; assigneeId?: string | null } = {};
    if (body.status !== undefined) {
      if (!TICKET_STATUSES.includes(body.status as TicketStatus)) return NextResponse.json({ error: "Neplatný stav." }, { status: 400 });
      if (body.status !== ticket.status && !canChangeStatus(ticket.status, body.status as TicketStatus)) return NextResponse.json({ error: "Tento přechod stavu není možný." }, { status: 400 });
      patch.status = body.status as TicketStatus;
    }
    if (body.assigneeId !== undefined) {
      if (body.assigneeId !== null && !isUuid(body.assigneeId)) return NextResponse.json({ error: "Neplatný řešitel." }, { status: 400 });
      patch.assigneeId = body.assigneeId as string | null;
    }
    const previousStatus = ticket.status;
    const written = await store.updateTicket(ticket.id, support.user.id, typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : "", patch);
    if (!written) return NextResponse.json({ error: "Hlášení se mezitím změnilo. Načtěte ho znovu.", code: "stale" }, { status: 409 });
    if (patch.status && patch.status !== previousStatus && (patch.status === "waiting" || patch.status === "resolved")) {
      // the history event of this change names the notification (one message per change)
      const change = [...(await store.listEvents(ticket.id))].reverse().find((event) => (event.type === "status" || event.type === "reopened") && event.toValue === patch.status && event.actorId === support.user.id);
      const updated = (await store.getTicket(ticket.id)) ?? ticket;
      if (change) await queueSupportNotifications({ ticket: updated, actorId: support.user.id, event: { type: "status", to: patch.status }, eventKey: `event:${change.id}` });
      else console.error("Support notifications: status event not found", JSON.stringify({ ticket: updated.number, ticketId: updated.id, status: patch.status }));
      scheduleSupportDispatch(request, [ticket.id]);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error, "Změnu hlášení se nepodařilo uložit.");
  }
}

// ---------------------------------------------------------------------------------------------
// Attachments: presign → browser PUT → verify (real size and type) → attached with the content
// ---------------------------------------------------------------------------------------------
export async function handleAttachmentPresign(request: NextRequest): Promise<NextResponse> {
  const body = await readJson(request);
  const decision = await authorizeSupport(request, body.app);
  if (decision.ok === false) return decision.response;
  const { support } = decision;
  if (body.purpose === "article" && !canManageSupport(support.role)) return forbiddenResponse("Přílohy návodů nahrává jen správce aplikace.");
  const problem = attachmentProblem(body.mimeType, body.size, body.fileName);
  if (problem) return NextResponse.json({ error: problem, code: "invalid_file" }, { status: 400 });
  const id = crypto.randomUUID();
  const fileName = safeFileName(body.fileName as string);
  const storageKey = `support/${support.appKey}/${id}/${fileName}`;
  try {
    const upload = await supportFiles().createUploadUrl({ storageKey, mimeType: body.mimeType as string, originalFileName: fileName, expiresInSeconds: UPLOAD_SECONDS });
    const attachment = await supportStore().createAttachment({ id, appKey: support.appKey, storageKey, fileName: text(body.fileName, 200), mimeType: body.mimeType as AttachmentMime, sizeBytes: body.size as number, uploadedBy: support.user.id });
    return NextResponse.json({ attachment: { id: attachment.id, fileName: attachment.fileName, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes }, upload });
  } catch (error) {
    return errorResponse(error, "Nahrání přílohy se nepodařilo připravit.");
  }
}

/** After the upload: the stored object must exist, have the declared size and a real allowed type. */
export async function handleAttachmentVerify(request: NextRequest): Promise<NextResponse> {
  const body = await readJson(request);
  const decision = await authorizeSupport(request, body.app);
  if (decision.ok === false) return decision.response;
  const { support } = decision;
  try {
    const store = supportStore();
    const attachment = isUuid(body.attachmentId) ? await store.getAttachment(body.attachmentId) : undefined;
    if (!attachment || attachment.appKey !== support.appKey || attachment.uploadedBy !== support.user.id || attachment.status === "attached") return notFound("Příloha");
    if (attachment.status === "verified") return NextResponse.json({ ok: true });
    const files = supportFiles();
    const metadata = await files.getMetadata(attachment.storageKey);
    const reject = async (reason: string) => {
      await files.deleteObject(attachment.storageKey).catch(() => undefined);
      await store.deleteAttachment(attachment.id);
      return NextResponse.json({ error: reason, code: "invalid_file" }, { status: 400 });
    };
    if (!metadata) return reject("Soubor se nenahrál. Zkuste to znovu.");
    if (metadata.contentLength !== attachment.sizeBytes) return reject("Velikost nahraného souboru nesouhlasí.");
    const sniffed = sniffAttachmentType((await files.readObjectPrefix(attachment.storageKey, 32)) ?? new Uint8Array());
    if (sniffed !== attachment.mimeType) return reject("Obsah souboru neodpovídá povolenému typu (obrázek PNG, JPEG, WebP nebo video MP4, WebM).");
    await store.markVerified(attachment.id, metadata.contentLength!);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error, "Přílohu se nepodařilo ověřit.");
  }
}

/** Removes the account's own upload that is not part of saved content yet. */
export async function handleAttachmentDiscard(request: NextRequest): Promise<NextResponse> {
  const body = await readJson(request);
  const decision = await authorizeSupport(request, body.app);
  if (decision.ok === false) return decision.response;
  try {
    const store = supportStore();
    const attachment = isUuid(body.attachmentId) ? await store.getAttachment(body.attachmentId) : undefined;
    if (!attachment || attachment.appKey !== decision.support.appKey || attachment.uploadedBy !== decision.support.user.id || attachment.status === "attached") return notFound("Příloha");
    await supportFiles().deleteObject(attachment.storageKey).catch(() => undefined);
    await store.deleteAttachment(attachment.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error, "Přílohu se nepodařilo odebrat.");
  }
}

/** Short-lived URL of an attached file — only when its article / report / message may be read. */
export async function handleAttachmentUrl(request: NextRequest): Promise<NextResponse> {
  const body = await readJson(request);
  const decision = await authorizeSupport(request, body.app);
  if (decision.ok === false) return decision.response;
  const { user, role, appKey } = decision.support;
  try {
    const store = supportStore();
    const attachment = isUuid(body.attachmentId) ? await store.getAttachment(body.attachmentId) : undefined;
    if (!attachment || attachment.appKey !== appKey || attachment.status !== "attached") return notFound("Příloha");
    let allowed = false;
    if (attachment.articleId) {
      const article = await store.getArticle(attachment.articleId);
      allowed = Boolean(article && canReadArticle(role, article));
    } else if (attachment.ticketId) {
      const ticket = await store.getTicket(attachment.ticketId);
      allowed = Boolean(ticket && canReadTicket(role, { authorId: ticket.authorId ?? "" }, user.id));
      if (allowed && attachment.messageId && !canManageSupport(role)) {
        const message = (await store.listMessages(attachment.ticketId)).find((entry) => entry.id === attachment.messageId);
        allowed = message?.visibility === "public";
      }
    }
    if (!allowed) return notFound("Příloha");
    const url = await supportFiles().getDownloadUrl(attachment.storageKey, DOWNLOAD_SECONDS, body.download === true ? attachment.fileName : undefined);
    return NextResponse.json({ url, expiresInSeconds: DOWNLOAD_SECONDS });
  } catch (error) {
    return errorResponse(error, "Přílohu se nepodařilo otevřít.");
  }
}

/**
 * Managers: queue the notifications of a report whose queueing failed (V1-SUPPORT-02). Only events
 * without any record are queued — the report itself is never created again and nobody gets a second
 * message about the same event.
 */
export async function handleNotificationsRequeue(request: NextRequest): Promise<NextResponse> {
  const body = await readJson(request);
  const decision = await authorizeSupport(request, body.app);
  if (decision.ok === false) return decision.response;
  const { role, appKey } = decision.support;
  if (!canManageSupport(role)) return forbiddenResponse("Upozornění doplňuje jen správce aplikace.");
  try {
    const ticket = isUuid(body.ticketId) ? await supportStore().getTicket(body.ticketId) : undefined;
    if (!ticket || ticket.appKey !== appKey) return notFound("Hlášení");
    const result = await requeueTicketNotifications(ticket);
    if (result.messages) scheduleSupportDispatch(request, [ticket.id]);
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, "Upozornění se nepodařilo zařadit — zkuste to znovu.");
  }
}
