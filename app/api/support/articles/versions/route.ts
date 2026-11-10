import type { NextRequest } from "next/server.js";
import { handleArticleVersions } from "../../../../../lib/support/supportApi.server.ts";

export async function GET(request: NextRequest) {
  return handleArticleVersions(request);
}
