/**
 * HWS SEE rules for proxy.ts. Pure (no Node APIs) so it is safe in the proxy runtime and testable.
 *
 * The portal proxy protects EVERYTHING by the session cookie. HWS SEE adds exactly these public
 * exceptions — each still enforces publication state / PIN on the server:
 *   /see/p/<slug>              customer presentation page (shell only; data comes from the API)
 *   /see/embed/<slug>          iframe variant
 *   /api/see/public/<slug>/…   manifest, PIN unlock, per-file authorization, view counter
 *   /api/see/content           short-lived signed ticket delivery (capability URL)
 *   /see/draco/…, /see/basis/… static Draco decoder and KTX2 (Basis) transcoder files (no data)
 * Everything else under /see and /api/see (editor, projects, uploads) keeps the portal login.
 */

import { globalFrameAncestors } from "../../domain/seeEmbed.ts";

const SLUG = "[A-Za-z0-9]{24,64}";
const PUBLIC_PAGE = new RegExp(`^/see/p/${SLUG}/?$`, "u");
const EMBED_PAGE = new RegExp(`^/see/embed/${SLUG}/?$`, "u");
const PUBLIC_API = new RegExp(`^/api/see/public/${SLUG}(/(unlock|view|files/[0-9a-fA-F-]{36}))?/?$`, "u");
/** Self-hosted three.js decoders (public/see/draco, public/see/basis), needed by the public viewer. */
const DECODER_ASSET = /^\/see\/(draco\/(draco_wasm_wrapper\.js|draco_decoder\.wasm)|basis\/(basis_transcoder\.js|basis_transcoder\.wasm))$/u;

export type SeePublicRouteKind = "page" | "embed" | "api" | "content" | "asset";

export function seePublicRouteKind(pathname: string): SeePublicRouteKind | undefined {
  if (PUBLIC_PAGE.test(pathname)) return "page";
  if (EMBED_PAGE.test(pathname)) return "embed";
  if (PUBLIC_API.test(pathname)) return "api";
  if (pathname === "/api/see/content") return "content";
  if (DECODER_ASSET.test(pathname)) return "asset";
  return undefined;
}

export function isSeeEditorPath(pathname: string): boolean {
  return pathname === "/see" || pathname.startsWith("/see/") || pathname.startsWith("/api/see/");
}

/**
 * SEE_EMBED_FRAME_ANCESTORS: space-separated CSP sources allowed to embed /see/embed/* when a
 * publication uses the default policy (e.g. "https://www.homeworkstudio.cz https://*.zakaznik.cz").
 * Default: any HTTPS site. A publication can narrow it to its own list or forbid embedding
 * (domain/seeEmbed.ts, resolved per request in lib/see/embedPolicy.server.ts).
 */
export const embedFrameAncestors = globalFrameAncestors;

/** The share slug of an embed path (for the per-publication policy lookup). */
export function embedSlug(pathname: string): string | undefined {
  return EMBED_PAGE.test(pathname) ? pathname.split("/")[3] : undefined;
}

/** Headers for HWS SEE responses; undefined for every non-SEE path (ABF/Easy are untouched). */
export function seeResponseHeaders(
  pathname: string,
  environment: Readonly<{ SEE_EMBED_FRAME_ANCESTORS?: string }>,
  embedFrameAncestorsValue?: string,
): Readonly<Record<string, string>> | undefined {
  if (!isSeeEditorPath(pathname)) return undefined;
  const kind = seePublicRouteKind(pathname);
  if (kind === "embed") {
    return {
      "Content-Security-Policy": `frame-ancestors ${embedFrameAncestorsValue ?? globalFrameAncestors(environment.SEE_EMBED_FRAME_ANCESTORS)}`,
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      "Referrer-Policy": "no-referrer",
    };
  }
  if (kind === "content") {
    // Delivered uploads: never an active document of the portal origin, never framed. (Proxy
    // headers win over route headers, so the full policy must be set here.)
    return {
      "Content-Security-Policy": "default-src 'none'; sandbox; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      "Referrer-Policy": "no-referrer",
    };
  }
  if (kind) {
    return {
      "Content-Security-Policy": "frame-ancestors 'self'",
      "X-Frame-Options": "SAMEORIGIN",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      "Referrer-Policy": "no-referrer",
    };
  }
  // Administration is never framed (clickjacking) and never indexed.
  return {
    "Content-Security-Policy": "frame-ancestors 'none'",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow",
  };
}
