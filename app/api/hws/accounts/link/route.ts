import type { NextRequest } from "next/server.js";
import { handleAccountLink } from "../../../../../lib/accounts/accountsAdminApi.server.ts";

export async function POST(request: NextRequest) {
  return handleAccountLink(request);
}
