import type { NextRequest } from "next/server.js";
import { handleUserProjects } from "../../../../../lib/auth/usersAdminApi.server.ts";

export async function POST(request: NextRequest) {
  return handleUserProjects(request);
}
