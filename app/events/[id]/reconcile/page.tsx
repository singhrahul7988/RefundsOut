import Link from "next/link";
import { pool } from "@/db/client";
import { getEvent } from "@/server/events";
import { latestPlanId } from "@/plan/review";
import { TopBar, PageHeader, Card, EmptyState, StepLink, btn } from "@/ui/kit";
import { IconShield, IconClock } from "@/ui/icons";
import { formatMoney } from "@/lib/money";
import { LetterPanel } from "./LetterPanel";
import { checkPendingRefunds } from "@/run/runner";

export const dynamic = "force-dynamic";

export default async function ReconcilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const event = await getEvent(id);
  const planId = await latestPlanId(id);
  const { rows: plan } = planId ? await pool.query(`select * from refund_plans where id=$1`, [planId]) : { rows: [] };
  if (!planId || !["done", "stopped"].includes(plan[0]?.status)) {
    return (
      <>
        <TopBar eventName={event.name} page="Reconcile" />
        <PageHeader title="Reconcile and notify" />
        <EmptyState title="Available after the run" body="Once the refund run finishes, this page checks every refund against PayPal and prepares a letter for each buyer." action={<StepLink href={`/events/${id}/${planId ? "run" : "review"}`}>Go to {planId ? "Run" : "Review"}</StepLink>} />
      </>
    );
  }

  await checkPendingRefunds(planId).catch(() => false); // PayPal may have finished eCheck-funded refunds since
  const { rows: items } = await pool.query(
    `select id, coalesce(buyer_name, buyer_email) as buyer, buyer_email, route, state, coalesce(override_cents, amount_cents)::bigint as cents, paypal_refund_id, dispute_id, lines, rule_ids, last_error
       from plan_items where plan_id=$1`,
    [planId],
  );
  const sum = (f: (i: (typeof items)[number]) => boolean) => items.filter(f).reduce((s, i) => s + Number(i.cents), 0);
  const count = (f: (i: (typeof items)[number]) => boolean) => items.filter(f).length;
  const moneyItems = items.filter((i) => ["refund", "dispute_offer"].includes(i.route));
  const planned = moneyItems.reduce((s, i) => s + Number(i.cents), 0);
  const buckets = [
    { key: "refunded", label: "Refunded through PayPal", color: "#0B6E55", test: (i: (typeof items)[number]) => ["refunded", "reconciled", "pending"].includes(i.state) },
    { key: "offer", label: "Offered through disputes", color: "#2F6DB5", test: (i: (typeof items)[number]) => i.state === "offer_sent" },
    { key: "skipped", label: "Skipped after the last check", color: "#8A919C", test: (i: (typeof items)[number]) => i.route !== "skip" && ["skipped", "cancelled"].includes(i.state) },
    { key: "attention", label: "Needs attention", color: "#B3261E", test: (i: (typeof items)[number]) => i.state === "needs_attention" },
  ].map((b) => ({ ...b, cents: sum((i) => moneyItems.includes(i) && b.test(i)), n: count((i) => moneyItems.includes(i) && b.test(i)) }));
  const accounted = buckets.reduce((s, b) => s + b.cents, 0);
  const unaccounted = planned - accounted;

  const { rows: dup } = await pool.query(
    `select count(*)::int as n from (select plan_item_id from refund_attempts ra join plan_items pi on pi.id=ra.plan_item_id
       where pi.plan_id=$1 and ra.paypal_refund_id is not null group by plan_item_id having count(distinct ra.paypal_refund_id) > 1) x`,
    [planId],
  );
  const refunded = buckets[0].n;
  const confirmed = count((i) => ["refunded", "reconciled"].includes(i.state));
  const stillPending = count((i) => i.state === "pending");
  const minutes = plan[0].started_at && plan[0].finished_at ? Math.max(1, Math.round((new Date(plan[0].finished_at).getTime() - new Date(plan[0].started_at).getTime()) / 60000)) : null;

  const letterCandidates = items
    .filter((i) => ["refunded", "pending", "offer_sent"].includes(i.state))
    // Every buyer who gets a letter is listed (the panel scrolls), so any letter can be checked before sending.
    .sort((a, b) => String(a.buyer).localeCompare(String(b.buyer)))
    .map((i) => ({ id: i.id, buyer: i.buyer, amount: Number(i.cents), offer: i.state === "offer_sent" }));

  return (
    <>
      <TopBar eventName={event.name} page="Reconcile" />
      <PageHeader
        title={unaccounted === 0 ? "Every cent accounted for" : "Reconcile the run"}
        subtitle={`Run ${plan[0].status === "stopped" ? "stopped" : "finished"}${minutes ? ` after ${minutes} min` : ""}. ${dup[0].n === 0 ? "No buyer was refunded twice." : `${dup[0].n} payments show more than one refund. Check them now.`}`}
        actions={<>
          <Link className={btn.secondary} href={`/events/${id}/audit`}>Audit log</Link>
          <a className={btn.primary} href={`/api/plans/${planId}/export`}>Download CSV for finance</a>
        </>}
      />

      <div className="flex flex-wrap items-start gap-4">
        <Card className="flex min-w-0 flex-[999_1_560px] flex-col gap-3.5 px-5 py-[18px]">
          <b className="text-[15px]">Where the planned {formatMoney(planned)} went</b>
          <div className="flex h-3.5 gap-0.5 overflow-hidden rounded-md" role="img" aria-label={buckets.map((b) => `${b.label} ${formatMoney(b.cents)}`).join(", ")}>
            {buckets.filter((b) => b.cents > 0).map((b) => <div key={b.key} style={{ flex: `${b.cents} 1 0`, background: b.color, minWidth: 6 }} />)}
          </div>
          <table className="w-full border-collapse">
            <tbody>
              {buckets.map((b) => (
                <tr key={b.key} className="border-b border-[#EEF0F3]">
                  <td className="py-2.5"><span className="flex items-center gap-2.5"><span className="size-2.5 flex-none rounded-sm" style={{ background: b.color }} /><span><b>{b.label}</b><br /><span className="text-muted">{b.n} payment{b.n === 1 ? "" : "s"}</span></span></span></td>
                  <td className="py-2.5 text-right font-semibold">{formatMoney(b.cents)}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-[#10221C]"><td className="py-3"><b>Unaccounted</b></td><td className={`py-3 text-right text-[16px] font-bold ${unaccounted === 0 ? "text-[#145C3D]" : "text-bad"}`}>{formatMoney(unaccounted)}</td></tr>
            </tbody>
          </table>
        </Card>

        <Card className="flex min-w-0 flex-[1_1_300px] flex-col gap-3 px-5 py-[18px]">
          <b className="text-[15px]">Checked against PayPal</b>
          <Tile ok big={`${confirmed} / ${refunded}`} label={stillPending ? `refunds completed · ${stillPending} still being finished by PayPal (bank-funded)` : "refunds confirmed completed by PayPal"} />
          <Tile ok={dup[0].n === 0} big={String(dup[0].n)} label="duplicate refunds" icon={<IconShield size={18} className="text-white" />} />
          <div className="flex items-center gap-3 rounded-[10px] bg-[#F3F5F8] p-3">
            <span className="flex size-[38px] flex-none items-center justify-center rounded-full border border-line-strong bg-white"><IconClock className="text-muted" /></span>
            <span className="flex flex-col"><b className="text-[15px] leading-5">Transaction Search</b><span className="text-xs text-[#3E4652]">PayPal&apos;s report can lag up to ~3 h. Re-check later for the finance file.</span></span>
          </div>
        </Card>
      </div>

      <div id="letters">
        <LetterPanel eventId={id} candidates={letterCandidates} total={buckets[0].n + buckets[1].n} />
      </div>
    </>
  );
}

function Tile({ ok, big, label, icon }: { ok: boolean; big: string; label: string; icon?: React.ReactNode }) {
  return (
    <div className={`flex items-center gap-3 rounded-[10px] p-3 ${ok ? "bg-ok-soft" : "bg-bad-soft"}`}>
      <span className={`flex size-[38px] flex-none items-center justify-center rounded-full ${ok ? "bg-ok" : "bg-bad"}`}>
        {icon ?? <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden><path d="M5.5 10.5 L8.5 13.5 L14.5 7" stroke="#fff" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>}
      </span>
      <span className="flex flex-col"><b className="text-xl leading-[26px]">{big}</b><span className="text-xs text-[#3E4652]">{label}</span></span>
    </div>
  );
}
