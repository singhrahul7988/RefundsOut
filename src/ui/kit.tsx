import Link from "next/link";
import { IconCheckCircle, IconXCircle } from "./icons";

export function TopBar({ eventName, page, right }: { eventName: string; page: string; right?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-muted">
      <span>{eventName} <span aria-hidden>›</span> <b className="text-ink">{page}</b></span>
      <span className="inline-flex items-center gap-2">{right ?? <><span className="size-2 rounded-full bg-ok" />PayPal sandbox connected</>}</span>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1.5">
        <h1 className="text-[28px] font-bold leading-[34px] tracking-[-0.4px]">{title}</h1>
        {subtitle && <p className="max-w-[680px] text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2.5">{actions}</div>}
    </div>
  );
}

export const btn = {
  primary: "inline-flex h-11 items-center gap-2 rounded-lg bg-accent px-[18px] font-semibold text-white hover:bg-accent-ink disabled:cursor-not-allowed disabled:bg-[#CBD5D1] disabled:text-[#3F4B46]",
  // Secondary and small buttons turn green on hover (not when disabled). `not-disabled:` also matches <label> "buttons".
  secondary: "inline-flex h-11 items-center gap-2 rounded-lg border border-line-strong bg-white px-4 font-semibold text-ink transition-colors not-disabled:hover:border-accent not-disabled:hover:bg-accent-soft not-disabled:hover:text-accent-ink disabled:opacity-60",
  danger: "inline-flex h-11 items-center gap-2 rounded-lg border border-[#D9A39F] bg-white px-4 font-semibold text-bad hover:bg-bad-soft disabled:opacity-60",
  small: "inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-white px-3 text-[13px] font-medium transition-colors not-disabled:hover:border-accent not-disabled:hover:bg-accent-soft not-disabled:hover:text-accent-ink disabled:opacity-60",
  ai: "inline-flex h-10 items-center gap-2 rounded-lg bg-ai px-4 font-semibold text-white hover:bg-ai-ink disabled:opacity-60",
};

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <section className={`rounded-[10px] border border-[#DDE1E7] bg-white ${className}`}>{children}</section>;
}

export function IconTile({ tone, children }: { tone: "green" | "blue" | "violet" | "gray" | "amber"; children: React.ReactNode }) {
  const tones = { green: "bg-accent-soft text-accent", blue: "bg-info-soft text-info", violet: "bg-ai-soft text-ai", gray: "bg-[#EEF0F3] text-[#3E4652]", amber: "bg-warn-soft text-warn" };
  return <span className={`flex size-[34px] flex-none items-center justify-center rounded-[9px] ${tones[tone]}`}>{children}</span>;
}

export function Chip({ tone = "gray", children }: { tone?: "gray" | "green" | "amber" | "red" | "blue" | "violet"; children: React.ReactNode }) {
  const tones = {
    gray: "bg-[#F1F3F5] text-[#3E4652]", green: "bg-[#DDF1E7] text-[#145C3D]", amber: "bg-[#FFE7B8] text-[#6B3E00]",
    red: "bg-[#F9D9D6] text-[#8A1C15]", blue: "bg-[#E1ECFA] text-info-ink", violet: "bg-ai-soft text-ai-ink",
  };
  return <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-[10px] px-2 py-0.5 text-xs font-semibold ${tones[tone]}`}>{children}</span>;
}

export function CheckRow({ passed, label, detail }: { passed: boolean; label: string; detail?: string }) {
  return (
    <div className={`flex h-full min-w-0 items-center gap-2.5 rounded-lg px-3 py-2.5 ${passed ? "bg-ok-soft" : "bg-bad-soft"}`}>
      {passed ? <IconCheckCircle size={20} className="flex-none text-ok" /> : <IconXCircle size={20} className="flex-none text-bad" />}
      <span className="flex min-w-0 flex-col">
        <b className="truncate" title={label}>{label}</b>
        {/* Wrap to two lines rather than cut off: details like "12 min ago" or "under $2,500" are the point of the check. */}
        {detail && <span className="line-clamp-2 text-muted" title={detail}>{detail}</span>}
      </span>
    </div>
  );
}

export function SegmentMeter({ values, label }: { values: boolean[]; label: string }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="flex gap-[3px]" role="img" aria-label={label}>
        {values.map((v, i) => <span key={i} className={`h-2 w-6 rounded ${v ? "bg-ok" : "bg-bad"}`} />)}
      </span>
      <span className={`font-semibold ${values.every(Boolean) ? "text-[#145C3D]" : "text-[#9A5B00]"}`}>{label}</span>
    </span>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <Card className="flex flex-col items-start gap-3 p-8">
      <b className="text-lg">{title}</b>
      <p className="max-w-[560px] text-muted">{body}</p>
      {action}
    </Card>
  );
}

export function StepLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <Link href={href} className={btn.primary}>{children}</Link>;
}
