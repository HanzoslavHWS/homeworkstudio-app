import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server.js";
import {
  applyImageEdits,
  articleMatches,
  canReadArticle,
  hasRedaction,
  nextNotificationAttempt,
  planNotifications,
  selectCleanup,
  parseArticleBody,
  safeContextPath,
  sanitizeClientContext,
  sniffAttachmentType,
  supportRoleOf,
  videoEmbedOf,
  type SupportAppKey,
} from "../domain/support.ts";
import { normalizeSupportRoute, parseWorkspaceHash, workspaceHash } from "../domain/adminNavigation.ts";
import { canOpenSection } from "../domain/accessControl.ts";
import {
  handleArticleGet,
  handleArticleRestore,
  handleArticleSave,
  handleArticlesList,
  handleArticleVersions,
  handleAttachmentDiscard,
  handleAttachmentPresign,
  handleAttachmentUrl,
  handleAttachmentVerify,
  handleCommentCreate,
  handleCommentModerate,
  handleNotificationsRequeue,
  handleSupportSummary,
  handleTicketCreate,
  handleTicketGet,
  handleTicketReply,
  handleTicketsList,
  handleTicketUpdate,
} from "../lib/support/supportApi.server.ts";
import { setSupportFilesForTesting, type SupportFiles } from "../lib/support/supportFiles.server.ts";
import {
  SupportConflictError,
  setSupportStoreForTesting,
  type ArticleInput,
  type ArticleRecord,
  type ArticleVersionRecord,
  type AttachmentRecord,
  type CommentRecord,
  type EventRecord,
  type MessageRecord,
  type SupportStore,
  type TicketRecord,
  type NotificationInput,
  type NotificationRecord,
} from "../lib/support/supportStore.supabase.ts";
import { dispatchSupportNotifications, handleNotificationsDispatch, setSupportMailerForTesting, setSupportSchedulerForTesting } from "../lib/support/supportNotifications.server.ts";

import { createTestSession, testAuthStore, type MemoryAuthStore } from "./helpers/testAuth.ts";
import { InvitationSendError } from "../lib/accounts/invitationMailer.server.ts";

const SECRET = "test-session-secret-with-at-least-32-characters";
process.env.APP_SESSION_SECRET = SECRET;
// links in support e-mails are built for a local DEV app (lib/auth/supabaseAuth.server.ts appBaseUrl)
process.env.NEXT_PUBLIC_APP_ENV = "development";
delete process.env.APP_BASE_URL;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;
const auth = testAuthStore();
const ORIGIN = "http://localhost:3000";

// =============================================================================================
// In-memory doubles with the contract of the database functions (supabase/migrations/20261111120000_app_support.sql)
// =============================================================================================
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
let clock = Date.parse("2026-11-10T10:00:00Z");
const now = () => new Date((clock += 1000)).toISOString();

class MemorySupportStore implements SupportStore {
  articles = new Map<string, Mutable<ArticleRecord>>();
  versions = new Map<string, ArticleVersionRecord[]>();
  comments = new Map<string, Mutable<CommentRecord>>();
  tickets = new Map<string, Mutable<TicketRecord> & { clientRequestId: string }>();
  messages = new Map<string, MessageRecord & { clientRequestId: string }>();
  events: EventRecord[] = [];
  attachments = new Map<string, Mutable<AttachmentRecord>>();
  number = 0;
  failNextWrite = false;
  private readonly users: MemoryAuthStore;
  constructor(users: MemoryAuthStore) {
    this.users = users;
  }

  private maybeFail() {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("simulated database failure");
    }
  }
  /** support_attach: every id a VERIFIED upload of this account in this app — or the whole write fails. */
  private attach(appKey: SupportAppKey, uploader: string, ids: readonly string[], owner: Partial<Pick<AttachmentRecord, "articleId" | "ticketId" | "messageId">>) {
    for (const id of ids) {
      const attachment = this.attachments.get(id);
      if (!attachment || attachment.appKey !== appKey || attachment.uploadedBy !== uploader || attachment.status !== "verified") throw new SupportConflictError("attachment_not_ready", "ATTACHMENT_NOT_READY");
    }
    for (const id of ids) Object.assign(this.attachments.get(id)!, { status: "attached", articleId: owner.articleId ?? null, ticketId: owner.ticketId ?? null, messageId: owner.messageId ?? null });
  }

  async listArticles(appKey: SupportAppKey) {
    return [...this.articles.values()].filter((article) => article.appKey === appKey);
  }
  async getArticle(id: string) {
    return this.articles.get(id);
  }
  async saveArticle(input: Parameters<SupportStore["saveArticle"]>[0]) {
    this.maybeFail();
    const time = now();
    let article: Mutable<ArticleRecord>;
    if (input.id === null) {
      article = { id: randomUUID(), appKey: input.appKey, ...input.article, version: 1, createdBy: input.actorId, updatedBy: input.actorId, createdAt: time, updatedAt: time, publishedAt: null };
    } else {
      const current = this.articles.get(input.id);
      if (!current || current.version !== input.expectedVersion) return null;
      article = { ...current, ...input.article, version: current.version + 1, updatedBy: input.actorId, updatedAt: time };
    }
    if (input.article.status === "published" && !article.publishedAt) article.publishedAt = time;
    this.attach(input.appKey, input.actorId, input.attachmentIds, { articleId: article.id });
    this.articles.set(article.id, article);
    this.versions.set(article.id, [{ version: article.version, createdAt: time, createdBy: input.actorId, snapshot: { ...input.article } }, ...(this.versions.get(article.id) ?? [])]);
    return article.id;
  }
  async listVersions(articleId: string) {
    return this.versions.get(articleId) ?? [];
  }
  async listComments(articleId: string) {
    return [...this.comments.values()].filter((comment) => comment.articleId === articleId);
  }
  async getComment(id: string) {
    return this.comments.get(id);
  }
  async addComment(input: Parameters<SupportStore["addComment"]>[0]) {
    const comment: Mutable<CommentRecord> = { id: randomUUID(), articleId: input.articleId, authorId: input.authorId, kind: input.kind, body: input.body, status: "open", hidden: false, createdAt: now() };
    this.comments.set(comment.id, comment);
    return comment;
  }
  async moderateComment(id: string, patch: Readonly<{ status?: "open" | "resolved"; hidden?: boolean }>) {
    Object.assign(this.comments.get(id)!, patch);
  }
  async listTickets(appKey: SupportAppKey, authorId?: string) {
    return [...this.tickets.values()].filter((ticket) => ticket.appKey === appKey && (authorId === undefined || ticket.authorId === authorId));
  }
  async getTicket(id: string) {
    return this.tickets.get(id);
  }
  async findTicketByRequest(authorId: string, clientRequestId: string) {
    return [...this.tickets.values()].find((ticket) => ticket.authorId === authorId && ticket.clientRequestId === clientRequestId)?.id;
  }
  async findMessageByRequest(authorId: string, clientRequestId: string) {
    return [...this.messages.values()].find((message) => message.authorId === authorId && message.clientRequestId === clientRequestId)?.id;
  }
  async createTicket(input: Parameters<SupportStore["createTicket"]>[0]) {
    const existing = [...this.tickets.values()].find((ticket) => ticket.authorId === input.authorId && ticket.clientRequestId === input.clientRequestId);
    if (existing) return existing.id;
    this.maybeFail();
    const time = now();
    const ticket = { id: randomUUID(), number: ++this.number, appKey: input.appKey, kind: input.kind, subject: input.subject, description: input.description, steps: input.steps || null, expected: input.expected || null, actual: input.actual || null, status: "new" as const, authorId: input.authorId, assigneeId: null, projectId: input.projectId, context: input.context, createdAt: time, updatedAt: time, clientRequestId: input.clientRequestId };
    this.attach(input.appKey, input.authorId, input.attachmentIds, { ticketId: ticket.id });
    this.tickets.set(ticket.id, ticket);
    this.events.push({ id: randomUUID(), ticketId: ticket.id, actorId: input.authorId, type: "created", fromValue: null, toValue: "new", createdAt: time });
    return ticket.id;
  }
  async addMessage(input: Parameters<SupportStore["addMessage"]>[0]) {
    const existing = [...this.messages.values()].find((message) => message.authorId === input.authorId && message.clientRequestId === input.clientRequestId);
    if (existing) return existing.id;
    this.maybeFail();
    const ticket = this.tickets.get(input.ticketId)!;
    const message = { id: randomUUID(), ticketId: ticket.id, authorId: input.authorId, visibility: input.visibility, body: input.body, createdAt: now(), clientRequestId: input.clientRequestId };
    this.attach(ticket.appKey, input.authorId, input.attachmentIds, { ticketId: ticket.id, messageId: message.id });
    this.messages.set(message.id, message);
    if (input.authorIsReporter && input.visibility === "public" && ticket.status === "waiting") {
      this.events.push({ id: randomUUID(), ticketId: ticket.id, actorId: input.authorId, type: "status", fromValue: "waiting", toValue: "in_progress", createdAt: message.createdAt });
      ticket.status = "in_progress";
    }
    ticket.updatedAt = now();
    return message.id;
  }
  async listMessages(ticketId: string) {
    return [...this.messages.values()].filter((message) => message.ticketId === ticketId);
  }
  async listEvents(ticketId: string) {
    return this.events.filter((event) => event.ticketId === ticketId);
  }
  async updateTicket(id: string, actorId: string, expectedUpdatedAt: string, patch: Readonly<{ status?: import("../domain/support.ts").TicketStatus; assigneeId?: string | null }>) {
    const ticket = this.tickets.get(id)!;
    if (ticket.updatedAt !== expectedUpdatedAt) return false;
    if (patch.assigneeId && !(await this.activeAppAdmins(ticket.appKey)).some((admin) => admin.id === patch.assigneeId)) throw new SupportConflictError("invalid_assignee", "INVALID_ASSIGNEE");
    const time = now();
    if (patch.status !== undefined && patch.status !== ticket.status) {
      const reopened = (ticket.status === "resolved" || ticket.status === "closed") && patch.status === "in_progress";
      this.events.push({ id: randomUUID(), ticketId: id, actorId, type: reopened ? "reopened" : "status", fromValue: ticket.status, toValue: patch.status, createdAt: time });
      ticket.status = patch.status;
    }
    if (patch.assigneeId !== undefined && patch.assigneeId !== ticket.assigneeId) {
      this.events.push({ id: randomUUID(), ticketId: id, actorId, type: "assignee", fromValue: ticket.assigneeId, toValue: patch.assigneeId, createdAt: time });
      ticket.assigneeId = patch.assigneeId;
    }
    ticket.updatedAt = time;
    return true;
  }
  async createAttachment(input: Parameters<SupportStore["createAttachment"]>[0]) {
    const attachment: Mutable<AttachmentRecord> = { ...input, status: "pending", articleId: null, ticketId: null, messageId: null, createdAt: now() };
    this.attachments.set(attachment.id, attachment);
    return attachment;
  }
  async getAttachment(id: string) {
    return this.attachments.get(id);
  }
  async markVerified(id: string, sizeBytes: number) {
    Object.assign(this.attachments.get(id)!, { status: "verified", sizeBytes });
  }
  async deleteAttachment(id: string) {
    if (this.attachments.get(id)?.status !== "attached") this.attachments.delete(id);
  }
  async listAttachments(owner: Readonly<{ articleId?: string; ticketId?: string }>) {
    return [...this.attachments.values()].filter((attachment) => attachment.status === "attached" && ((owner.articleId && attachment.articleId === owner.articleId) || (owner.ticketId && attachment.ticketId === owner.ticketId)));
  }
  async staleAttachments(olderThan: Date) {
    return [...this.attachments.values()].filter((attachment) => attachment.status !== "attached" && Date.parse(attachment.createdAt) < olderThan.getTime());
  }
  async activeAppAdmins(appKey: SupportAppKey) {
    return [...this.users.users.values()].filter((user) => user.isActive && user.apps[appKey] === "admin").map((user) => ({ id: user.id, name: user.displayName ?? user.email }));
  }
  async accountNames(ids: readonly string[]) {
    return new Map([...this.users.users.values()].filter((user) => ids.includes(user.id)).map((user) => [user.id, user.displayName ?? user.email] as [string, string]));
  }
  async projectName(projectId: string) {
    return `Zakázka ${projectId}`;
  }
  // --- V1-SUPPORT-02 outbox (same rules as support_notifications + support_claim_notifications)
  notifications = new Map<string, Mutable<NotificationRecord> & { lockedUntil: string | null }>();
  failQueue = false;
  async enqueueNotifications(rows: readonly NotificationInput[]) {
    if (this.failQueue) throw new Error("simulated queue failure");
    for (const row of rows) {
      if ([...this.notifications.values()].some((entry) => entry.eventKey === row.eventKey && entry.recipientId === row.recipientId)) continue;
      const id = randomUUID();
      this.notifications.set(id, { id, appKey: row.appKey, ticketId: row.ticketId, recipientId: row.recipientId, eventKey: row.eventKey, kind: row.kind, audience: row.audience, status: row.status ?? "pending", attempts: 0, nextAttemptAt: row.status === "skipped" ? null : new Date(clock).toISOString(), lastError: row.lastError ?? null, sentAt: null, createdAt: now(), lockedUntil: null });
    }
  }
  async claimNotifications(limit: number, ticketIds?: readonly string[]) {
    const due = [...this.notifications.values()].filter((entry) => ((entry.status === "pending" || entry.status === "failed") && entry.nextAttemptAt !== null && Date.parse(entry.nextAttemptAt) <= clock) || (entry.status === "sending" && entry.lockedUntil !== null && Date.parse(entry.lockedUntil) < clock));
    return due.filter((entry) => !ticketIds?.length || ticketIds.includes(entry.ticketId)).slice(0, limit).map((entry) => {
      Object.assign(entry, { status: "sending", attempts: entry.attempts + 1, lockedUntil: new Date(clock + 180_000).toISOString() });
      return { ...entry };
    });
  }
  async finishNotification(id: string, result: Readonly<{ status: "sent" | "failed" | "skipped"; lastError?: string | null; nextAttemptAt?: string | null }>) {
    Object.assign(this.notifications.get(id)!, { status: result.status, lastError: result.lastError ?? null, lockedUntil: null, nextAttemptAt: result.status === "failed" ? result.nextAttemptAt ?? null : null, ...(result.status === "sent" ? { sentAt: new Date(clock).toISOString() } : {}) });
  }
  async listNotifications(ticketId: string) {
    return [...this.notifications.values()].filter((entry) => entry.ticketId === ticketId);
  }
}

class MemoryFiles implements SupportFiles {
  objects = new Map<string, Uint8Array>();
  deleted: string[] = [];
  async createUploadUrl(input: Readonly<{ storageKey: string }>) {
    return { uploadUrl: `https://r2.test/${input.storageKey}?signature=x`, method: "PUT" as const, headers: {}, expiresAt: new Date(clock + 600_000).toISOString() };
  }
  async getDownloadUrl(storageKey: string, expiresInSeconds = 300) {
    return `https://r2.test/${storageKey}?expires=${expiresInSeconds}`;
  }
  async getMetadata(storageKey: string) {
    const bytes = this.objects.get(storageKey);
    return bytes ? { contentLength: bytes.length } : undefined;
  }
  async readObjectPrefix(storageKey: string, length = 64) {
    return this.objects.get(storageKey)?.slice(0, length);
  }
  async deleteObject(storageKey: string) {
    this.deleted.push(storageKey);
    this.objects.delete(storageKey);
  }
}

const store = new MemorySupportStore(auth);
const files = new MemoryFiles();
setSupportStoreForTesting(store);
setSupportFilesForTesting(files);
// e-mails: nothing ever leaves the process; the dispatch after the response is awaited by the tests
const scheduled: Promise<void>[] = [];
setSupportSchedulerForTesting((task) => { scheduled.push(task()); });
const flushNotifications = async () => { while (scheduled.length) await scheduled.shift(); };
type SentMail = Readonly<{ to: string; subject: string; text: string; html: string }>;
const mailbox: SentMail[] = [];
const mailer = { configured: false as boolean, failNext: 0, allowed: (_email: string) => true };
setSupportMailerForTesting({
  state: () => (mailer.configured ? { configured: true } : { configured: false, reason: "Odesílání e-mailů není nastavené (chybí SMTP_HOST). (test)" }),
  recipientAllowed: (email) => mailer.allowed(email),
  async send(mail) {
    if (mailer.failNext > 0) {
      mailer.failNext -= 1;
      throw new InvitationSendError("E-mail se nepodařilo odeslat (ECONNECTION).");
    }
    mailbox.push(mail);
  },
});

// ---------------------------------------------------------------------------------------------
type Handler = (request: NextRequest) => Promise<Response>;
async function call(handler: Handler, token: string | undefined, body?: Record<string, unknown>, query?: Record<string, string>) {
  const headers: Record<string, string> = token ? { cookie: `homeworkstudio_session=${token}` } : {};
  const search = new URLSearchParams({ app: "abf", ...(query ?? {}) });
  let payload: string | undefined;
  if (body) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify({ app: "abf", ...body });
  }
  const response = await handler(new NextRequest(`${ORIGIN}/api/support/x?${search}`, { method: body ? "POST" : "GET", headers, body: payload }));
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4]);
/** presign → (the browser's PUT) → verify, like lib/support/supportClient.ts uploadSupportFile. */
async function upload(token: string, bytes: Uint8Array = PNG, declared: Readonly<{ mimeType?: string; fileName?: string; purpose?: string }> = {}) {
  const presign = await call(handleAttachmentPresign, token, { purpose: declared.purpose ?? "ticket", mimeType: declared.mimeType ?? "image/png", size: bytes.length, fileName: declared.fileName ?? "snimek.png" });
  assert.equal(presign.status, 200, JSON.stringify(presign.body));
  const id = presign.body.attachment.id as string;
  files.objects.set(store.attachments.get(id)!.storageKey, bytes);
  const verify = await call(handleAttachmentVerify, token, { attachmentId: id });
  return { id, verify };
}

let sessionToken: string;
async function account(role: "admin" | "user" | "external" | null, displayName: string, extra: Readonly<{ isHwsAdmin?: boolean }> = {}) {
  const session = await createTestSession(SECRET, { role, ...extra });
  auth.users.get(session.user.id)!.displayName = displayName;
  return { token: session.token, id: session.user.id };
}

// Each test builds on the same people (fresh in-memory data per process run).
const people = {} as Record<"admin" | "admin2" | "user" | "user2" | "external" | "hwsOnly", { token: string; id: string }>;
test.before(async () => {
  people.admin = await account("admin", "Správce TEST");
  people.admin2 = await account("admin", "Správce 2 TEST");
  people.user = await account("user", "Běžný TEST");
  people.user2 = await account("user", "Běžný 2 TEST");
  people.external = await account("external", "Externí TEST");
  people.hwsOnly = await account(null, "HWS admin bez ABF TEST", { isHwsAdmin: true });
  sessionToken = people.admin.token;
});

const article = (overrides: Partial<ArticleInput> = {}): ArticleInput => ({ kind: "guide", category: "Katalog", title: "Import katalogu", summary: "Jak nahrát Excel", body: "## Postup\n- Otevřete Administraci", areaKeys: ["abf.catalog.import"], forExternal: false, status: "published", sortOrder: 0, ...overrides });

// =============================================================================================
// Access: roles, applications, removed membership
// =============================================================================================
test("přístup: role ABF → role podpory; HWS admin bez členství nic nedostane; podpora jen v ABF", async () => {
  assert.equal(supportRoleOf("abf", "admin"), "manager");
  assert.equal(supportRoleOf("abf", "user"), "member");
  assert.equal(supportRoleOf("abf", "external"), "external");
  assert.equal(supportRoleOf("abf", undefined), undefined);
  assert.equal(canOpenSection("external", "support"), true);
  assert.equal(canOpenSection(undefined, "support"), false);
  assert.equal((await call(handleSupportSummary, undefined)).status, 401);
  const hws = await call(handleSupportSummary, people.hwsOnly.token);
  assert.equal(hws.status, 403);
  assert.equal(hws.body.code, "no_app_access");
  assert.equal((await call(handleArticlesList, people.hwsOnly.token)).status, 403);
  const other = await handleSupportSummary(new NextRequest(`${ORIGIN}/api/support/summary?app=hws-easy`, { headers: { cookie: `homeworkstudio_session=${people.admin.token}` } }));
  assert.equal(other.status, 404, "HWS Easy support is not enabled yet");
  for (const [who, role] of [["admin", "manager"], ["user", "member"], ["external", "external"]] as const) {
    assert.equal((await call(handleSupportSummary, people[who].token)).body.role, role);
  }
});

// =============================================================================================
// Articles
// =============================================================================================
let internalId = "";
let externalId = "";
let draftId = "";
test("návody: správce vytváří a publikuje; běžný vidí publikované, externí jen určené externím; koncept nikdo jiný", async () => {
  const forbidden = await call(handleArticleSave, people.user.token, { id: null, expectedVersion: 0, ...article() });
  assert.equal(forbidden.status, 403, "only managers write articles");
  internalId = (await call(handleArticleSave, people.admin.token, { id: null, expectedVersion: 0, ...article() })).body.article.id;
  externalId = (await call(handleArticleSave, people.admin.token, { id: null, expectedVersion: 0, ...article({ title: "Stažení výstupů", category: "Projekty", forExternal: true, areaKeys: ["abf.projects"] }) })).body.article.id;
  draftId = (await call(handleArticleSave, people.admin.token, { id: null, expectedVersion: 0, ...article({ title: "Rozpracovaný koncept", status: "draft" }) })).body.article.id;
  const titles = async (token: string) => ((await call(handleArticlesList, token)).body.articles as { title: string }[]).map((entry) => entry.title).sort();
  assert.deepEqual(await titles(people.admin.token), ["Import katalogu", "Rozpracovaný koncept", "Stažení výstupů"]);
  assert.deepEqual(await titles(people.user.token), ["Import katalogu", "Stažení výstupů"]);
  assert.deepEqual(await titles(people.external.token), ["Stažení výstupů"]);
  // a direct id is refused the same way (no hint that it exists)
  assert.equal((await call(handleArticleGet, people.external.token, undefined, { id: internalId })).status, 404);
  assert.equal((await call(handleArticleGet, people.user.token, undefined, { id: draftId })).status, 404);
  assert.equal((await call(handleArticleGet, people.external.token, undefined, { id: externalId })).status, 200);
  // author and time of the change
  const managerView = (await call(handleArticlesList, people.admin.token)).body.articles.find((entry: { id: string }) => entry.id === internalId);
  assert.equal(managerView.updatedBy, "Správce TEST");
  assert.ok(managerView.updatedAt);
  assert.equal((await call(handleArticleVersions, people.user.token, undefined, { id: internalId })).status, 403);
});

test("návody: souběžná úprava se tiše nepřepíše; obnovení starší verze vytvoří novou verzi; historie zůstává", async () => {
  const first = await call(handleArticleSave, people.admin.token, { id: internalId, expectedVersion: 1, ...article({ body: "## Postup\n- Verze dvě" }) });
  assert.equal(first.status, 200);
  assert.equal(first.body.article.version, 2);
  // the second admin still holds version 1 → refused, nothing written
  const stale = await call(handleArticleSave, people.admin2.token, { id: internalId, expectedVersion: 1, ...article({ body: "přepis" }) });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "stale");
  assert.match(store.articles.get(internalId)!.body, /Verze dvě/u);
  const restored = await call(handleArticleRestore, people.admin2.token, { id: internalId, version: 1, expectedVersion: 2 });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.article.version, 3);
  assert.equal(store.articles.get(internalId)!.body, article().body);
  assert.equal(store.articles.get(internalId)!.updatedBy, people.admin2.id);
  const versions = (await call(handleArticleVersions, people.admin.token, undefined, { id: internalId })).body.versions as { version: number; author: string }[];
  assert.deepEqual(versions.map((entry) => entry.version), [3, 2, 1]);
  assert.equal(versions[0]!.author, "Správce 2 TEST");
});

test("návody: změna role na externí okamžitě omezí obsah; odebrané členství zavře i otevřenou session", async () => {
  const person = await account("user", "Dočasný TEST");
  assert.equal((await call(handleArticleGet, person.token, undefined, { id: internalId })).status, 200);
  auth.setRole(person.id, "external");
  assert.equal((await call(handleArticleGet, person.token, undefined, { id: internalId })).status, 404);
  auth.setMembership(person.id, "abf", undefined);
  assert.equal((await call(handleArticlesList, person.token)).status, 403);
  auth.setRole(person.id, "user");
  auth.setActive(person.id, false);
  assert.ok([401, 403].includes((await call(handleArticlesList, person.token)).status), "a deactivated account opens nothing");
});

test("komentáře a návrhy: uživatel přidá, správce vyřeší a skryje; skrytý komentář ostatní nevidí, externí vidí jen své", async () => {
  const comment = await call(handleCommentCreate, people.user.token, { articleId: internalId, kind: "suggestion", body: "Doplnit krok 3" });
  assert.equal(comment.status, 201);
  assert.equal((await call(handleCommentCreate, people.external.token, { articleId: internalId, body: "x" })).status, 404, "external cannot comment an internal article");
  await call(handleCommentCreate, people.external.token, { articleId: externalId, body: "Externí dotaz" });
  await call(handleCommentCreate, people.user2.token, { articleId: externalId, body: "Interní poznámka kolegy" });
  const externalView = (await call(handleArticleGet, people.external.token, undefined, { id: externalId })).body.comments as { body: string }[];
  assert.deepEqual(externalView.map((entry) => entry.body), ["Externí dotaz"]);
  assert.equal((await call(handleCommentModerate, people.user.token, { commentId: comment.body.comment.id, hidden: true })).status, 403);
  assert.equal((await call(handleCommentModerate, people.admin.token, { commentId: comment.body.comment.id, status: "resolved", hidden: true })).status, 200);
  assert.equal((await call(handleArticleGet, people.user2.token, undefined, { id: internalId })).body.comments.length, 0);
  const managerComments = (await call(handleArticleGet, people.admin.token, undefined, { id: internalId })).body.comments;
  assert.equal(managerComments[0].hidden, true);
  assert.equal(managerComments[0].status, "resolved");
});

test("obsah návodů: žádné HTML ani vlastní iframe; odkazy jen https nebo interní; video jen YouTube/Vimeo nebo příloha; hledání bez diakritiky", () => {
  const blocks = parseArticleBody('<script>alert(1)</script>\n<iframe src="https://evil.test"></iframe>\n[klik](javascript:alert(1)) [ok](https://example.com) [interní](/abf#/podpora)\n!video[x](https://evil.test/video.mp4)\n!video[y](https://youtu.be/dQw4w9WgXcQ)\n![z](příloha:6b22b294-2a6d-436b-8211-80320b02a2e8)');
  const json = JSON.stringify(blocks);
  assert.ok(!blocks.some((block) => (block.type as string) === "html"));
  assert.match(json, /"text":"<script>alert\(1\)<\/script>/u, "HTML stays plain text");
  assert.doesNotMatch(json, /"href":"javascript/u);
  assert.match(json, /"href":"https:\/\/example.com\/?"/u);
  assert.match(json, /"href":"\/abf#\/podpora"/u);
  assert.equal(blocks.filter((block) => block.type === "embed").length, 1);
  assert.equal(blocks.filter((block) => block.type === "image").length, 1);
  assert.equal(videoEmbedOf("https://evil.test/watch?v=dQw4w9WgXcQ"), undefined);
  assert.deepEqual(videoEmbedOf("https://vimeo.com/123456789"), { provider: "vimeo", videoId: "123456789" });
  assert.ok(articleMatches({ title: "Úprava cen", summary: "", body: "Ceník veletrhu", category: "Ceníky" }, "uprava", ""));
  assert.ok(articleMatches({ title: "Úprava cen", summary: "", body: "Ceník veletrhu", category: "Ceníky" }, "veletrhu  UPRAVA", ""), "all words, any order");
  assert.ok(!articleMatches({ title: "Úprava cen", summary: "", body: "Ceník veletrhu", category: "Ceníky" }, "uprava katalogu", ""));
  assert.ok(articleMatches({ title: "X", summary: "", body: "Ceník veletrhu", category: "Ceníky" }, "cenik", "Ceníky"));
  assert.ok(!articleMatches({ title: "X", summary: "", body: "Ceník", category: "Ceníky" }, "", "Katalog"));
  assert.equal(canReadArticle("external", { status: "published", forExternal: false }), false);
});

// =============================================================================================
// Attachments
// =============================================================================================
test("přílohy: skutečný obsah a velikost se ověřují; SVG/HTML a podvržený typ neprojdou; limity", async () => {
  for (const [mimeType, fileName] of [["image/svg+xml", "a.svg"], ["text/html", "a.html"], ["image/png", "a.svg"], ["application/pdf", "a.pdf"]]) {
    const response = await call(handleAttachmentPresign, people.user.token, { purpose: "ticket", mimeType, size: 10, fileName });
    assert.equal(response.status, 400, `${mimeType} ${fileName}`);
  }
  assert.equal((await call(handleAttachmentPresign, people.user.token, { purpose: "ticket", mimeType: "image/png", size: 11 * 1024 * 1024, fileName: "velky.png" })).status, 400);
  assert.equal((await call(handleAttachmentPresign, people.user.token, { purpose: "article", mimeType: "image/png", size: 10, fileName: "a.png" })).status, 403, "article media only for managers");
  // declared PNG, really HTML → object and row removed
  const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
  const fake = await upload(people.user.token, html, { mimeType: "image/png", fileName: "fake.png" });
  assert.equal(fake.verify.status, 400);
  assert.equal(store.attachments.has(fake.id), false);
  assert.equal(files.deleted.length, 1);
  // size differs from what was declared
  const presign = await call(handleAttachmentPresign, people.user.token, { purpose: "ticket", mimeType: "image/png", size: 5, fileName: "a.png" });
  files.objects.set(store.attachments.get(presign.body.attachment.id)!.storageKey, PNG);
  assert.equal((await call(handleAttachmentVerify, people.user.token, { attachmentId: presign.body.attachment.id })).status, 400);
  assert.equal(sniffAttachmentType(PNG), "image/png");
  assert.equal(sniffAttachmentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffAttachmentType(new TextEncoder().encode("<svg xmlns=")), undefined);
  // someone else cannot verify or discard my upload
  const mine = await upload(people.user.token);
  assert.equal(mine.verify.status, 200);
  assert.equal((await call(handleAttachmentDiscard, people.user2.token, { attachmentId: mine.id })).status, 404);
  assert.equal((await call(handleAttachmentDiscard, people.user.token, { attachmentId: mine.id })).status, 200);
});

// =============================================================================================
// Reports
// =============================================================================================
let ticketId = "";
let attachmentId = "";
test("hlášení: dvojí odeslání nevytvoří duplikát; kontext je bezpečný; číslo hlášení se vrátí", async () => {
  attachmentId = (await upload(people.user.token)).id;
  const requestId = randomUUID();
  const payload = {
    clientRequestId: requestId, kind: "bug", subject: "Nejde uložit ceník", description: "Po kliknutí se nic nestane.", steps: "1. Otevřu ceník", expected: "Uloží se", actual: "Chyba",
    context: { area: "abf.prices", path: "/abf?token=tajne&x=1#/administrace/ceniky/verze?heslo=1", browser: "Chrome 140 · Windows", viewport: "1440×900", password: "nikdy", formData: { cena: 100 }, console: ["err"] },
    attachmentIds: [attachmentId],
  };
  assert.equal((await call(handleTicketCreate, people.user.token, { ...payload, subject: " " })).status, 400);
  const [first, second] = await Promise.all([call(handleTicketCreate, people.user.token, payload), call(handleTicketCreate, people.user.token, payload)]);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.ticket.id, second.body.ticket.id);
  assert.equal((await call(handleTicketsList, people.user.token)).body.tickets.length, 1);
  ticketId = first.body.ticket.id;
  assert.equal(typeof first.body.ticket.number, "number");
  const stored = store.tickets.get(ticketId)!;
  assert.deepEqual(Object.keys(stored.context).sort(), ["app", "appVersion", "area", "browser", "path", "viewport"]);
  assert.equal(stored.context.path, "/abf#/administrace/ceniky/verze");
  assert.doesNotMatch(JSON.stringify(stored.context), /tajne|nikdy|cena|err/u);
  assert.equal(store.attachments.get(attachmentId)!.status, "attached");
  assert.equal(safeContextPath("/abf", "#/reset-password-token-abc"), "/abf#/reset-…");
  assert.deepEqual(sanitizeClientContext({ area: "neexistuje", viewport: "<b>" }).area, "abf.general");
});

test("hlášení: selhání uložení nevytvoří hlášení; neověřená příloha zastaví odeslání; opakování projde", async () => {
  const uploaded = await upload(people.user2.token);
  const requestId = randomUUID();
  const payload = { clientRequestId: requestId, kind: "question", subject: "Dotaz", description: "Jak?", attachmentIds: [uploaded.id] };
  store.failNextWrite = true;
  const failed = await call(handleTicketCreate, people.user2.token, payload);
  assert.equal(failed.status, 502);
  assert.equal((await call(handleTicketsList, people.user2.token)).body.tickets.length, 0);
  assert.equal(store.attachments.get(uploaded.id)!.status, "verified", "the attachment waits for the retry");
  // not yet verified upload → refused, nothing created
  const pending = (await call(handleAttachmentPresign, people.user2.token, { purpose: "ticket", mimeType: "image/png", size: PNG.length, fileName: "b.png" })).body.attachment.id;
  const notReady = await call(handleTicketCreate, people.user2.token, { ...payload, clientRequestId: randomUUID(), attachmentIds: [pending] });
  assert.equal(notReady.status, 409);
  assert.equal(notReady.body.code, "attachment_not_ready");
  // someone else's verified upload cannot be attached
  const foreign = await upload(people.user.token);
  assert.equal((await call(handleTicketCreate, people.user2.token, { ...payload, clientRequestId: randomUUID(), attachmentIds: [foreign.id] })).status, 409);
  const retried = await call(handleTicketCreate, people.user2.token, payload);
  assert.equal(retried.status, 201);
  assert.equal(store.attachments.get(uploaded.id)!.ticketId, retried.body.ticket.id);
});

test("hlášení: cizí hlášení a jeho přílohy vidí jen správce aplikace; autor vidí svá", async () => {
  assert.equal((await call(handleTicketGet, people.user2.token, undefined, { id: ticketId })).status, 404);
  assert.equal((await call(handleTicketGet, people.external.token, undefined, { id: ticketId })).status, 404);
  assert.equal((await call(handleAttachmentUrl, people.user2.token, { attachmentId })).status, 404);
  assert.equal((await call(handleTicketsList, people.user.token, undefined, { scope: "all" })).status, 403);
  assert.equal((await call(handleTicketsList, people.admin.token, undefined, { scope: "all" })).body.tickets.length, 2);
  assert.equal((await call(handleTicketGet, people.admin.token, undefined, { id: ticketId })).status, 200);
  const url = await call(handleAttachmentUrl, people.user.token, { attachmentId });
  assert.equal(url.status, 200);
  assert.match(url.body.url, /expires=300/u, "short-lived URL");
  assert.equal((await call(handleTicketGet, people.hwsOnly.token, undefined, { id: ticketId })).status, 403);
});

test("hlášení: interní poznámky a jejich přílohy zůstávají na serveru; odpověď autora vrací stav do řešení; historie", async () => {
  const noteFile = await upload(people.admin.token);
  assert.equal((await call(handleTicketReply, people.user.token, { ticketId, clientRequestId: randomUUID(), body: "x", visibility: "internal" })).status, 403);
  assert.equal((await call(handleTicketReply, people.admin.token, { ticketId, clientRequestId: randomUUID(), body: "Interní: chyba v cache", visibility: "internal", attachmentIds: [noteFile.id] })).status, 201);
  const publicReply = randomUUID();
  await call(handleTicketReply, people.admin.token, { ticketId, clientRequestId: publicReply, body: "Pošlete prosím snímek." });
  await call(handleTicketReply, people.admin.token, { ticketId, clientRequestId: publicReply, body: "Pošlete prosím snímek." });
  const authorView = (await call(handleTicketGet, people.user.token, undefined, { id: ticketId })).body;
  assert.deepEqual(authorView.messages.map((message: { body: string }) => message.body), ["Pošlete prosím snímek."]);
  assert.doesNotMatch(JSON.stringify(authorView), /Interní: chyba|internal/u);
  assert.ok(!authorView.attachments.some((entry: { id: string }) => entry.id === noteFile.id));
  assert.equal(authorView.assignees, undefined);
  assert.equal((await call(handleAttachmentUrl, people.user.token, { attachmentId: noteFile.id })).status, 404);
  assert.equal((await call(handleTicketGet, people.admin.token, undefined, { id: ticketId })).body.messages.length, 2);
  // status: author cannot change it; manager → waiting; the author's reply → in progress
  assert.equal((await call(handleTicketUpdate, people.user.token, { ticketId, expectedUpdatedAt: store.tickets.get(ticketId)!.updatedAt, status: "closed" })).status, 403);
  assert.equal((await call(handleTicketUpdate, people.admin.token, { ticketId, expectedUpdatedAt: "2000-01-01T00:00:00.000Z", status: "waiting" })).body.code, "stale");
  assert.equal((await call(handleTicketUpdate, people.admin.token, { ticketId, expectedUpdatedAt: store.tickets.get(ticketId)!.updatedAt, status: "waiting" })).status, 200);
  assert.equal((await call(handleSupportSummary, people.user.token)).body.waitingForMe, 1);
  const extra = await upload(people.user.token);
  assert.equal((await call(handleTicketReply, people.user.token, { ticketId, clientRequestId: randomUUID(), body: "Snímek posílám.", attachmentIds: [extra.id] })).status, 201);
  assert.equal(store.tickets.get(ticketId)!.status, "in_progress");
  assert.equal((await call(handleSupportSummary, people.user.token)).body.waitingForMe, 0);
  // assignment: only an active admin of the application
  const expected = () => store.tickets.get(ticketId)!.updatedAt;
  assert.equal((await call(handleTicketUpdate, people.admin.token, { ticketId, expectedUpdatedAt: expected(), assigneeId: people.user.id })).body.code, "invalid_assignee");
  assert.equal((await call(handleTicketUpdate, people.admin.token, { ticketId, expectedUpdatedAt: expected(), assigneeId: people.admin2.id })).status, 200);
  assert.equal((await call(handleTicketUpdate, people.admin.token, { ticketId, expectedUpdatedAt: expected(), status: "new" })).status, 400, "no transition back to Nové");
  await call(handleTicketUpdate, people.admin.token, { ticketId, expectedUpdatedAt: expected(), status: "closed" });
  assert.equal((await call(handleTicketReply, people.user.token, { ticketId, clientRequestId: randomUUID(), body: "ještě" })).body.code, "closed");
  assert.equal((await call(handleTicketUpdate, people.admin.token, { ticketId, expectedUpdatedAt: expected(), status: "in_progress" })).status, 200);
  const history = (await call(handleTicketGet, people.user.token, undefined, { id: ticketId })).body.events.map((event: { type: string; to: string | null }) => `${event.type}:${event.to}`);
  assert.deepEqual(history, ["created:new", "status:waiting", "status:in_progress", "assignee:Správce 2 TEST", "status:closed", "reopened:in_progress"]);
});

test("hlášení: zakázku připojí jen ten, kdo k ní má přístup; obsah zakázky se nikdy nevydává", async () => {
  auth.assign(people.user.id, "p-support-1");
  auth.projects.add("p-support-2");
  const base = { kind: "bug", subject: "Zakázka", description: "Popis", context: {} };
  const denied = await call(handleTicketCreate, people.user.token, { ...base, clientRequestId: randomUUID(), projectId: "p-support-2" });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "project_forbidden");
  const linked = await call(handleTicketCreate, people.user.token, { ...base, clientRequestId: randomUUID(), projectId: "p-support-1" });
  assert.equal(linked.status, 201);
  const view = (await call(handleTicketGet, people.user.token, undefined, { id: linked.body.ticket.id })).body.ticket;
  assert.deepEqual(view.project, { id: "p-support-1", name: "Zakázka p-support-1" });
  auth.unassign(people.user.id, "p-support-1");
  const after = (await call(handleTicketGet, people.user.token, undefined, { id: linked.body.ticket.id })).body.ticket;
  assert.equal(after.project, null);
  assert.equal(after.hasProject, true);
});

test("počítadla: nová hlášení pro správce, čekající na doplnění pro autora; externí vytvoří hlášení a vidí jen svá", async () => {
  const external = await call(handleTicketCreate, people.external.token, { clientRequestId: randomUUID(), kind: "question", subject: "Kde je export?", description: "Nevidím soubor.", context: {} });
  assert.equal(external.status, 201);
  assert.equal((await call(handleTicketsList, people.external.token)).body.tickets.length, 1);
  const summary = (await call(handleSupportSummary, people.admin.token)).body;
  assert.equal(summary.newTickets, [...store.tickets.values()].filter((ticket) => ticket.status === "new").length);
  assert.ok(summary.newTickets >= 2);
  assert.equal((await call(handleSupportSummary, people.external.token)).body.newTickets, 0);
});

// =============================================================================================
// Screenshots, cleanup, navigation, UI contract
// =============================================================================================
test("úprava snímku: zakrytí je neprůhledné a zapečené do pixelů; mimo oblast se nic nemění", () => {
  const width = 10;
  const height = 6;
  const image = { width, height, data: new Uint8ClampedArray(width * height * 4).fill(200) };
  applyImageEdits(image, [{ type: "redact", from: { x: 2, y: 1 }, to: { x: 6, y: 4 } }]);
  const pixel = (x: number, y: number) => [...image.data.slice((y * width + x) * 4, (y * width + x) * 4 + 4)];
  assert.deepEqual(pixel(3, 2), [0, 0, 0, 255]);
  assert.deepEqual(pixel(0, 0), [200, 200, 200, 200]);
  assert.deepEqual(pixel(8, 5), [200, 200, 200, 200]);
  assert.equal(hasRedaction([{ type: "rect", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }]), false);
  assert.equal(hasRedaction([{ type: "redact", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }]), true);
  const marked = { width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) };
  applyImageEdits(marked, [{ type: "rect", from: { x: 1, y: 1 }, to: { x: 8, y: 4 } }], 1);
  assert.notDeepEqual([...marked.data.slice(((1 * width) + 1) * 4, ((1 * width) + 1) * 4 + 4)], [255, 255, 255, 255]);
  assert.deepEqual([...marked.data.slice(((2 * width) + 4) * 4, ((2 * width) + 4) * 4 + 4)], [255, 255, 255, 255], "rectangle is an outline");
});

test("úklid nedokončených nahrání: nikdy nesmaže přílohu připojenou k obsahu", () => {
  const old = "2026-11-01T00:00:00.000Z";
  const rows = [
    { id: "a", status: "pending", createdAt: old, storageKey: "support/abf/a/x.png" },
    { id: "b", status: "verified", createdAt: old, storageKey: "support/abf/b/x.png" },
    { id: "c", status: "attached", createdAt: old, storageKey: "support/abf/c/x.png" },
    { id: "d", status: "pending", createdAt: "2026-11-10T09:59:00.000Z", storageKey: "support/abf/d/x.png" },
    { id: "e", status: "pending", createdAt: old, storageKey: "projects/p/exports/x.png" },
  ] as const;
  assert.deepEqual(selectCleanup(rows, new Date("2026-11-10T00:00:00.000Z"), false).map((row) => row.id), ["a", "b"]);
  assert.deepEqual(selectCleanup(rows, new Date("2026-11-10T00:00:00.000Z"), true).map((row) => row.id), ["a", "b", "c", "d"], "--all (rollback) still only support/ keys");
});

test("adresa podpory: #/podpora/… přežije obnovení stránky, cizí znaky se zahodí", () => {
  assert.deepEqual(parseWorkspaceHash("#/podpora/hlaseni/6b22b294-2a6d-436b-8211-80320b02a2e8"), { section: "support", support: "hlaseni/6b22b294-2a6d-436b-8211-80320b02a2e8" });
  assert.equal(workspaceHash({ section: "support", support: "sprava/hlaseni" }), "#/podpora/sprava/hlaseni");
  assert.equal(normalizeSupportRoute("navody/<script>"), "navody");
  assert.deepEqual(parseWorkspaceHash("#/podpora"), { section: "support", support: "navody" });
});

test("UI: Nahlásit chybu a Nápověda jsou překryvy — rozpracovaný projekt se nezavírá; snímek obrazovky hned zastaví stopy", () => {
  const generator = readFileSync("components/BoothGenerator.tsx", "utf8");
  assert.match(generator, /onReport=\{supportRole \? \(\) => setSupportReportOpen\(true\) : undefined\}/u);
  assert.match(generator, /onHelp=\{supportRole \? \(\) => setSupportHelpOpen\(true\) : undefined\}/u);
  const picker = readFileSync("components/support/AttachmentPicker.tsx", "utf8");
  assert.match(picker, /getDisplayMedia\(\{ video: true, audio: false \}\)/u);
  assert.match(picker, /finally \{\s*for \(const track of stream\.getTracks\(\)\) track\.stop\(\);/u);
  assert.match(picker, /NotAllowedError/u);
  const dialog = readFileSync("components/support/ReportDialog.tsx", "utf8");
  assert.match(dialog, /requestId = useRef/u, "one submission id per report");
  assert.doesNotMatch(dialog, /dangerouslySetInnerHTML=/u);
  assert.doesNotMatch(readFileSync("components/support/ArticleContent.tsx", "utf8"), /dangerouslySetInnerHTML=/u);
  const sidebar = readFileSync("components/AppSidebar.tsx", "utf8");
  assert.match(sidebar, /label: "Nápověda a podpora"/u);
  void sessionToken;
});

// =============================================================================================
// E-mail notifications (V1-SUPPORT-02)
// =============================================================================================
test("upozornění — kdo dostane e-mail: nikdy autor vlastní akce, nikdy interní poznámka", () => {
  const managers = ["m1", "m2"];
  const plan = (event: Parameters<typeof planNotifications>[0]["event"], actorId: string, assigneeId: string | null = null) => planNotifications({ event, actorId, authorId: "author", assigneeId, managerIds: managers }).map((entry) => `${entry.recipientId}:${entry.kind}:${entry.audience}`);
  assert.deepEqual(plan({ type: "created" }, "author"), ["m1:new_ticket:manager", "m2:new_ticket:manager"]);
  assert.deepEqual(plan({ type: "created" }, "m1"), ["m2:new_ticket:manager"], "a manager reporting does not notify themselves");
  assert.deepEqual(plan({ type: "message", visibility: "public" }, "m1"), ["author:staff_reply:author"]);
  assert.deepEqual(plan({ type: "message", visibility: "internal" }, "m1"), []);
  assert.deepEqual(plan({ type: "message", visibility: "public" }, "author", "m2"), ["m2:author_reply:manager"], "assignee only");
  assert.deepEqual(plan({ type: "message", visibility: "public" }, "author", "gone"), ["m1:author_reply:manager", "m2:author_reply:manager"], "assignee no longer a manager → managers");
  assert.deepEqual(plan({ type: "status", to: "waiting" }, "m1"), ["author:waiting:author"]);
  assert.deepEqual(plan({ type: "status", to: "resolved" }, "m1"), ["author:resolved:author"]);
  assert.deepEqual(plan({ type: "status", to: "closed" }, "m1"), []);
  assert.deepEqual(plan({ type: "status", to: "in_progress" }, "m1"), []);
  assert.deepEqual(planNotifications({ event: { type: "status", to: "resolved" }, actorId: "m1", authorId: "m1", assigneeId: null, managerIds: managers }), [], "own report resolved by oneself");
  assert.equal(nextNotificationAttempt(1, new Date(0))?.getTime(), 60_000);
  assert.equal(nextNotificationAttempt(5, new Date(0))?.getTime(), 240 * 60_000);
  assert.equal(nextNotificationAttempt(6, new Date(0)), null, "given up after 6 attempts");
});

const mailsTo = (email: string) => mailbox.filter((mail) => mail.to === email);
const emailOf = (id: string) => auth.users.get(id)!.email;

test("upozornění — průběh hlášení: nové → správci, odpověď/doplnění/vyřešení → autor, odpověď autora → řešitel; obsah jen číslo, předmět, odkaz", async () => {
  mailer.configured = true;
  mailbox.length = 0;
  const author = await account("user", "Autor upozornění TEST");
  const create = { clientRequestId: randomUUID(), kind: "bug", subject: "ZTEST <b>Ukládání</b>\r\nBcc: x@y", description: "TAJNÝ POPIS", context: {} };
  const created = await call(handleTicketCreate, author.token, create);
  assert.equal(created.status, 201);
  const ticketId = created.body.ticket.id as string;
  await flushNotifications();
  const managerMail = mailsTo(emailOf(people.admin.id));
  assert.equal(managerMail.length, 1);
  assert.equal(mailsTo(emailOf(people.admin2.id)).length, 1);
  assert.equal(mailsTo(emailOf(author.id)).length, 0, "no message about one's own action");
  const mail = managerMail[0]!;
  assert.equal(mail.subject, `Nové hlášení #${created.body.ticket.number}: ZTEST <b>Ukládání</b> Bcc: x@y — ABF Generator`);
  assert.doesNotMatch(mail.subject, /[\r\n]/u, "no header injection");
  assert.ok(mail.text.includes(`/abf#/podpora/sprava/hlaseni/${ticketId}`));
  assert.match(mail.html, /&lt;b&gt;Ukládání&lt;\/b&gt;/u, "subject escaped in HTML");
  assert.doesNotMatch(`${mail.text}${mail.html}`, /TAJNÝ POPIS/u, "the description stays in the application");
  // a repeated submission queues nothing new
  const before = store.notifications.size;
  assert.equal((await call(handleTicketCreate, author.token, create)).body.ticket.id, ticketId);
  await flushNotifications();
  assert.equal(store.notifications.size, before);
  assert.equal(mailsTo(emailOf(people.admin.id)).length, 1, "no duplicate e-mail");

  // internal note → nobody; public reply → the author (link to Moje hlášení), the reply text is not in the mail
  await call(handleTicketReply, people.admin.token, { ticketId, clientRequestId: randomUUID(), body: "INTERNÍ TEXT", visibility: "internal" });
  await call(handleTicketReply, people.admin.token, { ticketId, clientRequestId: randomUUID(), body: "VEŘEJNÁ ODPOVĚĎ" });
  await flushNotifications();
  const toAuthor = mailsTo(emailOf(author.id));
  assert.equal(toAuthor.length, 1);
  assert.match(toAuthor[0]!.subject, /^Odpověď na hlášení #/u);
  assert.ok(toAuthor[0]!.text.includes(`/abf#/podpora/hlaseni/${ticketId}`));
  assert.doesNotMatch(JSON.stringify(mailbox), /INTERNÍ TEXT|VEŘEJNÁ ODPOVĚĎ/u);
  assert.equal(mailsTo(emailOf(people.admin2.id)).length, 1, "other managers get nothing about a staff reply");

  // waiting + assignee → the author; the author's reply → only the assignee
  const expected = () => store.tickets.get(ticketId)!.updatedAt;
  await call(handleTicketUpdate, people.admin.token, { ticketId, expectedUpdatedAt: expected(), status: "waiting", assigneeId: people.admin2.id });
  await flushNotifications();
  assert.match(mailsTo(emailOf(author.id)).at(-1)!.subject, /čeká na doplnění/u);
  // the CURRENT address of the account is used
  auth.users.get(author.id)!.email = `novy-${author.id.slice(0, 6)}@test.invalid`;
  await call(handleTicketReply, author.token, { ticketId, clientRequestId: randomUUID(), body: "doplňuji" });
  await flushNotifications();
  assert.equal(mailsTo(emailOf(people.admin2.id)).length, 2, "assignee informed");
  assert.match(mailsTo(emailOf(people.admin2.id)).at(-1)!.subject, /^Doplnění k hlášení #/u);
  assert.equal(mailsTo(emailOf(people.admin.id)).length, 1, "not the other managers when there is an assignee");
  await call(handleTicketUpdate, people.admin2.token, { ticketId, expectedUpdatedAt: expected(), status: "resolved" });
  await flushNotifications();
  const resolved = mailsTo(emailOf(author.id));
  assert.equal(resolved.length, 1, "sent to the new address");
  assert.match(resolved[0]!.subject, /je vyřešené/u);
  // the record: managers see it, the author's view never contains it
  const log = (await call(handleTicketGet, people.admin.token, undefined, { id: ticketId })).body.notifications as { kind: string; status: string }[];
  const kinds = log.map((entry) => entry.kind);
  for (const kind of ["new_ticket", "staff_reply", "waiting", "author_reply", "resolved"]) assert.ok(kinds.includes(kind), kind);
  assert.ok(log.every((entry) => entry.status === "sent"));
  assert.equal((await call(handleTicketGet, author.token, undefined, { id: ticketId })).body.notifications, undefined);
});

test("upozornění — před odesláním znovu ověřený přístup příjemce; DEV jen na povolené adresy", async () => {
  mailer.configured = true;
  mailbox.length = 0;
  const author = await account("user", "Autor 2 TEST");
  const leaving = await account("admin", "Odcházející správce TEST");
  // queued but not yet sent: hold the dispatch, then remove the membership
  const held: (() => Promise<void>)[] = [];
  setSupportSchedulerForTesting((task) => { held.push(task); });
  const created = await call(handleTicketCreate, author.token, { clientRequestId: randomUUID(), kind: "question", subject: "ZTEST přístup", description: "x", context: {} });
  auth.setMembership(leaving.id, "abf", undefined);
  mailer.allowed = (email) => email !== emailOf(people.admin2.id);
  for (const task of held) await task();
  setSupportSchedulerForTesting((task) => { scheduled.push(task()); });
  const rows = await store.listNotifications(created.body.ticket.id);
  const byRecipient = (id: string) => rows.find((row) => row.recipientId === id)!;
  assert.equal(byRecipient(leaving.id).status, "skipped");
  assert.match(byRecipient(leaving.id).lastError ?? "", /nemá k hlášení přístup/u);
  assert.equal(byRecipient(people.admin2.id).status, "skipped");
  assert.match(byRecipient(people.admin2.id).lastError ?? "", /SMTP_DEV_ALLOWED_RECIPIENTS/u);
  assert.equal(byRecipient(people.admin.id).status, "sent");
  assert.equal(mailsTo(emailOf(people.admin.id)).length, 1);
  mailer.allowed = () => true;
});

test("upozornění — selhání SMTP neblokuje uložení, automatické opakování s odstupem, souběžní odesílatelé neposílají dvakrát", async () => {
  mailer.configured = true;
  const author = await account("user", "Autor 3 TEST");
  const created = await call(handleTicketCreate, author.token, { clientRequestId: randomUUID(), kind: "bug", subject: "ZTEST SMTP", description: "x", context: {} });
  const ticketId = created.body.ticket.id as string;
  await flushNotifications();
  mailbox.length = 0;
  mailer.failNext = 1;
  const reply = await call(handleTicketReply, people.admin.token, { ticketId, clientRequestId: randomUUID(), body: "odpověď" });
  assert.equal(reply.status, 201, "the reply is saved although the e-mail failed");
  await flushNotifications();
  const row = () => [...store.notifications.values()].find((entry) => entry.ticketId === ticketId && entry.kind === "staff_reply")!;
  assert.equal(row().status, "failed");
  assert.equal(row().attempts, 1);
  assert.match(row().lastError ?? "", /ECONNECTION/u);
  // retry scheduled from the time of the failure (real clock in the sender) — move the test clock just past it
  clock = Date.parse(row().nextAttemptAt!) - 30_000;
  assert.equal((await dispatchSupportNotifications({ baseUrl: ORIGIN, ticketIds: [ticketId], now: () => new Date(clock) })).claimed, 0, "not due yet");
  clock = Date.parse(row().nextAttemptAt!) + 1000;
  const retried = await dispatchSupportNotifications({ baseUrl: ORIGIN, ticketIds: [ticketId], now: () => new Date(clock) });
  assert.deepEqual(retried, { claimed: 1, sent: 1, failed: 0, skipped: 0 });
  assert.equal(row().status, "sent");
  assert.equal(row().attempts, 2);
  assert.equal(mailsTo(emailOf(author.id)).length, 1);
  // a message that keeps failing is given up after the last attempt
  mailer.failNext = 99;
  await call(handleTicketUpdate, people.admin.token, { ticketId, expectedUpdatedAt: store.tickets.get(ticketId)!.updatedAt, status: "waiting" });
  await flushNotifications();
  const waiting = () => [...store.notifications.values()].find((entry) => entry.ticketId === ticketId && entry.kind === "waiting")!;
  for (let guard = 0; waiting().nextAttemptAt && guard < 10; guard++) {
    clock = Date.parse(waiting().nextAttemptAt!) + 1000;
    await dispatchSupportNotifications({ baseUrl: ORIGIN, ticketIds: [ticketId], now: () => new Date(clock) });
  }
  assert.equal(waiting().status, "failed");
  assert.equal(waiting().attempts, 6);
  assert.match(waiting().lastError ?? "", /Další pokusy se už nedělají/u);
  mailer.failNext = 0;
  // two senders at the same time: the second one finds nothing to take
  const hold: (() => Promise<void>)[] = [];
  setSupportSchedulerForTesting((task) => { hold.push(task); });
  await call(handleTicketReply, people.admin.token, { ticketId, clientRequestId: randomUUID(), body: "další" });
  setSupportSchedulerForTesting((task) => { scheduled.push(task()); });
  const first = await store.claimNotifications(10, [ticketId]);
  const second = await store.claimNotifications(10, [ticketId]);
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
});

test("upozornění — bez SMTP: uložení projde, záznam „neodesláno“, správce vidí, že upozornění nejsou aktivní; chyba fronty nic neblokuje", async () => {
  mailer.configured = false;
  mailbox.length = 0;
  const author = await account("user", "Autor 4 TEST");
  const created = await call(handleTicketCreate, author.token, { clientRequestId: randomUUID(), kind: "idea", subject: "ZTEST bez SMTP", description: "x", context: {} });
  assert.equal(created.status, 201);
  await flushNotifications();
  const rows = await store.listNotifications(created.body.ticket.id);
  assert.ok(rows.length >= 2 && rows.every((row) => row.status === "skipped" && /není nastavené/u.test(row.lastError ?? "")));
  assert.equal(mailbox.length, 0);
  const summary = (await call(handleSupportSummary, people.admin.token)).body;
  assert.equal(summary.notifications.active, false);
  assert.match(summary.notifications.reason, /SMTP_HOST/u);
  assert.equal((await call(handleSupportSummary, author.token)).body.notifications, undefined, "only managers see the mail setup");
  mailer.configured = true;
  assert.deepEqual((await call(handleSupportSummary, people.admin.token)).body.notifications, { active: true });
  store.failQueue = true;
  const saved = await call(handleTicketReply, people.admin.token, { ticketId: created.body.ticket.id, clientRequestId: randomUUID(), body: "odpověď" });
  store.failQueue = false;
  assert.equal(saved.status, 201, "a queue failure never fails the reply");
  await flushNotifications();
});

test("upozornění — cron: bez CRON_SECRET nedostupný, cizí token 401, správný token odešle frontu", async () => {
  const cron = (authorization?: string) => handleNotificationsDispatch(new NextRequest(`${ORIGIN}/api/support/notifications/dispatch`, { headers: authorization ? { authorization } : {} }));
  delete process.env.CRON_SECRET;
  assert.equal((await cron("Bearer x")).status, 503);
  process.env.CRON_SECRET = "test-cron-secret-0123456789";
  assert.equal((await cron()).status, 401);
  assert.equal((await cron("Bearer test-cron-secret-012345678X")).status, 401);
  mailer.configured = true;
  const response = await cron("Bearer test-cron-secret-0123456789");
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { ok: boolean }).ok, true);
  delete process.env.CRON_SECRET;
  assert.match(readFileSync("proxy.ts", "utf8"), /"\/api\/support\/notifications\/dispatch"/u, "reachable without a session; the route checks its own secret");
  await flushNotifications();
});

test("upozornění — selhání fronty je dohledatelné; správce doplní chybějící upozornění bez druhého hlášení a bez duplicit", async () => {
  mailer.configured = true;
  mailbox.length = 0;
  const author = await account("user", "Autor 5 TEST");
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  let created: Awaited<ReturnType<typeof call>>;
  let ticketId = "";
  try {
    store.failQueue = true;
    created = await call(handleTicketCreate, author.token, { clientRequestId: randomUUID(), kind: "bug", subject: "ZTEST výpadek fronty", description: "x", context: {} });
    ticketId = created.body.ticket.id;
    await call(handleTicketReply, people.admin.token, { ticketId, clientRequestId: randomUUID(), body: "odpověď při výpadku" });
    await call(handleTicketReply, people.admin.token, { ticketId, clientRequestId: randomUUID(), body: "interní", visibility: "internal" });
  } finally {
    store.failQueue = false;
    console.error = originalError;
  }
  assert.equal(created.status, 201, "the report is saved");
  await flushNotifications();
  // traceable: the log names the report number, its id and the event
  const line = logged.find((entry) => entry.includes(`created:${ticketId}`));
  assert.ok(line && line.includes("queueing failed") && line.includes(`"ticket":${created.body.ticket.number}`), line);
  assert.ok(logged.some((entry) => entry.includes("message:")), "the reply's gap is logged too");
  assert.equal((await store.listNotifications(ticketId)).length, 0);
  // the manager sees the gap (2 events: the new report, the public reply — never the internal note)
  const detail = (await call(handleTicketGet, people.admin.token, undefined, { id: ticketId })).body;
  assert.equal(detail.missingNotifications, 2);
  assert.equal((await call(handleTicketGet, author.token, undefined, { id: ticketId })).body.missingNotifications, undefined);
  assert.equal((await call(handleNotificationsRequeue, author.token, { ticketId })).status, 403);
  // queued later: same event keys → no second report, nobody twice
  const requeued = await call(handleNotificationsRequeue, people.admin.token, { ticketId });
  assert.equal(requeued.status, 200);
  assert.equal(requeued.body.events, 2);
  await flushNotifications();
  assert.equal((await call(handleTicketsList, author.token)).body.tickets.length, 1, "still one report");
  assert.equal(mailsTo(emailOf(author.id)).length, 1, "the author: the staff reply");
  assert.deepEqual(mailsTo(emailOf(people.admin.id)).map((mail) => mail.subject.split(":")[0]), [`Nové hlášení #${created.body.ticket.number}`], "the new report only — nothing about one's own reply");
  assert.ok(mailsTo(emailOf(people.admin2.id)).length >= 1, "managers: the new report");
  const again = await call(handleNotificationsRequeue, people.admin.token, { ticketId });
  assert.deepEqual(again.body, { events: 0, messages: 0 });
  assert.equal((await call(handleTicketGet, people.admin.token, undefined, { id: ticketId })).body.missingNotifications, 0);
  // a queued event is never queued again for another recipient (a new assignee)
  await call(handleTicketUpdate, people.admin.token, { ticketId, expectedUpdatedAt: store.tickets.get(ticketId)!.updatedAt, assigneeId: people.admin2.id });
  const rows = (await store.listNotifications(ticketId)).length;
  await call(handleNotificationsRequeue, people.admin.token, { ticketId });
  assert.equal((await store.listNotifications(ticketId)).length, rows);
  // the repeated submission of the same report also fills the gap and still returns the same report
  const author2 = await account("user", "Autor 6 TEST");
  const request = { clientRequestId: randomUUID(), kind: "idea", subject: "ZTEST opakování", description: "x", context: {} };
  console.error = () => undefined;
  store.failQueue = true;
  const first = await call(handleTicketCreate, author2.token, request);
  store.failQueue = false;
  console.error = originalError;
  const second = await call(handleTicketCreate, author2.token, request);
  await flushNotifications();
  assert.equal(second.body.ticket.id, first.body.ticket.id);
  assert.ok((await store.listNotifications(first.body.ticket.id)).length >= 2);
});
