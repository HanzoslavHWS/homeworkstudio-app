import type { NextRequest } from "next/server.js";
import { handleSaleResolve } from "../../../../lib/priceVersions/priceVersionsApi.server.ts";

export async function POST(request: NextRequest) {
  return handleSaleResolve(request);
}
