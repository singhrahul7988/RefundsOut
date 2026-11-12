import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { getEvent } from "@/server/events";
import { eventSteps } from "@/server/steps";
import { currentUser } from "@/server/user";
import { Sidebar } from "@/ui/Sidebar";

export const dynamic = "force-dynamic";

export default async function EventLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const event = await getEvent(id);
  if (!event) notFound();
  const [steps, user, h] = await Promise.all([eventSteps(id), currentUser(), headers()]);
  const path = h.get("x-pathname") ?? "";
  const current = ["import", "policy", "review", "run", "reconcile", "audit"].find((s) => path.endsWith(`/${s}`)) ?? "";
  const dayName: Record<string, string> = { Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };

  return (
    <div className="flex min-h-screen flex-wrap bg-canvas">
      <Sidebar eventId={id} eventName={event.name} eventSub={`${dayName[event.cancelled_day] ?? event.cancelled_day} cancelled`} steps={steps} current={current} user={user} />
      <main className="m-3 flex min-w-0 flex-[999_1_560px] flex-col gap-6 rounded-[16px] border border-line bg-panel px-5 pb-12 pt-6 shadow-[0_1px_3px_rgba(16,24,40,0.05)] sm:my-4 sm:ml-1 sm:mr-4 sm:px-10 sm:pt-8 xl:my-7 xl:ml-4 xl:mr-7 xl:px-12 xl:pb-14 xl:pt-10">
        {children}
      </main>
    </div>
  );
}
