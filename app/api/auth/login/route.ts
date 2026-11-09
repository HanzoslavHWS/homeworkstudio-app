import type { NextRequest } from "next/server.js";
import { handleLogin } from "../../../../lib/auth/authApi.server.ts";

export async function POST(request: NextRequest) {
  return handleLogin(request);
}
