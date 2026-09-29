import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../db/supabase.server.ts";
import { SupabaseTaskRepository } from "../db/taskRepository.supabase.ts";
import { SupabaseStandChecklistRepository } from "../db/standChecklistRepository.supabase.ts";
import { createSupabaseEventIdResolver, isEventForeignKeyViolation, UNKNOWN_EVENT_MESSAGE, type EventIdResolver } from "../db/eventIdValidation.server.ts";
import { TaskNotFoundError, TaskValidationError } from "../../domain/taskService.ts";
import type { TaskRepository } from "../../domain/tasks.ts";
import type { StandChecklistRepository } from "../../domain/standChecklist.ts";

/**
 * Shared plumbing for app/api/tasks/* — same shape as every other module's routes: session check
 * first, a server-only service-role repository (RLS has zero policies, the browser never talks to
 * Postgres), and injectable factories so tests never touch a live DB.
 */
export type TaskApiDependencies = Readonly<{
  taskRepository: () => TaskRepository;
  checklistRepository: () => StandChecklistRepository;
  resolveEventId: () => EventIdResolver;
}>;

export const defaultTaskApiDependencies: TaskApiDependencies = {
  taskRepository: () => new SupabaseTaskRepository(createSupabaseServerClient()),
  checklistRepository: () => new SupabaseStandChecklistRepository(createSupabaseServerClient()),
  resolveEventId: () => createSupabaseEventIdResolver(createSupabaseServerClient()),
};

export async function requireTaskSession(request: NextRequest): Promise<NextResponse | undefined> {
  if (await isSessionRequestAuthorized(request)) return undefined;
  return NextResponse.json({ error: "Pro práci s úkoly je vyžadováno přihlášení." }, { status: 401 });
}

export async function readJsonBody<T>(request: NextRequest): Promise<T | NextResponse> {
  try {
    return (await request.json()) as T;
  } catch {
    return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 });
  }
}

function isForeignKeyViolation(error: unknown, column: string): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown; details?: unknown };
  if (candidate.code !== "23503") return false;
  return `${String(candidate.message ?? "")} ${String(candidate.details ?? "")}`.includes(column);
}

/** Maps domain/DB errors to the same Czech, non-leaky responses the other modules use. */
export function taskErrorResponse(error: unknown, fallbackMessage: string): NextResponse {
  if (error instanceof TaskValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
  if (error instanceof TaskNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
  if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
  if (isEventForeignKeyViolation(error)) return NextResponse.json({ error: UNKNOWN_EVENT_MESSAGE }, { status: 400 });
  if (isForeignKeyViolation(error, "realization_company_id")) return NextResponse.json({ error: "Vybraná realizačka není v databázi." }, { status: 400 });
  if (isForeignKeyViolation(error, "category_id")) return NextResponse.json({ error: "Vybraná kategorie neexistuje." }, { status: 400 });
  console.error(fallbackMessage, error);
  return NextResponse.json({ error: fallbackMessage }, { status: 502 });
}

/** Free-text actor name for history (not an authorization identity — the app has one shared login). */
export function cleanActorName(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : undefined;
}
