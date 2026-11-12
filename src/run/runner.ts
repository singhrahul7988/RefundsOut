import { createHash } from "node:crypto";
import { pool, tx, audit } from "@/db/client";
import { PayPalClient, PayPalError } from "@/paypal/client";
import { computeGates } from "@/plan/review";
import { formatMoney } from "@/lib/money";

// The run engine. Durable: every state lives in Postgres, so a crash or restart never loses or repeats a refund.
// Items are claimed with FOR UPDATE SKIP LOCKED (a Postgres-backed queue), a few at a time.

const CONCURRENCY = Number(process.env.RUN_CONCURRENCY ?? 4);
const MAX_ATTEMPTS = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Item = {
  id: string;
  plan_id: string;
  capture_id: string;
  currency: string;
  amount_cents: string;
  override_cents: string | null;
  route: "refund" | "dispute_offer";
  state: string;
  request_id: string;
  dispute_id: string | null;
  attempts: number;
  buyer_name: string | null;
};

// planId -> loop, one per process. Kept on globalThis because Next.js can load this module more than once.
// Even if two loops ever ran, SKIP LOCKED claiming plus fixed request ids keep every refund single.
const g = globalThis as unknown as { __refundsoutLoops?: Map<string, Promise<void>> };
const running: Map<string, Promise<void>> = (g.__refundsoutLoops ??= new Map());

async function setState(itemId: string, state: string, extra: Record<string, unknown> = {}) {
  const keys = Object.keys(extra);
  const sets = keys.map((k, i) => `${k}=$${i + 3}`).join(", ");
  await pool.query(`update plan_items set state=$2${sets ? ", " + sets : ""}, updated_at=now() where id=$1`, [itemId, state, ...keys.map((k) => extra[k])]);
}

async function logAttempt(item: Item, attemptNo: number, result: string, extra: { http?: number; refundId?: string; debugId?: string; error?: string } = {}) {
  await pool.query(
    `insert into refund_attempts (plan_item_id, request_id, attempt_no, http_status, result, paypal_refund_id, paypal_debug_id, error_name) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [item.id, item.request_id, attemptNo, extra.http ?? null, result, extra.refundId ?? null, extra.debugId ?? null, extra.error ?? null],
  );
}

/** Start (or resume) a run. Refuses unless every gate passes. */
export async function startRun(planId: string, actor: string) {
  const gates = await computeGates(planId);
  const failing = gates.filter((g) => !g.passed);
  if (failing.length) throw new Error(`Run is locked: ${failing.map((g) => g.label).join("; ")}`);

  await tx(async (db) => {
    const { rows } = await db.query(`select status from refund_plans where id=$1 for update`, [planId]);
    if (rows[0].status === "running") throw new Error("This plan is already running.");
    if (["done", "stopped"].includes(rows[0].status)) throw new Error("This plan has finished. Build a new plan to refund again.");
    await db.query(`update refund_plans set status='running', started_at=coalesce(started_at, now()) where id=$1`, [planId]);
    await db.query(`update plan_items set state='queued', updated_at=now() where plan_id=$1 and route in ('refund','dispute_offer') and state in ('planned','approved')`, [planId]);
    await db.query(`update plan_items set state='skipped', updated_at=now() where plan_id=$1 and route='skip' and state='planned'`, [planId]);
    await db.query(`update events set status='running' where id=(select event_id from refund_plans where id=$1)`, [planId]);
    await audit(db, { actor, action: "run.start", entity: "plan", entityId: planId });
  });
  ensureLoop(planId);
}

export async function pauseRun(planId: string, actor: string) {
  await pool.query(`update refund_plans set status='paused' where id=$1 and status='running'`, [planId]);
  await audit(pool, { actor, action: "run.pause", entity: "plan", entityId: planId });
}

export async function resumeRun(planId: string, actor: string) {
  const { rowCount } = await pool.query(`update refund_plans set status='running' where id=$1 and status='paused'`, [planId]);
  if (rowCount) {
    await audit(pool, { actor, action: "run.resume", entity: "plan", entityId: planId });
    ensureLoop(planId);
  }
}

/** Stop: cancel everything not yet sent. Calls already in flight finish first. */
export async function stopRun(planId: string, actor: string) {
  await tx(async (db) => {
    await db.query(`update refund_plans set status='stopped', finished_at=now() where id=$1 and status in ('running','paused')`, [planId]);
    await db.query(`update plan_items set state='cancelled', updated_at=now() where plan_id=$1 and state='queued'`, [planId]);
    await audit(db, { actor, action: "run.stop", entity: "plan", entityId: planId });
  });
}

/** After a crash or restart: put half-done items back in the queue. Same request id, so nothing is paid twice. */
export async function resumeInterruptedRuns() {
  await pool.query(`update plan_items set state='queued' where state in ('rechecking','sending') and plan_id in (select id from refund_plans where status='running')`);
  const { rows } = await pool.query(`select id from refund_plans where status='running'`);
  for (const r of rows) ensureLoop(r.id);
  return rows.length;
}

export function ensureLoop(planId: string) {
  if (running.has(planId)) return;
  const loop = runLoop(planId)
    .catch((err) => console.error(`[run ${planId}] loop crashed:`, err))
    .finally(() => running.delete(planId));
  running.set(planId, loop);
}

async function runLoop(planId: string) {
  const pp = new PayPalClient();
  let consecutiveFailures = 0;
  for (;;) {
    const { rows: st } = await pool.query(`select status from refund_plans where id=$1`, [planId]);
    if (st[0]?.status !== "running") return;

    const { rows: batch } = await pool.query<Item>(
      `update plan_items set state='rechecking', updated_at=now()
        where id in (select id from plan_items where plan_id=$1 and state='queued' order by updated_at, id limit $2 for update skip locked)
        returning *`,
      [planId, CONCURRENCY],
    );

    if (batch.length === 0) {
      const pending = await checkPendingRefunds(planId, pp);
      // The run ends when nothing is queued or in flight. Refunds PayPal is still finishing (e.g. funded by
      // eCheck) stay 'pending' and keep being checked from the Reconcile screen; they don't hold the run open.
      const { rows: left } = await pool.query(`select count(*) as n from plan_items where plan_id=$1 and state in ('queued','rechecking','sending')`, [planId]);
      if (Number(left[0].n) === 0) {
        await pool.query(`update refund_plans set status='done', finished_at=now() where id=$1 and status='running'`, [planId]);
        await pool.query(`update events set status='done' where id=(select event_id from refund_plans where id=$1)`, [planId]);
        await audit(pool, { actor: "runner", action: "run.done", entity: "plan", entityId: planId });
        return;
      }
      await sleep(pending ? 3000 : 1000);
      continue;
    }

    const results = await Promise.all(batch.map((item) => processItem(item, pp)));
    consecutiveFailures = results.every((r) => r === "failed") ? consecutiveFailures + results.length : 0;
    if (consecutiveFailures >= 8) {
      await pool.query(`update refund_plans set status='paused' where id=$1 and status='running'`, [planId]);
      await audit(pool, { actor: "runner", action: "run.auto_pause", entity: "plan", entityId: planId, after: { reason: "too many failures in a row" } });
      return;
    }
  }
}

type Outcome = "ok" | "retry" | "failed" | "skipped";

async function processItem(item: Item, pp: PayPalClient): Promise<Outcome> {
  const amount = Number(item.override_cents ?? item.amount_cents);
  const attemptNo = item.attempts + 1;

  // 1. Re-check the payment with PayPal right before money moves.
  let capture;
  try {
    capture = await pp.getCapture(item.capture_id);
  } catch (err) {
    return retryOrFail(item, attemptNo, err);
  }
  const disputeHold = capture.statusReason === "BUYER_COMPLAINT";
  // Already sent at least once (e.g. the process died mid-call): don't re-judge the payment, because our own
  // earlier refund may have changed it. Resend with the SAME request id and PayPal returns the original refund.
  const replay = item.attempts > 0;

  if (item.route === "refund" && replay && disputeHold && capture.refundableCents >= amount) {
    await setState(item.id, "needs_attention", { last_error: "A dispute was opened while this refund was in flight. Check it in PayPal before resending." });
    return "failed";
  }
  if (item.route === "refund" && !replay) {
    if (capture.status === "REVERSED") return skip(item, "Charged back since approval");
    if (disputeHold) return skip(item, "Buyer opened a dispute after approval. Handle it as a dispute offer.");
    // Our own ledger beats PayPal's possibly lagging view: anything another plan item already sent for this payment counts.
    const { rows: prior } = await pool.query(
      `select coalesce(sum(coalesce(o.override_cents, o.amount_cents)),0)::bigint as cents, array_remove(array_agg(o.paypal_refund_id), null) as ids
         from plan_items o join refund_plans orp on orp.id = o.plan_id
        where o.capture_id = $1 and o.id <> $2 and o.paypal_refund_id is not null and o.state in ('refunded','pending','reconciled')
          and orp.event_id = (select event_id from refund_plans where id = $3)`,
      [item.capture_id, item.id, item.plan_id],
    );
    const ledgerUsed = Number(prior[0].cents);
    const refundable = Math.min(capture.refundableCents, capture.capturedCents - ledgerUsed);
    if (refundable < amount) {
      if (ledgerUsed > 0 && refundable <= 0) return skip(item, `Already refunded by RefundsOut in an earlier run (${(prior[0].ids as string[]).join(", ")})`);
      if (refundable <= 0) return skip(item, "Already refunded since approval");
      await setState(item.id, "needs_attention", { last_error: `Only ${formatMoney(refundable)} is still refundable (plan said ${formatMoney(amount)})` });
      return "failed";
    }
  }

  // 2. Send the money call with the item's fixed request id.
  await setState(item.id, "sending", { attempts: attemptNo });
  try {
    if (item.route === "dispute_offer") {
      // An offer can't be undone, so before (re)sending check whether this dispute already carries ours.
      const dispute = (await pp.getDispute(item.dispute_id!)) as { offer?: { seller_offered_amount?: { value: string } }; status?: string };
      if (dispute.offer?.seller_offered_amount) {
        await logAttempt(item, attemptNo, "offer_sent", { error: "offer already on the dispute" });
        await setState(item.id, "offer_sent", { last_error: null });
        return "ok";
      }
      const res = await pp.makeOffer({
        disputeId: item.dispute_id!,
        amountCents: amount,
        currency: item.currency,
        note: `Refund offer under the festival's cancellation policy: ${formatMoney(amount)}.`,
        requestId: createHash("sha256").update(`${item.request_id}:offer`).digest("hex").slice(0, 40),
      });
      await logAttempt(item, attemptNo, "offer_sent", { http: res.status, debugId: res.debugId });
      await setState(item.id, "offer_sent", { last_error: null });
      return "ok";
    }
    const res = await pp.refundCapture({
      captureId: item.capture_id,
      amountCents: amount,
      currency: item.currency,
      requestId: item.request_id,
      invoiceId: `RO-${item.request_id.slice(3, 23)}`,
      noteToPayer: "Refund for the cancelled festival day, under the ticket terms.",
    });
    const status = res.data.status;
    // PayPal replays an earlier refund when it has seen this request id before. If that refund belongs to ANOTHER
    // item (an earlier plan), no new money moved: record that instead of counting it as a fresh refund.
    const { rows: dupe } = await pool.query(`select id from plan_items where paypal_refund_id = $1 and id <> $2 limit 1`, [res.data.id, item.id]);
    if (dupe.length) {
      await logAttempt(item, attemptNo, "skipped", { http: res.status, refundId: res.data.id, debugId: res.debugId, error: "replayed earlier refund" });
      return skip(item, `PayPal returned the refund already made in an earlier run (${res.data.id}); nothing new was sent`);
    }
    await logAttempt(item, attemptNo, status === "COMPLETED" ? "completed" : "pending", { http: res.status, refundId: res.data.id, debugId: res.debugId });
    await setState(item.id, status === "COMPLETED" ? "refunded" : "pending", { paypal_refund_id: res.data.id, last_error: null });
    return "ok";
  } catch (err) {
    if (err instanceof PayPalError && /INSUFFICIENT_FUNDS/i.test(err.issue ?? "")) {
      await pool.query(`update refund_plans set status='paused' where id=$1`, [item.plan_id]);
      await setState(item.id, "queued", { last_error: "Not enough money in the PayPal account. Run paused: add funds, then resume." });
      return "failed";
    }
    return retryOrFail(item, attemptNo, err);
  }
}

async function skip(item: Item, reason: string): Promise<Outcome> {
  await setState(item.id, "skipped", { last_error: reason });
  await audit(pool, { actor: "runner", action: "item.skip", entity: "plan_item", entityId: item.id, after: { reason } });
  return "skipped";
}

async function retryOrFail(item: Item, attemptNo: number, err: unknown): Promise<Outcome> {
  const e = err as PayPalError;
  await logAttempt(item, attemptNo, e.retryable ? "retry" : "failed", { http: e.status, debugId: e.debugId, error: e.issue ?? e.message });
  if (e.retryable && attemptNo < MAX_ATTEMPTS) {
    await setState(item.id, "queued", { attempts: attemptNo, last_error: `PayPal busy (${e.status}). Retry ${attemptNo + 1} of ${MAX_ATTEMPTS}, same request id.` });
    return "retry";
  }
  await setState(item.id, "needs_attention", { attempts: attemptNo, last_error: e.message });
  return "failed";
}

/** Refunds that came back PENDING are checked until PayPal finishes them. */
export async function checkPendingRefunds(planId: string, pp: PayPalClient = new PayPalClient()): Promise<boolean> {
  const { rows } = await pool.query(`select id, paypal_refund_id from plan_items where plan_id=$1 and state='pending'`, [planId]);
  for (const r of rows) {
    try {
      const refund = await pp.getRefund(r.paypal_refund_id);
      if (refund.status === "COMPLETED") await setState(r.id, "refunded");
      else if (["FAILED", "CANCELLED"].includes(refund.status)) await setState(r.id, "needs_attention", { last_error: `PayPal reported the refund ${refund.status.toLowerCase()}` });
    } catch {
      /* try again next loop */
    }
  }
  return rows.length > 0;
}

export async function runStatus(planId: string) {
  const { rows: plan } = await pool.query(`select id, status, total_cents, started_at, finished_at from refund_plans where id=$1`, [planId]);
  const { rows: counts } = await pool.query(
    `select state, count(*)::int as n, coalesce(sum(coalesce(override_cents, amount_cents)),0)::bigint as cents from plan_items where plan_id=$1 group by state`,
    [planId],
  );
  return { plan: plan[0], counts };
}
