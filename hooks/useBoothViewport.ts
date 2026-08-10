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
  panViewport,
  screenToWorld,
  zoomAroundScreenPoint,
  type ViewportSize,
  type ViewportTransform,
} from "../geometry/viewport";

type UseBoothViewportOptions = {
  worldWidthMm: number;
  worldHeightMm: number;
  enabled: boolean;
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
  }, [worldWidthMm, worldHeightMm]);

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

      if (!initializedRef.current && nextSize.width > 0 && nextSize.height > 0) {
        initializedRef.current = true;
        setTransform(fitWorldToViewport(nextSize, worldSize));
      }
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, worldWidthMm, worldHeightMm]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const element = viewportRef.current;
    if (!element) {
      return;
    }

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) {
        return;
      }

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
  }, [enabled]);

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
    startPan,
    movePan,
    endPan,
    clientToWorld,
  };
}
