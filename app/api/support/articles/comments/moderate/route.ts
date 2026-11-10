import type { NextRequest } from "next/server.js";
import { handleCommentModerate } from "../../../../../../lib/support/supportApi.server.ts";

export async function POST(request: NextRequest) {
  return handleCommentModerate(request);
}
