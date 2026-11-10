"use client";

import { useState, type DragEvent } from "react";
import {
  BATCH_TARGET_LABELS_CS,
  batchTargetCategory,
  batchUploadMimeType,
  buildBatchCardEdit,
  changeBatchTarget,
  planBatchUpload,
  type BatchCardEdit,
  type BatchPlanRow,
  type BatchUploaded,
} from "../../domain/catalogBatchUpload";
import type { StoredAsset } from "../../domain/assets";
import { uploadAsset } from "../../lib/storage/assetClient";
import { NativeSelect } from "@/components/ui/native-select";
import { Button } from "@/components/ui/button";

const BATCH_ACCEPT = ".jpg,.jpeg,.png,.webp,.glb,.skp,.dwg,.dxf,.pdf";

type RowState = Readonly<{ state: "waiting" | "uploading" | "done" | "failed" | "skipped"; percent: number; message?: string }>;

function formatSize(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toLocaleString("cs-CZ", { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(bytes / 1000)).toLocaleString("cs-CZ")} kB`;
}

/**
 * "Nahrát více souborů" on a SAVED catalog card (a card exists in the database from the moment it is
 * created, so its id is the upload owner). Files upload one by one through the existing R2 upload
 * API; a failed file never cancels the others. Everything that uploaded is then added to the card in
 * ONE save (existing files stay). Unsaved changes in the card's form fields are not touched.
 */
export function CatalogBatchUpload({
  ownerId,
  hasMainPhoto,
  hasModel,
  modelAllowed,
  cadAllowed,
  documentsAllowed,
  currentMainPhoto,
  formDirty,
  onSave,
}: {
  ownerId: string;
  hasMainPhoto: boolean;
  hasModel: boolean;
  /** The card's current mode (3D on → GLB; CAD sources shown; documents shown). Files the mode doesn't use are offered only as "Nenahrávat". */
  modelAllowed: boolean;
  cadAllowed: boolean;
  documentsAllowed: boolean;
  currentMainPhoto: StoredAsset | undefined;
  formDirty: boolean;
  onSave: (edit: BatchCardEdit) => Promise<void>;
}) {
  const [files, setFiles] = useState<readonly File[]>([]);
  const [rows, setRows] = useState<readonly BatchPlanRow[]>([]);
  const [states, setStates] = useState<readonly RowState[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [result, setResult] = useState<Readonly<{ ok?: string; error?: string }>>({});

  function select(selected: readonly File[]) {
    if (busy || selected.length === 0) return;
    setFiles(selected);
    setRows(planBatchUpload(selected.map((file) => ({ name: file.name, size: file.size })), { hasMainPhoto, hasModel, modelAllowed, cadAllowed, documentsAllowed }));
    setStates(selected.map(() => ({ state: "waiting", percent: 0 })));
    setResult({});
  }

  function reset() {
    setFiles([]);
    setRows([]);
    setStates([]);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOver(false);
    select(Array.from(event.dataTransfer.files));
  }

  const toUpload = rows.filter((row) => row.target !== "skip").length;
  const replacesModel = hasModel && rows.some((row) => row.target === "model_active");
  const replacesMainPhoto = hasMainPhoto && rows.some((row) => row.target === "photo_main");

  async function confirm() {
    if (replacesModel && !window.confirm("Aktivní 3D model karty bude nahrazen vybraným GLB. Pokračovat?")) return;
    setBusy(true);
    setResult({});
    const uploaded: BatchUploaded[] = [];
    const setRowState = (index: number, state: RowState) => setStates((current) => current.map((candidate, candidateIndex) => (candidateIndex === index ? state : candidate)));
    for (const [index, row] of rows.entries()) {
      const category = batchTargetCategory(row.target);
      if (!category) {
        setRowState(index, { state: "skipped", percent: 0, ...(row.error ? { message: row.error } : {}) });
        continue;
      }
      const mimeType = batchUploadMimeType(row.target, row.fileName);
      try {
        const asset = await uploadAsset(files[index]!, { category, ownerId, ...(mimeType ? { mimeType } : {}) }, (progress) => setRowState(index, { state: "uploading", percent: progress.percent }));
        uploaded.push({ target: row.target, asset });
        setRowState(index, { state: "done", percent: 100 });
      } catch (error) {
        setRowState(index, { state: "failed", percent: 0, message: error instanceof Error ? error.message : "Nahrání selhalo." });
      }
    }
    if (uploaded.length === 0) {
      setResult({ error: "Žádný soubor se nenahrál — karta zůstala beze změny." });
      setBusy(false);
      return;
    }
    try {
      await onSave(buildBatchCardEdit(uploaded, currentMainPhoto));
      const failed = rows.length - uploaded.length - rows.filter((row) => row.target === "skip").length;
      setResult({ ok: `Ke kartě přidáno ${uploaded.length} ${uploaded.length === 1 ? "soubor" : uploaded.length < 5 ? "soubory" : "souborů"}.${failed > 0 ? ` ${failed} se nenahrál(o) — viz chyby v seznamu.` : ""}` });
    } catch (error) {
      setResult({ error: `Soubory jsou nahrané v úložišti, ale kartu se nepodařilo uložit: ${error instanceof Error ? error.message : "neznámá chyba"}. Karta zůstala beze změny; zkuste to znovu po obnovení stránky.` });
    } finally {
      setBusy(false);
    }
  }

  const finished = states.length > 0 && states.every((state) => state.state !== "waiting" && state.state !== "uploading");

  return (
    <section className="catalogDetailSection catalogBatchUpload">
      <h3>Soubory karty</h3>
      <div
        className={`catalogBatchDrop${dragOver ? " active" : ""}`}
        onDragOver={(event) => { event.preventDefault(); if (!busy) setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <label className={`primaryButton catalogBatchButton${busy ? " disabled" : ""}`}>
          Nahrát více souborů
          <input type="file" multiple accept={BATCH_ACCEPT} disabled={busy} onChange={(event) => { const selected = Array.from(event.target.files ?? []); event.target.value = ""; select(selected); }} />
        </label>
        <span className="fieldHint">nebo soubory přetáhněte sem · JPG, PNG, WebP → fotografie{modelAllowed ? " · GLB → 3D model" : ""}{cadAllowed ? " · SKP, DWG, DXF → podklady" : ""}{documentsAllowed ? " · PDF → technický list / dokumentace" : ""}</span>
      </div>

      {rows.length > 0 && (
        <>
          <table className="catalogBatchTable">
            <thead><tr><th>Soubor</th><th>Zařazení</th><th>Stav</th></tr></thead>
            <tbody>
              {rows.map((row, index) => {
                const state = states[index];
                return (
                  <tr key={`${row.fileName}-${index}`} className={row.error || state?.state === "failed" ? "error" : undefined}>
                    <td><strong>{row.fileName}</strong><small> {formatSize(row.size)}</small></td>
                    <td>
                      {row.options.length > 0 ? (
                        <NativeSelect value={row.target} disabled={busy || finished} onChange={(event) => setRows((current) => changeBatchTarget(current, index, event.target.value as BatchPlanRow["target"]))}>
                          {row.options.map((option) => <option key={option} value={option}>{BATCH_TARGET_LABELS_CS[option]}</option>)}
                        </NativeSelect>
                      ) : <span className="uploadError">{row.error}</span>}
                      {row.note && <small className="fieldHint">{row.note}</small>}
                    </td>
                    <td>
                      {state?.state === "uploading" && <progress max="100" value={state.percent} />}
                      {state?.state === "waiting" && (row.target === "skip" ? "nenahraje se" : "čeká")}
                      {state?.state === "done" && <span className="saveOk">nahráno</span>}
                      {state?.state === "skipped" && "vynecháno"}
                      {state?.state === "failed" && <span className="uploadError">{state.message}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {replacesMainPhoto && !finished && <p className="fieldHint">Nová hlavní fotografie: dosavadní hlavní fotografie se přesune do galerie (nic se neodstraní).</p>}
          {replacesModel && !finished && <p className="fieldHint">Vybraný GLB nahradí aktivní 3D model generátoru (původní soubor zůstane v úložišti).</p>}
          {formDirty && !finished && <p className="fieldHint">Rozpracované změny polí karty se nahráním neuloží ani neztratí — uložte je potom tlačítkem Uložit.</p>}
          <div className="assetActions">
            {!finished && <Button variant="default" type="button" disabled={busy || toUpload === 0} onClick={() => void confirm()}>{busy ? "Nahrávám…" : `Nahrát ${toUpload} ${toUpload === 1 ? "soubor" : toUpload < 5 ? "soubory" : "souborů"}`}</Button>}
            <Button variant="outline" type="button" disabled={busy} onClick={reset}>{finished ? "Zavřít přehled" : "Zrušit"}</Button>
          </div>
        </>
      )}
      {result.ok && <p className="saveOk">{result.ok}</p>}
      {result.error && <p className="uploadError">{result.error}</p>}
    </section>
  );
}
