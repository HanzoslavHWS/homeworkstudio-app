import type { NextRequest } from "next/server.js";
import { handleEventConfigRead, handleEventConfigSave } from "../../../../lib/events/eventConfigApi.server.ts";

export async function GET(request: NextRequest) {
  return handleEventConfigRead(request);
}

export async function POST(request: NextRequest) {
  return handleEventConfigSave(request);
}
