import type { NextRequest } from "next/server.js";
import { handleCatalogImportPreview } from "../../../../../lib/catalogImport/catalogImportUi.server.ts";

export async function POST(request: NextRequest) {
  return handleCatalogImportPreview(request);
}
