import { NextResponse } from "next/server";
import { getRunSnapshot } from "@/run/status";
import { ensureLoop } from "@/run/runner";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ planId: string }> }) {
  const { planId } = await params;
  const snap = await getRunSnapshot(planId);
  if (!snap.plan) return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  // If the server restarted mid-run, polling the page is enough to pick the run back up.
  if (snap.plan.status === "running") ensureLoop(planId);
  return NextResponse.json(snap, { headers: { "Cache-Control": "no-store" } });
}
