import { frameAncestorsFor } from "../../domain/seeEmbed.ts";
import { isValidShareSlug } from "../../domain/seeProject.ts";
import { createSeeDeps } from "./backend.server.ts";

/**
 * CSP frame-ancestors for /see/embed/<slug>, resolved per publication on every request (proxy.ts
 * runs in the Node.js runtime in Next 16). Unknown slug or an unavailable database falls back to the
 * global policy: the page then only shows "neexistuje" / an error, never content.
 */
export async function embedFrameAncestorsForSlug(slug: string, environment: Readonly<Record<string, string | undefined>> = process.env): Promise<string> {
  if (!isValidShareSlug(slug)) return frameAncestorsFor(undefined, environment.SEE_EMBED_FRAME_ANCESTORS);
  try {
    const publication = await createSeeDeps(environment).repository.getPublicationBySlug(slug);
    return frameAncestorsFor(publication, environment.SEE_EMBED_FRAME_ANCESTORS);
  } catch {
    return frameAncestorsFor(undefined, environment.SEE_EMBED_FRAME_ANCESTORS);
  }
}
