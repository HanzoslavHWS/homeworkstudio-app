import type { NextRequest } from "next/server.js";
import { handleSupportSummary } from "../../../../lib/support/supportApi.server.ts";

export async function GET(request: NextRequest) {
  return handleSupportSummary(request);
}
