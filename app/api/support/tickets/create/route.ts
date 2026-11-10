import type { NextRequest } from "next/server.js";
import { handleTicketCreate } from "../../../../../lib/support/supportApi.server.ts";

export async function POST(request: NextRequest) {
  return handleTicketCreate(request);
}
