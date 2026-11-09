import type { NextRequest } from "next/server.js";
import { handleCallbackToken } from "../../../../lib/auth/authApi.server.ts";

export async function POST(request: NextRequest) {
  return handleCallbackToken(request);
}
