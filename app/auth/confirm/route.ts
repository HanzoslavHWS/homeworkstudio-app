import type { NextRequest } from "next/server.js";
import { handleConfirmLink } from "../../../lib/auth/authApi.server.ts";

export async function GET(request: NextRequest) {
  return handleConfirmLink(request);
}
