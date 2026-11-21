"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SEE_EMBED_POLICIES, SEE_EMBED_POLICY_LABELS_CS, type SeeEmbedPolicy } from "../../domain/seeEmbed";
import { modelOptimizationHints, SEE_ACCEPT_ATTRIBUTE } from "../../domain/seeFiles";
import {
  DEFAULT_SEE_SCENE_SETTINGS,
  formatFileSize,
  SEE_BACKGROUND_LABELS_CS,
  SEE_BACKGROUNDS,
  SEE_LIGHTING_LABELS_CS,
  SEE_LIGHTINGS,
  SEE_MAX_SCENES,
  SEE_PROJECT_STATUS_LABELS_CS,
  SEE_PUBLICATION_MODE_LABELS_CS,
  type SeeAnnotation,
  type SeePublicationMode,
  type SeeScene,
  type SeeSceneSettings,
  type SeeVec3,
} from "../../domain/seeProject";
import { embedSnippet, invitationTexts, type SeeEditorFile, type SeeEditorView } from "../../domain/seeViews";
import {
  changeSeeProjectStatus,
  copyText,
  formatDateTime,
  getSeeProject,
  saveSeeProject,
  seeEditorFileUrl,
  seePublicationAction,
  uploadSeeFile,
  type SeeUploadProgress,
} from "../../lib/see/client";
import { SeeNotice } from "./SeeNotice";
import { SeeViewer, type SeeViewerHandle } from "./SeeViewer";
import { clearDraftBackup, readDraftBackup, useUnsavedChangesGuard, writeDraftBackup, type StoredDraft } from "./useUnsavedChangesGuard";

type DraftFile = SeeEditorFile & { deleted?: boolean };
type Draft = { name: string; description: string; scenes: SeeScene[]; annotations: SeeAnnotation[]; files: DraftFile[] };
type Tab = "model" | "view" | "labels" | "docs" | "publish";

const TABS: readonly [Tab, string][] = [["model", "Model"], ["view", "Zobrazení"], ["labels", "Popisky"], ["docs", "Dokumentace"], ["publish", "Publikace"]];

function draftFromView(view: SeeEditorView): Draft {
  return {
    name: view.project.name,
    description: view.project.description,
    scenes: [...view.scenes],
    annotations: [...view.annotations],
    files: view.files.map((file) => ({ ...file })),
  };
}

function draftBody(draft: Draft) {
  return {
    project: { name: draft.name, description: draft.description },
    scenes: draft.scenes.map((scene) => ({ id: scene.id, name: scene.name, description: scene.description, modelFileId: scene.modelFileId ?? null, settings: scene.settings })),
    annotations: draft.annotations.map((annotation) => ({ id: annotation.id, sceneId: annotation.sceneId, title: annotation.title, body: annotation.body, position: annotation.position, normal: annotation.normal, visible: annotation.visible })),
    files: draft.files.map((file, index) => ({ id: file.id, displayName: file.displayName, appliesToAll: file.appliesToAll, sceneIds: file.sceneIds, sortOrder: index, deleted: file.deleted === true })),
  };
}

const nowIso = () => new Date().toISOString();

export function SeeEditor({ initial }: Readonly<{ initial: SeeEditorView }>) {
  const projectId = initial.project.id;
  const viewerRef = useRef<SeeViewerHandle>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [view, setView] = useState(initial);
  const [draft, setDraft] = useState<Draft>(() => draftFromView(initial));
  const [dirty, setDirty] = useState(false);
  const [activeSceneId, setActiveSceneId] = useState<string | undefined>(initial.scenes[0]?.id);
  const [tab, setTab] = useState<Tab>("model");
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | undefined>();
  const [pickMode, setPickMode] = useState(false);
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [busy, setBusy] = useState<string | undefined>();
  const [message, setMessage] = useState<{ kind: "ok" | "error" | "warn"; text: string } | undefined>();
  const [uploads, setUploads] = useState<Record<string, SeeUploadProgress & { name: string }>>({});
  const [docTarget, setDocTarget] = useState<"all" | string[]>("all");
  const [pinReveal, setPinReveal] = useState<string | undefined>();
  const [customPin, setCustomPin] = useState("");
  const [modeChoice, setModeChoice] = useState<SeePublicationMode>(initial.publication?.mode ?? "public");
  const [embedSize, setEmbedSize] = useState({ width: "100%", height: "650px" });
  const [embedPolicy, setEmbedPolicy] = useState<SeeEmbedPolicy>(initial.publication?.embedPolicy ?? "default");
  const [embedOrigins, setEmbedOrigins] = useState((initial.publication?.embedOrigins ?? []).join("\n"));
  const [origin, setOrigin] = useState("");
  const [recoverable, setRecoverable] = useState<StoredDraft<Draft> | undefined>();
  const closeMessage = useCallback(() => setMessage(undefined), []);

  useEffect(() => setOrigin(window.location.origin), []);
  useUnsavedChangesGuard(dirty);

  // Draft backup: survives the browser Back button, a crash or a closed tab within this session.
  useEffect(() => {
    const stored = readDraftBackup<Draft>(projectId);
    if (stored?.draft && Array.isArray(stored.draft.scenes)) setRecoverable(stored);
  }, [projectId]);
  useEffect(() => {
    if (!dirty) {
      if (!recoverable) clearDraftBackup(projectId);
      return undefined;
    }
    const timer = window.setTimeout(() => writeDraftBackup(projectId, { baseUpdatedAt: view.project.updatedAt, savedAt: new Date().toISOString(), draft }), 600);
    return () => window.clearTimeout(timer);
  }, [dirty, draft, projectId, view.project.updatedAt, recoverable]);

  const applyView = useCallback((next: SeeEditorView) => {
    setView(next);
    setDraft(draftFromView(next));
    setDirty(false);
    setActiveSceneId((current) => (next.scenes.some((scene) => scene.id === current) ? current : next.scenes[0]?.id));
  }, []);

  const change = (update: (current: Draft) => Draft) => {
    setDraft(update);
    setDirty(true);
  };

  const activeScene = draft.scenes.find((scene) => scene.id === activeSceneId);
  const activeAnnotations = draft.annotations.filter((annotation) => annotation.sceneId === activeSceneId);
  const filesById = useMemo(() => new Map(draft.files.map((file) => [file.id, file])), [draft.files]);
  const documents = draft.files.filter((file) => file.kind === "document");
  const readOnly = view.project.status === "archived";

  const updateScene = (sceneId: string, changes: Partial<SeeScene>) => change((current) => ({ ...current, scenes: current.scenes.map((scene) => (scene.id === sceneId ? { ...scene, ...changes } : scene)) }));
  const updateSettings = (changes: Partial<SeeSceneSettings>) => activeScene && updateScene(activeScene.id, { settings: { ...activeScene.settings, ...changes } });
  const updateAnnotation = (id: string, changes: Partial<SeeAnnotation>) => change((current) => ({ ...current, annotations: current.annotations.map((annotation) => (annotation.id === id ? { ...annotation, ...changes } : annotation)) }));
  const updateFile = (id: string, changes: Partial<DraftFile>) => change((current) => ({ ...current, files: current.files.map((file) => (file.id === id ? { ...file, ...changes } : file)) }));

  const perform = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setMessage(undefined);
    try {
      await action();
    } catch (problem) {
      setMessage({ kind: "error", text: problem instanceof Error ? problem.message : "Akce se nezdařila." });
    } finally {
      setBusy(undefined);
    }
  };

  const save = async (): Promise<SeeEditorView> => {
    const next = await saveSeeProject(projectId, draftBody(draft));
    applyView(next);
    return next;
  };
  const ensureSaved = async () => (dirty ? save() : view);

  const onSave = () => perform("Ukládám…", async () => {
    if (!draft.name.trim()) throw new Error("Vyplňte název projektu (záložka Model).");
    const unnamed = draft.scenes.find((scene) => !scene.name.trim());
    if (unnamed) throw new Error("Každý model musí mít název (záložka Model).");
    await save();
    clearDraftBackup(projectId);
    setMessage({ kind: "ok", text: "Změny uloženy." });
  });

  const restoreBackup = () => {
    if (!recoverable) return;
    setDraft(recoverable.draft);
    setDirty(true);
    setActiveSceneId(recoverable.draft.scenes[0]?.id);
    setRecoverable(undefined);
    setMessage({ kind: "warn", text: "Neuložené změny byly obnoveny — zkontrolujte je a klikněte na „Uložit změny“." });
  };
  const discardBackup = () => {
    clearDraftBackup(projectId);
    setRecoverable(undefined);
  };

  const addScene = () => {
    if (draft.scenes.length >= SEE_MAX_SCENES) return;
    const scene: SeeScene = { id: crypto.randomUUID(), projectId, name: `Model ${draft.scenes.length + 1}`, description: "", sortOrder: draft.scenes.length, settings: DEFAULT_SEE_SCENE_SETTINGS, createdAt: nowIso(), updatedAt: nowIso() };
    change((current) => ({ ...current, scenes: [...current.scenes, scene] }));
    setActiveSceneId(scene.id);
    setTab("model");
  };

  const removeScene = (sceneId: string) => {
    const scene = draft.scenes.find((entry) => entry.id === sceneId);
    if (!scene || !window.confirm(`Odstranit model „${scene.name}“ včetně jeho popisků? Změna se projeví po uložení.`)) return;
    change((current) => ({
      ...current,
      scenes: current.scenes.filter((entry) => entry.id !== sceneId),
      annotations: current.annotations.filter((annotation) => annotation.sceneId !== sceneId),
      files: current.files.map((file) => (file.sceneIds.includes(sceneId) ? { ...file, sceneIds: file.sceneIds.filter((id) => id !== sceneId) } : file)),
    }));
    setActiveSceneId(draft.scenes.find((entry) => entry.id !== sceneId)?.id);
  };

  const moveScene = (sceneId: string, offset: -1 | 1) => change((current) => {
    const scenes = [...current.scenes];
    const index = scenes.findIndex((scene) => scene.id === sceneId);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= scenes.length) return current;
    [scenes[index], scenes[target]] = [scenes[target], scenes[index]];
    return { ...current, scenes };
  });

  const uploadModel = (file: File | undefined) => {
    if (!file || !activeScene) return;
    const sceneId = activeScene.id;
    void perform("Nahrávám model…", async () => {
      await ensureSaved();
      const key = `model-${sceneId}`;
      const result = await uploadSeeFile(projectId, file, { kind: "model", sceneId }, (progress) => setUploads((current) => ({ ...current, [key]: { ...progress, name: file.name } })));
      applyView(result.project);
      setMessage({ kind: "ok", text: `Model ${file.name} nahrán a ověřen.` });
    });
  };

  const uploadDocuments = (files: FileList | null) => {
    if (!files?.length) return;
    const list = Array.from(files);
    void perform("Nahrávám dokumentaci…", async () => {
      await ensureSaved();
      let latest: SeeEditorView | undefined;
      const failures: string[] = [];
      for (const file of list) {
        const key = `doc-${file.name}-${file.size}`;
        try {
          latest = (await uploadSeeFile(projectId, file, { kind: "document", appliesToAll: docTarget === "all", sceneIds: docTarget === "all" ? [] : docTarget }, (progress) => setUploads((current) => ({ ...current, [key]: { ...progress, name: file.name } })))).project;
        } catch (problem) {
          failures.push(`${file.name}: ${problem instanceof Error ? problem.message : "chyba"}`);
        }
      }
      if (latest) applyView(latest);
      setMessage(failures.length ? { kind: "error", text: `Nepodařilo se nahrát: ${failures.join("; ")}` } : { kind: "ok", text: "Dokumentace nahrána." });
    });
  };

  const openFile = (fileId: string) => void perform("Připravuji soubor…", async () => {
    const url = await seeEditorFileUrl(projectId, fileId, true);
    const link = document.createElement("a");
    link.href = url;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  });

  const onPick = (position: SeeVec3, normal?: SeeVec3) => {
    if (!activeScene) return;
    const annotation: SeeAnnotation = {
      id: crypto.randomUUID(), sceneId: activeScene.id, title: `Popisek ${activeAnnotations.length + 1}`, body: "",
      position, normal, visible: true, sortOrder: activeAnnotations.length, createdAt: nowIso(), updatedAt: nowIso(),
    };
    change((current) => ({ ...current, annotations: [...current.annotations, annotation] }));
    setSelectedAnnotationId(annotation.id);
    setPickMode(false);
    setTab("labels");
  };

  const publication = view.publication;
  const published = publication?.status === "published";
  const shareUrl = publication && origin ? `${origin}/see/p/${publication.shareSlug}` : "";
  const embedUrl = publication && origin ? `${origin}/see/embed/${publication.shareSlug}` : "";
  const texts = shareUrl ? invitationTexts({ projectName: view.project.name, url: shareUrl, mode: publication!.mode, pin: pinReveal }) : undefined;

  const publicationRequest = (body: Record<string, unknown>, success: string) => perform("Zpracovávám publikaci…", async () => {
    await ensureSaved();
    const result = await seePublicationAction(projectId, body);
    applyView(result.project);
    setModeChoice(result.project.publication?.mode ?? "public");
    setEmbedPolicy(result.project.publication?.embedPolicy ?? "default");
    setEmbedOrigins((result.project.publication?.embedOrigins ?? []).join("\n"));
    setCustomPin("");
    if (result.pin) setPinReveal(result.pin);
    setMessage(result.warning ? { kind: "warn", text: `${success} ${result.warning}` } : { kind: "ok", text: success });
  });

  const statusRequest = (action: string, confirmText: string | undefined, success: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    void perform("Měním stav…", async () => {
      await ensureSaved();
      const result = await changeSeeProjectStatus(projectId, action);
      applyView(await getSeeProject(projectId));
      setMessage(result.warning ? { kind: "warn", text: `${success} ${result.warning}` } : { kind: "ok", text: success });
    });
  };

  const copy = async (text: string, label: string) => setMessage((await copyText(text)) ? { kind: "ok", text: `${label} zkopírován${label.endsWith("a") ? "a" : ""}.` } : { kind: "error", text: "Kopírování se nepodařilo — označte text ručně." });

  const viewerScene = activeScene ? {
    id: activeScene.id,
    modelFileId: activeScene.modelFileId ?? "",
    settings: activeScene.settings,
    annotations: activeAnnotations.filter((annotation) => annotation.visible),
  } : undefined;

  const modelFile = activeScene?.modelFileId ? filesById.get(activeScene.modelFileId) : undefined;

  return (
    <div className="seeEditor">
      <div className="seeEditorBar">
        <Link href="/see/projects" className="seeLinkButton">← Projekty</Link>
        <strong className="seeEditorTitle">{draft.name || "Bez názvu"}</strong>
        <span className={`seeChip seeChip-${published ? "published" : "draft"}`}>{published ? `Publikováno (${publication!.mode === "pin" ? "PIN" : "veřejné"})` : "Návrh"}</span>
        <span className={`seeChip seeChip-${view.project.status}`}>{SEE_PROJECT_STATUS_LABELS_CS[view.project.status]}</span>
        {dirty && <span className="seeChip seeChip-dirty" title="Změny zatím nejsou uložené">Neuložené změny</span>}
        {view.hasUnpublishedChanges && !dirty && <span className="seeChip seeChip-paused" title="Návštěvníci vidí poslední publikovanou verzi">Neveřejné změny</span>}
        <span className="seeSpacer" />
        {busy && <span className="seeMuted">{busy}</span>}
        <button type="button" className="seeButton seeButtonPrimary" disabled={!dirty || Boolean(busy) || readOnly} onClick={onSave}>{dirty ? "Uložit změny" : "Uloženo"}</button>
      </div>
      {view.backend === "local" && <div className="seeBanner seeBannerWarn">Lokální vývojový režim — data jen v .see-local/ na tomto počítači.</div>}
      {view.project.status === "paused" && <div className="seeBanner seeBannerWarn">Projekt je pozastavený: veřejný odkaz, embed i stahování jsou zablokované.</div>}
      {readOnly && <div className="seeBanner seeBannerWarn">Projekt je archivovaný — pro úpravy jej nejprve obnovte (záložka Publikace).</div>}
      {recoverable && (
        <div className="seeBanner seeBannerWarn seeNotice" role="status">
          <span>
            Našli jsme neuložené změny tohoto projektu z {formatDateTime(recoverable.savedAt)}.
            {recoverable.baseUpdatedAt !== view.project.updatedAt ? " Projekt byl mezitím uložen jinde — obnovením přepíšete novější verzi." : ""}
          </span>
          <span className="seeInline">
            <button type="button" className="seeSmallButton" onClick={restoreBackup}>Obnovit změny</button>
            <button type="button" className="seeSmallButton" onClick={discardBackup}>Zahodit</button>
          </span>
        </div>
      )}
      <SeeNotice notice={message} onClose={closeMessage} />

      <div className="seeWorkspace">
        <div className="seeStage" ref={stageRef}>
          <div className="seeSceneTabs" role="tablist" aria-label="Modely">
            {draft.scenes.map((scene) => (
              <button key={scene.id} type="button" role="tab" aria-selected={scene.id === activeSceneId} className={scene.id === activeSceneId ? "seeSceneTab seeSceneTabActive" : "seeSceneTab"} onClick={() => { setActiveSceneId(scene.id); setSelectedAnnotationId(undefined); setPickMode(false); }}>
                {scene.name}
                {!scene.modelFileId && <span className="seeDot" title="Chybí GLB" />}
              </button>
            ))}
            {draft.scenes.length < SEE_MAX_SCENES && !readOnly && <button type="button" className="seeSceneTab seeSceneTabAdd" onClick={addScene}>+ Model</button>}
          </div>
          <SeeViewer
            ref={viewerRef}
            fullscreenRoot={stageRef}
            onFullscreenChange={setFullscreen}
            scene={viewerScene?.modelFileId ? viewerScene : undefined}
            resolveModelUrl={(fileId) => seeEditorFileUrl(projectId, fileId)}
            prefetchModelFileIds={draft.scenes.map((scene) => scene.modelFileId ?? "").filter(Boolean)}
            showAnnotations={showAnnotations}
            selectedAnnotationId={selectedAnnotationId}
            onSelectAnnotation={setSelectedAnnotationId}
            pickMode={pickMode}
            onPick={onPick}
            emptyMessage={activeScene ? "K tomuto modelu zatím není nahraný GLB — nahrajte jej v záložce Model." : "Projekt zatím nemá žádný model. Přidejte jej tlačítkem „+ Model“."}
          />
          <div className="seeStageTools">
            <button type="button" onClick={() => viewerRef.current?.resetCamera()} title="Vrátit uložený pohled">Výchozí pohled</button>
            <button type="button" onClick={() => viewerRef.current?.fitModel()}>Přizpůsobit</button>
            <button type="button" onClick={() => setShowAnnotations((value) => !value)}>{showAnnotations ? "Skrýt popisky" : "Zobrazit popisky"}</button>
            <button type="button" onClick={() => viewerRef.current?.toggleFullscreen()}>{fullscreen ? "Ukončit celou obrazovku" : "Celá obrazovka"}</button>
          </div>
          {pickMode && <div className="seePickHint">Klikněte do modelu na místo nového popisku. <button type="button" onClick={() => setPickMode(false)}>Zrušit</button></div>}
        </div>

        <aside className="seePanel">
          <div className="seePanelTabs" role="tablist">
            {TABS.map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? "seePanelTab seePanelTabActive" : "seePanelTab"} onClick={() => setTab(key)}>{label}</button>
            ))}
          </div>
          <div className="seePanelBody">
            {tab === "model" && (
              <>
                <label className="seeField"><span>Název projektu</span><input value={draft.name} maxLength={200} onChange={(event) => change((current) => ({ ...current, name: event.target.value }))} disabled={readOnly} /></label>
                <label className="seeField"><span>Popis projektu</span><textarea rows={3} value={draft.description} maxLength={4000} onChange={(event) => change((current) => ({ ...current, description: event.target.value }))} disabled={readOnly} /></label>
                <hr />
                {activeScene ? (
                  <>
                    <label className="seeField"><span>Název modelu (scény)</span><input value={activeScene.name} maxLength={120} onChange={(event) => updateScene(activeScene.id, { name: event.target.value })} disabled={readOnly} /></label>
                    <label className="seeField"><span>Popis modelu</span><textarea rows={2} value={activeScene.description} maxLength={2000} onChange={(event) => updateScene(activeScene.id, { description: event.target.value })} disabled={readOnly} /></label>
                    <div className="seeInline">
                      <button type="button" className="seeSmallButton" onClick={() => moveScene(activeScene.id, -1)} disabled={readOnly}>↑ Posunout dřív</button>
                      <button type="button" className="seeSmallButton" onClick={() => moveScene(activeScene.id, 1)} disabled={readOnly}>↓ Posunout později</button>
                    </div>
                    <div className="seeFileBox">
                      <span className="seeMuted">GLB soubor</span>
                      <strong>{modelFile ? `${modelFile.originalFileName} (${formatFileSize(modelFile.sizeBytes)})` : "Nenahráno"}</strong>
                      {!readOnly && (
                        <label className="seeFilePick">
                          <input type="file" accept={SEE_ACCEPT_ATTRIBUTE.model} onChange={(event) => { uploadModel(event.target.files?.[0]); event.target.value = ""; }} disabled={Boolean(busy)} />
                          <span>{modelFile ? "Vyměnit GLB…" : "Nahrát GLB…"}</span>
                        </label>
                      )}
                      {uploads[`model-${activeScene.id}`] && <UploadState progress={uploads[`model-${activeScene.id}`]} />}
                      <span className="seeMuted">Max. {Math.round(view.limits.maxModelBytes / 1_000_000)} MB. Výměna se návštěvníkům projeví až po novém publikování.</span>
                      {modelFile?.modelInfo && <ModelInfoPanel file={modelFile} />}
                    </div>
                    {!readOnly && <button type="button" className="seeSmallButton seeDanger" onClick={() => removeScene(activeScene.id)}>Odstranit tento model</button>}
                  </>
                ) : <p className="seeMuted">Přidejte model tlačítkem „+ Model“ nad prohlížečem.</p>}
              </>
            )}

            {tab === "view" && activeScene && (
              <>
                <div className="seeFieldGroup">
                  <span className="seeFieldLabel">Kamera</span>
                  <div className="seeInline">
                    <button type="button" className="seeSmallButton" disabled={readOnly} onClick={() => { const camera = viewerRef.current?.getCamera(); if (camera) { updateSettings({ camera }); setMessage({ kind: "warn", text: "Pohled nastaven jako výchozí — nezapomeňte uložit." }); } }}>Uložit aktuální pohled jako výchozí</button>
                    <button type="button" className="seeSmallButton" onClick={() => viewerRef.current?.resetCamera()}>Reset kamery</button>
                    <button type="button" className="seeSmallButton" onClick={() => viewerRef.current?.fitModel()}>Přizpůsobit model</button>
                    {activeScene.settings.camera && <button type="button" className="seeSmallButton" disabled={readOnly} onClick={() => updateSettings({ camera: undefined })}>Zrušit uložený pohled</button>}
                  </div>
                  <span className="seeMuted">{activeScene.settings.camera ? "Model má uložený výchozí pohled." : "Výchozí pohled se dopočítá podle velikosti modelu."}</span>
                </div>
                <label className="seeField">
                  <span>Pozadí</span>
                  <select value={activeScene.settings.background} onChange={(event) => updateSettings({ background: event.target.value as SeeSceneSettings["background"] })} disabled={readOnly}>
                    {SEE_BACKGROUNDS.map((background) => <option key={background} value={background}>{SEE_BACKGROUND_LABELS_CS[background]}</option>)}
                  </select>
                </label>
                {activeScene.settings.background === "custom" && (
                  <label className="seeField"><span>Barva pozadí</span><input type="color" value={activeScene.settings.backgroundColor} onChange={(event) => updateSettings({ backgroundColor: event.target.value })} disabled={readOnly} /></label>
                )}
                <label className="seeField">
                  <span>Osvětlení</span>
                  <select value={activeScene.settings.lighting} onChange={(event) => updateSettings({ lighting: event.target.value as SeeSceneSettings["lighting"] })} disabled={readOnly}>
                    {SEE_LIGHTINGS.map((lighting) => <option key={lighting} value={lighting}>{SEE_LIGHTING_LABELS_CS[lighting]}</option>)}
                  </select>
                </label>
                <label className="seeField">
                  <span>Expozice {activeScene.settings.exposure.toFixed(2).replace(".", ",")}</span>
                  <input type="range" min={0.2} max={3} step={0.05} value={activeScene.settings.exposure} onChange={(event) => updateSettings({ exposure: Number(event.target.value) })} disabled={readOnly} />
                </label>
                <label className="seeCheck"><input type="checkbox" checked={activeScene.settings.showAnnotations} onChange={(event) => updateSettings({ showAnnotations: event.target.checked })} disabled={readOnly} /> Návštěvníkům zobrazit popisky hned po otevření</label>
                <button type="button" className="seeSmallButton" onClick={() => viewerRef.current?.toggleFullscreen()}>Celá obrazovka</button>
              </>
            )}

            {tab === "labels" && activeScene && (
              <>
                <div className="seeInline">
                  <button type="button" className={pickMode ? "seeSmallButton seeSmallButtonActive" : "seeSmallButton"} disabled={!activeScene.modelFileId || readOnly} onClick={() => setPickMode((value) => !value)}>
                    {pickMode ? "Zrušit vkládání" : "+ Přidat popisek kliknutím do modelu"}
                  </button>
                  <label className="seeCheck"><input type="checkbox" checked={showAnnotations} onChange={(event) => setShowAnnotations(event.target.checked)} /> Zobrazit popisky</label>
                </div>
                {activeAnnotations.length === 0 && <p className="seeMuted">Tento model zatím nemá popisky. Popisky jsou vždy vázané na konkrétní model.</p>}
                <ol className="seeAnnotationList">
                  {activeAnnotations.map((annotation, index) => (
                    <li key={annotation.id} className={annotation.id === selectedAnnotationId ? "seeAnnotationSelected" : ""}>
                      <div className="seeAnnotationHead">
                        <button type="button" className="seeMarkerBadge" onClick={() => setSelectedAnnotationId(annotation.id)} title="Zobrazit v modelu">{index + 1}</button>
                        <input value={annotation.title} maxLength={160} onChange={(event) => updateAnnotation(annotation.id, { title: event.target.value })} onFocus={() => setSelectedAnnotationId(annotation.id)} disabled={readOnly} aria-label="Název popisku" />
                      </div>
                      <textarea rows={2} value={annotation.body} maxLength={4000} placeholder="Text popisku" onChange={(event) => updateAnnotation(annotation.id, { body: event.target.value })} onFocus={() => setSelectedAnnotationId(annotation.id)} disabled={readOnly} />
                      <div className="seeInline">
                        <label className="seeCheck"><input type="checkbox" checked={annotation.visible} onChange={(event) => updateAnnotation(annotation.id, { visible: event.target.checked })} disabled={readOnly} /> Aktivní</label>
                        <span className="seeMuted seeCoords">[{annotation.position.map((value) => value.toFixed(3)).join("; ")}]</span>
                        {!readOnly && <button type="button" className="seeLinkButton seeDanger" onClick={() => change((current) => ({ ...current, annotations: current.annotations.filter((entry) => entry.id !== annotation.id) }))}>Smazat</button>}
                      </div>
                    </li>
                  ))}
                </ol>
              </>
            )}

            {(tab === "view" || tab === "labels") && !activeScene && <p className="seeMuted">Nejdřív přidejte model.</p>}

            {tab === "docs" && (
              <>
                {!readOnly && (
                  <div className="seeFileBox">
                    <span className="seeFieldLabel">Nahrát dokumentaci (PDF, JPG, PNG · max. {Math.round(view.limits.maxDocumentBytes / 1_000_000)} MB)</span>
                    <div className="seeTargets">
                      <label><input type="radio" checked={docTarget === "all"} onChange={() => setDocTarget("all")} /> Všechny modely</label>
                      {draft.scenes.map((scene) => (
                        <label key={scene.id}>
                          <input type="checkbox" checked={docTarget !== "all" && docTarget.includes(scene.id)} onChange={() => setDocTarget((current) => { const list = current === "all" ? [] : current; return list.includes(scene.id) ? list.filter((id) => id !== scene.id) : [...list, scene.id]; })} />
                          {scene.name}
                        </label>
                      ))}
                    </div>
                    <label className="seeFilePick">
                      <input type="file" multiple accept={SEE_ACCEPT_ATTRIBUTE.document} disabled={Boolean(busy) || (docTarget !== "all" && docTarget.length === 0)} onChange={(event) => { uploadDocuments(event.target.files); event.target.value = ""; }} />
                      <span>Vybrat soubory…</span>
                    </label>
                    {Object.entries(uploads).filter(([key]) => key.startsWith("doc-")).map(([key, progress]) => <UploadState key={key} progress={progress} />)}
                  </div>
                )}
                {documents.length === 0 && <p className="seeMuted">Projekt zatím nemá dokumentaci.</p>}
                <ul className="seeDocList">
                  {documents.map((file) => (
                    <li key={file.id} className={file.deleted ? "seeDocDeleted" : ""}>
                      <input value={file.displayName} maxLength={200} onChange={(event) => updateFile(file.id, { displayName: event.target.value })} disabled={readOnly || file.deleted} aria-label="Název dokumentu" />
                      <span className="seeMuted">{file.originalFileName} · {formatFileSize(file.sizeBytes)}</span>
                      <div className="seeTargets">
                        <label><input type="checkbox" checked={file.appliesToAll} onChange={(event) => updateFile(file.id, { appliesToAll: event.target.checked })} disabled={readOnly || file.deleted} /> Všechny modely</label>
                        {!file.appliesToAll && draft.scenes.map((scene) => (
                          <label key={scene.id}>
                            <input type="checkbox" checked={file.sceneIds.includes(scene.id)} onChange={() => updateFile(file.id, { sceneIds: file.sceneIds.includes(scene.id) ? file.sceneIds.filter((id) => id !== scene.id) : [...file.sceneIds, scene.id] })} disabled={readOnly || file.deleted} />
                            {scene.name}
                          </label>
                        ))}
                      </div>
                      {!file.appliesToAll && file.sceneIds.length === 0 && !file.deleted && <span className="seeErrorText">Dokument není přiřazen žádnému modelu — návštěvníci jej neuvidí.</span>}
                      <div className="seeInline">
                        <button type="button" className="seeLinkButton" onClick={() => openFile(file.id)} disabled={file.status !== "ready" || file.deleted}>Stáhnout</button>
                        {!readOnly && <button type="button" className="seeLinkButton seeDanger" onClick={() => updateFile(file.id, { deleted: !file.deleted })}>{file.deleted ? "Vrátit" : "Odstranit"}</button>}
                        {file.status === "pending" && <span className="seeErrorText">Nedokončený upload</span>}
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {tab === "publish" && (
              <>
                <div className="seeFieldGroup">
                  <span className="seeFieldLabel">Stav publikace</span>
                  <p>{published ? `Publikováno ${formatDateTime(publication!.publishedAt)} (verze ${publication!.snapshotRevision}, ${publication!.snapshotSceneCount} modely, ${publication!.snapshotDocumentCount} přílohy)` : publication ? `Návrh — publikace zrušena ${formatDateTime(publication.unpublishedAt)}` : "Návrh — zatím nepublikováno."}</p>
                  {publication && <p className="seeMuted">Počet otevření: {publication.viewCount}{publication.lastViewedAt ? ` · naposledy ${formatDateTime(publication.lastViewedAt)}` : ""}</p>}
                  {view.hasUnpublishedChanges && <p className="seeWarnText">Návštěvníci vidí poslední publikovanou verzi. Změny se projeví až po „Publikovat znovu“.</p>}
                </div>

                <div className="seeFieldGroup">
                  <span className="seeFieldLabel">Režim sdílení</span>
                  {(["public", "pin"] as const).map((mode) => (
                    <label key={mode} className="seeRadio">
                      <input type="radio" name="see-mode" checked={modeChoice === mode} onChange={() => setModeChoice(mode)} />
                      <span>
                        <strong>{mode === "public" ? "Veřejné" : "Chráněné PINem"}</strong> — {SEE_PUBLICATION_MODE_LABELS_CS[mode]}
                        <small className="seeMuted">{mode === "public" ? "Odkaz otevře kdokoli, kdo ho získá (bez přihlášení a bez PINu). Stránka není indexovaná, ale není tajná." : "Na stejném odkazu se nejdřív zadává číselný PIN. Bez správného PINu server nevydá model, popisky ani dokumenty."}</small>
                      </span>
                    </label>
                  ))}
                  {modeChoice === "pin" && (
                    <label className="seeField">
                      <span>Vlastní PIN (8–12 číslic, nepovinné — jinak se vygeneruje náhodný 8místný)</span>
                      <input value={customPin} inputMode="numeric" autoComplete="off" pattern="[0-9]{8,12}" maxLength={12} onChange={(event) => setCustomPin(event.target.value.replace(/\D/gu, ""))} />
                    </label>
                  )}
                  <div className="seeInline">
                    <button type="button" className="seeButton seeButtonPrimary" disabled={Boolean(busy) || view.project.status !== "active"} onClick={() => publicationRequest({ action: "publish", mode: modeChoice, ...(modeChoice === "pin" && customPin ? { pin: customPin } : {}) }, published ? "Publikovaný obsah aktualizován." : "Projekt publikován.")}>
                      {published ? "Publikovat znovu (aktualizovat obsah)" : "Publikovat"}
                    </button>
                    {published && publication!.mode !== modeChoice && (
                      <button type="button" className="seeButton" disabled={Boolean(busy)} onClick={() => publicationRequest({ action: "set-mode", mode: modeChoice, ...(modeChoice === "pin" && customPin ? { pin: customPin } : {}) }, "Režim sdílení změněn bez změny obsahu.")}>Jen změnit režim</button>
                    )}
                    {published && <button type="button" className="seeButton" disabled={Boolean(busy)} onClick={() => window.confirm("Zrušit publikaci? Odkaz i embed okamžitě přestanou fungovat.") && publicationRequest({ action: "unpublish" }, "Publikace zrušena.")}>Zrušit publikaci</button>}
                  </div>
                  {view.project.status !== "active" && <p className="seeWarnText">Pozastavený nebo archivovaný projekt nelze publikovat.</p>}
                </div>

                {pinReveal && (
                  <div className="seePinReveal">
                    <span className="seeFieldLabel">Nový PIN (zobrazuje se pouze nyní)</span>
                    <strong className="seePin">{pinReveal}</strong>
                    <p className="seeMuted">Uložen je jen jednosměrný otisk. Po zavření jej už nelze zobrazit — pro novou pozvánku vygenerujte nový PIN. Odkaz a PIN posílejte odděleně.</p>
                    <div className="seeInline">
                      <button type="button" className="seeSmallButton" onClick={() => void copy(pinReveal, "PIN")}>Zkopírovat PIN</button>
                      {texts?.pin && <button type="button" className="seeSmallButton" onClick={() => void copy(texts.pin!, "Zpráva s PINem")}>Kopírovat zprávu s PINem</button>}
                      <button type="button" className="seeSmallButton" onClick={() => setPinReveal(undefined)}>Skrýt PIN</button>
                    </div>
                  </div>
                )}

                {published && shareUrl && (
                  <div className="seeFieldGroup">
                    <span className="seeFieldLabel">Odkaz</span>
                    <input readOnly value={shareUrl} onFocus={(event) => event.target.select()} />
                    <div className="seeInline">
                      <button type="button" className="seeSmallButton" onClick={() => void copy(shareUrl, "Odkaz")}>Kopírovat odkaz</button>
                      <button type="button" className="seeSmallButton" onClick={() => void copy(texts!.link, "Pozvánka")}>Kopírovat pozvánku</button>
                      <a className="seeSmallButton" href={shareUrl} target="_blank" rel="noreferrer">Otevřít náhled</a>
                    </div>
                    <p className="seeMuted">E-mailové odesílání není nakonfigurované — pozvánku zkopírujte a pošlete sami{publication!.mode === "pin" ? "; PIN pošlete zvlášť" : ""}.</p>
                    {publication!.mode === "pin" && (
                      <button type="button" className="seeSmallButton" disabled={Boolean(busy)} onClick={() => window.confirm("Vygenerovat nový PIN? Starý PIN a všechny otevřené přístupy okamžitě přestanou platit.") && publicationRequest({ action: "new-pin", ...(customPin ? { pin: customPin } : {}) }, "Nový PIN nastaven.")}>
                        {customPin ? "Nastavit zadaný PIN" : "Vygenerovat nový PIN"}
                      </button>
                    )}
                    <button type="button" className="seeLinkButton seeDanger" disabled={Boolean(busy)} onClick={() => window.confirm("Vytvořit nový odkaz? Starý odkaz i embed okamžitě přestanou fungovat.") && publicationRequest({ action: "rotate-link" }, "Vytvořen nový odkaz, starý již neplatí.")}>Vytvořit nový odkaz (zneplatnit starý)</button>
                  </div>
                )}

                {published && embedUrl && (
                  <div className="seeFieldGroup">
                    <span className="seeFieldLabel">Vložení na web (iframe)</span>
                    <div className="seeInline">
                      <label className="seeField seeFieldSmall"><span>Šířka</span><input value={embedSize.width} onChange={(event) => setEmbedSize((size) => ({ ...size, width: event.target.value }))} /></label>
                      <label className="seeField seeFieldSmall"><span>Výška</span><input value={embedSize.height} onChange={(event) => setEmbedSize((size) => ({ ...size, height: event.target.value }))} /></label>
                    </div>
                    <textarea readOnly rows={4} value={embedSnippet({ url: embedUrl, width: embedSize.width, height: embedSize.height, title: view.project.name })} onFocus={(event) => event.target.select()} />
                    <button type="button" className="seeSmallButton" onClick={() => void copy(embedSnippet({ url: embedUrl, width: embedSize.width, height: embedSize.height, title: view.project.name }), "Kód pro vložení")}>Kopírovat kód</button>
                    <p className="seeMuted">Embed respektuje režim sdílení — u chráněné prezentace se v iframu nejdřív zadává PIN.</p>
                    <span className="seeFieldLabel">Kde smí být prezentace vložena</span>
                    {SEE_EMBED_POLICIES.map((policy) => (
                      <label key={policy} className="seeCheck">
                        <input type="radio" name="see-embed-policy" checked={embedPolicy === policy} onChange={() => setEmbedPolicy(policy)} />
                        {SEE_EMBED_POLICY_LABELS_CS[policy]}
                      </label>
                    ))}
                    {embedPolicy === "allowlist" && (
                      <label className="seeField">
                        <span>Povolené weby (jeden na řádek, např. https://www.zakaznik.cz nebo https://*.zakaznik.cz)</span>
                        <textarea rows={3} value={embedOrigins} onChange={(event) => setEmbedOrigins(event.target.value)} spellCheck={false} />
                      </label>
                    )}
                    <p className="seeMuted">
                      {embedPolicy === "default" ? "Platí výchozí politika portálu (bez nastavení: libovolný web přes HTTPS)." : embedPolicy === "none" ? "Iframe se nikde nezobrazí; odkaz na prezentaci dál funguje." : "Prohlížeč zobrazí iframe jen na uvedených webech (CSP frame-ancestors)."} Nastavení řídí jen vkládání, ochranu obsahu zajišťuje odkaz a případně PIN.
                    </p>
                    {(embedPolicy !== (publication!.embedPolicy ?? "default") || (embedPolicy === "allowlist" && embedOrigins.split(/[\s,;]+/u).filter(Boolean).join(",") !== (publication!.embedOrigins ?? []).join(","))) && (
                      <button type="button" className="seeSmallButton" disabled={Boolean(busy)} onClick={() => publicationRequest({ action: "set-embed", embedPolicy, embedOrigins }, "Nastavení vkládání uloženo.")}>Uložit nastavení vkládání</button>
                    )}
                  </div>
                )}

                {published && (
                  <div className="seeFieldGroup">
                    <span className="seeFieldLabel">Zabezpečení souborů</span>
                    <p className="seeMuted">
                      {view.delivery === "stream"
                        ? "Soubory se posílají přes server portálu; každé zrušení přístupu ukončí i rozběhnuté stahování."
                        : view.delivery === "hybrid"
                          ? "Dokumenty se posílají přes server portálu (okamžité ukončení); modely přes krátké podepsané odkazy, které se při zrušení přístupu okamžitě zneplatní překlíčováním."
                          : "Modely a dokumenty se načítají přes krátké podepsané odkazy; při zrušení publikace, novém PINu, novém odkazu nebo pozastavení se soubory překlíčují a staré odkazy přestanou platit okamžitě."}
                    </p>
                    {publication!.mode === "pin" && view.pinSecurity && (
                      <p className={view.pinSecurity.locked ? "seeWarnText" : "seeMuted"}>
                        Chybné pokusy o PIN v posledních 15 minutách: {view.pinSecurity.recentFailures}.
                        {view.pinSecurity.locked ? " Prezentace je dočasně zablokovaná proti hádání PINu — vygenerováním nového PINu blokaci ukončíte." : ""}
                      </p>
                    )}
                  </div>
                )}

                <div className="seeFieldGroup">
                  <span className="seeFieldLabel">Stav projektu: {SEE_PROJECT_STATUS_LABELS_CS[view.project.status]}</span>
                  <div className="seeInline">
                    {view.project.status === "active" && <button type="button" className="seeSmallButton" onClick={() => statusRequest("pause", "Pozastavit projekt? Veřejný odkaz, embed i stahování se okamžitě zablokují.", "Projekt pozastaven.")}>Pozastavit</button>}
                    {view.project.status === "paused" && <button type="button" className="seeSmallButton" onClick={() => statusRequest("resume", "Obnovit projekt? Publikovaný odkaz začne znovu fungovat (PIN bude třeba zadat znovu).", "Projekt obnoven.")}>Obnovit</button>}
                    {view.project.status !== "archived" && <button type="button" className="seeSmallButton" onClick={() => statusRequest("archive", "Archivovat projekt? Veřejný odkaz přestane fungovat.", "Projekt archivován.")}>Archivovat</button>}
                    {view.project.status === "archived" && <button type="button" className="seeSmallButton" onClick={() => statusRequest("restore", "Obnovit projekt z archivu? Publikovaný odkaz začne znovu fungovat.", "Projekt obnoven z archivu.")}>Obnovit z archivu</button>}
                  </div>
                  <p className="seeMuted">Vytvořil {view.project.createdBy?.label ?? "—"} {formatDateTime(view.project.createdAt)} · upravil {view.project.updatedBy?.label ?? "—"} {formatDateTime(view.project.updatedAt)}</p>
                </div>
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function ModelInfoPanel({ file }: Readonly<{ file: SeeEditorFile }>) {
  const info = file.modelInfo!;
  const hints = modelOptimizationHints(info, file.sizeBytes);
  const compression = [info.draco ? "Draco" : "", info.meshopt ? "Meshopt" : "", info.ktx2 ? "KTX2 textury" : ""].filter(Boolean);
  return (
    <div className="seeModelInfo">
      <span className="seeMuted">
        {info.triangles.toLocaleString("cs-CZ")} trojúhelníků · {info.meshes} meshí · {info.materials} materiálů · {info.textures} textur
        {info.imageTypes.length ? ` (${info.imageTypes.map((type) => type.replace("image/", "").toUpperCase()).join(", ")})` : ""}
      </span>
      <span className="seeMuted">Komprese: {compression.length ? compression.join(", ") : "žádná"}{info.generator ? ` · ${info.generator}` : ""}</span>
      {hints.map((hint) => <span key={hint} className="seeWarnText">{hint}</span>)}
    </div>
  );
}

function UploadState({ progress }: Readonly<{ progress: SeeUploadProgress & { name: string } }>) {
  if (progress.state === "uploading") return <span className="seeProgress"><span style={{ width: `${progress.percent}%` }} />{progress.name}: {progress.message ?? `${progress.percent} %`}</span>;
  if (progress.state === "verifying") return <span className="seeMuted">{progress.name}: {progress.message ?? "ověřuji na serveru…"}</span>;
  if (progress.state === "done") return <span className="seeOk">{progress.name}: nahráno</span>;
  return <span className="seeErrorText">{progress.name}: {progress.message}</span>;
}
