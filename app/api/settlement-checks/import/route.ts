import type { NextRequest } from "next/server.js";
import { handleSettlementImport } from "../../../../lib/settlement/settlementApi.server.ts";

export async function POST(request: NextRequest) {
  return handleSettlementImport(request);
}
