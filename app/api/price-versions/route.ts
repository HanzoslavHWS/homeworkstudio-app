import type { NextRequest } from "next/server.js";
import { handleSaleAction, handleSaleRegister } from "../../../lib/priceVersions/priceVersionsApi.server.ts";

export async function GET(request: NextRequest) {
  return handleSaleRegister(request);
}

export async function POST(request: NextRequest) {
  return handleSaleAction(request);
}
