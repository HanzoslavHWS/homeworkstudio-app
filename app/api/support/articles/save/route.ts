import type { NextRequest } from "next/server.js";
import { handleArticleSave } from "../../../../../lib/support/supportApi.server.ts";

export async function POST(request: NextRequest) {
  return handleArticleSave(request);
}
