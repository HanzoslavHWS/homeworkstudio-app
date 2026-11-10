import type { NextRequest } from "next/server.js";
import { handleArticleRestore } from "../../../../../lib/support/supportApi.server.ts";

export async function POST(request: NextRequest) {
  return handleArticleRestore(request);
}
