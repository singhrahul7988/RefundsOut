"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { clearRunsAction, restoreRunsAction } from "./actions";
import { IconTrash } from "@/ui/icons";

export type RunCard = {
  id: string;
  href: string;
  name: string;
  sub: string;
  status: { label: string; cls: string; cta: string };
  /** Refunds are being sent right now; such a run can't be cleared. */
  sending: boolean;
  summary: React.ReactNode;
};

/** Recent runs with per-card "Clear", "Clear all" and Undo. Clearing hides a run; nothing is deleted. */
export function RecentRuns({ runs, clearableTotal }: { runs: RunCard[]; clearableTotal: number }) {
  const [pending, start] = useTransition();
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [undo, setUndo] = useState<{ ids: string[]; text: string } | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The undo offer fades after a while; the runs stay recoverable in the database regardless.
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 12000);
    return () => clearTimeout(t);
  }, [undo]);

  const clear = (ids: string[] | null, text: (n: number) => string) => {
    setError(null);
    setConfirmAll(false);
    const optimistic = ids ?? runs.filter((r) => !r.sending).map((r) => r.id);
    setGone((g) => new Set([...g, ...optimistic]));
    start(async () => {
      const res = await clearRunsAction(ids);
      if (!res.ok) {
        setGone((g) => new Set([...g].filter((id) => !optimistic.includes(id))));
        setError(res.error);
        return;
      }
      const hidden = res.data ?? [];
      setUndo(hidden.length ? { ids: hidden, text: text(hidden.length) } : null);
    });
  };

  const restore = () => {
    if (!undo) return;
    const ids = undo.ids;
    setUndo(null);
    start(async () => {
      const res = await restoreRunsAction(ids);
      if (!res.ok) return setError(res.error);
      setGone((g) => new Set([...g].filter((id) => !ids.includes(id))));
    });
  };

  const shown = runs.filter((r) => !gone.has(r.id));
  if (!shown.length && !undo && !error) return null;

  return (
    <section className="flex flex-col gap-3" aria-labelledby="recent-runs">
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-3">
        <b id="recent-runs" className="text-[17px]">Recent runs</b>
        {clearableTotal > 0 && shown.some((r) => !r.sending) && (
          confirmAll ? (
            <span className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="text-muted">Clear {clearableTotal === 1 ? "this run" : `all ${clearableTotal} runs`} from this list?</span>
              <button type="button" onClick={() => setConfirmAll(false)} className="h-8 rounded-md border border-line-strong bg-white px-3 font-medium hover:bg-[#F7F8FA]">Cancel</button>
              <button type="button" disabled={pending} onClick={() => clear(null, (n) => `Cleared ${n} run${n === 1 ? "" : "s"}.`)}
                className="h-8 rounded-md bg-bad px-3 font-semibold text-white hover:bg-bad-ink disabled:opacity-60">Clear all</button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirmAll(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-muted transition-colors hover:bg-bad-soft hover:text-bad">
              <IconTrash size={15} />Clear all
            </button>
          )
        )}
      </div>

      {(undo || error) && (
        <div role="status" className={`flex flex-wrap items-center justify-between gap-3 rounded-[10px] px-4 py-2.5 text-[13px] ${error ? "bg-bad-soft text-bad-ink" : "bg-[#14171C] text-white"}`}>
          <span>{error ?? <>{undo!.text} <span className="text-white/70">Hidden from this list, not deleted.</span></>}</span>
          {error ? (
            <button type="button" onClick={() => setError(null)} className="font-semibold underline">Dismiss</button>
          ) : (
            <button type="button" disabled={pending} onClick={restore} className="rounded-md px-2 py-1 font-semibold text-[#8FE3C4] hover:bg-white/10 disabled:opacity-60">Undo</button>
          )}
        </div>
      )}

      {shown.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((r) => (
            <article key={r.id} className="group relative flex flex-col gap-4 rounded-[12px] border border-line bg-white p-4 transition-colors has-[a:hover]:border-accent">
              <div className="flex items-start justify-between gap-3">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <b className="truncate" title={r.name}>{r.name}</b>
                  <span className="truncate text-xs text-muted">{r.sub}</span>
                </span>
                <span className={`flex-none whitespace-nowrap rounded-[10px] px-2 py-0.5 text-xs font-semibold ${r.status.cls}`}>{r.status.label}</span>
              </div>
              <div className="flex-1">{r.summary}</div>
              <div className="flex items-center justify-between gap-3">
                {/* The link's ::after covers the whole card, so the card stays one big click target. */}
                <Link href={r.href} className="font-semibold text-accent after:absolute after:inset-0 after:rounded-[12px] after:content-[''] hover:underline">
                  {r.status.cta} →
                </Link>
                {r.sending ? (
                  <span className="text-xs text-muted" title="A run can't be cleared while refunds are being sent">Sending…</span>
                ) : (
                  <button type="button" disabled={pending} onClick={() => clear([r.id], () => `Cleared “${r.name}”.`)}
                    aria-label={`Clear ${r.name} from recent runs`} title="Clear from recent runs"
                    className="relative z-10 inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium text-muted transition-colors hover:bg-bad-soft hover:text-bad disabled:opacity-60">
                    <IconTrash size={15} />Clear
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
