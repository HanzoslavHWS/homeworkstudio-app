import { NextResponse, type NextRequest } from "next/server.js";
import { SupabaseConfigurationError } from "../db/supabase.server.ts";
import { AuthSchemaNotMigratedError } from "./authStore.server.ts";
import { authorize } from "./requestAuth.ts";
import { UserConflictError, usersAdminStore } from "./usersAdmin.supabase.ts";

/**
 * ABF → Administrace → Uživatelé a přiřazení (V1-AUTH-01, V1-AUTH-02). Every handler requires
 * `users.manage` (ABF admin) — also when called directly. Shows the ABF members with their ABF role
 * and state and manages project assignments only. Creating accounts, invitations, roles and access
 * to applications belong to the shared HomeworkStudio administration (lib/accounts, /sprava-uzivatelu).
 *
 * A NEW assignment needs an active ABF member; removing an assignment is always possible. An
 * assignment never opens anything on its own: without an ABF membership every ABF request is refused.
 */
function errorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof UserConflictError) return NextResponse.json({ error: error.message, code: "conflict" }, { status: 409 });
  if (error instanceof AuthSchemaNotMigratedError || error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message, code: "config" }, { status: 503 });
  console.error(`Users admin: ${fallback}`, error instanceof Error ? error.message : error);
  return NextResponse.json({ error: fallback }, { status: 502 });
}

async function readJson(request: NextRequest): Promise<Record<string, unknown> | undefined> {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export async function handleUsersList(request: NextRequest): Promise<NextResponse> {
  const decision = await authorize(request, "users.manage");
  if (decision.ok === false) return decision.response;
  try {
    const store = usersAdminStore();
    const [users, projects] = await Promise.all([store.list(), store.assignableProjects()]);
    return NextResponse.json({ users, projects, currentUserId: decision.auth.user.id });
  } catch (error) {
    return errorResponse(error, "Seznam uživatelů se nepodařilo načíst.");
  }
}

/** Přiřazení projektů uživateli (nahradí celé přiřazení). Odebrání platí okamžitě i pro přímá volání API. */
export async function handleUserProjects(request: NextRequest): Promise<NextResponse> {
  const decision = await authorize(request, "users.manage");
  if (decision.ok === false) return decision.response;
  const body = await readJson(request);
  const userId = typeof body?.userId === "string" ? body.userId : "";
  const projectIds = Array.isArray(body?.projectIds) && body!.projectIds.every((id) => typeof id === "string") ? (body!.projectIds as string[]) : undefined;
  if (!userId || !projectIds) return NextResponse.json({ error: "Chybí uživatel nebo seznam projektů." }, { status: 400 });
  try {
    const store = usersAdminStore();
    const target = await store.get(userId);
    if (!target) return NextResponse.json({ error: "Uživatel neexistuje." }, { status: 404 });
    const adds = projectIds.some((id) => !target.projectIds.includes(id));
    if (adds && (!target.isActive || target.role === undefined)) {
      return NextResponse.json({ error: "Účet nemá aktivní přístup do ABF — nové zakázky mu nelze přiřadit (odebrat je lze).", code: "no_app_access" }, { status: 409 });
    }
    return NextResponse.json({ projectIds: await store.setProjects(userId, projectIds, decision.auth.user.id) });
  } catch (error) {
    return errorResponse(error, "Přiřazení projektů se nepodařilo uložit.");
  }
}
