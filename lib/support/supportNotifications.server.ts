import { timingSafeEqual } from "node:crypto";
import { after, NextResponse, type NextRequest } from "next/server.js";
import { hwsApp } from "../../domain/hwsApps.ts";
import {
  mayReceiveNotification,
  nextNotificationAttempt,
  planNotifications,
  supportRoleOf,
  type NotificationAudience,
  type NotificationEvent,
  type NotificationKind,
  type SupportAppKey,
} from "../../domain/support.ts";
import { InvitationSendError, recipientAllowedIn, sendSmtpMail, smtpState, type MailContent, type MailerState } from "../accounts/invitationMailer.server.ts";
import { authStore } from "../auth/authStore.server.ts";
import { appBaseUrl } from "../auth/supabaseAuth.server.ts";
import { supportStore, type NotificationRecord, type TicketRecord } from "./supportStore.supabase.ts";

/**
 * V1-SUPPORT-02 — e-mail notifications of in-app support through the company SMTP.
 *
 * Saving a report or a reply only QUEUES messages (support_notifications, one row per event and
 * recipient — a repeated request queues nothing new); a failure there is logged and never fails the
 * save. Sending happens after the response (next/server after()) and, for retries, from the
 * dispatcher (cron route /api/support/notifications/dispatch and opportunistically from the support
 * summary every open client polls). Right before each message the recipient is checked again: active
 * account, still a member of the application, still allowed to read the report; the address is the
 * CURRENT e-mail of the account. A message carries the report number, its subject, a short notice and
 * a link — never the text of a reply, an internal note or an attachment.
 */
export interface SupportMailer {
  state(): MailerState;
  recipientAllowed(email: string): boolean;
  send(mail: MailContent): Promise<void>;
}

const smtpSupportMailer: SupportMailer = {
  state: () => smtpState(undefined, ""),
  recipientAllowed: (email) => recipientAllowedIn(email),
  send: (mail) => sendSmtpMail(mail),
};

type Scheduler = (task: () => Promise<void>) => void;
/** After the response; outside a request (scripts) the task simply runs. */
const afterResponse: Scheduler = (task) => {
  try {
    after(task);
  } catch {
    void task();
  }
};

let mailerOverride: SupportMailer | undefined;
let schedulerOverride: Scheduler | undefined;
export const supportMailer = (): SupportMailer => mailerOverride ?? smtpSupportMailer;
/** Tests only — records messages instead of sending them. */
export function setSupportMailerForTesting(mailer: SupportMailer | undefined): void {
  mailerOverride = mailer;
}
/** Tests only — run (and await) the dispatch instead of after(). */
export function setSupportSchedulerForTesting(scheduler: Scheduler | undefined): void {
  schedulerOverride = scheduler;
}

export function supportNotificationState(): Readonly<{ active: boolean; reason?: string }> {
  const state = supportMailer().state();
  return state.configured === false ? { active: false, reason: state.reason } : { active: true };
}

// ---------------------------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------------------------
type QueueInput = Readonly<{ ticket: TicketRecord; actorId: string; event: NotificationEvent; eventKey: string }>;

async function enqueuePlanned(input: QueueInput, managerIds: readonly string[]): Promise<number> {
  const planned = planNotifications({ event: input.event, actorId: input.actorId, authorId: input.ticket.authorId, assigneeId: input.ticket.assigneeId, managerIds });
  if (!planned.length) return 0;
  const state = supportMailer().state();
  await supportStore().enqueueNotifications(planned.map((entry) => ({
    appKey: input.ticket.appKey, ticketId: input.ticket.id, recipientId: entry.recipientId, eventKey: input.eventKey, kind: entry.kind, audience: entry.audience,
    // recorded even without SMTP, so the administrator can see what was not sent and why
    ...(state.configured === false ? { status: "skipped" as const, lastError: shortError(state.reason) } : {}),
  })));
  return planned.length;
}

/**
 * Never throws: a notification problem must not turn a saved report or reply into an error. A failure
 * is logged with the report number, its id and the event key (searchable in the hosting logs); the
 * manager also sees the gap in the report detail and fills it with requeueTicketNotifications.
 */
export async function queueSupportNotifications(input: QueueInput): Promise<number> {
  try {
    const managers = await supportStore().activeAppAdmins(input.ticket.appKey);
    return await enqueuePlanned(input, managers.map((admin) => admin.id));
  } catch (error) {
    console.error("Support notifications: queueing failed", JSON.stringify({ ticket: input.ticket.number, ticketId: input.ticket.id, eventKey: input.eventKey, error: error instanceof Error ? error.message : String(error) }));
    return 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Gaps: events of a report that have no notification record at all (the queueing failed)
// ---------------------------------------------------------------------------------------------
/** How far back a missing notification is still worth sending later. */
export const REQUEUE_WINDOW_DAYS = 7;

/**
 * The report's events rebuilt from saved data (the report, its replies, its status history) with the
 * same event keys as when they happened, limited to those that would notify someone and have NO
 * record in the outbox — an event that was queued (sent, skipped or failed) is never queued again,
 * not even for a different recipient (e.g. a new assignee).
 */
export async function missingTicketNotifications(ticket: TicketRecord, now: Date = new Date()): Promise<readonly QueueInput[]> {
  const store = supportStore();
  const since = now.getTime() - REQUEUE_WINDOW_DAYS * 24 * 3600 * 1000;
  const [messages, events, existing, managers] = await Promise.all([store.listMessages(ticket.id), store.listEvents(ticket.id), store.listNotifications(ticket.id), store.activeAppAdmins(ticket.appKey)]);
  const known = new Set(existing.map((row) => row.eventKey));
  const managerIds = managers.map((admin) => admin.id);
  const candidates: (QueueInput & { at: string })[] = [
    { ticket, actorId: ticket.authorId ?? "", event: { type: "created" }, eventKey: `created:${ticket.id}`, at: ticket.createdAt },
    ...messages.map((message) => ({ ticket, actorId: message.authorId ?? "", event: { type: "message" as const, visibility: message.visibility }, eventKey: `message:${message.id}`, at: message.createdAt })),
    ...events
      .filter((event) => (event.type === "status" || event.type === "reopened") && (event.toValue === "waiting" || event.toValue === "resolved"))
      .map((event) => ({ ticket, actorId: event.actorId ?? "", event: { type: "status" as const, to: event.toValue as "waiting" | "resolved" }, eventKey: `event:${event.id}`, at: event.createdAt })),
  ];
  return candidates.filter((candidate) => Date.parse(candidate.at) >= since && !known.has(candidate.eventKey) && planNotifications({ event: candidate.event, actorId: candidate.actorId, authorId: ticket.authorId, assigneeId: ticket.assigneeId, managerIds }).length > 0);
}

/** Queues the missing notifications of one report (manager action). Throws when the queue still fails. */
export async function requeueTicketNotifications(ticket: TicketRecord): Promise<Readonly<{ events: number; messages: number }>> {
  const missing = await missingTicketNotifications(ticket);
  const managers = (await supportStore().activeAppAdmins(ticket.appKey)).map((admin) => admin.id);
  let messages = 0;
  for (const entry of missing) messages += await enqueuePlanned(entry, managers);
  return { events: missing.length, messages };
}

// ---------------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------------
const shortError = (text: string) => text.slice(0, 300);
const oneLine = (text: string, max: number) => text.replace(/[\r\n\t]+/gu, " ").trim().slice(0, max);
const escapeHtml = (text: string) => text.replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

const NOTICE: Readonly<Record<NotificationKind, (number: number) => Readonly<{ subject: string; lead: string }>>> = {
  new_ticket: (n) => ({ subject: `Nové hlášení #${n}`, lead: "V aplikaci bylo založeno nové hlášení." }),
  staff_reply: (n) => ({ subject: `Odpověď na hlášení #${n}`, lead: "Správce aplikace odpověděl na vaše hlášení." }),
  waiting: (n) => ({ subject: `Hlášení #${n} čeká na doplnění`, lead: "Správce aplikace vás žádá o doplnění informací k hlášení." }),
  resolved: (n) => ({ subject: `Hlášení #${n} je vyřešené`, lead: "Vaše hlášení bylo označeno jako vyřešené. Pokud problém trvá, odpovězte v aplikaci." }),
  author_reply: (n) => ({ subject: `Doplnění k hlášení #${n}`, lead: "Autor hlášení odpověděl." }),
};

export function supportTicketLink(baseUrl: string, appKey: SupportAppKey, ticketId: string, audience: NotificationAudience): string {
  const appPath = hwsApp(appKey)?.url ?? `/${appKey}`;
  return `${baseUrl}${appPath}#/podpora/${audience === "manager" ? "sprava/hlaseni" : "hlaseni"}/${ticketId}`;
}

/** Number, subject, a short notice and the link — the content of the report stays in the application. */
export function supportNotificationEmail(input: Readonly<{ kind: NotificationKind; number: number; ticketSubject: string; appName: string; link: string; to: string; recipientName: string | null }>): MailContent {
  const notice = NOTICE[input.kind](input.number);
  const subjectLine = oneLine(input.ticketSubject, 120);
  const greeting = input.recipientName ? `Dobrý den, ${oneLine(input.recipientName, 80)},` : "Dobrý den,";
  const text = `${greeting}\n\n${notice.lead}\n\nHlášení #${input.number}: ${subjectLine}\nAplikace: ${input.appName}\n\nDetail (po přihlášení):\n${input.link}\n\nPřílohy a celé znění najdete v aplikaci. Toto je automatické upozornění, neodpovídejte na něj.\n\nHomeworkStudio`;
  const html = `<p>${escapeHtml(greeting)}</p><p>${escapeHtml(notice.lead)}</p><p><strong>Hlášení #${input.number}:</strong> ${escapeHtml(subjectLine)}<br>Aplikace: ${escapeHtml(input.appName)}</p><p><a href="${escapeHtml(input.link)}">Otevřít detail hlášení</a> (po přihlášení)</p><p>Přílohy a celé znění najdete v aplikaci. Toto je automatické upozornění, neodpovídejte na něj.</p><p>HomeworkStudio</p>`;
  return { to: input.to, subject: `${notice.subject}: ${subjectLine} — ${input.appName}`, text, html };
}

export type DispatchResult = Readonly<{ claimed: number; sent: number; failed: number; skipped: number }>;

export async function dispatchSupportNotifications(input: Readonly<{ baseUrl: string | null; ticketIds?: readonly string[]; limit?: number; now?: () => Date }>): Promise<DispatchResult> {
  const store = supportStore();
  const mailer = supportMailer();
  const now = input.now ?? (() => new Date());
  const claimed = await store.claimNotifications(input.limit ?? 20, input.ticketIds);
  const result = { claimed: claimed.length, sent: 0, failed: 0, skipped: 0 };
  const skip = async (record: NotificationRecord, reason: string) => {
    await store.finishNotification(record.id, { status: "skipped", lastError: shortError(reason) });
    result.skipped += 1;
  };
  const fail = async (record: NotificationRecord, reason: string) => {
    const next = nextNotificationAttempt(record.attempts, now());
    await store.finishNotification(record.id, { status: "failed", lastError: shortError(next ? reason : `${reason} Další pokusy se už nedělají.`), nextAttemptAt: next?.toISOString() ?? null });
    result.failed += 1;
  };
  for (const record of claimed) {
    try {
      const state = mailer.state();
      if (state.configured === false) {
        await skip(record, state.reason);
        continue;
      }
      const ticket = await store.getTicket(record.ticketId);
      if (!ticket) {
        await skip(record, "Hlášení už neexistuje.");
        continue;
      }
      // the recipient's CURRENT access and address
      const user = await authStore().findUserById(record.recipientId);
      const role = user ? supportRoleOf(record.appKey, user.apps[record.appKey]) : undefined;
      if (!user || !mayReceiveNotification({ audience: record.audience, role, isActive: user.isActive, isAuthor: ticket.authorId === user.id })) {
        await skip(record, "Příjemce už nemá k hlášení přístup.");
        continue;
      }
      if (!mailer.recipientAllowed(user.email)) {
        await skip(record, "Vývoj (DEV): adresa příjemce není v SMTP_DEV_ALLOWED_RECIPIENTS.");
        continue;
      }
      if (!input.baseUrl) {
        await fail(record, "Chybí adresa aplikace (APP_BASE_URL).");
        continue;
      }
      const mail = supportNotificationEmail({
        kind: record.kind, number: ticket.number, ticketSubject: ticket.subject, appName: hwsApp(record.appKey)?.name ?? record.appKey,
        link: supportTicketLink(input.baseUrl, record.appKey, ticket.id, record.audience), to: user.email, recipientName: user.displayName,
      });
      try {
        await mailer.send(mail);
      } catch (error) {
        await fail(record, error instanceof InvitationSendError ? error.message : "E-mail se nepodařilo odeslat.");
        continue;
      }
      await store.finishNotification(record.id, { status: "sent" });
      result.sent += 1;
    } catch (error) {
      // a database problem with one row: it stays claimed and becomes due again when the lock expires
      console.error("Support notifications: dispatch of one message failed", error instanceof Error ? error.message : error);
    }
  }
  return result;
}

const baseUrlOf = (request: NextRequest) => {
  try {
    return appBaseUrl(request.url);
  } catch {
    return null;
  }
};

/** Sends after the response — the user's save never waits for SMTP. */
export function scheduleSupportDispatch(request: NextRequest, ticketIds?: readonly string[], limit = 20): void {
  const baseUrl = baseUrlOf(request);
  (schedulerOverride ?? afterResponse)(async () => {
    try {
      await dispatchSupportNotifications({ baseUrl, ticketIds, limit });
    } catch (error) {
      console.error("Support notifications: dispatch failed", error instanceof Error ? error.message : error);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Cron route: GET /api/support/notifications/dispatch with "Authorization: Bearer <CRON_SECRET>"
// ---------------------------------------------------------------------------------------------
function secretMatches(header: string | null, secret: string): boolean {
  const given = Buffer.from(header ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function handleNotificationsDispatch(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || secret.length < 16) return NextResponse.json({ error: "Automatické odesílání není nastavené (CRON_SECRET).", code: "cron_not_configured" }, { status: 503 });
  if (!secretMatches(request.headers.get("authorization"), secret)) return NextResponse.json({ error: "Neplatné oprávnění.", code: "unauthenticated" }, { status: 401 });
  try {
    const result = await dispatchSupportNotifications({ baseUrl: baseUrlOf(request), limit: 50 });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("Support notifications: cron dispatch failed", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Odesílání upozornění selhalo." }, { status: 502 });
  }
}
