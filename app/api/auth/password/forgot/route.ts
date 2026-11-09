import type { NextRequest } from "next/server.js";
import { handleForgotPassword } from "../../../../../lib/auth/authApi.server.ts";

export async function POST(request: NextRequest) {
  return handleForgotPassword(request);
}
