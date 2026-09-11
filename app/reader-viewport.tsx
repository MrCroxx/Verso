"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Minus, Plus } from "lucide-react";
import type { UiMessages } from "../lib/ui-messages";

export const READER_PAGE_WIDTH = 576;
const SPREAD_WIDTH = 1200;
const MIN_READER_ZOOM = 0.5;
const MAX_READER_ZOOM = 3;
const READER_ZOOM_STEP = 0.2;
const WHEEL_ZOOM_SENSITIVITY = 0.004;
type ZoomUpdate = (zoom: number) => number;
const ZoomContext = createContext({ zoom: 1, onZoom: (() => {}) as (update: ZoomUpdate) => void });

// Only the controls and viewport subscribe; a gesture never rerenders every book page.
export function ReaderZoomProvider({ children }: { children: ReactNode }) {
  const [zoom, setZoom] = useState(1);
  const onZoom = useCallback((update: ZoomUpdate) => {
    setZoom((value) => Math.min(MAX_READER_ZOOM, Math.max(MIN_READER_ZOOM, update(value))));
  }, []);
  const value = useMemo(() => ({ zoom, onZoom }), [zoom, onZoom]);
  return <ZoomContext value={value}>{children}</ZoomContext>;
}

export function ReaderZoomControls({ messages }: { messages: UiMessages }) {
  const { zoom, onZoom } = useContext(ZoomContext);
  return (
    <div className="reader-zoom" role="group" aria-label={messages.readerZoom}>
      <button className="icon-button" aria-label={messages.zoomOut} disabled={zoom <= MIN_READER_ZOOM} onClick={() => onZoom((value) => value - READER_ZOOM_STEP)}><Minus size={16} /></button>
      <button className="zoom-fit" title={messages.fitWidth} onClick={() => onZoom(() => 1)}>{Math.round(zoom * 100)}%</button>
      <button className="icon-button" aria-label={messages.zoomIn} disabled={zoom >= MAX_READER_ZOOM} onClick={() => onZoom((value) => value + READER_ZOOM_STEP)}><Plus size={16} /></button>
      <button className="zoom-fit" onClick={() => onZoom(() => 1)}>{messages.fitWidth}</button>
    </div>
  );
}

type ZoomAnchor = { page: number; x: number; y: number; fractionX: number; fractionY: number };

export function ReaderViewport({ children, currentPage }: {
  children: ReactNode;
  currentPage: number;
}) {
  const { zoom, onZoom } = useContext(ZoomContext);
  const ref = useRef<HTMLDivElement>(null);
  const spreadsRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const horizontal = useRef({ available: SPREAD_WIDTH, width: SPREAD_WIDTH });
  const gesture = useRef({ active: false, timer: 0, settleFrame: 0, anchor: null as ZoomAnchor | null });
  const [geometry, setGeometry] = useState({ fitScale: 1, height: 0 });
  const anchor = useRef<ZoomAnchor | null>(null);
  const currentPageRef = useRef(currentPage);
  useLayoutEffect(() => { currentPageRef.current = currentPage; }, [currentPage]);
  const rememberAnchor = useCallback((point?: { x: number; y: number }) => {
    const viewport = ref.current;
    if (!viewport) return;
    // Use the page under the gesture, including when the pointer is over its translation.
    const pointedPage = point && document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>("[data-page]");
    const node = pointedPage && viewport.contains(pointedPage)
      ? pointedPage : viewport.querySelector<HTMLElement>(`[data-page="${currentPageRef.current}"]`);
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    const x = point?.x ?? viewportRect.left + viewport.clientWidth / 2;
    const y = point?.y ?? Math.max(130, rect.top);
    anchor.current = { page: Number(node.dataset.page), x, y,
      fractionX: (x - rect.left) / rect.width, fractionY: (y - rect.top) / rect.height };
  }, []);

  useLayoutEffect(() => {
    const viewport = ref.current;
    const spreads = spreadsRef.current;
    if (!viewport || !spreads) return;
    let previousWidth = 0;
    const measure = () => {
      const width = viewport.clientWidth;
      if (previousWidth && width !== previousWidth) rememberAnchor();
      previousWidth = width;
      const fitScale = Math.max(0.1, (width - 16) / SPREAD_WIDTH);
      const height = spreads.offsetHeight;
      setGeometry((previous) => previous.fitScale === fitScale && previous.height === height
        ? previous : { fitScale, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(spreads);
    return () => observer.disconnect();
  }, [rememberAnchor]);

  const positionHorizontally = useCallback((left: number) => {
    const viewport = ref.current;
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!viewport || !stage || !canvas) return;
    const { available, width } = horizontal.current;
    const padding = Math.max(0, left);
    const scroll = Math.max(0, -left);
    // Reserve space before scrolling so native scroll limits cannot change the zoom origin.
    stage.style.width = `${Math.max(available + scroll, width + padding)}px`;
    canvas.style.marginLeft = `${padding}px`;
    viewport.scrollLeft = scroll;
  }, []);

  const settleHorizontalPosition = useCallback((animatePosition = true) => {
    const viewport = ref.current;
    const canvas = canvasRef.current;
    if (!viewport || !canvas) return;
    gesture.current.active = false;
    gesture.current.anchor = null;
    window.cancelAnimationFrame(gesture.current.settleFrame);
    const { available, width } = horizontal.current;
    const from = canvas.getBoundingClientRect().left - viewport.getBoundingClientRect().left - 8;
    const to = width <= available ? (available - width) / 2 : Math.max(available - width, Math.min(0, from));
    if (!animatePosition || Math.abs(to - from) < 0.5 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      positionHorizontally(to);
      return;
    }
    const start = performance.now();
    const animate = (time: number) => {
      const progress = Math.min(1, (time - start) / 160);
      positionHorizontally(from + (to - from) * (1 - (1 - progress) ** 3));
      gesture.current.settleFrame = progress < 1 ? window.requestAnimationFrame(animate) : 0;
    };
    gesture.current.settleFrame = window.requestAnimationFrame(animate);
  }, [positionHorizontally]);

  useLayoutEffect(() => {
    const viewport = ref.current;
    const saved = anchor.current;
    anchor.current = null;
    if (!viewport) return;
    const available = SPREAD_WIDTH * geometry.fitScale;
    const width = available * zoom;
    horizontal.current = { available, width };
    const node = saved && viewport.querySelector<HTMLElement>(`[data-page="${saved.page}"]`);
    const rect = node?.getBoundingClientRect();
    let left = saved && rect
      ? saved.x - viewport.getBoundingClientRect().left - 8 - saved.fractionX * rect.width
      : -viewport.scrollLeft;
    if (!gesture.current.active) {
      window.cancelAnimationFrame(gesture.current.settleFrame);
      left = width <= available ? (available - width) / 2 : Math.max(available - width, Math.min(0, left));
    }
    positionHorizontally(left);
    if (saved && rect) {
      window.scrollBy({ top: rect.top + saved.fractionY * rect.height - saved.y, behavior: "instant" });
    }
  }, [geometry.fitScale, zoom, positionHorizontally]);

  useEffect(() => {
    let frame = 0;
    let delta = 0;
    let point = { x: 0, y: 0 };
    const stopGesture = () => {
      window.clearTimeout(gesture.current.timer);
      window.cancelAnimationFrame(gesture.current.settleFrame);
      gesture.current.active = false;
      gesture.current.anchor = null;
    };
    const controlZoom = (event: Event) => {
      if (event.target instanceof Element && event.target.closest(".reader-zoom")) {
        stopGesture();
        settleHorizontalPosition(false);
        rememberAnchor();
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (["Enter", " "].includes(event.key)) controlZoom(event);
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable=true]")) return;
      if (!["+", "=", "-", "0"].includes(event.key)) return;
      event.preventDefault();
      stopGesture();
      settleHorizontalPosition(false);
      rememberAnchor();
      onZoom((value) => event.key === "0" ? 1 : value + (event.key === "-" ? -READER_ZOOM_STEP : READER_ZOOM_STEP));
    };
    const wheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) {
        if (gesture.current.active) {
          window.clearTimeout(gesture.current.timer);
          settleHorizontalPosition();
        }
        return;
      }
      event.preventDefault();
      window.clearTimeout(gesture.current.timer);
      window.cancelAnimationFrame(gesture.current.settleFrame);
      gesture.current.active = true;
      gesture.current.timer = window.setTimeout(settleHorizontalPosition, 180);
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
      delta += event.deltaY * unit;
      point = { x: event.clientX, y: event.clientY };
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const saved = gesture.current.anchor;
        if (saved && saved.x === point.x && saved.y === point.y) anchor.current = saved;
        else {
          rememberAnchor(point);
          gesture.current.anchor = anchor.current;
        }
        const factor = Math.exp(-delta * WHEEL_ZOOM_SENSITIVITY);
        delta = 0;
        onZoom((value) => value * factor);
      });
    };
    window.addEventListener("click", controlZoom, { capture: true });
    window.addEventListener("keydown", keydown, { capture: true });
    window.addEventListener("wheel", wheel, { passive: false, capture: true });
    return () => {
      window.cancelAnimationFrame(frame);
      stopGesture();
      window.removeEventListener("click", controlZoom, { capture: true });
      window.removeEventListener("keydown", keydown, { capture: true });
      window.removeEventListener("wheel", wheel, { capture: true });
    };
  }, [onZoom, rememberAnchor, settleHorizontalPosition]);

  const scale = geometry.fitScale * zoom;
  return (
    <div className="reader-viewport" ref={ref}>
      <div className="reader-stage" ref={stageRef} style={{ width: Math.max(SPREAD_WIDTH * geometry.fitScale, SPREAD_WIDTH * scale) }}>
        <div className="reader-canvas" ref={canvasRef} style={{ width: SPREAD_WIDTH * scale, height: geometry.height * scale }}>
          <div className="spreads" ref={spreadsRef} style={{ width: SPREAD_WIDTH, transform: `scale(${scale})` }}>{children}</div>
        </div>
      </div>
    </div>
  );
}
