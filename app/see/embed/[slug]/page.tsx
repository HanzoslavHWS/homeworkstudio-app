import type { Metadata, Viewport } from "next";
import { SeePublicViewer } from "../../../../components/see/SeePublicViewer";

/**
 * PUBLIC iframe variant: viewer (and the PIN form when protected) only, never any administration.
 * Framing policy: CSP frame-ancestors from SEE_EMBED_FRAME_ANCESTORS (proxy.ts / lib/see/proxyRules.ts).
 */
export const metadata: Metadata = {
  title: "3D prezentace | HWS SEE",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

/** Full-bleed on phones with a notch; toolbars respect the safe areas (see.css). */
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default async function SeeEmbedPage({ params }: Readonly<{ params: Promise<{ slug: string }> }>) {
  const { slug } = await params;
  return <SeePublicViewer slug={slug} embed />;
}
