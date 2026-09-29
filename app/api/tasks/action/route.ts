import { NextResponse, type NextRequest } from "next/server.js";
import { approveTask, returnTask, setTaskStatus } from "../../../../domain/taskService.ts";
import { TASK_STATUSES, type TaskStatus } from "../../../../domain/tasks.ts";
import { cleanActorName, defaultTaskApiDependencies, readJsonBody, requireTaskSession, taskErrorResponse, type TaskApiDependencies } from "../../../../lib/tasks/taskApi.server.ts";

type ActionBody = Readonly<{ id?: string; action?: "setStatus" | "approve" | "return"; status?: TaskStatus; note?: string; actorName?: string }>;

/** Quick actions: checkbox done / undo (setStatus), "Schválit ✓" (approve), "Vrátit zpět" with a note (return). */
export async function handleTaskAction(request: NextRequest, dependencies: TaskApiDependencies = defaultTaskApiDependencies): Promise<NextResponse> {
  const unauthorized = await requireTaskSession(request);
  if (unauthorized) return unauthorized;
  const body = await readJsonBody<ActionBody>(request);
  if (body instanceof NextResponse) return body;
  if (!body.id) return NextResponse.json({ error: "Chybí id úkolu." }, { status: 400 });
  const actor = { actorName: cleanActorName(body.actorName) };
  try {
    const repository = dependencies.taskRepository();
    switch (body.action) {
      case "setStatus": {
        if (!body.status || !TASK_STATUSES.includes(body.status)) return NextResponse.json({ error: "Neplatný stav úkolu." }, { status: 400 });
        return NextResponse.json({ task: await setTaskStatus(repository, body.id, body.status, actor) });
      }
      case "approve":
        return NextResponse.json({ task: await approveTask(repository, body.id, actor, body.note) });
      case "return":
        return NextResponse.json({ task: await returnTask(repository, body.id, body.note ?? "", actor) });
      default:
        return NextResponse.json({ error: "Neznámá akce." }, { status: 400 });
    }
  } catch (error) {
    return taskErrorResponse(error, "Úkol se nepodařilo změnit.");
  }
}

export async function POST(request: NextRequest) {
  return handleTaskAction(request);
}
