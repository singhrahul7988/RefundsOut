import { getEvent } from "@/server/events";
import { latestPlanId, getPlanView } from "@/plan/review";
import { currentUser } from "@/server/user";
import { pool } from "@/db/client";
import { Policy } from "@/policy/schema";
import { TopBar, PageHeader, EmptyState } from "@/ui/kit";
import { ReviewClient, type ReviewRow } from "./ReviewClient";
import { BuildPlanButton } from "./BuildPlanButton";
import type { PlanLine } from "@/plan/build";

export const dynamic = "force-dynamic";

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const event = await getEvent(id);
  const planId = await latestPlanId(id);
  const { rows: pol } = await pool.query(`select id, status, rules_json from policies where event_id=$1 order by version desc limit 1`, [id]);
  const policyApproved = pol[0]?.status === "approved";

  if (!planId) {
    return (
      <>
        <TopBar eventName={event.name} page="Review" />
        <PageHeader title="Review refunds" subtitle="Build a practice run of every refund. Nothing moves until every check passes and you press Run refunds." />
        <EmptyState
          title={policyApproved ? "Ready to build the refund plan" : "Approve the refund policy first"}
          body={policyApproved
            ? "RefundsOut will read every payment's live state from PayPal, apply the approved rules to each ticket, and route anything unusual to a decision list."
            : "The plan is built from the approved policy. Finish the Policy step, then come back."}
          action={policyApproved ? <BuildPlanButton eventId={id} /> : undefined}
        />
      </>
    );
  }

  const view = await getPlanView(planId);
  const user = await currentUser();
  const { rows: planPolicy } = await pool.query(`select rules_json from policies where id=$1`, [view.plan.policy_id]);
  const policy = Policy.parse(planPolicy[0].rules_json);
  const ruleInfo = Object.fromEntries([...policy.rules, ...policy.deductions].map((r) => [r.id, { title: r.title, clause: r.clause, quote: r.quote }]));

  const rows: ReviewRow[] = view.items.map((i) => {
    const lines = i.lines as PlanLine[];
    const firstRule = lines.map((l) => (l.result.kind === "refund" ? l.result.ruleId : null)).find(Boolean) ?? null;
    const group =
      i.route === "dispute_offer" ? "Dispute offers · sent through the open dispute"
      : i.route === "skip" ? "Skipped · reason on each row"
      : i.route === "exception" ? "Needs a decision"
      : firstRule ? `${firstRule} · ${ruleInfo[firstRule]?.title ?? ""}` : "Other";
    const tierCounts = new Map<string, number>();
    for (const l of lines) tierCounts.set(l.tier, (tierCounts.get(l.tier) ?? 0) + 1);
    return {
      id: i.id,
      group,
      buyer: i.buyer_name ?? i.buyer_email,
      email: i.buyer_email,
      tickets: [...tierCounts].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(" + "),
      captureId: i.capture_id,
      paid: Number(i.paid_cents) / 100,
      refunded: Number(i.already_refunded_cents) / 100,
      refund: Number(i.override_cents ?? i.amount_cents) / 100,
      policyAmount: Number(i.amount_cents) / 100,
      overridden: i.override_cents !== null,
      overrideReason: i.override_reason,
      route: i.route,
      exceptionType: i.exception_type,
      flags: i.flags,
      reason: i.reason,
      resolution: i.resolution,
      disputeId: i.dispute_id,
      lines,
    };
  });

  const { rows: setAside } = await pool.query(
    `select count(*)::int as n from quarantined_rows q join uploads u on u.id=q.upload_id where u.event_id=$1 and q.resolution is null`,
    [id],
  );

  return (
    <ReviewClient
      eventId={id}
      eventName={event.name}
      planId={planId}
      planStatus={view.plan.status}
      totalCents={Number(view.plan.total_cents)}
      budgetCents={Number(view.plan.refund_budget_cents)}
      thresholdCents={Number(view.plan.approval_threshold_cents)}
      gates={view.gates}
      approvals={view.approvals.map((a) => ({ role: a.role, userName: a.user_name }))}
      rows={rows}
      ruleInfo={ruleInfo}
      setAsideCount={setAside[0].n}
      user={user}
      licenseKey={process.env.AG_GRID_LICENSE_KEY}
      cancelledDay={event.cancelled_day}
    />
  );
}
