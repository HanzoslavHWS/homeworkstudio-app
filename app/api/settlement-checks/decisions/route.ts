import type { NextRequest } from "next/server.js";
import { handleSettlementDecision } from "../../../../lib/settlement/settlementApi.server.ts";

export async function POST(request: NextRequest) {
  return handleSettlementDecision(request);
}
