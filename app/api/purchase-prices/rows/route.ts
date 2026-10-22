import type { NextRequest } from "next/server.js";
import { handlePurchaseRowsRead, handlePurchaseRowsSave } from "../../../../lib/priceVersions/priceVersionsApi.server.ts";

export async function GET(request: NextRequest) {
  return handlePurchaseRowsRead(request);
}

export async function POST(request: NextRequest) {
  return handlePurchaseRowsSave(request);
}
