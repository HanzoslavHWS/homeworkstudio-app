import path from "node:path";
import { readSeeUploadLimits, type SeeUploadLimits } from "../../domain/seeFiles.ts";
import { createSupabaseServerClient } from "../db/supabase.server.ts";
import type { SeeRepository } from "./repository.ts";
import { MemorySeeRepository } from "./repository.memory.ts";
import { SupabaseSeeRepository } from "./repository.supabase.ts";
import { LocalDiskSeeObjectStorage, R2SeeObjectStorage, type SeeObjectStorage } from "./storage.server.ts";

/**
 * signed-url  short presigned R2 GET (default; scales, no function egress)
 * stream      bytes through /api/see/content, re-authorized at start and every few seconds
 * hybrid      documents streamed (immediate cut-off), models as signed URLs (large files)
 */
export type SeeDeliveryMode = "signed-url" | "stream" | "hybrid";

export type SeeDeps = Readonly<{
  repository: SeeRepository;
  storage: SeeObjectStorage;
  /** APP_SESSION_SECRET — keys for tickets and hashed client/visitor ids are derived from it. */
  secret: string | undefined;
  now: () => Date;
  limits: SeeUploadLimits;
  backend: "supabase" | "local";
  delivery: SeeDeliveryMode;
  /** Lifetime of a signed GET URL / content ticket (seconds). */
  fileUrlTtlSeconds: number;
  /**
   * On every access-tightening event (unpublish, new PIN, link rotation, pause …) copy the
   * published objects to new opaque keys and delete the old ones, so already issued signed URLs
   * stop working immediately instead of expiring after fileUrlTtlSeconds.
   */
  rekeyOnRevoke: boolean;
  /** Stream delivery re-checks the authorization this often while bytes flow (ms). */
  streamRecheckMs: number;
  uploadUrlTtlSeconds: number;
  grantTtlMinutes: number;
  pinIterations?: number;
  /** Extra delay after a wrong PIN (ms); tests pass 0. */
  failedPinDelayMs: number;
  /** Whether cookies get Secure / SameSite=None; Partitioned (https). */
  secureCookies: boolean;
  /** http://localhost links in annotations / info panel — only for local development, never in production. */
  allowLocalHttpLinks?: boolean;
}>;

type SeeEnvironment = Readonly<Record<string, string | undefined>>;

function boundedNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
}

/**
 * SEE_BACKEND=local is an explicit DEVELOPMENT mode (data + files in the git-ignored `.see-local/`
 * folder, nothing leaves the machine). It is refused in production builds, so a forgotten variable
 * can never turn production into a local-disk fake.
 */
export function isLocalSeeBackend(environment: SeeEnvironment = process.env): boolean {
  return environment.SEE_BACKEND === "local" && environment.NODE_ENV !== "production";
}

const globalCache = globalThis as typeof globalThis & { __hwsSeeLocalRepository?: MemorySeeRepository };

export function createSeeDeps(environment: SeeEnvironment = process.env): SeeDeps {
  const local = isLocalSeeBackend(environment);
  const secret = environment.APP_SESSION_SECRET;
  const common = {
    secret,
    now: () => new Date(),
    limits: readSeeUploadLimits(environment),
    fileUrlTtlSeconds: boundedNumber(environment.SEE_FILE_URL_TTL_SECONDS, 60, 30, 300),
    uploadUrlTtlSeconds: 900,
    grantTtlMinutes: boundedNumber(environment.SEE_PIN_GRANT_TTL_MINUTES, 120, 5, 720),
    failedPinDelayMs: 400,
    rekeyOnRevoke: environment.SEE_REKEY_ON_REVOKE !== "false",
    streamRecheckMs: 3000,
    secureCookies: environment.NODE_ENV === "production",
    allowLocalHttpLinks: environment.NODE_ENV !== "production",
  };
  if (local) {
    // Local dev data only: excluded from output file tracing, so a deployment never bundles the
    // project tree (or .see-local/) into the server functions.
    const root = path.resolve(/* turbopackIgnore: true */ environment.SEE_LOCAL_DIR || ".see-local");
    globalCache.__hwsSeeLocalRepository ??= new MemorySeeRepository({ persistFile: path.join(root, "db.json") });
    return {
      ...common,
      repository: globalCache.__hwsSeeLocalRepository,
      storage: new LocalDiskSeeObjectStorage(path.join(root, "objects"), secret),
      backend: "local",
      delivery: "stream",
    };
  }
  return {
    ...common,
    repository: new SupabaseSeeRepository(createSupabaseServerClient({ SUPABASE_URL: environment.SUPABASE_URL, SUPABASE_SECRET_KEY: environment.SUPABASE_SECRET_KEY })),
    storage: new R2SeeObjectStorage(environment),
    backend: "supabase",
    delivery: environment.SEE_FILE_DELIVERY === "stream" || environment.SEE_FILE_DELIVERY === "hybrid" ? environment.SEE_FILE_DELIVERY : "signed-url",
  };
}
