import type { NextRequest } from "next/server.js";
import { handleCatalogImportStatus } from "../../../../lib/catalogImport/catalogImportUi.server.ts";

export async function GET(request: NextRequest) {
  return handleCatalogImportStatus(request);
}
