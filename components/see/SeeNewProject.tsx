"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { SEE_ACCEPT_ATTRIBUTE, seeMimeTypeFor, type SeeUploadLimits } from "../../domain/seeFiles";
import { formatFileSize, SEE_MAX_SCENES } from "../../domain/seeProject";
import { createSeeProject, uploadSeeFile, type SeeUploadProgress } from "../../lib/see/client";
import { useUnsavedChangesGuard } from "./useUnsavedChangesGuard";

/** One model of the wizard. `key` is stable, so reordering/removing never mixes up document links. */
type ModelSlot = { key: string; name: string; file?: File };
type DocumentDraft = { key: string; file: File; target: "all" | string[] };

const newSlot = (): ModelSlot => ({ key: crypto.randomUUID(), name: "" });
const slotLabel = (slot: ModelSlot, index: number) => slot.name.trim() || `Model ${index + 1}`;

function clientCheck(file: File, kind: "model" | "document", limits: SeeUploadLimits): string | undefined {
  const mime = seeMimeTypeFor(file.name, file.type);
  const allowed = kind === "model" ? ["model/gltf-binary"] : ["application/pdf", "image/jpeg", "image/png"];
  if (!allowed.includes(mime)) return kind === "model" ? "Pouze soubory .glb." : "Pouze PDF, JPG nebo PNG.";
  const max = kind === "model" ? limits.maxModelBytes : limits.maxDocumentBytes;
  if (file.size > max) return `Překračuje limit ${Math.round(max / 1_000_000)} MB.`;
  return undefined;
}

/**
 * "Nový projekt": name + description, models added one by one (starts with ONE; "+ Přidat další
 * model" for more — no fixed limit of three), any number of documents assigned to "Všechny modely"
 * or chosen models, then "Uložit a otevřít pracovní náhled". Browser checks are a convenience;
 * the server validates every file again.
 */
export function SeeNewProject({ limits }: Readonly<{ limits: SeeUploadLimits }>) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [slots, setSlots] = useState<ModelSlot[]>(() => [newSlot()]);
  const [documents, setDocuments] = useState<DocumentDraft[]>([]);
  const [progress, setProgress] = useState<Record<string, SeeUploadProgress>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [createdId, setCreatedId] = useState<string | undefined>();
  const [sceneIdBySlot, setSceneIdBySlot] = useState<Record<string, string>>({});

  // Typed texts and picked files are lost when leaving before "Uložit" — ask first.
  useUnsavedChangesGuard(!createdId && Boolean(name.trim() || description.trim() || slots.some((slot) => slot.file || slot.name.trim()) || documents.length), "Rozpracovaný projekt ještě není uložený. Opravdu chcete stránku opustit?");

  const updateSlot = (key: string, change: Partial<ModelSlot>) => setSlots((current) => current.map((slot) => (slot.key === key ? { ...slot, ...change } : slot)));
  const addSlot = () => setSlots((current) => (current.length >= SEE_MAX_SCENES ? current : [...current, newSlot()]));
  const removeSlot = (key: string) => {
    setSlots((current) => (current.length <= 1 ? current : current.filter((slot) => slot.key !== key)));
    // A document linked only to the removed model falls back to "Všechny modely" — visible and explicit.
    setDocuments((current) => current.map((document) => {
      if (document.target === "all" || !document.target.includes(key)) return document;
      const remaining = document.target.filter((entry) => entry !== key);
      return { ...document, target: remaining.length ? remaining : "all" };
    }));
  };
  const moveSlot = (key: string, offset: -1 | 1) => setSlots((current) => {
    const index = current.findIndex((slot) => slot.key === key);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= current.length) return current;
    const next = [...current];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  });

  // A model is created when it has a GLB or at least a name; an empty project still gets one model.
  const usedSlots = slots.map((slot, index) => ({ ...slot, index })).filter((slot) => slot.file || slot.name.trim());
  const fileErrors = [
    ...usedSlots.filter((slot) => slot.file).map((slot) => clientCheck(slot.file!, "model", limits)),
    ...documents.map((document) => clientCheck(document.file, "document", limits)),
  ].filter(Boolean);

  const addDocuments = (files: FileList | null) => {
    if (!files) return;
    // Copy now: the caller clears the <input>, which empties this live FileList before React
    // runs the state updater.
    const picked = Array.from(files);
    setDocuments((current) => [...current, ...picked.map((file) => ({ key: `${file.name}-${file.size}-${crypto.randomUUID()}`, file, target: "all" as const }))]);
  };

  const toggleDocumentSlot = (documentKey: string, slotKey: string) => setDocuments((current) => current.map((document) => {
    if (document.key !== documentKey) return document;
    const selected = document.target === "all" ? [] : document.target;
    const next = selected.includes(slotKey) ? selected.filter((entry) => entry !== slotKey) : [...selected, slotKey];
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
    const usedKeys = new Set(usedSlots.map((slot) => slot.key));
    if (documents.some((document) => document.target !== "all" && (document.target.length === 0 || document.target.some((key) => !usedKeys.has(key))))) {
      setError("U každého dokumentu zvolte „Všechny modely“ nebo alespoň jeden model, který má název nebo soubor.");
      return;
    }
    setBusy(true);
    try {
      const sceneSlots = usedSlots.length ? usedSlots : [{ ...slots[0], index: 0 }];
      const project = createdId ? undefined : await createSeeProject({
        name: name.trim(),
        description: description.trim(),
        scenes: sceneSlots.map((slot) => ({ name: slotLabel(slot, slot.index) })),
      });
      const projectId = createdId ?? project!.project.id;
      setCreatedId(projectId);
      const sceneIds: Record<string, string> = project ? Object.fromEntries(sceneSlots.map((slot, position) => [slot.key, project.scenes[position].id])) : sceneIdBySlot;
      setSceneIdBySlot(sceneIds);
      let failures = 0;
      for (const slot of usedSlots.filter((entry) => entry.file)) {
        const key = `model-${slot.key}`;
        if (progress[key]?.state === "done") continue;
        try {
          await uploadSeeFile(projectId, slot.file!, { kind: "model", sceneId: sceneIds[slot.key] }, (value) => setProgress((current) => ({ ...current, [key]: value })));
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
            sceneIds: document.target === "all" ? [] : document.target.map((key) => sceneIds[key]).filter((id): id is string => Boolean(id)),
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

  const locked = Boolean(createdId);
  return (
    <form className="seeForm" onSubmit={submit}>
      <h1>Nový projekt</h1>
      <section className="seeCard">
        <label className="seeField">
          <span>Název projektu *</span>
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={200} required placeholder="např. ZARGES 40863" disabled={locked} />
        </label>
        <label className="seeField">
          <span>Popis</span>
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={4000} rows={3} disabled={locked} />
        </label>
      </section>

      <section className="seeCard">
        <h2>3D modely</h2>
        <p className="seeMuted">Každý model je samostatná scéna se svým pohledem, světlem a popisky; návštěvník mezi nimi přepíná. Začněte jedním modelem a další přidejte tlačítkem níže. Limit {Math.round(limits.maxModelBytes / 1_000_000)} MB na soubor; podporované jsou vestavěné textury, KTX2, Draco i Meshopt komprese.</p>
        <ol className="seeSlotList">
          {slots.map((slot, index) => (
            <li key={slot.key} className="seeSlot">
              <div className="seeSlotHead">
                <span className="seeSlotIndex" aria-hidden="true">{index + 1}</span>
                <label className="seeField seeSlotName">
                  <span>Název modelu</span>
                  <input value={slot.name} placeholder={`Model ${index + 1}`} maxLength={120} onChange={(event) => updateSlot(slot.key, { name: event.target.value })} disabled={locked} aria-label={`Název modelu ${index + 1}`} />
                </label>
                {!locked && (
                  <span className="seeSlotActions">
                    <button type="button" className="seeSmallButton" onClick={() => moveSlot(slot.key, -1)} disabled={index === 0} aria-label={`Posunout model ${index + 1} výš`}>↑</button>
                    <button type="button" className="seeSmallButton" onClick={() => moveSlot(slot.key, 1)} disabled={index === slots.length - 1} aria-label={`Posunout model ${index + 1} níž`}>↓</button>
                    <button type="button" className="seeSmallButton seeDanger" onClick={() => removeSlot(slot.key)} disabled={slots.length <= 1} title={slots.length <= 1 ? "Projekt musí mít alespoň jeden model." : undefined} aria-label={`Odebrat model ${index + 1}`}>Odebrat</button>
                  </span>
                )}
              </div>
              <label className="seeFilePick">
                <input type="file" accept={SEE_ACCEPT_ATTRIBUTE.model} onChange={(event) => updateSlot(slot.key, { file: event.target.files?.[0] })} disabled={locked} />
                <span>{slot.file ? `${slot.file.name} (${formatFileSize(slot.file.size)})` : "Vybrat .glb"}</span>
              </label>
              {slot.file && clientCheck(slot.file, "model", limits) && <span className="seeErrorText">{clientCheck(slot.file, "model", limits)}</span>}
              {progressLabel(`model-${slot.key}`)}
            </li>
          ))}
        </ol>
        {!locked && slots.length < SEE_MAX_SCENES && <button type="button" className="seeButton" onClick={addSlot}>+ Přidat další model</button>}
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
                  {slots.map((slot, index) => (
                    <label key={slot.key}>
                      <input type="checkbox" checked={document.target !== "all" && document.target.includes(slot.key)} onChange={() => toggleDocumentSlot(document.key, slot.key)} />
                      {slotLabel(slot, index)}
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
