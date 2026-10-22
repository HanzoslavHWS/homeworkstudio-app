import type { NextRequest } from "next/server.js";
import { handleSaleRowsRead, handleSaleRowsSave } from "../../../../lib/priceVersions/priceVersionsApi.server.ts";

export async function GET(request: NextRequest) {
  return handleSaleRowsRead(request);
}

export async function POST(request: NextRequest) {
  return handleSaleRowsSave(request);
}
