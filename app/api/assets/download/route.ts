import { NextResponse, type NextRequest } from "next/server.js";
import { AssetValidationError, assertValidStorageKey, type AssetStorageProvider } from "../../../../domain/assets.ts";
import { isAssetRequestAuthorized } from "../../../../lib/storage/assetRouteAuth.ts";
import { createCloudflareR2StorageProvider } from "../../../../lib/storage/cloudflareR2.server.ts";
import { R2ConfigurationError } from "../../../../lib/storage/r2Config.ts";

export async function handleAssetDownload(
  request: NextRequest,
  providerFactory: () => AssetStorageProvider = createCloudflareR2StorageProvider,
): Promise<NextResponse> {
  if (!(await isAssetRequestAuthorized(request))) return NextResponse.json({ error: "Pro stažení je vyžadováno přihlášení." }, { status: 401 });
  let storageKey = "";
  try { storageKey = String((await request.json() as { storageKey?: unknown }).storageKey ?? ""); }
  catch { return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 }); }
  try {
    assertValidStorageKey(storageKey);
    const provider = providerFactory();
    const metadata = await provider.getMetadata(storageKey);
    if (!metadata) return NextResponse.json({ error: "Asset nebyl nalezen." }, { status: 404 });
    return NextResponse.json({ downloadUrl: await provider.getDownloadUrl(storageKey), metadata });
  } catch (error) {
    if (error instanceof AssetValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof R2ConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "R2 download URL se nepodařilo vytvořit." }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  return handleAssetDownload(request);
}
