"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { setupGrid, gridTheme, money } from "@/ui/grid";
import { TopBar, PageHeader, btn, Card, Chip } from "@/ui/kit";
import { IconShield } from "@/ui/icons";
import type { RunActivity, RunItem } from "@/run/status";
import { pauseRunAction, resumeRunAction, stopRunAction } from "../../../actions";

type Snapshot = { plan: { id: string; status: string; total_cents: number; started_at: string | null; finished_at: string | null } | null; items: RunItem[]; activity: RunActivity[] };

const STATES: { key: string; label: string; color: string; tile: string; text: string; match: (i: RunItem) => boolean }[] = [
  { key: "refunded", label: "Refunded", color: "#0B6E55", tile: "bg-ok-soft", text: "text-[#145C3D]", match: (i) => ["refunded", "reconciled"].includes(i.state) },
  { key: "offer", label: "Dispute offers sent", color: "#2F6DB5", tile: "bg-[#E9F1FB]", text: "text-info-ink", match: (i) => i.state === "offer_sent" },
  { key: "retry", label: "Retrying", color: "#E3A13B", tile: "bg-[#FFF4DE]", text: "text-warn-ink", match: (i) => i.state === "queued" && i.attempts > 0 },
  { key: "attention", label: "Needs attention", color: "#B3261E", tile: "bg-bad-soft", text: "text-[#9A2019]", match: (i) => i.state === "needs_attention" },
  { key: "pending", label: "PayPal finishing", color: "#8DB3E2", tile: "bg-[#EEF4FB]", text: "text-info-ink", match: (i) => i.state === "pending" },
  // Counts only payments skipped while sending (e.g. charged back after approval). Rows already skipped in Review are
  // not payments to send, so they're outside these tiles; the label says so, or "0" looks wrong next to Review's count.
  { key: "skipped", label: "Skipped at send", color: "#8A919C", tile: "bg-[#EEF0F3]", text: "text-[#3E4652]", match: (i) => i.state === "skipped" || i.state === "cancelled" },
  { key: "waiting", label: "Waiting", color: "#E3E6EA", tile: "bg-[#EEF0F3]", text: "text-[#3E4652]", match: (i) => ["queued", "rechecking", "sending", "planned", "approved"].includes(i.state) && !(i.state === "queued" && i.attempts > 0) },
];

const STATE_CHIP: Record<string, { tone: "green" | "blue" | "amber" | "red" | "gray"; label: string }> = {
  refunded: { tone: "green", label: "Refunded" }, reconciled: { tone: "green", label: "Refunded" }, offer_sent: { tone: "blue", label: "Offer sent" },
  needs_attention: { tone: "red", label: "Needs attention" }, skipped: { tone: "gray", label: "Skipped" }, cancelled: { tone: "gray", label: "Cancelled" },
  pending: { tone: "blue", label: "PayPal finishing" }, sending: { tone: "amber", label: "Sending…" }, rechecking: { tone: "amber", label: "Re-checking…" },
  queued: { tone: "gray", label: "Queued" }, planned: { tone: "gray", label: "Planned" },
};

const ACTIVITY_STYLE: Record<RunActivity["kind"], { bg: string; fg: string; glyph: string }> = {
  refunded: { bg: "#DDF1E7", fg: "#145C3D", glyph: "✓" }, pending: { bg: "#E1ECFA", fg: "#1A4F8C", glyph: "…" }, offer: { bg: "#E1ECFA", fg: "#1A4F8C", glyph: "→" },
  retry: { bg: "#FFF1D6", fg: "#C27A00", glyph: "↻" }, failed: { bg: "#FCEDEB", fg: "#B3261E", glyph: "!" }, skipped: { bg: "#EEF0F3", fg: "#3E4652", glyph: "⏭" },
  start: { bg: "#10221C", fg: "#FFFFFF", glyph: "▶" }, pause: { bg: "#FFF1D6", fg: "#7A4600", glyph: "Ⅱ" }, stop: { bg: "#FCEDEB", fg: "#B3261E", glyph: "■" }, done: { bg: "#0B6E55", fg: "#FFFFFF", glyph: "✓" },
};

export function RunClient({ eventId, eventName, planId, initial, licenseKey }: { eventId: string; eventName: string; planId: string; initial: Snapshot; licenseKey?: string }) {
  setupGrid(licenseKey);
  const router = useRouter();
  const [snap, setSnap] = useState<Snapshot>(initial);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const gridRef = useRef<AgGridReact<RunItem>>(null);
  const status = snap.plan?.status ?? "running";
  const live = status === "running";
  const finished = status === "done" || status === "stopped";

  useEffect(() => {
    let stop = false;
    if (finished) return; // a finished run never changes again: no polling
    const tick = async () => {
      try {
        const res = await fetch(`/api/plans/${planId}/status`, { cache: "no-store" });
        if (res.ok && !stop) setSnap(await res.json());
      } catch { /* keep the last snapshot */ }
      if (!stop) setTimeout(tick, live ? 1200 : 5000);
    };
    const t = setTimeout(tick, 800);
    return () => { stop = true; clearTimeout(t); };
  }, [planId, live, finished]);

  const actionable = snap.items.filter((i) => i.route !== "skip" || i.state !== "planned");
  const moneyItems = snap.items.filter((i) => i.route !== "skip");
  const done = moneyItems.filter((i) => !["queued", "rechecking", "sending", "planned", "approved"].includes(i.state)).length;
  const refundedCents = moneyItems.filter((i) => ["refunded", "reconciled", "pending"].includes(i.state)).reduce((s, i) => s + Math.round(i.amount * 100), 0);
  const pct = moneyItems.length ? Math.round((done / moneyItems.length) * 100) : 0;
  const stateCounts = STATES.map((s) => ({ ...s, n: moneyItems.filter(s.match).length }));

  const columnDefs = useMemo<ColDef<RunItem>[]>(() => [
    { headerName: "Buyer", field: "buyer", flex: 1.2, minWidth: 160, cellRenderer: (p: ICellRendererParams<RunItem>) => <b>{p.value}</b> },
    { headerName: "Amount", field: "amount", type: "rightAligned", width: 120, valueFormatter: (p) => money(p.value), enableCellChangeFlash: true },
    {
      headerName: "Status", field: "state", width: 170, enableCellChangeFlash: true,
      cellRenderer: (p: ICellRendererParams<RunItem>) => {
        const c = STATE_CHIP[p.value as string] ?? { tone: "gray" as const, label: p.value };
        return <Chip tone={c.tone}>{p.data?.state === "queued" && (p.data?.attempts ?? 0) > 0 ? "Retrying" : c.label}</Chip>;
      },
    },
    {
      headerName: "PayPal reference or reason", flex: 2, minWidth: 260, enableCellChangeFlash: true,
      valueGetter: (p) => p.data?.refundId ?? (p.data?.state === "offer_sent" ? p.data.disputeId : null) ?? p.data?.lastError ?? (p.data?.route === "dispute_offer" ? `Offer through ${p.data.disputeId}` : ""),
      cellClass: (p) => (p.data?.refundId || p.data?.state === "offer_sent" ? "mono" : ""),
    },
    { headerName: "Tries", field: "attempts", width: 90, type: "rightAligned" },
  ], []);

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>) => start(async () => {
    setError(null);
    const r = await fn();
    if (!r.ok) setError(r.error ?? "Something went wrong");
    router.refresh();
  });

  const startedAt = snap.plan?.started_at ? new Date(snap.plan.started_at) : null;
  const title = status === "done" ? "Refunds sent" : status === "paused" ? "Run paused" : status === "stopped" ? "Run stopped" : "Refunds running";

  return (
    <>
      <TopBar eventName={eventName} page="Run" right={<><span className={`size-2 rounded-full ${live ? "bg-ok ro-pulse" : "bg-[#A3ABB8]"}`} />{live ? "Live · updating every second" : status.charAt(0).toUpperCase() + status.slice(1)}</>} />
      <PageHeader
        title={title}
        subtitle={<>Started {startedAt ? startedAt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : "—"} · every refund uses a fixed PayPal request ID, so retries and restarts never pay twice</>}
        actions={
          status === "done" || status === "stopped" ? (
            <Link href={`/events/${eventId}/reconcile`} className={btn.primary}>Reconcile and notify</Link>
          ) : (
            <>
              {status === "running" && <button className={btn.secondary} disabled={pending} onClick={() => act(() => pauseRunAction(eventId, planId))}>Pause</button>}
              {status === "paused" && <button className={btn.primary} disabled={pending} onClick={() => act(() => resumeRunAction(eventId, planId))}>Resume</button>}
              <button className={btn.danger} disabled={pending} onClick={() => act(() => stopRunAction(eventId, planId))}>Stop</button>
            </>
          )
        }
      />
      {error && <div role="alert" className="rounded-lg bg-bad-soft px-4 py-3 text-bad-ink">{error}</div>}

      <Card className="flex flex-col gap-3 px-5 py-[18px]">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <span><b className="text-[26px] leading-8">{done}</b> <span className="text-muted">of {moneyItems.length} payments</span></span>
          <span><b className="text-lg">{money(refundedCents / 100)}</b> <span className="text-muted">of {money((snap.plan?.total_cents ?? 0) / 100)} refunded</span></span>
        </div>
        <div className="flex h-3 gap-0.5 overflow-hidden rounded-md" role="img" aria-label={stateCounts.map((s) => `${s.n} ${s.label}`).join(", ")}>
          {stateCounts.filter((s) => s.n > 0).map((s) => <div key={s.key} style={{ flex: `${s.n} 1 0`, background: s.color, minWidth: 5 }} className="transition-all duration-500" />)}
        </div>
        <span className="text-muted">{pct}% done · {process.env.NEXT_PUBLIC_RUN_CONCURRENCY ?? 4} refunds at a time to stay inside PayPal&apos;s limits</span>
      </Card>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(160px,100%),1fr))] gap-2.5">
        {stateCounts.map((s) => (
          <div key={s.key} className={`flex flex-col gap-0.5 rounded-lg px-3.5 py-3 ${s.tile}`}>
            <span className={`inline-flex items-center gap-1.5 font-semibold ${s.text}`}><span className="size-2 rounded-sm" style={{ background: s.color, boxShadow: s.key === "waiting" ? "inset 0 0 0 1px #A3ABB8" : undefined }} />{s.label}</span>
            <b className="text-xl leading-7">{s.n}</b>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-start gap-4">
        <Card className="flex min-w-0 flex-[999_1_620px] flex-col overflow-hidden">
          <div className="flex flex-wrap justify-between gap-2 border-b border-[#E6E9EE] px-[18px] py-3.5"><b className="text-[15px]">Every payment, updating live</b><span className="text-muted">Newest changes first</span></div>
          <div style={{ height: 460 }}>
            <AgGridReact<RunItem>
              ref={gridRef}
              theme={gridTheme}
              rowData={actionable}
              columnDefs={columnDefs}
              getRowId={(p) => p.data.id}
              animateRows
              suppressCellFocus
            />
          </div>
        </Card>
        <Card className="flex min-w-0 flex-[1_1_300px] flex-col overflow-hidden">
          <div className="border-b border-[#E6E9EE] px-[18px] py-3.5"><b className="text-[15px]">Activity</b></div>
          <ol className="flex flex-col py-1">
            {snap.activity.length === 0 && <li className="px-[18px] py-3 text-muted">Waiting for the first refund…</li>}
            {snap.activity.map((a, i) => {
              const st = ACTIVITY_STYLE[a.kind];
              return (
                <li key={`${a.at}-${i}`} className="flex items-start gap-2.5 border-b border-[#EEF0F3] px-[18px] py-2.5 last:border-0">
                  <span className="flex size-[26px] flex-none items-center justify-center rounded-full text-xs font-bold" style={{ background: st.bg, color: st.fg }}>{st.glyph}</span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span>{a.text}{a.amount !== undefined && <> · <b>{money(a.amount)}</b></>}</span>
                    <span className="text-xs text-muted">{new Date(a.at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        </Card>
      </div>

      <div className="flex items-center gap-3 rounded-[10px] bg-ok-soft px-4 py-3 text-[#145C3D]">
        <IconShield className="flex-none text-accent" />
        <span><b>Safe to close this page.</b> The run keeps going on the server and never refunds anyone twice.</span>
      </div>
    </>
  );
}
