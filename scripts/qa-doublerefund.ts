// Reproduces the double-refund scenario found by QA on Nov 10 and proves the three guards hold:
//   run -> stop mid-way -> build a new plan IMMEDIATELY (PayPal's view still lags) -> run it -> verify with PayPal.
// Moves REAL sandbox money.   npx tsx --env-file=.env scripts/qa-doublerefund.ts
import { readFile } from "node:fs/promises";
import { pool } from "../src/db/client";
import { createEvent, stageSalesFile, confirmSalesMapping, saveScansFile, saveTextDocument, compileEventPolicy, getCurrentPolicy, answerPolicyQuestions, approvePolicy } from "../src/server/events";
import { buildPlan } from "../src/plan/build";
import { getPlanView, resolveException, resolveQuarantined, approvePlan } from "../src/plan/review";
import { startRun, stopRun } from "../src/run/runner";
import { PayPalClient } from "../src/paypal/client";
import { formatMoney } from "../src/lib/money";

let passed = 0, failed = 0;
const ok = (name: string, cond: boolean, detail = "") => { cond ? passed++ : failed++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? " · " + detail : ""}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const maya = "Maya Chen", jordan = "Jordan Ortiz";
const t0 = Date.now(); const t = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

const eventId = await createEvent({ name: "QA double-refund guard", cancelledDay: "Sat", budgetCents: 600_000, approvalThresholdCents: 250_000 });
const s = await stageSalesFile(eventId, "sales.csv", await readFile("data/sample/sales.csv", "utf8"));
await confirmSalesMapping(eventId, s.uploadId, s.mapping, maya);
await saveScansFile(eventId, "scans.csv", await readFile("data/sample/scans.csv", "utf8"), maya);
await saveTextDocument(eventId, "terms", "terms.txt", await readFile("data/sample/terms.txt", "utf8"), maya);
await saveTextDocument(eventId, "notice", "notice.txt", await readFile("data/sample/notice.txt", "utf8"), maya);
await compileEventPolicy(eventId, maya);
let policy = (await getCurrentPolicy(eventId))!;
for (let i = 0; i < 3; i++) {
  const open = policy.questions.filter((q: { answer: string | null }) => !q.answer);
  const bad = policy.checks.some((c: { passed: boolean }) => !c.passed);
  if (!open.length && !bad) break;
  if (open.length) await answerPolicyQuestions(eventId, open.map((q: { id: string; options: { label: string; detail: string }[] }) => ({ questionId: q.id, answer: `${q.options[0].label}: ${q.options[0].detail}` })), maya);
  else await compileEventPolicy(eventId, maya);
  policy = (await getCurrentPolicy(eventId))!;
}
await approvePolicy(eventId, policy.id, maya);
console.log(`[${t()}] policy v${policy.version} approved (${policy.model})`);

async function prepare(planId: string) {
  const v = await getPlanView(planId);
  for (const i of v.items.filter((x) => x.route === "exception")) await resolveException(planId, i.id, "skip", "QA: skip", maya);
  const { rows: q } = await pool.query(`select q.id from quarantined_rows q join uploads u on u.id=q.upload_id where u.event_id=$1 and q.resolution is null`, [eventId]);
  for (const r of q) await resolveQuarantined(Number(r.id), "excluded", "QA", maya);
  await approvePlan(planId, "operator", maya);
  await approvePlan(planId, "approver", jordan);
}

const planA = await buildPlan(eventId, maya);
await prepare(planA);
await startRun(planA, maya);
for (let i = 0; i < 60; i++) {
  await sleep(500);
  const { rows } = await pool.query(`select count(*)::int n from plan_items where plan_id=$1 and paypal_refund_id is not null`, [planA]);
  if (rows[0].n >= 8) break;
}
await stopRun(planA, maya);
console.log(`[${t()}] stopped plan A; building plan B immediately`);
const planB = await buildPlan(eventId, maya); // no wait at all: PayPal's view of the last refunds will still lag
await sleep(3000); // let plan A's in-flight calls land before we read its ledger
const { rows: sentA } = await pool.query(`select capture_id, paypal_refund_id, coalesce(override_cents, amount_cents)::int cents, state from plan_items where plan_id=$1 and paypal_refund_id is not null`, [planA]);
const vB = await getPlanView(planB);
const byCap = new Map(vB.items.map((i) => [i.capture_id, i]));
const missed = sentA.filter((a) => { const b = byCap.get(a.capture_id); return !b || b.route === "refund"; });
const lagged = vB.items.filter((i) => i.flags.includes("paypal_lag")).length;
ok("plan B never re-schedules a payment plan A already refunded", missed.length === 0, `${sentA.length} refunded in A, ${lagged} of them only known from our ledger (PayPal lagging)${missed.length ? "; MISSED " + missed.map((m) => m.capture_id).join(",") : ""}`);
ok("plan B still refunds the rest", vB.items.filter((i) => i.route === "refund").length > 0, `${vB.items.filter((i) => i.route === "refund").length} to refund`);

// Guard 3 on its own: replaying a refund with its request id returns the SAME refund, no new money.
const pp = new PayPalClient();
const sample = sentA[0];
const { rows: itemA } = await pool.query(`select request_id, currency from plan_items where plan_id=$1 and capture_id=$2`, [planA, sample.capture_id]);
const replay = await pp.refundCapture({ captureId: sample.capture_id, amountCents: sample.cents, currency: itemA[0].currency, requestId: itemA[0].request_id });
ok("PayPal replays an identical request id instead of refunding again", replay.data.id === sample.paypal_refund_id, `${replay.data.id} vs ${sample.paypal_refund_id}`);

await prepare(planB);
await startRun(planB, maya);
for (let i = 0; i < 150; i++) { await sleep(2000); const { rows } = await pool.query(`select status from refund_plans where id=$1`, [planB]); if (rows[0].status !== "running") break; }
const { rows: fin } = await pool.query(`select status from refund_plans where id=$1`, [planB]);
ok("plan B finishes", fin[0].status === "done", fin[0].status);

// The real verdict: across the whole event, every refunded payment got exactly one refund, for its planned amount.
const { rows: caps } = await pool.query(
  `select pi.capture_id, count(distinct pi.paypal_refund_id)::int as refunds, sum(coalesce(pi.override_cents, pi.amount_cents)) filter (where pi.paypal_refund_id is not null)::int as cents,
          min(pi.already_refunded_cents)::int as prior
     from plan_items pi join refund_plans rp on rp.id=pi.plan_id where rp.event_id=$1 and pi.paypal_refund_id is not null group by pi.capture_id`, [eventId]);
const twice = caps.filter((c) => c.refunds > 1);
ok("no payment was refunded twice (our ledger)", twice.length === 0, `${caps.length} payments refunded${twice.length ? "; TWICE: " + twice.map((c) => c.capture_id).join(",") : ""}`);
const bad: string[] = [];
for (const c of caps) {
  const st = await pp.getCapture(c.capture_id);
  // Refunds made before this event (e.g. a seeded partial refund) are not ours; count only what this event sent.
  const actual = st.refundedCents + st.pendingRefundCents - c.prior;
  if (actual !== c.cents) bad.push(`${c.capture_id}: PayPal ${formatMoney(actual)} vs planned ${formatMoney(c.cents)}`);
}
ok("no payment was refunded twice (PayPal's own numbers)", bad.length === 0, bad.join("; ").slice(0, 300) || `${caps.length}/${caps.length} match`);
console.log(`\n[${t()}] ${passed} passed, ${failed} failed`);
await pool.end();
process.exit(failed ? 1 : 0);
