import type { NextRequest } from "next/server.js";
import { handleUserUpdate } from "../../../../../lib/auth/usersAdminApi.server.ts";

export async function POST(request: NextRequest) {
  return handleUserUpdate(request);
}
