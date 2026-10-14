import { resolveAppEnvironment } from "../env/supabaseEnvironment.ts";

export type R2Environment = Readonly<{
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;
  R2_ENDPOINT?: string;
  /** DEV / PREVIEW only: the bucket name this environment is allowed to use (docs/DEV_PROD_SETUP.md). */
  R2_EXPECTED_BUCKET?: string;
  NEXT_PUBLIC_APP_ENV?: string;
  NODE_ENV?: string;
}>;

export type R2Config = Readonly<{
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  endpoint: string;
  region: "auto";
}>;

export class R2ConfigurationError extends Error {
  readonly missingVariables: readonly string[];

  constructor(missingVariables: readonly string[], message?: string) {
    super(message ?? `Cloudflare R2 není nakonfigurováno. Chybí: ${missingVariables.join(", ")}.`);
    this.name = "R2ConfigurationError";
    this.missingVariables = missingVariables;
  }
}

/**
 * Outside production, file storage stays OFF unless R2_EXPECTED_BUCKET explicitly names the
 * configured bucket — a dedicated DEV bucket. Without it every upload/download answers 503, so a
 * development machine can never write into (or read from) the production bucket by accident.
 * Production (NEXT_PUBLIC_APP_ENV unset / "production") behaves exactly as before.
 */
export function readR2Config(environment: R2Environment): R2Config {
  const appEnvironment = resolveAppEnvironment(environment);
  if (appEnvironment !== "production") {
    const expected = environment.R2_EXPECTED_BUCKET?.trim();
    const bucket = environment.R2_BUCKET_NAME?.trim();
    if (!expected || expected !== bucket) {
      throw new R2ConfigurationError([], `Nahrávání a stahování souborů je v prostředí ${appEnvironment} vypnuté, dokud nebude nastavený samostatný DEV bucket (R2_BUCKET_NAME = R2_EXPECTED_BUCKET). Produkční úložiště se ve vývoji nepoužívá.`);
    }
  }
  const names = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_ENDPOINT"] as const;
  const missing = names.filter((name) => !environment[name]?.trim());
  if (missing.length) throw new R2ConfigurationError(missing);
  const endpoint = environment.R2_ENDPOINT!.trim().replace(/\/$/u, "");
  if (!/^https:\/\//u.test(endpoint)) throw new Error("R2_ENDPOINT musí být platná HTTPS adresa S3 API.");
  return {
    accountId: environment.R2_ACCOUNT_ID!.trim(),
    accessKeyId: environment.R2_ACCESS_KEY_ID!.trim(),
    secretAccessKey: environment.R2_SECRET_ACCESS_KEY!.trim(),
    bucketName: environment.R2_BUCKET_NAME!.trim(),
    endpoint,
    region: "auto",
  };
}
