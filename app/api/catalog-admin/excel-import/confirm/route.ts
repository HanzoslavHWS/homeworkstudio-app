import type { NextRequest } from "next/server.js";
import { handleCatalogImportConfirm } from "../../../../../lib/catalogImport/catalogImportUi.server.ts";

export async function POST(request: NextRequest) {
  return handleCatalogImportConfirm(request);
}
