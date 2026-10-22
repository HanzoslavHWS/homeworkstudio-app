import type { NextRequest } from "next/server.js";
import { handlePurchaseAction, handlePurchaseRegister } from "../../../lib/priceVersions/priceVersionsApi.server.ts";

export async function GET(request: NextRequest) {
  return handlePurchaseRegister(request);
}

export async function POST(request: NextRequest) {
  return handlePurchaseAction(request);
}
