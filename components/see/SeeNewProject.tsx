"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { SEE_ACCEPT_ATTRIBUTE, seeMimeTypeFor, type SeeUploadLimits } from "../../domain/seeFiles";
import { formatFileSize, SEE_MAX_SCENES } from "../../domain/seeProject";
import { createSeeProject, uploadSeeFile, type SeeUploadProgress } from "../../lib/see/client";
import { useUnsavedChangesGuard } from "./useUnsavedChangesGuard";

type ModelSlot = { name: string; file?: File };
type DocumentDraft = { key: string; file: File; target: "all" | number[] };

const DEFAULT_SLOT_NAMES = ["Zavřená bedna", "Otevřená bedna", "Pohled dovnitř"];

function clientCheck(file: File, kind: "model" | "document", limits: SeeUploadLimits): string | undefined {
  const mime = seeMimeTypeFor(file.name, file.type);
  const allowed = kind === "model" ? ["model/gltf-binary"] : ["application/pdf", "image/jpeg", "image/png"];
  if (!allowed.includes(mime)) return kind === "model" ? "Pouze soubory .glb." : "Pouze PDF, JPG nebo PNG.";
  const max = kind === "model" ? limits.maxModelBytes : limits.maxDocumentBytes;
  if (file.size > max) return `Překračuje limit ${Math.round(max / 1_000_000)} MB.`;
  return undefined;
}

/**
 * "Nový projekt": name + description, up to three independent GLB scenes, any number of documents
 * assigned to "Všechny modely" or chosen models, then "Uložit a otevřít pracovní náhled".
 * The browser checks are only convenience — the server validates every file again.
 */
export function SeeNewProject({ limits }: Readonly<{ limits: SeeUploadLimits }>) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [slots, setSlots] = useState<ModelSlot[]>(DEFAULT_SLOT_NAMES.map(() => ({ name: "" })));
  const [documents, setDocuments] = useState<DocumentDraft[]>([]);
  const [progress, setProgress] = useState<Record<string, SeeUploadProgress>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [createdId, setCreatedId] = useState<string | undefined>();
  const [sceneIdBySlot, setSceneIdBySlot] = useState<Record<number, string>>({});

  // Typed texts and picked files are lost when leaving before "Uložit" — ask first.
  useUnsavedChangesGuard(!createdId && Boolean(name.trim() || description.trim() || slots.some((slot) => slot.file) || documents.length), "Rozpracovaný projekt ještě není uložený. Opravdu chcete stránku opustit?");

  const updateSlot = (index: number, change: Partial<ModelSlot>) => setSlots((current) => current.map((slot, position) => (position === index ? { ...slot, ...change } : slot)));
  const usedSlots = slots.map((slot, index) => ({ ...slot, index })).filter((slot) => slot.file);
  const fileErrors = [
    ...usedSlots.map((slot) => clientCheck(slot.file!, "model", limits)),
    ...documents.map((document) => clientCheck(document.file, "document", limits)),
  ].filter(Boolean);

  const addDocuments = (files: FileList | null) => {
    if (!files) return;
    // Copy now: the caller clears the <input>, which empties this live FileList before React
    // runs the state updater.
    const picked = Array.from(files);
    setDocuments((current) => [...current, ...picked.map((file) => ({ key: `${file.name}-${file.size}-${crypto.randomUUID()}`, file, target: "all" as const }))]);
  };

  const toggleDocumentSlot = (key: string, slotIndex: number) => setDocuments((current) => current.map((document) => {
    if (document.key !== key) return document;
    const selected = document.target === "all" ? [] : document.target;
    const next = selected.includes(slotIndex) ? selected.filter((entry) => entry !== slotIndex) : [...selected, slotIndex];
    return { ...document, target: next };
  }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(undefined);
    if (!name.trim()) {
      setError("Vyplňte název projektu.");
      return;
    }
    if (fileErrors.length) {
      setError("Některé soubory nevyhovují — opravte je, prosím.");
      return;
    }
    if (documents.some((document) => document.target !== "all" && (document.target.length === 0 || document.target.some((slot) => !slots[slot]?.file)))) {
      setError("U každého dokumentu zvolte „Všechny modely“ nebo alespoň jeden nahrávaný model.");
      return;
    }
    setBusy(true);
    try {
      const project = createdId ? undefined : await createSeeProject({
        name: name.trim(),
        description: description.trim(),
        scenes: usedSlots.map((slot) => ({ name: slot.name.trim() || DEFAULT_SLOT_NAMES[slot.index] || `Model ${slot.index + 1}` })),
      });
      const projectId = createdId ?? project!.project.id;
      setCreatedId(projectId);
      const sceneIds: Record<number, string> = project ? Object.fromEntries(usedSlots.map((slot, position) => [slot.index, project.scenes[position].id])) : sceneIdBySlot;
      setSceneIdBySlot(sceneIds);
      let failures = 0;
      for (const slot of usedSlots) {
        const key = `model-${slot.index}`;
        if (progress[key]?.state === "done") continue;
        try {
          await uploadSeeFile(projectId, slot.file!, { kind: "model", sceneId: sceneIds[slot.index] }, (value) => setProgress((current) => ({ ...current, [key]: value })));
        } catch {
          failures += 1;
        }
      }
      for (const document of documents) {
        if (progress[document.key]?.state === "done") continue;
        try {
          await uploadSeeFile(projectId, document.file, {
            kind: "document",
            appliesToAll: document.target === "all",
            sceneIds: document.target === "all" ? [] : document.target.map((slot) => sceneIds[slot]).filter((id): id is string => Boolean(id)),
          }, (value) => setProgress((current) => ({ ...current, [document.key]: value })));
        } catch {
          failures += 1;
        }
      }
      if (failures === 0) {
        router.push(`/see/projects/${projectId}`);
        return;
      }
      setError(`Projekt je uložený, ale ${failures} ${failures === 1 ? "soubor se nepodařilo" : "soubory se nepodařilo"} nahrát. Chybu vidíte u souboru; soubory lze doplnit i později v editoru.`);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Projekt se nepodařilo založit.");
    } finally {
      setBusy(false);
    }
  };

  const progressLabel = (key: string) => {
    const value = progress[key];
    if (!value) return undefined;
    if (value.state === "uploading") return <span className="seeProgress"><span style={{ width: `${value.percent}%` }} />{value.message ?? `${value.percent} %`}</span>;
    if (value.state === "verifying") return <span className="seeMuted">{value.message ?? "Ověřuji soubor na serveru…"}</span>;
    if (value.state === "done") return <span className="seeOk">Nahráno a ověřeno</span>;
    return <span className="seeErrorText">{value.message}</span>;
  };

  return (
    <form className="seeForm" onSubmit={submit}>
      <h1>Nový projekt</h1>
      <section className="seeCard">
        <label className="seeField">
          <span>Název projektu *</span>
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={200} required placeholder="např. ZARGES 40863" disabled={Boolean(createdId)} />
        </label>
        <label className="seeField">
          <span>Popis</span>
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={4000} rows={3} disabled={Boolean(createdId)} />
        </label>
      </section>

      <section className="seeCard">
        <h2>3D modely (až {SEE_MAX_SCENES} × GLB)</h2>
        <p className="seeMuted">Každý model je samostatná scéna se svým pohledem, světlem a popisky. Limit {Math.round(limits.maxModelBytes / 1_000_000)} MB na soubor; podporované jsou vestavěné textury, Draco i Meshopt komprese.</p>
        <div className="seeSlotGrid">
          {slots.map((slot, index) => (
            <div key={index} className="seeSlot">
              <label className="seeField">
                <span>Název modelu {index + 1}</span>
                <input value={slot.name} placeholder={DEFAULT_SLOT_NAMES[index]} maxLength={120} onChange={(event) => updateSlot(index, { name: event.target.value })} disabled={Boolean(createdId)} />
              </label>
              <label className="seeFilePick">
                <input type="file" accept={SEE_ACCEPT_ATTRIBUTE.model} onChange={(event) => updateSlot(index, { file: event.target.files?.[0] })} disabled={Boolean(createdId)} />
                <span>{slot.file ? `${slot.file.name} (${formatFileSize(slot.file.size)})` : "Vybrat .glb"}</span>
              </label>
              {slot.file && clientCheck(slot.file, "model", limits) && <span className="seeErrorText">{clientCheck(slot.file, "model", limits)}</span>}
              {progressLabel(`model-${index}`)}
            </div>
          ))}
        </div>
      </section>

      <section className="seeCard">
        <h2>Dokumentace</h2>
        <p className="seeMuted">PDF, JPG nebo PNG, libovolný počet, max. {Math.round(limits.maxDocumentBytes / 1_000_000)} MB na soubor. Návštěvník u každého modelu uvidí jen dokumenty pro „Všechny modely“ a ty přiřazené k danému modelu.</p>
        <label className="seeFilePick">
          <input type="file" multiple accept={SEE_ACCEPT_ATTRIBUTE.document} onChange={(event) => { addDocuments(event.target.files); event.target.value = ""; }} />
          <span>Přidat dokumenty…</span>
        </label>
        {documents.length > 0 && (
          <ul className="seeDocList">
            {documents.map((document) => (
              <li key={document.key}>
                <div className="seeDocHead">
                  <strong>{document.file.name}</strong>
                  <span className="seeMuted">{formatFileSize(document.file.size)}</span>
                  {!progress[document.key] && <button type="button" className="seeLinkButton" onClick={() => setDocuments((current) => current.filter((entry) => entry.key !== document.key))}>Odebrat</button>}
                </div>
                <div className="seeTargets">
                  <label><input type="radio" checked={document.target === "all"} onChange={() => setDocuments((current) => current.map((entry) => (entry.key === document.key ? { ...entry, target: "all" } : entry)))} /> Všechny modely</label>
                  {slots.map((slot, index) => slot.file && (
                    <label key={index}>
                      <input type="checkbox" checked={document.target !== "all" && document.target.includes(index)} onChange={() => toggleDocumentSlot(document.key, index)} />
                      {slot.name.trim() || DEFAULT_SLOT_NAMES[index]}
                    </label>
                  ))}
                </div>
                {clientCheck(document.file, "document", limits) && <span className="seeErrorText">{clientCheck(document.file, "document", limits)}</span>}
                {progressLabel(document.key)}
              </li>
            ))}
          </ul>
        )}
      </section>

      {error && <div className="seeBanner seeBannerError">{error}</div>}
      <div className="seeActions">
        {createdId && <button type="button" className="seeButton" onClick={() => router.push(`/see/projects/${createdId}`)}>Otevřít pracovní náhled bez chybějících souborů</button>}
        <button type="submit" className="seeButton seeButtonPrimary" disabled={busy}>
          {busy ? "Ukládám a nahrávám…" : createdId ? "Zkusit nahrát znovu" : "Uložit a otevřít pracovní náhled"}
        </button>
      </div>
    </form>
  );
}
