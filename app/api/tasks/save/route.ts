import { NextResponse, type NextRequest } from "next/server.js";
import { createTask, updateTask } from "../../../../domain/taskService.ts";
import type { TaskInput } from "../../../../domain/tasks.ts";
import { cleanActorName, defaultTaskApiDependencies, readJsonBody, requireTaskSession, taskErrorResponse, type TaskApiDependencies } from "../../../../lib/tasks/taskApi.server.ts";

type SaveBody = Readonly<{ id?: string; task?: TaskInput; actorName?: string }>;

/**
 * `{ task }` creates, `{ id, task }` updates (full form). The event id goes through the same
 * canonical event resolver as every other module's save route (a legacy per-edition id becomes
 * its canonical id; an unknown one is rejected with a clear message instead of a raw FK error).
 */
export async function handleTaskSave(request: NextRequest, dependencies: TaskApiDependencies = defaultTaskApiDependencies): Promise<NextResponse> {
  const unauthorized = await requireTaskSession(request);
  if (unauthorized) return unauthorized;
  const body = await readJsonBody<SaveBody>(request);
  if (body instanceof NextResponse) return body;
  if (!body.task || typeof body.task !== "object") return NextResponse.json({ error: "Chybí data úkolu." }, { status: 400 });
  try {
    const eventResolution = await dependencies.resolveEventId()(body.task.eventId);
    if (eventResolution.ok === false) return NextResponse.json({ error: eventResolution.message }, { status: 400 });
    const input: TaskInput = { ...body.task, eventId: eventResolution.eventId };
    const actor = { actorName: cleanActorName(body.actorName) };
    const repository = dependencies.taskRepository();
    const task = body.id ? await updateTask(repository, body.id, input, actor) : await createTask(repository, input, actor);
    return NextResponse.json({ task });
  } catch (error) {
    return taskErrorResponse(error, "Úkol se nepodařilo uložit do databáze.");
  }
}

export async function POST(request: NextRequest) {
  return handleTaskSave(request);
}
