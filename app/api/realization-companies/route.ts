import type { NextRequest } from "next/server.js";
import { handleRealizationCompaniesList, handleRealizationCompanyCreate } from "../../../lib/realizationCompanies/realizationCompanyApi.server.ts";

export async function GET(request: NextRequest) {
  return handleRealizationCompaniesList(request);
}

export async function POST(request: NextRequest) {
  return handleRealizationCompanyCreate(request);
}
