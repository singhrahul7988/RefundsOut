import { pool } from "@/db/client";
import { latestPlanId, computeGates } from "@/plan/review";

export type StepStatus = { key: string; label: string; href: string; state: "done" | "active" | "locked" | "open"; badge?: string; badgeTone?: "amber" | "green" };

/** Where the event is in the flow, for the sidebar. */
export async function eventSteps(eventId: string): Promise<StepStatus[]> {
  const base = `/events/${eventId}`;
  const { rows: t } = await pool.query(
    `select (select count(*) from tickets where event_id=$1)::int as tickets,
            (select count(*) from quarantined_rows q join uploads u on u.id=q.upload_id where u.event_id=$1 and q.resolution is null)::int as set_aside,
            (select count(*) from uploads where event_id=$1 and kind in ('terms','notice'))::int as docs`,
    [eventId],
  );
  const { rows: pol } = await pool.query(
    `select p.status, (select count(*) from policy_questions q where q.policy_id=p.id and q.answer is null)::int as open_q
       from policies p where p.event_id=$1 order by version desc limit 1`,
    [eventId],
  );
  const planId = await latestPlanId(eventId);
  const plan = planId ? (await pool.query(`select status from refund_plans where id=$1`, [planId])).rows[0] : null;
  const gates = planId ? await computeGates(planId) : [];
  const failing = gates.filter((g) => !g.passed).length;

  const imported = t[0].tickets > 0 && t[0].docs >= 2;
  const policyApproved = pol[0]?.status === "approved";
  const running = plan && ["running", "paused"].includes(plan.status);
  const finished = plan && ["done", "stopped"].includes(plan.status);

  return [
    { key: "import", label: "Import", href: `${base}/import`, state: imported ? "done" : "open", ...(t[0].set_aside ? { badge: `${t[0].set_aside} to check`, badgeTone: "amber" as const } : {}) },
    {
      key: "policy", label: "Policy", href: `${base}/policy`, state: policyApproved ? "done" : imported ? "open" : "locked",
      ...(pol[0] && !policyApproved ? { badge: pol[0].open_q ? `${pol[0].open_q} question${pol[0].open_q > 1 ? "s" : ""}` : "To approve", badgeTone: "amber" as const } : {}),
    },
    {
      key: "review", label: "Review", href: `${base}/review`, state: running || finished ? "done" : policyApproved ? "open" : "locked",
      ...(planId && !running && !finished && failing ? { badge: `${failing} check${failing > 1 ? "s" : ""}`, badgeTone: "amber" as const } : {}),
    },
    { key: "run", label: "Run", href: `${base}/run`, state: finished ? "done" : running ? "open" : "locked", ...(running ? { badge: plan.status === "paused" ? "Paused" : "Live", badgeTone: "green" as const } : {}) },
    { key: "reconcile", label: "Reconcile", href: `${base}/reconcile`, state: finished ? "open" : "locked", ...(finished ? { badge: "Ready", badgeTone: "green" as const } : {}) },
  ];
}
