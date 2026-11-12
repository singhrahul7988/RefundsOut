"use client";

import { useEffect, useState, useTransition } from "react";
import { writeLetterAction } from "../../../actions";
import { Card, btn } from "@/ui/kit";
import { formatMoney } from "@/lib/money";

type Candidate = { id: string; buyer: string; amount: number; offer: boolean };

export function LetterPanel({ eventId, candidates, total }: { eventId: string; candidates: Candidate[]; total: number }) {
  const [selected, setSelected] = useState<Candidate | null>(candidates[0] ?? null);
  const [letter, setLetter] = useState<{ to: string; subject: string; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!selected) return;
    start(async () => {
      setError(null);
      const r = await writeLetterAction(eventId, selected.id);
      if (r.ok && r.data) setLetter(r.data); else if (!r.ok) setError(r.error);
    });
  }, [eventId, selected]);

  if (!candidates.length) return null;
  return (
    <Card className="flex flex-wrap overflow-hidden">
      <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-3 border-r border-[#E6E9EE] px-5 py-[18px]">
        <b className="text-[15px]">Letters to buyers</b>
        <span className="text-muted">One letter per payment. RefundsOut fills in every amount, date and ID. Gemini only writes the wording around them.</span>
        <div className="-mx-1 flex max-h-[296px] flex-col gap-1 overflow-y-auto px-1" role="list" aria-label={`${candidates.length} letters`}>
          {candidates.map((c) => (
            <button key={c.id} onClick={() => setSelected(c)} className={`rounded-lg px-3 py-2.5 text-left ${selected?.id === c.id ? "bg-[#EAF5F0]" : "hover:bg-[#F5F6F8]"}`}>
              <b>{c.buyer}</b> · {formatMoney(c.amount)} {c.offer ? "offered" : "refunded"}
            </button>
          ))}
        </div>
        <button className={btn.secondary} disabled title="Sandbox mode: letters are shown here, not emailed">Send {total} letters</button>
        <span className="text-[13px] text-muted">Sandbox mode: letters are shown here, not emailed.</span>
      </div>
      <article className="flex min-w-0 flex-[2_1_420px] flex-col gap-3.5 bg-[#FBFBFA] px-7 py-6">
        {letter ? (
          <>
            <div className="flex flex-col gap-0.5 text-[13px] text-muted"><span>To: {letter.to}</span><span>Subject: <b className="text-ink">{letter.subject}</b></span></div>
            <div className={`flex flex-col gap-3 text-[16px] leading-[26px] text-[#22252B] ${pending ? "opacity-50" : ""}`} style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>
              {letter.body.split(/\n{2,}/).map((p, i) => (
                <p key={i} className="whitespace-pre-line">
                  {p.split(/⟦|⟧/).map((part, j) => (j % 2 === 1 ? <mark key={j} className="rounded-[3px] bg-accent-soft px-0.5 font-semibold text-inherit">{part}</mark> : part))}
                </p>
              ))}
            </div>
            <span className="text-xs text-muted">Highlighted values are filled in by RefundsOut from the plan and PayPal, never written by AI.</span>
          </>
        ) : (
          <span className="ro-pulse text-muted">{error ?? "Gemini is writing the letter…"}</span>
        )}
      </article>
    </Card>
  );
}
