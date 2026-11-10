import { NextResponse, type NextRequest } from "next/server.js";
import { hwsApp, parseRequestedAccess, type RequestedAccess } from "../../domain/hwsApps.ts";
import { SupabaseConfigurationError } from "../db/supabase.server.ts";
import { AuthSchemaNotMigratedError } from "../auth/authStore.server.ts";
import { authorizeAccounts } from "../auth/requestAuth.ts";
import { AppBaseUrlError, AuthGatewayError, appBaseUrl, authGateway, normalizeEmail, type AuthUserInfo } from "../auth/supabaseAuth.server.ts";
import { AccountConflictError, LastAdminError, accountsAdminStore, type AccountRecord } from "./accountsAdmin.supabase.ts";
import { InvitationSendError, invitationMailer } from "./invitationMailer.server.ts";

/**
 * Správa uživatelů HomeworkStudio (V1-AUTH-02). Every handler requires the shared administration's
 * own permission (authorizeAccounts — app_users.is_hws_admin), also when called directly; an ABF
 * administrator without it gets 403. No public sign-up.
 *
 * Invitation = account (Supabase Auth + app_users, idempotent) → invitation row "access_pending" →
 * memberships (one transaction) → "ready" → optionally e-mail ("sent" / "send_failed"). A failure
 * leaves a traceable state and the same request can simply be repeated: no second account, no
 * duplicate membership. An existing activated account is never re-invited (its password is never
 * touched) — its access is edited instead. Links and tokens are returned to the administrator only
 * and never logged.
 */
const LINK_NOTE = "Odkaz je jednorázový a platí omezenou dobu (podle nastavení Supabase Auth, výchozí 24 h). Předejte ho bezpečnou cestou.";

function errorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof LastAdminError) return NextResponse.json({ error: error.message, code: error.scope === "hws" ? "last_hws_admin" : "last_app_admin", appKey: error.appKey }, { status: 409 });
  if (error instanceof AccountConflictError) return NextResponse.json({ error: error.message, code: "conflict" }, { status: 409 });
  if (error instanceof AuthGatewayError) return NextResponse.json({ error: error.message, code: error.code }, { status: 502 });
  if (error instanceof AppBaseUrlError) return NextResponse.json({ error: error.message, code: "config" }, { status: 503 });
  if (error instanceof AuthSchemaNotMigratedError || error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message, code: "config" }, { status: 503 });
  console.error(`Accounts admin: ${fallback}`, error instanceof Error ? error.message : error);
  return NextResponse.json({ error: fallback }, { status: 502 });
}

async function readJson(request: NextRequest): Promise<Record<string, unknown> | undefined> {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const displayNameOf = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : null);
const confirmLink = (base: string, tokenHash: string, type: "invite" | "recovery") => `${base}/auth/confirm?token_hash=${encodeURIComponent(tokenHash)}&type=${type}`;
/** An account counts as activated once its e-mail link was used (password set) or it ever signed in. */
export const isActivated = (info: AuthUserInfo | undefined) => Boolean(info?.confirmedAt || info?.lastSignInAt);
const appNames = (access: readonly RequestedAccess[]) => access.map((entry) => hwsApp(entry.appKey)?.name ?? entry.appKey);

export type AccountView = AccountRecord & Readonly<{ activated: boolean; lastSignInAt: string | null }>;

async function withAuthInfo(accounts: readonly AccountRecord[]): Promise<AccountView[]> {
  const gateway = authGateway();
  return Promise.all(accounts.map(async (account) => {
    const info = await gateway.authUserInfo(account.id).catch(() => undefined);
    return { ...account, activated: isActivated(info), lastSignInAt: info?.lastSignInAt ?? null };
  }));
}

function mailerSummary() {
  const mailer = invitationMailer();
  const state = mailer.state();
  return state.configured === false ? { configured: false as const, reason: state.reason } : { configured: true as const };
}

export async function handleAccountsList(request: NextRequest): Promise<NextResponse> {
  const decision = await authorizeAccounts(request);
  if (decision.ok === false) return decision.response;
  try {
    const store = accountsAdminStore();
    const [accounts, apps] = await Promise.all([store.list(), store.apps()]);
    return NextResponse.json({ accounts: await withAuthInfo(accounts), apps, mailer: mailerSummary(), currentUserId: decision.auth.user.id });
  } catch (error) {
    return errorResponse(error, "Seznam uživatelů se nepodařilo načíst.");
  }
}

type Delivery = "manual" | "email";
const deliveryOf = (value: unknown): Delivery => (value === "email" ? "email" : "manual");

/**
 * Sends the link when e-mail delivery was asked for and is possible. Returns what the administrator
 * must be told — never "odesláno" unless the SMTP server accepted the message.
 */
async function deliver(invitationId: string | null, account: Readonly<{ email: string; displayName: string | null }>, link: string, kind: "invite" | "recovery", access: readonly RequestedAccess[], delivery: Delivery) {
  const store = accountsAdminStore();
  const mailer = invitationMailer();
  if (delivery !== "email") return { emailSent: false, link, notice: "Odkaz předejte uživateli bezpečnou cestou." };
  const state = mailer.state();
  const refusal = state.configured === false ? state.reason : !mailer.recipientAllowed(account.email) ? "Ve vývoji (DEV) lze posílat jen na adresy ze SMTP_DEV_ALLOWED_RECIPIENTS — odkaz předejte ručně." : undefined;
  if (refusal) {
    if (invitationId) await store.updateInvitation(invitationId, { status: "send_failed", lastError: refusal });
    return { emailSent: false, link, notice: refusal };
  }
  try {
    await mailer.send({ to: account.email, displayName: account.displayName, link, appNames: appNames(access), kind });
    if (invitationId) await store.updateInvitation(invitationId, { status: "sent", lastError: null });
    return { emailSent: true, link: undefined, notice: `E-mail byl odeslán na ${account.email}.` };
  } catch (error) {
    const reason = error instanceof InvitationSendError ? error.message : "E-mail se nepodařilo odeslat.";
    if (invitationId) await store.updateInvitation(invitationId, { status: "send_failed", lastError: reason });
    // the account and its access stay; the administrator can hand the link over or try again
    return { emailSent: false, link, notice: `${reason} Účet i přístupy zůstaly uložené — odkaz předejte ručně nebo odeslání zopakujte.` };
  }
}

/** Pozvat uživatele: jméno, e-mail, aplikace s rolemi. */
export async function handleAccountInvite(request: NextRequest): Promise<NextResponse> {
  const decision = await authorizeAccounts(request);
  if (decision.ok === false) return decision.response;
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  if (!email) return NextResponse.json({ error: "Zadejte platný e-mail." }, { status: 400 });
  const parsed = parseRequestedAccess(body?.access);
  if (parsed.ok === false) return NextResponse.json({ error: parsed.error }, { status: 400 });
  if (parsed.access.length === 0) return NextResponse.json({ error: "Zaškrtněte alespoň jednu aplikaci." }, { status: 400 });
  const access = parsed.access;
  const delivery = deliveryOf(body?.delivery);
  const actorId = decision.auth.user.id;
  try {
    const base = appBaseUrl(request.url);
    const store = accountsAdminStore();
    const gateway = authGateway();
    const existing = await store.findByEmail(email);
    if (existing) {
      const info = await gateway.authUserInfo(existing.id).catch(() => undefined);
      // Never a second account, never a password reset of an activated account.
      if (isActivated(info)) return NextResponse.json({ error: "Účet s tímto e-mailem už existuje a je aktivovaný — upravte jeho přístupy v seznamu.", code: "account_exists", userId: existing.id }, { status: 409 });
    }
    // New account (or a pending one again): Supabase Auth creates / finds the identity — no e-mail is sent here.
    let link: { userId: string; tokenHash: string; type: "invite" | "recovery" };
    try {
      link = { ...(await gateway.generateLink("invite", email, `${base}/auth/callback`)), type: "invite" };
    } catch (error) {
      if (!(error instanceof AuthGatewayError) || error.code !== "email_exists") throw error;
      // An identity without a password yet (pending invite) or without a profile: a set-password link.
      link = { ...(await gateway.generateLink("recovery", email, `${base}/auth/callback`)), type: "recovery" };
    }
    if (existing && existing.id !== link.userId) throw new AccountConflictError("E-mail patří jinému účtu Supabase Auth — pozvánka zastavena.");
    const account = await store.ensureAccount({ id: link.userId, email, displayName: displayNameOf(body?.displayName) ?? existing?.displayName ?? null, createdBy: actorId });
    const invitation = await store.createInvitation({ userId: account.id, access, delivery, createdBy: actorId });
    try {
      // Existing memberships of other applications stay; the requested ones get the requested role.
      const merged = new Map<string, RequestedAccess>(Object.entries(account.apps).map(([appKey, role]) => [appKey, { appKey, role } as RequestedAccess]));
      for (const entry of access) merged.set(entry.appKey, entry);
      await store.setMemberships(account.id, [...merged.values()], actorId);
    } catch (error) {
      await store.updateInvitation(invitation.id, { status: "access_pending", lastError: error instanceof LastAdminError || error instanceof AccountConflictError ? error.message : "Přístupy se nepodařilo uložit." }).catch(() => undefined);
      const response = errorResponse(error, "Přístupy se nepodařilo uložit — pozvánka zůstala nedokončená, zopakujte ji.");
      return response;
    }
    await store.updateInvitation(invitation.id, { status: "ready", lastError: null });
    const result = await deliver(invitation.id, { email, displayName: account.displayName }, confirmLink(base, link.tokenHash, link.type), link.type, access, delivery);
    const saved = await store.get(account.id);
    return NextResponse.json({ account: saved, ...result, linkNote: result.link ? LINK_NOTE : undefined, resumed: Boolean(existing) }, { status: existing ? 200 : 201 });
  } catch (error) {
    return errorResponse(error, "Pozvánku se nepodařilo vytvořit.");
  }
}

/** Jméno, aktivní stav, správce HomeworkStudia a přístupy do aplikací. Heslo se nikdy nemění. */
export async function handleAccountUpdate(request: NextRequest): Promise<NextResponse> {
  const decision = await authorizeAccounts(request);
  if (decision.ok === false) return decision.response;
  const body = await readJson(request);
  const userId = typeof body?.userId === "string" ? body.userId : "";
  const expectedUpdatedAt = typeof body?.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : "";
  if (!userId || !expectedUpdatedAt) return NextResponse.json({ error: "Chybí uživatel nebo verze záznamu." }, { status: 400 });
  const patch: { displayName?: string | null; isActive?: boolean; isHwsAdmin?: boolean; access?: readonly RequestedAccess[] } = {};
  if (body!.displayName !== undefined) patch.displayName = displayNameOf(body!.displayName);
  for (const key of ["isActive", "isHwsAdmin"] as const) {
    if (body![key] === undefined) continue;
    if (typeof body![key] !== "boolean") return NextResponse.json({ error: "Neplatná hodnota." }, { status: 400 });
    patch[key] = body![key] as boolean;
  }
  if (body!.access !== undefined) {
    const parsed = parseRequestedAccess(body!.access);
    if (parsed.ok === false) return NextResponse.json({ error: parsed.error }, { status: 400 });
    patch.access = parsed.access;
  }
  if (userId === decision.auth.user.id && (patch.isActive === false || patch.isHwsAdmin === false)) {
    return NextResponse.json({ error: "Vlastní účet ani vlastní správu HomeworkStudia si nelze vypnout — požádejte jiného správce.", code: "self_change" }, { status: 403 });
  }
  try {
    const store = accountsAdminStore();
    if (!(await store.get(userId))) return NextResponse.json({ error: "Uživatel neexistuje." }, { status: 404 });
    const written = await store.updateAccount(userId, patch, expectedUpdatedAt, decision.auth.user.id);
    if (!written) return NextResponse.json({ error: "Účet byl mezitím změněn jinde. Obnovte seznam a zkuste to znovu.", code: "stale" }, { status: 409 });
    return NextResponse.json({ account: await store.get(userId) });
  } catch (error) {
    return errorResponse(error, "Změnu účtu se nepodařilo uložit.");
  }
}

/**
 * Nový odkaz: dokončení pozvánky (účet ještě nenastavil heslo) nebo — výslovně — nastavení nového
 * hesla aktivovaného účtu. Heslo se změní až tím, že uživatel odkaz použije.
 */
export async function handleAccountLink(request: NextRequest): Promise<NextResponse> {
  const decision = await authorizeAccounts(request);
  if (decision.ok === false) return decision.response;
  const body = await readJson(request);
  const userId = typeof body?.userId === "string" ? body.userId : "";
  const delivery = deliveryOf(body?.delivery);
  try {
    const store = accountsAdminStore();
    const account = await store.get(userId);
    if (!account) return NextResponse.json({ error: "Uživatel neexistuje." }, { status: 404 });
    if (!account.isActive) return NextResponse.json({ error: "Účet je deaktivovaný — nejdřív ho aktivujte." }, { status: 409 });
    const base = appBaseUrl(request.url);
    const gateway = authGateway();
    const activated = isActivated(await gateway.authUserInfo(account.id).catch(() => undefined));
    let type: "invite" | "recovery" = activated ? "recovery" : "invite";
    let tokenHash: string;
    try {
      tokenHash = (await gateway.generateLink(type, account.email, `${base}/auth/callback`)).tokenHash;
    } catch (error) {
      if (type !== "invite" || !(error instanceof AuthGatewayError) || error.code !== "email_exists") throw error;
      type = "recovery";
      tokenHash = (await gateway.generateLink("recovery", account.email, `${base}/auth/callback`)).tokenHash;
    }
    const access = Object.entries(account.apps).map(([appKey, role]) => ({ appKey, role }) as RequestedAccess);
    // A pending account gets a new invitation record (traceable); a password reset is not an invitation.
    const invitation = activated ? null : await store.createInvitation({ userId: account.id, access, delivery, createdBy: decision.auth.user.id });
    if (invitation) await store.updateInvitation(invitation.id, { status: "ready", lastError: null });
    const result = await deliver(invitation?.id ?? null, account, confirmLink(base, tokenHash, type), activated ? "recovery" : "invite", access, delivery);
    return NextResponse.json({ kind: activated ? "recovery" : "invite", ...result, linkNote: result.link ? LINK_NOTE : undefined });
  } catch (error) {
    return errorResponse(error, "Odkaz se nepodařilo vytvořit.");
  }
}
