import type { NextRequest } from "next/server.js";
import { handleRealizationCompanyUpdate } from "../../../../lib/realizationCompanies/realizationCompanyApi.server.ts";

export async function POST(request: NextRequest) {
  return handleRealizationCompanyUpdate(request);
}
