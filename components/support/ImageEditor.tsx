"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ActionBar } from "@/components/ui/workspace";
import { applyImageEdits, hasRedaction, MARK_COLOR, type ImageEdit, type Point } from "../../domain/support";

type Tool = "rect" | "draw" | "redact";
const TOOL_LABELS: Readonly<Record<Tool, string>> = { rect: "Obdélník", draw: "Kresba", redact: "Zakrýt" };
const MARK = `rgba(${MARK_COLOR[0]}, ${MARK_COLOR[1]}, ${MARK_COLOR[2]}, 1)`;

/**
 * Simple screenshot editing (V1-SUPPORT-01): mark the problem with a rectangle or a freehand line,
 * hide a sensitive part with an opaque black rectangle. The result is a NEW PNG whose pixels already
 * contain the edits (domain applyImageEdits) — the original is replaced locally and never sent.
 */
export function ImageEditor({ file, onDone, onCancel }: Readonly<{ file: File; onDone: (edited: File, redacted: boolean) => void; onCancel: () => void }>) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<Tool>("rect");
  const [edits, setEdits] = useState<readonly ImageEdit[]>([]);
  const [current, setCurrent] = useState<ImageEdit | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false; // a superseded load (re-run of the effect) must not report an error or draw
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      setError("");
      imageRef.current = image;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
      }
      redraw([], null);
    };
    image.onerror = () => { if (!cancelled) setError("Obrázek se nepodařilo otevřít."); };
    image.src = url;
    return () => {
      cancelled = true;
      URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  function redraw(list: readonly ImageEdit[], live: ImageEdit | null) {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !image || !context) return;
    context.drawImage(image, 0, 0);
    const width = Math.max(3, Math.round(canvas.width / 300));
    for (const edit of live ? [...list, live] : list) {
      if (edit.type === "redact") {
        context.fillStyle = "#000";
        context.fillRect(Math.min(edit.from.x, edit.to.x), Math.min(edit.from.y, edit.to.y), Math.abs(edit.to.x - edit.from.x), Math.abs(edit.to.y - edit.from.y));
      } else if (edit.type === "rect") {
        context.strokeStyle = MARK;
        context.lineWidth = width;
        context.strokeRect(edit.from.x, edit.from.y, edit.to.x - edit.from.x, edit.to.y - edit.from.y);
      } else {
        context.strokeStyle = MARK;
        context.lineWidth = width;
        context.lineJoin = "round";
        context.beginPath();
        edit.points.forEach((point, index) => (index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y)));
        context.stroke();
      }
    }
  }

  useEffect(() => redraw(edits, current), [edits, current]);

  const pointOf = (event: React.PointerEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current!;
    const box = canvas.getBoundingClientRect();
    return { x: ((event.clientX - box.left) / box.width) * canvas.width, y: ((event.clientY - box.top) / box.height) * canvas.height };
  };

  function down(event: React.PointerEvent<HTMLCanvasElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointOf(event);
    setCurrent(tool === "draw" ? { type: "draw", points: [point] } : { type: tool, from: point, to: point });
  }
  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!current) return;
    const point = pointOf(event);
    setCurrent(current.type === "draw" ? { type: "draw", points: [...current.points, point] } : { ...current, to: point });
  }
  function up() {
    if (!current) return;
    const tiny = current.type === "draw" ? current.points.length < 2 : Math.abs(current.to.x - current.from.x) < 3 || Math.abs(current.to.y - current.from.y) < 3;
    if (!tiny) setEdits([...edits, current]);
    setCurrent(null);
  }

  async function finish() {
    const image = imageRef.current;
    if (!image) return;
    setBusy(true);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      applyImageEdits(pixels, edits, Math.max(3, Math.round(canvas.width / 300)));
      context.putImageData(pixels, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("export");
      const base = (file.name || "snimek").replace(/\.[^.]+$/u, "");
      onDone(new File([blob], `${base}-upraveno.png`, { type: "image/png" }), hasRedaction(edits));
    } catch {
      setError("Úpravu se nepodařilo uložit.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="max-h-[94vh] w-[calc(100vw-1rem)] max-w-5xl overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Upravit obrázek</DialogTitle>
          <DialogDescription>Označte problém, nebo zakryjte citlivé údaje černým obdélníkem. Odešle se jen upravený obrázek.</DialogDescription>
        </DialogHeader>
        <ActionBar role="group" aria-label="Nástroj">
          {(Object.keys(TOOL_LABELS) as Tool[]).map((key) => (
            <Button key={key} type="button" size="sm" variant={tool === key ? "default" : "outline"} aria-pressed={tool === key} onClick={() => setTool(key)}>{TOOL_LABELS[key]}</Button>
          ))}
          <Button type="button" size="sm" variant="ghost" disabled={!edits.length} onClick={() => setEdits(edits.slice(0, -1))}>Zpět</Button>
        </ActionBar>
        <div className="overflow-auto rounded-lg border bg-muted p-2">
          <canvas
            ref={canvasRef}
            className="mx-auto block h-auto max-h-[60vh] w-auto max-w-full cursor-crosshair touch-none"
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            aria-label="Obrázek k úpravě"
          />
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>Zrušit</Button>
          <Button type="button" onClick={() => void finish()} disabled={busy}>{busy ? "Ukládám…" : "Použít úpravy"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
