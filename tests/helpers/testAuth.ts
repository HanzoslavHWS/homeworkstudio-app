/**
 * Test support for V1-AUTH-01 / V1-AUTH-02: an in-memory AuthStore with the same contract as the database one
 * (lib/auth/authStore.server.ts). A test session is a REAL signed cookie (createSessionToken with the
 * test secret) backed by a session row and an app user in this store — nothing is skipped: a wrong
 * signature, an expired / revoked session or a deactivated user is refused exactly as in production.
 */
import { randomUUID } from "node:crypto";
import type { AppRole } from "../../domain/accessControl.ts";
import type { AppMemberships, HwsAppKey } from "../../domain/hwsApps.ts";
import { setAuthStoreForTesting, type AuthStore, type AuthUser, type StoredSession } from "../../lib/auth/authStore.server.ts";
import { createSessionToken, SESSION_ABSOLUTE_TTL_SECONDS, SESSION_TTL_SECONDS } from "../../lib/auth/session.ts";

type MutableSession = { -readonly [K in keyof StoredSession]: StoredSession[K] };
type MutableUser = { -readonly [K in keyof AuthUser]: AuthUser[K] };

export class MemoryAuthStore implements AuthStore {
  readonly users = new Map<string, MutableUser>();
  readonly sessions = new Map<string, MutableSession>();
  readonly members = new Set<string>();
  readonly projects = new Set<string>();

  /** `role` = the ABF membership (as before V1-AUTH-02); `role: null` = an account without ABF; `apps` = other memberships. */
  addUser(input: Partial<Omit<AuthUser, "role">> & Readonly<{ role: AppRole | null }>): AuthUser {
    const id = input.id ?? randomUUID();
    const apps: Partial<Record<HwsAppKey, string>> = { ...(input.apps ?? {}) };
    if (input.role) apps.abf = input.role;
    const user: MutableUser = { id, email: input.email ?? `${input.role ?? "none"}-${id.slice(0, 8)}@test.invalid`, displayName: input.displayName ?? null, ...(input.role ? { role: input.role } : {}), isActive: input.isActive ?? true, isHwsAdmin: input.isHwsAdmin ?? false, apps: apps as AppMemberships };
    this.users.set(id, user);
    return user;
  }
  setActive(userId: string, isActive: boolean): void {
    this.users.get(userId)!.isActive = isActive;
    if (!isActive) for (const session of this.sessions.values()) if (session.userId === userId && session.revokedAt === null) session.revokedAt = Date.now();
  }
  setRole(userId: string, role: AppRole): void {
    this.setMembership(userId, "abf", role);
  }
  /** Grants (role) or removes (undefined) one application membership — like the database row. */
  setMembership(userId: string, appKey: HwsAppKey, role: string | undefined): void {
    const user = this.users.get(userId)!;
    const apps: Partial<Record<HwsAppKey, string>> = { ...user.apps };
    if (role === undefined) delete apps[appKey];
    else apps[appKey] = role;
    user.apps = apps as AppMemberships;
    if (appKey === "abf") {
      if (role === undefined) delete user.role;
      else user.role = role as AppRole;
    }
  }
  setHwsAdmin(userId: string, isHwsAdmin: boolean): void {
    this.users.get(userId)!.isHwsAdmin = isHwsAdmin;
  }
  assign(userId: string, projectId: string): void {
    this.projects.add(projectId);
    this.members.add(`${projectId}|${userId}`);
  }
  unassign(userId: string, projectId: string): void {
    this.members.delete(`${projectId}|${userId}`);
  }

  async loadSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    const user = session ? this.users.get(session.userId) : undefined;
    return session && user ? { session: { ...session }, user: { ...user, apps: { ...user.apps } } } : undefined;
  }
  async createSession(userId: string, expiresAt: number, absoluteExpiresAt: number) {
    const session: MutableSession = { id: randomUUID(), userId, createdAt: Date.now(), expiresAt, absoluteExpiresAt, revokedAt: null };
    this.sessions.set(session.id, session);
    return { ...session };
  }
  async extendSession(sessionId: string, expiresAt: number) {
    const session = this.sessions.get(sessionId);
    if (session && session.revokedAt === null) session.expiresAt = expiresAt;
  }
  async revokeSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session && session.revokedAt === null) session.revokedAt = Date.now();
  }
  async revokeUserSessions(userId: string) {
    for (const session of this.sessions.values()) if (session.userId === userId && session.revokedAt === null) session.revokedAt = Date.now();
  }
  async findUserById(userId: string) {
    const user = this.users.get(userId);
    return user ? { ...user } : undefined;
  }
  async findUserByEmail(email: string) {
    const user = [...this.users.values()].find((candidate) => candidate.email === email.trim().toLowerCase());
    return user ? { ...user } : undefined;
  }
  async projectExists(projectId: string) {
    return this.projects.has(projectId);
  }
  async isProjectMember(userId: string, projectId: string) {
    return this.members.has(`${projectId}|${userId}`);
  }
  async memberProjectIds(userId: string) {
    return new Set([...this.members].filter((key) => key.endsWith(`|${userId}`)).map((key) => key.split("|")[0]!));
  }
  async addProjectMember(projectId: string, userId: string) {
    this.assign(userId, projectId);
  }
}

let shared: MemoryAuthStore | undefined;

/** The in-memory store of this test process (installed on first use). */
export function testAuthStore(): MemoryAuthStore {
  if (!shared) {
    shared = new MemoryAuthStore();
    setAuthStoreForTesting(shared);
  }
  return shared;
}

/** A signed session cookie value for a new user of `role` (default admin = every permission). */
export async function createTestSessionToken(secret: string, nowMs = Date.now(), role: AppRole = "admin"): Promise<string> {
  return (await createTestSession(secret, { role, nowMs })).token;
}

export async function createTestSession(secret: string, options: Readonly<{ role?: AppRole | null; nowMs?: number; user?: AuthUser; isHwsAdmin?: boolean; apps?: AppMemberships }> = {}): Promise<Readonly<{ token: string; user: AuthUser; sessionId: string }>> {
  const store = testAuthStore();
  const nowMs = options.nowMs ?? Date.now();
  const user = options.user ?? store.addUser({ role: options.role === undefined ? "admin" : options.role, isHwsAdmin: options.isHwsAdmin, apps: options.apps });
  const expiresAt = nowMs + SESSION_TTL_SECONDS * 1000;
  const session = await store.createSession(user.id, expiresAt, nowMs + SESSION_ABSOLUTE_TTL_SECONDS * 1000);
  return { token: await createSessionToken(secret, { sessionId: session.id, userId: user.id, expiresAt }), user, sessionId: session.id };
}
