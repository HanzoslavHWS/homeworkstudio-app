import type { NextRequest } from "next/server.js";
import { handleCatalogImportRuns } from "../../../../../lib/catalogImport/catalogImportUi.server.ts";

export async function GET(request: NextRequest) {
  return handleCatalogImportRuns(request);
}
