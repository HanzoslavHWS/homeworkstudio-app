import { NextResponse, type NextRequest } from "next/server.js";
import {
  AssetValidationError,
  createStorageKey,
  validateUploadInput,
  type AssetStorageProvider,
  type StoredAsset,
} from "../../../../domain/assets.ts";
import { isAssetRequestAuthorized } from "../../../../lib/storage/assetRouteAuth.ts";
import { createCloudflareR2StorageProvider } from "../../../../lib/storage/cloudflareR2.server.ts";
import { R2ConfigurationError } from "../../../../lib/storage/r2Config.ts";

type PresignBody = Readonly<{
  category?: string;
  ownerId?: string;
  originalFileName?: string;
  mimeType?: string;
  size?: number;
  checksum?: string;
  displayName?: string;
}>;

export async function handleAssetPresign(
  request: NextRequest,
  providerFactory: () => AssetStorageProvider = createCloudflareR2StorageProvider,
): Promise<NextResponse> {
  if (!(await isAssetRequestAuthorized(request))) return NextResponse.json({ error: "Pro upload je vyžadováno přihlášení." }, { status: 401 });
  let body: PresignBody;
  try { body = await request.json() as PresignBody; }
  catch { return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 }); }
  const input = {
    category: body.category ?? "",
    ownerId: body.ownerId ?? "",
    originalFileName: body.originalFileName ?? "",
    mimeType: body.mimeType ?? "",
    size: body.size ?? 0,
  };
  try {
    validateUploadInput(input);
    const storageKey = createStorageKey(input);
    const asset: StoredAsset = {
      id: crypto.randomUUID(),
      storageKey,
      originalFileName: input.originalFileName,
      mimeType: input.mimeType,
      size: input.size,
      createdAt: new Date().toISOString(),
      checksum: typeof body.checksum === "string" && body.checksum.length <= 128 ? body.checksum : undefined,
      displayName: typeof body.displayName === "string" ? body.displayName.slice(0, 200) : undefined,
      category: input.category,
    };
    const upload = await providerFactory().createUploadUrl({
      storageKey,
      mimeType: asset.mimeType,
      originalFileName: asset.originalFileName,
      checksum: asset.checksum,
    });
    return NextResponse.json({ asset, upload });
  } catch (error) {
    if (error instanceof AssetValidationError) return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    if (error instanceof R2ConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "R2 upload se nepodařilo připravit." }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  return handleAssetPresign(request);
}
