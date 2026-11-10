"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ActionBar } from "@/components/ui/workspace";
import { formatBytes, LIMITS_TEXT_CS } from "../../domain/support";
import { localFile, localFileProblem, type LocalFile } from "../../lib/support/supportClient";
import { ImageEditor } from "./ImageEditor";

const ACCEPT = "image/png,image/jpeg,image/webp,video/mp4,video/webm";

/**
 * One frame of a screen / window / tab the user picked; every track is stopped right after. The picker
 * opens on browser tabs (the original tab of the application) and leaves out the tab that asks — the
 * report form itself (V1-SUPPORT-03). Browsers without these hints simply show their usual picker.
 */
export const DISPLAY_MEDIA_OPTIONS = {
  video: { displaySurface: "browser" },
  audio: false,
  preferCurrentTab: false,
  selfBrowserSurface: "exclude",
  surfaceSwitching: "exclude",
  systemAudio: "exclude",
  monitorTypeSurfaces: "include",
} as const;

const CAPTURE_TIMEOUT_MS = 10_000;

export async function captureScreenFrame(): Promise<File | null> {
  const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  if (!media?.getDisplayMedia) throw new Error("unsupported");
  let stream: MediaStream;
  // Keep the user in the form: by default the browser switches to the captured tab, which hides this
  // one (its timers slow down and the user loses the form). Browsers without CaptureController ignore it.
  const ControllerClass = (globalThis as { CaptureController?: new () => { setFocusBehavior?: (behavior: string) => void } }).CaptureController;
  const controller = ControllerClass ? new ControllerClass() : undefined;
  try {
    stream = await media.getDisplayMedia({ ...DISPLAY_MEDIA_OPTIONS, ...(controller ? { controller } : {}) } as DisplayMediaStreamOptions);
    try {
      controller?.setFocusBehavior?.("focus-capturing-application"); // must run right after the picker resolves
    } catch {
      // too late or not supported — the capture still works
    }
  } catch (error) {
    // the user closed the browser's picker — not an error of the form
    if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "AbortError")) return null;
    throw error;
  }
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    // the first frame of another (background) tab can take a moment — but never wait forever
    const firstFrame = (async () => {
      await video.play();
      while (!video.videoWidth) await new Promise((resolve) => setTimeout(resolve, 50));
      // a short pause for a complete frame — timers, not requestAnimationFrame (it never fires in a hidden tab)
      await new Promise((resolve) => setTimeout(resolve, 150));
    })();
    const timedOut = await Promise.race([firstFrame.then(() => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(true), CAPTURE_TIMEOUT_MS))]);
    if (timedOut) throw new Error("timeout");
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    video.srcObject = null;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    return blob ? new File([blob], `snimek-obrazovky-${new Date().toISOString().slice(0, 19).replace(/[:T]/gu, "-")}.png`, { type: "image/png" }) : null;
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}

export const screenCaptureSupported = () => typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getDisplayMedia);

/**
 * Attachments of a report, reply or article — kept in the browser (with preview, edit and remove)
 * until the content is sent. Accepts a file (on a phone also a photo / screenshot from the gallery),
 * an image pasted with Ctrl+V (handled by the form via addPasted) and a screen capture.
 */
export function AttachmentPicker({ files, onChange, max, disabled, allowCapture = true, idPrefix, captureLabel = "Snímek obrazovky", captureHint }: Readonly<{ files: readonly LocalFile[]; onChange: (files: readonly LocalFile[]) => void; max: number; disabled?: boolean; allowCapture?: boolean; idPrefix: string; captureLabel?: string; captureHint?: string }>) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<LocalFile | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [captureAvailable, setCaptureAvailable] = useState(false);
  useEffect(() => setCaptureAvailable(allowCapture && screenCaptureSupported()), [allowCapture]);
  // a capture or a clipboard read finishes later — it must add to the CURRENT list, not to the one at
  // the time of the click (images pasted or files attached meanwhile would be lost)
  const filesRef = useRef(files);
  filesRef.current = files;

  function add(incoming: readonly File[]) {
    const accepted: LocalFile[] = [];
    const problems: string[] = [];
    for (const file of incoming) {
      const problem = localFileProblem(file);
      if (problem) problems.push(`${file.name || "Obrázek"}: ${problem}`);
      else accepted.push(localFile(file));
    }
    const current = filesRef.current;
    const room = Math.max(0, max - current.length);
    if (accepted.length > room) problems.push(`Nejvýš ${max} příloh.`);
    const next = [...current, ...accepted.slice(0, room)];
    filesRef.current = next;
    onChange(next);
    setNotice(problems.join(" "));
  }

  async function paste() {
    setNotice("");
    try {
      const items = await navigator.clipboard.read();
      const images: File[] = [];
      for (const item of items) {
        const type = item.types.find((candidate) => candidate === "image/png" || candidate === "image/jpeg" || candidate === "image/webp");
        if (type) images.push(new File([await item.getType(type)], `vlozeny-obrazek.${type.split("/")[1]}`, { type }));
      }
      if (images.length) add(images);
      else setNotice("Ve schránce není obrázek. Zkopírujte snímek obrazovky a zkuste to znovu, nebo použijte Ctrl+V.");
    } catch {
      setNotice("Prohlížeč nepovolil čtení schránky. Klikněte do formuláře a stiskněte Ctrl+V, nebo přiložte soubor.");
    }
  }

  async function capture() {
    setNotice("");
    setCapturing(true);
    try {
      const frame = await captureScreenFrame();
      if (frame) add([frame]);
      else setNotice("Zachycení obrazovky bylo zrušeno — nic se nestalo.");
    } catch (error) {
      setNotice(error instanceof Error && error.message === "timeout"
        ? "Vybraná karta neposlala obraz včas — zkuste to znovu, nebo vložte snímek přes Ctrl+V."
        : "Zachycení obrazovky tu není dostupné. Přiložte soubor nebo vložte obrázek ze schránky (Ctrl+V).");
    } finally {
      setCapturing(false);
    }
  }

  function remove(target: LocalFile) {
    URL.revokeObjectURL(target.previewUrl);
    onChange(files.filter((entry) => entry.key !== target.key));
  }

  return (
    <div className="grid gap-2" data-slot="attachment-picker">
      <ActionBar>
        <Button type="button" variant="outline" size="sm" disabled={disabled || files.length >= max} onClick={() => inputRef.current?.click()}>Přiložit soubor</Button>
        <Button type="button" variant="outline" size="sm" disabled={disabled || files.length >= max} onClick={() => void paste()}>Vložit ze schránky</Button>
        {captureAvailable && <Button type="button" variant="outline" size="sm" disabled={disabled || capturing || files.length >= max} onClick={() => void capture()}>{capturing ? "Vyberte kartu…" : captureLabel}</Button>}
        <input id={`${idPrefix}-file`} ref={inputRef} type="file" accept={ACCEPT} multiple className="sr-only" tabIndex={-1} onChange={(event) => { add([...(event.target.files ?? [])]); event.target.value = ""; }} />
      </ActionBar>
      {captureAvailable && captureHint && <p className="text-xs text-muted-foreground">{captureHint}</p>}
      <p className="text-xs text-muted-foreground">{LIMITS_TEXT_CS} Obrázek lze vložit i klávesami Ctrl+V. Soubory zůstávají jen ve vašem prohlížeči, dokud formulář neodešlete.</p>
      {notice && <p role="status" className="text-sm text-warning">{notice}</p>}
      {files.length > 0 && (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="Přílohy k odeslání">
          {files.map((entry) => {
            const image = entry.file.type.startsWith("image/");
            return (
              <li key={entry.key} className="grid min-w-0 gap-1 rounded-lg border bg-card p-2">
                {image ? <img src={entry.previewUrl} alt={`Náhled ${entry.file.name}`} className="h-24 w-full rounded object-contain bg-muted" /> : <span className="grid h-24 place-items-center rounded bg-muted text-xs text-muted-foreground">Video</span>}
                <span className="truncate text-xs" title={entry.file.name}>{entry.file.name}</span>
                <span className="text-xs text-muted-foreground">{formatBytes(entry.file.size)}{entry.edited ? " · upraveno" : ""}</span>
                <span className="flex flex-wrap gap-1">
                  {image && <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => setEditing(entry)}>Upravit</Button>}
                  <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => remove(entry)} aria-label={`Odebrat ${entry.file.name}`}>Odebrat</Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {editing && (
        <ImageEditor
          file={editing.file}
          onCancel={() => setEditing(null)}
          onDone={(edited) => {
            // the original (possibly unredacted) file is dropped here — only the edited image stays
            URL.revokeObjectURL(editing.previewUrl);
            onChange(files.map((entry) => (entry.key === editing.key ? localFile(edited, true) : entry)));
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

/** Ctrl+V anywhere in the form: images from the clipboard become attachments. */
export function pastedImages(event: React.ClipboardEvent): File[] {
  return [...event.clipboardData.items].flatMap((item) => (item.kind === "file" && item.type.startsWith("image/") ? [item.getAsFile()!].filter(Boolean) : []));
}
