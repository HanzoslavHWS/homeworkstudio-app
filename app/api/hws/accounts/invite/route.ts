import type { NextRequest } from "next/server.js";
import { handleAccountInvite } from "../../../../../lib/accounts/accountsAdminApi.server.ts";

export async function POST(request: NextRequest) {
  return handleAccountInvite(request);
}
