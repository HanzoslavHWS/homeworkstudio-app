import type { NextRequest } from "next/server.js";
import { handleSettlementDelete } from "../../../../lib/settlement/settlementApi.server.ts";

export async function POST(request: NextRequest) {
  return handleSettlementDelete(request);
}
