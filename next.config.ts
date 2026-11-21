import type { NextConfig } from "next";

/**
 * Only change: hide the round "N" development indicator in `next dev`, so local HWS SEE
 * presentations are not covered by it. Next.js still shows compile and runtime errors; production
 * builds never render the indicator. Everything else keeps the framework defaults.
 */
const nextConfig: NextConfig = {
  devIndicators: false,
};

export default nextConfig;
