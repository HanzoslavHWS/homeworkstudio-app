import { NextResponse, type NextRequest } from "next/server.js";
import { AssetValidationError, assertValidStorageKey, type AssetStorageProvider } from "../../../../domain/assets.ts";
import { authenticate, authorizeFile } from "../../../../lib/auth/requestAuth.ts";
import { createCloudflareR2StorageProvider } from "../../../../lib/storage/cloudflareR2.server.ts";

export async function handleAssetDelete(
  request: NextRequest,
  providerFactory: () => AssetStorageProvider = createCloudflareR2StorageProvider,
): Promise<NextResponse> {
  const signedIn = await authenticate(request);
  if (signedIn.ok === false) return signedIn.response;
  let storageKey = "";
  try { storageKey = String((await request.json() as { storageKey?: unknown }).storageKey ?? ""); }
  catch { return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 }); }
  try {
    assertValidStorageKey(storageKey);
    const access = await authorizeFile(request, storageKey, "write");
    if (access.ok === false) return access.response;
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
