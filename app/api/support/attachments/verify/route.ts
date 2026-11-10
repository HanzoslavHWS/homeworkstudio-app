import type { NextRequest } from "next/server.js";
import { handleAttachmentVerify } from "../../../../../lib/support/supportApi.server.ts";

export async function POST(request: NextRequest) {
  return handleAttachmentVerify(request);
}
