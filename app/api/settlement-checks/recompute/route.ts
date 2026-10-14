import type { NextRequest } from "next/server.js";
import { handleSettlementRecompute } from "../../../../lib/settlement/settlementApi.server.ts";

export async function POST(request: NextRequest) {
  return handleSettlementRecompute(request);
}
