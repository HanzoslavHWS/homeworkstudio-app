import type { NextRequest } from "next/server.js";
import { handleNotificationsRequeue } from "../../../../../lib/support/supportApi.server.ts";

export async function POST(request: NextRequest) {
  return handleNotificationsRequeue(request);
}
