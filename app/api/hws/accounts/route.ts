import type { NextRequest } from "next/server.js";
import { handleAccountsList } from "../../../../lib/accounts/accountsAdminApi.server.ts";

export async function GET(request: NextRequest) {
  return handleAccountsList(request);
}
