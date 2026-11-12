import { pool, tx, audit } from "@/db/client";
import { refreshPlanHash } from "./build";
import { formatMoney } from "@/lib/money";

export type Gate = { id: string; label: string; detail: string; passed: boolean };

export async function latestPlanId(eventId: string): Promise<string | null> {
  const { rows } = await pool.query(`select id from refund_plans where event_id=$1 order by created_at desc limit 1`, [eventId]);
  return rows[0]?.id ?? null;
}

/** The five checks that lock or unlock "Run refunds". Computed fresh on every read. */
export async function computeGates(planId: string): Promise<Gate[]> {
  const { rows: p } = await pool.query(
    `select rp.*, e.refund_budget_cents, e.approval_threshold_cents, pol.version, pol.status as policy_status, pol.tests_json
       from refund_plans rp join events e on e.id=rp.event_id join policies pol on pol.id=rp.policy_id where rp.id=$1`,
    [planId],
  );
  const plan = p[0];
  if (!plan) throw new Error("Plan not found");
  const tests = (plan.tests_json ?? []) as { passed: boolean }[];
  const passedTests = tests.filter((t) => t.passed).length;

  const { rows: sync } = await pool.query(
    `select count(*) as n, count(*) filter (where pi.route='skip') as skipped, min(ps.fetched_at) as oldest from plan_items pi join payment_snapshots ps on ps.capture_id = pi.capture_id where pi.plan_id=$1`,
    [planId],
  );
  const syncedMinutes = sync[0].oldest ? Math.round((Date.now() - new Date(sync[0].oldest).getTime()) / 60000) : null;

  const { rows: ex } = await pool.query(
    `select count(*) filter (where route='exception') as open_exceptions from plan_items where plan_id=$1`,
    [planId],
  );
  const { rows: q } = await pool.query(
    `select count(*) as n from quarantined_rows qr join uploads u on u.id=qr.upload_id where u.event_id=$1 and qr.resolution is null`,
    [plan.event_id],
  );
  const open = Number(ex[0].open_exceptions) + Number(q[0].n);

  const total = Number(plan.total_cents);
  const budget = Number(plan.refund_budget_cents);
  const { rows: appr } = await pool.query(`select role, user_name from approvals where plan_id=$1 and plan_hash=$2`, [planId, plan.plan_hash]);
  const needsSecond = total > Number(plan.approval_threshold_cents);
  // "$2,500.00" → "$2,500": the gate box is narrow and the limit is a round number.
  const limit = formatMoney(Number(plan.approval_threshold_cents)).replace(/\.00$/, "");
  const operator = appr.find((a) => a.role === "operator");
  const approver = appr.find((a) => a.role === "approver" && a.user_name !== operator?.user_name);

  return [
    {
      id: "policy",
      label: `Policy version ${plan.version} approved`,
      detail: `${passedTests} of ${tests.length} tests pass`,
      passed: plan.policy_status === "approved" && passedTests === tests.length,
    },
    {
      id: "synced",
      label: "All payments verified",
      // Skipped rows (e.g. already refunded) are checked with PayPal too; say so, or the count won't match the "PayPal payments" card.
      detail: `${Number(sync[0].skipped) > 0 ? `${Number(sync[0].n) - Number(sync[0].skipped)} + ${sync[0].skipped} skipped` : `${sync[0].n} payments`} · ${syncedMinutes === null ? "not synced yet" : syncedMinutes < 1 ? "just now" : `${syncedMinutes} min ago`}`,
      passed: syncedMinutes !== null && syncedMinutes <= 60,
    },
    {
      id: "exceptions",
      label: open === 0 ? "No open exceptions" : `${open} ${open === 1 ? "item needs" : "items need"} a decision`,
      detail: open === 0 ? "Every row has a route" : "Pinned at the top of the grid",
      passed: open === 0,
    },
    {
      id: "budget",
      label: total <= budget ? "Within budget" : "Over budget",
      detail: `${formatMoney(total)} of ${formatMoney(budget)}`,
      passed: total <= budget,
    },
    {
      id: "approval",
      label: !operator ? "Operator approval needed" : needsSecond && !approver ? "Second approval needed" : "Approved",
      // Always name the limit, so it's clear why one sign-off is enough (or why two are needed).
      detail: needsSecond
        ? `Over ${limit}: needs two people`
        : `${operator ? `By ${operator.user_name}` : "One approval"} (under ${limit})`,
      passed: !!operator && (!needsSecond || !!approver),
    },
  ];
}

export async function getPlanView(planId: string) {
  const { rows: plan } = await pool.query(
    `select rp.*, e.name as event_name, e.refund_budget_cents, e.approval_threshold_cents, pol.version as policy_version
       from refund_plans rp join events e on e.id=rp.event_id join policies pol on pol.id=rp.policy_id where rp.id=$1`,
    [planId],
  );
  const { rows: items } = await pool.query(`select * from plan_items where plan_id=$1 order by route, capture_id`, [planId]);
  const { rows: approvals } = await pool.query(`select * from approvals where plan_id=$1 and plan_hash=$2 order by approved_at`, [planId, plan[0]?.plan_hash]);
  return { plan: plan[0], items, approvals, gates: await computeGates(planId) };
}

async function assertEditable(db: Pick<typeof pool, "query">, planId: string) {
  const { rows } = await db.query(`select status from refund_plans where id=$1 for update`, [planId]);
  if (!rows[0]) throw new Error("Plan not found");
  if (!["draft", "approved"].includes(rows[0].status)) throw new Error("The plan can't be edited once a run has started.");
}

/** Manual amount change. Needs a reason, is capped at what's still refundable, and voids approvals (the plan hash changes). */
export async function overrideAmount(planId: string, itemId: string, cents: number, reason: string, actor: string) {
  if (!Number.isInteger(cents) || cents < 0) throw new Error("Amount must be a positive number of cents.");
  if (reason.trim().length < 3) throw new Error("Give a reason for the change.");
  return tx(async (db) => {
    await assertEditable(db, planId);
    const { rows } = await db.query(`select * from plan_items where id=$1 and plan_id=$2`, [itemId, planId]);
    const item = rows[0];
    if (!item) throw new Error("Row not found");
    const max = Number(item.paid_cents) - Number(item.already_refunded_cents);
    if (cents > max) throw new Error(`Can't refund more than ${formatMoney(max)} still refundable on this payment.`);
    await db.query(`update plan_items set override_cents=$2, override_reason=$3, updated_at=now() where id=$1`, [itemId, cents, reason.trim()]);
    await db.query(`update refund_plans set status='draft' where id=$1`, [planId]);
    await audit(db, { actor, action: "item.override", entity: "plan_item", entityId: itemId, before: { amount: item.override_cents ?? item.amount_cents }, after: { amount: cents, reason } });
    return refreshPlanHash(planId, db);
  });
}

/** Decide an exception: refund it (with the policy amount) or skip it. Always with a note. */
export async function resolveException(planId: string, itemId: string, decision: "refund" | "skip", note: string, actor: string) {
  if (note.trim().length < 3) throw new Error("Add a short note explaining the decision.");
  return tx(async (db) => {
    await assertEditable(db, planId);
    const { rows } = await db.query(`select * from plan_items where id=$1 and plan_id=$2 and route='exception'`, [itemId, planId]);
    if (!rows[0]) throw new Error("That row is not an open exception.");
    if (decision === "refund" && rows[0].exception_type !== "possible_duplicate") throw new Error("Only possible duplicates can be refunded from here.");
    await db.query(`update plan_items set route=$2, resolution=$3, updated_at=now() where id=$1`, [itemId, decision, note.trim()]);
    await db.query(`update refund_plans set status='draft' where id=$1`, [planId]);
    await audit(db, { actor, action: "item.resolve", entity: "plan_item", entityId: itemId, after: { decision, note } });
    return refreshPlanHash(planId, db);
  });
}

export async function resolveQuarantined(rowId: number, resolution: "excluded", note: string, actor: string) {
  await pool.query(`update quarantined_rows set resolution=$2, resolution_note=$3, resolved_at=now() where id=$1`, [rowId, resolution, note]);
  await audit(pool, { actor, action: "row.exclude", entity: "quarantined_row", entityId: String(rowId), after: { note } });
}

/** Sign off on the CURRENT plan hash. Two different people are needed above the threshold. */
export async function approvePlan(planId: string, role: "operator" | "approver", userName: string) {
  return tx(async (db) => {
    await assertEditable(db, planId);
    const { rows } = await db.query(`select plan_hash from refund_plans where id=$1`, [planId]);
    const hash = rows[0].plan_hash;
    if (role === "approver") {
      const { rows: op } = await db.query(`select user_name from approvals where plan_id=$1 and plan_hash=$2 and role='operator'`, [planId, hash]);
      if (op[0]?.user_name === userName) throw new Error("The second approval must come from a different person.");
    }
    await db.query(`insert into approvals (plan_id, plan_hash, user_name, role) values ($1,$2,$3,$4) on conflict do nothing`, [planId, hash, userName, role]);
    await audit(db, { actor: userName, action: `plan.approve.${role}`, entity: "plan", entityId: planId, after: { hash } });
  });
}
