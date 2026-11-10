import type { NextRequest } from "next/server.js";
import { handleCommentCreate } from "../../../../../lib/support/supportApi.server.ts";

export async function POST(request: NextRequest) {
  return handleCommentCreate(request);
}
