import type { NextRequest } from "next/server.js";
import { handleSettlementList } from "../../../../lib/settlement/settlementApi.server.ts";

export async function GET(request: NextRequest) {
  return handleSettlementList(request);
}
