import { NextResponse, type NextRequest } from "next/server.js";
import type { Permission } from "../../domain/accessControl.ts";
import { denyUnless } from "../auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../db/supabase.server.ts";
import { RealizationCompaniesNotMigratedError, SupabaseRealizationCompanyRepository } from "../db/realizationCompanyRepository.supabase.ts";
import {
  REALIZATION_COMPANY_ALIAS_KINDS,
  type RealizationCompany,
  type RealizationCompanyAdminRepository,
  type RealizationCompanyAliasInput,
  type RealizationCompanyCardInput,
  type RealizationCompanyContact,
} from "../../domain/realizationCompany.ts";
import { createRealizationCompanyId, planAliasChanges, validateRealizationCompanyCard } from "../../domain/realizationCompanyIdentity.ts";

/**
 * Administrace → Realizační firmy (V1-DATA-02). Same shape as lib/settlement/settlementApi.server.ts:
 * session check first, a server-only service-role repository, an injectable factory for tests.
 * There is deliberately no delete handler — a firm is deactivated on its card.
 */
export type RealizationCompanyApiDependencies = Readonly<{ repository: () => RealizationCompanyAdminRepository }>;

export const defaultRealizationCompanyApiDependencies: RealizationCompanyApiDependencies = {
  repository: () => new SupabaseRealizationCompanyRepository(createSupabaseServerClient()),
};

async function unauthorized(request: NextRequest, permission: Permission): Promise<NextResponse | undefined> {
  return denyUnless(request, permission);
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

function errorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof SupabaseConfigurationError || error instanceof RealizationCompaniesNotMigratedError) {
    return NextResponse.json({ error: error.message }, { status: 503 });
  }
  const code = (error as { code?: string } | null)?.code;
  if (code === "23505") return NextResponse.json({ error: "Stejné IČO nebo alternativní název už má jiná firma." }, { status: 409 });
  if (code === "P0001" || code === "23514") {
    return NextResponse.json({ error: (error as { message?: string }).message ?? fallback }, { status: 409 });
  }
  return NextResponse.json({ error: fallback }, { status: 502 });
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseCard(value: unknown): RealizationCompanyCardInput | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const contacts: RealizationCompanyContact[] = Array.isArray(raw.contacts)
    ? raw.contacts.filter((entry) => entry && typeof entry === "object").map((entry, index) => {
        const contact = entry as Record<string, unknown>;
        return { id: text(contact.id) || `contact-${index + 1}`, name: text(contact.name), role: text(contact.role), email: text(contact.email), phone: text(contact.phone), note: text(contact.note) };
      })
    : [];
  return {
    name: text(raw.name) ?? "",
    legalName: text(raw.legalName),
    abraName: text(raw.abraName),
    ico: text(raw.ico),
    dic: text(raw.dic),
    contacts,
    note: text(raw.note),
    isActive: raw.isActive !== false,
  };
}

function parseAliases(value: unknown): RealizationCompanyAliasInput[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => entry && typeof entry === "object").map((entry) => {
    const alias = entry as Record<string, unknown>;
    const kind = REALIZATION_COMPANY_ALIAS_KINDS.find((candidate) => candidate === alias.kind) ?? "alternative";
    return { id: text(alias.id), alias: text(alias.alias) ?? "", kind, note: text(alias.note) };
  });
}

export async function handleRealizationCompaniesList(
  request: NextRequest,
  dependencies: RealizationCompanyApiDependencies = defaultRealizationCompanyApiDependencies,
): Promise<NextResponse> {
  const denied = await unauthorized(request, "realizationCompanies.read");
  if (denied) return denied;
  try {
    const repository = dependencies.repository();
    const [companies, aliases, legacyIds] = await Promise.all([repository.list(), repository.listAliases(), repository.listLegacyIds()]);
    return NextResponse.json({ companies, aliases, legacyIds });
  } catch (error) {
    return errorResponse(error, "Realizační firmy se nepodařilo načíst.");
  }
}

export async function handleRealizationCompanyCreate(
  request: NextRequest,
  dependencies: RealizationCompanyApiDependencies = defaultRealizationCompanyApiDependencies,
): Promise<NextResponse> {
  const denied = await unauthorized(request, "realizationCompanies.manage");
  if (denied) return denied;
  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;
  const card = parseCard(body.card);
  if (!card) return NextResponse.json({ error: "Chybí karta firmy." }, { status: 400 });

  try {
    const repository = dependencies.repository();
    const [companies, aliases, legacyIds] = await Promise.all([repository.list(), repository.listAliases(), repository.listLegacyIds()]);
    const validated = validateRealizationCompanyCard(card, parseAliases(body.aliases), { companies, aliases });
    if (validated.ok === false) return NextResponse.json({ error: validated.issues[0]!.message, issues: validated.issues }, { status: 422 });

    const id = createRealizationCompanyId(validated.card.name, companies.map((company) => company.id), legacyIds.map((legacy) => legacy.legacyId));
    const company = await repository.create({ id, ...validated.card, source: "manual" } satisfies RealizationCompany);
    await repository.saveAliases(planAliasChanges(id, validated.aliases, []));
    return NextResponse.json({ company }, { status: 201 });
  } catch (error) {
    return errorResponse(error, "Firmu se nepodařilo založit.");
  }
}

export async function handleRealizationCompanyUpdate(
  request: NextRequest,
  dependencies: RealizationCompanyApiDependencies = defaultRealizationCompanyApiDependencies,
): Promise<NextResponse> {
  const denied = await unauthorized(request, "realizationCompanies.manage");
  if (denied) return denied;
  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;
  const id = text(body.id);
  const card = parseCard(body.card);
  if (!id || !card) return NextResponse.json({ error: "Chybí ID nebo karta firmy." }, { status: 400 });

  try {
    const repository = dependencies.repository();
    const [companies, aliases] = await Promise.all([repository.list(), repository.listAliases()]);
    const existing = companies.find((company) => company.id === id);
    if (!existing) return NextResponse.json({ error: "Firma neexistuje." }, { status: 404 });
    const validated = validateRealizationCompanyCard(card, parseAliases(body.aliases), { companyId: id, companies, aliases });
    if (validated.ok === false) return NextResponse.json({ error: validated.issues[0]!.message, issues: validated.issues }, { status: 422 });

    const company = await repository.update({ ...validated.card, id, source: existing.source });
    await repository.saveAliases(planAliasChanges(id, validated.aliases, aliases));
    return NextResponse.json({ company });
  } catch (error) {
    return errorResponse(error, "Kartu firmy se nepodařilo uložit.");
  }
}
