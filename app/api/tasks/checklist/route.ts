import { NextResponse, type NextRequest } from "next/server.js";
import { buildStandChecklist, resolveChecklistTemplate, resolveStandKey, type StandChecklistRepository, type StandKey } from "../../../../domain/standChecklist.ts";
import { cleanActorName, defaultTaskApiDependencies, readJsonBody, requireTaskSession, taskErrorResponse, type TaskApiDependencies } from "../../../../lib/tasks/taskApi.server.ts";

async function loadChecklist(repository: StandChecklistRepository, stand: StandKey) {
  const [templates, entries] = await Promise.all([repository.listTemplates(), repository.listEntries(stand)]);
  const template = resolveChecklistTemplate(templates, stand.eventId);
  return template ? buildStandChecklist(template, entries) : undefined;
}

/** GET ?eventId=&standNumber= -> the stand's checklist (template resolved server-side). */
export async function handleChecklistGet(request: NextRequest, dependencies: TaskApiDependencies = defaultTaskApiDependencies): Promise<NextResponse> {
  const unauthorized = await requireTaskSession(request);
  if (unauthorized) return unauthorized;
  const params = new URL(request.url).searchParams;
  const stand = resolveStandKey(params.get("eventId") ?? undefined, params.get("standNumber") ?? undefined);
  if (!stand) return NextResponse.json({ error: "Checklist vyžaduje veletrh a číslo stánku." }, { status: 400 });
  try {
    return NextResponse.json({ checklist: (await loadChecklist(dependencies.checklistRepository(), stand)) ?? null });
  } catch (error) {
    return taskErrorResponse(error, "Checklist stánku se nepodařilo načíst.");
  }
}

type ToggleBody = Readonly<{ eventId?: string; standNumber?: string; itemKey?: string; isDone?: boolean; actorName?: string }>;

/** POST { eventId, standNumber, itemKey, isDone } -> the updated checklist. Only keys from the resolved template are accepted. */
export async function handleChecklistToggle(request: NextRequest, dependencies: TaskApiDependencies = defaultTaskApiDependencies): Promise<NextResponse> {
  const unauthorized = await requireTaskSession(request);
  if (unauthorized) return unauthorized;
  const body = await readJsonBody<ToggleBody>(request);
  if (body instanceof NextResponse) return body;
  const stand = resolveStandKey(body.eventId, body.standNumber);
  if (!stand || !body.itemKey || typeof body.isDone !== "boolean") return NextResponse.json({ error: "Chybí stánek, položka nebo stav." }, { status: 400 });
  try {
    const repository = dependencies.checklistRepository();
    const template = resolveChecklistTemplate(await repository.listTemplates(), stand.eventId);
    if (!template?.items.some((item) => item.key === body.itemKey)) return NextResponse.json({ error: "Položka v checklistu neexistuje." }, { status: 400 });
    await repository.setEntry(stand, body.itemKey, body.isDone, cleanActorName(body.actorName));
    return NextResponse.json({ checklist: (await loadChecklist(repository, stand)) ?? null });
  } catch (error) {
    return taskErrorResponse(error, "Checklist stánku se nepodařilo uložit.");
  }
}

export async function GET(request: NextRequest) {
  return handleChecklistGet(request);
}

export async function POST(request: NextRequest) {
  return handleChecklistToggle(request);
}
