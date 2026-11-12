import { pool } from "@/db/client";

export type RunItem = {
  id: string; buyer: string; email: string; route: string; state: string; amount: number;
  refundId: string | null; disputeId: string | null; captureId: string; attempts: number; lastError: string | null; updatedAt: string;
};
export type RunActivity = { at: string; kind: "refunded" | "pending" | "retry" | "failed" | "offer" | "skipped" | "start" | "pause" | "stop" | "done"; text: string; amount?: number };

export async function getRunSnapshot(planId: string) {
  const { rows: plan } = await pool.query(
    `select rp.id, rp.status, rp.total_cents, rp.started_at, rp.finished_at, rp.event_id, e.name as event_name
       from refund_plans rp join events e on e.id=rp.event_id where rp.id=$1`,
    [planId],
  );
  const { rows: items } = await pool.query(
    `select id, coalesce(buyer_name, buyer_email) as buyer, buyer_email as email, route, state, coalesce(override_cents, amount_cents)::bigint as cents,
            paypal_refund_id, dispute_id, capture_id, attempts, last_error, updated_at
       from plan_items where plan_id=$1 and route in ('refund','dispute_offer','skip') order by updated_at desc`,
    [planId],
  );
  const { rows: attempts } = await pool.query(
    `select ra.created_at as at, ra.result, ra.paypal_refund_id, ra.error_name, ra.attempt_no, coalesce(pi.buyer_name, pi.buyer_email) as buyer,
            coalesce(pi.override_cents, pi.amount_cents)::bigint as cents, pi.dispute_id
       from refund_attempts ra join plan_items pi on pi.id=ra.plan_item_id where pi.plan_id=$1 order by ra.created_at desc limit 12`,
    [planId],
  );
  const { rows: events } = await pool.query(
    `select at, action, after from audit_log where entity in ('plan','plan_item') and (entity_id=$1::text or entity_id in (select id::text from plan_items where plan_id=$1::uuid))
       and action in ('run.start','run.pause','run.resume','run.stop','run.done','run.auto_pause','item.skip') order by at desc limit 10`,
    [planId],
  );

  const activity: RunActivity[] = [
    ...attempts.map((a): RunActivity => {
      const amount = Number(a.cents) / 100;
      if (a.result === "completed") return { at: a.at, kind: "refunded", text: `Refunded ${a.buyer}`, amount };
      if (a.result === "pending") return { at: a.at, kind: "pending", text: `${a.buyer} · PayPal is finishing the refund`, amount };
      if (a.result === "offer_sent") return { at: a.at, kind: "offer", text: `Dispute offer to ${a.buyer} · ${a.dispute_id}`, amount };
      if (a.result === "retry") return { at: a.at, kind: "retry", text: `${a.buyer} · PayPal busy, retry ${a.attempt_no + 1}` };
      return { at: a.at, kind: "failed", text: `${a.buyer} · ${a.error_name ?? "PayPal declined"}` };
    }),
    ...events.map((e): RunActivity => {
      const map: Record<string, RunActivity["kind"]> = { "run.start": "start", "run.pause": "pause", "run.auto_pause": "pause", "run.resume": "start", "run.stop": "stop", "run.done": "done", "item.skip": "skipped" };
      const text: Record<string, string> = { "run.start": "Run started", "run.pause": "Run paused", "run.auto_pause": "Run paused automatically: too many failures", "run.resume": "Run resumed", "run.stop": "Run stopped", "run.done": "Run finished", "item.skip": `Skipped · ${e.after?.reason ?? ""}` };
      return { at: e.at, kind: map[e.action] ?? "start", text: text[e.action] ?? e.action };
    }),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 12);

  return {
    plan: plan[0] ? { ...plan[0], total_cents: Number(plan[0].total_cents) } : null,
    items: items.map((i): RunItem => ({
      id: i.id, buyer: i.buyer, email: i.email, route: i.route, state: i.state, amount: Number(i.cents) / 100, refundId: i.paypal_refund_id,
      disputeId: i.dispute_id, captureId: i.capture_id, attempts: i.attempts, lastError: i.last_error, updatedAt: i.updated_at,
    })),
    activity,
  };
}
