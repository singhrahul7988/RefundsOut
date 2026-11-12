// End-to-end run test with a simulated crash. Moves REAL sandbox money.
//   npx tsx --env-file=.env scripts/run-test.ts prepare   -> resolve decisions, approve as both people
//   npx tsx --env-file=.env scripts/run-test.ts crash     -> start the run, then exit abruptly after ~10 refunds
//   npx tsx --env-file=.env scripts/run-test.ts resume    -> restart: resume the run, wait for the end, verify with PayPal
import { pool } from "../src/db/client";
import { latestPlanId, resolveException, resolveQuarantined, approvePlan, computeGates } from "../src/plan/review";
import { startRun, resumeInterruptedRuns } from "../src/run/runner";
import { PayPalClient } from "../src/paypal/client";
import { formatMoney } from "../src/lib/money";

const mode = process.argv[2];
const { rows: ev } = await pool.query(`select id from events order by created_at desc limit 1`);
const eventId = ev[0].id;
const planId = (await latestPlanId(eventId))!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const counts = async () => {
  const { rows } = await pool.query(`select state, count(*)::int n from plan_items where plan_id=$1 group by state order by state`, [planId]);
  return Object.fromEntries(rows.map((r) => [r.state, r.n]));
};

if (mode === "prepare") {
  const { rows: ex } = await pool.query(`select id, exception_type from plan_items where plan_id=$1 and route='exception'`, [planId]);
  for (const e of ex) {
    await resolveException(planId, e.id, "skip", e.exception_type === "possible_duplicate" ? "Buyer confirmed it was a duplicate; refunding the first order only" : "Box office sale: refunded in cash at the gate", "Maya Chen");
  }
  const { rows: q } = await pool.query(`select q.id from quarantined_rows q join uploads u on u.id=q.upload_id where u.event_id=$1 and q.resolution is null`, [eventId]);
  for (const r of q) await resolveQuarantined(Number(r.id), "excluded", "Test rows from the ticketing export, not real sales", "Maya Chen");
  await approvePlan(planId, "operator", "Maya Chen");
  await approvePlan(planId, "approver", "Jordan Ortiz");
  for (const g of await computeGates(planId)) console.log(`${g.passed ? "✓" : "✗"} ${g.label} — ${g.detail}`);
}

if (mode === "crash") {
  await startRun(planId, "Maya Chen");
  for (;;) {
    await sleep(500);
    const c = await counts();
    if ((c.refunded ?? 0) >= 10) {
      console.log("CRASHING NOW with states:", c);
      process.exit(1); // abrupt: in-flight items stay in 'sending' / 'rechecking'
    }
  }
}

if (mode === "resume") {
  console.log("states after crash:", await counts());
  console.log("resumed runs:", await resumeInterruptedRuns());
  for (;;) {
    await sleep(1500);
    const { rows } = await pool.query(`select status from refund_plans where id=$1`, [planId]);
    if (["done", "paused", "stopped"].includes(rows[0].status)) { console.log("plan", rows[0].status, await counts()); break; }
  }
  // Verify with PayPal: each refunded payment was refunded exactly once, for exactly the planned amount.
  const pp = new PayPalClient();
  const { rows: items } = await pool.query(`select capture_id, coalesce(override_cents, amount_cents)::int as cents, already_refunded_cents::int as before, state from plan_items where plan_id=$1 and state in ('refunded','pending')`, [planId]);
  let ok = 0;
  const bad: string[] = [];
  for (const it of items) {
    const s = await pp.getCapture(it.capture_id);
    const total = s.refundedCents + s.pendingRefundCents;
    if (total === it.before + it.cents) ok++;
    else bad.push(`${it.capture_id}: expected ${formatMoney(it.before + it.cents)} refunded, PayPal shows ${formatMoney(total)}`);
  }
  const { rows: attempts } = await pool.query(`select count(*)::int n, count(distinct ra.paypal_refund_id)::int ids from refund_attempts ra join plan_items pi on pi.id=ra.plan_item_id where pi.plan_id=$1 and ra.paypal_refund_id is not null`, [planId]);
  console.log(`PayPal check: ${ok}/${items.length} payments refunded exactly once for the planned amount.`);
  console.log(`Refund calls that returned an id: ${attempts[0].n}, distinct refund ids: ${attempts[0].ids}`);
  if (bad.length) console.log("MISMATCHES:\n" + bad.join("\n"));
}
await pool.end();
