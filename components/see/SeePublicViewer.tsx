"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { resolveInfoPanel } from "../../domain/seeContent";
import { documentsForScene, formatFileSize, fileDownloadName } from "../../domain/seeProject";
import { SEE_PUBLIC_STATE_MESSAGES_CS, type SeePublicManifest } from "../../domain/seeViews";
import { SeeCubeIcon } from "./SeeShell";
import { SeeInfoDrawer, SeeSceneSwitcher, SeeViewPresets } from "./SeeViewControls";
import { SeeViewer, type SeeViewerHandle } from "./SeeViewer";

type LoadedManifest = Extract<SeePublicManifest, { state: "ok" }>;

class AccessLost extends Error {}

/**
 * Customer-facing HWS SEE viewer for /see/p/[slug] and /see/embed/[slug]. No portal login.
 * Everything it shows comes from the public API, which re-checks publication state and — in PIN
 * mode — the grant on every request. The grant token from the unlock response is kept only in
 * memory (header fallback for iframes where third-party cookies are blocked); the HttpOnly cookie
 * covers normal page reloads.
 */
export function SeePublicViewer({ slug, embed = false }: Readonly<{ slug: string; embed?: boolean }>) {
  const viewerRef = useRef<SeeViewerHandle>(null);
  const presentationRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const grantRef = useRef<string | undefined>(undefined);
  const viewCountedRef = useRef(false);
  const [manifest, setManifest] = useState<SeePublicManifest | undefined>();
  const [failure, setFailure] = useState<string | undefined>();
  const [activeSceneId, setActiveSceneId] = useState<string | undefined>();
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | undefined>();
  const [menu, setMenu] = useState<"downloads" | "info" | undefined>();
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | undefined>();
  const [unlocking, setUnlocking] = useState(false);
  // The information panel is always CLOSED when a presentation is opened; a manual opening is kept
  // while switching between the models of this presentation only.
  const [infoOpen, setInfoOpen] = useState(false);

  const api = useCallback(async (path: string, init?: RequestInit) => {
    const headers: Record<string, string> = { ...(init?.body ? { "Content-Type": "application/json" } : {}) };
    if (grantRef.current) headers["x-see-grant"] = grantRef.current;
    return fetch(`/api/see/public/${slug}${path}`, { ...init, headers, credentials: "same-origin", cache: "no-store" });
  }, [slug]);

  const load = useCallback(async () => {
    try {
      const response = await api("");
      const raw = await response.json() as { state?: string; error?: string };
      if (!raw.state) throw new Error(raw.error ?? "Prezentaci se nepodařilo načíst.");
      const body = raw as SeePublicManifest;
      setFailure(undefined);
      setManifest(body);
      if (body.state === "ok") {
        setActiveSceneId((current) => (body.scenes.some((scene) => scene.id === current) ? current : body.scenes[0]?.id));
        if (!viewCountedRef.current) {
          viewCountedRef.current = true;
          void api("/view", { method: "POST", body: JSON.stringify({ embed }) }).catch(() => undefined);
        }
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Prezentaci se nepodařilo načíst.");
    }
  }, [api, embed]);

  useEffect(() => { void load(); }, [load]);

  const loaded = manifest?.state === "ok" ? manifest as LoadedManifest : undefined;
  const activeScene = loaded?.scenes.find((scene) => scene.id === activeSceneId) ?? loaded?.scenes[0];
  useEffect(() => {
    if (activeScene) setShowAnnotations(activeScene.settings.showAnnotations);
    setSelectedAnnotationId(undefined);
  }, [activeScene?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const fileUrl = useCallback(async (fileId: string, download: boolean) => {
    const response = await api(`/files/${fileId}${download ? "?download=1" : ""}`);
    const body = await response.json() as { url?: string; manifest?: SeePublicManifest };
    if (!response.ok || !body.url) {
      if (body.manifest) setManifest(body.manifest);
      throw new AccessLost("Přístup k souboru byl odepřen.");
    }
    return body.url;
  }, [api]);

  const download = async (fileId: string) => {
    try {
      const url = await fileUrl(fileId, true);
      const link = document.createElement("a");
      link.href = url;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setMenu(undefined);
    } catch {
      // manifest state already switched to the matching error / PIN screen
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setUnlocking(true);
    setPinError(undefined);
    try {
      const response = await fetch(`/api/see/public/${slug}/unlock`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: pin.replace(/\s+/gu, "") }), credentials: "same-origin", cache: "no-store" });
      const body = await response.json() as { grant?: string; error?: string; manifest?: SeePublicManifest };
      if (!response.ok || !body.grant) {
        if (body.manifest) setManifest(body.manifest);
        setPinError(body.error ?? "PIN se nepodařilo ověřit.");
        return;
      }
      grantRef.current = body.grant;
      setPin("");
      await load();
    } catch {
      setPinError("Server je nedostupný, zkuste to prosím znovu.");
    } finally {
      setUnlocking(false);
    }
  };

  const shellClass = embed ? "seePublic seePublicEmbed" : "seePublic";

  if (failure) return <div className={shellClass}><StateScreen title="Prezentaci se nepodařilo načíst" text={failure} action={<button type="button" onClick={() => void load()}>Zkusit znovu</button>} /></div>;
  if (!manifest) return <div className={shellClass}><StateScreen title="Načítám prezentaci…" /></div>;
  if (manifest.state === "not-found") return <div className={shellClass}><StateScreen title="Prezentace nenalezena" text={SEE_PUBLIC_STATE_MESSAGES_CS["not-found"]} /></div>;
  if (manifest.state === "unavailable") return <div className={shellClass}><StateScreen title="Prezentace není dostupná" text={SEE_PUBLIC_STATE_MESSAGES_CS[manifest.reason]} /></div>;
  if (manifest.state === "pin-required") {
    return (
      <div className={shellClass}>
        <div className="seeState">
          <form className="seePinForm" onSubmit={unlock}>
            <SeeCubeIcon size={34} />
            <h1>Chráněná prezentace</h1>
            <p>{manifest.reason === "expired" ? SEE_PUBLIC_STATE_MESSAGES_CS.expired : "Pro zobrazení 3D prezentace zadejte PIN, který jste obdrželi."}</p>
            <input
              value={pin}
              onChange={(event) => setPin(event.target.value.replace(/[^\d\s]/gu, ""))}
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label="PIN"
              placeholder="PIN"
              maxLength={16}
              autoFocus
              required
            />
            {pinError && <div className="seePinError" role="alert">{pinError}</div>}
            <button type="submit" disabled={unlocking || pin.replace(/\s/gu, "").length < 8}>{unlocking ? "Ověřuji…" : "Zobrazit prezentaci"}</button>
          </form>
        </div>
      </div>
    );
  }

  const scene = activeScene;
  const docs = documentsForScene(loaded!.documents, scene?.id);
  const panel = resolveInfoPanel(loaded!.infoPanel, scene?.settings.infoPanel);
  const resolveImage = (fileId: string) => fileUrl(fileId, false);
  return (
    <div className={shellClass} ref={presentationRef}>
      <SeeViewer
        fullscreenRoot={presentationRef}
        onFullscreenChange={setFullscreen}
        ref={viewerRef}
        className="seePublicCanvas"
        scene={scene}
        resolveModelUrl={(fileId) => fileUrl(fileId, false)}
        resolveImageUrl={resolveImage}
        prefetchModelFileIds={loaded!.scenes.map((entry) => entry.modelFileId)}
        showAnnotations={showAnnotations}
        selectedAnnotationId={selectedAnnotationId}
        onSelectAnnotation={setSelectedAnnotationId}
        emptyMessage="Prezentace neobsahuje žádný model."
      />
      <header className="seePublicBar">
        <div className="seePublicTitle">
          <SeeCubeIcon size={18} />
          <strong>{loaded!.title}</strong>
        </div>
        {loaded!.scenes.length > 1 && (
          <SeeSceneSwitcher
            scenes={loaded!.scenes}
            activeId={scene?.id}
            onSelect={setActiveSceneId}
            className="seePublicScenes"
            tabClassName="seePublicScene"
            activeTabClassName="seePublicSceneActive"
          />
        )}
      </header>
      {scene && <SeeViewPresets className="seePublicViews" onSelect={(preset) => viewerRef.current?.setView(preset)} />}
      <SeeInfoDrawer content={panel} open={infoOpen && Boolean(panel)} onToggle={setInfoOpen} resolveImage={resolveImage} />
      <div className="seePublicTools">
        <button type="button" title="Výchozí pohled" aria-label="Výchozí pohled" onClick={() => viewerRef.current?.resetCamera()}><ToolIcon name="reset" /></button>
        {scene && scene.annotations.length > 0 && (
          <button type="button" className={showAnnotations ? "seeToggleOn" : "seeToggleOff"} title={showAnnotations ? "Skrýt 3D popisky" : "Zobrazit 3D popisky"} aria-label={showAnnotations ? "Skrýt 3D popisky" : "Zobrazit 3D popisky"} aria-pressed={showAnnotations} onClick={() => setShowAnnotations((value) => !value)}><ToolIcon name={showAnnotations ? "labels" : "labelsOff"} /></button>
        )}
        <button type="button" title="Informace" aria-label="Informace" aria-expanded={menu === "info"} onClick={() => setMenu((value) => (value === "info" ? undefined : "info"))}><ToolIcon name="info" /></button>
        {docs.length > 0 && (
          <button type="button" title="Dokumentace ke stažení" aria-label="Dokumentace ke stažení" aria-expanded={menu === "downloads"} onClick={() => setMenu((value) => (value === "downloads" ? undefined : "downloads"))}><ToolIcon name="download" /><span className="seeBadge">{docs.length}</span></button>
        )}
        <button type="button" title={fullscreen ? "Ukončit celou obrazovku" : "Celá obrazovka"} aria-label={fullscreen ? "Ukončit celou obrazovku" : "Celá obrazovka"} aria-pressed={fullscreen} onClick={() => viewerRef.current?.toggleFullscreen()}><ToolIcon name={fullscreen ? "exit" : "fullscreen"} /></button>
        {menu === "downloads" && (
          <div className="seePublicMenu" role="menu">
            <strong>Dokumentace{scene ? ` — ${scene.name}` : ""}</strong>
            {docs.map((document) => (
              <button key={document.id} type="button" role="menuitem" onClick={() => void download(document.id)}>
                <span>{fileDownloadName(document)}</span>
                <small>{document.mimeType === "application/pdf" ? "PDF" : document.mimeType === "image/png" ? "PNG" : "JPG"} · {formatFileSize(document.sizeBytes)}</small>
              </button>
            ))}
          </div>
        )}
        {menu === "info" && (
          <div className="seePublicMenu seePublicInfo">
            <strong>{loaded!.title}</strong>
            {loaded!.description && <p>{loaded!.description}</p>}
            {scene && <p><b>{scene.name}</b>{scene.description ? ` — ${scene.description}` : ""}</p>}
            <p className="seeMuted">Ovládání: tažení = otáčení, kolečko / dva prsty = přiblížení, pravé tlačítko / dva prsty = posun.</p>
            {embed && <a href={`/see/p/${slug}`} target="_blank" rel="noreferrer">Otevřít v novém okně</a>}
          </div>
        )}
      </div>
    </div>
  );
}

function StateScreen({ title, text, action }: Readonly<{ title: string; text?: string; action?: React.ReactNode }>) {
  return (
    <div className="seeState">
      <div className="seeStateCard">
        <SeeCubeIcon size={34} />
        <h1>{title}</h1>
        {text && <p>{text}</p>}
        {action}
      </div>
    </div>
  );
}

function ToolIcon({ name }: Readonly<{ name: "reset" | "labels" | "labelsOff" | "info" | "download" | "fullscreen" | "exit" }>) {
  const paths: Record<typeof name, string> = {
    reset: "M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4",
    // "message-square-text": a text label (the annotations), crossed out when they are hidden
    labels: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2zM7 8h10M7 12h7",
    labelsOff: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2zM7 8h10M7 12h7M3 3l18 18",
    info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 7.5v.5",
    download: "M12 4v11M7 10l5 5 5-5M5 20h14",
    fullscreen: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
    exit: "M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5",
  };
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}
