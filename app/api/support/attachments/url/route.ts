import type { NextRequest } from "next/server.js";
import { handleAttachmentUrl } from "../../../../../lib/support/supportApi.server.ts";

export async function POST(request: NextRequest) {
  return handleAttachmentUrl(request);
}
