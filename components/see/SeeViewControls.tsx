"use client";

import { useEffect, useId, useRef, useState } from "react";
import { SEE_VIEW_PRESET_LABELS_CS, SEE_VIEW_PRESET_SHORT_CS, SEE_VIEW_PRESETS, type SeeViewPreset } from "../../domain/seeCameraFit";
import { isPanelContentEmpty, type SeeInfoPanelContent } from "../../domain/seeContent";
import { SeeExternalLink, SeeImage, SeeRichText } from "./SeeMedia";

/** Small cube-face pictograms for the quick views (one shared stroke style). */
function ViewIcon({ preset }: Readonly<{ preset: SeeViewPreset }>) {
  const faces: Record<SeeViewPreset, string> = {
    default: "M12 3 20 7.5v9L12 21l-8-4.5v-9z M4 7.5 12 12l8-4.5M12 12v9",
    front: "M6 6h12v12H6z",
    back: "M6 6h12v12H6z M6 6l12 12",
    left: "M6 6h6v12H6z M12 6l6 3v6l-6 3",
    right: "M12 6h6v12h-6z M12 6 6 9v6l6 3",
    top: "M5 9l7-4 7 4-7 4z M5 9v6l7 4 7-4V9",
    bottom: "M5 15l7 4 7-4-7-4z M5 15V9l7-4 7 4v6",
  };
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
      <path d={faces[preset]} />
    </svg>
  );
}

/**
 * Quick camera views (top right of the viewer). Wide screens: a compact toolbar; phones: one
 * button opening a short list. Every button has an accessible Czech name.
 */
export function SeeViewPresets({ onSelect, className }: Readonly<{ onSelect: (preset: SeeViewPreset) => void; className?: string }>) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<SeeViewPreset | undefined>();
  const listId = useId();
  const choose = (preset: SeeViewPreset) => {
    setActive(preset);
    setOpen(false);
    onSelect(preset);
  };
  return (
    <div className={`seeViewPresets ${open ? "seeViewPresetsOpen" : ""} ${className ?? ""}`}>
      <button type="button" className="seeViewPresetsToggle" aria-expanded={open} aria-controls={listId} aria-label="Pohledy kamery" title="Pohledy kamery" onClick={() => setOpen((value) => !value)}>
        <ViewIcon preset="default" />
        <span>Pohled</span>
      </button>
      <div className="seeViewPresetsList" id={listId} role="toolbar" aria-label="Pohledy kamery">
        {SEE_VIEW_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            className={active === preset ? "seeViewPreset seeViewPresetActive" : "seeViewPreset"}
            title={SEE_VIEW_PRESET_LABELS_CS[preset]}
            aria-label={SEE_VIEW_PRESET_LABELS_CS[preset]}
            aria-pressed={active === preset}
            onClick={() => choose(preset)}
          >
            <ViewIcon preset={preset} />
            <span className="seeViewPresetLabel">{SEE_VIEW_PRESET_SHORT_CS[preset]}</span>
            <span className="seeViewPresetLong">{SEE_VIEW_PRESET_LABELS_CS[preset]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Panel body shared by the public drawer and the editor preview. */
export function SeeInfoPanelBody({ content, resolveImage }: Readonly<{ content: SeeInfoPanelContent; resolveImage?: (fileId: string) => Promise<string> }>) {
  return (
    <>
      {content.title && <h2 className="seeInfoTitle">{content.title}</h2>}
      {content.imageFileId && resolveImage && <SeeImage fileId={content.imageFileId} resolve={resolveImage} alt={content.title || "Obrázek"} className="seeInfoImage" />}
      {content.body && <SeeRichText text={content.body} />}
      {content.links.length > 0 && (
        <div className="seeInfoLinks">
          {content.links.map((link, index) => <SeeExternalLink key={`${link.url}-${index}`} link={link} />)}
        </div>
      )}
    </>
  );
}

/**
 * Optional right-hand information panel of the public viewer. Closed by default on every visit;
 * the trigger exists only when there is content. Desktop: drawer from the right (320–420 px);
 * phones: bottom sheet. Closes with ×, the trigger again, or Esc; the rest of the model stays
 * interactive.
 */
export function SeeInfoDrawer({ content, open, onToggle, resolveImage }: Readonly<{
  content: SeeInfoPanelContent | undefined;
  open: boolean;
  onToggle: (open: boolean) => void;
  resolveImage?: (fileId: string) => Promise<string>;
}>) {
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!open) {
      if (wasOpen.current) triggerRef.current?.focus({ preventScroll: true });
      wasOpen.current = false;
      return undefined;
    }
    wasOpen.current = true;
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onToggle(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onToggle]);
  if (isPanelContentEmpty(content)) return null;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={open ? "seeInfoTrigger seeInfoTriggerOpen" : "seeInfoTrigger"}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? "Zavřít informační panel" : "Otevřít informační panel"}
        title={open ? "Zavřít informace" : "Informace k modelu"}
        onClick={() => onToggle(!open)}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={open ? "M9 6l6 6-6 6" : "M15 6l-6 6 6 6"} />
        </svg>
      </button>
      <aside id={panelId} className={open ? "seeInfoDrawer seeInfoDrawerOpen" : "seeInfoDrawer"} aria-hidden={!open} aria-label="Informační panel" inert={!open}>
        <div className="seeInfoDrawerHead">
          <span className="seeInfoDrawerHandle" aria-hidden="true" />
          <button ref={closeRef} type="button" className="seeInfoClose" aria-label="Zavřít informační panel" onClick={() => onToggle(false)}>×</button>
        </div>
        {open && content && (
          <div className="seeInfoDrawerBody">
            <SeeInfoPanelBody content={content} resolveImage={resolveImage} />
          </div>
        )}
      </aside>
    </>
  );
}

/**
 * Model switcher built from the dynamic list of scenes (any number). Horizontal scrolling keeps
 * the active model in view, ←/→/Home/End move between models, and with many models a phone shows
 * a compact select instead of a long row of tabs.
 */
export function SeeSceneSwitcher({ scenes, activeId, onSelect, className, tabClassName, activeTabClassName, trailing }: Readonly<{
  scenes: readonly Readonly<{ id: string; name: string; missingModel?: boolean }>[];
  activeId: string | undefined;
  onSelect: (id: string) => void;
  className: string;
  tabClassName: string;
  activeTabClassName: string;
  trailing?: React.ReactNode;
}>) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>("[aria-selected=true]");
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, scenes.length]);
  const onKeyDown = (event: React.KeyboardEvent) => {
    const index = scenes.findIndex((scene) => scene.id === activeId);
    const next = event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? scenes.length - 1 : undefined;
    if (next === undefined || !scenes.length) return;
    event.preventDefault();
    const target = scenes[(next + scenes.length) % scenes.length];
    onSelect(target.id);
    listRef.current?.querySelector<HTMLElement>(`[data-scene-id="${target.id}"]`)?.focus();
  };
  return (
    <div className={`${className} ${scenes.length > 4 ? "seeManyScenes" : ""}`}>
      <div className="seeSceneTabList" role="tablist" aria-label="Modely" ref={listRef} onKeyDown={onKeyDown}>
        {scenes.map((scene, index) => (
          <button
            key={scene.id}
            data-scene-id={scene.id}
            type="button"
            role="tab"
            aria-selected={scene.id === activeId}
            tabIndex={scene.id === activeId ? 0 : -1}
            className={scene.id === activeId ? `${tabClassName} ${activeTabClassName}` : tabClassName}
            title={`${index + 1}. ${scene.name}`}
            onClick={() => onSelect(scene.id)}
          >
            {scene.name}
            {scene.missingModel && <span className="seeDot" title="Chybí GLB" />}
          </button>
        ))}
        {trailing}
      </div>
      {scenes.length > 4 && (
        <select className="seeSceneSelect" aria-label="Vybrat model" value={activeId} onChange={(event) => onSelect(event.target.value)}>
          {scenes.map((scene, index) => <option key={scene.id} value={scene.id}>{`${index + 1}. ${scene.name}`}</option>)}
        </select>
      )}
    </div>
  );
}
