import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { AssetObjectMetadata, AssetStorageProvider } from "../../domain/assets.ts";
import { assertValidStorageKey } from "../../domain/assets.ts";
import { readR2Config, type R2Config, type R2Environment } from "./r2Config.ts";

type S3Transport = Pick<S3Client, "send">;
type UrlSigner = (client: S3Client, command: PutObjectCommand | GetObjectCommand, options: { expiresIn: number }) => Promise<string>;

export function createR2Client(config: R2Config): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // AWS SDK v3 defaults to requestChecksumCalculation "WHEN_SUPPORTED", which silently adds
    // an x-amz-checksum-crc32 header (computed for an empty body) to PutObject requests and
    // therefore into the presigned SignedHeaders. Browsers never send that header on the real
    // PUT, so R2 rejects the signature with 403. "WHEN_REQUIRED" only adds checksum headers
    // when explicitly requested via ChecksumAlgorithm, which we don't set.
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
}

export class CloudflareR2StorageProvider implements AssetStorageProvider {
  readonly id = "cloudflare-r2";
  private readonly config: R2Config;
  private readonly client: S3Transport;
  private readonly signUrl: UrlSigner;

  constructor(
    config: R2Config,
    client: S3Transport = createR2Client(config),
    signUrl: UrlSigner = getSignedUrl,
  ) {
    this.config = config;
    this.client = client;
    this.signUrl = signUrl;
  }

  async createUploadUrl(input: Readonly<{ storageKey: string; mimeType: string; originalFileName: string; checksum?: string; expiresInSeconds?: number }>) {
    assertValidStorageKey(input.storageKey);
    const expiresIn = boundedExpiry(input.expiresInSeconds, 600);
    // Deliberately no Metadata / x-amz-meta-* here: the presigner hoists custom headers into
    // the presigned URL's query string, and Cloudflare R2 returns 403 SignatureDoesNotMatch if
    // the browser then ALSO sends that same header value on the actual PUT (verified against
    // live R2 - identical request succeeds with 200 once the header/Metadata is removed).
    // originalFileName and checksum are already persisted in the application's Asset model, so
    // R2 object metadata isn't needed for the app to function.
    const command = new PutObjectCommand({
      Bucket: this.config.bucketName,
      Key: input.storageKey,
      ContentType: input.mimeType,
    });
    return {
      uploadUrl: await this.signUrl(this.client as S3Client, command, { expiresIn }),
      method: "PUT" as const,
      headers: { "Content-Type": input.mimeType },
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };
  }

  async getDownloadUrl(storageKey: string, expiresInSeconds?: number): Promise<string> {
    assertValidStorageKey(storageKey);
    return this.signUrl(this.client as S3Client, new GetObjectCommand({ Bucket: this.config.bucketName, Key: storageKey }), { expiresIn: boundedExpiry(expiresInSeconds, 900) });
  }

  async deleteObject(storageKey: string): Promise<void> {
    assertValidStorageKey(storageKey);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucketName, Key: storageKey }));
  }

  async objectExists(storageKey: string): Promise<boolean> {
    return Boolean(await this.getMetadata(storageKey));
  }

  async getMetadata(storageKey: string): Promise<AssetObjectMetadata | undefined> {
    assertValidStorageKey(storageKey);
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucketName, Key: storageKey }));
      return {
        storageKey,
        contentType: result.ContentType,
        contentLength: result.ContentLength,
        etag: result.ETag,
        lastModified: result.LastModified?.toISOString(),
        customMetadata: result.Metadata,
      };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async listObjects(prefix: string): Promise<readonly AssetObjectMetadata[]> {
    assertValidStorageKey(prefix.replace(/\/$/u, ""));
    const result = await this.client.send(new ListObjectsV2Command({ Bucket: this.config.bucketName, Prefix: prefix }));
    return (result.Contents ?? []).flatMap((object) => object.Key ? [{ storageKey: object.Key, contentLength: object.Size, etag: object.ETag, lastModified: object.LastModified?.toISOString() }] : []);
  }
}

export function createCloudflareR2StorageProvider(environment: R2Environment = {
  R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME: process.env.R2_BUCKET_NAME,
  R2_ENDPOINT: process.env.R2_ENDPOINT,
}): CloudflareR2StorageProvider {
  return new CloudflareR2StorageProvider(readR2Config(environment));
}

function boundedExpiry(value: number | undefined, fallback: number): number {
  return Math.max(30, Math.min(3600, Number.isFinite(value) ? Math.round(value!) : fallback));
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === "NotFound" || candidate.name === "NoSuchKey" || candidate.$metadata?.httpStatusCode === 404;
}
