import type { NextRequest } from "next/server.js";
import { handleSession } from "../../../../lib/auth/authApi.server.ts";

export async function GET(request: NextRequest) {
  return handleSession(request);
}
