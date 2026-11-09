import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server.js";
import { CATALOG_HELPER_SHEETS, isBlankRow, planCatalogWorkbookImport, type CatalogImportContext, type CatalogImportPlan, type WorkbookSheetInput } from "../../domain/catalogExcelImport.ts";
import { authorize } from "../auth/requestAuth.ts";
import { KNOWN_PRODUCTION_SUPABASE_REFS, resolveAppEnvironment, supabaseProjectRef } from "../env/supabaseEnvironment.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../db/supabase.server.ts";
import { readCatalogItemsAdmin, readCatalogVariantSets } from "../db/catalogItemsAdmin.supabase.ts";
import { readCatalogCategoryRegister } from "../db/catalogCategories.supabase.ts";
import { writeCatalogImportPlan, type CatalogExcelImportApplyResult, type CatalogImportRowOutcome } from "../db/catalogExcelImport.supabase.ts";
import { extractStrictSheetGrid, readWorkbookFromBufferTolerant } from "../import/xlsxReader.server.ts";
import { CatalogImportRunsNotMigratedError, SupabaseCatalogImportRunStore, type CatalogImportRun, type CatalogImportRunStore } from "./catalogImportRuns.supabase.ts";

/**
 * Administrace → Katalog komponent → Import Excel (V1-IMPORT-UI-01). The SAME domain logic as the
 * CLI (domain/catalogExcelImport.ts) and the same writer (writeCatalogImportPlan) — no second
 * importer. Only an active admin (`catalog.import`), only in the DEV project, never production.
 *
 *   preview  — reads the uploaded file (real XLSX content, limits), plans against the CURRENT
 *              catalog and stores a run: author, environment, file SHA-256 and the hash of the plan.
 *   confirm  — the same file again + the run id. Nothing from the client is trusted: the server
 *              checks author, environment, expiry and file hash, re-plans against the database as
 *              it is NOW and writes only if that plan hashes exactly like the previewed one (equal
 *              counts are not enough). The run is claimed previewed → running in one conditional
 *              update, so a double click / repeated request / second tab cannot write twice, and
 *              only one catalog-template import may run at a time (across server instances).
 *   runs     — the state of a run (per-row outcome stored during the write) after a lost connection.
 * Writes are atomic per card, not per batch: on a failure the run stops; saved cards stay saved.
 */
export const CATALOG_IMPORT_LIMITS = { maxBytes: 5 * 1024 * 1024, maxDataRows: 2000, previewValidMinutes: 30, staleRunningMinutes: 15 } as const;
export const CATALOG_IMPORT_UI_DEV_REFS: readonly string[] = ["wpbivmobbqcqmyehunog"];
const TARGET_ENVIRONMENT = "DEV";

export type Availability = Readonly<{ enabled: true; projectRef: string }> | Readonly<{ enabled: false; reason: string }>;

/** The UI import writes only into the verified DEV project; in production it is switched off on the server. */
export function catalogImportAvailability(environment: Readonly<Record<string, string | undefined>> = process.env): Availability {
  const appEnvironment = resolveAppEnvironment({ NEXT_PUBLIC_APP_ENV: environment.NEXT_PUBLIC_APP_ENV, NODE_ENV: environment.NODE_ENV });
  const ref = supabaseProjectRef(environment.SUPABASE_URL);
  if (appEnvironment !== "development") return { enabled: false, reason: "Import z administrace je zatím povolený jen ve vývojovém prostředí (DEV). V produkci je vypnutý." };
  if (!ref || KNOWN_PRODUCTION_SUPABASE_REFS.includes(ref) || !CATALOG_IMPORT_UI_DEV_REFS.includes(ref) || environment.SUPABASE_EXPECTED_PROJECT_REF?.trim() !== ref) {
    return { enabled: false, reason: "Import z administrace smí zapisovat jen do ověřené DEV databáze — tato instance na ni nemíří." };
  }
  return { enabled: true, projectRef: ref };
}

// ---------------------------------------------------------------------------------------------
// File
// ---------------------------------------------------------------------------------------------
export class CatalogImportFileError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "CatalogImportFileError";
    this.status = status;
  }
}

export type ReadWorkbook = (bytes: Buffer) => Promise<readonly WorkbookSheetInput[]>;

const defaultReadWorkbook: ReadWorkbook = async (bytes) => {
  const workbook = await readWorkbookFromBufferTolerant(bytes);
  return workbook.worksheets.map((sheet) => ({ name: sheet.name, grid: extractStrictSheetGrid(workbook, sheet.name) }));
};

/** Real XLSX content (ZIP container + a readable workbook), within the limits — not just the extension. */
export async function readCatalogWorkbook(bytes: Buffer, readWorkbook: ReadWorkbook = defaultReadWorkbook): Promise<Readonly<{ sheets: readonly WorkbookSheetInput[]; dataRows: number }>> {
  if (bytes.length === 0) throw new CatalogImportFileError("Soubor je prázdný.");
  if (bytes.length > CATALOG_IMPORT_LIMITS.maxBytes) throw new CatalogImportFileError(`Soubor je větší než ${CATALOG_IMPORT_LIMITS.maxBytes / 1024 / 1024} MB.`, 413);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) throw new CatalogImportFileError("Soubor není sešit Excelu (.xlsx) — obsah neodpovídá formátu XLSX.");
  let sheets: readonly WorkbookSheetInput[];
  try {
    sheets = await readWorkbook(bytes);
  } catch {
    throw new CatalogImportFileError("Sešit se nepodařilo přečíst — soubor je poškozený nebo to není platný .xlsx.");
  }
  if (!sheets.length) throw new CatalogImportFileError("Sešit neobsahuje žádný list.");
  const dataRows = sheets.filter((sheet) => !(CATALOG_HELPER_SHEETS as readonly string[]).includes(sheet.name)).reduce((sum, sheet) => sum + sheet.grid.slice(2).filter((row) => !isBlankRow(row)).length, 0);
  if (dataRows > CATALOG_IMPORT_LIMITS.maxDataRows) throw new CatalogImportFileError(`Sešit má ${dataRows} datových řádků — limit je ${CATALOG_IMPORT_LIMITS.maxDataRows}.`, 413);
  return { sheets, dataRows };
}

export const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as object).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

/** Identity of a plan: every row (action, card, updated_at, changes, create input / edit) and every issue. */
export function catalogImportPlanHash(plan: CatalogImportPlan): string {
  return sha256(stableStringify({ templateFormat: plan.templateFormat, environment: plan.environment, sheets: plan.sheets, issues: plan.issues, rows: plan.rows }));
}

/** Why a plan must not be written (empty = may be confirmed). */
export function blockReasons(plan: CatalogImportPlan): readonly string[] {
  const reasons: string[] = [];
  if (plan.summary.conflict > 0) reasons.push(`Náhled obsahuje ${plan.summary.conflict} ${plan.summary.conflict === 1 ? "konflikt" : "konfliktů"} — opravte soubor a nahrajte ho znovu. Import vybraných řádků zatím není.`);
  const workbookErrors = plan.issues.filter((issue) => issue.severity === "error");
  if (workbookErrors.length) reasons.push(`Sešit má ${workbookErrors.length} ${workbookErrors.length === 1 ? "chybu" : "chyb"} (nepodporovaný list s daty, chybějící hlavička nebo neznámá verze šablony).`);
  if (plan.environment && plan.environment.toUpperCase() !== TARGET_ENVIRONMENT) reasons.push(`Šablona je připravená pro prostředí ${plan.environment}, ne pro ${TARGET_ENVIRONMENT}.`);
  return reasons;
}

const changeCount = (plan: CatalogImportPlan) => plan.summary.create + plan.summary.update;

// ---------------------------------------------------------------------------------------------
// Dependencies (injectable for tests)
// ---------------------------------------------------------------------------------------------
export type CatalogImportUiDependencies = Readonly<{
  availability: () => Availability;
  runs: () => CatalogImportRunStore;
  loadContext: () => Promise<CatalogImportContext>;
  write: (plan: CatalogImportPlan, onProgress: (rows: readonly CatalogImportRowOutcome[]) => Promise<void>) => Promise<CatalogExcelImportApplyResult>;
  readWorkbook?: ReadWorkbook;
  now?: () => Date;
}>;

export const defaultCatalogImportUiDependencies: CatalogImportUiDependencies = {
  availability: () => catalogImportAvailability(),
  runs: () => new SupabaseCatalogImportRunStore(createSupabaseServerClient()),
  loadContext: async () => {
    const client = createSupabaseServerClient();
    const [items, register, variantSets] = await Promise.all([readCatalogItemsAdmin(client), readCatalogCategoryRegister(client), readCatalogVariantSets(client)]);
    return { items, categories: register.categories, variantSets, targetEnvironment: TARGET_ENVIRONMENT };
  },
  write: (plan, onProgress) => writeCatalogImportPlan(createSupabaseServerClient(), plan, onProgress),
};

// ---------------------------------------------------------------------------------------------
// Shared request checks
// ---------------------------------------------------------------------------------------------
const json = (body: unknown, status = 200) => NextResponse.json(body, { status });

/** Mutations only from this origin (on top of the SameSite=Lax session cookie). */
function crossOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== (request.headers.get("host") ?? request.nextUrl.host);
  } catch {
    return true;
  }
}

async function guard(request: NextRequest, dependencies: CatalogImportUiDependencies, mutation: boolean) {
  const decision = await authorize(request, "catalog.import");
  if (decision.ok === false) return { response: decision.response };
  if (mutation && crossOrigin(request)) return { response: json({ error: "Požadavek z cizího původu byl odmítnut.", code: "cross_origin" }, 403) };
  const availability = dependencies.availability();
  if (availability.enabled === false) return { response: json({ error: availability.reason, code: "import_disabled" }, 403) };
  return { user: decision.auth.user, availability };
}

function failure(error: unknown, fallback: string): NextResponse {
  if (error instanceof CatalogImportFileError) return json({ error: error.message, code: "invalid_file" }, error.status);
  if (error instanceof CatalogImportRunsNotMigratedError || error instanceof SupabaseConfigurationError) return json({ error: error.message, code: "config" }, 503);
  // Never a stack or an internal detail in the response.
  console.error(`Catalog import (UI): ${fallback}`, error instanceof Error ? error.message : error);
  return json({ error: fallback }, 502);
}

async function readUpload(request: NextRequest): Promise<Readonly<{ file: File; form: FormData }>> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new CatalogImportFileError("Neplatný požadavek — očekáván nahraný soubor.");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw new CatalogImportFileError("Chybí soubor k importu.");
  if (!/\.xlsx$/iu.test(file.name)) throw new CatalogImportFileError("Podporovaný je jen sešit .xlsx (šablona katalogu).");
  if (file.size > CATALOG_IMPORT_LIMITS.maxBytes) throw new CatalogImportFileError(`Soubor je větší než ${CATALOG_IMPORT_LIMITS.maxBytes / 1024 / 1024} MB.`, 413);
  return { file, form };
}

const safeFileName = (name: string) => name.replace(/[\u0000-\u001f\\/]/gu, "_").slice(0, 200);

function previewBody(run: CatalogImportRun, plan: CatalogImportPlan, dataRows: number, reasons: readonly string[], context: CatalogImportContext) {
  return {
    runId: run.id,
    status: run.status,
    fileName: run.fileName,
    fileSha256: run.fileSha256,
    fileSize: run.fileSize,
    dataRows,
    expiresAt: run.previewExpiresAt,
    templateFormat: plan.templateFormat,
    environment: plan.environment,
    sheets: plan.sheets,
    issues: plan.issues,
    summary: plan.summary,
    bySheet: plan.bySheet,
    rows: plan.rows.map(({ createInput: _createInput, edit: _edit, expectedUpdatedAt: _expected, ...row }) => row),
    canConfirm: run.status === "previewed" && reasons.length === 0,
    blockReasons: reasons,
    limits: CATALOG_IMPORT_LIMITS,
    categoryNames: Object.fromEntries(context.categories.map((category) => [category.id, category.name])),
  };
}

const runSummary = (plan: CatalogImportPlan, dataRows: number) => ({ dataRows, summary: plan.summary, bySheet: plan.bySheet, sheets: plan.sheets, issueCount: plan.issues.length });

// ---------------------------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------------------------
export async function handleCatalogImportPreview(request: NextRequest, dependencies: CatalogImportUiDependencies = defaultCatalogImportUiDependencies): Promise<NextResponse> {
  const checked = await guard(request, dependencies, true);
  if ("response" in checked) return checked.response!;
  try {
    const { file } = await readUpload(request);
    const bytes = Buffer.from(await file.arrayBuffer());
    const { sheets, dataRows } = await readCatalogWorkbook(bytes, dependencies.readWorkbook);
    const context = await dependencies.loadContext();
    const plan = planCatalogWorkbookImport(sheets, context);
    const reasons = blockReasons(plan);
    const now = (dependencies.now ?? (() => new Date()))();
    const run = await dependencies.runs().createPreview({
      status: changeCount(plan) === 0 && reasons.length === 0 ? "no_changes" : "previewed",
      createdBy: checked.user!.id,
      environment: checked.availability!.projectRef,
      fileName: safeFileName(file.name),
      fileSha256: sha256(bytes),
      fileSize: bytes.length,
      planHash: catalogImportPlanHash(plan),
      previewExpiresAt: new Date(now.getTime() + CATALOG_IMPORT_LIMITS.previewValidMinutes * 60_000).toISOString(),
      summary: runSummary(plan, dataRows),
    });
    return json(previewBody(run, plan, dataRows, reasons, context));
  } catch (error) {
    return failure(error, "Náhled importu se nepodařilo připravit.");
  }
}

export async function handleCatalogImportConfirm(request: NextRequest, dependencies: CatalogImportUiDependencies = defaultCatalogImportUiDependencies): Promise<NextResponse> {
  const checked = await guard(request, dependencies, true);
  if ("response" in checked) return checked.response!;
  const user = checked.user!;
  try {
    const { file, form } = await readUpload(request);
    const runId = typeof form.get("runId") === "string" ? String(form.get("runId")) : "";
    const runs = dependencies.runs();
    const run = runId ? await runs.get(runId) : undefined;
    if (!run) return json({ error: "Náhled neexistuje. Připravte nový náhled.", code: "run_missing" }, 404);
    if (run.createdBy !== user.id) return json({ error: "Tento náhled připravil jiný uživatel. Připravte vlastní náhled.", code: "run_foreign" }, 403);
    if (run.environment !== checked.availability!.projectRef) return json({ error: "Náhled patří k jinému prostředí. Připravte nový náhled.", code: "environment_changed" }, 409);
    if (run.status !== "previewed") {
      const message = run.status === "running" ? "Import tohoto náhledu už běží." : run.status === "no_changes" ? "Vše je beze změny — není co zapsat." : ["succeeded", "partial", "failed", "interrupted"].includes(run.status) ? "Tento náhled už byl potvrzen. Výsledek najdete níže; pro další import připravte nový náhled." : "Náhled už neplatí. Připravte nový náhled.";
      return json({ error: message, code: "run_not_previewed", run: publicRun(run) }, 409);
    }
    const now = (dependencies.now ?? (() => new Date()))();
    if (!run.previewExpiresAt || Date.parse(run.previewExpiresAt) <= now.getTime()) return json({ error: "Náhled vypršel (platí 30 minut). Připravte nový náhled.", code: "run_expired" }, 409);
    const bytes = Buffer.from(await file.arrayBuffer());
    if (sha256(bytes) !== run.fileSha256) return json({ error: "Soubor se od náhledu změnil. Připravte nový náhled.", code: "file_changed" }, 409);

    // Re-plan against the database as it is NOW — the client's plan, counts or rights are never used.
    const { sheets } = await readCatalogWorkbook(bytes, dependencies.readWorkbook);
    const plan = planCatalogWorkbookImport(sheets, await dependencies.loadContext());
    if (catalogImportPlanHash(plan) !== run.planHash) {
      await runs.markSuperseded(run.id);
      return json({ error: "Katalog nebo číselníky se od náhledu změnily — plán už neodpovídá. Nic se nezapsalo; připravte nový náhled.", code: "plan_changed" }, 409);
    }
    const reasons = blockReasons(plan);
    if (reasons.length) return json({ error: reasons.join(" "), code: "blocked" }, 409);
    if (changeCount(plan) === 0) return json({ error: "Vše je beze změny — není co zapsat.", code: "no_changes" }, 409);

    await runs.expireStaleRunning(new Date(now.getTime() - CATALOG_IMPORT_LIMITS.staleRunningMinutes * 60_000).toISOString());
    const claimed = await runs.claim(run.id, user.id, now.toISOString());
    if (claimed === "busy") return json({ error: "Právě běží jiný import katalogu. Počkejte na jeho dokončení a připravte nový náhled.", code: "import_busy" }, 409);
    if (claimed === "already") return json({ error: "Tento náhled už byl potvrzen nebo vypršel.", code: "run_not_previewed", run: publicRun((await runs.get(run.id)) ?? run) }, 409);

    let lastRows: readonly CatalogImportRowOutcome[] = [];
    try {
      const result = await dependencies.write(plan, async (rows) => {
        lastRows = rows;
        await runs.saveProgress(run.id, rows);
      });
      const finalRows = lastRows.length ? lastRows : [];
      const status = result.failed ? (result.written.length ? "partial" : "failed") : "succeeded";
      await runs.finish(run.id, status, finalRows, result.failed ? `Řádek ${result.failed.sheet} ${result.failed.rowNumber} (${result.failed.label}): ${result.failed.message}` : null);
      return json({ run: publicRun((await runs.get(run.id)) ?? run), written: result.written.length, failed: result.failed ? 1 : 0, notAttempted: Math.max(0, result.notWritten.length - (result.failed ? 1 : 0)) });
    } catch (error) {
      console.error("Catalog import (UI): run failed", error instanceof Error ? error.message : error);
      await runs.finish(run.id, "failed", lastRows, "Import se přerušil neočekávanou chybou. Uložené řádky viz výsledky; stav ověřte novým náhledem.").catch(() => undefined);
      return json({ error: "Import se přerušil neočekávanou chybou. Již uložené karty zůstaly uložené — zkontrolujte výsledek běhu a připravte nový náhled.", code: "run_failed", run: publicRun((await runs.get(run.id).catch(() => undefined)) ?? run) }, 502);
    }
  } catch (error) {
    return failure(error, "Import se nepodařilo provést.");
  }
}

export function publicRun(run: CatalogImportRun) {
  const { planHash: _planHash, createdBy: _createdBy, ...rest } = run;
  return rest;
}

/** GET ?id=… (state of one run — e.g. after a lost connection) or the recent runs. */
export async function handleCatalogImportRuns(request: NextRequest, dependencies: CatalogImportUiDependencies = defaultCatalogImportUiDependencies): Promise<NextResponse> {
  const checked = await guard(request, dependencies, false);
  if ("response" in checked) return checked.response!;
  try {
    const runs = dependencies.runs();
    const id = request.nextUrl.searchParams.get("id");
    await runs.expireStaleRunning(new Date(Date.now() - CATALOG_IMPORT_LIMITS.staleRunningMinutes * 60_000).toISOString());
    if (id) {
      const run = await runs.get(id);
      return run ? json({ run: publicRun(run) }) : json({ error: "Běh importu neexistuje." }, 404);
    }
    return json({ runs: (await runs.listRecent(10)).map(publicRun), limits: CATALOG_IMPORT_LIMITS });
  } catch (error) {
    return failure(error, "Evidenci importů se nepodařilo načíst.");
  }
}

/** GET availability for the panel (enabled / why not) — admin only. */
export async function handleCatalogImportStatus(request: NextRequest, dependencies: CatalogImportUiDependencies = defaultCatalogImportUiDependencies): Promise<NextResponse> {
  const decision = await authorize(request, "catalog.import");
  if (decision.ok === false) return decision.response;
  const availability = dependencies.availability();
  return json({ enabled: availability.enabled, reason: availability.enabled === false ? availability.reason : null, limits: CATALOG_IMPORT_LIMITS, supportedSheets: ["Produkty", "Sluzby"] });
}
