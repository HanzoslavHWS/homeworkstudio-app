import type { SupabaseClient } from "@supabase/supabase-js";
import type { ArticleKind, ArticleStatus, AttachmentMime, NotificationAudience, NotificationKind, SupportAppKey, TicketKind, TicketStatus } from "../../domain/support.ts";
import { createSupabaseServerClient } from "../db/supabase.server.ts";

/**
 * V1-SUPPORT-01 — rows of the support tables. Only called by lib/support/supportApi.server.ts after
 * it decided what the signed-in account may do; this module never filters by permission itself.
 * Multi-row writes go through the database functions (one transaction each).
 */
export type ArticleRecord = Readonly<{
  id: string; appKey: SupportAppKey; kind: ArticleKind; category: string; title: string; summary: string; body: string;
  areaKeys: readonly string[]; forExternal: boolean; status: ArticleStatus; sortOrder: number; version: number;
  createdBy: string | null; updatedBy: string | null; createdAt: string; updatedAt: string; publishedAt: string | null;
}>;
export type ArticleInput = Readonly<{
  kind: ArticleKind; category: string; title: string; summary: string; body: string; areaKeys: readonly string[];
  forExternal: boolean; status: ArticleStatus; sortOrder: number;
}>;
export type ArticleVersionRecord = Readonly<{ version: number; createdAt: string; createdBy: string | null; snapshot: ArticleInput }>;
export type CommentRecord = Readonly<{ id: string; articleId: string; authorId: string | null; kind: "comment" | "suggestion"; body: string; status: "open" | "resolved"; hidden: boolean; createdAt: string }>;
export type TicketRecord = Readonly<{
  id: string; number: number; appKey: SupportAppKey; kind: TicketKind; subject: string; description: string; steps: string | null; expected: string | null; actual: string | null;
  status: TicketStatus; authorId: string | null; assigneeId: string | null; projectId: string | null; context: Record<string, unknown>; createdAt: string; updatedAt: string;
}>;
export type MessageRecord = Readonly<{ id: string; ticketId: string; authorId: string | null; visibility: "public" | "internal"; body: string; createdAt: string }>;
export type EventRecord = Readonly<{ id: string; ticketId: string; actorId: string | null; type: "created" | "status" | "reopened" | "assignee"; fromValue: string | null; toValue: string | null; createdAt: string }>;
export type AttachmentRecord = Readonly<{
  id: string; appKey: SupportAppKey; storageKey: string; fileName: string; mimeType: AttachmentMime; sizeBytes: number; status: "pending" | "verified" | "attached";
  articleId: string | null; ticketId: string | null; messageId: string | null; uploadedBy: string | null; createdAt: string;
}>;
export type AccountName = Readonly<{ id: string; name: string }>;
/** V1-SUPPORT-02 outbox row (no e-mail address: it is read from the account at sending time). */
export type NotificationStatus = "pending" | "sending" | "sent" | "failed" | "skipped";
export type NotificationRecord = Readonly<{
  id: string; appKey: SupportAppKey; ticketId: string; recipientId: string; eventKey: string; kind: NotificationKind; audience: NotificationAudience;
  status: NotificationStatus; attempts: number; nextAttemptAt: string | null; lastError: string | null; sentAt: string | null; createdAt: string;
}>;
export type NotificationInput = Readonly<{ appKey: SupportAppKey; ticketId: string; recipientId: string; eventKey: string; kind: NotificationKind; audience: NotificationAudience; status?: "pending" | "skipped"; lastError?: string }>;

export class SupportConflictError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SupportConflictError";
    this.code = code;
  }
}

export interface SupportStore {
  listArticles(appKey: SupportAppKey): Promise<readonly ArticleRecord[]>;
  getArticle(id: string): Promise<ArticleRecord | undefined>;
  /** null = stale expectedVersion (concurrent edit), nothing written. */
  saveArticle(input: Readonly<{ id: string | null; appKey: SupportAppKey; actorId: string; expectedVersion: number; article: ArticleInput; attachmentIds: readonly string[] }>): Promise<string | null>;
  listVersions(articleId: string): Promise<readonly ArticleVersionRecord[]>;
  listComments(articleId: string): Promise<readonly CommentRecord[]>;
  getComment(id: string): Promise<CommentRecord | undefined>;
  addComment(input: Readonly<{ articleId: string; authorId: string; kind: "comment" | "suggestion"; body: string }>): Promise<CommentRecord>;
  moderateComment(id: string, patch: Readonly<{ status?: "open" | "resolved"; hidden?: boolean }>, actorId: string): Promise<void>;
  listTickets(appKey: SupportAppKey, authorId?: string): Promise<readonly TicketRecord[]>;
  getTicket(id: string): Promise<TicketRecord | undefined>;
  /** Idempotency: the report / reply an account already created with this submission id. */
  findTicketByRequest(authorId: string, clientRequestId: string): Promise<string | undefined>;
  findMessageByRequest(authorId: string, clientRequestId: string): Promise<string | undefined>;
  createTicket(input: Readonly<{ appKey: SupportAppKey; authorId: string; clientRequestId: string; kind: TicketKind; subject: string; description: string; steps: string; expected: string; actual: string; projectId: string | null; context: Record<string, unknown>; attachmentIds: readonly string[] }>): Promise<string>;
  addMessage(input: Readonly<{ ticketId: string; authorId: string; clientRequestId: string; visibility: "public" | "internal"; body: string; attachmentIds: readonly string[]; authorIsReporter: boolean }>): Promise<string>;
  listMessages(ticketId: string): Promise<readonly MessageRecord[]>;
  listEvents(ticketId: string): Promise<readonly EventRecord[]>;
  updateTicket(id: string, actorId: string, expectedUpdatedAt: string, patch: Readonly<{ status?: TicketStatus; assigneeId?: string | null }>): Promise<boolean>;
  createAttachment(input: Readonly<{ id: string; appKey: SupportAppKey; storageKey: string; fileName: string; mimeType: AttachmentMime; sizeBytes: number; uploadedBy: string }>): Promise<AttachmentRecord>;
  getAttachment(id: string): Promise<AttachmentRecord | undefined>;
  markVerified(id: string, sizeBytes: number): Promise<void>;
  deleteAttachment(id: string): Promise<void>;
  listAttachments(owner: Readonly<{ articleId?: string; ticketId?: string }>): Promise<readonly AttachmentRecord[]>;
  /** Not attached and older than the cutoff — never anything attached to saved content. */
  staleAttachments(olderThan: Date): Promise<readonly AttachmentRecord[]>;
  activeAppAdmins(appKey: SupportAppKey): Promise<readonly AccountName[]>;
  /** Queues messages; an (event, recipient) pair already queued is left as it is (no duplicates on a repeated request). */
  enqueueNotifications(rows: readonly NotificationInput[]): Promise<void>;
  /** Due messages for ONE sender (database row locks — concurrent senders never take the same row). */
  claimNotifications(limit: number, ticketIds?: readonly string[]): Promise<readonly NotificationRecord[]>;
  finishNotification(id: string, result: Readonly<{ status: "sent" | "failed" | "skipped"; lastError?: string | null; nextAttemptAt?: string | null }>): Promise<void>;
  listNotifications(ticketId: string): Promise<readonly NotificationRecord[]>;
  accountNames(ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
  projectName(projectId: string): Promise<string | undefined>;
}

const isMissingSchema = (error: unknown) => ["42P01", "PGRST205", "PGRST200", "PGRST202", "42703", "42883"].includes((error as { code?: string } | null)?.code ?? "");

export class SupportSchemaNotMigratedError extends Error {
  constructor() {
    super("Databáze nemá tabulky podpory (migrace 20261111120000_app_support).");
    this.name = "SupportSchemaNotMigratedError";
  }
}

function fail(error: unknown): never {
  if (isMissingSchema(error)) throw new SupportSchemaNotMigratedError();
  const message = String((error as { message?: string } | null)?.message ?? "");
  if (message.includes("ATTACHMENT_NOT_READY")) throw new SupportConflictError("attachment_not_ready", "Některá příloha není nahraná a ověřená — nahrajte ji znovu.");
  if (message.includes("INVALID_ASSIGNEE")) throw new SupportConflictError("invalid_assignee", "Řešitelem může být jen aktivní správce aplikace.");
  if (message.includes("TICKET_NOT_FOUND")) throw new SupportConflictError("not_found", "Hlášení neexistuje.");
  throw error instanceof Error ? error : new Error(message || "Databázová chyba podpory.");
}

type ArticleRow = { id: string; app_key: SupportAppKey; kind: ArticleKind; category: string; title: string; summary: string; body: string; area_keys: string[]; for_external: boolean; status: ArticleStatus; sort_order: number; version: number; created_by: string | null; updated_by: string | null; created_at: string; updated_at: string; published_at: string | null };
const toArticle = (row: ArticleRow): ArticleRecord => ({ id: row.id, appKey: row.app_key, kind: row.kind, category: row.category, title: row.title, summary: row.summary, body: row.body, areaKeys: row.area_keys ?? [], forExternal: row.for_external, status: row.status, sortOrder: row.sort_order, version: row.version, createdBy: row.created_by, updatedBy: row.updated_by, createdAt: row.created_at, updatedAt: row.updated_at, publishedAt: row.published_at });
type TicketRow = { id: string; number: number; app_key: SupportAppKey; kind: TicketKind; subject: string; description: string; steps: string | null; expected: string | null; actual: string | null; status: TicketStatus; author_id: string | null; assignee_id: string | null; project_id: string | null; context: Record<string, unknown>; created_at: string; updated_at: string };
const toTicket = (row: TicketRow): TicketRecord => ({ id: row.id, number: Number(row.number), appKey: row.app_key, kind: row.kind, subject: row.subject, description: row.description, steps: row.steps, expected: row.expected, actual: row.actual, status: row.status, authorId: row.author_id, assigneeId: row.assignee_id, projectId: row.project_id, context: row.context ?? {}, createdAt: row.created_at, updatedAt: row.updated_at });
type AttachmentRow = { id: string; app_key: SupportAppKey; storage_key: string; file_name: string; mime_type: AttachmentMime; size_bytes: number; status: "pending" | "verified" | "attached"; article_id: string | null; ticket_id: string | null; message_id: string | null; uploaded_by: string | null; created_at: string };
const toAttachment = (row: AttachmentRow): AttachmentRecord => ({ id: row.id, appKey: row.app_key, storageKey: row.storage_key, fileName: row.file_name, mimeType: row.mime_type, sizeBytes: Number(row.size_bytes), status: row.status, articleId: row.article_id, ticketId: row.ticket_id, messageId: row.message_id, uploadedBy: row.uploaded_by, createdAt: row.created_at });
type NotificationRow = { id: string; app_key: SupportAppKey; ticket_id: string; recipient_id: string; event_key: string; kind: NotificationKind; audience: NotificationAudience; status: NotificationStatus; attempts: number; next_attempt_at: string | null; last_error: string | null; sent_at: string | null; created_at: string };
const toNotification = (row: NotificationRow): NotificationRecord => ({ id: row.id, appKey: row.app_key, ticketId: row.ticket_id, recipientId: row.recipient_id, eventKey: row.event_key, kind: row.kind, audience: row.audience, status: row.status, attempts: row.attempts, nextAttemptAt: row.next_attempt_at, lastError: row.last_error, sentAt: row.sent_at, createdAt: row.created_at });
const NOTIFICATION_COLUMNS = "id, app_key, ticket_id, recipient_id, event_key, kind, audience, status, attempts, next_attempt_at, last_error, sent_at, created_at";
type CommentRow = { id: string; article_id: string; author_id: string | null; kind: "comment" | "suggestion"; body: string; status: "open" | "resolved"; hidden: boolean; created_at: string };
const toComment = (row: CommentRow): CommentRecord => ({ id: row.id, articleId: row.article_id, authorId: row.author_id, kind: row.kind, body: row.body, status: row.status, hidden: row.hidden, createdAt: row.created_at });

const ARTICLE_COLUMNS = "id, app_key, kind, category, title, summary, body, area_keys, for_external, status, sort_order, version, created_by, updated_by, created_at, updated_at, published_at";
const TICKET_COLUMNS = "id, number, app_key, kind, subject, description, steps, expected, actual, status, author_id, assignee_id, project_id, context, created_at, updated_at";
const ATTACHMENT_COLUMNS = "id, app_key, storage_key, file_name, mime_type, size_bytes, status, article_id, ticket_id, message_id, uploaded_by, created_at";
const COMMENT_COLUMNS = "id, article_id, author_id, kind, body, status, hidden, created_at";

export class SupabaseSupportStore implements SupportStore {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async listArticles(appKey: SupportAppKey) {
    const { data, error } = await this.client.from("support_articles").select(ARTICLE_COLUMNS).eq("app_key", appKey).order("sort_order").order("title");
    if (error) fail(error);
    return ((data ?? []) as ArticleRow[]).map(toArticle);
  }

  async getArticle(id: string) {
    const { data, error } = await this.client.from("support_articles").select(ARTICLE_COLUMNS).eq("id", id).maybeSingle();
    if (error) fail(error);
    return data ? toArticle(data as ArticleRow) : undefined;
  }

  async saveArticle(input: Parameters<SupportStore["saveArticle"]>[0]) {
    const { article } = input;
    const { data, error } = await this.client.rpc("support_save_article", {
      p_article: input.id, p_app: input.appKey, p_actor: input.actorId, p_expected_version: input.expectedVersion, p_kind: article.kind, p_category: article.category,
      p_title: article.title, p_summary: article.summary, p_body: article.body, p_area_keys: article.areaKeys, p_for_external: article.forExternal,
      p_status: article.status, p_sort_order: article.sortOrder, p_attachment_ids: input.attachmentIds,
    });
    if (error) fail(error);
    return (data as string | null) ?? null;
  }

  async listVersions(articleId: string) {
    const { data, error } = await this.client.from("support_article_versions").select("version, created_at, created_by, snapshot").eq("article_id", articleId).order("version", { ascending: false });
    if (error) fail(error);
    return ((data ?? []) as { version: number; created_at: string; created_by: string | null; snapshot: ArticleInput }[]).map((row) => ({ version: row.version, createdAt: row.created_at, createdBy: row.created_by, snapshot: row.snapshot }));
  }

  async listComments(articleId: string) {
    const { data, error } = await this.client.from("support_article_comments").select(COMMENT_COLUMNS).eq("article_id", articleId).order("created_at");
    if (error) fail(error);
    return ((data ?? []) as CommentRow[]).map(toComment);
  }

  async getComment(id: string) {
    const { data, error } = await this.client.from("support_article_comments").select(COMMENT_COLUMNS).eq("id", id).maybeSingle();
    if (error) fail(error);
    return data ? toComment(data as CommentRow) : undefined;
  }

  async addComment(input: Readonly<{ articleId: string; authorId: string; kind: "comment" | "suggestion"; body: string }>) {
    const { data, error } = await this.client.from("support_article_comments").insert({ article_id: input.articleId, author_id: input.authorId, kind: input.kind, body: input.body }).select(COMMENT_COLUMNS).single();
    if (error) fail(error);
    return toComment(data as CommentRow);
  }

  async moderateComment(id: string, patch: Readonly<{ status?: "open" | "resolved"; hidden?: boolean }>, actorId: string) {
    const { error } = await this.client.from("support_article_comments").update({ ...(patch.status ? { status: patch.status } : {}), ...(patch.hidden !== undefined ? { hidden: patch.hidden } : {}), moderated_by: actorId }).eq("id", id);
    if (error) fail(error);
  }

  async listTickets(appKey: SupportAppKey, authorId?: string) {
    let query = this.client.from("support_tickets").select(TICKET_COLUMNS).eq("app_key", appKey).order("updated_at", { ascending: false });
    if (authorId) query = query.eq("author_id", authorId);
    const { data, error } = await query;
    if (error) fail(error);
    return ((data ?? []) as TicketRow[]).map(toTicket);
  }

  async getTicket(id: string) {
    const { data, error } = await this.client.from("support_tickets").select(TICKET_COLUMNS).eq("id", id).maybeSingle();
    if (error) fail(error);
    return data ? toTicket(data as TicketRow) : undefined;
  }

  async findTicketByRequest(authorId: string, clientRequestId: string) {
    const { data, error } = await this.client.from("support_tickets").select("id").eq("author_id", authorId).eq("client_request_id", clientRequestId).maybeSingle();
    if (error) fail(error);
    return (data as { id: string } | null)?.id;
  }

  async findMessageByRequest(authorId: string, clientRequestId: string) {
    const { data, error } = await this.client.from("support_ticket_messages").select("id").eq("author_id", authorId).eq("client_request_id", clientRequestId).maybeSingle();
    if (error) fail(error);
    return (data as { id: string } | null)?.id;
  }

  async createTicket(input: Parameters<SupportStore["createTicket"]>[0]) {
    const { data, error } = await this.client.rpc("support_create_ticket", {
      p_app: input.appKey, p_author: input.authorId, p_client_request_id: input.clientRequestId, p_kind: input.kind, p_subject: input.subject, p_description: input.description,
      p_steps: input.steps, p_expected: input.expected, p_actual: input.actual, p_project_id: input.projectId, p_context: input.context, p_attachment_ids: input.attachmentIds,
    });
    if (error) fail(error);
    return data as string;
  }

  async addMessage(input: Parameters<SupportStore["addMessage"]>[0]) {
    const { data, error } = await this.client.rpc("support_add_message", {
      p_ticket: input.ticketId, p_author: input.authorId, p_client_request_id: input.clientRequestId, p_visibility: input.visibility, p_body: input.body,
      p_attachment_ids: input.attachmentIds, p_author_is_reporter: input.authorIsReporter,
    });
    if (error) fail(error);
    return data as string;
  }

  async listMessages(ticketId: string) {
    const { data, error } = await this.client.from("support_ticket_messages").select("id, ticket_id, author_id, visibility, body, created_at").eq("ticket_id", ticketId).order("created_at");
    if (error) fail(error);
    return ((data ?? []) as { id: string; ticket_id: string; author_id: string | null; visibility: "public" | "internal"; body: string; created_at: string }[]).map((row) => ({ id: row.id, ticketId: row.ticket_id, authorId: row.author_id, visibility: row.visibility, body: row.body, createdAt: row.created_at }));
  }

  async listEvents(ticketId: string) {
    const { data, error } = await this.client.from("support_ticket_events").select("id, ticket_id, actor_id, type, from_value, to_value, created_at").eq("ticket_id", ticketId).order("created_at");
    if (error) fail(error);
    return ((data ?? []) as { id: string; ticket_id: string; actor_id: string | null; type: EventRecord["type"]; from_value: string | null; to_value: string | null; created_at: string }[]).map((row) => ({ id: row.id, ticketId: row.ticket_id, actorId: row.actor_id, type: row.type, fromValue: row.from_value, toValue: row.to_value, createdAt: row.created_at }));
  }

  async updateTicket(id: string, actorId: string, expectedUpdatedAt: string, patch: Readonly<{ status?: TicketStatus; assigneeId?: string | null }>) {
    const { data, error } = await this.client.rpc("support_update_ticket", {
      p_ticket: id, p_actor: actorId, p_expected_updated_at: expectedUpdatedAt, p_set_status: patch.status !== undefined, p_status: patch.status ?? null,
      p_set_assignee: patch.assigneeId !== undefined, p_assignee: patch.assigneeId ?? null,
    });
    if (error) fail(error);
    return data === true;
  }

  async createAttachment(input: Parameters<SupportStore["createAttachment"]>[0]) {
    const { data, error } = await this.client.from("support_attachments").insert({ id: input.id, app_key: input.appKey, storage_key: input.storageKey, file_name: input.fileName, mime_type: input.mimeType, size_bytes: input.sizeBytes, uploaded_by: input.uploadedBy }).select(ATTACHMENT_COLUMNS).single();
    if (error) fail(error);
    return toAttachment(data as AttachmentRow);
  }

  async getAttachment(id: string) {
    const { data, error } = await this.client.from("support_attachments").select(ATTACHMENT_COLUMNS).eq("id", id).maybeSingle();
    if (error) fail(error);
    return data ? toAttachment(data as AttachmentRow) : undefined;
  }

  async markVerified(id: string, sizeBytes: number) {
    const { error } = await this.client.from("support_attachments").update({ status: "verified", size_bytes: sizeBytes }).eq("id", id).eq("status", "pending");
    if (error) fail(error);
  }

  async deleteAttachment(id: string) {
    const { error } = await this.client.from("support_attachments").delete().eq("id", id).neq("status", "attached");
    if (error) fail(error);
  }

  async listAttachments(owner: Readonly<{ articleId?: string; ticketId?: string }>) {
    let query = this.client.from("support_attachments").select(ATTACHMENT_COLUMNS).eq("status", "attached").order("created_at");
    query = owner.articleId ? query.eq("article_id", owner.articleId) : query.eq("ticket_id", owner.ticketId ?? "");
    const { data, error } = await query;
    if (error) fail(error);
    return ((data ?? []) as AttachmentRow[]).map(toAttachment);
  }

  async staleAttachments(olderThan: Date) {
    const { data, error } = await this.client.from("support_attachments").select(ATTACHMENT_COLUMNS).neq("status", "attached").lt("created_at", olderThan.toISOString());
    if (error) fail(error);
    return ((data ?? []) as AttachmentRow[]).map(toAttachment);
  }

  async activeAppAdmins(appKey: SupportAppKey) {
    const { data, error } = await this.client.from("app_memberships").select("user_id, app_users!app_memberships_user_id_fkey (id, email, display_name, is_active)").eq("app_key", appKey).eq("role", "admin");
    if (error) fail(error);
    return ((data ?? []) as unknown as { app_users: { id: string; email: string; display_name: string | null; is_active: boolean } | null }[])
      .flatMap((row) => (row.app_users?.is_active ? [{ id: row.app_users.id, name: row.app_users.display_name || row.app_users.email }] : []))
      .sort((a, b) => a.name.localeCompare(b.name, "cs"));
  }

  async enqueueNotifications(rows: readonly NotificationInput[]) {
    if (!rows.length) return;
    const { error } = await this.client.from("support_notifications").upsert(
      rows.map((row) => ({
        app_key: row.appKey, ticket_id: row.ticketId, recipient_id: row.recipientId, event_key: row.eventKey, kind: row.kind, audience: row.audience,
        status: row.status ?? "pending", last_error: row.lastError ?? null, next_attempt_at: row.status === "skipped" ? null : new Date().toISOString(),
      })),
      { onConflict: "event_key,recipient_id", ignoreDuplicates: true },
    );
    if (error) fail(error);
  }

  async claimNotifications(limit: number, ticketIds?: readonly string[]) {
    const { data, error } = await this.client.rpc("support_claim_notifications", { p_limit: limit, p_ticket_ids: ticketIds?.length ? ticketIds : null });
    if (error) fail(error);
    return ((data ?? []) as NotificationRow[]).map(toNotification);
  }

  async finishNotification(id: string, result: Parameters<SupportStore["finishNotification"]>[1]) {
    const { error } = await this.client.from("support_notifications").update({
      status: result.status, last_error: result.lastError ?? null, locked_until: null,
      next_attempt_at: result.status === "failed" ? result.nextAttemptAt ?? null : null,
      ...(result.status === "sent" ? { sent_at: new Date().toISOString() } : {}),
    }).eq("id", id);
    if (error) fail(error);
  }

  async listNotifications(ticketId: string) {
    const { data, error } = await this.client.from("support_notifications").select(NOTIFICATION_COLUMNS).eq("ticket_id", ticketId).order("created_at");
    if (error) fail(error);
    return ((data ?? []) as NotificationRow[]).map(toNotification);
  }

  async accountNames(ids: readonly string[]) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map<string, string>();
    const { data, error } = await this.client.from("app_users").select("id, email, display_name").in("id", unique);
    if (error) fail(error);
    return new Map(((data ?? []) as { id: string; email: string; display_name: string | null }[]).map((row) => [row.id, row.display_name || row.email]));
  }

  async projectName(projectId: string) {
    const { data, error } = await this.client.from("projects").select("id, document").eq("id", projectId).maybeSingle();
    if (error) fail(error);
    return data ? ((data as { document: { name?: string } | null }).document?.name || projectId) : undefined;
  }
}

let override: SupportStore | undefined;
export function supportStore(): SupportStore {
  return override ?? new SupabaseSupportStore(createSupabaseServerClient());
}
/** Tests only (in-memory double with the same contract). */
export function setSupportStoreForTesting(store: SupportStore | undefined): void {
  override = store;
}
