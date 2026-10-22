import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../db/supabase.server.ts";
import { createSupabaseEventConfigRepository, EventConfigConflictError, EventConfigNotMigratedError, type EventConfigRepository } from "../db/eventConfig.supabase.ts";
import {
  isEventPathRole,
  normalizeEventPaths,
  validateEventPaths,
  validateRealizationLinks,
  type EventPathMapping,
  type EventRealizationLink,
} from "../../domain/eventAdmin.ts";

/**
 * Administrace → Výstavy / eventy, sections "Realizační firmy" (one list, one optional default) and
 * "Složky na disku" (V1-DATA-06).
 * Session check, server-only repository, injectable for tests. Every save states the
 * config_revision it was based on; a mismatch is a 409 and nothing is written. Paths are metadata
 * only — the server never touches a file system.
 */
export type EventConfigApiDependencies = Readonly<{ repository: () => EventConfigRepository; isAuthorized: (request: NextRequest) => Promise<boolean> }>;

export const defaultEventConfigApiDependencies: EventConfigApiDependencies = {
  repository: () => createSupabaseEventConfigRepository(createSupabaseServerClient()),
  isAuthorized: (request) => isSessionRequestAuthorized(request),
};

const NOT_SAVED = "Veletrh ještě není uložený. Nejdřív uložte kartu veletrhu.";

function errorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof EventConfigConflictError) {
    return NextResponse.json({ error: error.message, conflict: true, ...(error.currentRevision !== undefined ? { currentRevision: error.currentRevision } : {}) }, { status: 409 });
  }
  if (error instanceof SupabaseConfigurationError || error instanceof EventConfigNotMigratedError) return NextResponse.json({ error: error.message }, { status: 503 });
  const code = (error as { code?: string } | null)?.code;
  if (code === "P0002") return NextResponse.json({ error: NOT_SAVED }, { status: 404 });
  if (code === "P0001" || code === "23514" || code === "23503" || code === "23505") return NextResponse.json({ error: (error as { message?: string }).message ?? fallback }, { status: 422 });
  return NextResponse.json({ error: fallback }, { status: 502 });
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function revisionOf(value: unknown): number | undefined {
  const revision = typeof value === "string" ? Number(value) : value;
  return typeof revision === "number" && Number.isInteger(revision) && revision > 0 ? revision : undefined;
}

export async function handleEventConfigRead(request: NextRequest, dependencies: EventConfigApiDependencies = defaultEventConfigApiDependencies): Promise<NextResponse> {
  if (!(await dependencies.isAuthorized(request))) return NextResponse.json({ error: "Pro nastavení veletrhu je vyžadováno přihlášení." }, { status: 401 });
  const eventId = text(request.nextUrl.searchParams.get("eventId"));
  if (!eventId) return NextResponse.json({ error: "Chybí veletrh." }, { status: 400 });
  try {
    const repository = dependencies.repository();
    const [config, companies] = await Promise.all([repository.load(eventId), repository.listCompanies()]);
    if (!config) return NextResponse.json({ error: NOT_SAVED, notSaved: true }, { status: 404 });
    return NextResponse.json({ ...config, companies });
  } catch (error) {
    return errorResponse(error, "Nastavení veletrhu se nepodařilo načíst.");
  }
}

export async function handleEventConfigSave(request: NextRequest, dependencies: EventConfigApiDependencies = defaultEventConfigApiDependencies): Promise<NextResponse> {
  if (!(await dependencies.isAuthorized(request))) return NextResponse.json({ error: "Pro nastavení veletrhu je vyžadováno přihlášení." }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
    if (!body || typeof body !== "object") throw new Error("not an object");
  } catch {
    return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 });
  }
  const eventId = text(body.eventId);
  const expected = revisionOf(body.expectedConfigRevision);
  if (!eventId) return NextResponse.json({ error: "Chybí veletrh." }, { status: 400 });
  if (!expected) return NextResponse.json({ error: "Chybí revize nastavení (expectedConfigRevision). Načtěte kartu znovu." }, { status: 422 });
  try {
    const repository = dependencies.repository();
    if (body.action === "saveRealization") {
      const raw = Array.isArray(body.links) ? body.links : [];
      const links: EventRealizationLink[] = [];
      for (const entry of raw) {
        const row = (entry ?? {}) as Record<string, unknown>;
        const realizationCompanyId = text(row.realizationCompanyId);
        if (!realizationCompanyId) return NextResponse.json({ error: "Každý řádek musí mít realizační firmu." }, { status: 422 });
        const note = text(row.note);
        links.push({ realizationCompanyId, isDefault: row.isDefault === true, ...(note ? { note: note.slice(0, 500) } : {}) });
      }
      const check = validateRealizationLinks(links, await repository.listCompanies());
      if (check.errors.length) return NextResponse.json({ error: check.errors[0], errors: check.errors }, { status: 422 });
      const configRevision = await repository.saveRealizationLinks(eventId, expected, links);
      return NextResponse.json({ ok: true, configRevision, warnings: check.warnings });
    }
    if (body.action === "savePaths") {
      const raw = Array.isArray(body.paths) ? body.paths : [];
      const paths: EventPathMapping[] = [];
      for (const entry of raw) {
        const row = (entry ?? {}) as Record<string, unknown>;
        if (!isEventPathRole(row.role)) return NextResponse.json({ error: "Neznámá role složky." }, { status: 422 });
        const note = text(row.note);
        paths.push({ role: row.role, path: typeof row.path === "string" ? row.path : "", ...(note ? { note: note.slice(0, 500) } : {}) });
      }
      const normalized = normalizeEventPaths(paths);
      const issues = validateEventPaths(normalized);
      if (Object.keys(issues).length) return NextResponse.json({ error: Object.values(issues)[0], issues }, { status: 422 });
      const configRevision = await repository.savePathMappings(eventId, expected, normalized);
      return NextResponse.json({ ok: true, configRevision, paths: normalized });
    }
    return NextResponse.json({ error: "Neznámá akce." }, { status: 400 });
  } catch (error) {
    return errorResponse(error, "Nastavení veletrhu se nepodařilo uložit.");
  }
}
