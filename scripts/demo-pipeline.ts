// Runs the whole dry-run pipeline from the command line, without the UI:
// create event -> import sales (Gemini mapping) -> scans -> terms + notice -> compile policy (Gemini)
// -> answer questions with the first option -> approve -> build plan (PayPal sync). Nothing is refunded.
//
// Run: npx tsx --env-file=.env scripts/demo-pipeline.ts
import { readFile } from "node:fs/promises";
import { pool } from "../src/db/client";
import {
  createEvent, stageSalesFile, confirmSalesMapping, saveScansFile, saveTextDocument,
  compileEventPolicy, getCurrentPolicy, answerPolicyQuestion, approvePolicy,
} from "../src/server/events";
import { buildPlan } from "../src/plan/build";
import { getPlanView } from "../src/plan/review";
import { formatMoney } from "../src/lib/money";

const actor = "Maya Chen";
const t = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const t0 = Date.now();

const eventId = await createEvent({ name: "Riverside Sound Festival 2026", cancelledDay: "Sat", budgetCents: 600_000, approvalThresholdCents: 250_000 });
console.log(`[${t()}] event ${eventId}`);

const sales = await readFile("data/sample/sales.csv", "utf8");
const staged = await stageSalesFile(eventId, "sales_export_final_v2.csv", sales);
console.log(`[${t()}] mapping suggested for ${staged.rowCount} rows`);
const imported = await confirmSalesMapping(eventId, staged.uploadId, staged.mapping, actor);
console.log(`[${t()}] imported ${imported.tickets} tickets, ${imported.quarantined} set aside`);

const scans = await saveScansFile(eventId, "gate_scans_fri_sun.csv", await readFile("data/sample/scans.csv", "utf8"), actor);
console.log(`[${t()}] scans matched ${scans.matched}, unmatched ${scans.unmatched}`);
await saveTextDocument(eventId, "terms", "Riverside_Ticket_Terms_2026.txt", await readFile("data/sample/terms.txt", "utf8"), actor);
await saveTextDocument(eventId, "notice", "cancellation_notice.txt", await readFile("data/sample/notice.txt", "utf8"), actor);

await compileEventPolicy(eventId, actor);
let policy = await getCurrentPolicy(eventId);
console.log(`[${t()}] policy v${policy!.version} (${policy!.model}): ${policy!.checks.map((c: { id: string; passed: boolean }) => `${c.id}=${c.passed ? "ok" : "FAIL"}`).join(" ")}`);
for (const q of policy!.questions.filter((q: { answer: string | null }) => !q.answer)) {
  const opt = (q.options as { label: string; detail: string }[])[0];
  console.log(`[${t()}] Q: ${q.question} -> answering "${opt.label}: ${opt.detail}"`);
  await answerPolicyQuestion(eventId, q.id, `${opt.label}: ${opt.detail}`, actor);
  policy = await getCurrentPolicy(eventId);
}
await approvePolicy(eventId, policy!.id, actor);
console.log(`[${t()}] approved policy v${policy!.version}`);

const planId = await buildPlan(eventId, actor);
const view = await getPlanView(planId);
console.log(`[${t()}] plan ${planId}: total ${formatMoney(Number(view.plan.total_cents))}, ${view.items.length} items`);
const byRoute: Record<string, number> = {};
for (const i of view.items) byRoute[`${i.route}${i.exception_type ? ":" + i.exception_type : ""}`] = (byRoute[`${i.route}${i.exception_type ? ":" + i.exception_type : ""}`] ?? 0) + 1;
console.log(byRoute);
for (const i of view.items.filter((i) => i.route !== "refund" || i.flags.length)) {
  console.log(` - ${i.route}${i.exception_type ? `/${i.exception_type}` : ""} ${i.capture_id} ${formatMoney(Number(i.amount_cents))} [${i.flags}] ${i.reason.slice(0, 110)}`);
}
for (const g of view.gates) console.log(` gate ${g.passed ? "✓" : "✗"} ${g.label} — ${g.detail}`);
await pool.end();
