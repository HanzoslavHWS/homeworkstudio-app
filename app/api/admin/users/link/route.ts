import type { NextRequest } from "next/server.js";
import { handleUserLink } from "../../../../../lib/auth/usersAdminApi.server.ts";

export async function POST(request: NextRequest) {
  return handleUserLink(request);
}
