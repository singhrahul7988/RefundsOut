import Papa from "papaparse";
import { pool } from "@/db/client";

export const dynamic = "force-dynamic";

/** Finance file: every payment, the rule behind it, the amount, and PayPal's reference. */
export async function GET(_req: Request, { params }: { params: Promise<{ planId: string }> }) {
  const { planId } = await params;
  const { rows } = await pool.query(
    `select pi.capture_id, coalesce(pi.buyer_name,'') as buyer, pi.buyer_email, pi.route, pi.state, pi.exception_type,
            pi.paid_cents, pi.already_refunded_cents, coalesce(pi.override_cents, pi.amount_cents) as amount_cents,
            array_to_string(pi.rule_ids, ' ') as rules, pi.reason, coalesce(pi.override_reason, pi.resolution, '') as decision,
            coalesce(pi.paypal_refund_id, pi.dispute_id, '') as paypal_reference, pi.request_id, pi.attempts, coalesce(pi.last_error,'') as note
       from plan_items pi where pi.plan_id=$1 order by pi.route, pi.capture_id`,
    [planId],
  );
  const dollars = (c: string | number) => (Number(c) / 100).toFixed(2);
  const csv = Papa.unparse(
    rows.map((r) => ({
      "PayPal payment": r.capture_id, Buyer: r.buyer, Email: r.buyer_email, Route: r.route, Status: r.state, Exception: r.exception_type ?? "",
      Paid: dollars(r.paid_cents), "Refunded before": dollars(r.already_refunded_cents), Amount: dollars(r.amount_cents),
      Rules: r.rules, "Why this amount": r.reason, "Manual decision": r.decision, "PayPal reference": r.paypal_reference,
      "PayPal-Request-Id": r.request_id, Attempts: r.attempts, Note: r.note,
    })),
  );
  return new Response(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="refundsout-${planId.slice(0, 8)}.csv"` },
  });
}
