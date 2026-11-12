import { pool } from "@/db/client";
import { getEvent, getCurrentPolicy } from "@/server/events";
import { normaliseText } from "@/policy/verify";
import type { Policy, Rule } from "@/policy/schema";
import { TopBar, PageHeader, Card, EmptyState, SegmentMeter } from "@/ui/kit";
import { IconCheckCircle } from "@/ui/icons";
import { formatMoney } from "@/lib/money";
import { CompileButton, ApproveButton, QuestionsForm } from "./PolicyControls";

export const dynamic = "force-dynamic";

function formula(r: Rule) {
  const f = r.refund;
  if (f.kind === "percent") return f.percent === 100 ? "100% of price" : `${f.percent}% of price`;
  if (f.kind === "fraction") return `price × ${f.numerator}/${f.denominator}`;
  if (f.kind === "fixed") return formatMoney(f.cents);
  return "No refund";
}

const Arrow = () => (
  <svg width="18" height="12" viewBox="0 0 18 12" aria-hidden><path d="M1 6 H15 M11 2 L15 6 L11 10" stroke="#8A919C" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const CondChip = ({ children }: { children: React.ReactNode }) => <span className="rounded-md border border-[#E1E4E8] bg-[#F3F5F8] px-2 py-[3px] text-[13px]">{children}</span>;

export default async function PolicyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const event = await getEvent(id);
  const current = await getCurrentPolicy(id);
  const { rows: docs } = await pool.query(
    `select distinct on (kind) kind, file_name, content from uploads where event_id=$1 and kind in ('terms','notice') order by kind, confirmed_at desc nulls last`,
    [id],
  );
  const terms = docs.find((d) => d.kind === "terms");
  const notice = docs.find((d) => d.kind === "notice");
  const { rows: t } = await pool.query(`select count(*)::int as n from tickets where event_id=$1`, [id]);

  if (!current) {
    const ready = !!terms && !!notice && t[0].n > 0;
    return (
      <>
        <TopBar eventName={event.name} page="Policy" />
        <PageHeader title="Refund policy" subtitle="Gemini turns your ticket terms into rules. Every rule quotes its clause, and code, not AI, calculates each amount." />
        <EmptyState
          title={ready ? "Compile the refund policy" : "Import your files first"}
          body={ready ? `Gemini will read ${terms.file_name} and the cancellation notice, then write rules and test cases for your ${t[0].n} tickets. Code checks every quote word for word.` : "The compiler needs the sales file, the ticket terms and the cancellation notice."}
          action={ready ? <CompileButton eventId={id} /> : undefined}
        />
      </>
    );
  }

  const policy: Policy = current.policy;
  const openQuestions = current.questions.filter((q: { answer: string | null }) => !q.answer);
  const allChecks = current.checks.every((c: { passed: boolean }) => c.passed);
  const approved = current.status === "approved";
  const ordered = [...policy.rules].sort((a, b) => a.priority - b.priority);
  const quotes = [...policy.rules, ...policy.deductions].map((r) => ({ id: r.id, quote: r.quote, isDeduction: !("refund" in r) }));

  // Highlight each quoted clause in the source text.
  const termLines: string[] = (terms?.content ?? "").split(/\r?\n/).filter((l: string) => l.trim());
  const testsPassed = current.tests.filter((x: { passed: boolean }) => x.passed).length;

  return (
    <>
      <TopBar eventName={event.name} page="Policy" right={<><span className="size-2 rounded-full bg-ai" />Compiled by {current.model ?? "Gemini"} · version {current.version}</>} />
      <PageHeader
        title={`Refund policy · version ${current.version}`}
        subtitle="Gemini turned your ticket terms into the rules below. Every rule quotes the clause it came from. Code, not AI, will calculate each amount."
        actions={
          // Top-aligned: either button may show a line of text underneath, which must not shift the other one.
          <div className="flex flex-wrap items-start gap-2.5">
            {!approved && <CompileButton eventId={id} variant="secondary" label="Compile again" />}
            <ApproveButton eventId={id} policyId={current.id} disabled={approved || !allChecks || openQuestions.length > 0} approved={approved}
              reason={openQuestions.length ? `Answer ${openQuestions.length} question${openQuestions.length > 1 ? "s" : ""} first` : !allChecks ? "Every check must pass" : undefined} />
          </div>
        }
      />

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))] gap-2.5">
        {current.checks.map((c: { id: string; label: string; passed: boolean; details: string[] }) => (
          <div key={c.id} className={`flex items-center gap-2.5 rounded-lg px-3 py-2.5 ${c.passed ? "bg-ok-soft" : "bg-bad-soft"}`} title={c.details.join("\n")}>
            {c.passed ? <IconCheckCircle size={20} className="flex-none text-ok" /> : <span className="flex size-5 flex-none items-center justify-center rounded-full bg-bad text-xs font-bold text-white">!</span>}
            <span>{c.label}</span>
          </div>
        ))}
        {openQuestions.length > 0 && (
          <div className="flex items-center gap-2.5 rounded-lg bg-warn-soft px-3 py-2.5"><span className="flex size-5 flex-none items-center justify-center rounded-full bg-warn text-xs font-bold text-white">?</span><span>{openQuestions.length} question{openQuestions.length > 1 ? "s" : ""} for you</span></div>
        )}
      </div>

      <div className="flex flex-wrap items-start gap-4">
        <Card className="flex min-w-0 flex-[1_1_420px] flex-col overflow-hidden">
          <div className="flex border-b border-[#E6E9EE] px-4"><span className="border-b-2 border-ink py-3 font-semibold">Ticket terms</span></div>
          <div className="flex flex-col gap-3.5 px-7 py-6 font-serif text-[16px] leading-[26px] text-[#22252B]" style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}>
            <span className="font-sans text-xs text-muted">{terms?.file_name}</span>
            {termLines.map((line, i) => {
              const hit = quotes.find((q) => normaliseText(line).includes(normaliseText(q.quote)));
              if (!hit) return <p key={i} className={/^\d+\.\s/.test(line.trim()) || /^[A-Z0-9 \-—]+$/.test(line.trim()) ? "font-sans text-[15px] font-semibold" : "text-[#4A4F58]"}>{line}</p>;
              const at = line.indexOf(hit.quote);
              const pre = at >= 0 ? line.slice(0, at) : "";
              const body = at >= 0 ? hit.quote : line;
              const post = at >= 0 ? line.slice(at + hit.quote.length) : "";
              const isQuestion = openQuestions.some((q: { clause_quote: string }) => normaliseText(q.clause_quote) === normaliseText(hit.quote));
              return (
                <p key={i}>
                  {pre}<mark className={`rounded-[3px] px-0.5 text-inherit ${isQuestion ? "bg-[#FFE7B8]" : "bg-accent-soft"}`}>{body}</mark>{post}{" "}
                  <span className={`font-sans text-xs font-bold ${isQuestion ? "text-warn-ink" : "text-accent"}`}>{hit.id}{isQuestion ? " · question" : ""}</span>
                </p>
              );
            })}
            {notice && (
              <div className="mt-2 rounded-lg border-l-[3px] border-accent bg-accent-soft px-4 py-3 font-sans text-[14px] leading-5">
                <b className="text-xs uppercase tracking-[0.4px] text-accent">Cancellation notice</b>
                <p className="mt-1 whitespace-pre-line text-accent-ink">{notice.content.trim()}</p>
              </div>
            )}
          </div>
        </Card>

        <div className="flex min-w-0 flex-[1.3_1_520px] flex-col gap-4">
          {openQuestions.length > 0 && !approved && <QuestionsForm eventId={id} questions={openQuestions.map((q: { id: string; question: string; clause_quote: string; options: { label: string; detail: string }[] }) => ({ id: q.id, question: q.question, clauseQuote: q.clause_quote, options: q.options }))} />}

          <Card className="flex flex-col overflow-hidden">
            <div className="flex flex-wrap justify-between gap-2 border-b border-[#E6E9EE] px-[18px] py-3.5">
              <b className="text-[15px]">Rules</b>
              <span className="text-muted">Checked in order; the first match wins. Cancelled: {policy.cancelledDays.join(", ")}</span>
            </div>
            {ordered.map((r) => {
              const deds = policy.deductions.filter((d) => d.appliesToRules.includes(r.id));
              return (
                <div key={r.id} className="flex gap-3.5 border-b border-[#EEF0F3] px-[18px] py-3.5 last:border-0">
                  <span className="flex h-6 w-9 flex-none items-center justify-center rounded-md bg-accent-soft font-bold text-accent">{r.id}</span>
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <div className="flex flex-wrap justify-between gap-2"><b>{r.title}</b><span className="text-xs font-semibold text-[#145C3D]">✓ Clause {r.clause}</span></div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <CondChip>{r.when.tiers.join(" or ")}</CondChip>
                      {r.when.attendedOtherDay === true && <CondChip>Came on another day</CondChip>}
                      {r.when.attendedOtherDay === false && <CondChip>Never came</CondChip>}
                      <Arrow />
                      <span className="rounded-md bg-accent-soft px-2.5 py-[3px] text-[13px] font-bold text-accent-ink">{formula(r)}</span>
                      {deds.map((d) => <span key={d.id} className="rounded-md bg-warn-soft px-2 py-[3px] text-xs font-semibold text-warn-ink">{d.tiers.join("/")} −{formatMoney(d.cents)} first ({d.id})</span>)}
                    </div>
                  </div>
                </div>
              );
            })}
          </Card>

          <Card className="flex flex-col overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#E6E9EE] px-[18px] py-3.5">
              <b className="text-[15px]">Tests written by the compiler</b>
              <SegmentMeter values={current.tests.map((x: { passed: boolean }) => x.passed)} label={`${testsPassed} of ${current.tests.length} pass`} />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] border-collapse">
                <thead><tr className="bg-[#F3F5F8] text-left text-xs text-[#3E4652]"><th className="px-[18px] py-2 font-semibold">Test</th><th className="px-3 py-2 text-right font-semibold">Expected</th><th className="px-3 py-2 text-right font-semibold">Engine</th><th className="px-[18px] py-2 font-semibold">Result</th></tr></thead>
                <tbody>
                  {current.tests.map((x: { name: string; expectedCents: number | null; actualCents: number | null; passed: boolean }) => (
                    <tr key={x.name} className="border-t border-[#EEF0F3]">
                      <td className="px-[18px] py-2">{x.name}</td>
                      <td className="px-3 py-2 text-right">{x.expectedCents === null ? "Skip" : formatMoney(x.expectedCents)}</td>
                      <td className="px-3 py-2 text-right">{x.actualCents === null ? "Skip" : formatMoney(x.actualCents)}</td>
                      <td className="px-[18px] py-2">{x.passed ? <span className="inline-flex items-center gap-1.5 font-semibold text-[#145C3D]"><IconCheckCircle className="text-ok" />Pass</span> : <span className="font-semibold text-bad">Fail</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
