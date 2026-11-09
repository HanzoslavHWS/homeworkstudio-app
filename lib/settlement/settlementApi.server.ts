import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server.js";
import { denyUnless } from "../auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../db/supabase.server.ts";
import { SupabaseRealizationCompanyRepository } from "../db/realizationCompanyRepository.supabase.ts";
import { SettlementSchemaNotMigratedError, SupabaseSettlementRepository } from "../db/settlementRepository.supabase.ts";
import { createSupabaseEventIdResolver, isEventForeignKeyViolation, UNKNOWN_EVENT_MESSAGE, type EventIdResolver } from "../db/eventIdValidation.server.ts";
import { extractSheetGrid, readWorkbookFromBufferTolerant } from "../import/xlsxReader.server.ts";
import type { RealizationCompany } from "../../domain/realizationCompany.ts";
import type { PdfTextItem } from "../../domain/technicalReportTableParsing.ts";
import { parseAbfOrdersFromPdfTextItems, parseAbfOrdersFromSheetGrid } from "../../domain/settlementAbfOrderImport.ts";
import { parseCreativExpoWorkbook, type VendorSheetGrid } from "../../domain/settlementCreativExpoImport.ts";
import {
  SETTLEMENT_VENDOR_PARSERS,
  SettlementConflictError,
  SettlementNotFoundError,
  SettlementValidationError,
  type ParsedVendorBilling,
  type SettlementFileFormat,
  type SettlementParser,
} from "../../domain/settlementCheck.ts";
import {
  addCatalogItemName,
  assignSettlementStand,
  changeSettlementRuleStatus,
  createSettlementCheck,
  createSettlementRule,
  deleteSettlementCheck,
  importSettlementFile,
  loadSettlementCheckDetail,
  loadSettlementSourceRows,
  recomputeSettlementCheck,
  removeSettlementFile,
  saveSettlementDecision,
  saveSettlementMapping,
  updateSettlementCheck,
  type SettlementRepository,
} from "../../domain/settlementService.ts";

/**
 * Shared plumbing + handlers for app/api/settlement-checks/* — same shape as lib/tasks/
 * taskApi.server.ts: session check first, a server-only service-role repository (RLS has zero
 * policies), injectable factories so tests never touch a live DB. The route files only forward.
 */
export type SettlementApiDependencies = Readonly<{
  repository: () => SettlementRepository;
  resolveEventId: () => EventIdResolver;
  listCompanies: () => Promise<readonly RealizationCompany[]>;
  /** Uploaded workbook bytes -> every sheet as a plain grid (the only place exceljs is touched). */
  readWorkbookSheets: (buffer: Buffer) => Promise<readonly VendorSheetGrid[]>;
}>;

export const defaultSettlementApiDependencies: SettlementApiDependencies = {
  repository: () => new SupabaseSettlementRepository(createSupabaseServerClient()),
  resolveEventId: () => createSupabaseEventIdResolver(createSupabaseServerClient()),
  listCompanies: () => new SupabaseRealizationCompanyRepository(createSupabaseServerClient()).list(),
  readWorkbookSheets: async (buffer) => {
    const workbook = await readWorkbookFromBufferTolerant(buffer);
    return workbook.worksheets.map((sheet) => ({ name: sheet.name, rows: extractSheetGrid(workbook, sheet.name) }));
  },
};

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_PDF_TEXT_ITEMS = 200_000;

async function unauthorized(request: NextRequest): Promise<NextResponse | undefined> {
  return denyUnless(request, "settlement.use");
}

async function readJsonBody(request: NextRequest): Promise<Record<string, unknown> | NextResponse> {
  try {
    const body = (await request.json()) as unknown;
    if (!body || typeof body !== "object") throw new Error("not an object");
    return body as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 });
  }
}

function errorResponse(error: unknown, fallbackMessage: string): NextResponse {
  if (error instanceof SettlementValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
  if (error instanceof SettlementNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
  if (error instanceof SettlementConflictError) return NextResponse.json({ error: error.message, code: error.code, details: error.details ?? null }, { status: 409 });
  if (error instanceof SettlementSchemaNotMigratedError) return NextResponse.json({ error: error.message }, { status: 503 });
  if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
  if (isEventForeignKeyViolation(error)) return NextResponse.json({ error: UNKNOWN_EVENT_MESSAGE }, { status: 400 });
  console.error(fallbackMessage, error);
  return NextResponse.json({ error: fallbackMessage }, { status: 502 });
}

/** Free-text actor name (not an authorization identity — the app has one shared login). */
function actorOf(value: unknown): Readonly<{ actorName?: string }> {
  return { actorName: typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : undefined };
}

type Handler = (request: NextRequest, dependencies?: SettlementApiDependencies) => Promise<NextResponse>;

function guarded(fallbackMessage: string, run: (request: NextRequest, dependencies: SettlementApiDependencies) => Promise<NextResponse>): Handler {
  return async (request, dependencies = defaultSettlementApiDependencies) => {
    const denied = await unauthorized(request);
    if (denied) return denied;
    try {
      return await run(request, dependencies);
    } catch (error) {
      return errorResponse(error, fallbackMessage);
    }
  };
}

export const handleSettlementList = guarded("Kontroly vyúčtování se nepodařilo načíst.", async (_request, dependencies) => {
  const [checks, companies] = await Promise.all([dependencies.repository().listChecks(), dependencies.listCompanies()]);
  return NextResponse.json({ checks, companies, vendorParsers: SETTLEMENT_VENDOR_PARSERS });
});

export const handleSettlementCreate = guarded("Kontrolu se nepodařilo vytvořit.", async (request, dependencies) => {
  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;
  const eventResolution = await dependencies.resolveEventId()(typeof body.eventId === "string" ? body.eventId : undefined);
  if (eventResolution.ok === false) return NextResponse.json({ error: eventResolution.message }, { status: 400 });
  // The company must be one of the existing realization companies — this module never creates one.
  const company = (await dependencies.listCompanies()).find((candidate) => candidate.id === body.realizationCompanyId);
  if (!company) return NextResponse.json({ error: "Vybraná realizační firma není v databázi." }, { status: 400 });
  const check = await createSettlementCheck(
    dependencies.repository(),
    { eventId: eventResolution.eventId, realizationCompanyId: company.id, realizationCompanyName: company.name, note: typeof body.note === "string" ? body.note : undefined },
    actorOf(body.actorName),
  );
  return NextResponse.json({ check });
});

export const handleSettlementGet = guarded("Kontrolu se nepodařilo načíst.", async (request, dependencies) => {
  const detail = await loadSettlementCheckDetail(dependencies.repository(), request.nextUrl.searchParams.get("id"));
  return NextResponse.json(detail);
});

export const handleSettlementUpdate = guarded("Kontrolu se nepodařilo uložit.", async (request, dependencies) => {
  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;
  return NextResponse.json({ check: await updateSettlementCheck(dependencies.repository(), body.id, { status: body.status, note: body.note }) });
});

export const handleSettlementDelete = guarded("Kontrolu se nepodařilo smazat.", async (request, dependencies) => {
  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;
  await deleteSettlementCheck(dependencies.repository(), body.id);
  return NextResponse.json({ ok: true });
});

export const handleSettlementRecompute = guarded("Porovnání se nepodařilo přepočítat.", async (request, dependencies) => {
  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;
  return NextResponse.json({ check: await recomputeSettlementCheck(dependencies.repository(), body.id) });
});

export const handleSettlementFileDelete = guarded("Soubor se nepodařilo odebrat.", async (request, dependencies) => {
  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;
  return NextResponse.json({ check: await removeSettlementFile(dependencies.repository(), body.checkId, body.fileId) });
});

function formatOf(fileName: string): SettlementFileFormat | undefined {
  const lower = fileName.toLocaleLowerCase("cs");
  if (lower.endsWith(".xlsx") || lower.endsWith(".xlsm")) return "xlsx";
  if (lower.endsWith(".pdf")) return "pdf";
  return undefined;
}

/** Never trusts the browser's extracted PDF text: every item is re-shaped, anything malformed is dropped. */
function parsePdfTextItems(raw: unknown): readonly PdfTextItem[] {
  if (typeof raw !== "string" || !raw) throw new SettlementValidationError("U PDF chybí extrahovaný text. Nahrajte PDF znovu, případně použijte export do XLSX.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SettlementValidationError("Extrahovaný text PDF není platný.");
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_PDF_TEXT_ITEMS) throw new SettlementValidationError("Extrahovaný text PDF není platný.");
  const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  return parsed.flatMap((entry) => {
    const item = entry as Record<string, unknown> | null;
    if (!item || typeof item.str !== "string" || !finite(item.page) || !finite(item.x) || !finite(item.y)) return [];
    return [{ str: item.str.slice(0, 2000), page: item.page, x: item.x, y: item.y, width: finite(item.width) ? item.width : 0, height: finite(item.height) ? item.height : 0 }];
  });
}

function parseVendorWorkbook(parser: SettlementParser, sheets: readonly VendorSheetGrid[]): ParsedVendorBilling {
  // One parser today; a new realization company adds a case here and an entry in SETTLEMENT_VENDOR_PARSERS.
  if (parser === "creativ_expo_v1") return parseCreativExpoWorkbook(sheets);
  throw new SettlementValidationError("Pro tento formát vyúčtování zatím není importér.");
}

/**
 * multipart/form-data: file, checkId, side ("abf" | "vendor"), optional mode ("replace" | "add"),
 * optional parser (vendor side), optional actorName, and for a PDF `pdfTextItems` — the text
 * layer the browser extracted with pdf.js (lib/pdf/pdfTextExtraction.ts), same split as Technické
 * rastry: pdf.js runs only in the browser, the parsing itself is the pure domain parser here.
 */
export const handleSettlementImport = guarded("Soubor se nepodařilo naimportovat. V databázi po něm nic nezůstalo.", async (request, dependencies) => {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Neplatný požadavek — očekáván nahraný soubor." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Chybí soubor k importu." }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) return NextResponse.json({ error: "Soubor je příliš velký (limit 20 MB)." }, { status: 400 });
  const side = form.get("side");
  if (side !== "abf" && side !== "vendor") return NextResponse.json({ error: "Chybí určení, zda jde o objednávky ABF, nebo vyúčtování realizačky." }, { status: 400 });
  const format = formatOf(file.name);
  if (!format) return NextResponse.json({ error: "Nepodporovaný typ souboru — nahrajte XLSX nebo PDF." }, { status: 400 });
  const modeRaw = form.get("mode");
  const mode = modeRaw === "replace" || modeRaw === "add" ? modeRaw : undefined;

  const buffer = Buffer.from(await file.arrayBuffer());
  const fingerprint = createHash("sha256").update(buffer).digest("hex");
  const base = { checkId: form.get("checkId"), format, fileName: file.name, fileSize: file.size, fingerprint, mode } as const;
  const actor = actorOf(form.get("actorName"));
  const repository = dependencies.repository();

  if (side === "vendor") {
    if (format !== "xlsx") return NextResponse.json({ error: "Vyúčtování realizačky se importuje z XLSX." }, { status: 400 });
    const parserRaw = form.get("parser");
    const parser = SETTLEMENT_VENDOR_PARSERS.find((candidate) => candidate.id === parserRaw)?.id ?? SETTLEMENT_VENDOR_PARSERS[0]!.id;
    let sheets: readonly VendorSheetGrid[];
    try {
      sheets = await dependencies.readWorkbookSheets(buffer);
    } catch {
      return NextResponse.json({ error: "Soubor se nepodařilo přečíst jako XLSX." }, { status: 422 });
    }
    const result = await importSettlementFile(repository, { ...base, side, parsed: { side, billing: parseVendorWorkbook(parser, sheets) } }, actor);
    return NextResponse.json(result);
  }

  if (format === "pdf") {
    const orders = parseAbfOrdersFromPdfTextItems(parsePdfTextItems(form.get("pdfTextItems")));
    return NextResponse.json(await importSettlementFile(repository, { ...base, side, parsed: { side, orders } }, actor));
  }
  let sheets: readonly VendorSheetGrid[];
  try {
    sheets = await dependencies.readWorkbookSheets(buffer);
  } catch {
    return NextResponse.json({ error: "Soubor se nepodařilo přečíst jako XLSX." }, { status: 422 });
  }
  // The ABF report is one sheet; if a workbook has more, the one with the most stands is the report.
  const candidates = sheets.map((sheet) => parseAbfOrdersFromSheetGrid(sheet.rows)).sort((a, b) => b.stands.length - a.stands.length);
  const orders = candidates[0] ?? parseAbfOrdersFromSheetGrid([]);
  return NextResponse.json(await importSettlementFile(repository, { ...base, side, parsed: { side, orders } }, actor));
});

export const handleSettlementSourceRows = guarded("Původní řádky se nepodařilo načíst.", async (request, dependencies) => {
  const params = request.nextUrl.searchParams;
  return NextResponse.json({ rows: await loadSettlementSourceRows(dependencies.repository(), params.get("checkId"), params.get("standId")) });
});

/** `{ kind: "row", … }` records the user's verdict on a compared row; `{ kind: "assignStand", … }` files an unassigned sheet under a stand. */
export const handleSettlementDecision = guarded("Rozhodnutí se nepodařilo uložit.", async (request, dependencies) => {
  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;
  const repository = dependencies.repository();
  if (body.kind === "assignStand") {
    return NextResponse.json({ check: await assignSettlementStand(repository, body.checkId, body.standId, body.standNumber) });
  }
  if (body.kind === "row") {
    const decision = await saveSettlementDecision(repository, { checkId: body.checkId, standKey: body.standKey, rowKey: body.rowKey, decision: body.decision, note: body.note }, actorOf(body.actorName));
    return NextResponse.json({ decision });
  }
  return NextResponse.json({ error: "Neznámý druh rozhodnutí." }, { status: 400 });
});

async function recomputeIfRequested(repository: SettlementRepository, checkId: unknown) {
  return typeof checkId === "string" && checkId ? recomputeSettlementCheck(repository, checkId) : undefined;
}

export const handleSettlementDictionaryGet = guarded("Slovník názvů se nepodařilo načíst.", async (request, dependencies) => {
  const companyId = request.nextUrl.searchParams.get("companyId");
  const repository = dependencies.repository();
  const [catalogItems, catalogNames, mappings] = await Promise.all([
    repository.listCatalogItems(),
    repository.listCatalogNames(),
    companyId ? repository.listMappings(companyId) : Promise.resolve([]),
  ]);
  return NextResponse.json({ catalogItems, catalogNames, mappings });
});

/**
 * `saveMapping` (realization-company name -> component), `addName` / `deleteName` (ABF names of a
 * catalog card). With `recomputeCheckId` the open check is recomputed right away, so a confirmed
 * mapping shows its effect without re-uploading anything.
 */
export const handleSettlementDictionaryPost = guarded("Slovník názvů se nepodařilo uložit.", async (request, dependencies) => {
  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;
  const repository = dependencies.repository();
  if (body.action === "saveMapping") {
    const mapping = await saveSettlementMapping(repository, { realizationCompanyId: body.realizationCompanyId, sourceText: body.sourceText, catalogItemId: body.catalogItemId, unit: body.unit, status: body.status, note: body.note });
    return NextResponse.json({ mapping, check: await recomputeIfRequested(repository, body.recomputeCheckId) });
  }
  if (body.action === "addName") {
    const name = await addCatalogItemName(repository, { catalogItemId: body.catalogItemId, nameType: body.nameType, name: body.name });
    return NextResponse.json({ name, check: await recomputeIfRequested(repository, body.recomputeCheckId) });
  }
  if (body.action === "deleteName") {
    if (typeof body.id !== "string" || !body.id) return NextResponse.json({ error: "Chybí ID názvu." }, { status: 400 });
    await repository.deleteCatalogName(body.id);
    return NextResponse.json({ ok: true, check: await recomputeIfRequested(repository, body.recomputeCheckId) });
  }
  return NextResponse.json({ error: "Neznámá akce slovníku." }, { status: 400 });
});

export const handleSettlementRulesGet = guarded("Pravidla se nepodařilo načíst.", async (request, dependencies) => {
  const companyId = request.nextUrl.searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "Chybí realizační firma." }, { status: 400 });
  return NextResponse.json({ rules: await dependencies.repository().listRules(companyId) });
});

/** `create` always stores a draft; `setStatus` is the only way to activate one and needs the actor's name. */
export const handleSettlementRulesPost = guarded("Pravidlo se nepodařilo uložit.", async (request, dependencies) => {
  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;
  const repository = dependencies.repository();
  const actor = actorOf(body.actorName);
  if (body.action === "create") {
    let rule = await createSettlementRule(repository, body.realizationCompanyId, body.rule, actor);
    // "Realizačka neúčtuje" is clicked on a concrete row by a named person: that click IS the
    // verification, so the rule may be activated in the same request — through the same path.
    if (body.activate === true) rule = await changeSettlementRuleStatus(repository, rule.id, "active", actor);
    return NextResponse.json({ rule, check: await recomputeIfRequested(repository, body.recomputeCheckId) });
  }
  if (body.action === "setStatus") {
    const rule = await changeSettlementRuleStatus(repository, body.id, body.status, actor);
    return NextResponse.json({ rule, check: await recomputeIfRequested(repository, body.recomputeCheckId) });
  }
  return NextResponse.json({ error: "Neznámá akce pravidel." }, { status: 400 });
});
