import type { NextRequest } from "next/server.js";
import { handleTicketGet } from "../../../../../lib/support/supportApi.server.ts";

export async function GET(request: NextRequest) {
  return handleTicketGet(request);
}
