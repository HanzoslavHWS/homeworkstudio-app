import type { NextRequest } from "next/server.js";
import { handleTicketReply } from "../../../../../lib/support/supportApi.server.ts";

export async function POST(request: NextRequest) {
  return handleTicketReply(request);
}
