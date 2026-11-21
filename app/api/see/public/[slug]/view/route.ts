import type { NextRequest } from "next/server.js";
import { createSeeDeps, type SeeDeps } from "../../../../../../lib/see/backend.server.ts";
import { grantTokens, seeErrorResponse, seeJson } from "../../../../../../lib/see/http.server.ts";
import { clientIp } from "../../../../../../lib/see/security.server.ts";
import { recordPublicView } from "../../../../../../lib/see/service.server.ts";

type Params = Readonly<{ slug: string }>;

/** PUBLIC. One real open of an accessible presentation (bots/prefetch/refresh-within-30-min skipped). */
export async function handleSeePublicView(request: NextRequest, params: Params, depsFactory: () => SeeDeps = createSeeDeps) {
  try {
    let embed = false;
    try {
      embed = ((await request.json()) as { embed?: unknown })?.embed === true;
    } catch {
      embed = false;
    }
    const result = await recordPublicView(depsFactory(), params.slug, grantTokens(request), request.headers, clientIp(request.headers), embed);
    return seeJson({ counted: result.counted }, result.status, true);
  } catch (error) {
    return seeErrorResponse(error, true);
  }
}

export async function POST(request: NextRequest, context: { params: Promise<Params> }) {
  return handleSeePublicView(request, await context.params);
}
