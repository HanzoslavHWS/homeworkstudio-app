import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { copyFile, open, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { buildContentDispositionHeader } from "../../domain/assets.ts";
import { isSeeStorageKey, normalizeSeePrefix } from "../../domain/seeFiles.ts";
import { readR2Config, type R2Config, type R2Environment } from "../storage/r2Config.ts";
import { signTicket } from "./security.server.ts";

export type SeePresignedUpload = Readonly<{ uploadUrl: string; method: "PUT"; headers: Readonly<Record<string, string>>; expiresAt: string }>;

export type SeeObjectInfo = Readonly<{ contentLength?: number; contentType?: string }>;

/**
 * Object storage of HWS SEE. Keys are opaque (`<prefix>/o/<uuid>.<ext>`, domain/seeFiles.ts) and
 * every method re-validates them, so this layer can never be steered outside the SEE prefix.
 */
export interface SeeObjectStorage {
  readonly id: "cloudflare-r2" | "local-disk";
  readonly prefix: string;
  /** false = files are always delivered through /api/see/content (local dev). */
  readonly supportsSignedDownload: boolean;
  createUploadUrl(input: Readonly<{ storageKey: string; mimeType: string; fileId: string; expiresInSeconds: number }>): Promise<SeePresignedUpload>;
  createDownloadUrl(input: Readonly<{ storageKey: string; mimeType: string; expiresInSeconds: number; fileName: string; attachment: boolean }>): Promise<string>;
  head(storageKey: string): Promise<SeeObjectInfo | undefined>;
  readHead(storageKey: string, bytes: number): Promise<Uint8Array | undefined>;
  openRead(storageKey: string): Promise<Readonly<{ body: ReadableStream<Uint8Array>; contentLength?: number }> | undefined>;
  /**
   * Used for uploads that failed verification, and for the OLD key after re-keying (the bytes stay
   * under the new key) — never for a file that is still referenced.
   */
  deleteObject(storageKey: string): Promise<void>;
  /** Server-side copy inside the SEE storage (re-keying). */
  copyObject(fromKey: string, toKey: string): Promise<void>;
}

function assertKey(storageKey: string, prefix: string) {
  if (!isSeeStorageKey(storageKey, prefix)) throw new Error("Invalid HWS SEE storage key.");
}

/**
 * R2 / network outage (timeouts, connection errors, 5xx, throttling) after the SDK's own retries.
 * Mapped to HTTP 503 + Retry-After with a Czech message; callers keep the project consistent.
 */
export class SeeStorageUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("Úložiště souborů je dočasně nedostupné. Zkuste to prosím za chvíli znovu.");
    this.name = "SeeStorageUnavailableError";
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

const TRANSIENT_NAMES = new Set(["TimeoutError", "RequestTimeout", "RequestTimeoutException", "NetworkingError", "ServiceUnavailable", "SlowDown", "InternalError", "ThrottlingException", "AbortError"]);
const TRANSIENT_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);

export function isTransientStorageError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: string; code?: string; $metadata?: { httpStatusCode?: number }; $retryable?: unknown; cause?: unknown };
  if (candidate.name && TRANSIENT_NAMES.has(candidate.name)) return true;
  if (candidate.code && TRANSIENT_CODES.has(candidate.code)) return true;
  const status = candidate.$metadata?.httpStatusCode;
  if (typeof status === "number" && (status >= 500 || status === 429)) return true;
  if (candidate.$retryable) return true;
  return candidate.cause !== undefined && candidate.cause !== error && isTransientStorageError(candidate.cause);
}

/** Converts transient failures into SeeStorageUnavailableError; everything else is rethrown. */
async function storageCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isTransientStorageError(error)) throw new SeeStorageUnavailableError(error);
    throw error;
  }
}

/**
 * HWS SEE's own S3 client for R2 (the shared lib/storage client of ABF stays untouched): bounded
 * timeouts so an R2 outage fails fast instead of hanging a serverless function, and the SDK's
 * standard retry (3 attempts with backoff) for transient errors.
 */
export function createSeeR2Client(config: R2Config): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // See lib/storage/cloudflareR2.server.ts: R2 rejects presigned PUTs that carry SDK checksums.
    requestChecksumCalculation: "WHEN_REQUIRED",
    maxAttempts: 3,
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 60_000 },
  });
}

export type SeeR2Environment = R2Environment & Readonly<{ SEE_R2_BUCKET_NAME?: string; SEE_R2_PREFIX?: string }>;

/**
 * Cloudflare R2 (S3 API). Reuses the portal's R2 account credentials; SEE_R2_BUCKET_NAME selects a
 * dedicated `hws-see-*` bucket, otherwise the shared private bucket is used under SEE_R2_PREFIX
 * (default `hws-see/`), which the generic /api/assets routes deliberately do not accept.
 */
export class R2SeeObjectStorage implements SeeObjectStorage {
  readonly id = "cloudflare-r2" as const;
  readonly supportsSignedDownload = true;
  readonly prefix: string;
  private readonly environment: SeeR2Environment;
  private cached?: { client: S3Client; bucket: string };

  /** `connection` is for tests only (a fake S3 transport); production builds it from the environment. */
  constructor(environment: SeeR2Environment, connection?: Readonly<{ client: Pick<S3Client, "send">; bucket: string }>) {
    this.environment = environment;
    this.prefix = normalizeSeePrefix(environment.SEE_R2_PREFIX);
    if (connection) this.cached = { client: connection.client as S3Client, bucket: connection.bucket };
  }

  private connection() {
    if (!this.cached) {
      const config = readR2Config({ ...this.environment, R2_BUCKET_NAME: this.environment.SEE_R2_BUCKET_NAME?.trim() || this.environment.R2_BUCKET_NAME });
      this.cached = { client: createSeeR2Client(config), bucket: config.bucketName };
    }
    return this.cached;
  }

  async createUploadUrl(input: Readonly<{ storageKey: string; mimeType: string; fileId: string; expiresInSeconds: number }>) {
    assertKey(input.storageKey, this.prefix);
    const { client, bucket } = this.connection();
    // Same R2 constraints as lib/storage/cloudflareR2.server.ts: no x-amz-meta headers, checksum
    // calculation WHEN_REQUIRED (set on the client). Size is verified after upload via HEAD.
    const command = new PutObjectCommand({ Bucket: bucket, Key: input.storageKey, ContentType: input.mimeType });
    return {
      uploadUrl: await getSignedUrl(client, command, { expiresIn: input.expiresInSeconds }),
      method: "PUT" as const,
      headers: { "Content-Type": input.mimeType },
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString(),
    };
  }

  async createDownloadUrl(input: Readonly<{ storageKey: string; mimeType: string; expiresInSeconds: number; fileName: string; attachment: boolean }>) {
    assertKey(input.storageKey, this.prefix);
    const { client, bucket } = this.connection();
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: input.storageKey,
      ResponseContentType: input.mimeType,
      ResponseContentDisposition: buildContentDispositionHeader(input.fileName, input.attachment ? "attachment" : "inline"),
      ResponseCacheControl: "private, no-store",
    });
    return getSignedUrl(client, command, { expiresIn: input.expiresInSeconds });
  }

  async head(storageKey: string): Promise<SeeObjectInfo | undefined> {
    assertKey(storageKey, this.prefix);
    const { client, bucket } = this.connection();
    return storageCall(async () => {
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: storageKey }));
        return { contentLength: result.ContentLength, contentType: result.ContentType };
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    });
  }

  async readHead(storageKey: string, bytes: number) {
    assertKey(storageKey, this.prefix);
    const { client, bucket } = this.connection();
    return storageCall(async () => {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: storageKey, Range: `bytes=0-${bytes - 1}` }));
        return result.Body ? await result.Body.transformToByteArray() : undefined;
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    });
  }

  async openRead(storageKey: string) {
    assertKey(storageKey, this.prefix);
    const { client, bucket } = this.connection();
    return storageCall(async () => {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: storageKey }));
        return result.Body ? { body: result.Body.transformToWebStream() as ReadableStream<Uint8Array>, contentLength: result.ContentLength } : undefined;
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
    });
  }

  async deleteObject(storageKey: string) {
    assertKey(storageKey, this.prefix);
    const { client, bucket } = this.connection();
    await storageCall(() => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey })));
  }

  async copyObject(fromKey: string, toKey: string) {
    assertKey(fromKey, this.prefix);
    assertKey(toKey, this.prefix);
    const { client, bucket } = this.connection();
    // Same-bucket server-side copy (R2 supports CopyObject up to 5 GB; SEE models are ≤ 1 GB).
    await storageCall(() => client.send(new CopyObjectCommand({ Bucket: bucket, Key: toKey, CopySource: `${bucket}/${toKeyPath(fromKey)}` })));
  }
}

function toKeyPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

/**
 * LOCAL DEV ONLY (SEE_BACKEND=local, refused when NODE_ENV=production): objects on the local disk
 * in a git-ignored folder. Uploads and downloads go through /api/see/dev-storage with the same
 * short-lived signed tickets as real delivery, so the browser flow matches production.
 */
export class LocalDiskSeeObjectStorage implements SeeObjectStorage {
  readonly id = "local-disk" as const;
  readonly supportsSignedDownload = false;
  readonly prefix: string;
  private readonly root: string;
  private readonly secret: string | undefined;

  constructor(root: string, secret: string | undefined, prefix = "hws-see") {
    this.root = path.resolve(root);
    this.secret = secret;
    this.prefix = normalizeSeePrefix(prefix);
  }

  private filePath(storageKey: string) {
    assertKey(storageKey, this.prefix);
    return path.join(this.root, ...storageKey.split("/"));
  }

  async createUploadUrl(input: Readonly<{ storageKey: string; mimeType: string; fileId: string; expiresInSeconds: number }>) {
    this.filePath(input.storageKey);
    const exp = Date.now() + input.expiresInSeconds * 1000;
    const ticket = signTicket({ op: "put", key: input.storageKey, fileId: input.fileId, mime: input.mimeType, exp }, this.secret);
    return {
      uploadUrl: `/api/see/dev-storage?t=${encodeURIComponent(ticket)}`,
      method: "PUT" as const,
      headers: { "Content-Type": input.mimeType },
      expiresAt: new Date(exp).toISOString(),
    };
  }

  async createDownloadUrl(): Promise<string> {
    throw new Error("Local disk storage delivers files only through /api/see/content.");
  }

  async writeObject(storageKey: string, body: Uint8Array) {
    const target = this.filePath(storageKey);
    mkdirSync(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }

  async head(storageKey: string) {
    const target = this.filePath(storageKey);
    return existsSync(target) ? { contentLength: statSync(target).size } : undefined;
  }

  async readHead(storageKey: string, bytes: number) {
    const target = this.filePath(storageKey);
    if (!existsSync(target)) return undefined;
    const handle = await open(target, "r");
    try {
      const buffer = new Uint8Array(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.slice(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async openRead(storageKey: string) {
    const target = this.filePath(storageKey);
    if (!existsSync(target)) return undefined;
    return { body: Readable.toWeb(createReadStream(target)) as ReadableStream<Uint8Array>, contentLength: statSync(target).size };
  }

  async deleteObject(storageKey: string) {
    const target = this.filePath(storageKey);
    if (existsSync(target)) await unlink(target);
  }

  async copyObject(fromKey: string, toKey: string) {
    const target = this.filePath(toKey);
    mkdirSync(path.dirname(target), { recursive: true });
    await copyFile(this.filePath(fromKey), target);
  }
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === "NotFound" || candidate.name === "NoSuchKey" || candidate.$metadata?.httpStatusCode === 404;
}
