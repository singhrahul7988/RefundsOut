import { pool } from "@/db/client";
import { currentUser } from "@/server/user";
import { Logo, IconImport, IconReview, IconRun, IconCheckCircle } from "@/ui/icons";
import { formatMoney } from "@/lib/money";
import { HomeForm } from "./HomeForm";
import { AgGridMark, GeminiMark, Heart, PayPalMark } from "@/ui/brands";
import { RecentRuns, type RunCard } from "./RecentRuns";

export const dynamic = "force-dynamic";

const STATUS: Record<string, { label: string; cls: string; next: string; cta: string }> = {
  draft: { label: "Setting up", cls: "bg-[#F1F3F5] text-[#3E4652]", next: "import", cta: "Continue setup" },
  reviewing: { label: "In review", cls: "bg-warn-soft text-warn-ink", next: "review", cta: "Open review" },
  running: { label: "Sending", cls: "bg-info-soft text-info-ink", next: "run", cta: "Watch progress" },
  done: { label: "Done", cls: "bg-[#DDF1E7] text-[#145C3D]", next: "reconcile", cta: "See reconciliation" },
};

/** Entrance delay for .ro-rise / .ro-draw (see globals.css). */
const delay = (ms: number) => ({ "--d": `${ms}ms` }) as React.CSSProperties;

const STEPS = [
  { t: "Upload", d: "Your ticket sales, gate scans and ticket terms, in any layout.", icon: <IconImport />, tone: "bg-accent-soft text-accent" },
  { t: "Check", d: "Read the rules made from your terms, and every buyer's refund.", icon: <IconReview />, tone: "bg-ai-soft text-ai" },
  { t: "Approve and send", d: "Two people sign off. PayPal sends each refund exactly once.", icon: <IconRun />, tone: "bg-info-soft text-info" },
];

export default async function Home() {
  const user = await currentUser();
  const { rows: runs } = await pool.query(
    `select e.id, e.name, e.status, e.cancelled_day, e.created_at,
            (select count(*) from tickets t where t.event_id=e.id)::int as tickets,
            p.total_cents, p.status as plan_status,
            (select coalesce(sum(coalesce(pi.override_cents, pi.amount_cents)),0) from plan_items pi
              where pi.plan_id=p.id and pi.state in ('refunded','pending','offer_sent','reconciled'))::bigint as sent_cents
       from events e
       left join lateral (select * from refund_plans rp where rp.event_id=e.id order by rp.created_at desc limit 1) p on true
      where e.hidden_at is null  -- cleared from this list (never deleted)
        and exists (select 1 from uploads u where u.event_id=e.id)  -- hide runs that were created but never given files
      order by e.created_at desc limit 6`,
  );
  // "Clear all" covers every listed run, not just the six shown.
  const { rows: [{ n: clearableTotal }] } = await pool.query(
    `select count(*)::int as n from events e
      where e.hidden_at is null and e.status <> 'running' and exists (select 1 from uploads u where u.event_id=e.id)`,
  );
  const day: Record<string, string> = { Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };

  return (
    <div className="min-h-screen bg-canvas">
      <div className="mx-auto flex max-w-[1120px] flex-col px-4 md:px-8">
        <header className="flex items-center justify-between gap-4 py-5">
          <span className="flex items-center gap-2.5 text-[20px] font-bold tracking-[-0.2px]"><Logo />RefundsOut</span>
          <span className="flex items-center gap-3">
            <span className="rounded-[10px] bg-warn-soft px-2 py-0.5 text-xs font-semibold text-warn-ink">Sandbox</span>
            <span className={`flex size-8 items-center justify-center rounded-full text-xs font-semibold text-white ${user.id === "maya" ? "bg-[#10221C]" : "bg-info"}`} title={user.name}>{user.initials}</span>
          </span>
        </header>

        <main className="flex flex-col gap-12 pb-16 pt-10 md:pt-14">
          <section className="flex flex-col gap-5">
            <h1 className="ro-rise max-w-[980px] text-[34px] font-bold leading-[40px] tracking-[-0.8px] text-balance sm:text-[44px] sm:leading-[50px] lg:text-[52px] lg:leading-[58px]">
              An event got cancelled.<br className="hidden sm:block" /> Leave the refund headache to us.
            </h1>
            <p className="ro-rise max-w-[640px] text-[17px] leading-[27px] text-muted" style={delay(120)}>
              Upload your ticket sales and terms. RefundsOut works out what every buyer is owed, checks each payment with PayPal, and sends the refunds once you approve.
            </p>
            <ul className="flex flex-wrap gap-2">
              {["Every refund sent once", "Checked against PayPal", "Two people approve big runs"].map((t, i) => (
                <li key={t} style={delay(240 + i * 80)} className="ro-rise inline-flex items-center gap-1.5 rounded-full border border-line bg-white px-3 py-1.5 font-medium">
                  <IconCheckCircle className="text-ok" />{t}
                </li>
              ))}
            </ul>
          </section>

          <section className="grid items-stretch gap-5 md:grid-cols-2">
            <div className="ro-rise grid" style={delay(420)}><HomeForm /></div>
            <div className="ro-rise flex flex-col gap-5 rounded-[14px] border border-line bg-white p-6 shadow-[0_1px_3px_rgba(16,24,40,0.05)]" style={delay(500)}>
              <div className="flex flex-col gap-1">
                <b className="text-[18px]">How it works</b>
                <span className="text-muted">Nothing is sent until you&apos;ve seen every refund.</span>
              </div>
              <ol className="flex flex-1 flex-col">
                {STEPS.map((s, i) => (
                  // Steps land one after another, the connector draws down to the next, then a ring loops 1 → 2 → 3.
                  <li key={s.t} className="ro-rise relative flex gap-4 pb-7 last:pb-0" style={delay(800 + i * 450)}>
                    {i < STEPS.length - 1 && <span aria-hidden className="ro-draw absolute bottom-0 left-[19px] top-11 w-px bg-line" style={delay(1050 + i * 450)} />}
                    <span className={`ro-ping flex size-10 flex-none items-center justify-center rounded-[10px] ${s.tone}`} style={{ "--p": `${2400 + i * 2000}ms` } as React.CSSProperties}>{s.icon}</span>
                    <span className="flex min-w-0 flex-col gap-0.5 pt-0.5">
                      <b className="text-[15px]">{i + 1}. {s.t}</b>
                      <span className="text-muted">{s.d}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          </section>

          <RecentRuns
            clearableTotal={clearableTotal}
            runs={runs.map((r): RunCard => {
              const st = STATUS[r.status] ?? STATUS.draft;
              const total = Number(r.total_cents ?? 0);
              const sent = Number(r.sent_cents ?? 0);
              const pct = total ? Math.min(100, (sent / total) * 100) : 0;
              const started = new Date(r.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
              const summary =
                sent > 0 ? (
                  <div className="flex flex-col gap-1.5">
                    <span><b>{formatMoney(sent)}</b> <span className="text-muted">of {formatMoney(total)} sent</span></span>
                    <div className="h-1.5 rounded-full bg-[#EEF0F3]"><div className="h-1.5 rounded-full bg-accent" style={{ width: `${pct}%` }} /></div>
                  </div>
                ) : total > 0 ? (
                  <span><b>{formatMoney(total)}</b> <span className="text-muted">planned · waiting for approval</span></span>
                ) : r.tickets > 0 ? (
                  <span><b>{r.tickets}</b> <span className="text-muted">tickets imported · rules next</span></span>
                ) : (
                  <span className="text-muted">Files uploaded · confirm the columns</span>
                );
              return {
                id: r.id, href: `/events/${r.id}/${st.next}`, name: r.name,
                sub: `${day[r.cancelled_day] ?? r.cancelled_day} cancelled · ${started}`,
                status: { label: st.label, cls: st.cls, cta: st.cta }, sending: r.status === "running", summary,
              };
            })}
          />

          <footer className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4 border-t border-line pt-6 text-[13px] text-muted">
            <div className="flex flex-wrap items-center gap-2">
              <span className="mr-1">Built with</span>
              {[
                { t: "PayPal REST APIs", logo: <PayPalMark /> },
                { t: "Google Gemini", logo: <GeminiMark /> },
                { t: "AG Grid Enterprise", logo: <AgGridMark size={13} /> },
              ].map(({ t, logo }) => (
                <span key={t} className="inline-flex h-8 items-center gap-2 rounded-full border border-line bg-white pl-2.5 pr-3 font-medium text-[#2A303A] shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
                  {logo}{t}
                </span>
              ))}
            </div>
            <span className="group inline-flex items-center gap-1.5">
              Made with
              <Heart className="text-[#E5484D] transition-transform duration-200 group-hover:scale-125 motion-reduce:transition-none" />
              <span className="sr-only">love</span>
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}
