import { NextResponse, type NextRequest } from "next/server.js";
import { AssetValidationError, assertValidStorageKey, type AssetStorageProvider } from "../../../../domain/assets.ts";
import { isAssetRequestAuthorized } from "../../../../lib/storage/assetRouteAuth.ts";
import { createCloudflareR2StorageProvider } from "../../../../lib/storage/cloudflareR2.server.ts";

export async function handleAssetDelete(
  request: NextRequest,
  providerFactory: () => AssetStorageProvider = createCloudflareR2StorageProvider,
): Promise<NextResponse> {
  if (!(await isAssetRequestAuthorized(request))) return NextResponse.json({ error: "Pro smazání je vyžadováno přihlášení." }, { status: 401 });
  let storageKey = "";
  try { storageKey = String((await request.json() as { storageKey?: unknown }).storageKey ?? ""); }
  catch { return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 }); }
  try {
    assertValidStorageKey(storageKey);
    if (!storageKey.startsWith("temporary/")) {
      return NextResponse.json({ deleted: false, reason: "reference-safety", message: "Objekt zůstal v R2, protože aplikace zatím nemá globální reference tracking. Metadata lze bezpečně odebrat v editoru." });
    }
    await providerFactory().deleteObject(storageKey);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    if (error instanceof AssetValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ error: "R2 objekt se nepodařilo odstranit." }, { status: 502 });
  }
}

export async function DELETE(request: NextRequest) {
  return handleAssetDelete(request);
}
