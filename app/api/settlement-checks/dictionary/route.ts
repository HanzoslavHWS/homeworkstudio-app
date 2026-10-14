import type { NextRequest } from "next/server.js";
import { handleSettlementDictionaryGet, handleSettlementDictionaryPost } from "../../../../lib/settlement/settlementApi.server.ts";

export async function GET(request: NextRequest) {
  return handleSettlementDictionaryGet(request);
}

export async function POST(request: NextRequest) {
  return handleSettlementDictionaryPost(request);
}
