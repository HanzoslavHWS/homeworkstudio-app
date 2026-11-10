import type { NextRequest } from "next/server.js";
import { handleUsersList } from "../../../../lib/auth/usersAdminApi.server.ts";

// Accounts are created in the shared HomeworkStudio administration (/api/hws/accounts), not here.
export async function GET(request: NextRequest) {
  return handleUsersList(request);
}
