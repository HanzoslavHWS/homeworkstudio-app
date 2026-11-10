import type { NextRequest } from "next/server.js";
import { handleArticleGet } from "../../../../../lib/support/supportApi.server.ts";

export async function GET(request: NextRequest) {
  return handleArticleGet(request);
}
