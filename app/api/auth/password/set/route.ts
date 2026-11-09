import type { NextRequest } from "next/server.js";
import { handleSetPassword } from "../../../../../lib/auth/authApi.server.ts";

export async function POST(request: NextRequest) {
  return handleSetPassword(request);
}
