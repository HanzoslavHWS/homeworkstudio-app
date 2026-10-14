import type { NextRequest } from "next/server.js";
import { handleSettlementUpdate } from "../../../../lib/settlement/settlementApi.server.ts";

export async function POST(request: NextRequest) {
  return handleSettlementUpdate(request);
}
