import Link from "next/link";
import type { StepStatus } from "@/server/steps";
import type { DemoUser } from "@/server/user";
import { IconImport, IconPolicy, IconReview, IconRun, IconReconcile, IconMail, IconClock, IconLink, IconLock, IconCheckCircle, IconChevronLeft, Logo } from "./icons";
import { UserSwitcher } from "./UserSwitcher";

const STEP_ICONS: Record<string, (p: { className?: string }) => React.ReactElement> = {
  import: IconImport, policy: IconPolicy, review: IconReview, run: IconRun, reconcile: IconReconcile,
};

export function Sidebar({ eventName, eventSub, steps, current, user, eventId }: {
  eventName: string; eventSub: string; steps: StepStatus[]; current: string; user: DemoUser; eventId: string;
}) {
  return (
    <aside aria-label="Main navigation" className="flex flex-[1_1_240px] flex-col gap-5 px-3 pb-3.5 pt-[18px] sm:py-4 xl:py-7 lg:sticky lg:top-0 lg:h-dvh lg:flex-[0_0_308px] lg:self-start lg:overflow-y-auto">
      <Link href="/" className="flex items-center gap-2.5 px-2.5 py-0.5 text-[17px] font-bold tracking-[-0.2px]"><Logo />RefundsOut</Link>

      <div className="flex w-full items-center gap-2.5 rounded-[10px] border border-[#E1E4E8] bg-white px-2.5 py-2">
        <Link href="/" aria-label="Back to all refund runs" title="Back to all refund runs"
          className="flex size-8 flex-none items-center justify-center rounded-lg border border-line bg-white text-muted transition-colors hover:border-accent hover:bg-accent-soft hover:text-accent">
          <IconChevronLeft size={16} />
        </Link>
        <span className="flex min-w-0 flex-1 flex-col" title={eventName}>
          <b className="truncate text-[13px] leading-[18px]">{eventName}</b>
          <span className="text-xs leading-4 text-muted">{eventSub}</span>
        </span>
      </div>

      <nav aria-label="Refund run" className="flex flex-col gap-0.5">
        <span className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.6px] text-faint">Refund run</span>
        {steps.map((s) => {
          const Icon = STEP_ICONS[s.key];
          const active = s.key === current;
          const content = (
            <>
              <Icon className={active ? "text-accent" : "text-faint"} />
              <span className="flex-1">{s.label}</span>
              {s.badge ? (
                <span className={`rounded-[10px] px-2 py-px text-xs font-semibold ${s.badgeTone === "green" ? "bg-[#D5EEE2] text-[#145C3D]" : "bg-warn-soft text-warn-ink"}`}>{s.badge}</span>
              ) : s.state === "done" ? (
                <IconCheckCircle className="text-ok" />
              ) : s.state === "locked" ? (
                <IconLock className="text-[#9AA1AC]" />
              ) : null}
            </>
          );
          const cls = `flex h-[38px] items-center gap-2.5 rounded-lg border px-2.5 ${active ? "border-[#E1E4E8] bg-white font-semibold text-accent-ink shadow-[0_1px_2px_rgba(16,24,40,0.06)]" : "border-transparent font-medium text-[#3A4150] hover:bg-white/60"}`;
          return s.state === "locked" && !active ? (
            <span key={s.key} className={`${cls} cursor-not-allowed opacity-80`} aria-disabled="true" title="Finish the earlier steps first">{content}</span>
          ) : (
            <Link key={s.key} href={s.href} aria-current={active ? "page" : undefined} className={cls}>{content}</Link>
          );
        })}
      </nav>

      <nav aria-label="Workspace" className="flex flex-col gap-0.5">
        <span className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.6px] text-faint">Workspace</span>
        <Link href={`/events/${eventId}/reconcile#letters`} className="flex h-[38px] items-center gap-2.5 rounded-lg px-2.5 font-medium text-[#3A4150] hover:bg-white/60"><IconMail className="text-faint" />Buyer letters</Link>
        <Link href={`/events/${eventId}/audit`} className="flex h-[38px] items-center gap-2.5 rounded-lg px-2.5 font-medium text-[#3A4150] hover:bg-white/60"><IconClock className="text-faint" />Audit log</Link>
        <span className="flex h-[38px] items-center gap-2.5 rounded-lg px-2.5 font-medium text-[#3A4150]"><IconLink className="text-faint" /><span className="flex-1">PayPal connection</span><span className="size-2 rounded-full bg-ok" role="img" aria-label="Connected" /></span>
      </nav>

      <div className="mt-auto flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-2 px-2.5">
          <span className="text-xs text-muted">Environment</span>
          <span className="rounded-[10px] bg-warn-soft px-2 py-px text-xs font-semibold text-warn-ink">Sandbox</span>
        </div>
        <UserSwitcher user={user} />
      </div>
    </aside>
  );
}
