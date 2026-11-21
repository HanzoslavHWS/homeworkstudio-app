import type { Metadata, Viewport } from "next";
import { SeePublicViewer } from "../../../../components/see/SeePublicViewer";

/**
 * PUBLIC customer page (no portal login; proxy.ts exempts only valid-looking share links). Renders
 * just the client shell — publication state, PIN and all data are enforced by /api/see/public/*.
 */
export const metadata: Metadata = {
  title: "3D prezentace | HWS SEE",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

/** Full-bleed on phones with a notch; toolbars respect the safe areas (see.css). */
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default async function SeePublicPage({ params }: Readonly<{ params: Promise<{ slug: string }> }>) {
  const { slug } = await params;
  return <SeePublicViewer slug={slug} />;
}
