import type { NextRequest } from "next/server.js";
import { handleAccountUpdate } from "../../../../../lib/accounts/accountsAdminApi.server.ts";

export async function POST(request: NextRequest) {
  return handleAccountUpdate(request);
}
