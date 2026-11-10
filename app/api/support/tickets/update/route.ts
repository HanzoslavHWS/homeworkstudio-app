import type { NextRequest } from "next/server.js";
import { handleTicketUpdate } from "../../../../../lib/support/supportApi.server.ts";

export async function POST(request: NextRequest) {
  return handleTicketUpdate(request);
}
