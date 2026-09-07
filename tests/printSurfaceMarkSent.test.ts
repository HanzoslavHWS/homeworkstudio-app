import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  addPrintSurfaceItemWithPlacement,
  addPrintSurfaceView,
  createPrintSurfaceProject,
  markPrintSurfaceProjectSent,
  withLatestPdf,
  type PrintSurfaceLatestPdf,
  type PrintSurfaceProject,
} from "../domain/printSurfaceProject.ts";
import { SupabasePrintSurfaceProjectRepository } from "../lib/db/printSurfaceProjectRepository.supabase.ts";
import { handlePrintSurfaceProjectSave } from "../app/api/print-surfaces/projects/save/route.ts";
import { NextRequest } from "next/server.js";
import { createSessionToken } from "../lib/auth/session.ts";
import type { PrintSurfaceProjectRepository } from "../domain/printSurfaceProject.ts";

// =============================================================================================
// Regression coverage for the "Potvrdit jako odesláno" -> "Chyba ukládání" bug.
//
// Root cause: print_surface_projects originally had `constraint print_surface_projects_sent_pair
// check ((sent_at is null) = (sent_by is null))` (supabase/migrations/20260906150000_print_surfaces.sql).
// PrintSurfaceEditorPage.handleMarkSent calls markPrintSurfaceProjectSent(current,
// current.createdBy) — and this app has no per-user login yet (one shared login), so createdBy
// (and therefore sentBy) is always undefined in real usage. That wrote sent_at=<timestamp>,
// sent_by=NULL, which violated the original symmetric CHECK constraint.
//
// Per project convention, createdBy/sentBy stay nullable rather than get a fake placeholder actor
// (no "shared-account" invention) — so the FIX is a new migration
// (20260907130000_print_surfaces_sent_pair_constraint.sql) that relaxes the constraint to the
// asymmetric invariant this app's real usage actually needs: sent_by without sent_at is invalid;
// sent_at without sent_by is valid (and today, the norm). The original migration file is left
// untouched — this is a NEW migration that drops and replaces the constraint.
//
// The hand-rolled fake Supabase client used by tests/printSurfaceDb.test.ts never enforced CHECK
// constraints at all, so this was invisible to the existing suite — this file's fake client below
// DOES enforce the (new) constraint, on purpose.
// =============================================================================================

function makeLatestPdf(overrides: Partial<PrintSurfaceLatestPdf> = {}): PrintSurfaceLatestPdf {
  return {
    storageKey: overrides.storageKey ?? "print-surfaces/export/11111111-1111-1111-1111-111111111111.pdf",
    fileName: overrides.fileName ?? "Tiskove_plochy_FOR_BEAUTY_Test_001.pdf",
    generatedAt: overrides.generatedAt ?? "2026-02-01T09:00:00.000Z",
    projectFingerprint: overrides.projectFingerprint ?? ({} as PrintSurfaceLatestPdf["projectFingerprint"]),
  };
}

test("markPrintSurfaceProjectSent: bez skutečné user identity (sentBy=undefined) zůstává sentBy undefined — NIKDY fake actor jako 'shared-account'", () => {
  const project = createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1");
  assert.equal(project.createdBy, undefined, "reálný projekt dnes nemá createdBy (žádný per-user login)");

  const sent = markPrintSurfaceProjectSent(project, project.createdBy, "2026-02-01T10:00:00.000Z");
  assert.equal(sent.status, "sent");
  assert.equal(sent.sentAt, "2026-02-01T10:00:00.000Z");
  assert.equal(sent.sentBy, undefined, "sentBy zůstává nullable/undefined, dokud neexistuje skutečná per-user identita — žádný vymyšlený actor");
});

test("markPrintSurfaceProjectSent: reálný sentBy (budoucí per-user login) se zapíše beze změny", () => {
  const project = createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1");
  const sent = markPrintSurfaceProjectSent(project, "jan.novak", "2026-02-01T10:00:00.000Z");
  assert.equal(sent.sentBy, "jan.novak");
});

// -----------------------------------------------------------------------------------------------
// Fake Supabase client that enforces the NEW (post-20260907130000) sent_pair CHECK constraint:
// sent_by without sent_at is invalid; sent_at without sent_by is valid. Unlike the shared fake in
// tests/printSurfaceDb.test.ts (which enforces nothing), this is the piece that proves the actual
// DB-level invariant the migration establishes.
// -----------------------------------------------------------------------------------------------
type FakeRow = Record<string, unknown>;

function isNull(value: unknown): boolean {
  return value === null || value === undefined;
}

/** sent_by is null or sent_at is not null — i.e. sent_by without sent_at is the only invalid shape. */
function assertNewSentPairInvariant(row: FakeRow): void {
  const sentByIsNull = isNull(row.sent_by);
  const sentAtIsNull = isNull(row.sent_at);
  const valid = sentByIsNull || !sentAtIsNull;
  if (!valid) {
    throw Object.assign(new Error('new row for relation "print_surface_projects" violates check constraint "print_surface_projects_sent_pair"'), { code: "23514" });
  }
}

function createConstraintEnforcingFakeClient() {
  const rows = new Map<string, FakeRow>();

  function from(tableName: string) {
    if (tableName !== "print_surface_projects") throw new Error(`unsupported table in this fake: ${tableName}`);
    let op: "insert" | "update" | "select" = "select";
    let payload: FakeRow | undefined;
    let filterId: string | undefined;

    const builder = {
      select() { return builder; },
      insert(row: FakeRow) { op = "insert"; payload = { ...row }; return builder; },
      update(patch: FakeRow) { op = "update"; payload = patch; return builder; },
      eq(column: string, value: unknown) { if (column === "id") filterId = value as string; return builder; },
      async maybeSingle() { return execute(); },
      async single() { return execute(); },
      then(onFulfilled: (value: { data: unknown; error: unknown }) => unknown, onRejected?: (reason: unknown) => unknown) {
        return execute().then(onFulfilled, onRejected);
      },
    };

    async function execute(): Promise<{ data: unknown; error: unknown }> {
      try {
        if (op === "insert" && payload) {
          const id = crypto.randomUUID();
          const row: FakeRow = { id, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), sent_at: null, sent_by: null, ...payload };
          assertNewSentPairInvariant(row);
          rows.set(id, row);
          return { data: row, error: null };
        }
        if (op === "update" && filterId) {
          const existing = rows.get(filterId);
          if (!existing) return { data: null, error: { message: "not found" } };
          const merged: FakeRow = { ...existing, ...payload, updated_at: new Date().toISOString() };
          assertNewSentPairInvariant(merged);
          rows.set(filterId, merged);
          return { data: merged, error: null };
        }
        if (op === "select" && filterId) {
          const existing = rows.get(filterId);
          return { data: existing ?? null, error: null };
        }
        return { data: null, error: { message: "unsupported fake operation" } };
      } catch (thrown) {
        return { data: null, error: thrown };
      }
    }

    return builder;
  }

  return { from };
}

test("NOVÝ invariant: sentAt nastavené + sentBy NULL je PLATNÉ (reálný dnešní stav bez per-user loginu)", async () => {
  const client = createConstraintEnforcingFakeClient();
  const repository = new SupabasePrintSurfaceProjectRepository(client as never);
  const created = await repository.create({ name: "Test", companyName: "ACME" });

  const sent: PrintSurfaceProject = { ...created, status: "sent", sentAt: "2026-02-01T10:00:00.000Z", sentBy: undefined };
  const saved = await repository.save(sent);
  assert.equal(saved.status, "sent");
  assert.ok(saved.sentAt);
  assert.equal(saved.sentBy, undefined);
});

test("NOVÝ invariant: sentAt nastavené + skutečný sentBy je PLATNÉ", async () => {
  const client = createConstraintEnforcingFakeClient();
  const repository = new SupabasePrintSurfaceProjectRepository(client as never);
  const created = await repository.create({ name: "Test", companyName: "ACME" });

  const sent: PrintSurfaceProject = { ...created, status: "sent", sentAt: "2026-02-01T10:00:00.000Z", sentBy: "jan.novak" };
  const saved = await repository.save(sent);
  assert.equal(saved.sentAt, "2026-02-01T10:00:00.000Z");
  assert.equal(saved.sentBy, "jan.novak");
});

test("NOVÝ invariant: sentBy BEZ sentAt je NEPLATNÉ — simulovaný CHECK constraint zamítne uložení", async () => {
  const client = createConstraintEnforcingFakeClient();
  const repository = new SupabasePrintSurfaceProjectRepository(client as never);
  const created = await repository.create({ name: "Test", companyName: "ACME" });

  const invalid: PrintSurfaceProject = { ...created, sentAt: undefined, sentBy: "jan.novak" };
  await assert.rejects(
    () => repository.save(invalid),
    /print_surface_projects_sent_pair/u,
    "sent_by bez sent_at musí být DB constraintem odmítnuto podle nového invariantu",
  );
});

test("OPRAVA: markPrintSurfaceProjectSent + repository.save() uspěje bez per-user loginu (createdBy undefined), status 'sent' se správně uloží", async () => {
  const client = createConstraintEnforcingFakeClient();
  const repository = new SupabasePrintSurfaceProjectRepository(client as never);
  const created = await repository.create({ name: "Test", companyName: "ACME" });
  assert.equal(created.createdBy, undefined);

  const sent = markPrintSurfaceProjectSent(created, created.createdBy);
  const saved = await repository.save(sent);
  assert.equal(saved.status, "sent");
  assert.equal(saved.sentBy, undefined, "žádný fake actor — sentBy zůstává undefined stejně jako v doméně");
  assert.ok(saved.sentAt);
});

test("views/items/placements/latestPdf/eventId/realizationCompanyId přežijí markSent + save round-trip beze změny", async () => {
  const client = createConstraintEnforcingFakeClient();
  const repository = new SupabasePrintSurfaceProjectRepository(client as never);
  const created = await repository.create({ name: "Test", companyName: "ACME", eventId: "for-beauty-2026", realizationCompanyId: "gendai" });

  const withView = addPrintSurfaceView(created, {
    asset: { id: "asset-1", storageKey: "print-surfaces/x/image/a.jpg", originalFileName: "a.jpg", mimeType: "image/jpeg", size: 100, createdAt: "2026-01-01T00:00:00.000Z", category: "print-surface-image" },
    widthPx: 800,
    heightPx: 600,
  });
  const view = withView.views[0]!;
  const { project: withItem } = addPrintSurfaceItemWithPlacement(withView, { typeId: "panel" }, view.id, 0.5, 0.5);
  const withPdf = withLatestPdf(withItem, makeLatestPdf());

  const sent = markPrintSurfaceProjectSent(withPdf, withPdf.createdBy);
  const saved = await repository.save(sent);

  assert.equal(saved.eventId, "for-beauty-2026");
  assert.equal(saved.realizationCompanyId, "gendai");
  assert.equal(saved.views.length, 1);
  assert.equal(saved.views[0]?.image.asset.storageKey, "print-surfaces/x/image/a.jpg");
  assert.equal(saved.items.length, 1);
  assert.equal(saved.placements.length, 1);
  assert.equal(saved.latestPdf?.fileName, "Tiskove_plochy_FOR_BEAUTY_Test_001.pdf");
  assert.equal(saved.status, "sent");
});

test("API SAVE: repository chyba (např. DB CHECK constraint) se propaguje jako 502 s obecnou hláškou, nikdy jako falešný 200 úspěch", async () => {
  const SECRET = "print-surface-mark-sent-test-session-secret-32ch";
  (process.env as Record<string, string | undefined>).APP_SESSION_SECRET = SECRET;
  const token = await createSessionToken(SECRET);

  const failingRepository: PrintSurfaceProjectRepository = {
    async list() { return []; },
    async get() { return undefined; },
    async create(input) { return createPrintSurfaceProject(input, "ps-1"); },
    async save() { throw new Error('violates check constraint "print_surface_projects_sent_pair"'); },
    async delete() {},
  };

  const project = createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "ps-1");
  const request = new NextRequest("http://localhost/api/print-surfaces/projects/save", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `homeworkstudio_session=${token}` },
    body: JSON.stringify({ project: { ...project, sentBy: "jan.novak" } }),
  });

  const response = await handlePrintSurfaceProjectSave(request, () => failingRepository);
  assert.equal(response.status, 502);
  const body = await response.json() as { error?: string };
  assert.ok(body.error);
});

// =============================================================================================
// Autosave race (spec section 5): the debounced autosave effect must never overwrite an explicit
// "Potvrdit jako odesláno" save — source-contract check against PrintSurfaceEditorPage.tsx, this
// codebase's established pattern for React behavior with no DOM test runner (see
// tests/printSurfaceEmailFlow.test.ts's own doc note).
// =============================================================================================
const editorPageSource = readFileSync(new URL("../components/workflow/printSurfaces/PrintSurfaceEditorPage.tsx", import.meta.url), "utf8");

function extractFunction(source: string, name: string): string {
  const match = source.match(new RegExp(`(?:function|async function) ${name}\\([\\s\\S]*?\\n  \\}\\n`, "u"));
  assert.ok(match, `expected to find function ${name}`);
  return match![0];
}

test("persistNow ruší pending debounovaný autosave PŘED explicitním uložením (handleMarkSent/handlePdfGenerated/handleManualSave) — žádný race mezi 'Potvrdit jako odesláno' a starším autosave", () => {
  const persistNow = extractFunction(editorPageSource, "persistNow");
  assert.match(persistNow, /window\.clearTimeout\(pendingSaveTimeoutRef\.current\)/u);
  assert.match(persistNow, /pendingSaveTimeoutRef\.current = undefined/u);
});

test("handleMarkSent volá jen persistNow (jeden konzistentní persist flow), nikdy vlastní paralelní save logiku ani fake identitu", () => {
  const handleMarkSent = extractFunction(editorPageSource, "handleMarkSent");
  assert.match(handleMarkSent, /markPrintSurfaceProjectSent\(current, current\.createdBy\)/u);
  assert.match(handleMarkSent, /void persistNow\(next\)/u);
  assert.doesNotMatch(handleMarkSent, /projectRepository\.save/u);
  assert.doesNotMatch(handleMarkSent, /"shared-account"|shared-account/u);
});

test("chyby ukládání se logují do konzole s diagnostickou příčinou (persistNow i debounced autosave), UI hláška zůstává obecná", () => {
  const persistNow = extractFunction(editorPageSource, "persistNow");
  assert.match(persistNow, /console\.error\("Print surface project save failed", error\)/u);
  assert.match(editorPageSource, /console\.error\("Print surface project autosave failed", error\)/u);
  assert.match(editorPageSource, /\{saveStatus === "error" && "Chyba ukládání"\}/u);
});

test("žádný fake actor v doménovém zdrojáku: markPrintSurfaceProjectSent nikde nepoužívá placeholder identitu", () => {
  const domainSource = readFileSync(new URL("../domain/printSurfaceProject.ts", import.meta.url), "utf8");
  assert.doesNotMatch(domainSource, /"shared-account"/u);
  assert.match(domainSource, /return \{ \.\.\.project, status: "sent", sentAt: now, sentBy, updatedAt: now \};/u);
});
