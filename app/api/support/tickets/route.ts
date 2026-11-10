import type { NextRequest } from "next/server.js";
import { handleTicketsList } from "../../../../lib/support/supportApi.server.ts";

export async function GET(request: NextRequest) {
  return handleTicketsList(request);
}
