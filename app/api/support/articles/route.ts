import type { NextRequest } from "next/server.js";
import { handleArticlesList } from "../../../../lib/support/supportApi.server.ts";

export async function GET(request: NextRequest) {
  return handleArticlesList(request);
}
