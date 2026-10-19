import type { NextRequest } from "next/server.js";
import { handlePrintSurfaceCatalogSync } from "../../../../../lib/printSurfaces/printSurfaceCatalogSyncApi.server.ts";

export async function POST(request: NextRequest) {
  return handlePrintSurfaceCatalogSync(request);
}
