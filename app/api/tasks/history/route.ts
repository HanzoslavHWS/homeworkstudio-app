import { NextResponse, type NextRequest } from "next/server.js";
import { defaultTaskApiDependencies, requireTaskSession, taskErrorResponse, type TaskApiDependencies } from "../../../../lib/tasks/taskApi.server.ts";

export async function handleTaskHistory(request: NextRequest, dependencies: TaskApiDependencies = defaultTaskApiDependencies): Promise<NextResponse> {
  const unauthorized = await requireTaskSession(request);
  if (unauthorized) return unauthorized;
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Chybí id úkolu." }, { status: 400 });
  try {
    return NextResponse.json({ history: await dependencies.taskRepository().listHistory(id) });
  } catch (error) {
    return taskErrorResponse(error, "Historii úkolu se nepodařilo načíst.");
  }
}

export async function GET(request: NextRequest) {
  return handleTaskHistory(request);
}
