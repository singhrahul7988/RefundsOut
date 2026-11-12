// QA: the whole flow plus edge cases, through the same server functions the UI buttons call. Moves REAL sandbox money.
//   npx tsx --env-file=.env scripts/qa-flow.ts
import { readFile } from "node:fs/promises";
import { pool } from "../src/db/client";
import {
  createEvent, stageSalesFile, confirmSalesMapping, saveScansFile, saveTextDocument,
  compileEventPolicy, getCurrentPolicy, answerPolicyQuestions, approvePolicy,
} from "../src/server/events";
import { buildPlan } from "../src/plan/build";
import { latestPlanId, getPlanView, computeGates, overrideAmount, resolveException, resolveQuarantined, approvePlan } from "../src/plan/review";
import { startRun, pauseRun, resumeRun, stopRun } from "../src/run/runner";
import { PayPalClient } from "../src/paypal/client";
import { formatMoney } from "../src/lib/money";

let passed = 0, failed = 0;
const ok = (name: string, cond: boolean, detail = "") => { cond ? passed++ : failed++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? " · " + detail : ""}`); };
const rejects = async (name: string, fn: () => Promise<unknown>, re: RegExp) => {
  try { await fn(); ok(name, false, "did not throw"); } catch (e) { ok(name, re.test((e as Error).message), (e as Error).message.slice(0, 90)); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const maya = "Maya Chen", jordan = "Jordan Ortiz";

const eventId = await createEvent({ name: "QA Festival", cancelledDay: "Sat", budgetCents: 600_000, approvalThresholdCents: 250_000 });
const sales = await readFile("data/sample/sales.csv", "utf8");
const s1 = await stageSalesFile(eventId, "sales.csv", sales);
const s2 = await stageSalesFile(eventId, "sales.csv", sales);
ok("same sales file twice is a no-op (no second Gemini call)", s2.sameFile && s2.uploadId === s1.uploadId);
const imp = await confirmSalesMapping(eventId, s1.uploadId, s1.mapping, maya);
ok("import: 62 tickets, 4 set aside", imp.tickets === 62 && imp.quarantined === 4, JSON.stringify(imp));
const scans = await saveScansFile(eventId, "scans.csv", await readFile("data/sample/scans.csv", "utf8"), maya);
ok("scans: 38 matched, 2 ignored", scans.matched === 38 && scans.unmatched === 2, JSON.stringify(scans));

await rejects("policy compile needs terms + notice first", () => compileEventPolicy(eventId, maya), /terms/i);
await saveTextDocument(eventId, "terms", "terms.txt", await readFile("data/sample/terms.txt", "utf8"), maya);
await saveTextDocument(eventId, "notice", "notice.txt", await readFile("data/sample/notice.txt", "utf8"), maya);
await rejects("plan can't be built before a policy is approved", () => buildPlan(eventId, maya), /approve/i);

await compileEventPolicy(eventId, maya);
let policy = (await getCurrentPolicy(eventId))!;
ok("policy compiled with all checks passing", policy.checks.every((c: { passed: boolean }) => c.passed), policy.model);
const open = policy.questions.filter((q: { answer: string | null }) => !q.answer);
if (open.length) {
  await rejects("approval blocked while a question is open", () => approvePolicy(eventId, policy.id, maya), /question/i);
  await answerPolicyQuestions(eventId, open.map((q: { id: string; options: { label: string; detail: string }[] }) => ({ questionId: q.id, answer: `${q.options[0].label}: ${q.options[0].detail}` })), maya);
  policy = (await getCurrentPolicy(eventId))!;
  ok("recompile after answers leaves no open questions", policy.questions.every((q: { answer: string | null }) => !!q.answer), `v${policy.version}`);
}
await approvePolicy(eventId, policy.id, maya);
ok("policy approved", (await getCurrentPolicy(eventId))!.status === "approved");

let planId = await buildPlan(eventId, maya);
let view = await getPlanView(planId);
const dup = view.items.find((i) => i.exception_type === "possible_duplicate");
const cash = view.items.find((i) => i.exception_type === "not_paypal");
const refundRow = view.items.find((i) => i.route === "refund" && Number(i.already_refunded_cents) === 0);
ok("plan built with expected routes", !!dup && !!cash && !!refundRow, `${view.items.length} items, ${formatMoney(Number(view.plan.total_cents))}`);
ok("Run is locked while decisions are open", !(await computeGates(planId)).every((g) => g.passed));
await rejects("run refuses while gates fail", () => startRun(planId, maya), /locked/i);

await rejects("override needs a reason", () => overrideAmount(planId, refundRow!.id, 1000, "", maya), /reason/i);
await rejects("override can't exceed what's refundable", () => overrideAmount(planId, refundRow!.id, Number(refundRow!.paid_cents) + 100, "too much", maya), /refundable/i);
await rejects("a cash sale can't be refunded through PayPal", () => resolveException(planId, cash!.id, "refund", "please", maya), /duplicat/i);
await overrideAmount(planId, refundRow!.id, 5000, "Goodwill: buyer complained", maya);
await resolveException(planId, dup!.id, "skip", "Buyer confirmed duplicate", maya);
await resolveException(planId, cash!.id, "skip", "Paid in cash at the gate", maya);
const { rows: q } = await pool.query(`select q.id from quarantined_rows q join uploads u on u.id=q.upload_id where u.event_id=$1 and q.resolution is null`, [eventId]);
for (const r of q) await resolveQuarantined(Number(r.id), "excluded", "Test rows", maya);
let gates = await computeGates(planId);
ok("after decisions only the approval gate is open", gates.filter((g) => !g.passed).map((g) => g.id).join() === "approval", gates.filter((g) => !g.passed).map((g) => g.label).join("; "));

await approvePlan(planId, "operator", maya);
await rejects("second approval must be a different person", () => approvePlan(planId, "approver", maya), /different/i);
await approvePlan(planId, "approver", jordan);
ok("two approvals unlock the run", (await computeGates(planId)).every((g) => g.passed));

await overrideAmount(planId, refundRow!.id, 5100, "Changed my mind", maya);
ok("an edit after approval voids the approvals", !(await computeGates(planId)).find((g) => g.id === "approval")!.passed);

const rebuilt = await buildPlan(eventId, maya);
view = await getPlanView(rebuilt);
const carriedOverride = view.items.find((i) => i.capture_id === refundRow!.capture_id);
const carriedDup = view.items.find((i) => i.capture_id === dup!.capture_id);
ok("re-check carries the manual amount over", Number(carriedOverride?.override_cents) === 5100, String(carriedOverride?.override_reason));
ok("re-check carries the skip decision over", carriedDup?.route === "skip" && !!carriedDup?.resolution);
ok("re-check leaves the run locked (needs fresh approvals)", !(await computeGates(rebuilt)).every((g) => g.passed));
planId = rebuilt;
await approvePlan(planId, "operator", maya);
await approvePlan(planId, "approver", jordan);

await startRun(planId, maya);
await rejects("starting an already running plan is refused", () => startRun(planId, maya), /already running/i);
await sleep(4000);
await pauseRun(planId, maya);
const { rows: p1 } = await pool.query(`select status from refund_plans where id=$1`, [planId]);
ok("pause sets status paused", p1[0].status === "paused");
await sleep(3000);
const { rows: c1 } = await pool.query(`select count(*)::int n from plan_items where plan_id=$1 and state in ('rechecking','sending')`, [planId]);
ok("paused run has nothing in flight after a few seconds", c1[0].n === 0);
await resumeRun(planId, maya);
await sleep(5000);
await stopRun(planId, maya);
const { rows: c2 } = await pool.query(`select state, count(*)::int n from plan_items where plan_id=$1 group by state`, [planId]);
const stateMap = Object.fromEntries(c2.map((r) => [r.state, r.n]));
ok("stop cancels what was still queued", (stateMap.cancelled ?? 0) > 0 && (stateMap.refunded ?? 0) + (stateMap.pending ?? 0) + (stateMap.sending ?? 0) > 0, JSON.stringify(stateMap));
await sleep(3000); // let in-flight calls finish

const planB = await buildPlan(eventId, maya); // "Start a new plan" after a stop
const vB = await getPlanView(planB);
const alreadyDone = vB.items.filter((i) => i.exception_type === "already_refunded").length;
const stillToRefund = vB.items.filter((i) => i.route === "refund").length;
ok("new plan after stop skips what was refunded and keeps the rest", alreadyDone >= (stateMap.refunded ?? 0) - 1 && stillToRefund > 0, `${alreadyDone} already refunded, ${stillToRefund} still to refund`);
await approvePlan(planB, "operator", maya);
await approvePlan(planB, "approver", jordan);
await startRun(planB, maya);
for (let i = 0; i < 120; i++) {
  await sleep(2000);
  const { rows } = await pool.query(`select status from refund_plans where id=$1`, [planB]);
  if (rows[0].status !== "running") break;
}
const { rows: fin } = await pool.query(`select status from refund_plans where id=$1`, [planB]);
ok("second run finishes", fin[0].status === "done", fin[0].status);

// Every refunded payment across both runs: exactly one refund, planned amount.
const pp = new PayPalClient();
const { rows: items } = await pool.query(
  `select capture_id, sum(coalesce(override_cents, amount_cents))::int as cents, min(already_refunded_cents)::int as before, count(distinct paypal_refund_id)::int as n
     from plan_items where plan_id in ($1,$2) and paypal_refund_id is not null group by capture_id`, [planId, planB]);
let exact = 0; const bad: string[] = [];
for (const it of items) {
  const s = await pp.getCapture(it.capture_id);
  if (it.n === 1 && s.refundedCents + s.pendingRefundCents === it.before + it.cents) exact++;
  else bad.push(`${it.capture_id}: ${it.n} refunds, PayPal shows ${formatMoney(s.refundedCents + s.pendingRefundCents)} vs expected ${formatMoney(it.before + it.cents)}`);
}
ok("PayPal: every refunded payment was refunded exactly once, for the planned amount", bad.length === 0, `${exact}/${items.length}${bad.length ? "\n" + bad.join("\n") : ""}`);

// HTTP routes
const base = "http://localhost:3000";
const st = await fetch(`${base}/api/plans/${planB}/status`).then((r) => r.json());
ok("status API returns the plan", st.plan?.id === planB && Array.isArray(st.items));
const csv = await fetch(`${base}/api/plans/${planB}/export`);
const csvText = await csv.text();
ok("CSV export works", csv.ok && csv.headers.get("content-type")?.includes("text/csv") === true && csvText.split("\n").length > 10, `${csvText.split("\n").length} lines`);
for (const pg of ["import", "policy", "review", "run", "reconcile", "audit"]) {
  const r = await fetch(`${base}/events/${eventId}/${pg}`);
  const html = await r.text();
  ok(`page /${pg} renders`, r.ok && !/Runtime (Type)?Error|operator does not exist|is not a function/.test(html), String(r.status));
}
const bogus = await fetch(`${base}/events/00000000-0000-0000-0000-000000000000/review`);
ok("unknown event gives 404", bogus.status === 404, String(bogus.status));

console.log(`\n${passed} passed, ${failed} failed`);
await pool.end();
process.exit(failed ? 1 : 0);
