"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export const READER_PAGE_WIDTH = 576;
const SPREAD_WIDTH = 1200;
export const MIN_READER_ZOOM = 0.5;
export const MAX_READER_ZOOM = 3;

export function ReaderViewport({ children, zoom, onZoom, currentPage }: {
  children: ReactNode;
  zoom: number;
  onZoom: (update: (zoom: number) => number) => void;
  currentPage: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [fitScale, setFitScale] = useState(1);
  const previousFitScale = useRef(1);
  const anchor = useRef<{ page: number; top: number; fraction: number } | null>(null);
  const rememberAnchor = useCallback(() => {
    const node = ref.current?.querySelector<HTMLElement>(`[data-page="${currentPage}"]`);
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const top = Math.max(130, rect.top);
    anchor.current = { page: currentPage, top, fraction: (top - rect.top) / rect.height };
  }, [currentPage]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      const next = Math.max(0.1, (node.clientWidth - 16) / SPREAD_WIDTH);
      if (Math.abs(next - previousFitScale.current) < 0.0001) return;
      rememberAnchor();
      previousFitScale.current = next;
      setFitScale(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [rememberAnchor]);

  useLayoutEffect(() => {
    if (zoom === 1 && ref.current) ref.current.scrollLeft = 0;
    const saved = anchor.current;
    anchor.current = null;
    if (!saved) return;
    const node = ref.current?.querySelector<HTMLElement>(`[data-page="${saved.page}"]`);
    if (!node) return;
    const rect = node.getBoundingClientRect();
    window.scrollBy({ top: rect.top + saved.fraction * rect.height - saved.top, behavior: "instant" });
  }, [fitScale, zoom]);

  useEffect(() => {
    const change = (update: (value: number) => number) => {
      rememberAnchor();
      onZoom((value) => Math.min(MAX_READER_ZOOM, Math.max(MIN_READER_ZOOM, update(value))));
    };
    const controlZoom = (event: Event) => {
      if (event.target instanceof Element && event.target.closest(".reader-zoom")) rememberAnchor();
    };
    const keydown = (event: KeyboardEvent) => {
      if (["Enter", " "].includes(event.key)) controlZoom(event);
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable=true]")) return;
      if (!["+", "=", "-", "0"].includes(event.key)) return;
      event.preventDefault();
      change((value) => event.key === "0" ? 1 : value + (event.key === "-" ? -0.1 : 0.1));
    };
    const wheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      change((value) => value * Math.exp(-event.deltaY * 0.002));
    };
    window.addEventListener("pointerdown", controlZoom, { capture: true });
    window.addEventListener("keydown", keydown, { capture: true });
    window.addEventListener("wheel", wheel, { passive: false, capture: true });
    return () => {
      window.removeEventListener("pointerdown", controlZoom, { capture: true });
      window.removeEventListener("keydown", keydown, { capture: true });
      window.removeEventListener("wheel", wheel, { capture: true });
    };
  }, [onZoom, rememberAnchor]);

  return (
    <div className="reader-viewport" ref={ref}>
      <div className="spreads" style={{ width: SPREAD_WIDTH, zoom: fitScale * zoom }}>{children}</div>
    </div>
  );
}
