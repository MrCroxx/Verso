"use client";

import { Minus, Plus, RotateCcw, Type, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
  DEFAULT_READER_TYPOGRAPHY,
  MAX_TRANSLATION_FONT_SIZE,
  MIN_TRANSLATION_FONT_SIZE,
  TRANSLATION_FONT_SIZE_STEP,
  normalizeReaderTypography,
  type ReaderTypography,
} from "../lib/reader-typography";

export function ReaderFontControls({ value, onChange, messages }: {
  value: ReaderTypography;
  onChange: (value: ReaderTypography) => void;
  messages: {
    label: string;
    title: string;
    size: string;
    decrease: string;
    increase: string;
    family: string;
    serif: string;
    sans: string;
    reset: string;
    close: string;
  };
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const slider = useRef<HTMLInputElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    slider.current?.focus({ preventScroll: true });
    const closeOutside = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };
  const resize = (translationFontSize: number) => onChange(normalizeReaderTypography({ ...value, translationFontSize }));

  return (
    <div className="reader-font-controls" ref={root} onKeyDown={(event) => {
      if (open && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    }}>
      <button type="button" className="reader-font-button" ref={trigger}
        aria-label={messages.title} title={messages.title} aria-haspopup="dialog"
        aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
        <Type size={17} /><span>{messages.label}</span>
      </button>
      {open && (
        <div className="reader-font-panel" id={id} role="dialog" aria-label={messages.title}>
          <div className="reader-font-heading">
            <strong>{messages.title}</strong>
            <button type="button" className="icon-button" aria-label={messages.close} onClick={close}><X size={16} /></button>
          </div>
          <div className="reader-font-label">
            <label htmlFor={`${id}-size`}>{messages.size}</label>
            <output htmlFor={`${id}-size`}>{value.translationFontSize}%</output>
          </div>
          <div className="reader-font-size">
            <button type="button" className="icon-button" aria-label={messages.decrease}
              disabled={value.translationFontSize <= MIN_TRANSLATION_FONT_SIZE}
              onClick={() => resize(value.translationFontSize - TRANSLATION_FONT_SIZE_STEP)}><Minus size={16} /></button>
            <input ref={slider} id={`${id}-size`} type="range" min={MIN_TRANSLATION_FONT_SIZE}
              max={MAX_TRANSLATION_FONT_SIZE} step={TRANSLATION_FONT_SIZE_STEP} value={value.translationFontSize}
              aria-valuetext={`${value.translationFontSize}%`} onChange={(event) => resize(Number(event.target.value))} />
            <button type="button" className="icon-button" aria-label={messages.increase}
              disabled={value.translationFontSize >= MAX_TRANSLATION_FONT_SIZE}
              onClick={() => resize(value.translationFontSize + TRANSLATION_FONT_SIZE_STEP)}><Plus size={16} /></button>
          </div>
          <fieldset className="reader-font-family">
            <legend>{messages.family}</legend>
            <div>
              {(["serif", "sans"] as const).map((family) => (
                <label key={family}>
                  <input type="radio" name={`${id}-family`} value={family} checked={value.translationFontFamily === family}
                    onChange={() => onChange({ ...value, translationFontFamily: family })} />
                  <span data-font={family}>{messages[family]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <button type="button" className="reader-font-reset"
            disabled={value.translationFontSize === DEFAULT_READER_TYPOGRAPHY.translationFontSize
              && value.translationFontFamily === DEFAULT_READER_TYPOGRAPHY.translationFontFamily}
            onClick={() => onChange({ ...DEFAULT_READER_TYPOGRAPHY })}><RotateCcw size={13} />{messages.reset}</button>
        </div>
      )}
    </div>
  );
}
