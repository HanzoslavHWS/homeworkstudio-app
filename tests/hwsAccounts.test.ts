import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server.js";
import { AUTH_COOKIE_NAME } from "../lib/auth/session.ts";
import { HWS_APPS, canManageAccounts, hasAppAccess, invitationSucceeded, isValidAppRole, launcherEntries, parseRequestedAccess, type AppMemberships, type InvitationStatus, type RequestedAccess } from "../domain/hwsApps.ts";
import { authenticate, authenticateAccount, authorize, authorizeAccounts, authorizeFile, authorizeProject } from "../lib/auth/requestAuth.ts";
import { appBaseUrl, setAuthGatewayForTesting, type AuthGateway, type AuthUserInfo } from "../lib/auth/supabaseAuth.server.ts";
import { handleAccountInvite, handleAccountLink, handleAccountsList, handleAccountUpdate } from "../lib/accounts/accountsAdminApi.server.ts";
import { AccountConflictError, LastAdminError, accountsError, setAccountsAdminStoreForTesting, type AccountRecord, type AccountsAdminStore, type InvitationRecord } from "../lib/accounts/accountsAdmin.supabase.ts";
import { invitationText, recipientAllowedIn, setInvitationMailerForTesting, smtpState, type InvitationMailer, type InvitationMessage } from "../lib/accounts/invitationMailer.server.ts";
import { createTestSession, testAuthStore } from "./helpers/testAuth.ts";

const SECRET = "test-session-secret-with-at-least-32-characters";
process.env.APP_SESSION_SECRET = SECRET;
process.env.NEXT_PUBLIC_APP_ENV = "development";
delete process.env.APP_BASE_URL;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;
const store = testAuthStore();
const ORIGIN = "http://localhost:3000";

function request(pathname: string, init: Readonly<{ token?: string; body?: unknown }> = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (init.token) headers.cookie = `${AUTH_COOKIE_NAME}=${init.token}`;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    headers.accept = "application/json";
  }
  return new NextRequest(`${ORIGIN}${pathname}`, { method: init.body !== undefined ? "POST" : "GET", headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
}
const json = async (response: Response) => (await response.json()) as Record<string, unknown>;
const status = async (decision: Promise<{ ok: boolean; response?: Response }>) => {
  const result = await decision;
  return result.ok ? 200 : (result as { response: Response }).response.status;
};
const code = async (decision: Promise<{ ok: boolean }>) => {
  const result = await decision;
  return result.ok ? "ok" : ((await (result as unknown as { response: Response }).response.json()) as { code: string }).code;
};

// =============================================================================================
// Domain: registry, roles, access
// =============================================================================================
test("registr aplikací: role platí jen pro svou aplikaci; nepřidělený přístup = zákaz; správce HWS neotevírá aplikace", () => {
  assert.equal(isValidAppRole("abf", "admin"), true);
  assert.equal(isValidAppRole("abf", "owner"), false);
  assert.equal(isValidAppRole("hws-easy", "external"), false, "an ABF role is not valid in another application");
  assert.equal(isValidAppRole("nonexistent", "user"), false);
  const hwsOnly = { isActive: true, isHwsAdmin: true, apps: {} };
  assert.equal(canManageAccounts(hwsOnly), true);
  assert.equal(hasAppAccess(hwsOnly, "abf"), false);
  assert.equal(canManageAccounts({ isActive: true, isHwsAdmin: false, apps: { abf: "admin" } }), false, "an ABF admin is not a shared admin");
  assert.equal(canManageAccounts({ isActive: false, isHwsAdmin: true, apps: {} }), false);
  assert.equal(hasAppAccess({ isActive: false, isHwsAdmin: false, apps: { abf: "admin" } }, "abf"), false, "global deactivation blocks every application");
  assert.deepEqual(launcherEntries({ isActive: true, isHwsAdmin: false, apps: { abf: "user", "hws-easy": "user" } }).map((entry) => [entry.app.key, entry.opens]), [["abf", true], ["hws-easy", false]]);
  for (const app of HWS_APPS) if (app.status === "coming_soon") assert.equal(app.url, null, `${app.key} must not open an address`);
});

test("přístupy z formuláře: každá aplikace jednou, s platnou rolí; nezaškrtnutá aplikace v požadavku vůbec není", () => {
  assert.deepEqual(parseRequestedAccess([{ appKey: "abf", role: "external" }, { appKey: "hws-easy", role: "user" }]), { ok: true, access: [{ appKey: "abf", role: "external" }, { appKey: "hws-easy", role: "user" }] });
  assert.equal(parseRequestedAccess([{ appKey: "abf", role: "user" }, { appKey: "abf", role: "admin" }]).ok, false, "no duplicate application");
  assert.equal(parseRequestedAccess([{ appKey: "abf", role: "superuser" }]).ok, false);
  assert.equal(parseRequestedAccess([{ appKey: "evil", role: "user" }]).ok, false);
  assert.equal(parseRequestedAccess("abf").ok, false);
  assert.equal(invitationSucceeded("access_pending"), false, "an invitation counts only after its access was stored");
  assert.equal(invitationSucceeded("send_failed"), true, "a failed e-mail does not undo stored access");
});

// =============================================================================================
// Server checks: ABF membership, open sessions, deactivation, shared administration
// =============================================================================================
test("ABF vyžaduje členství; odebrání členství i změna role platí v už otevřené session; jiné aplikace se neovlivňují", async () => {
  const session = await createTestSession(SECRET, { role: "user", apps: { "hws-easy": "user" } });
  store.assign(session.user.id, "p-open");
  const req = () => request("/api/catalog/items", { token: session.token });
  assert.equal(await status(authorize(req(), "catalog.read")), 200);
  assert.equal(await status(authorizeProject(req(), "p-open", "write")), 200);
  // role change ABF user → external: the same cookie, the next request
  store.setRole(session.user.id, "external");
  assert.equal(await status(authorize(req(), "catalog.read")), 403);
  assert.equal(await status(authorizeProject(req(), "p-open", "write")), 403);
  assert.equal(await status(authorizeProject(req(), "p-open", "read")), 200, "external still reads its assignment");
  // ABF membership removed: the remaining project assignment opens nothing (pages, API, files)
  store.setMembership(session.user.id, "abf", undefined);
  assert.equal(await code(authenticate(req())), "no_app_access");
  assert.equal(await status(authorizeProject(req(), "p-open", "read")), 403);
  assert.equal(await status(authorizeFile(req(), "projects/p-open/exports/plan.pdf", "read")), 403);
  // the account itself is fine and still has its other application
  const account = await authenticateAccount(req());
  assert.equal(account.ok, true);
  assert.deepEqual((account as { auth: { user: { apps: AppMemberships } } }).auth.user.apps, { "hws-easy": "user" });
  // ABF back with a role → access back; project assignment and history were never touched
  store.setRole(session.user.id, "user");
  assert.equal(await status(authorizeProject(req(), "p-open", "write")), 200);
});

test("globální deaktivace zablokuje všechny aplikace i společnou správu (403 účet deaktivován)", async () => {
  const session = await createTestSession(SECRET, { role: "admin", isHwsAdmin: true, apps: { "hws-easy": "user" } });
  assert.equal(await status(authorizeAccounts(request("/api/hws/accounts", { token: session.token }))), 200);
  store.setActive(session.user.id, false);
  for (const decision of [authenticate(request("/x", { token: session.token })), authenticateAccount(request("/x", { token: session.token })), authorizeAccounts(request("/x", { token: session.token }))]) {
    assert.equal(await status(decision), 403);
  }
});

test("společná správa: jen správce HomeworkStudia — samotný správce ABF ne; správce HWS bez ABF do ABF nevstoupí", async () => {
  const abfAdmin = await createTestSession(SECRET, { role: "admin" });
  const hwsOnly = await createTestSession(SECRET, { role: null, isHwsAdmin: true });
  assert.equal(await status(authorizeAccounts(request("/api/hws/accounts", { token: abfAdmin.token }))), 403);
  assert.equal(await status(authorizeAccounts(request("/api/hws/accounts", { token: hwsOnly.token }))), 200);
  assert.equal(await code(authorize(request("/api/catalog/items", { token: hwsOnly.token }), "catalog.read")), "no_app_access");
});

// =============================================================================================
// Shared administration API (in-memory store + fake Supabase Auth + recording mailer)
// =============================================================================================
type Gateway = AuthGateway & { links: Array<{ type: string; email: string }>; passwords: string[]; info: Map<string, AuthUserInfo> };
function fakeGateway(): Gateway {
  const ids = new Map<string, string>();
  const gateway: Gateway = {
    links: [],
    passwords: [],
    info: new Map(),
    async signInWithPassword() { return { ok: false, reason: "invalid" }; },
    async verifyEmailLinkToken() { return undefined; },
    async verifyAccessToken() { return undefined; },
    async generateLink(type, email) {
      gateway.links.push({ type, email });
      if (!ids.has(email)) ids.set(email, crypto.randomUUID());
      return { userId: ids.get(email)!, tokenHash: `hash-${type}-${gateway.links.length}` };
    },
    async createConfirmedUser() { return crypto.randomUUID(); },
    async setPassword(_userId, password) { gateway.passwords.push(password); },
    async sendRecoveryEmail() {},
    async authUserInfo(userId) { return gateway.info.get(userId) ?? { invitedAt: "2026-11-10", confirmedAt: null, lastSignInAt: null, hasPassword: false }; },
  };
  return gateway;
}

type MemoryAccounts = AccountsAdminStore & { accounts: Map<string, AccountRecord & { apps: AppMemberships }>; invitations: Map<string, InvitationRecord & { userId: string }>; failMemberships: number; writes: number };
function memoryAccounts(initial: AccountRecord[] = []): MemoryAccounts {
  const accounts = new Map(initial.map((account) => [account.id, { ...account }]));
  const invitations = new Map<string, InvitationRecord & { userId: string }>();
  let clock = 0;
  const latest = (userId: string) => [...invitations.values()].filter((entry) => entry.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  const view = (account: AccountRecord) => ({ ...account, invitation: latest(account.id) });
  const assertAdmins = (next: Map<string, AccountRecord>) => {
    // the database triggers' rules (verified against DEV separately)
    if (![...next.values()].some((account) => account.isActive && account.isHwsAdmin) && [...accounts.values()].some((account) => account.isActive && account.isHwsAdmin)) throw new LastAdminError("hws", null);
    if (![...next.values()].some((account) => account.isActive && account.apps.abf === "admin") && [...accounts.values()].some((account) => account.isActive && account.apps.abf === "admin")) throw new LastAdminError("app", "abf");
  };
  const memory: MemoryAccounts = {
    accounts,
    invitations,
    failMemberships: 0,
    writes: 0,
    async list() { return [...accounts.values()].map(view); },
    async get(id) { const account = accounts.get(id); return account ? view(account) : undefined; },
    async findByEmail(email) { const account = [...accounts.values()].find((entry) => entry.email === email); return account ? view(account) : undefined; },
    async ensureAccount(input) {
      if (!accounts.has(input.id)) {
        if ([...accounts.values()].some((entry) => entry.email === input.email)) throw new AccountConflictError("Účet s tímto e-mailem už existuje.");
        accounts.set(input.id, { id: input.id, email: input.email, displayName: input.displayName, isActive: true, isHwsAdmin: false, apps: {}, createdAt: "t", updatedAt: `v${clock++}`, deactivatedAt: null, invitation: null });
      }
      return view(accounts.get(input.id)!);
    },
    async setMemberships(userId, access) {
      if (memory.failMemberships > 0) { memory.failMemberships -= 1; throw new Error("network"); }
      const next = new Map(accounts);
      next.set(userId, { ...accounts.get(userId)!, apps: Object.fromEntries(access.map((entry) => [entry.appKey, entry.role])) as AppMemberships });
      assertAdmins(next);
      accounts.set(userId, next.get(userId)!);
      memory.writes += 1;
    },
    async updateAccount(userId, patch, expected) {
      const current = accounts.get(userId)!;
      if (current.updatedAt !== expected) return false;
      const updated = { ...current, ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}), ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}), ...(patch.isHwsAdmin !== undefined ? { isHwsAdmin: patch.isHwsAdmin } : {}), ...(patch.access ? { apps: Object.fromEntries(patch.access.map((entry) => [entry.appKey, entry.role])) as AppMemberships } : {}), updatedAt: `v${clock++}` };
      const next = new Map(accounts);
      next.set(userId, updated);
      assertAdmins(next);
      accounts.set(userId, updated);
      memory.writes += 1;
      return true;
    },
    async createInvitation(input) {
      const record = { id: crypto.randomUUID(), userId: input.userId, status: "access_pending" as InvitationStatus, delivery: input.delivery, lastError: null, createdAt: `2026-11-10T10:00:${String(clock++).padStart(2, "0")}Z`, updatedAt: "t" };
      invitations.set(record.id, record);
      return record;
    },
    async updateInvitation(id, patch) {
      const record = invitations.get(id)!;
      invitations.set(id, { ...record, status: patch.status, lastError: patch.lastError ?? null });
    },
    async apps() { return HWS_APPS.map((app, index) => ({ key: app.key, name: app.name, url: app.url, status: app.status, roles: app.roles, sortOrder: index })); },
  };
  return memory;
}

function recordingMailer(options: Readonly<{ configured?: boolean; allowed?: boolean; fail?: boolean }> = {}): InvitationMailer & { sent: InvitationMessage[] } {
  const mailer = {
    sent: [] as InvitationMessage[],
    state: () => (options.configured === false ? { configured: false as const, reason: "Odesílání e-mailů není nastavené." } : { configured: true as const }),
    recipientAllowed: () => options.allowed !== false,
    async send(message: InvitationMessage) {
      if (options.fail) throw new Error("smtp down");
      mailer.sent.push(message);
    },
  };
  return mailer;
}

async function withAdministration<T>(run: (context: { hws: Awaited<ReturnType<typeof createTestSession>>; accounts: MemoryAccounts; gateway: Gateway }) => Promise<T>, mailer: InvitationMailer = recordingMailer({ configured: false })): Promise<T> {
  const hws = await createTestSession(SECRET, { role: "admin", isHwsAdmin: true });
  const accounts = memoryAccounts([{ id: hws.user.id, email: hws.user.email, displayName: "Správce", isActive: true, isHwsAdmin: true, apps: { abf: "admin" }, createdAt: "t", updatedAt: "v-hws", deactivatedAt: null, invitation: null }]);
  const gateway = fakeGateway();
  gateway.info.set(hws.user.id, { invitedAt: null, confirmedAt: "2026-01-01", lastSignInAt: "2026-11-01", hasPassword: true });
  setAccountsAdminStoreForTesting(accounts);
  setAuthGatewayForTesting(gateway);
  setInvitationMailerForTesting(mailer);
  try {
    return await run({ hws, accounts, gateway });
  } finally {
    setAccountsAdminStoreForTesting(undefined);
    setAuthGatewayForTesting(undefined);
    setInvitationMailerForTesting(undefined);
  }
}

test("pozvání: účet + přístupy s platnými rolemi → teprve pak „připravená“; odkaz jen správci; nic se neodeslalo", async () => {
  await withAdministration(async ({ hws, accounts, gateway }) => {
    const abfAdminOnly = await createTestSession(SECRET, { role: "admin" });
    assert.equal((await handleAccountInvite(request("/api/hws/accounts/invite", { token: abfAdminOnly.token, body: { email: "x@test.invalid", access: [{ appKey: "abf", role: "user" }] } }))).status, 403, "an ABF admin cannot invite");
    assert.equal((await handleAccountInvite(request("/api/hws/accounts/invite", { token: hws.token, body: { email: "x@test.invalid", access: [{ appKey: "abf", role: "owner" }] } }))).status, 400);
    assert.equal((await handleAccountInvite(request("/api/hws/accounts/invite", { token: hws.token, body: { email: "x@test.invalid", access: [] } }))).status, 400);
    const response = await handleAccountInvite(request("/api/hws/accounts/invite", { token: hws.token, body: { email: "Nova@Test.invalid", displayName: "Nová", access: [{ appKey: "abf", role: "external" }, { appKey: "hws-easy", role: "user" }] } }));
    assert.equal(response.status, 201);
    const body = await json(response);
    assert.match(String(body.link), /^http:\/\/localhost:3000\/auth\/confirm\?token_hash=.+&type=invite$/u);
    assert.equal(body.emailSent, false);
    const created = [...accounts.accounts.values()].find((account) => account.email === "nova@test.invalid")!;
    assert.deepEqual(created.apps, { abf: "external", "hws-easy": "user" });
    assert.equal(created.isHwsAdmin, false);
    assert.equal([...accounts.invitations.values()].find((entry) => entry.userId === created.id)!.status, "ready");
    assert.deepEqual(gateway.passwords, []);
  });
});

test("duplicitní pozvání: aktivovaný účet se nezaloží znovu ani se mu nezmění heslo; nedokončená pozvánka se dokončí bez duplicit", async () => {
  await withAdministration(async ({ hws, accounts, gateway }) => {
    const first = await json(await handleAccountInvite(request("/api/hws/accounts/invite", { token: hws.token, body: { email: "opak@test.invalid", access: [{ appKey: "abf", role: "user" }] } })));
    const id = (first.account as { id: string }).id;
    // still pending → repeating the invitation resumes it: same account, no duplicate
    const again = await handleAccountInvite(request("/api/hws/accounts/invite", { token: hws.token, body: { email: "opak@test.invalid", access: [{ appKey: "hws-easy", role: "user" }] } }));
    assert.equal(again.status, 200);
    assert.equal((await json(again)).resumed, true);
    assert.equal([...accounts.accounts.values()].filter((account) => account.email === "opak@test.invalid").length, 1);
    assert.deepEqual(accounts.accounts.get(id)!.apps, { abf: "user", "hws-easy": "user" }, "existing access kept, requested added");
    // activated → refused, no link, no password change
    gateway.info.set(id, { invitedAt: "x", confirmedAt: "2026-11-10", lastSignInAt: "2026-11-10", hasPassword: true });
    const linksBefore = gateway.links.length;
    const refused = await handleAccountInvite(request("/api/hws/accounts/invite", { token: hws.token, body: { email: "OPAK@test.invalid", access: [{ appKey: "abf", role: "admin" }] } }));
    assert.equal(refused.status, 409);
    const refusedBody = await json(refused);
    assert.deepEqual([refusedBody.code, refusedBody.userId], ["account_exists", id]);
    assert.equal(gateway.links.length, linksBefore, "no link generated for an activated account");
    assert.equal(accounts.accounts.get(id)!.apps.abf, "user", "nothing changed");
    assert.deepEqual(gateway.passwords, []);
  });
});

test("částečné selhání: přístupy se neuloží → pozvánka zůstane „nedokončená“ (dohledatelná); opakování ji dokončí bez druhého účtu", async () => {
  await withAdministration(async ({ hws, accounts }) => {
    accounts.failMemberships = 1;
    const failed = await handleAccountInvite(request("/api/hws/accounts/invite", { token: hws.token, body: { email: "padne@test.invalid", access: [{ appKey: "abf", role: "user" }] } }));
    assert.equal(failed.status, 502);
    const account = [...accounts.accounts.values()].find((entry) => entry.email === "padne@test.invalid")!;
    assert.deepEqual(account.apps, {});
    assert.equal((await accounts.get(account.id))!.invitation!.status, "access_pending");
    const retried = await handleAccountInvite(request("/api/hws/accounts/invite", { token: hws.token, body: { email: "padne@test.invalid", access: [{ appKey: "abf", role: "user" }] } }));
    assert.equal(retried.status, 200);
    assert.equal([...accounts.accounts.values()].filter((entry) => entry.email === "padne@test.invalid").length, 1);
    assert.deepEqual(accounts.accounts.get(account.id)!.apps, { abf: "user" });
    assert.equal((await accounts.get(account.id))!.invitation!.status, "ready");
  });
});

test("e-mail: „odesláno“ jen po skutečném odeslání; selhání nezničí účet ani přístupy a vrátí odkaz k ručnímu předání; DEV jen povolené adresy", async () => {
  const ok = recordingMailer();
  await withAdministration(async ({ hws }) => {
    const body = await json(await handleAccountInvite(request("/api/hws/accounts/invite", { token: hws.token, body: { email: "mail@test.invalid", displayName: "Pošta", delivery: "email", access: [{ appKey: "abf", role: "user" }] } })));
    assert.equal(body.emailSent, true);
    assert.equal(body.link, undefined, "the link is not echoed once it was e-mailed");
    assert.equal(ok.sent.length, 1);
    assert.match(ok.sent[0]!.link, /\/auth\/confirm\?token_hash=/u);
    assert.deepEqual(ok.sent[0]!.appNames, ["ABF Generator"]);
  }, ok);
  const failing = recordingMailer({ fail: true });
  await withAdministration(async ({ hws, accounts }) => {
    const response = await handleAccountInvite(request("/api/hws/accounts/invite", { token: hws.token, body: { email: "spadne@test.invalid", delivery: "email", access: [{ appKey: "abf", role: "user" }] } }));
    const body = await json(response);
    assert.equal(response.status, 201);
    assert.equal(body.emailSent, false);
    assert.match(String(body.notice), /nepodařilo odeslat/u);
    assert.ok(body.link, "manual hand-over still possible");
    const account = [...accounts.accounts.values()].find((entry) => entry.email === "spadne@test.invalid")!;
    assert.deepEqual(account.apps, { abf: "user" });
    assert.equal((await accounts.get(account.id))!.invitation!.status, "send_failed");
  }, failing);
  const blocked = recordingMailer({ allowed: false });
  await withAdministration(async ({ hws }) => {
    const body = await json(await handleAccountInvite(request("/api/hws/accounts/invite", { token: hws.token, body: { email: "skutecny.clovek@test.invalid", delivery: "email", access: [{ appKey: "abf", role: "user" }] } })));
    assert.equal(body.emailSent, false);
    assert.equal(blocked.sent.length, 0, "a DEV invitation never reaches a real person");
  }, blocked);
  // configuration + DEV allow-list + text without secrets
  assert.equal(smtpState({}).configured, false);
  assert.equal(smtpState({ SMTP_HOST: "smtp.example", SMTP_PORT: "587", SMTP_USER: "u", SMTP_PASSWORD: "p", SMTP_FROM: "a@b.cz" }).configured, true);
  assert.equal(recipientAllowedIn("a@homeworkstudio.cz", { NEXT_PUBLIC_APP_ENV: "development", SMTP_DEV_ALLOWED_RECIPIENTS: "@test.invalid" }), false);
  assert.equal(recipientAllowedIn("a@test.invalid", { NEXT_PUBLIC_APP_ENV: "development", SMTP_DEV_ALLOWED_RECIPIENTS: "@test.invalid" }), true);
  assert.equal(recipientAllowedIn("a@homeworkstudio.cz", { NEXT_PUBLIC_APP_ENV: "production" }), true);
  assert.doesNotMatch(invitationText({ to: "a@b.cz", displayName: "<b>", link: "https://x/auth/confirm?token_hash=t", appNames: ["ABF"], kind: "invite" }).html, /<b>/u, "name is escaped");
});

test("úprava: přidání aplikace existujícímu účtu bez změny hesla; role per aplikace nezávislé; vlastní účet a správu nelze vypnout", async () => {
  await withAdministration(async ({ hws, accounts, gateway }) => {
    const other = crypto.randomUUID();
    accounts.accounts.set(other, { id: other, email: "jiny@test.invalid", displayName: null, isActive: true, isHwsAdmin: false, apps: { abf: "external" }, createdAt: "t", updatedAt: "v-o", deactivatedAt: null, invitation: null });
    const update = (token: string, body: Record<string, unknown>) => handleAccountUpdate(request("/api/hws/accounts/update", { token, body }));
    assert.equal((await update(hws.token, { userId: other, expectedUpdatedAt: "v-o", access: [{ appKey: "abf", role: "external" }, { appKey: "hws-easy", role: "user" }] })).status, 200);
    assert.deepEqual(accounts.accounts.get(other)!.apps, { abf: "external", "hws-easy": "user" }, "ABF role unchanged by adding another application");
    assert.deepEqual([gateway.passwords, gateway.links], [[], []], "no password reset, no link");
    assert.equal((await update(hws.token, { userId: other, expectedUpdatedAt: "v-o", displayName: "stará verze" })).status, 409, "stale version refused");
    const self = await update(hws.token, { userId: hws.user.id, expectedUpdatedAt: "v-hws", isActive: false });
    assert.deepEqual([self.status, (await json(self)).code], [403, "self_change"]);
    assert.equal((await update(hws.token, { userId: hws.user.id, expectedUpdatedAt: "v-hws", isHwsAdmin: false })).status, 403);
    assert.equal((await update(hws.token, { userId: other, expectedUpdatedAt: accounts.accounts.get(other)!.updatedAt, access: [{ appKey: "abf", role: "boss" }] })).status, 400);
  });
});

test("poslední správci: HomeworkStudia i ABF chránění (odpověď 409, nic se nezapíše)", async () => {
  await withAdministration(async ({ hws, accounts }) => {
    const second = crypto.randomUUID();
    accounts.accounts.set(second, { id: second, email: "druhy@test.invalid", displayName: null, isActive: true, isHwsAdmin: true, apps: {}, createdAt: "t", updatedAt: "v-2", deactivatedAt: null, invitation: null });
    // the second HWS admin removes the ABF admin role of the only ABF admin
    const secondSession = await createTestSession(SECRET, { role: null, isHwsAdmin: true, user: undefined });
    accounts.accounts.set(secondSession.user.id, { id: secondSession.user.id, email: secondSession.user.email, displayName: null, isActive: true, isHwsAdmin: true, apps: {}, createdAt: "t", updatedAt: "v-s", deactivatedAt: null, invitation: null });
    const demote = await handleAccountUpdate(request("/api/hws/accounts/update", { token: secondSession.token, body: { userId: hws.user.id, expectedUpdatedAt: "v-hws", access: [{ appKey: "abf", role: "user" }] } }));
    assert.deepEqual([demote.status, (await json(demote)).code], [409, "last_app_admin"]);
    assert.equal(accounts.accounts.get(hws.user.id)!.apps.abf, "admin");
    // with two HWS admins one may be switched off, the last one not
    assert.equal((await handleAccountUpdate(request("/api/hws/accounts/update", { token: hws.token, body: { userId: second, expectedUpdatedAt: "v-2", isHwsAdmin: false } }))).status, 200);
    assert.equal((await handleAccountUpdate(request("/api/hws/accounts/update", { token: hws.token, body: { userId: secondSession.user.id, expectedUpdatedAt: "v-s", isActive: false } }))).status, 200);
    // only one active HWS admin is left: taking its flag away is refused and nothing is written
    const last = await handleAccountUpdate(request("/api/hws/accounts/update", { token: secondSession.token, body: { userId: hws.user.id, expectedUpdatedAt: "v-hws", isHwsAdmin: false } }));
    assert.deepEqual([last.status, (await json(last)).code], [409, "last_hws_admin"]);
    assert.equal(accounts.accounts.get(hws.user.id)!.isHwsAdmin, true);
  });
  // database error messages → typed errors
  assert.ok(accountsError({ message: "LAST_ACTIVE_HWS_ADMIN: …" }) instanceof LastAdminError);
  assert.equal((accountsError({ message: "LAST_ACTIVE_APP_ADMIN:abf: …" }) as LastAdminError).appKey, "abf");
  assert.ok(accountsError({ message: "INVALID_APP_ROLE: …" }) instanceof AccountConflictError);
});

test("seznam a odkazy: jen správce HWS; nový odkaz aktivovanému účtu = nastavení hesla (heslo se mění až použitím), nedokončenému = pozvánka", async () => {
  await withAdministration(async ({ hws, accounts, gateway }) => {
    const user = await createTestSession(SECRET, { role: "user" });
    assert.equal((await handleAccountsList(request("/api/hws/accounts", { token: user.token }))).status, 403);
    const list = await json(await handleAccountsList(request("/api/hws/accounts", { token: hws.token })));
    assert.equal((list.mailer as { configured: boolean }).configured, false);
    const recovery = await json(await handleAccountLink(request("/api/hws/accounts/link", { token: hws.token, body: { userId: hws.user.id } })));
    assert.equal(recovery.kind, "recovery");
    assert.deepEqual(gateway.passwords, [], "generating a link changes no password");
    const pending = crypto.randomUUID();
    accounts.accounts.set(pending, { id: pending, email: "ceka@test.invalid", displayName: null, isActive: true, isHwsAdmin: false, apps: { abf: "user" }, createdAt: "t", updatedAt: "v-p", deactivatedAt: null, invitation: null });
    const invite = await json(await handleAccountLink(request("/api/hws/accounts/link", { token: hws.token, body: { userId: pending } })));
    assert.equal(invite.kind, "invite");
    assert.equal((await accounts.get(pending))!.invitation!.status, "ready");
  });
});

// =============================================================================================
// Migration: what the database guarantees
// =============================================================================================
test("migrace: role → členství ABF beze změny, žádný automatický správce HWS ani osobní e-mail, ochrana posledních správců serializovaná", () => {
  const sql = readFileSync("supabase/migrations/20261110120000_hws_accounts_app_memberships.sql", "utf8");
  assert.match(sql, /insert into app_memberships \(user_id, app_key, role, created_at, created_by\)\s+select id, 'abf', role, created_at, created_by from app_users;/u);
  assert.match(sql, /add column is_hws_admin boolean not null default false/u);
  assert.doesNotMatch(sql, /update app_users set is_hws_admin|@homeworkstudio|@[a-z0-9-]+\.(cz|com)/u, "nobody is promoted by the migration");
  assert.match(sql, /primary key \(user_id, app_key\)/u, "one membership per account × application");
  assert.match(sql, /references hws_apps \(key\)/u);
  assert.match(sql, /INVALID_APP_ROLE/u);
  assert.equal((sql.match(/pg_advisory_xact_lock\(hashtext\('hws_last_admins'\)\)/gu) ?? []).length, 2, "one lock for both last-admin checks");
  assert.match(sql, /LAST_ACTIVE_HWS_ADMIN/u);
  assert.match(sql, /LAST_ACTIVE_APP_ADMIN/u);
  assert.match(sql, /alter table app_users drop column role;/u);
  assert.match(sql, /\('hws-easy', 'HWS Easy', null, 'coming_soon'/u);
  assert.match(sql, /constraint hws_apps_url_matches_status check \(\(status = 'available'\) = \(url is not null\)\)/u);
  assert.match(sql, /revoke all on hws_apps, app_memberships, account_invitations from anon, authenticated;/u);
  const rollback = readFileSync("supabase/rollback/20261110120000_hws_accounts_app_memberships.down.sql", "utf8");
  assert.match(rollback, /update app_users u set role = m\.role from app_memberships m where m\.user_id = u\.id and m\.app_key = 'abf';/u);
  assert.match(rollback, /create trigger app_users_keep_last_admin/u);
  // bootstrap: explicit e-mail and explicit roles, DEV only
  const bootstrap = readFileSync("scripts/authBootstrapAdmin.ts", "utf8");
  assert.match(bootstrap, /--hws-admin/u);
  assert.match(bootstrap, /Skript nikoho nevybírá sám/u);
  assert.doesNotMatch(bootstrap, /info@homeworkstudio/u);
  void appBaseUrl;
});

test("API vstupy: každá ABF routa i soubory jdou přes authenticate (členství ABF); společná správa přes authorizeAccounts", () => {
  const requestAuth = readFileSync("lib/auth/requestAuth.ts", "utf8");
  assert.match(requestAuth, /export async function authenticate\(request: NextRequest\): Promise<AuthDecision> \{\s+const decision = await authenticateAccount\(request\);\s+if \(decision\.ok === false\) return decision;\s+return hasAppAccess\(decision\.auth\.user, "abf"\)/u);
  assert.match(requestAuth, /export async function authorize\(request: NextRequest, permission: Permission\): Promise<AuthDecision> \{\s+const decision = await authenticate\(request\);/u);
  assert.match(requestAuth, /export async function authorizeFile\([^)]*\): Promise<AuthDecision> \{\s+const decision = await authenticate\(request\);/u);
  for (const handler of ["handleAccountsList", "handleAccountInvite", "handleAccountUpdate", "handleAccountLink"]) {
    const source = readFileSync("lib/accounts/accountsAdminApi.server.ts", "utf8");
    assert.match(source, new RegExp(`export async function ${handler}\\(request: NextRequest\\): Promise<NextResponse> \\{\\s+const decision = await authorizeAccounts\\(request\\);`, "u"), handler);
  }
  void ([] as RequestedAccess[]);
});
