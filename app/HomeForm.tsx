"use client";

import { useFormStatus } from "react-dom";
import { useState } from "react";
import { createEventAction } from "./actions";
import { btn } from "@/ui/kit";
import { IconSparkle } from "@/ui/icons";
import { AffixInput, Select, field } from "@/ui/form";

function Buttons() {
  const { pending, data } = useFormStatus();
  const intent = data?.get("intent");
  return (
    <div className="flex flex-wrap gap-2.5">
      <button name="intent" value="create" className={btn.primary} disabled={pending}>
        {pending && intent === "create" ? <span className="ro-pulse">Creating…</span> : "Create run"}
      </button>
      <button name="intent" value="sample" className={btn.secondary} disabled={pending}>
        <IconSparkle className="text-ai" />
        {pending && intent === "sample" ? <span className="ro-pulse">Making fresh sandbox payments for your demo (about 15s)…</span> : "Try with sample festival data"}
      </button>
    </div>
  );
}

export function HomeForm() {
  const [budget, setBudget] = useState("6,000.00");
  const tidy = () => {
    const n = Number(budget.replace(/[$,\s]/g, ""));
    if (Number.isFinite(n) && n > 0) setBudget(n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  };
  return (
    <form action={createEventAction} className="flex h-full flex-col gap-4 rounded-[14px] border border-line bg-white p-6 shadow-[0_1px_3px_rgba(16,24,40,0.05)]">
      <div className="flex flex-col gap-1">
        <b className="text-[18px]">Start a refund run</b>
        <span className="text-muted">Takes about a minute with your files, or one click with ours.</span>
      </div>
      <label className="flex flex-col gap-1.5" htmlFor="ev-name">
        <span className="text-xs font-semibold text-muted">Event name</span>
        <input id="ev-name" name="name" defaultValue="Riverside Sound Festival 2026" className={field()} />
      </label>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(170px,100%),1fr))] gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-semibold text-muted" htmlFor="ev-day">Cancelled day</label>
          <Select id="ev-day" name="cancelledDay" defaultValue="Sat" aria-label="Cancelled day"
            options={[{ value: "Fri", label: "Friday" }, { value: "Sat", label: "Saturday" }, { value: "Sun", label: "Sunday" }]} />
        </div>
        <label className="flex flex-col gap-1.5" htmlFor="ev-budget">
          <span className="text-xs font-semibold text-muted">Refund budget</span>
          <AffixInput prefix="$" id="ev-budget" name="budget" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} onBlur={tidy} />
        </label>
      </div>
      <span className="-mt-1 text-xs text-muted">Runs over $2,500 need a second person to approve.</span>
      <Buttons />
    </form>
  );
}
