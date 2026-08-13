export type R2Environment = Readonly<{
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;
  R2_ENDPOINT?: string;
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

  constructor(missingVariables: readonly string[]) {
    super(`Cloudflare R2 není nakonfigurováno. Chybí: ${missingVariables.join(", ")}.`);
    this.name = "R2ConfigurationError";
    this.missingVariables = missingVariables;
  }
}

export function readR2Config(environment: R2Environment): R2Config {
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
