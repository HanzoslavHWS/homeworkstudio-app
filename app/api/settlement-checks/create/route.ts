import type { NextRequest } from "next/server.js";
import { handleSettlementCreate } from "../../../../lib/settlement/settlementApi.server.ts";

export async function POST(request: NextRequest) {
  return handleSettlementCreate(request);
}
