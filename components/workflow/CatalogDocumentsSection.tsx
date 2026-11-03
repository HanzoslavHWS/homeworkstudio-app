"use client";

import { useState } from "react";
import type { SourceAssetEntry, StoredAsset } from "../../domain/assets";
import type { CatalogItemAdminEdit } from "../../domain/catalogItemsAdmin";
import { getAssetDownloadUrl, uploadAsset, type UploadProgress } from "../../lib/storage/assetClient";

async function openAsset(asset: StoredAsset, onError: (message: string) => void) {
  try {
    window.open(await getAssetDownloadUrl(asset.storageKey, asset.originalFileName), "_blank", "noopener");
  } catch (error) {
    onError(error instanceof Error ? error.message : "Soubor se nepodařilo otevřít.");
  }
}

/**
 * "Technický list / dokumentace" — PDF documents of a card. No new document model: they are the
 * card's existing source-file entries of kind "pdf" (category catalog-source), uploaded through the
 * existing R2 upload. Never required for activation. Removing = metadata only, the R2 object stays.
 */
export function CatalogDocumentsSection({ entries, ownerId, onSave }: { entries: readonly SourceAssetEntry[]; ownerId: string; onSave: (edit: CatalogItemAdminEdit) => Promise<void> }) {
  const [progress, setProgress] = useState<UploadProgress | undefined>();
  const [busyId, setBusyId] = useState<string | undefined>();
  const [error, setError] = useState("");

  async function upload(file: File, replacing?: SourceAssetEntry) {
    setError("");
    if (!file.name.toLowerCase().endsWith(".pdf") || file.size === 0) {
      setError("Technický list musí být neprázdný soubor PDF.");
      return;
    }
    setBusyId(replacing?.id ?? "new");
    try {
      const asset = await uploadAsset(file, { category: "catalog-source", ownerId, mimeType: "application/pdf" }, setProgress);
      // Replace = add the new entry and drop the old reference in ONE save (the old object stays in R2).
      await onSave({ addSourceAsset: { kind: "pdf", asset }, ...(replacing ? { removeSourceAssetId: replacing.id } : {}) });
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Nahrání PDF selhalo.");
    } finally {
      setBusyId(undefined);
    }
  }

  async function remove(entry: SourceAssetEntry) {
    setError("");
    setBusyId(entry.id);
    try {
      await onSave({ removeSourceAssetId: entry.id });
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Odebrání selhalo.");
    } finally {
      setBusyId(undefined);
    }
  }

  return (
    <section className="catalogDetailSection">
      <h3>Technický list / dokumentace</h3>
      {entries.length === 0 && <p className="fieldHint">Zatím žádný dokument. PDF je volitelné — aktivaci neblokuje.</p>}
      {entries.length > 0 && (
        <ul className="sourceAssetList">
          {entries.map((entry) => (
            <li key={entry.id} className="sourceAssetListItem">
              <span className="sourceAssetKindBadge">PDF</span>
              <span>{entry.label || entry.asset.originalFileName}</span>
              <button type="button" className="linkButton" onClick={() => void openAsset(entry.asset, setError)}>Otevřít</button>
              <label className="smallUploadButton">
                {busyId === entry.id ? "Nahrávám…" : "Nahradit"}
                <input type="file" accept="application/pdf,.pdf" disabled={Boolean(busyId)} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file, entry); }} />
              </label>
              <button type="button" className="dangerText" disabled={Boolean(busyId)} onClick={() => void remove(entry)}>Odebrat referenci</button>
            </li>
          ))}
        </ul>
      )}
      <div className="assetActions">
        <label className="smallUploadButton">
          {busyId === "new" ? "Nahrávám…" : "Nahrát PDF"}
          <input type="file" accept="application/pdf,.pdf" disabled={Boolean(busyId)} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} />
        </label>
      </div>
      {progress && busyId && (
        <div className={`assetUploadState ${progress.state}`}>
          <progress max="100" value={progress.percent} />
          <span>{progress.state === "uploading" ? `Nahrávám ${progress.percent} %` : progress.state === "success" ? "Nahráno do R2" : progress.message}</span>
        </div>
      )}
      {error && <small className="uploadError">{error}</small>}
    </section>
  );
}

/**
 * Files the card keeps although its current mode hides their upload sections (3D off → active GLB;
 * a service / point without 3D → SKP/DWG/DXF). Nothing is deleted by switching a mode; they stay
 * listed and openable here, and come back in their own sections when the mode is switched back.
 */
export function CatalogHiddenAttachments({ model, sources }: { model?: Readonly<{ fileName: string; asset?: StoredAsset }>; sources: readonly SourceAssetEntry[] }) {
  const [error, setError] = useState("");
  if (!model && sources.length === 0) return null;
  return (
    <section className="catalogDetailSection">
      <h3>Uložené přílohy mimo aktuální režim</h3>
      <p className="fieldHint">Tyto soubory karta má uložené, ale v aktuálním nastavení (bez 3D / bez CAD podkladů) je nepoužívá. Nic se nesmazalo; po zapnutí 3D se vrátí do svých sekcí.</p>
      <ul className="sourceAssetList">
        {model && (
          <li className="sourceAssetListItem">
            <span className="sourceAssetKindBadge">GLB</span>
            <span>{model.fileName}</span>
            {model.asset && <button type="button" className="linkButton" onClick={() => void openAsset(model.asset!, setError)}>Otevřít</button>}
          </li>
        )}
        {sources.map((entry) => (
          <li key={entry.id} className="sourceAssetListItem">
            <span className="sourceAssetKindBadge">{entry.kind.toUpperCase()}</span>
            <span>{entry.label || entry.asset.originalFileName}</span>
            <button type="button" className="linkButton" onClick={() => void openAsset(entry.asset, setError)}>Otevřít</button>
          </li>
        ))}
      </ul>
      {error && <small className="uploadError">{error}</small>}
    </section>
  );
}
