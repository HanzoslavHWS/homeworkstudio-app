import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { NextRequest } from "next/server.js";
import { BUILT_IN_CATALOG_CATEGORIES } from "../domain/catalogClassification.ts";
import type { CatalogImportPlan } from "../domain/catalogExcelImport.ts";
import type { CatalogItemAdmin } from "../domain/catalogItemsAdmin.ts";
import { AUTH_COOKIE_NAME } from "../lib/auth/session.ts";
import type { CatalogExcelImportApplyResult, CatalogImportRowOutcome } from "../lib/db/catalogExcelImport.supabase.ts";
import type { CatalogImportRun, CatalogImportRunStore, NewPreviewRun } from "../lib/catalogImport/catalogImportRuns.supabase.ts";
import {
  catalogImportAvailability,
  catalogImportPlanHash,
  handleCatalogImportConfirm,
  handleCatalogImportPreview,
  handleCatalogImportRuns,
  type CatalogImportUiDependencies,
} from "../lib/catalogImport/catalogImportUi.server.ts";
import { createTestSession, testAuthStore } from "./helpers/testAuth.ts";

const SECRET = "test-session-secret-with-at-least-32-characters";
process.env.APP_SESSION_SECRET = SECRET;
const store = testAuthStore();
const ORIGIN = "http://localhost:3000";

// ---------------------------------------------------------------------------------------------
// A real .xlsx built in memory (catalog-template/1)
// ---------------------------------------------------------------------------------------------
const S_KEYS = ["id", "generator_code", "abf_code", "display_name", "official_name", "official_name_en", "category", "unit_code", "power_kw", "show_2d", "show_3d", "catalog_visible", "catalog_name", "catalog_description", "catalog_sort", "note", "lifecycle_status"];
async function workbook(rows: Array<Record<string, unknown>>, extra?: (book: ExcelJS.Workbook) => void): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const meta = book.addWorksheet("_meta");
  meta.addRow(["key", "value"]);
  meta.addRow(["template_format", "catalog-template/1"]);
  meta.addRow(["environment", "DEV"]);
  const sheet = book.addWorksheet("Sluzby");
  sheet.addRow(S_KEYS);
  sheet.addRow(S_KEYS.map((key) => `label ${key}`));
  for (const row of rows) sheet.addRow(S_KEYS.map((key) => (row[key] ?? null) as ExcelJS.CellValue));
  extra?.(book);
  return Buffer.from(await book.xlsx.writeBuffer());
}

const I20: CatalogItemAdmin = {
  id: "9bf98ab8-4479-4b61-9eeb-9313e6b281e9", internalCode: "I20", abfCode: "I20", itemType: "SERVICE", kind: "service", lifecycleStatus: "active",
  displayName: "Internet Wifi", officialName: null, officialNameEn: null, category: "service-internet", unit: "ks", unitCode: "ks",
  createdAt: "2026-11-06T09:00:00Z", updatedAt: "2026-11-06T11:00:00.1+00:00",
  document: { displayName: "Internet Wifi", category: "service-internet", unit: "ks", showIn2D: true, showIn3D: false, footprint2D: { shape: "rectangle" }, serviceTechnical: { serviceCategory: "internet" }, catalogPublication: { visible: true, name: "Internet Wifi" } },
} as CatalogItemAdmin;
const I20_ROW = { generator_code: "I20", abf_code: "I20", display_name: "Internet WIFI", category: "Internet", unit_code: "ks", show_2d: "ANO", show_3d: false, catalog_visible: "ANO", catalog_name: "Internet Wifi " };
const NEW_ROW = { generator_code: "ZTEST1", display_name: "TEST služba", category: "Internet", unit_code: "ks" };

// ---------------------------------------------------------------------------------------------
// In-memory run store with the same contract (claim is atomic: one synchronous check-and-set)
// ---------------------------------------------------------------------------------------------
class MemoryRuns implements CatalogImportRunStore {
  readonly runs = new Map<string, CatalogImportRun & { -readonly [K in keyof CatalogImportRun]: CatalogImportRun[K] }>();
  async createPreview(input: NewPreviewRun) {
    const run = { id: crypto.randomUUID(), status: input.status, createdBy: input.createdBy, createdAt: new Date().toISOString(), environment: input.environment, fileName: input.fileName, fileSha256: input.fileSha256, fileSize: input.fileSize, planHash: input.planHash, previewExpiresAt: input.previewExpiresAt, startedAt: null, finishedAt: null, summary: input.summary, resultRows: null, errorMessage: null };
    this.runs.set(run.id, run);
    return { ...run };
  }
  async get(id: string) { const run = this.runs.get(id); return run ? { ...run } : undefined; }
  async listRecent() { return [...this.runs.values()]; }
  async markSuperseded(id: string) { const run = this.runs.get(id); if (run?.status === "previewed") run.status = "superseded"; }
  async expireStaleRunning() {}
  async claim(id: string, userId: string, now: string) {
    if ([...this.runs.values()].some((run) => run.status === "running")) return "busy" as const;
    const run = this.runs.get(id);
    if (!run || run.status !== "previewed" || run.createdBy !== userId || !run.previewExpiresAt || run.previewExpiresAt <= now) return "already" as const;
    run.status = "running";
    run.startedAt = now;
    return { ...run };
  }
  async saveProgress(id: string, rows: readonly CatalogImportRowOutcome[]) { this.runs.get(id)!.resultRows = rows; }
  async finish(id: string, status: "succeeded" | "partial" | "failed", rows: readonly CatalogImportRowOutcome[], errorMessage: string | null) {
    const run = this.runs.get(id)!;
    Object.assign(run, { status, resultRows: rows, finishedAt: new Date().toISOString(), errorMessage });
  }
}

type Harness = { deps: CatalogImportUiDependencies; runs: MemoryRuns; writes: CatalogImportPlan[]; items: CatalogItemAdmin[] };
function harness(options: Readonly<{ items?: CatalogItemAdmin[]; fail?: "second-row"; slowWrite?: () => Promise<void>; enabled?: boolean }> = {}): Harness {
  const runs = new MemoryRuns();
  const writes: CatalogImportPlan[] = [];
  const items = [...(options.items ?? [I20])];
  const deps: CatalogImportUiDependencies = {
    availability: () => (options.enabled === false ? { enabled: false, reason: "Jen v DEV." } : { enabled: true, projectRef: "wpbivmobbqcqmyehunog" }),
    runs: () => runs,
    loadContext: async () => ({ items: [...items], categories: BUILT_IN_CATALOG_CATEGORIES, variantSets: [], targetEnvironment: "DEV" }),
    write: async (plan, onProgress): Promise<CatalogExcelImportApplyResult> => {
      writes.push(plan);
      await options.slowWrite?.();
      const changeRows = plan.rows.filter((row) => row.action === "create" || row.action === "update");
      const outcomes: CatalogImportRowOutcome[] = changeRows.map((row) => ({ sheet: row.sheet, rowNumber: row.rowNumber, label: row.label, action: row.action as "create" | "update", status: "not_attempted" }));
      const written = [];
      for (const [index, row] of changeRows.entries()) {
        if (options.fail === "second-row" && index === 1) {
          outcomes[index] = { ...outcomes[index]!, status: "failed", message: "ConcurrencyConflictError" };
          await onProgress(outcomes);
          return { written, failed: { sheet: row.sheet, rowNumber: row.rowNumber, label: row.label, message: "ConcurrencyConflictError" }, notWritten: changeRows.slice(index).map((entry) => ({ sheet: entry.sheet, rowNumber: entry.rowNumber, label: entry.label })) };
        }
        outcomes[index] = { ...outcomes[index]!, status: "written", itemId: `id-${index}` };
        written.push({ sheet: row.sheet, rowNumber: row.rowNumber, label: row.label, action: row.action as "create" | "update", itemId: `id-${index}`, lifecycleStatus: "needs_review" });
        await onProgress(outcomes);
      }
      return { written, notWritten: [] };
    },
  };
  return { deps, runs, writes, items };
}

function upload(path: string, token: string | undefined, bytes: Buffer, fields: Record<string, string> = {}, fileName = "katalog.xlsx", origin = ORIGIN): NextRequest {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], fileName, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return new NextRequest(`${ORIGIN}${path}`, { method: "POST", body: form, headers: { origin, host: "localhost:3000", ...(token ? { cookie: `${AUTH_COOKIE_NAME}=${token}` } : {}) } });
}
const preview = (h: Harness, token: string, bytes: Buffer, name?: string) => handleCatalogImportPreview(upload("/api/catalog-admin/excel-import/preview", token, bytes, {}, name), h.deps);
const confirm = (h: Harness, token: string, bytes: Buffer, runId: string) => handleCatalogImportConfirm(upload("/api/catalog-admin/excel-import/confirm", token, bytes, { runId }), h.deps);
const body = async (response: Response) => (await response.json()) as Record<string, any>;

// =============================================================================================
test("prostředí: zápis z administrace jen v ověřeném DEV wpbivmobbqcqmyehunog, v produkci vypnuto", () => {
  const dev = { NEXT_PUBLIC_APP_ENV: "development", SUPABASE_URL: "https://wpbivmobbqcqmyehunog.supabase.co", SUPABASE_EXPECTED_PROJECT_REF: "wpbivmobbqcqmyehunog" };
  assert.deepEqual(catalogImportAvailability(dev), { enabled: true, projectRef: "wpbivmobbqcqmyehunog" });
  assert.equal(catalogImportAvailability({ ...dev, NEXT_PUBLIC_APP_ENV: "production" }).enabled, false);
  assert.equal(catalogImportAvailability({ NEXT_PUBLIC_APP_ENV: "development", SUPABASE_URL: "https://fwchkogtaqaunaxmchtu.supabase.co", SUPABASE_EXPECTED_PROJECT_REF: "fwchkogtaqaunaxmchtu" }).enabled, false);
  assert.equal(catalogImportAvailability({ ...dev, SUPABASE_EXPECTED_PROJECT_REF: "jinyprojekt" }).enabled, false);
  assert.equal(catalogImportAvailability({ ...dev, SUPABASE_URL: "https://jinyprojektxxxxxxxxx.supabase.co", SUPABASE_EXPECTED_PROJECT_REF: "jinyprojektxxxxxxxxx" }).enabled, false);
});

test("oprávnění: náhled i potvrzení jen aktivní Správce — nepřihlášený 401, běžný / externí / deaktivovaný správce 403, vypnutá funkce 403", async () => {
  const h = harness();
  const bytes = await workbook([I20_ROW]);
  assert.equal((await handleCatalogImportPreview(upload("/x", undefined, bytes), h.deps)).status, 401);
  for (const role of ["user", "external"] as const) {
    const { token } = await createTestSession(SECRET, { role });
    assert.equal((await preview(h, token, bytes)).status, 403, role);
    assert.equal((await confirm(h, token, bytes, "x")).status, 403, role);
    assert.equal((await handleCatalogImportRuns(new NextRequest(`${ORIGIN}/api/catalog-admin/excel-import/runs`, { headers: { cookie: `${AUTH_COOKIE_NAME}=${token}` } }), h.deps)).status, 403, role);
  }
  const admin = await createTestSession(SECRET, { role: "admin" });
  store.setActive(admin.user.id, false);
  const deactivated = await preview(h, admin.token, bytes);
  assert.deepEqual([deactivated.status, (await body(deactivated)).code], [403, "account_inactive"]);
  const active = await createTestSession(SECRET, { role: "admin" });
  assert.equal((await handleCatalogImportPreview(upload("/x", active.token, bytes), harness({ enabled: false }).deps)).status, 403);
  assert.equal((await handleCatalogImportPreview(upload("/x", active.token, bytes, {}, "k.xlsx", "https://evil.example"), h.deps)).status, 403, "cross-origin");
  assert.equal(h.writes.length, 0);
});

test("náhled nic nezapisuje: plán, počty po listech, změna Wifi → WIFI s původní a novou hodnotou; nový řádek; běh uložen s hashem souboru a plánu", async () => {
  const h = harness();
  const { token, user } = await createTestSession(SECRET, { role: "admin" });
  const response = await preview(h, token, await workbook([I20_ROW, NEW_ROW]), "Generator_ABF_Katalog.xlsx");
  assert.equal(response.status, 200);
  const result = await body(response);
  assert.equal(h.writes.length, 0, "no write");
  assert.deepEqual(result.summary, { create: 1, update: 1, unchanged: 0, conflict: 0, warnings: 0 });
  assert.deepEqual(result.bySheet, { Sluzby: { create: 1, update: 1, unchanged: 0, conflict: 0 } });
  assert.equal(result.dataRows, 2);
  assert.equal(result.canConfirm, true);
  const update = result.rows.find((row: { label: string }) => row.label === "I20");
  assert.deepEqual(update.changes, [{ field: "display_name", labelCs: "Interní název HomeworkStudio", before: "Internet Wifi", after: "Internet WIFI" }]);
  assert.equal(update.edit, undefined, "the client never gets the write payload");
  const run = h.runs.runs.get(result.runId)!;
  assert.deepEqual([run.status, run.createdBy, run.environment, run.fileName], ["previewed", user.id, "wpbivmobbqcqmyehunog", "Generator_ABF_Katalog.xlsx"]);
  assert.match(run.fileSha256!, /^[0-9a-f]{64}$/u);
  assert.match(run.planHash!, /^[0-9a-f]{64}$/u);
});

test("potvrzení zapíše přesně znovu spočítaný plán; výsledek po řádcích uložen; druhé potvrzení téhož náhledu už nic nezapíše", async () => {
  const h = harness();
  const { token } = await createTestSession(SECRET, { role: "admin" });
  const bytes = await workbook([I20_ROW, NEW_ROW]);
  const { runId } = await body(await preview(h, token, bytes));
  const first = await confirm(h, token, bytes, runId);
  assert.equal(first.status, 200);
  const result = await body(first);
  assert.deepEqual([result.written, result.failed, result.run.status], [2, 0, "succeeded"]);
  assert.deepEqual(result.run.resultRows.map((row: { status: string }) => row.status), ["written", "written"]);
  assert.equal(result.run.planHash, undefined, "internal hash not exposed");
  const again = await confirm(h, token, bytes, runId);
  assert.deepEqual([again.status, (await body(again)).code], [409, "run_not_previewed"]);
  assert.equal(h.writes.length, 1);
});

test("dvojklik / souběžné potvrzení téhož náhledu → zapíše se jen jednou; druhý náhled během běžícího importu → 409 import_busy", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = harness({ slowWrite: () => gate });
  const { token } = await createTestSession(SECRET, { role: "admin" });
  const bytes = await workbook([I20_ROW]);
  const { runId } = await body(await preview(h, token, bytes));
  const otherBytes = await workbook([NEW_ROW]);
  const { runId: otherRun } = await body(await preview(h, token, otherBytes));
  const [a, b] = [confirm(h, token, bytes, runId), confirm(h, token, bytes, runId)];
  await new Promise((resolve) => setTimeout(resolve, 50));
  const busy = await confirm(h, token, otherBytes, otherRun);
  assert.deepEqual([busy.status, (await body(busy)).code], [409, "import_busy"]);
  // state of the running run can be read meanwhile (e.g. after a lost connection)
  const during = await handleCatalogImportRuns(new NextRequest(`${ORIGIN}/api/catalog-admin/excel-import/runs?id=${runId}`, { headers: { cookie: `${AUTH_COOKIE_NAME}=${token}` } }), h.deps);
  assert.equal((await body(during)).run.status, "running");
  release();
  const statuses = (await Promise.all([a, b])).map((response) => response.status).sort();
  assert.deepEqual(statuses, [200, 409]);
  assert.equal(h.writes.length, 1);
});

test("změna souboru nebo databáze mezi náhledem a potvrzením → nic se nezapíše, je potřeba nový náhled (shodné počty nestačí)", async () => {
  const h = harness();
  const { token } = await createTestSession(SECRET, { role: "admin" });
  const bytes = await workbook([I20_ROW]);
  const { runId } = await body(await preview(h, token, bytes));
  const otherFile = await workbook([{ ...I20_ROW, display_name: "Internet WiFi" }]);
  const changedFile = await confirm(h, token, otherFile, runId);
  assert.deepEqual([changedFile.status, (await body(changedFile)).code], [409, "file_changed"]);
  // Same counts (1 update), but the card was changed in between (updated_at) → different plan.
  h.items[0] = { ...I20, updatedAt: "2026-11-09T08:00:00+00:00" } as CatalogItemAdmin;
  const changedDb = await confirm(h, token, bytes, runId);
  assert.deepEqual([changedDb.status, (await body(changedDb)).code], [409, "plan_changed"]);
  assert.equal(h.runs.runs.get(runId)!.status, "superseded");
  assert.equal(h.writes.length, 0);
});

test("náhled jiného uživatele, prošlý náhled a neexistující běh nejdou potvrdit", async () => {
  const h = harness();
  const owner = await createTestSession(SECRET, { role: "admin" });
  const other = await createTestSession(SECRET, { role: "admin" });
  const bytes = await workbook([I20_ROW]);
  const { runId } = await body(await preview(h, owner.token, bytes));
  assert.equal((await confirm(h, other.token, bytes, runId)).status, 403);
  h.runs.runs.get(runId)!.previewExpiresAt = new Date(Date.now() - 1000).toISOString();
  assert.equal((await body(await confirm(h, owner.token, bytes, runId))).code, "run_expired");
  assert.equal((await confirm(h, owner.token, bytes, crypto.randomUUID())).status, 404);
  assert.equal(h.writes.length, 0);
});

test("nulové změny: „beze změny“, potvrzení není nabídnuto a server ho odmítne", async () => {
  const h = harness();
  const { token } = await createTestSession(SECRET, { role: "admin" });
  const bytes = await workbook([{ ...I20_ROW, display_name: "Internet Wifi" }]);
  const result = await body(await preview(h, token, bytes));
  assert.deepEqual([result.status, result.canConfirm, result.summary.unchanged], ["no_changes", false, 1]);
  const response = await confirm(h, token, bytes, result.runId);
  assert.equal(response.status, 409);
  assert.equal(h.writes.length, 0);
});

test("neplatný soubor: jiný obsah než XLSX, poškozený XLSX, příliš velký soubor a nepodporovaný list s daty", async () => {
  const h = harness();
  const { token } = await createTestSession(SECRET, { role: "admin" });
  const notXlsx = await preview(h, token, Buffer.from("id;kód\n1;M20"), "katalog.xlsx");
  assert.deepEqual([notXlsx.status, (await body(notXlsx)).code], [400, "invalid_file"]);
  const broken = await preview(h, token, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(200, 7)]));
  const brokenBody = await body(broken);
  assert.equal(broken.status, 400);
  assert.doesNotMatch(JSON.stringify(brokenBody), /at |\.ts|stack/u, "no internal detail");
  const huge = await preview(h, token, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(5 * 1024 * 1024)]));
  assert.equal(huge.status, 413);
  assert.equal((await preview(h, token, await workbook([I20_ROW]), "katalog.csv")).status, 400);
  const withKits = await workbook([I20_ROW], (book) => {
    const kits = book.addWorksheet("Komplety");
    kits.addRow(["generator_code"]);
    kits.addRow(["Kód"]);
    kits.addRow(["P86"]);
  });
  const blocked = await body(await preview(h, token, withKits));
  assert.equal(blocked.canConfirm, false);
  assert.ok(blocked.sheets.some((sheet: { name: string; status: string }) => sheet.name === "Komplety" && sheet.status === "unsupported_with_data"));
  assert.match(blocked.blockReasons.join(" "), /nepodporovaný list/u);
  assert.equal((await confirm(h, token, withKits, blocked.runId)).status, 409);
  const wrongEnv = await workbook([I20_ROW], (book) => { book.getWorksheet("_meta")!.getRow(3).getCell(2).value = "PROD"; });
  assert.match((await body(await preview(h, token, wrongEnv))).blockReasons.join(" "), /PROD/u);
  assert.equal(h.writes.length, 0);
});

test("částečné selhání: uložené / selhané / neprovedené řádky; stav běhu jde zjistit; nový náhled vychází z uloženého stavu", async () => {
  const h = harness({ fail: "second-row" });
  const { token } = await createTestSession(SECRET, { role: "admin" });
  const bytes = await workbook([I20_ROW, NEW_ROW, { ...NEW_ROW, generator_code: "ZTEST2", display_name: "TEST 2" }]);
  const { runId } = await body(await preview(h, token, bytes));
  const response = await confirm(h, token, bytes, runId);
  const result = await body(response);
  assert.deepEqual([result.written, result.failed, result.notAttempted, result.run.status], [1, 1, 1, "partial"]);
  assert.deepEqual(result.run.resultRows.map((row: { status: string }) => row.status), ["written", "failed", "not_attempted"]);
  assert.match(result.run.errorMessage, /ZTEST1/u);
  const state = await body(await handleCatalogImportRuns(new NextRequest(`${ORIGIN}/api/catalog-admin/excel-import/runs?id=${runId}`, { headers: { cookie: `${AUTH_COOKIE_NAME}=${token}` } }), h.deps));
  assert.deepEqual(state.run.resultRows.map((row: { status: string }) => row.status), ["written", "failed", "not_attempted"]);
  // The saved card is now part of the catalog → the next preview counts it as unchanged.
  h.items[0] = { ...I20, displayName: "Internet WIFI", updatedAt: "2026-11-09T09:00:00+00:00", document: { ...I20.document, displayName: "Internet WIFI" } } as CatalogItemAdmin;
  const next = await body(await preview(h, token, bytes));
  assert.deepEqual([next.summary.unchanged, next.summary.create], [1, 2]);
});

test("hash plánu: shodné počty, ale jiný updated_at nebo jiná hodnota = jiný plán", async () => {
  const { planCatalogWorkbookImport } = await import("../domain/catalogExcelImport.ts");
  const sheets = [{ name: "Sluzby", grid: [S_KEYS, S_KEYS, S_KEYS.map((key) => (I20_ROW as Record<string, unknown>)[key] ?? null)] }] as never;
  const plan = (items: CatalogItemAdmin[]) => planCatalogWorkbookImport(sheets, { items, categories: BUILT_IN_CATALOG_CATEGORIES, targetEnvironment: "DEV" });
  assert.equal(catalogImportPlanHash(plan([I20])), catalogImportPlanHash(plan([I20])));
  assert.notEqual(catalogImportPlanHash(plan([I20])), catalogImportPlanHash(plan([{ ...I20, updatedAt: "2026-11-09T00:00:00Z" } as CatalogItemAdmin])));
  assert.notEqual(catalogImportPlanHash(plan([I20])), catalogImportPlanHash(plan([{ ...I20, displayName: "Internet Wi-fi" } as CatalogItemAdmin])));
});
