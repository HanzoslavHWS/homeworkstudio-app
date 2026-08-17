import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server.js";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  AssetValidationError,
  createStorageKey,
  preferredAsset,
  sanitizeStorageSegment,
  validateUploadInput,
  type AssetStorageProvider,
  type StoredAsset,
} from "../domain/assets.ts";
import { catalogImageAsset, catalogImageUrl } from "../domain/catalog.ts";
import { componentCatalog } from "../data/components.ts";
import {
  createEventDocumentFromAsset,
  normalizeExhibition,
} from "../domain/organizations.ts";
import { LocalEventRepository } from "../domain/eventRepository.ts";
import type { KeyValueStorage } from "../domain/repository.ts";
import { normalizeProjectRecord } from "../domain/project.ts";
import { CloudflareR2StorageProvider, createR2Client } from "../lib/storage/cloudflareR2.server.ts";
import { R2ConfigurationError, readR2Config } from "../lib/storage/r2Config.ts";
import { createSessionToken } from "../lib/auth/session.ts";
import { handleAssetPresign } from "../app/api/assets/presign/route.ts";
import { handleAssetDelete } from "../app/api/assets/delete/route.ts";

const r2Config = {
  accountId: "account",
  accessKeyId: "ACCESS_DO_NOT_LEAK",
  secretAccessKey: "SECRET_DO_NOT_LEAK",
  bucketName: "bucket",
  endpoint: "https://account.r2.cloudflarestorage.com",
  region: "auto" as const,
};

test("R2 config vrátí srozumitelnou chybu se jmény chybějících env bez secrets", () => {
  assert.throws(
    () => readR2Config({ R2_ACCOUNT_ID: "account" }),
    (error) => error instanceof R2ConfigurationError && error.missingVariables.includes("R2_SECRET_ACCESS_KEY") && !error.message.includes("ACCESS_DO_NOT_LEAK"),
  );
  assert.equal(readR2Config({ R2_ACCOUNT_ID: "account", R2_ACCESS_KEY_ID: "key", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET_NAME: "bucket", R2_ENDPOINT: "https://endpoint.example/" }).endpoint, "https://endpoint.example");
});

test("storageKey generátor sanitizuje owner a nikdy nepoužije původní filename jako cestu", () => {
  assert.equal(sanitizeStorageSegment("For Beauty Podzim 2026"), "for-beauty-podzim-2026");
  assert.equal(
    createStorageKey({ category: "event-logo", ownerId: "For Beauty Podzim 2026", originalFileName: "../../My Logo.PNG", mimeType: "image/png" }, "fixed-uuid"),
    "events/for-beauty-podzim-2026/logo/fixed-uuid.png",
  );
  assert.throws(() => sanitizeStorageSegment("../../"), AssetValidationError);
});

test("upload validace odmítne MIME mismatch a oversized soubor", () => {
  assert.throws(() => validateUploadInput({ category: "event-logo", ownerId: "event", originalFileName: "logo.exe", mimeType: "application/octet-stream", size: 10 }), (error) => error instanceof AssetValidationError && error.code === "invalid-mime");
  assert.throws(() => validateUploadInput({ category: "event-logo", ownerId: "event", originalFileName: "logo.png", mimeType: "image/png", size: 6_000_000 }), (error) => error instanceof AssetValidationError && error.code === "oversized");
});

// -----------------------------------------------------------------------------------------
// Catalog item asset workflow — photo (jpg/jpeg/png/webp only) + GLB (model/gltf-binary only)
// -----------------------------------------------------------------------------------------

test("catalog-photo přijme jpg/png/webp a odmítne gif/svg (užší než sdílené IMAGE_TYPES pro eventy)", () => {
  for (const [mimeType, fileName] of [["image/jpeg", "photo.jpg"], ["image/png", "photo.png"], ["image/webp", "photo.webp"]] as const) {
    assert.doesNotThrow(() => validateUploadInput({ category: "catalog-photo", ownerId: "M99", originalFileName: fileName, mimeType, size: 1000 }));
  }
  assert.throws(() => validateUploadInput({ category: "catalog-photo", ownerId: "M99", originalFileName: "photo.gif", mimeType: "image/gif", size: 1000 }), (error) => error instanceof AssetValidationError && error.code === "invalid-mime");
  assert.throws(() => validateUploadInput({ category: "catalog-photo", ownerId: "M99", originalFileName: "photo.svg", mimeType: "image/svg+xml", size: 1000 }), (error) => error instanceof AssetValidationError && error.code === "invalid-mime");
});

test("catalog-model přijme pouze .glb (model/gltf-binary) a odmítne application/octet-stream (dřív povolovalo i .skp)", () => {
  assert.doesNotThrow(() => validateUploadInput({ category: "catalog-model", ownerId: "M99", originalFileName: "model.glb", mimeType: "model/gltf-binary", size: 1_000_000 }));
  assert.throws(() => validateUploadInput({ category: "catalog-model", ownerId: "M99", originalFileName: "model.skp", mimeType: "application/octet-stream", size: 1_000_000 }), (error) => error instanceof AssetValidationError && error.code === "invalid-mime");
  assert.throws(() => validateUploadInput({ category: "catalog-model", ownerId: "M99", originalFileName: "model.glb", mimeType: "application/octet-stream", size: 1_000_000 }), (error) => error instanceof AssetValidationError && error.code === "invalid-mime");
  assert.throws(() => validateUploadInput({ category: "catalog-model", ownerId: "M99", originalFileName: "photo.jpg", mimeType: "image/jpeg", size: 1000 }), (error) => error instanceof AssetValidationError && error.code === "invalid-mime");
});

test("catalog-model storageKey odpovídá existující catalog/furniture/<id>/models konvenci (stejný prefix jako catalog-photo)", () => {
  assert.equal(
    createStorageKey({ category: "catalog-model", ownerId: "M99", originalFileName: "model.glb", mimeType: "model/gltf-binary" }, "fixed-uuid"),
    "catalog/furniture/m99/models/fixed-uuid.glb",
  );
});

test("R2 provider presignuje PutObject s bucketem, klíčem a Content-Type bez R2 object metadata", async () => {
  const commands: unknown[] = [];
  const client = { send: async (command: unknown) => { commands.push(command); return {}; } };
  const signed: unknown[] = [];
  const provider = new CloudflareR2StorageProvider(r2Config, client as never, async (_client, command) => { signed.push(command); return "https://signed.example/upload"; });
  const result = await provider.createUploadUrl({ storageKey: "events/event/logo/id.png", mimeType: "image/png", originalFileName: "Logo.png" });
  const command = signed[0] as PutObjectCommand;
  assert.ok(command instanceof PutObjectCommand);
  assert.deepEqual(command.input, { Bucket: "bucket", Key: "events/event/logo/id.png", ContentType: "image/png" });
  assert.equal(result.headers["Content-Type"], "image/png");
  assert.equal("x-amz-meta-original-file-name" in result.headers, false, "R2 nesmí dostat x-amz-meta header, jinak presigned PUT vrátí SignatureDoesNotMatch");
});

test("presigned PUT URL nevynucuje checksum ani x-amz-meta header, které browser XHR PUT neposílá", async () => {
  const client = createR2Client(r2Config);
  const provider = new CloudflareR2StorageProvider(r2Config, client);
  const upload = await provider.createUploadUrl({ storageKey: "temporary/checksum-regression.png", mimeType: "image/png", originalFileName: "test.png" });
  const url = new URL(upload.uploadUrl);
  assert.equal(url.searchParams.has("x-amz-checksum-crc32"), false, "presigned URL nesmí vyžadovat CRC32 checksum, který XHR PUT neposílá");
  assert.equal(url.searchParams.has("x-amz-sdk-checksum-algorithm"), false);
  // Ověřeno proti živému R2: pokud presigner hoistne x-amz-meta-* do query stringu presignované
  // URL a browser stejný header zároveň pošle jako skutečný HTTP header, R2 vrátí
  // 403 SignatureDoesNotMatch. Proto command nesmí obsahovat Metadata a query string ani
  // vrácené headers nesmí x-amz-meta-* obsahovat.
  assert.equal(url.searchParams.has("x-amz-meta-original-file-name"), false, "presigned URL nesmí hoistovat x-amz-meta do query stringu, jinak R2 vrátí SignatureDoesNotMatch, pošle-li browser stejný header");
  assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "host", "SignedHeaders nesmí obsahovat header, který browser PUT nepošle");
  assert.deepEqual(new Set(Object.keys(upload.headers)), new Set(["Content-Type"]), "vrácené headers musí přesně odpovídat tomu, co browser XHR PUT skutečně odešle");
  assert.equal(upload.headers["Content-Type"], "image/png", "Content-Type vrácený klientovi musí odpovídat mimeType z presign requestu");
});

test("R2 provider presignuje GetObject a HEAD metadata nevrací obsah", async () => {
  const sent: unknown[] = [];
  const client = { send: async (command: unknown) => { sent.push(command); return command instanceof HeadObjectCommand ? { ContentType: "image/png", ContentLength: 42, ETag: "etag" } : {}; } };
  const signed: unknown[] = [];
  const provider = new CloudflareR2StorageProvider(r2Config, client as never, async (_client, command) => { signed.push(command); return "https://signed.example/download"; });
  assert.equal(await provider.getDownloadUrl("events/event/logo/id.png"), "https://signed.example/download");
  assert.ok(signed[0] instanceof GetObjectCommand);
  assert.equal((await provider.getMetadata("events/event/logo/id.png"))?.contentLength, 42);
  assert.ok(sent[0] instanceof HeadObjectCommand);
});

test("provider a API response nepropustí access key ani secret", async () => {
  const provider = new CloudflareR2StorageProvider(r2Config, { send: async () => ({}) } as never, async () => "https://signed.example/token");
  const serialized = JSON.stringify(await provider.createUploadUrl({ storageKey: "temporary/test.txt", mimeType: "text/plain", originalFileName: "test.txt" }));
  assert.equal(serialized.includes(r2Config.accessKeyId), false);
  assert.equal(serialized.includes(r2Config.secretAccessKey), false);
});

test("event logo, cover a dokument ukládají persistentní storage metadata", async () => {
  const logo = asset("logo", "events/event/logo/logo.png", "image/png", "logo.png", "event-logo");
  const cover = asset("cover", "events/event/cover/cover.webp", "image/webp", "cover.webp", "event-cover");
  const document = createEventDocumentFromAsset(asset("doc", "events/event/documents/manual.pdf", "application/pdf", "manual.pdf", "event-document"), { category: "manual", language: "cs" });
  const storage = new MemoryStorage();
  const repository = new LocalEventRepository(storage);
  await repository.save(normalizeExhibition({ id: "event", slug: "event", logoUrl: "", coverImageUrl: "", logoAsset: logo, coverImageAsset: cover, documents: [document] }));
  const reloaded = (await repository.list())[0]!;
  assert.equal(reloaded.logoAsset?.storageKey, logo.storageKey);
  assert.equal(reloaded.coverImageAsset?.storageKey, cover.storageKey);
  assert.equal(reloaded.documents[0]?.storageKey, document.storageKey);
  assert.equal(reloaded.documents[0]?.title, "manual");
  assert.equal(reloaded.documents[0]?.language, "cs");
});

test("M57 resolver preferuje R2 asset, zachová static URL a missing fallback", () => {
  assert.equal(catalogImageAsset(componentCatalog.chair)?.storageKey, "catalog/furniture/M57/photos/photo.jpg");
  assert.deepEqual(preferredAsset(catalogImageAsset(componentCatalog.chair), componentCatalog.chair.photoUrl), { storageKey: "catalog/furniture/M57/photos/photo.jpg", legacyUrl: "/models/chairs/M57/photo.jpg" });
  assert.equal(catalogImageUrl(componentCatalog.chair), "/models/chairs/M57/photo.jpg");
  assert.equal(catalogImageUrl({}), undefined);
});

test("presign route odmítne nepřihlášený request před vytvořením provideru", async () => {
  let providerCreated = false;
  const response = await handleAssetPresign(new NextRequest("http://localhost/api/assets/presign", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } }), () => { providerCreated = true; throw new Error("must not run"); });
  assert.equal(response.status, 401);
  assert.equal(providerCreated, false);
});

test("presign route s platnou session odmítne MIME a velikost bez volání R2", async () => {
  const secret = "test-session-secret-with-at-least-32-characters";
  process.env.APP_SESSION_SECRET = secret;
  const token = await createSessionToken(secret);
  let calls = 0;
  const provider = mockProvider(() => { calls += 1; });
  const request = authenticatedRequest(token, { category: "event-logo", ownerId: "event", originalFileName: "logo.png", mimeType: "image/png", size: 6_000_000 });
  const response = await handleAssetPresign(request, () => provider);
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

test("delete API chrání referencované cesty a fyzicky maže jen temporary prefix", async () => {
  const secret = "delete-session-secret-with-at-least-32-characters";
  process.env.APP_SESSION_SECRET = secret;
  const token = await createSessionToken(secret);
  let deleted = "";
  const provider = mockProvider(undefined, (key) => { deleted = key; });
  const protectedResponse = await handleAssetDelete(authenticatedRequest(token, { storageKey: "events/event/logo/id.png" }, "DELETE"), () => provider);
  assert.equal((await protectedResponse.json()).reason, "reference-safety");
  assert.equal(deleted, "");
  const temporaryResponse = await handleAssetDelete(authenticatedRequest(token, { storageKey: "temporary/storage-smoke-test/file.txt" }, "DELETE"), () => provider);
  assert.equal((await temporaryResponse.json()).deleted, true);
  assert.equal(deleted, "temporary/storage-smoke-test/file.txt");
});

test("starý event a projekt bez storageKey se otevřou s legacy fallbacky", () => {
  const event = normalizeExhibition({ id: "legacy", logoUrl: "/legacy/logo.png", coverImageUrl: "blob:cover", documents: [{ id: "doc", fileName: "old.pdf", assetUrl: "blob:old", mimeType: "application/pdf", availability: "temporary-session", title: "Old", category: "other", active: true }] });
  const project = normalizeProjectRecord({ id: "legacy-project", graphicsFiles: [{ id: "graphic", name: "old.pdf", size: 10, mimeType: "application/pdf", availability: "temporary-session", storageUrl: "blob:old" }] });
  assert.equal(event.logoUrl, "/legacy/logo.png");
  assert.equal(event.documents[0]?.storageKey, undefined);
  assert.equal(project.graphicsFiles[0]?.storageKey, undefined);
});

function asset(id: string, storageKey: string, mimeType: string, originalFileName: string, category: StoredAsset["category"]): StoredAsset {
  return { id, storageKey, mimeType, originalFileName, category, size: 42, createdAt: "2026-08-12T10:00:00.000Z" };
}

function authenticatedRequest(token: string, body: unknown, method = "POST") {
  return new NextRequest("http://localhost/api/assets", { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json", Cookie: `homeworkstudio_session=${token}` } });
}

function mockProvider(onUpload?: () => void, onDelete?: (key: string) => void): AssetStorageProvider {
  return {
    id: "mock",
    async createUploadUrl() { onUpload?.(); return { uploadUrl: "https://signed.example", method: "PUT", headers: {}, expiresAt: new Date().toISOString() }; },
    async getDownloadUrl() { return "https://signed.example"; },
    async deleteObject(key) { onDelete?.(key); },
    async objectExists() { return true; },
    async getMetadata(key) { return { storageKey: key }; },
  };
}

class MemoryStorage implements KeyValueStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
