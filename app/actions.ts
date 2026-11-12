"use server";

import { readFile } from "node:fs/promises";
import path from "node:path";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentUser } from "@/server/user";
import {
  createEvent, stageSalesFile, confirmSalesMapping, saveScansFile, saveTextDocument,
  compileEventPolicy, answerPolicyQuestions, approvePolicy, hideEvents, restoreEvents, keepQuarantinedRow,
} from "@/server/events";
import type { ColumnMapping } from "@/ai/mapColumns";
import { buildPlan } from "@/plan/build";
import { overrideAmount, resolveException, resolveQuarantined, approvePlan } from "@/plan/review";
import { startRun, pauseRun, resumeRun, stopRun, runStatus } from "@/run/runner";
import { generateJsonFromSchema } from "@/ai/gemini";
import { toCents } from "@/lib/money";

export type ActionResult<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

async function attempt<T>(fn: () => Promise<T>, revalidate?: string): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    if (revalidate) revalidatePath(revalidate, "layout");
    return { ok: true, data };
  } catch (err) {
    console.error(err);
    return { ok: false, error: (err as Error).message };
  }
}

const eventPath = (id: string) => `/events/${id}`;

// ---------- Identity ----------
export async function switchUserAction(userId: "maya" | "jordan", returnTo: string) {
  (await cookies()).set("ro_user", userId, { path: "/", sameSite: "lax" });
  revalidatePath(returnTo, "layout");
}

// ---------- Recent runs (home page) ----------
// "Clear" hides runs; it never deletes them. Running runs are skipped.
export async function clearRunsAction(ids: string[] | null) {
  const user = await currentUser();
  return attempt(() => hideEvents(ids, user.name), "/");
}
export async function restoreRunsAction(ids: string[]) {
  const user = await currentUser();
  return attempt(() => restoreEvents(ids, user.name), "/");
}

// ---------- Event + import ----------
export async function createEventAction(formData: FormData) {
  const sample = formData.get("intent") === "sample";
  const name = String(formData.get("name") ?? "").trim() || "Riverside Sound Festival 2026";
  const budget = toCents(String(formData.get("budget") ?? "")) ?? 600_000;
  const id = await createEvent({ name, cancelledDay: String(formData.get("cancelledDay") ?? "Sat"), budgetCents: budget, approvalThresholdCents: 250_000 });
  if (sample) {
    const user = await currentUser();
    await loadSampleFiles(id, user.name); // judges can try the whole flow in one click
  }
  redirect(`/events/${id}/import`);
}

async function loadSampleFiles(eventId: string, actor: string) {
  const dir = path.join(process.cwd(), "data", "sample");
  const [sales, scans, terms, notice] = await Promise.all(
    ["sales.csv", "scans.csv", "terms.txt", "notice.txt"].map((f) => readFile(path.join(dir, f), "utf8")),
  );
  await saveTextDocument(eventId, "terms", "Riverside_Ticket_Terms_2026.txt", terms, actor);
  await saveTextDocument(eventId, "notice", "cancellation_notice.txt", notice, actor);
  const staged = await stageSalesFile(eventId, "sales_export_final_v2.csv", sales);
  await saveScansFile(eventId, "gate_scans_fri_sun.csv", scans, actor);
  return staged;
}

export async function stageSalesAction(eventId: string, fileName: string, text: string) {
  return attempt(() => stageSalesFile(eventId, fileName, text));
}

export async function confirmMappingAction(eventId: string, uploadId: string, mapping: ColumnMapping) {
  const user = await currentUser();
  return attempt(() => confirmSalesMapping(eventId, uploadId, mapping, user.name), eventPath(eventId));
}

export async function uploadScansAction(eventId: string, fileName: string, text: string) {
  const user = await currentUser();
  return attempt(() => saveScansFile(eventId, fileName, text, user.name), eventPath(eventId));
}

export async function uploadTextAction(eventId: string, kind: "terms" | "notice", fileName: string, text: string) {
  const user = await currentUser();
  return attempt(() => saveTextDocument(eventId, kind, fileName, text, user.name), eventPath(eventId));
}

/** Loads the bundled Riverside sample files so judges can try the flow without their own data. */
export async function loadSampleFilesAction(eventId: string) {
  const dir = path.join(process.cwd(), "data", "sample");
  const [sales, scans, terms, notice] = await Promise.all(
    ["sales.csv", "scans.csv", "terms.txt", "notice.txt"].map((f) => readFile(path.join(dir, f), "utf8")),
  );
  const user = await currentUser();
  return attempt(async () => {
    await saveTextDocument(eventId, "terms", "Riverside_Ticket_Terms_2026.txt", terms, user.name);
    await saveTextDocument(eventId, "notice", "cancellation_notice.txt", notice, user.name);
    const staged = await stageSalesFile(eventId, "sales_export_final_v2.csv", sales);
    return { staged, scansText: scans };
  });
}

// ---------- Policy ----------
export async function compilePolicyAction(eventId: string) {
  const user = await currentUser();
  return attempt(() => compileEventPolicy(eventId, user.name), eventPath(eventId));
}

export async function answerQuestionsAction(eventId: string, answers: { questionId: string; answer: string }[]) {
  const user = await currentUser();
  return attempt(() => answerPolicyQuestions(eventId, answers, user.name), eventPath(eventId));
}

export async function approvePolicyAction(eventId: string, policyId: string) {
  const user = await currentUser();
  return attempt(() => approvePolicy(eventId, policyId, user.name), eventPath(eventId));
}

// ---------- Review ----------
export async function buildPlanAction(eventId: string) {
  const user = await currentUser();
  return attempt(() => buildPlan(eventId, user.name), eventPath(eventId));
}

export async function overrideAmountAction(eventId: string, planId: string, itemId: string, dollars: string, reason: string) {
  const user = await currentUser();
  const cents = toCents(dollars);
  if (cents === null) return { ok: false as const, error: "Enter an amount like 73.00" };
  return attempt(() => overrideAmount(planId, itemId, cents, reason, user.name), eventPath(eventId));
}

export async function resolveExceptionAction(eventId: string, planId: string, itemId: string, decision: "refund" | "skip", note: string) {
  const user = await currentUser();
  return attempt(() => resolveException(planId, itemId, decision, note, user.name), eventPath(eventId));
}

export async function keepRowAction(eventId: string, rowId: number) {
  const user = await currentUser();
  return attempt(() => keepQuarantinedRow(eventId, rowId, user.name), eventPath(eventId));
}

export async function excludeRowAction(eventId: string, rowId: number, note: string) {
  const user = await currentUser();
  return attempt(() => resolveQuarantined(rowId, "excluded", note, user.name), eventPath(eventId));
}

export async function approvePlanAction(eventId: string, planId: string) {
  const user = await currentUser();
  return attempt(() => approvePlan(planId, user.role, user.name), eventPath(eventId));
}

/** "Ask the grid": AG Grid describes its state as a JSON schema; Gemini fills it from a plain-English question. */
export async function askGridAction(question: string, schema: Record<string, unknown>, columns: string) {
  return attempt(() =>
    generateJsonFromSchema(
      `You control an AG Grid of refund rows by returning grid state (filters, sort, row grouping, column visibility) that answers the user's request.
Only use columns that exist. Columns: ${columns}. Money columns are in dollars. Return the full state object.`,
      question,
      schema,
    ),
  );
}

// ---------- Run ----------
export async function startRunAction(eventId: string, planId: string) {
  const user = await currentUser();
  const res = await attempt(() => startRun(planId, user.name), eventPath(eventId));
  if (res.ok) redirect(`/events/${eventId}/run`);
  return res;
}
export async function pauseRunAction(eventId: string, planId: string) {
  const user = await currentUser();
  return attempt(() => pauseRun(planId, user.name), eventPath(eventId));
}
export async function resumeRunAction(eventId: string, planId: string) {
  const user = await currentUser();
  return attempt(() => resumeRun(planId, user.name), eventPath(eventId));
}
export async function stopRunAction(eventId: string, planId: string) {
  const user = await currentUser();
  return attempt(() => stopRun(planId, user.name), eventPath(eventId));
}
export async function runStatusAction(planId: string) {
  return runStatus(planId);
}

// ---------- Letters ----------
export async function writeLetterAction(eventId: string, itemId: string) {
  return attempt(async () => {
    const { pool } = await import("@/db/client");
    const { writeLetter } = await import("@/ai/letters");
    const { rows } = await pool.query(
      `select pi.*, e.name as event_name, e.cancelled_day, p.rules_json from plan_items pi join refund_plans rp on rp.id=pi.plan_id
         join events e on e.id=rp.event_id join policies p on p.id=rp.policy_id where pi.id=$1 and e.id=$2`,
      [itemId, eventId],
    );
    const i = rows[0];
    if (!i) throw new Error("Payment not found");
    if (i.letter) return JSON.parse(i.letter) as { to: string; subject: string; body: string };
    const rules = [...(i.rules_json.rules ?? []), ...(i.rules_json.deductions ?? [])] as { id: string; clause: string; title: string }[];
    const ruleText = (i.rule_ids as string[]).map((rid) => rules.find((r) => r.id === rid)).filter(Boolean).map((r) => `clause ${r!.clause}, ${r!.title.split(" ").map((w) => (/^[A-Z0-9]{2,}$/.test(w) ? w : w.toLowerCase())).join(" ")}`).join("; ");
    const lines = i.lines as { tier: string }[];
    // "a Sunday Day Pass", "2 Sunday Day Pass tickets", "a VIP Weekend and a Camping add-on": counts matter (Mina Park holds two).
    const tierCounts = new Map<string, number>();
    for (const l of lines) tierCounts.set(l.tier, (tierCounts.get(l.tier) ?? 0) + 1);
    const tiers = [...tierCounts].map(([t, n]) => (n > 1 ? `${n} ${t} tickets` : `${/^[aeiou]/i.test(t) ? "an" : "a"} ${t}`)).join(" and ");
    const dayName: Record<string, string> = { Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };
    const offer = i.state === "offer_sent";
    const { body } = await writeLetter({
      firstName: (i.buyer_name ?? "there").split(" ")[0], event: i.event_name, cancelledDay: dayName[i.cancelled_day] ?? i.cancelled_day,
      tickets: tiers || "your ticket", amountCents: Number(i.override_cents ?? i.amount_cents), reason: ruleText || "the cancellation terms",
      reference: i.paypal_refund_id ?? i.dispute_id ?? i.capture_id, method: offer ? "offer" : "refund",
    });
    const dayLabel = dayName[i.cancelled_day] ?? i.cancelled_day;
    const letter = { to: i.buyer_email, subject: `Your ${dayLabel} refund: $${(Number(i.override_cents ?? i.amount_cents) / 100).toFixed(2)}`, body };
    await pool.query(`update plan_items set letter=$2 where id=$1`, [itemId, JSON.stringify(letter)]);
    return letter;
  });
}
