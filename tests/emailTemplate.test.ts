import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { handleEmailTemplatesSave } from "../app/api/emails/templates/save/route.ts";
import { handleEmailTemplatesDelete } from "../app/api/emails/templates/delete/route.ts";
import { handleEmailTemplatesList } from "../app/api/emails/templates/list/route.ts";
import { createSessionToken } from "../lib/auth/session.ts";
import { EmailTemplateProtectedError, type EmailTemplate, type EmailTemplateCreateInput, type EmailTemplateEditInput, type EmailTemplateRepository } from "../domain/emailTemplate.ts";

const SECRET = "email-template-test-session-secret-32ch";
const mutableEnv = process.env as Record<string, string | undefined>;
mutableEnv.APP_SESSION_SECRET = SECRET;

function authenticatedRequest(token: string | undefined, url: string, init: Readonly<{ method?: string; body?: unknown }> = {}) {
  const headers: Record<string, string> = {};
  if (token) headers.Cookie = `homeworkstudio_session=${token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  return new NextRequest(url, { method: init.method ?? "GET", headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
}

let sequence = 0;

/** In-memory fake mirroring lib/db/emailTemplateRepository.supabase.ts's exact scope-guard contract — update/delete on a scope: "system" row always throws EmailTemplateProtectedError. */
function fakeTemplateRepository(seed: readonly EmailTemplate[] = []): EmailTemplateRepository {
  const rows = new Map(seed.map((template) => [template.id, template]));
  return {
    async list() { return [...rows.values()]; },
    async create(input: EmailTemplateCreateInput) {
      const now = new Date().toISOString();
      const template: EmailTemplate = { id: `tpl-${sequence++}`, scope: "user", name: input.name, freeText: input.freeText, aiInstruction: input.aiInstruction, languageCode: input.languageCode, toneId: input.toneId, createdAt: now, updatedAt: now };
      rows.set(template.id, template);
      return template;
    },
    async update(id: string, edit: EmailTemplateEditInput) {
      const current = rows.get(id);
      if (!current || current.scope === "system") throw new EmailTemplateProtectedError(id);
      const updated: EmailTemplate = { ...current, name: edit.name, freeText: edit.freeText, aiInstruction: edit.aiInstruction, languageCode: edit.languageCode, toneId: edit.toneId, updatedAt: new Date().toISOString() };
      rows.set(id, updated);
      return updated;
    },
    async delete(id: string) {
      const current = rows.get(id);
      if (current?.scope === "system") throw new EmailTemplateProtectedError(id);
      rows.delete(id);
    },
  };
}

function systemTemplate(overrides: Partial<EmailTemplate> = {}): EmailTemplate {
  return { id: "sys-1", scope: "system", name: "Zaslání kalkulace", aiInstruction: "…", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...overrides };
}

test("CREATE: save without an id always produces scope: \"user\", regardless of what the caller sends", async () => {
  const token = await createSessionToken(SECRET);
  const repository = fakeTemplateRepository();
  const response = await handleEmailTemplatesSave(authenticatedRequest(token, "http://localhost/api/emails/templates/save", { method: "POST", body: { template: { name: "Moje šablona" } } }), () => repository);
  assert.equal(response.status, 200);
  const body = await response.json() as { template: EmailTemplate };
  assert.equal(body.template.scope, "user");
  assert.equal(body.template.name, "Moje šablona");
});

test("LIST: system and user templates both appear", async () => {
  const token = await createSessionToken(SECRET);
  const repository = fakeTemplateRepository([systemTemplate()]);
  await repository.create({ name: "Moje" });
  const response = await handleEmailTemplatesList(authenticatedRequest(token, "http://localhost/api/emails/templates/list"), () => repository);
  const body = await response.json() as { templates: EmailTemplate[] };
  assert.equal(body.templates.length, 2);
  assert.ok(body.templates.some((template) => template.scope === "system"));
  assert.ok(body.templates.some((template) => template.scope === "user"));
});

test("PROTECTED: updating a scope: \"system\" template via the API is rejected with 400, never silently succeeds", async () => {
  const token = await createSessionToken(SECRET);
  const repository = fakeTemplateRepository([systemTemplate()]);
  const response = await handleEmailTemplatesSave(authenticatedRequest(token, "http://localhost/api/emails/templates/save", { method: "POST", body: { id: "sys-1", template: { name: "Hacked name" } } }), () => repository);
  assert.equal(response.status, 400);
  const listed = await repository.list();
  assert.equal(listed.find((template) => template.id === "sys-1")!.name, "Zaslání kalkulace");
});

test("PROTECTED: deleting a scope: \"system\" template via the API is rejected with 400, never silently succeeds", async () => {
  const token = await createSessionToken(SECRET);
  const repository = fakeTemplateRepository([systemTemplate()]);
  const response = await handleEmailTemplatesDelete(authenticatedRequest(token, "http://localhost/api/emails/templates/delete", { method: "POST", body: { id: "sys-1" } }), () => repository);
  assert.equal(response.status, 400);
  const listed = await repository.list();
  assert.ok(listed.some((template) => template.id === "sys-1"), "system template must still exist");
});

test("USER SCOPE: update and delete both succeed for a scope: \"user\" template", async () => {
  const token = await createSessionToken(SECRET);
  const repository = fakeTemplateRepository();
  const created = await repository.create({ name: "Původní" });

  const updateResponse = await handleEmailTemplatesSave(authenticatedRequest(token, "http://localhost/api/emails/templates/save", { method: "POST", body: { id: created.id, template: { name: "Upraveno" } } }), () => repository);
  assert.equal(updateResponse.status, 200);
  const updateBody = await updateResponse.json() as { template: EmailTemplate };
  assert.equal(updateBody.template.name, "Upraveno");

  const deleteResponse = await handleEmailTemplatesDelete(authenticatedRequest(token, "http://localhost/api/emails/templates/delete", { method: "POST", body: { id: created.id } }), () => repository);
  assert.equal(deleteResponse.status, 200);
  assert.equal((await repository.list()).length, 0);
});

test("AUTH: unauthenticated requests to save/delete/list are rejected with 401", async () => {
  const repository = fakeTemplateRepository();
  const factory = () => repository;
  assert.equal((await handleEmailTemplatesList(authenticatedRequest(undefined, "http://localhost/api/emails/templates/list"), factory)).status, 401);
  assert.equal((await handleEmailTemplatesSave(authenticatedRequest(undefined, "http://localhost/api/emails/templates/save", { method: "POST", body: { template: { name: "x" } } }), factory)).status, 401);
  assert.equal((await handleEmailTemplatesDelete(authenticatedRequest(undefined, "http://localhost/api/emails/templates/delete", { method: "POST", body: { id: "x" } }), factory)).status, 401);
});
