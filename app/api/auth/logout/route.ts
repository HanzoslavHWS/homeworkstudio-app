import type { NextRequest } from "next/server.js";
import { handleLogout } from "../../../../lib/auth/authApi.server.ts";

export async function POST(request: NextRequest) {
  return handleLogout(request);
}
