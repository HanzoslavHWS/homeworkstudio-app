import type { NextRequest } from "next/server.js";
import { handleSettlementGet } from "../../../../lib/settlement/settlementApi.server.ts";

export async function GET(request: NextRequest) {
  return handleSettlementGet(request);
}
