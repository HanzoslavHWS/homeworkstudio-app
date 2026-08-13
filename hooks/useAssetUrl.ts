"use client";

import { useEffect, useState } from "react";
import type { StoredAsset } from "../domain/assets.ts";
import { getAssetDownloadUrl } from "../lib/storage/assetClient.ts";

export function useAssetUrl(asset: StoredAsset | undefined, legacyUrl?: string): Readonly<{ url?: string; loading: boolean; error?: string }> {
  const [resolved, setResolved] = useState<Readonly<{ url?: string; loading: boolean; error?: string }>>({ url: legacyUrl, loading: Boolean(asset?.storageKey) });
  useEffect(() => {
    let active = true;
    if (!asset?.storageKey) { setResolved({ url: legacyUrl, loading: false }); return; }
    setResolved({ url: legacyUrl, loading: true });
    getAssetDownloadUrl(asset.storageKey)
      .then((url) => active && setResolved({ url, loading: false }))
      .catch((error) => active && setResolved({ url: legacyUrl, loading: false, error: error instanceof Error ? error.message : "Asset není dostupný." }));
    return () => { active = false; };
  }, [asset?.storageKey, legacyUrl]);
  return resolved;
}
