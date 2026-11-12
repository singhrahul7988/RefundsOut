"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { approvePolicyAction, answerQuestionsAction, compilePolicyAction } from "../../../actions";
import { btn, Card } from "@/ui/kit";
import { IconSparkle } from "@/ui/icons";

function useAction() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.error ?? "Something went wrong");
      else { after?.(); router.refresh(); }
    });
  return { pending, error, run };
}

// What the compile does, in order. Shown one after another while Gemini works (the call itself is a single request).
const COMPILE_STAGES = [
  "Reading the ticket terms…",
  "Reading the cancellation notice…",
  "Finding the refund clauses…",
  "Writing the rules…",
  "Writing test cases…",
  "Checking quotes word for word…",
];

/** Seconds since `active` turned on, and which stage to show (advances every 4s, then holds on the last). */
function useWorking(active: boolean, stages: string[], stepMs = 4000) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active) return;
    setElapsed(0);
    const started = Date.now();
    const t = setInterval(() => setElapsed(Date.now() - started), 500);
    return () => clearInterval(t);
  }, [active]);
  return { seconds: Math.floor(elapsed / 1000), stage: stages[Math.min(stages.length - 1, Math.floor(elapsed / stepMs))] };
}

export function CompileButton({ eventId, label = "Compile with Gemini", variant = "primary" }: { eventId: string; label?: string; variant?: "primary" | "secondary" }) {
  const { pending, error, run } = useAction();
  const { seconds, stage } = useWorking(pending, COMPILE_STAGES);
  const base = variant === "primary" ? btn.ai + " h-11" : btn.secondary;
  return (
    <div className="flex flex-col items-start gap-2">
      <button
        className={`${base} ${pending ? `ro-shimmer cursor-progress disabled:opacity-100 ${variant === "primary" ? "bg-ai-ink" : "ro-shimmer-ink border-ai! bg-ai-soft! text-ai-ink!"}` : ""}`}
        disabled={pending}
        aria-busy={pending}
        onClick={() => run(() => compilePolicyAction(eventId))}
      >
        <IconSparkle className={pending ? "ro-twinkle" : ""} />
        {pending ? (
          <span className="flex items-center gap-2">
            <span key={stage} className="ro-fade-in">{stage}</span>
            <span className="tabular-nums opacity-75">{seconds}s</span>
          </span>
        ) : label}
      </button>
      {pending && (
        <span className="text-xs text-muted" role="status">
          {seconds < 50
            ? "Usually under a minute. Stay on this page."
            : "Still working. When Gemini is busy, the app tries another model, which can take a few minutes."}
        </span>
      )}
      {error && <span className="text-bad">{error}</span>}
    </div>
  );
}

export function ApproveButton({ eventId, policyId, disabled, approved, reason }: { eventId: string; policyId: string; disabled: boolean; approved: boolean; reason?: string }) {
  const { pending, error, run } = useAction();
  return (
    <div className="flex flex-col items-end gap-1">
      <button className={btn.primary} disabled={disabled || pending} title={reason} onClick={() => run(() => approvePolicyAction(eventId, policyId))}>
        {approved ? "Approved ✓" : pending ? "Approving…" : "Approve policy"}
      </button>
      {reason && !approved && <span className="text-xs text-muted">{reason}</span>}
      {error && <span className="text-bad">{error}</span>}
    </div>
  );
}

export function QuestionsForm({ eventId, questions }: { eventId: string; questions: { id: string; question: string; clauseQuote: string; options: { label: string; detail: string }[] }[] }) {
  const [answers, setAnswers] = useState<Record<string, string>>(() => Object.fromEntries(questions.map((q) => [q.id, `${q.options[0].label}: ${q.options[0].detail}`])));
  const { pending, error, run } = useAction();
  return (
    <Card className="flex flex-col gap-4 border-[#A99BE0] bg-[#F7F5FD] px-5 py-[18px]">
      <span className="text-xs font-semibold uppercase tracking-[0.4px] text-ai">{questions.length > 1 ? `${questions.length} questions` : "A question"} from the compiler</span>
      {questions.map((q) => (
        <fieldset key={q.id} className="flex flex-col gap-2.5">
          <legend className="mb-1 text-[16px] font-bold leading-6">{q.question}</legend>
          <span className="w-fit rounded-md border border-[#CFC6F0] bg-white px-2.5 py-1 text-[13px] text-[#3F3A55]">“{q.clauseQuote}”</span>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] gap-2.5">
            {q.options.map((o) => {
              const value = `${o.label}: ${o.detail}`;
              const checked = answers[q.id] === value;
              return (
                <label key={o.label} className={`flex cursor-pointer flex-col gap-1.5 rounded-[10px] bg-white px-4 py-3.5 ${checked ? "border-2 border-ai" : "border border-[#CFC6F0]"}`}>
                  <span className="flex items-center gap-2.5">
                    <input type="radio" name={q.id} className="accent-ai" checked={checked} onChange={() => setAnswers((a) => ({ ...a, [q.id]: value }))} />
                    <b className="text-[18px] leading-6">{o.label}</b>
                  </span>
                  <span className="text-[#4A4370]">{o.detail}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        <button className={btn.ai} disabled={pending} onClick={() => run(() => answerQuestionsAction(eventId, Object.entries(answers).map(([questionId, answer]) => ({ questionId, answer }))))}>
          <IconSparkle />{pending ? <span className="ro-pulse">Recompiling with your answers…</span> : "Save answers and recompile"}
        </button>
        <span className="text-[#4A4370]">Your answers are saved with the policy and the rules are rewritten to follow them.</span>
      </div>
      {error && <span className="text-bad">{error}</span>}
    </Card>
  );
}
