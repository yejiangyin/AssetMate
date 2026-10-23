import { ArrowLeft, Check, ChevronDown, Info, MoreHorizontal, ShieldAlert, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

// Shared building blocks for the AI connection settings (model, search and DataPro views).

export const CONTROL_CLASS = "min-h-9 w-full rounded-lg border border-app-border bg-app-surface px-3 py-2 text-[12px] leading-4 text-tp outline-none transition-colors placeholder:text-tmi focus:border-app-accent focus:ring-2 focus:ring-[rgba(79,156,249,0.12)]";
export const LABEL_CLASS = "mb-1 block text-[11px] font-medium leading-4 text-tm";

export type Tone = "ok" | "warn" | "danger" | "accent" | "muted";

const TONE_CLASS: Record<Tone, string> = {
  ok: "bg-[rgba(49,208,139,0.12)] text-[#1F9D6A]",
  warn: "bg-[rgba(245,158,11,0.12)] text-[#C27C0E]",
  danger: "bg-[rgba(242,78,78,0.1)] text-[#D94A4A]",
  accent: "bg-[rgba(79,156,249,0.12)] text-app-accent",
  muted: "bg-app-surface text-tmi",
};

export function SelectField({
  value,
  onChange,
  children,
  ariaLabel,
  className = "",
  disabled = false,
}: {
  value: string | number;
  onChange: (value: string) => void;
  children: ReactNode;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div className={`relative min-w-0 ${className}`}>
      <select
        aria-label={ariaLabel}
        className={`${CONTROL_CLASS} appearance-none truncate pr-8 disabled:cursor-not-allowed disabled:opacity-60`}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
      <ChevronDown aria-hidden="true" size={12} strokeWidth={1.8} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-tmi" />
    </div>
  );
}

export function Field({ label, hint, children, className = "" }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`block min-w-0 ${className}`}>
      <span className={LABEL_CLASS}>{label}</span>
      {children}
      {hint && <span className="mt-1 block px-0.5 text-[11px] leading-4 text-tmi">{hint}</span>}
    </label>
  );
}

export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-3 ${TONE_CLASS[tone]}`}>{children}</span>;
}

export function SettingsSection({
  title,
  description,
  action,
  children,
  ariaLabel,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  ariaLabel?: string;
}) {
  return (
    <section aria-label={ariaLabel ?? title} className="rounded-xl border border-app-border bg-app-card p-3">
      <div className="mb-2.5 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[12px] font-semibold leading-4 text-tp">{title}</h3>
          {description && <p className="mt-0.5 text-[11px] leading-4 text-tmi">{description}</p>}
        </div>
        {action && <div className="flex shrink-0 items-center gap-1.5">{action}</div>}
      </div>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

export function Switch({ checked, onChange, label, description }: { checked: boolean; onChange: (checked: boolean) => void; label: string; description?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-[12px] leading-4 text-ts">{label}</p>
        {description && <p className="mt-0.5 text-[11px] leading-4 text-tmi">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? "bg-app-accent" : "bg-app-control"}`}
      >
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${checked ? "translate-x-[18px]" : "translate-x-0.5"}`} />
      </button>
    </div>
  );
}

export function Notice({ tone = "accent", children }: { tone?: "accent" | "warn" | "muted"; children: ReactNode }) {
  const Icon = tone === "warn" ? ShieldAlert : Info;
  const className = tone === "warn"
    ? "bg-[rgba(245,158,11,0.08)] text-tm"
    : tone === "muted" ? "border border-app-border bg-app-surface text-tmi" : "bg-[rgba(79,156,249,0.07)] text-tm";
  return (
    <div className={`flex items-start gap-2 rounded-lg px-2.5 py-2 text-[11px] leading-4 ${className}`}>
      <Icon size={12} className={`mt-0.5 shrink-0 ${tone === "warn" ? "text-[#F59E0B]" : "text-app-accent"}`} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Feedback({ type, message }: { type: "success" | "error"; message: string }) {
  if (!message) return null;
  return (
    <div role="status" className={`flex items-start gap-1.5 text-[11px] leading-4 ${type === "success" ? "text-[#1F9D6A]" : "text-[#E04848]"}`}>
      {type === "success" ? <Check size={12} className="mt-0.5 shrink-0" /> : <TriangleAlert size={12} className="mt-0.5 shrink-0" />}
      <span className="min-w-0 break-words">{message}</span>
    </div>
  );
}

export function Disclosure({ title, summary, defaultOpen = false, children }: { title: string; summary?: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-xl border border-app-border bg-app-card">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left">
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold leading-4 text-tp">{title}</p>
          {summary && !open && <p className="mt-0.5 truncate text-[11px] leading-4 text-tmi">{summary}</p>}
        </div>
        <ChevronDown size={14} className={`shrink-0 text-tmi transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <div className="space-y-2.5 border-t border-app-border px-3 pb-3 pt-2.5">{children}</div>}
    </section>
  );
}

const MONOGRAM_TONES = {
  blue: "bg-[rgba(79,156,249,0.13)] text-app-accent",
  violet: "bg-[rgba(124,58,237,0.11)] text-[#7C3AED]",
  green: "bg-[rgba(49,208,139,0.13)] text-[#1F9D6A]",
  openai: "bg-[rgba(16,163,127,0.13)] text-[#0E8C6D]",
  gray: "bg-app-surface text-tm",
} as const;

export type MonogramTone = keyof typeof MONOGRAM_TONES;

export function Monogram({ label, tone, size = 32 }: { label: string; tone: MonogramTone; size?: number }) {
  const letters = label.replace(/[（(].*$/, "").trim().replace(/\s+/g, "").slice(0, 2).toUpperCase();
  return (
    <span aria-hidden="true" className={`flex shrink-0 items-center justify-center rounded-lg text-[11px] font-bold ${MONOGRAM_TONES[tone]}`} style={{ width: size, height: size }}>
      {letters || "AI"}
    </span>
  );
}

export function EditorHeader({
  backLabel,
  onBack,
  title,
  subtitle,
  actions,
}: {
  backLabel: string;
  onBack: () => void;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-2.5 flex items-center gap-2">
      <button type="button" onClick={onBack} aria-label={backLabel} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-app-border bg-app-card text-tm">
        <ArrowLeft size={14} />
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-semibold leading-4 text-tp">{title}</p>
        {subtitle && <p className="mt-0.5 truncate text-[11px] leading-4 text-tmi">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  );
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export function OverflowMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div ref={rootRef} className="relative">
      <button type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="flex h-8 w-8 items-center justify-center rounded-lg border border-app-border bg-app-card text-tm">
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-9 z-20 min-w-[140px] overflow-hidden rounded-xl border border-app-border bg-app-card py-1 shadow-lg">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => { setOpen(false); item.onSelect(); }}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] disabled:opacity-40 ${item.danger ? "text-[#E04848]" : "text-ts"} hover:bg-app-surface`}
            >
              {item.icon}{item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ConfirmBar({ message, confirmLabel, cancelLabel, onConfirm, onCancel }: { message: string; confirmLabel: string; cancelLabel: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div role="alertdialog" className="flex items-center gap-2 rounded-xl border border-[#F24E4E]/20 bg-[rgba(242,78,78,0.07)] px-2.5 py-2">
      <p className="min-w-0 flex-1 text-[11px] leading-4 text-[#D94A4A]">{message}</p>
      <button type="button" onClick={onCancel} className="rounded-lg px-2 py-1 text-[11px] text-tm">{cancelLabel}</button>
      <button type="button" onClick={onConfirm} className="rounded-lg bg-[#F24E4E] px-2 py-1 text-[11px] font-semibold text-white">{confirmLabel}</button>
    </div>
  );
}

/** Pinned to the bottom of the scrolling settings pane so save/test stay reachable. */
export function StickyActions({ children, status }: { children: ReactNode; status?: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-3 mt-3 border-t border-app-border bg-app-bg/95 px-3 pb-3 pt-2 backdrop-blur">
      {status && <div className="mb-2">{status}</div>}
      <div className="flex gap-2">{children}</div>
    </div>
  );
}

export function UnsavedDot() {
  return <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[#F59E0B]" />;
}
