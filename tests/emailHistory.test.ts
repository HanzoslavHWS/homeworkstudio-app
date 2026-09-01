import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { handleEmailHistoryList } from "../app/api/emails/history/list/route.ts";
import { handleEmailHistorySave } from "../app/api/emails/history/save/route.ts";
import { handleEmailHistoryUpdate } from "../app/api/emails/history/update/route.ts";
import { handleEmailHistoryDelete } from "../app/api/emails/history/delete/route.ts";
import { createSessionToken } from "../lib/auth/session.ts";
import { nextHistorySaveAction, type EmailHistoryEntry, type EmailHistoryRepository, type EmailHistorySaveInput } from "../domain/emailHistory.ts";

const SECRET = "email-history-test-session-secret-32ch";
const mutableEnv = process.env as Record<string, string | undefined>;
mutableEnv.APP_SESSION_SECRET = SECRET;

function authenticatedRequest(token: string | undefined, url: string, init: Readonly<{ method?: string; body?: unknown }> = {}) {
  const headers: Record<string, string> = {};
  if (token) headers.Cookie = `homeworkstudio_session=${token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  return new NextRequest(url, { method: init.method ?? "GET", headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
}

let sequence = 0;

function fakeHistoryRepository(seed: readonly EmailHistoryEntry[] = []): EmailHistoryRepository {
  const rows = new Map(seed.map((entry) => [entry.id, entry]));
  return {
    async list() { return [...rows.values()]; },
    async create(input: EmailHistorySaveInput) {
      const now = new Date().toISOString();
      const entry: EmailHistoryEntry = { id: `hist-${sequence++}`, createdAt: now, updatedAt: now, ...input };
      rows.set(entry.id, entry);
      return entry;
    },
    async update(id: string, input: EmailHistorySaveInput) {
      const current = rows.get(id);
      if (!current) throw new Error("not found");
      const updated: EmailHistoryEntry = { ...current, ...input, updatedAt: new Date().toISOString() };
      rows.set(id, updated);
      return updated;
    },
    async delete(id: string) { rows.delete(id); },
  };
}

// =========================================================================================
// Section 12's dedup rule, isolated as a pure decision.
// =========================================================================================

test("nextHistorySaveAction: no currentHistoryId -> create", () => {
  assert.deepEqual(nextHistorySaveAction(undefined), { action: "create" });
});

test("nextHistorySaveAction: currentHistoryId set -> update with that exact id", () => {
  assert.deepEqual(nextHistorySaveAction("hist-42"), { action: "update", id: "hist-42" });
});

// =========================================================================================
// Route-level behavior (fake repository injected — no live DB call).
// =========================================================================================

const baseInput: EmailHistorySaveInput = { language: "cs", tone: "natural", subject: "Kalkulace", body: "Dobrý den, posíláme kalkulaci." };

test("SAVE then UPDATE (Copy then Outlook): updating the SAME id never creates a second row", async () => {
  const token = await createSessionToken(SECRET);
  const repository = fakeHistoryRepository();
  const factory = () => repository;

  const saved = await handleEmailHistorySave(authenticatedRequest(token, "http://localhost/api/emails/history/save", { method: "POST", body: { entry: baseInput } }), factory);
  assert.equal(saved.status, 200);
  const savedEntry = (await saved.json() as { entry: EmailHistoryEntry }).entry;

  const decision = nextHistorySaveAction(savedEntry.id);
  assert.equal(decision.action, "update");

  const updated = await handleEmailHistoryUpdate(authenticatedRequest(token, "http://localhost/api/emails/history/update", { method: "POST", body: { id: savedEntry.id, entry: { ...baseInput, body: "Upravený text po ruční editaci." } } }), factory);
  assert.equal(updated.status, 200);

  const listed = await repository.list();
  assert.equal(listed.length, 1, "must still be exactly one row");
  assert.equal(listed[0]!.body, "Upravený text po ruční editaci.", "the manually-edited CURRENT body is what gets saved, never the original");
});

test("LIST: returns saved entries", async () => {
  const token = await createSessionToken(SECRET);
  const repository = fakeHistoryRepository();
  await repository.create(baseInput);
  const response = await handleEmailHistoryList(authenticatedRequest(token, "http://localhost/api/emails/history/list"), () => repository);
  const body = await response.json() as { entries: EmailHistoryEntry[] };
  assert.equal(body.entries.length, 1);
});

test("DELETE: removes the entry", async () => {
  const token = await createSessionToken(SECRET);
  const repository = fakeHistoryRepository();
  const entry = await repository.create(baseInput);
  const response = await handleEmailHistoryDelete(authenticatedRequest(token, "http://localhost/api/emails/history/delete", { method: "POST", body: { id: entry.id } }), () => repository);
  assert.equal(response.status, 200);
  assert.equal((await repository.list()).length, 0);
});

test("VALIDATION: save rejects an entry missing body/language", async () => {
  const token = await createSessionToken(SECRET);
  const repository = fakeHistoryRepository();
  const response = await handleEmailHistorySave(authenticatedRequest(token, "http://localhost/api/emails/history/save", { method: "POST", body: { entry: { subject: "x", body: "", language: "cs" } } }), () => repository);
  assert.equal(response.status, 400);
});

test("eventNameSnapshot: preserved on the saved entry even if the caller's event has since been renamed elsewhere", async () => {
  const token = await createSessionToken(SECRET);
  const repository = fakeHistoryRepository();
  const response = await handleEmailHistorySave(authenticatedRequest(token, "http://localhost/api/emails/history/save", { method: "POST", body: { entry: { ...baseInput, eventId: "evt-1", eventNameSnapshot: "FOR BEAUTY podzim 2026" } } }), () => repository);
  const body = (await response.json() as { entry: EmailHistoryEntry }).entry;
  assert.equal(body.eventNameSnapshot, "FOR BEAUTY podzim 2026");
});

test("AUTH: unauthenticated requests to list/save/update/delete are rejected with 401", async () => {
  const repository = fakeHistoryRepository();
  const factory = () => repository;
  assert.equal((await handleEmailHistoryList(authenticatedRequest(undefined, "http://localhost/api/emails/history/list"), factory)).status, 401);
  assert.equal((await handleEmailHistorySave(authenticatedRequest(undefined, "http://localhost/api/emails/history/save", { method: "POST", body: { entry: baseInput } }), factory)).status, 401);
  assert.equal((await handleEmailHistoryUpdate(authenticatedRequest(undefined, "http://localhost/api/emails/history/update", { method: "POST", body: { id: "x", entry: baseInput } }), factory)).status, 401);
  assert.equal((await handleEmailHistoryDelete(authenticatedRequest(undefined, "http://localhost/api/emails/history/delete", { method: "POST", body: { id: "x" } }), factory)).status, 401);
});
