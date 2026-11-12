import { getEvent } from "@/server/events";
import { latestPlanId } from "@/plan/review";
import { getRunSnapshot } from "@/run/status";
import { TopBar, PageHeader, EmptyState, StepLink } from "@/ui/kit";
import { RunClient } from "./RunClient";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const event = await getEvent(id);
  const planId = await latestPlanId(id);
  const snap = planId ? await getRunSnapshot(planId) : null;
  if (!planId || !snap?.plan || ["draft", "approved"].includes(snap.plan.status)) {
    return (
      <>
        <TopBar eventName={event.name} page="Run" />
        <PageHeader title="Run refunds" />
        <EmptyState title="The run hasn't started" body="Runs start from the Review screen once all five checks pass." action={<StepLink href={`/events/${id}/review`}>Go to Review</StepLink>} />
      </>
    );
  }
  return <RunClient eventId={id} eventName={event.name} planId={planId} initial={snap} licenseKey={process.env.AG_GRID_LICENSE_KEY} />;
}
