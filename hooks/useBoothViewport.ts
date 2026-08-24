"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  DEFAULT_PIXELS_PER_MM,
  centerWorld,
  fitWorldToViewport,
  fitBoundsToViewport,
  panViewport,
  resolveInitialViewportFit,
  screenToWorld,
  zoomAroundScreenPoint,
  type ViewportSize,
  type ViewportTransform,
  type WorldBounds,
} from "../geometry/viewport";

type UseBoothViewportOptions = {
  worldWidthMm: number;
  worldHeightMm: number;
  enabled: boolean;
  /**
   * The bounds the INITIAL auto-fit (and any re-fit triggered by fitKey changing) should target,
   * if different from the full worldWidthMm×worldHeightMm rectangle — e.g. Individual mode's
   * real (usually much smaller) plot polygon inside a large 10×10 m workspace canvas. Omitted =
   * unchanged behavior (fit to the full world rectangle), which is what typovka always uses.
   */
  fitBounds?: WorldBounds;
  /**
   * Changing this value forces a fresh auto-fit on the NEXT size measurement, even if the
   * viewport element's pixel size hasn't actually changed. Needed because this hook is called
   * ONCE per owning component (React hooks can't be conditional) while the DOM element it
   * measures can be conditionally mounted/unmounted by the caller (e.g. Individual mode's
   * Konstrukce/Mobiliář tabs share one call to this hook but their .configuratorWorkspace only
   * mounts once a plan/3D-bearing tab is entered) — without this, re-entering a tab whose
   * container just remounted would silently keep the STALE transform from before, since neither
   * `enabled` nor worldWidthMm/worldHeightMm necessarily changed. Typovka never passes this, so
   * its behavior is completely unaffected.
   */
  fitKey?: string | number;
  /** Initial auto-fit waits until the booth's current visual (GLB or fallback) is ready. */
  initialFitReady?: boolean;
};

type PanSession = {
  pointerId: number;
  clientX: number;
  clientY: number;
  panX: number;
  panY: number;
};

export function useBoothViewport({
  worldWidthMm,
  worldHeightMm,
  enabled,
  fitBounds,
  fitKey,
  initialFitReady = true,
}: UseBoothViewportOptions) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const initializedRef = useRef(false);
  const panSessionRef = useRef<PanSession | null>(null);
  const [viewportSize, setViewportSize] = useState<ViewportSize>({
    width: 0,
    height: 0,
  });
  const [transform, setTransform] = useState<ViewportTransform>({
    zoom: 1,
    pan: { x: 0, y: 0 },
  });
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const [isPanning, setIsPanning] = useState(false);

  const worldSize = { width: worldWidthMm, height: worldHeightMm };

  useEffect(() => {
    initializedRef.current = false;
  }, [worldWidthMm, worldHeightMm, fitKey]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const element = viewportRef.current;
    if (!element) {
      return;
    }

    const updateSize = () => {
      const nextSize = {
        width: element.clientWidth,
        height: element.clientHeight,
      };
      setViewportSize(nextSize);

      const initialFit = resolveInitialViewportFit({
        initialized: initializedRef.current,
        visualReady: initialFitReady,
        viewport: nextSize,
        world: worldSize,
        fitBounds,
      });
      if (initialFit) {
        initializedRef.current = true;
        setTransform(initialFit);
      }
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, worldWidthMm, worldHeightMm, fitKey, initialFitReady]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const element = viewportRef.current;
    if (!element) {
      return;
    }

    const handleWheel = (event: WheelEvent) => {
      // Scoped to THIS element only (addEventListener below, not window/document) — plain wheel
      // zooms the plan directly, and Ctrl+wheel over this element is handled the exact same way
      // (never left to fall through to the browser's own page-zoom) since preventDefault always
      // runs here. Wheel/trackpad events outside this element are never touched — the browser
      // behaves completely normally there.
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const anchor = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      setTransform((current) =>
        zoomAroundScreenPoint(current, current.zoom * factor, anchor),
      );
    };

    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
    // fitKey (not just `enabled`) so this re-attaches when the DOM element this hook measures
    // gets freshly (re)mounted by a conditionally-rendered caller — see the fitKey doc comment
    // above. Without it, `enabled` can already be true (and this effect already have run once,
    // finding viewportRef.current still null) BEFORE the element actually mounts, permanently
    // skipping the listener for the element's entire later lifetime — this was the exact cause
    // of "wheel does nothing over the 2D plan" for Individual mode's Konstrukce/Mobiliář tabs.
  }, [enabled, fitKey]);

  useEffect(() => {
    if (!enabled) {
      setIsSpacePressed(false);
      return;
    }

    const isEditableTarget = (target: EventTarget | null) =>
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLButtonElement ||
      target instanceof HTMLAnchorElement ||
      (target instanceof HTMLElement && target.isContentEditable);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space" && !isEditableTarget(event.target)) {
        event.preventDefault();
        setIsSpacePressed(true);
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        setIsSpacePressed(false);
      }
    };
    const handleBlur = () => setIsSpacePressed(false);

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, [enabled]);

  const zoomAt = useCallback((zoom: number, anchor?: { x: number; y: number }) => {
    setTransform((current) =>
      zoomAroundScreenPoint(
        current,
        zoom,
        anchor ?? {
          x: viewportSize.width / 2,
          y: viewportSize.height / 2,
        },
      ),
    );
  }, [viewportSize]);

  const zoomIn = () => zoomAt(transform.zoom * 1.25);
  const zoomOut = () => zoomAt(transform.zoom / 1.25);
  const resetZoom = () => setTransform(centerWorld(viewportSize, worldSize, 1));
  const fitToBooth = () => setTransform(fitWorldToViewport(viewportSize, worldSize));
  const fitToContent = (bounds: WorldBounds) =>
    setTransform(fitBoundsToViewport(viewportSize, bounds));

  const startPan = (event: ReactPointerEvent<HTMLDivElement>): boolean => {
    const shouldPan = event.button === 1 || (event.button === 0 && isSpacePressed);
    if (!shouldPan) {
      return false;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    panSessionRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      panX: transform.pan.x,
      panY: transform.pan.y,
    };
    setIsPanning(true);
    return true;
  };

  const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const session = panSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) {
      return;
    }

    setTransform((current) =>
      panViewport(
        {
          ...current,
          pan: { x: session.panX, y: session.panY },
        },
        {
          x: event.clientX - session.clientX,
          y: event.clientY - session.clientY,
        },
      ),
    );
  };

  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (panSessionRef.current?.pointerId !== event.pointerId) {
      return;
    }

    panSessionRef.current = null;
    setIsPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const clientToWorld = (clientX: number, clientY: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) {
      return null;
    }

    return screenToWorld(
      { x: clientX - rect.left, y: clientY - rect.top },
      transform,
    );
  };

  return {
    viewportRef,
    transform,
    zoomPercent: Math.round(transform.zoom * 100),
    pixelsPerMm: DEFAULT_PIXELS_PER_MM,
    isSpacePressed,
    isPanning,
    zoomIn,
    zoomOut,
    resetZoom,
    fitToBooth,
    fitToContent,
    startPan,
    movePan,
    endPan,
    clientToWorld,
  };
}
