"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { buildPlanAction } from "../../../actions";
import { btn } from "@/ui/kit";

export function BuildPlanButton({ eventId, label = "Build the refund plan", variant = "primary" }: { eventId: string; label?: string; variant?: "primary" | "secondary" }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        className={btn[variant]}
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const res = await buildPlanAction(eventId);
            if (!res.ok) setError(res.error);
            else router.refresh();
          })
        }
      >
        {pending ? <span className="ro-pulse">Checking every payment with PayPal…</span> : label}
      </button>
      {error && <span className="text-bad">{error}</span>}
    </div>
  );
}
