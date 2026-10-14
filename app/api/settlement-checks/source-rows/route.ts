import type { NextRequest } from "next/server.js";
import { handleSettlementSourceRows } from "../../../../lib/settlement/settlementApi.server.ts";

export async function GET(request: NextRequest) {
  return handleSettlementSourceRows(request);
}
