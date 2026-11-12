"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/* ------------------------------------------------------------------ */
/* Text fields                                                         */
/* ------------------------------------------------------------------ */

type Size = "lg" | "md" | "sm" | "xs";
type Tone = "default" | "warn" | "ai";

const heights: Record<Size, string> = { lg: "h-11", md: "h-10", sm: "h-9", xs: "h-8 text-[13px]" };

const tones: Record<Tone, { idle: string; focus: string; within: string }> = {
  default: {
    idle: "border-line-strong bg-white hover:border-[#AEB6C1]",
    focus: "focus:border-accent focus:ring-3 focus:ring-accent/15",
    within: "focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/15",
  },
  warn: {
    idle: "border-[#E0B45C] bg-white hover:border-[#C99A3E]",
    focus: "focus:border-warn focus:ring-3 focus:ring-warn/20",
    within: "focus-within:border-warn focus-within:ring-3 focus-within:ring-warn/20",
  },
  ai: {
    idle: "border-[#C9BEEF] bg-[#F9F8FE] hover:border-[#A99BE0]",
    focus: "focus:border-ai focus:bg-white focus:ring-3 focus:ring-ai/15",
    within: "focus-within:border-ai focus-within:bg-white focus-within:ring-3 focus-within:ring-ai/15",
  },
};

const base =
  "min-w-0 rounded-lg border text-ink outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[#8A919C] disabled:cursor-not-allowed disabled:bg-[#F5F6F8] disabled:text-muted";

/** Classes for a themed <input> or <textarea>. Pass size "area" styles via `textarea` instead. */
export function field({ size = "lg", tone = "default" }: { size?: Size; tone?: Tone } = {}) {
  const t = tones[tone];
  return `${base} ${heights[size]} px-3 ${t.idle} ${t.focus}`;
}

export function textarea({ tone = "default" }: { tone?: Tone } = {}) {
  const t = tones[tone];
  return `${base} resize-y px-3 py-2.5 leading-6 ${t.idle} ${t.focus}`;
}

/** An input with a fixed prefix (e.g. "$"). The wrapper carries the border and focus ring. */
export function AffixInput({ prefix, size = "lg", className = "", ...props }: { prefix: React.ReactNode; size?: Size } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "size" | "prefix">) {
  const t = tones.default;
  return (
    // Tailwind orders hover after focus-within, so scope the hover border to the unfocused state.
    <span className={`flex items-center ${base} ${heights[size]} ${t.idle.replace("hover:", "not-focus-within:hover:")} ${t.within} ${className}`}>
      <span className="select-none pl-3 pr-1.5 text-muted">{prefix}</span>
      <input {...props} className="h-full min-w-0 flex-1 rounded-r-lg bg-transparent pr-3 outline-none" />
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Select                                                              */
/* ------------------------------------------------------------------ */

export type SelectOption<T extends string = string> = { value: T; label: string; hint?: string };

type SelectProps<T extends string> = {
  options: SelectOption<T>[];
  value?: T;
  defaultValue?: T;
  onChange?: (value: T) => void;
  /** Adds a hidden input so the value posts with a <form>. */
  name?: string;
  id?: string;
  "aria-label"?: string;
  size?: Size;
  tone?: Tone;
  disabled?: boolean;
  className?: string;
};

/** Themed, keyboard-accessible replacement for a native <select>. The list renders in a portal so tables can't clip it. */
export function Select<T extends string>({
  options, value, defaultValue, onChange, name, id, size = "lg", tone = "default", disabled, className = "", ...aria
}: SelectProps<T>) {
  const [inner, setInner] = useState<T | undefined>(defaultValue ?? options[0]?.value);
  const current = value ?? inner;
  const selectedIdx = Math.max(0, options.findIndex((o) => o.value === current));
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(selectedIdx);
  const [pos, setPos] = useState<React.CSSProperties | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const autoId = useId();
  const listId = `${id ?? autoId}-list`;

  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const want = Math.min(288, options.length * 38 + 10);
    const below = window.innerHeight - r.bottom;
    const up = below < want + 8 && r.top > below;
    setPos({
      position: "fixed", left: r.left, minWidth: r.width, maxWidth: Math.max(r.width, 360),
      ...(up ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }),
    });
  }, [options.length]);

  useLayoutEffect(() => { if (open) place(); }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!btnRef.current?.contains(t) && !listRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { document.removeEventListener("mousedown", onDown); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, place]);

  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const show = () => { setActive(selectedIdx); setOpen(true); };
  const choose = (i: number) => {
    const v = options[i]?.value;
    if (v === undefined) return;
    if (value === undefined) setInner(v);
    if (v !== current) onChange?.(v);
    setOpen(false);
    btnRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const last = options.length - 1;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); show(); }
      return;
    }
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); setActive((a) => Math.min(last, a + 1)); return;
      case "ArrowUp": e.preventDefault(); setActive((a) => Math.max(0, a - 1)); return;
      case "Home": e.preventDefault(); setActive(0); return;
      case "End": e.preventDefault(); setActive(last); return;
      case "Enter": case " ": e.preventDefault(); choose(active); return;
      case "Escape": e.preventDefault(); setOpen(false); return;
      case "Tab": setOpen(false); return;
    }
    if (e.key.length === 1) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at > 600 ? "" : typed.current.text) + e.key.toLowerCase(), at: now };
      const hit = options.findIndex((o) => o.label.toLowerCase().startsWith(typed.current.text));
      if (hit >= 0) setActive(hit);
    }
  };

  const t = tones[tone];
  const sel = options[selectedIdx];

  return (
    <>
      <button
        ref={btnRef}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        aria-label={aria["aria-label"]}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
        className={`flex w-full items-center justify-between gap-2 text-left ${base} ${heights[size]} px-3 ${t.idle} ${t.focus} ${open ? "border-accent ring-3 ring-accent/15" : ""} ${className}`}
      >
        <span className="truncate">{sel?.label}</span>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden
          className={`flex-none text-faint transition-transform duration-150 ${open ? "rotate-180" : ""}`}>
          <path d="M4 6 L8 10 L12 6" />
        </svg>
      </button>
      {name && <input type="hidden" name={name} value={current ?? ""} />}
      {open && pos && createPortal(
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={aria["aria-label"]}
          style={pos}
          className="ro-pop z-[70] max-h-72 overflow-auto rounded-[10px] border border-line bg-white p-1 shadow-[0_12px_32px_rgba(16,24,40,0.14),0_2px_6px_rgba(16,24,40,0.06)]"
        >
          {options.map((o, i) => {
            const isSel = i === selectedIdx;
            return (
              <li
                key={o.value}
                id={`${listId}-${i}`}
                data-idx={i}
                role="option"
                aria-selected={isSel}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(i)}
                className={`flex cursor-pointer items-center justify-between gap-3 rounded-md px-2.5 py-2 ${i === active ? "bg-[#EEF5F1]" : ""} ${isSel ? "font-semibold text-accent-ink" : "text-ink"}`}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{o.label}</span>
                  {o.hint && <span className="text-xs font-normal text-muted">{o.hint}</span>}
                </span>
                {isSel && (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="flex-none text-accent">
                    <path d="M3.5 8.5 L6.5 11.5 L12.5 4.5" />
                  </svg>
                )}
              </li>
            );
          })}
        </ul>,
        document.body,
      )}
    </>
  );
}
