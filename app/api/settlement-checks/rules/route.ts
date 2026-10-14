import type { NextRequest } from "next/server.js";
import { handleSettlementRulesGet, handleSettlementRulesPost } from "../../../../lib/settlement/settlementApi.server.ts";

export async function GET(request: NextRequest) {
  return handleSettlementRulesGet(request);
}

export async function POST(request: NextRequest) {
  return handleSettlementRulesPost(request);
}
