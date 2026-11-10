import type { NextRequest } from "next/server.js";
import { handleAttachmentPresign } from "../../../../../lib/support/supportApi.server.ts";

export async function POST(request: NextRequest) {
  return handleAttachmentPresign(request);
}
