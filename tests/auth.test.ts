import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { NextRequest } from "next/server.js";
import {
  AUTH_COOKIE_NAME,
  createPasswordSetupToken,
  createSessionToken,
  isSessionSecretConfigured,
  PASSWORD_SETUP_COOKIE_NAME,
  readPasswordSetupToken,
  readSessionToken,
  SESSION_TTL_SECONDS,
  sessionCookieOptions,
  verifySessionToken,
} from "../lib/auth/session.ts";
import { can, canOpenSection, fileScope, permissionsOf, projectAccess, projectFileAccess, safeReturnPath, type AppRole } from "../domain/accessControl.ts";
import { externalProjectView } from "../domain/externalProjectView.ts";
import { AuthSchemaNotMigratedError, setAuthStoreForTesting } from "../lib/auth/authStore.server.ts";
import { authorizeFile, authorizeProject, resolveSessionToken } from "../lib/auth/requestAuth.ts";
import { handleConfirmLink, handleForgotPassword, handleLogin, handleLogout, handleSession, handleSetPassword, resetLoginLimiterForTesting } from "../lib/auth/authApi.server.ts";
import { appBaseUrl, setAuthGatewayForTesting, type AuthGateway } from "../lib/auth/supabaseAuth.server.ts";
import { handleUserProjects, handleUsersList } from "../lib/auth/usersAdminApi.server.ts";
import { setUsersAdminStoreForTesting, type AdminUserRecord, type UsersAdminStore } from "../lib/auth/usersAdmin.supabase.ts";
import { handleProjectsList } from "../app/api/projects/list/route.ts";
import { handleProjectsSave } from "../app/api/projects/save/route.ts";
import { handleProjectsDelete } from "../app/api/projects/delete/route.ts";
import { proxy } from "../proxy.ts";
import { createTestSession, testAuthStore } from "./helpers/testAuth.ts";

const SECRET = "test-session-secret-with-at-least-32-characters";
process.env.APP_SESSION_SECRET = SECRET;
// Links are built for a local DEV app (lib/auth/supabaseAuth.server.ts appBaseUrl).
process.env.NEXT_PUBLIC_APP_ENV = "development";
delete process.env.APP_BASE_URL;
// The route handlers must never reach a real database in these tests.
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;
const store = testAuthStore();
const ORIGIN = "http://localhost:3000";
const UUID = "6b22b294-2a6d-436b-8211-80320b02a2e8";

function request(pathname: string, init: Readonly<{ method?: string; token?: string; body?: unknown; form?: Record<string, string>; cookies?: Record<string, string> }> = {}): NextRequest {
  const headers: Record<string, string> = {};
  const cookies = { ...(init.cookies ?? {}), ...(init.token ? { [AUTH_COOKIE_NAME]: init.token } : {}) };
  if (Object.keys(cookies).length) headers.cookie = Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join("; ");
  let body: string | undefined;
  if (init.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(init.form).toString();
  } else if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    headers.accept = "application/json";
    body = JSON.stringify(init.body);
  }
  return new NextRequest(`${ORIGIN}${pathname}`, { method: init.method ?? (body ? "POST" : "GET"), headers, body });
}
const setCookie = (response: Response, name: string) => response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`))?.split(";")[0]!.slice(name.length + 1);
const json = async (response: Response) => (await response.json()) as Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// Fake Supabase Auth (records what would have been sent — nothing leaves the process)
// ---------------------------------------------------------------------------------------------
type GatewayLog = { recoveryEmails: string[]; passwords: Array<{ userId: string; password: string }>; links: Array<{ type: string; email: string; redirectTo: string }> };
function fakeGateway(accounts: Record<string, { userId: string; password: string; confirmed?: boolean }>, log: GatewayLog = { recoveryEmails: [], passwords: [], links: [] }): AuthGateway & { log: GatewayLog } {
  return {
    log,
    async signInWithPassword(email, password) {
      const account = accounts[email];
      if (!account || account.password !== password) return { ok: false, reason: "invalid" };
      if (account.confirmed === false) return { ok: false, reason: "unconfirmed" };
      return { ok: true, userId: account.userId };
    },
    async verifyEmailLinkToken(tokenHash) {
      return tokenHash.startsWith("valid-") ? tokenHash.slice(6) : undefined;
    },
    async verifyAccessToken(token) {
      return token.startsWith("valid-") ? token.slice(6) : undefined;
    },
    async generateLink(type, email, redirectTo) {
      log.links.push({ type, email, redirectTo });
      const existing = accounts[email];
      return { userId: existing?.userId ?? crypto.randomUUID(), tokenHash: `hash-${type}-${email}` };
    },
    async createConfirmedUser() {
      return crypto.randomUUID();
    },
    async setPassword(userId, password) {
      log.passwords.push({ userId, password });
    },
    async sendRecoveryEmail(email) {
      log.recoveryEmails.push(email);
    },
    async authUserInfo() {
      return { invitedAt: null, confirmedAt: null, lastSignInAt: null, hasPassword: false };
    },
  };
}

// =============================================================================================
// Session cookie
// =============================================================================================
test("session cookie v2: podepsaná, s ID session a uživatele; pozměněná, prošlá i stará v1 cookie neplatí", async () => {
  const now = 1_800_000_000_000;
  const token = await createSessionToken(SECRET, { sessionId: UUID, userId: UUID, expiresAt: now + SESSION_TTL_SECONDS * 1000 });
  assert.deepEqual(await readSessionToken(token, SECRET, now + 1000), { sessionId: UUID, userId: UUID, expiresAt: now + SESSION_TTL_SECONDS * 1000 });
  assert.equal(await verifySessionToken(`${token}x`, SECRET, now), false);
  assert.equal(await verifySessionToken(token, "another-secret-with-at-least-32-characters!", now), false);
  assert.equal(await verifySessionToken(token, SECRET, now + 13 * 60 * 60 * 1000), false, "expired");
  // The former shared-password cookie ({version:1, expiresAt}) is never accepted again.
  const v1 = `${Buffer.from(JSON.stringify({ version: 1, expiresAt: now + 1e9 })).toString("base64url")}.sig`;
  assert.equal(await verifySessionToken(v1, SECRET, now), false);
});

test("odkaz pro nastavení hesla: vlastní podpis a účel — nelze ho použít jako session a naopak", async () => {
  const grant = await createPasswordSetupToken(SECRET, UUID, "invite");
  assert.deepEqual(await readPasswordSetupToken(grant, SECRET), { userId: UUID, kind: "invite" });
  assert.equal(await verifySessionToken(grant, SECRET), false);
  const session = await createSessionToken(SECRET, { sessionId: UUID, userId: UUID, expiresAt: Date.now() + 60_000 });
  assert.equal(await readPasswordSetupToken(session, SECRET), undefined);
  assert.equal(await readPasswordSetupToken(grant, SECRET, Date.now() + 16 * 60 * 1000), undefined, "15 minutes only");
});

test("cookie má bezpečné atributy; tajemství session musí mít alespoň 32 znaků", () => {
  const options = sessionCookieOptions();
  assert.equal(options.httpOnly, true);
  assert.equal(options.sameSite, "lax");
  assert.equal(options.path, "/");
  assert.ok(options.maxAge > 0);
  assert.equal(isSessionSecretConfigured("kratky"), false);
  assert.equal(isSessionSecretConfigured(SECRET), true);
});

// =============================================================================================
// Return URL
// =============================================================================================
test("návratová URL: jen interní cesta, nikdy cizí doména ani smyčka na přihlášení", () => {
  assert.equal(safeReturnPath("/abf"), "/abf");
  assert.equal(safeReturnPath("/abf?tab=2#x"), "/abf?tab=2#x");
  for (const evil of ["https://evil.example", "//evil.example", "/\\evil.example", "\\\\evil.example", "javascript:alert(1)", " //evil.example", "/\u0000x", "http:/evil", "/login", "/login/nove-heslo", "/auth/callback", "/api/projects/list", undefined, 42]) {
    assert.equal(safeReturnPath(evil), "/", String(evil));
  }
});

// =============================================================================================
// Proxy (first gate)
// =============================================================================================
test("proxy: bez session stránka → /login s návratem, API → 401; přihlašovací stránky a callback bez přesměrování", async () => {
  const page = await proxy(new NextRequest(`${ORIGIN}/abf?x=1`));
  assert.equal(page.status, 307);
  assert.equal(page.headers.get("location"), `${ORIGIN}/login?next=%2Fabf%3Fx%3D1`);
  const api = await proxy(new NextRequest(`${ORIGIN}/api/projects/list`));
  assert.equal(api.status, 401);
  for (const open of ["/login", "/login/zapomenute-heslo", "/login/nove-heslo", "/auth/callback", "/auth/confirm", "/api/auth/login", "/api/auth/session", "/api/auth/password/forgot"]) {
    assert.equal((await proxy(new NextRequest(`${ORIGIN}${open}`))).headers.get("x-middleware-next"), "1", open);
  }
  const { token } = await createTestSession(SECRET);
  assert.equal((await proxy(request("/abf", { token }))).headers.get("x-middleware-next"), "1");
});

// =============================================================================================
// Resolver states
// =============================================================================================
test("stav přihlášení: chybějící / neplatná / odvolaná / prošlá session, deaktivovaný účet a chybějící konfigurace se rozlišují", async () => {
  assert.deepEqual(await resolveSessionToken(undefined), { status: "unauthenticated", reason: "missing" });
  assert.deepEqual(await resolveSessionToken("x.y"), { status: "unauthenticated", reason: "invalid" });
  const ok = await createTestSession(SECRET, { role: "user" });
  assert.equal((await resolveSessionToken(ok.token)).status, "authenticated");
  await store.revokeSession(ok.sessionId);
  assert.deepEqual(await resolveSessionToken(ok.token), { status: "unauthenticated", reason: "revoked" });
  // Session row expired although the cookie is still valid (server-side expiry wins).
  const expired = await createTestSession(SECRET);
  store.sessions.get(expired.sessionId)!.expiresAt = Date.now() - 1;
  assert.deepEqual(await resolveSessionToken(expired.token), { status: "unauthenticated", reason: "expired" });
  const inactive = await createTestSession(SECRET, { role: "user" });
  store.users.get(inactive.user.id)!.isActive = false;
  assert.equal((await resolveSessionToken(inactive.token)).status, "inactive");
  const config = await resolveSessionToken(ok.token, { APP_SESSION_SECRET: undefined });
  assert.equal(config.status === "unavailable" && config.reason, "config");
  // Missing migration: an explicit 503 state, never an open door.
  setAuthStoreForTesting({ ...store, loadSession: async () => { throw new AuthSchemaNotMigratedError(); } } as never);
  try {
    const migration = await resolveSessionToken((await createSessionToken(SECRET, { sessionId: UUID, userId: UUID, expiresAt: Date.now() + 60_000 })));
    assert.equal(migration.status === "unavailable" && migration.reason, "migration");
  } finally {
    setAuthStoreForTesting(store);
  }
});

// =============================================================================================
// Permission matrix
// =============================================================================================
test("matice oprávnění: Správce vše, Běžný provoz bez správy, Externí nic globálního", () => {
  assert.equal(permissionsOf("external").length, 0);
  for (const permission of ["users.manage", "catalog.manage", "prices.sale.write", "prices.purchase.write", "events.manage", "realizationCompanies.manage", "printSurfaces.catalogSync"] as const) {
    assert.equal(can("admin", permission), true, permission);
    assert.equal(can("user", permission), false, permission);
  }
  for (const permission of ["projects.create", "catalog.read", "prices.sale.read", "prices.purchase.read", "events.read", "tasks.use", "emails.use", "printSurfaces.use", "technicalRasters.use", "settlement.use"] as const) assert.equal(can("user", permission), true, permission);
  assert.equal(canOpenSection("user", "users"), false);
  assert.equal(canOpenSection("user", "components"), false);
  assert.equal(canOpenSection("user", "tasks"), true);
  assert.equal(canOpenSection("external", "projects"), false);
});

test("přístup k projektu: správce vše; běžný jen přiřazené (a nový); externí jen čtení přiřazeného; přiřazení neotvírá globální data", () => {
  const member = { exists: true, isMember: true };
  const stranger = { exists: true, isMember: false };
  const fresh = { exists: false, isMember: false };
  assert.equal(projectAccess("admin", "delete", stranger), true);
  assert.deepEqual((["read", "write", "delete"] as const).map((action) => projectAccess("user", action, member)), [true, true, true]);
  assert.deepEqual((["read", "write"] as const).map((action) => projectAccess("user", action, stranger)), [false, false]);
  assert.equal(projectAccess("user", "write", fresh), true, "a new project");
  assert.deepEqual((["read", "write", "delete"] as const).map((action) => projectAccess("external", action, member)), [true, false, false]);
  assert.equal(projectAccess("external", "write", fresh), false);
  assert.equal(projectFileAccess("external", "read", "exports", member), true);
  assert.equal(projectFileAccess("external", "read", "graphics", member), false, "customer graphics are not an output");
  assert.equal(projectFileAccess("external", "read", "exports", stranger), false);
  assert.deepEqual(fileScope("catalog/furniture/m57/photos/a.png", "read"), { kind: "global", permission: "catalog.read" });
  assert.deepEqual(fileScope("catalog/furniture/m57/photos/a.png", "write"), { kind: "global", permission: "catalog.manage" });
  assert.deepEqual(fileScope("projects/p-1/exports/a.pdf", "read"), { kind: "project", projectId: "p-1", folder: "exports" });
  assert.equal(can("external", "catalog.read"), false);
});

// =============================================================================================
// Login / logout / session
// =============================================================================================
test("přihlášení: správné údaje → session + cookie + bezpečný návrat; chybné heslo, chybějící profil, deaktivace a limit pokusů se hlásí zvlášť", async () => {
  resetLoginLimiterForTesting();
  const active = store.addUser({ role: "user", email: "jana@test.invalid" });
  const inactive = store.addUser({ role: "user", email: "petr@test.invalid", isActive: false });
  setAuthGatewayForTesting(fakeGateway({
    "jana@test.invalid": { userId: active.id, password: "spravne-heslo-1" },
    "petr@test.invalid": { userId: inactive.id, password: "spravne-heslo-2" },
    "cizi@test.invalid": { userId: crypto.randomUUID(), password: "spravne-heslo-3" },
  }));
  process.env.SUPABASE_URL = "https://wpbivmobbqcqmyehunog.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "test";
  try {
    const okResponse = await handleLogin(request("/api/auth/login", { form: { email: " Jana@Test.invalid ", password: "spravne-heslo-1", next: "https://evil.example/x" } }));
    assert.equal(okResponse.status, 303);
    assert.equal(okResponse.headers.get("location"), `${ORIGIN}/`, "foreign return URL replaced by /");
    const cookie = setCookie(okResponse, AUTH_COOKIE_NAME)!;
    const state = await resolveSessionToken(cookie);
    assert.equal(state.status === "authenticated" && state.user.id, active.id);
    const withNext = await handleLogin(request("/api/auth/login", { body: { email: "jana@test.invalid", password: "spravne-heslo-1", next: "/abf?tab=1" } }));
    assert.deepEqual(await json(withNext), { ok: true, redirectTo: "/abf?tab=1" });

    const wrong = await handleLogin(request("/api/auth/login", { body: { email: "jana@test.invalid", password: "spatne" } }));
    assert.deepEqual([wrong.status, (await json(wrong)).code], [401, "invalid"]);
    const noProfile = await handleLogin(request("/api/auth/login", { body: { email: "cizi@test.invalid", password: "spravne-heslo-3" } }));
    assert.deepEqual([noProfile.status, (await json(noProfile)).code], [403, "no_access"]);
    const deactivated = await handleLogin(request("/api/auth/login", { body: { email: "petr@test.invalid", password: "spravne-heslo-2" } }));
    assert.deepEqual([deactivated.status, (await json(deactivated)).code], [403, "inactive"]);
    for (let attempt = 0; attempt < 8; attempt += 1) await handleLogin(request("/api/auth/login", { body: { email: "jana@test.invalid", password: `x${attempt}` } }));
    const limited = await handleLogin(request("/api/auth/login", { body: { email: "jana@test.invalid", password: "spravne-heslo-1" } }));
    assert.deepEqual([limited.status, (await json(limited)).code], [429, "rate_limited"]);
  } finally {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    resetLoginLimiterForTesting();
  }
});

test("přihlášení bez konfigurace se hlásí jako chyba konfigurace, ne jako špatné heslo", async () => {
  const response = await handleLogin(request("/api/auth/login", { body: { email: "jana@test.invalid", password: "cokoliv-dlouheho" } }));
  assert.deepEqual([response.status, (await json(response)).code], [503, "config"]);
  const form = await handleLogin(request("/api/auth/login", { form: { email: "jana@test.invalid", password: "x" } }));
  assert.equal(form.headers.get("location"), `${ORIGIN}/login?error=config`);
});

test("odhlášení odvolá session — stará cookie už nic neotevře", async () => {
  const { token } = await createTestSession(SECRET, { role: "user" });
  assert.equal((await handleSession(request("/api/auth/session", { token }))).status, 200);
  const logout = await handleLogout(request("/api/auth/logout", { method: "POST", token }));
  assert.equal(logout.headers.get("location"), `${ORIGIN}/login?status=logged_out`);
  assert.equal(setCookie(logout, AUTH_COOKIE_NAME), "");
  assert.equal((await handleSession(request("/api/auth/session", { token }))).status, 401);
});

test("obnovení session: po polovině nečinné doby se prodlouží (nejvýš do absolutní hranice); prošlá session → 401", async () => {
  const now = Date.now();
  const session = await createTestSession(SECRET, { role: "user", nowMs: now - (SESSION_TTL_SECONDS * 1000 * 3) / 4 });
  const response = await handleSession(request("/api/auth/session", { token: session.token }));
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.deepEqual(body.user, { id: session.user.id, email: session.user.email, displayName: null, role: "user", isHwsAdmin: false, apps: { abf: "user" } });
  assert.ok(!(body.permissions as string[]).includes("users.manage"));
  const renewed = setCookie(response, AUTH_COOKIE_NAME)!;
  assert.ok((await readSessionToken(renewed, SECRET))!.expiresAt > now + SESSION_TTL_SECONDS * 1000 * 0.9);
  assert.ok(store.sessions.get(session.sessionId)!.expiresAt > now + SESSION_TTL_SECONDS * 1000 * 0.9);
  const old = await createTestSession(SECRET, { nowMs: now - SESSION_TTL_SECONDS * 1000 - 1000 });
  assert.equal((await handleSession(request("/api/auth/session", { token: old.token }))).status, 401);
});

// =============================================================================================
// Reset password / invitation
// =============================================================================================
test("zapomenuté heslo: stejná odpověď pro každý e-mail; odkaz jen pro existující aktivní účet; odkaz vede do tohoto prostředí", async () => {
  const user = store.addUser({ role: "user", email: "reset@test.invalid" });
  store.addUser({ role: "user", email: "vypnuty@test.invalid", isActive: false });
  const gateway = fakeGateway({});
  setAuthGatewayForTesting(gateway);
  const answers = [];
  for (const email of ["reset@test.invalid", "neexistuje@test.invalid", "vypnuty@test.invalid"]) {
    const response = await handleForgotPassword(request("/api/auth/password/forgot", { body: { email } }));
    answers.push([response.status, (await json(response)).message]);
  }
  assert.equal(new Set(answers.map((answer) => JSON.stringify(answer))).size, 1, "no account enumeration");
  assert.deepEqual(gateway.log.recoveryEmails, [user.email]);
});

test("pozvánka / obnova: ověřený odkaz → krátkodobé oprávnění → heslo nastaveno, stará přihlášení ukončena, nové přihlášení", async () => {
  const user = store.addUser({ role: "external", email: "host@test.invalid" });
  const before = await createTestSession(SECRET, { user });
  const gateway = fakeGateway({});
  setAuthGatewayForTesting(gateway);
  const confirm = await handleConfirmLink(request(`/auth/confirm?token_hash=valid-${user.id}&type=invite`));
  assert.equal(confirm.headers.get("location"), `${ORIGIN}/login/nove-heslo?kind=invite`);
  const grant = setCookie(confirm, PASSWORD_SETUP_COOKIE_NAME)!;
  assert.equal((await handleConfirmLink(request("/auth/confirm?token_hash=bad&type=invite"))).headers.get("location"), `${ORIGIN}/login?error=link_invalid`);

  const weak = await handleSetPassword(request("/api/auth/password/set", { body: { password: "kratke" }, cookies: { [PASSWORD_SETUP_COOKIE_NAME]: grant } }));
  assert.equal(weak.status, 400);
  assert.equal((await handleSetPassword(request("/api/auth/password/set", { body: { password: "dostatecne-dlouhe" } }))).status, 401, "no grant");
  const set = await handleSetPassword(request("/api/auth/password/set", { body: { password: "dostatecne-dlouhe" }, cookies: { [PASSWORD_SETUP_COOKIE_NAME]: grant } }));
  assert.equal(set.status, 200);
  assert.deepEqual(gateway.log.passwords, [{ userId: user.id, password: "dostatecne-dlouhe" }]);
  assert.equal((await resolveSessionToken(before.token)).status, "unauthenticated", "old sessions revoked");
  assert.equal((await resolveSessionToken(setCookie(set, AUTH_COOKIE_NAME))).status, "authenticated");
  // A link of a deactivated account opens nothing.
  store.setActive(user.id, false);
  assert.equal((await handleConfirmLink(request(`/auth/confirm?token_hash=valid-${user.id}&type=recovery`))).headers.get("location"), `${ORIGIN}/login?error=inactive`);
});

test("adresa pro odkazy: v DEV jen lokální aplikace, jinde povinně https — DEV odkaz nikdy nevede do produkce", () => {
  assert.equal(appBaseUrl("http://localhost:3000/x", { NEXT_PUBLIC_APP_ENV: "development" }), "http://localhost:3000");
  assert.equal(appBaseUrl("http://localhost:3000/x", { NEXT_PUBLIC_APP_ENV: "development", APP_BASE_URL: "http://127.0.0.1:3005/" }), "http://127.0.0.1:3005");
  assert.throws(() => appBaseUrl("http://localhost:3000/x", { NEXT_PUBLIC_APP_ENV: "development", APP_BASE_URL: "https://app.homeworkstudio.cz" }), /lokální/u);
  assert.throws(() => appBaseUrl("https://app.example/x", { NEXT_PUBLIC_APP_ENV: "production" }), /APP_BASE_URL/u);
  assert.throws(() => appBaseUrl("https://app.example/x", { NEXT_PUBLIC_APP_ENV: "production", APP_BASE_URL: "http://app.example" }), /https/u);
});

// =============================================================================================
// Every API route: no session → 401, external → 403, user → 403 on global administration
// =============================================================================================
const PUBLIC_ROUTES = new Set(["auth/login", "auth/logout", "auth/session", "auth/callback", "auth/password/forgot", "auth/password/set"]);
// Routes an EXTERNAL user may call at all (each checks the concrete project / file itself).
const EXTERNAL_ROUTES = new Set(["projects/list", "assets/download", "assets/presign", "assets/delete", "projects/save", "projects/delete"]);
// Global administration: a BĚŽNÝ user gets 403 (method-specific).
const ADMIN_ONLY: ReadonlySet<string> = new Set([
  "GET admin/users", "POST admin/users/projects",
  // shared HomeworkStudio administration: its own permission, not an ABF role (V1-AUTH-02)
  "GET hws/accounts", "POST hws/accounts/invite", "POST hws/accounts/update", "POST hws/accounts/link",
  "POST catalog-admin/categories", "POST catalog-admin/items/aliases", "POST catalog-admin/items/create", "POST catalog-admin/items/duplicate",
  "POST catalog-admin/items/lifecycle", "POST catalog-admin/items/package", "POST catalog-admin/items/save", "POST catalog-admin/variant-sets",
  "POST events/save", "POST events/config", "POST price-lists/save", "POST pricing-admin/entries/save", "POST pricing-admin/price-lists/duplicate",
  "POST price-versions", "POST price-versions/rows", "POST purchase-prices", "POST purchase-prices/rows", "POST realization-companies", "POST realization-companies/update", "POST print-surfaces/catalog/sync",
  "GET catalog-admin/excel-import", "POST catalog-admin/excel-import/preview", "POST catalog-admin/excel-import/confirm", "GET catalog-admin/excel-import/runs",
]);

function routeFiles(directory: string, prefix = ""): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) return routeFiles(full, prefix ? `${prefix}/${name}` : name);
    return name === "route.ts" ? [prefix] : [];
  });
}

test("každá API routa: bez přihlášení 401, externí účet 403 (mimo vlastní projekty/soubory), běžný účet 403 na globální administraci, účet bez ABF 403 všude", async () => {
  const external = await createTestSession(SECRET, { role: "external" });
  const user = await createTestSession(SECRET, { role: "user" });
  // V1-AUTH-02: an active account WITHOUT an ABF membership (but with another application and an old project assignment)
  const noAbf = await createTestSession(SECRET, { role: null, apps: { "hws-easy": "user" } });
  store.assign(noAbf.user.id, "p-1");
  const routes = routeFiles(path.resolve("app/api"));
  assert.ok(routes.length >= 80, `${routes.length} routes`);
  let checked = 0;
  for (const route of routes) {
    if (PUBLIC_ROUTES.has(route)) continue;
    const module = (await import(pathToFileURL(path.resolve("app/api", route, "route.ts")).href)) as Record<string, unknown>;
    for (const method of ["GET", "POST", "DELETE"] as const) {
      const handler = module[method] as ((request: NextRequest) => Promise<Response>) | undefined;
      if (!handler) continue;
      const make = (token?: string) => request(`/api/${route}`, { method, token, ...(method === "GET" ? {} : { body: {} }) });
      assert.equal((await handler(make())).status, 401, `${method} ${route} without session`);
      if (!EXTERNAL_ROUTES.has(route)) assert.equal((await handler(make(external.token))).status, 403, `${method} ${route} as external`);
      const asUser = (await handler(make(user.token))).status;
      if (ADMIN_ONLY.has(`${method} ${route}`)) assert.equal(asUser, 403, `${method} ${route} as user`);
      else assert.notEqual(asUser, 403, `${method} ${route} as user must not be forbidden`);
      assert.notEqual(asUser, 401, `${method} ${route} as user`);
      assert.equal((await handler(make(noAbf.token))).status, 403, `${method} ${route} without ABF membership`);
      checked += 1;
    }
  }
  assert.ok(checked >= 85, `${checked} handlers checked`);
});

// =============================================================================================
// Projects: assignment, external view, removal, deactivation
// =============================================================================================
type ProjectRow = { id: string; name: string; fairId: string; boothNumber: string; status: string; modifiedAt: string; notes: string; sceneObjects: unknown[]; visualizations: unknown[]; generatedPlanOutputs: unknown[]; graphicsFiles: unknown[] };
const project = (id: string): ProjectRow => ({
  id, name: `Projekt ${id}`, fairId: "decor-2026", boothNumber: "A12", status: "inProgress", modifiedAt: "2026-11-06T10:00:00Z",
  notes: "interní poznámka — cena 12 000", sceneObjects: [{ id: "x" }],
  visualizations: [{ asset: { storageKey: `projects/${id}/visualizations/v1.png`, originalFileName: "vizualizace.png" } }],
  generatedPlanOutputs: [{ asset: { storageKey: `projects/${id}/exports/plan.pdf`, displayName: "Plán.pdf" } }],
  graphicsFiles: [{ asset: { storageKey: `projects/${id}/graphics/logo.ai` } }],
});
const repository = (rows: ProjectRow[]) => () => ({
  list: async () => rows,
  get: async (id: string) => rows.find((row) => row.id === id),
  getWithRevision: async (id: string) => rows.find((row) => row.id === id),
  save: async (row: ProjectRow) => row,
  saveWithRevision: async (row: ProjectRow) => ({ ...row, revision: 1 }),
  delete: async () => undefined,
}) as never;

test("seznam projektů: správce vše, běžný jen přiřazené, externí jen přiřazené ve výřezu bez interních dat; bez přiřazení nic", async () => {
  const rows = [project("p-1"), project("p-2"), project("p-3")];
  const admin = await createTestSession(SECRET, { role: "admin" });
  const user = await createTestSession(SECRET, { role: "user" });
  const external = await createTestSession(SECRET, { role: "external" });
  const lonely = await createTestSession(SECRET, { role: "external" });
  store.assign(user.user.id, "p-1");
  store.assign(external.user.id, "p-2");
  const ids = async (token: string) => ((await json(await handleProjectsList(request("/api/projects/list", { token }), repository(rows)))).projects as { id: string }[]).map((entry) => entry.id);
  assert.deepEqual(await ids(admin.token), ["p-1", "p-2", "p-3"]);
  assert.deepEqual(await ids(user.token), ["p-1"]);
  assert.deepEqual(await ids(lonely.token), []);
  const view = (await json(await handleProjectsList(request("/api/projects/list", { token: external.token }), repository(rows)))).projects as Record<string, unknown>[];
  assert.deepEqual(Object.keys(view[0]!).sort(), ["boothNumber", "fairId", "id", "modifiedAt", "name", "outputs", "status"]);
  assert.doesNotMatch(JSON.stringify(view), /interní poznámka|sceneObjects|graphics/u);
  assert.deepEqual((view[0]!.outputs as { storageKey: string }[]).map((output) => output.storageKey).sort(), ["projects/p-2/exports/plan.pdf", "projects/p-2/visualizations/v1.png"]);
  assert.deepEqual(externalProjectView(project("p-9") as never).outputs.length, 2);
});

test("úprava projektu: nepřiřazený → 403, nový → povolen a autor přiřazen, externí nikdy; odebrání přiřazení platí okamžitě i v přímém API", async () => {
  const user = await createTestSession(SECRET, { role: "user" });
  const external = await createTestSession(SECRET, { role: "external" });
  store.projects.add("p-foreign");
  const save = (token: string, id: string, expectedRevision: number | null) => handleProjectsSave(request("/api/projects/save", { token, body: { project: { id, name: "X" }, expectedRevision } }), repository([]), () => async () => ({ ok: true, eventId: undefined }) as never);
  assert.equal((await save(user.token, "p-foreign", 1)).status, 403);
  assert.equal((await save(user.token, "p-new-1", null)).status, 200);
  assert.equal(await store.isProjectMember(user.user.id, "p-new-1"), true, "creator assigned");
  store.assign(external.user.id, "p-ext");
  assert.equal((await save(external.token, "p-ext", 1)).status, 403, "external never edits");
  assert.equal((await handleProjectsDelete(request("/api/projects/delete", { token: external.token, body: { id: "p-ext" } }), repository([]))).status, 403);
  // Assigned → allowed; assignment removed → the very next direct call is refused.
  store.assign(user.user.id, "p-shared");
  assert.equal((await authorizeProject(request("/api/projects/save", { token: user.token }), "p-shared", "write")).ok, true);
  store.unassign(user.user.id, "p-shared");
  assert.equal((await authorizeProject(request("/api/projects/save", { token: user.token }), "p-shared", "write")).ok, false);
  assert.equal((await authorizeFile(request("/api/assets/download", { token: external.token }), "projects/p-ext/exports/plan.pdf", "read")).ok, true);
  store.unassign(external.user.id, "p-ext");
  assert.equal((await authorizeFile(request("/api/assets/download", { token: external.token }), "projects/p-ext/exports/plan.pdf", "read")).ok, false);
});

test("soubory a exporty: externí jen výstupy přiřazeného projektu; běžný nenahraje do katalogu ani cizího projektu; správce vše", async () => {
  const admin = await createTestSession(SECRET, { role: "admin" });
  const user = await createTestSession(SECRET, { role: "user" });
  const external = await createTestSession(SECRET, { role: "external" });
  store.assign(external.user.id, "p-out");
  store.assign(user.user.id, "p-own");
  store.projects.add("p-other");
  const allowed = async (token: string, key: string, action: "read" | "write") => (await authorizeFile(request("/api/assets/download", { token }), key, action)).ok;
  assert.equal(await allowed(external.token, "projects/p-out/exports/plan.pdf", "read"), true);
  assert.equal(await allowed(external.token, "projects/p-out/visualizations/v.png", "read"), true);
  assert.equal(await allowed(external.token, "projects/p-out/graphics/logo.ai", "read"), false);
  assert.equal(await allowed(external.token, "projects/p-out/exports/plan.pdf", "write"), false);
  assert.equal(await allowed(external.token, "catalog/furniture/m57/photos/a.png", "read"), false);
  assert.equal(await allowed(external.token, "events/decor/documents/a.pdf", "read"), false);
  assert.equal(await allowed(user.token, "catalog/furniture/m57/photos/a.png", "read"), true);
  assert.equal(await allowed(user.token, "catalog/furniture/m57/photos/a.png", "write"), false);
  assert.equal(await allowed(user.token, "projects/p-own/graphics/a.png", "write"), true);
  assert.equal(await allowed(user.token, "projects/p-other/graphics/a.png", "read"), false);
  assert.equal(await allowed(user.token, "projects/p-unsaved/graphics/a.png", "write"), true, "upload before the first save of a new project");
  assert.equal(await allowed(admin.token, "projects/p-other/exports/a.pdf", "write"), true);
  // The route itself: download of a foreign project's export → 403 before any storage call.
  const { handleAssetDownload } = await import("../app/api/assets/download/route.ts");
  let storageCalls = 0;
  const provider = () => ({ getMetadata: async () => { storageCalls += 1; return {}; }, getDownloadUrl: async () => "https://signed" }) as never;
  assert.equal((await handleAssetDownload(request("/api/assets/download", { token: user.token, body: { storageKey: "projects/p-other/exports/a.pdf" } }), provider)).status, 403);
  assert.equal((await handleAssetDownload(request("/api/assets/download", { token: external.token, body: { storageKey: "projects/p-out/exports/a.pdf" } }), provider)).status, 200);
  assert.equal(storageCalls, 1);
});

test("deaktivace: dříve vydaná session přestane číst i zapisovat hned (403 účet deaktivován)", async () => {
  const session = await createTestSession(SECRET, { role: "user" });
  store.assign(session.user.id, "p-d");
  assert.equal((await authorizeProject(request("/x", { token: session.token }), "p-d", "write")).ok, true);
  store.setActive(session.user.id, false);
  const decision = await authorizeProject(request("/x", { token: session.token }), "p-d", "read");
  assert.equal(decision.ok, false);
  const response = (decision as { response: Response }).response;
  assert.equal(response.status, 403);
  assert.equal(((await response.json()) as { code: string }).code, "account_inactive");
  assert.equal((await handleProjectsList(request("/api/projects/list", { token: session.token }), repository([project("p-d")]))).status === 200, false);
});

// =============================================================================================
// ABF → Uživatelé a přiřazení (V1-AUTH-02: ABF members only, assignments only)
// =============================================================================================
function memoryUsersStore(initial: AdminUserRecord[]): UsersAdminStore & { rows: AdminUserRecord[]; assigned: Map<string, string[]> } {
  const rows = [...initial];
  const assigned = new Map<string, string[]>();
  return {
    rows,
    assigned,
    async list() { return rows.filter((row) => row.role !== undefined); },
    async get(id) { return rows.find((row) => row.id === id); },
    async setProjects(id, ids) { assigned.set(id, [...ids].sort()); return [...ids].sort(); },
    async assignableProjects() { return []; },
  };
}

test("ABF uživatelé: jen správce ABF; seznam jen členů ABF; nové přiřazení jen aktivnímu členovi, odebrání vždy; zakládání účtů tu není", async () => {
  const admin = await createTestSession(SECRET, { role: "admin" });
  const user = await createTestSession(SECRET, { role: "user" });
  const external = await createTestSession(SECRET, { role: "external" });
  const record = (id: string, role: AppRole | undefined, isActive = true, projectIds: string[] = []): AdminUserRecord => ({ id, email: `${id.slice(0, 6)}@test.invalid`, displayName: null, ...(role ? { role } : {}), isActive, isHwsAdmin: false, apps: role ? { abf: role } : {}, createdAt: "t", updatedAt: "t0", deactivatedAt: null, projectIds });
  const outsider = crypto.randomUUID();
  const sleeper = crypto.randomUUID();
  const users = memoryUsersStore([record(admin.user.id, "admin"), record(user.user.id, "user"), record(outsider, undefined, true, ["p-old"]), record(sleeper, "user", false, ["p-old"])]);
  setUsersAdminStoreForTesting(users);
  try {
    for (const token of [user.token, external.token]) {
      assert.equal((await handleUsersList(request("/api/admin/users", { token }))).status, 403);
      assert.equal((await handleUserProjects(request("/api/admin/users/projects", { token, body: { userId: user.user.id, projectIds: ["p"] } }))).status, 403);
    }
    const listed = ((await json(await handleUsersList(request("/api/admin/users", { token: admin.token })))).users as { id: string }[]).map((entry) => entry.id);
    assert.ok(listed.includes(user.user.id) && listed.includes(sleeper));
    assert.equal(listed.includes(outsider), false, "an account without ABF is not offered");
    assert.equal((await handleUserProjects(request("/api/admin/users/projects", { token: admin.token, body: { userId: user.user.id, projectIds: ["p-1"] } }))).status, 200);
    const refused = await handleUserProjects(request("/api/admin/users/projects", { token: admin.token, body: { userId: outsider, projectIds: ["p-old", "p-new"] } }));
    assert.deepEqual([refused.status, (await json(refused)).code], [409, "no_app_access"], "no new assignment without ABF");
    assert.equal((await handleUserProjects(request("/api/admin/users/projects", { token: admin.token, body: { userId: sleeper, projectIds: ["p-old", "p-new"] } }))).status, 409, "no new assignment for a deactivated account");
    assert.equal((await handleUserProjects(request("/api/admin/users/projects", { token: admin.token, body: { userId: sleeper, projectIds: [] } }))).status, 200, "removing is always possible");
    // creating accounts / roles moved to the shared administration
    const routes = routeFiles(path.resolve("app/api"));
    assert.equal(routes.includes("admin/users/update") || routes.includes("admin/users/link"), false);
    const adminUsersRoute = (await import(pathToFileURL(path.resolve("app/api/admin/users/route.ts")).href)) as Record<string, unknown>;
    assert.equal(adminUsersRoute.POST, undefined, "ABF does not create shared accounts");
  } finally {
    setUsersAdminStoreForTesting(undefined);
  }
});
