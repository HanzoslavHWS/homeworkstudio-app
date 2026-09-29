import { NextResponse, type NextRequest } from "next/server.js";
import { defaultTaskApiDependencies, requireTaskSession, taskErrorResponse, type TaskApiDependencies } from "../../../../lib/tasks/taskApi.server.ts";

/** All tasks + categories in one round trip — the Úkoly page filters/sorts client-side. */
export async function handleTaskList(request: NextRequest, dependencies: TaskApiDependencies = defaultTaskApiDependencies): Promise<NextResponse> {
  const unauthorized = await requireTaskSession(request);
  if (unauthorized) return unauthorized;
  try {
    const repository = dependencies.taskRepository();
    const [tasks, categories] = await Promise.all([repository.list(), repository.listCategories()]);
    return NextResponse.json({ tasks, categories });
  } catch (error) {
    return taskErrorResponse(error, "Úkoly se nepodařilo načíst z databáze.");
  }
}

export async function GET(request: NextRequest) {
  return handleTaskList(request);
}
