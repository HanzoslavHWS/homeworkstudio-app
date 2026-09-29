import { NextResponse, type NextRequest } from "next/server.js";
import { deleteTask } from "../../../../domain/taskService.ts";
import { defaultTaskApiDependencies, readJsonBody, requireTaskSession, taskErrorResponse, type TaskApiDependencies } from "../../../../lib/tasks/taskApi.server.ts";

export async function handleTaskDelete(request: NextRequest, dependencies: TaskApiDependencies = defaultTaskApiDependencies): Promise<NextResponse> {
  const unauthorized = await requireTaskSession(request);
  if (unauthorized) return unauthorized;
  const body = await readJsonBody<{ id?: string }>(request);
  if (body instanceof NextResponse) return body;
  if (!body.id) return NextResponse.json({ error: "Chybí id úkolu." }, { status: 400 });
  try {
    await deleteTask(dependencies.taskRepository(), body.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return taskErrorResponse(error, "Úkol se nepodařilo smazat.");
  }
}

export async function POST(request: NextRequest) {
  return handleTaskDelete(request);
}
