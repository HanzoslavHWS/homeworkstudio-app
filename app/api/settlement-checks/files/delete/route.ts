import type { NextRequest } from "next/server.js";
import { handleSettlementFileDelete } from "../../../../../lib/settlement/settlementApi.server.ts";

export async function POST(request: NextRequest) {
  return handleSettlementFileDelete(request);
}
