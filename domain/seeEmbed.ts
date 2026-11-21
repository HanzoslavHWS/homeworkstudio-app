/**
 * HWS SEE embed (iframe) policy per publication. Pure — used by the editor API, the service and
 * proxy.ts (CSP `frame-ancestors` of /see/embed/<slug>).
 *
 *   default    the global policy (SEE_EMBED_FRAME_ANCESTORS, otherwise any HTTPS site)
 *   allowlist  only the listed sites (plus the portal itself)
 *   none       the presentation cannot be embedded anywhere (the share link still works)
 *
 * This only controls FRAMING. It is not access control — the share link (and the PIN in `pin`
 * mode) remains the actual protection of the content.
 */
import { SeeValidationError } from "./seeProject.ts";

export const SEE_EMBED_POLICIES = ["default", "allowlist", "none"] as const;
export type SeeEmbedPolicy = (typeof SEE_EMBED_POLICIES)[number];

export const SEE_EMBED_POLICY_LABELS_CS: Readonly<Record<SeeEmbedPolicy, string>> = {
  default: "Výchozí politika portálu",
  allowlist: "Jen na vybraných webech",
  none: "Vkládání zakázáno",
};

export const SEE_MAX_EMBED_ORIGINS = 20;

/** `https://host[:port]`, `https://*.host`, and plain-HTTP localhost for local testing. No paths. */
const ORIGIN_PATTERN = /^(https:\/\/(\*\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(:\d{1,5})?|https?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?)$/u;

export function isValidEmbedOrigin(value: string): boolean {
  return ORIGIN_PATTERN.test(value);
}

/** Editor input (one origin per line / comma / space) → normalized list, or a Czech error. */
export function parseEmbedOrigins(input: unknown): readonly string[] {
  const raw = Array.isArray(input) ? input.map(String) : typeof input === "string" ? input.split(/[\s,;]+/u) : [];
  const origins: string[] = [];
  for (const entry of raw) {
    const value = entry.trim().toLowerCase().replace(/\/+$/u, "");
    if (!value) continue;
    if (!isValidEmbedOrigin(value)) {
      throw new SeeValidationError(`„${entry.trim().slice(0, 80)}“ není platná adresa webu. Použijte tvar https://www.example.cz nebo https://*.example.cz (bez cesty).`);
    }
    if (!origins.includes(value)) origins.push(value);
  }
  if (origins.length > SEE_MAX_EMBED_ORIGINS) throw new SeeValidationError(`Nejvýše ${SEE_MAX_EMBED_ORIGINS} povolených webů.`);
  return origins;
}

export function isSeeEmbedPolicy(value: unknown): value is SeeEmbedPolicy {
  return (SEE_EMBED_POLICIES as readonly unknown[]).includes(value);
}

const DEFAULT_FRAME_ANCESTORS = "'self' https:";

/**
 * Global policy from SEE_EMBED_FRAME_ANCESTORS (space separated CSP sources); invalid tokens are
 * dropped, so a typo never widens the policy beyond what is listed.
 */
export function globalFrameAncestors(value: string | undefined): string {
  const sources = (value ?? "").split(/\s+/u).filter((source) => source === "'self'" || source === "https:" || isValidEmbedOrigin(source.toLowerCase()));
  return sources.length ? sources.join(" ") : DEFAULT_FRAME_ANCESTORS;
}

/** The CSP frame-ancestors value for one publication. */
export function frameAncestorsFor(policy: Readonly<{ embedPolicy: SeeEmbedPolicy; embedOrigins: readonly string[] }> | undefined, globalValue: string | undefined): string {
  if (!policy || policy.embedPolicy === "default") return globalFrameAncestors(globalValue);
  if (policy.embedPolicy === "none") return "'none'";
  const origins = policy.embedOrigins.filter(isValidEmbedOrigin);
  return origins.length ? `'self' ${origins.join(" ")}` : "'none'";
}
