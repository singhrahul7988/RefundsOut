import { createHash } from "node:crypto";
import { pool, tx, audit } from "@/db/client";
import { PayPalClient, PayPalError, refundRequestId, type CaptureState } from "@/paypal/client";
import { evaluateTicket, type TicketResult } from "@/policy/evaluate";
import { Policy } from "@/policy/schema";
import { dayOf } from "@/import/sales";
import { formatMoney, toCents } from "@/lib/money";
import type { DisputeDetail } from "@/paypal/client";

type DisputeWithOffer = DisputeDetail & { offer?: { seller_offered_amount?: { value: string } } };

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const DAY_MS = 86_400_000;

type TicketRow = {
  external_ticket_id: string;
  tier: string;
  price_cents: string;
  buyer_email: string;
  buyer_name: string | null;
  paypal_capture_id: string | null;
  transferred_to_email: string | null;
  purchased_at: Date | null;
  is_comp: boolean;
};

export type PlanLine = {
  ticketId: string;
  tier: string;
  priceCents: number;
  attendedDays: string[];
  result: TicketResult;
};

type ItemDraft = {
  captureKey: string;
  buyerEmail: string;
  buyerName: string | null;
  currency: string;
  paidCents: number;
  alreadyRefundedCents: number;
  amountCents: number;
  lines: PlanLine[];
  ruleIds: string[];
  reason: string;
  route: "refund" | "dispute_offer" | "skip" | "exception";
  exceptionType: string | null;
  flags: string[];
  disputeId: string | null;
  overrideCents?: number;
  overrideReason?: string | null;
  resolution?: string | null;
};

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

/** Read live state for every payment and every open dispute, and snapshot it. */
export async function syncPayPal(eventId: string, captureIds: string[], pp = new PayPalClient()) {
  const states = new Map<string, CaptureState | { error: string }>();
  await mapLimit(captureIds, 5, async (id) => {
    try {
      const s = await pp.getCapture(id);
      states.set(id, s);
    } catch (err) {
      states.set(id, { error: err instanceof PayPalError && err.status === 404 ? "PayPal can't find this payment" : (err as Error).message });
    }
  });

  const disputesByCapture = new Map<string, { disputeId: string; stage?: string; status: string; amount?: string; offeredCents: number }>();
  const open = await pp.listOpenDisputes();
  await mapLimit(open, 4, async (d) => {
    const detail = (await pp.getDispute(d.dispute_id)) as DisputeWithOffer;
    for (const t of detail.disputed_transactions ?? []) {
      if (t.seller_transaction_id) {
        disputesByCapture.set(t.seller_transaction_id, {
          disputeId: d.dispute_id, stage: d.dispute_life_cycle_stage, status: d.status, amount: d.dispute_amount?.value,
          offeredCents: toCents(detail.offer?.seller_offered_amount?.value ?? null) ?? 0,
        });
      }
    }
  });

  for (const [id, s] of states) {
    if ("error" in s) continue;
    const d = disputesByCapture.get(id);
    await pool.query(
      `insert into payment_snapshots (capture_id, event_id, captured_cents, refunded_cents, currency, status, dispute_id, dispute_stage, dispute_status, captured_at, fetched_at, raw)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), $11)
       on conflict (capture_id) do update set captured_cents=excluded.captured_cents, refunded_cents=excluded.refunded_cents, status=excluded.status,
         dispute_id=excluded.dispute_id, dispute_stage=excluded.dispute_stage, dispute_status=excluded.dispute_status, fetched_at=now(), raw=excluded.raw`,
      [id, eventId, s.capturedCents, s.refundedCents + s.pendingRefundCents, s.currency, s.status, d?.disputeId ?? null, d?.stage ?? null, d?.status ?? null, s.capturedAt ?? null, JSON.stringify(s.raw)],
    );
  }
  return { states, disputesByCapture };
}

function planHashOf(items: { capture_id: string; route: string; amount_cents: number | string; override_cents: number | string | null }[]) {
  const canonical = [...items]
    .sort((a, b) => a.capture_id.localeCompare(b.capture_id))
    .map((i) => `${i.capture_id}|${i.route}|${i.override_cents ?? i.amount_cents}`)
    .join("\n");
  return sha(canonical);
}

/** Recompute and store the plan fingerprint. Any change to an item changes it, which voids earlier approvals. */
export async function refreshPlanHash(planId: string, db: Pick<typeof pool, "query"> = pool) {
  const { rows } = await db.query(`select capture_id, route, amount_cents, override_cents from plan_items where plan_id=$1`, [planId]);
  const hash = planHashOf(rows);
  const total = await db.query(
    `select coalesce(sum(coalesce(override_cents, amount_cents)) filter (where route in ('refund','dispute_offer')),0) as t from plan_items where plan_id=$1`,
    [planId],
  );
  await db.query(`update refund_plans set plan_hash=$2, total_cents=$3 where id=$1`, [planId, hash, total.rows[0].t]);
  return hash;
}

/** Build a dry-run plan: nothing is sent to PayPal here except reads. */
export async function buildPlan(eventId: string, actor: string) {
  const { rows: pol } = await pool.query(`select id, rules_json from policies where event_id=$1 and status='approved' order by version desc limit 1`, [eventId]);
  if (!pol[0]) throw new Error("Approve a refund policy first.");
  const policy = Policy.parse(pol[0].rules_json);

  const { rows: tickets } = await pool.query<TicketRow>(`select * from tickets where event_id=$1 order by external_ticket_id`, [eventId]);
  const { rows: scanRows } = await pool.query(`select external_ticket_id, to_char(scanned_at, 'YYYY-MM-DD HH24:MI:SS') as at from scans where event_id=$1 and matched`, [eventId]);
  const attended = new Map<string, Set<string>>();
  for (const s of scanRows) {
    const set = attended.get(s.external_ticket_id) ?? new Set<string>();
    set.add(dayOf(s.at));
    attended.set(s.external_ticket_id, set);
  }

  const captureIds = [...new Set(tickets.map((t) => t.paypal_capture_id).filter((c): c is string => !!c))];
  const { states, disputesByCapture } = await syncPayPal(eventId, captureIds);

  // Our own ledger of money this event has already sent, from ANY earlier plan. PayPal's view of a payment can lag a
  // refund by seconds, so a plan built right after a run must not trust PayPal alone (that is how money gets sent twice).
  const { rows: ledgerRows } = await pool.query(
    `select pi.capture_id, sum(coalesce(pi.override_cents, pi.amount_cents))::bigint as cents, array_agg(pi.paypal_refund_id) as refund_ids,
            bool_or(pi.state = 'offer_sent') as offered
       from plan_items pi join refund_plans rp on rp.id = pi.plan_id
      where rp.event_id = $1 and (pi.state in ('refunded','pending','reconciled') and pi.paypal_refund_id is not null or pi.state = 'offer_sent')
      group by pi.capture_id`,
    [eventId],
  );
  const ledger = new Map(ledgerRows.map((r) => [r.capture_id as string, { cents: Number(r.cents), refundIds: (r.refund_ids as string[]).filter(Boolean), offered: r.offered as boolean }]));

  const drafts: ItemDraft[] = [];
  const byCapture = new Map<string, TicketRow[]>();
  for (const t of tickets) {
    if (!t.paypal_capture_id) {
      const free = t.is_comp || Number(t.price_cents) === 0;
      drafts.push({
        captureKey: `${free ? "COMP" : "NOPAYPAL"}:${t.external_ticket_id}`,
        buyerEmail: t.buyer_email, buyerName: t.buyer_name, currency: "USD",
        paidCents: Number(t.price_cents), alreadyRefundedCents: 0, amountCents: 0,
        lines: [{ ticketId: t.external_ticket_id, tier: t.tier, priceCents: Number(t.price_cents), attendedDays: [...(attended.get(t.external_ticket_id) ?? [])], result: { kind: "skip", ticketId: t.external_ticket_id, amountCents: 0, reason: free ? "Free ticket" : "Not paid with PayPal" } }],
        ruleIds: [], reason: free ? "Free ticket: nothing was paid" : "Not paid with PayPal (no PayPal transaction ID)",
        route: free ? "skip" : "exception", exceptionType: free ? "free_ticket" : "not_paypal", flags: [], disputeId: null,
      });
      continue;
    }
    const list = byCapture.get(t.paypal_capture_id) ?? [];
    list.push(t);
    byCapture.set(t.paypal_capture_id, list);
  }

  for (const [captureId, group] of byCapture) {
    const lines: PlanLine[] = group.map((t) => {
      const days = [...(attended.get(t.external_ticket_id) ?? [])].sort();
      return {
        ticketId: t.external_ticket_id,
        tier: t.tier,
        priceCents: Number(t.price_cents),
        attendedDays: days,
        result: evaluateTicket(policy, { ticketId: t.external_ticket_id, tier: t.tier, priceCents: Number(t.price_cents), isComp: t.is_comp, attendedDays: days }),
      };
    });
    const policyAmount = lines.reduce((s, l) => s + l.result.amountCents, 0);
    const ruleIds = [...new Set(lines.flatMap((l) => (l.result.kind === "refund" ? [l.result.ruleId, ...l.result.deductionIds] : [])))];
    const explanation = lines.map((l) => (l.result.kind === "refund" ? l.result.explanation : l.result.reason)).join("; ");
    const first = group[0];
    const state = states.get(captureId);
    const flags: string[] = [];
    if (group.some((t) => t.transferred_to_email)) flags.push("transferred");

    const base = {
      captureKey: captureId, buyerEmail: first.buyer_email, buyerName: first.buyer_name, lines, ruleIds, flags, disputeId: null as string | null,
    };

    if (!state || "error" in state) {
      drafts.push({ ...base, currency: "USD", paidCents: 0, alreadyRefundedCents: 0, amountCents: 0, reason: state && "error" in state ? state.error : "Not checked", route: "exception", exceptionType: "paypal_not_found" });
      continue;
    }
    const paypalUsed = state.refundedCents + state.pendingRefundCents;
    const ours = ledger.get(captureId);
    const used = Math.max(paypalUsed, ours?.cents ?? 0); // whichever knows more
    if (ours && ours.cents > paypalUsed) flags.push("paypal_lag");
    const refundable = Math.max(0, state.capturedCents - used);
    const common = { ...base, currency: state.currency, paidCents: state.capturedCents, alreadyRefundedCents: used };
    const dispute = disputesByCapture.get(captureId);

    if (ours && (ours.offered || refundable === 0 || ours.cents >= policyAmount)) {
      drafts.push({
        ...common, amountCents: 0, route: "skip", exceptionType: ours.offered ? "offer_pending" : "already_refunded", disputeId: dispute?.disputeId ?? null,
        reason: ours.offered
          ? `An offer was already sent through dispute ${dispute?.disputeId ?? ""} in an earlier run`
          : `Already refunded ${formatMoney(ours.cents)} by RefundsOut in an earlier run (${ours.refundIds.join(", ")})`,
      });
    } else if (lines.some((l) => l.result.kind === "no_rule")) {
      drafts.push({ ...common, amountCents: 0, reason: lines.find((l) => l.result.kind === "no_rule")!.result.kind === "no_rule" ? explanation : "", route: "exception", exceptionType: "no_rule" });
    } else if (state.status === "REVERSED") {
      drafts.push({ ...common, amountCents: 0, reason: "Charged back through the buyer's bank: money already returned", route: "skip", exceptionType: "chargeback" });
    } else if (dispute && dispute.offeredCents > 0 && dispute.status === "WAITING_FOR_BUYER_RESPONSE") {
      drafts.push({
        ...common, amountCents: 0, disputeId: dispute.disputeId, route: "skip", exceptionType: "offer_pending",
        reason: `Offer of ${formatMoney(dispute.offeredCents)} already sent in dispute ${dispute.disputeId}; waiting for the buyer to accept`,
      });
    } else if (dispute) {
      // Never refund a disputed payment directly: the buyer could be paid twice when the case closes.
      const offer = Math.min(policyAmount, Math.max(0, state.capturedCents - state.refundedCents));
      drafts.push({
        ...common, amountCents: offer, disputeId: dispute.disputeId, route: "dispute_offer", exceptionType: null,
        reason: `Open dispute ${dispute.disputeId}: offer ${formatMoney(offer)} through the dispute instead of refunding. ${explanation}`,
      });
    } else if (state.capturedAt && Date.now() - Date.parse(state.capturedAt) > 180 * DAY_MS) {
      drafts.push({ ...common, amountCents: policyAmount, reason: "Paid more than 180 days ago: PayPal no longer allows a refund", route: "exception", exceptionType: "too_old" });
    } else if (refundable === 0) {
      drafts.push({ ...common, amountCents: 0, reason: `Already refunded in full (${formatMoney(used)})`, route: "skip", exceptionType: "already_refunded" });
    } else if (policyAmount === 0) {
      drafts.push({ ...common, amountCents: 0, reason: explanation || "Nothing to refund under the policy", route: "skip", exceptionType: "nothing_due" });
    } else {
      const amount = Math.min(policyAmount, refundable);
      if (used > 0) flags.push("partly_refunded");
      if (amount < policyAmount) flags.push("capped");
      drafts.push({
        ...common, amountCents: amount, route: "refund", exceptionType: null,
        reason: amount < policyAmount ? `${explanation}; capped at ${formatMoney(amount)} still refundable` : explanation,
      });
    }
  }

  // Possible duplicates: same buyer, same ticket types, separate payments within 10 minutes. The later one needs a decision.
  const byBuyer = new Map<string, { draft: ItemDraft; at: number; tiers: string }[]>();
  for (const d of drafts) {
    if (d.route !== "refund") continue;
    const t = tickets.find((x) => x.paypal_capture_id === d.captureKey);
    if (!t?.purchased_at) continue;
    const key = d.buyerEmail;
    const list = byBuyer.get(key) ?? [];
    list.push({ draft: d, at: new Date(t.purchased_at).getTime(), tiers: d.lines.map((l) => l.tier).sort().join("+") });
    byBuyer.set(key, list);
  }
  for (const list of byBuyer.values()) {
    list.sort((a, b) => a.at - b.at);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      if (cur.tiers === prev.tiers && cur.at - prev.at <= 10 * 60_000) {
        cur.draft.route = "exception";
        cur.draft.exceptionType = "possible_duplicate";
        cur.draft.reason = `Possible duplicate: same buyer bought the same tickets ${Math.round((cur.at - prev.at) / 60000)} min earlier (payment ${prev.draft.captureKey}). ${cur.draft.reason}`;
      }
    }
  }

  const inputsHash = sha(JSON.stringify({ tickets: tickets.map((t) => [t.external_ticket_id, t.price_cents, t.paypal_capture_id, t.tier]), scans: scanRows.length, policy: pol[0].id }));

  // Carry decisions over from the previous plan ("Re-check with PayPal" must not throw away the organizer's work):
  // manual amounts on refund rows, and skip/refund decisions on exceptions that are still the same exception.
  const { rows: prevItems } = await pool.query(
    `select pi.capture_id, pi.route, pi.exception_type, pi.override_cents, pi.override_reason, pi.resolution
       from plan_items pi where pi.plan_id = (select id from refund_plans where event_id=$1 order by created_at desc limit 1)
        and (pi.override_cents is not null or pi.resolution is not null)`,
    [eventId],
  );
  const prevByCapture = new Map(prevItems.map((p) => [p.capture_id as string, p]));
  let carried = 0;
  for (const d of drafts) {
    const prev = prevByCapture.get(d.captureKey);
    if (!prev) continue;
    if (d.route === "refund" && prev.override_cents !== null) {
      const cap = d.paidCents - d.alreadyRefundedCents;
      d.overrideCents = Math.min(Number(prev.override_cents), cap);
      d.overrideReason = prev.override_reason;
      carried++;
    } else if (d.route === "exception" && prev.resolution && prev.route !== "exception" && (prev.exception_type ?? null) === d.exceptionType) {
      d.route = prev.route; // 'refund' or 'skip', as decided before
      d.resolution = prev.resolution;
      carried++;
    }
  }

  return tx(async (db) => {
    const { rows: plan } = await db.query(
      `insert into refund_plans (event_id, policy_id, inputs_hash, plan_hash, total_cents) values ($1,$2,$3,'pending',0) returning id`,
      [eventId, pol[0].id, inputsHash],
    );
    const planId = plan[0].id as string;
    for (const d of drafts) {
      await db.query(
        `insert into plan_items (plan_id, capture_id, buyer_email, buyer_name, currency, paid_cents, already_refunded_cents, amount_cents,
                                 lines, rule_ids, reason, route, exception_type, flags, dispute_id, request_id, override_cents, override_reason, resolution)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [planId, d.captureKey, d.buyerEmail, d.buyerName, d.currency, d.paidCents, d.alreadyRefundedCents, d.amountCents,
         JSON.stringify(d.lines), d.ruleIds, d.reason, d.route, d.exceptionType, d.flags, d.disputeId, refundRequestId(eventId, d.captureKey, d.alreadyRefundedCents),
         d.overrideCents ?? null, d.overrideReason ?? null, d.resolution ?? null],
      );
    }
    const hash = await refreshPlanHash(planId, db);
    if (carried) await audit(db, { actor, action: "plan.carry_over", entity: "plan", entityId: planId, after: { decisionsCarried: carried } });
    await db.query(`update events set status='reviewing' where id=$1`, [eventId]);
    await audit(db, { actor, action: "plan.build", entity: "plan", entityId: planId, after: { items: drafts.length, hash } });
    return planId;
  });
}
