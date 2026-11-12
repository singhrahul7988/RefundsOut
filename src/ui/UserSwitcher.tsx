"use client";

import { usePathname } from "next/navigation";
import { useTransition } from "react";
import { switchUserAction } from "../../app/actions";
import type { DemoUser } from "@/server/user";
import { IconSwap } from "./icons";

// Who the button switches to. Kept here because @/server/user reads cookies and can't load on the client.
const OTHER = {
  maya: { id: "jordan", label: "Switch to Jordan (approver)" },
  jordan: { id: "maya", label: "Switch to Maya (operator)" },
} as const;

/** Demo-only: switch between the operator and the second approver to show the two-person rule. */
export function UserSwitcher({ user }: { user: DemoUser }) {
  const path = usePathname();
  const [pending, start] = useTransition();
  const other = OTHER[user.id as keyof typeof OTHER] ?? OTHER.maya;
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => start(() => switchUserAction(other.id, path))}
      aria-label={`Signed in as ${user.name}, ${user.role}. ${other.label}`}
      title={other.label}
      className="group flex w-full items-center gap-2.5 rounded-[10px] border border-[#E1E4E8] bg-white px-2.5 py-2 text-left transition-colors hover:border-accent disabled:opacity-60"
    >
      <span className={`flex size-8 flex-none items-center justify-center rounded-full text-xs font-semibold text-white ${user.id === "maya" ? "bg-[#10221C]" : "bg-info"}`}>{user.initials}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <b className="truncate text-[13px] leading-[18px]">{user.name}</b>
        <span className="truncate text-xs leading-4 text-muted">{pending ? "Switching…" : user.role === "operator" ? "Operator" : "Approver"}</span>
      </span>
      <span className="flex size-7 flex-none items-center justify-center rounded-md text-faint transition-colors group-hover:bg-accent-soft group-hover:text-accent">
        <IconSwap size={16} />
      </span>
    </button>
  );
}
