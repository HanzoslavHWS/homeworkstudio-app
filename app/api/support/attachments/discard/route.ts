import type { NextRequest } from "next/server.js";
import { handleAttachmentDiscard } from "../../../../../lib/support/supportApi.server.ts";

export async function POST(request: NextRequest) {
  return handleAttachmentDiscard(request);
}
