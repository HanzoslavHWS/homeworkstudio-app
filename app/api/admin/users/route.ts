import type { NextRequest } from "next/server.js";
import { handleUserCreate, handleUsersList } from "../../../../lib/auth/usersAdminApi.server.ts";

export async function GET(request: NextRequest) {
  return handleUsersList(request);
}

export async function POST(request: NextRequest) {
  return handleUserCreate(request);
}
