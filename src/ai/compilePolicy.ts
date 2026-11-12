import { generateJson, ACCURATE_MODELS } from "./gemini";
import { Policy } from "@/policy/schema";
import { verifyPolicy, type PolicyCheck } from "@/policy/verify";

const SYSTEM = `You compile a festival's ticket terms into refund rules for a refund engine. You do NOT calculate refunds; code does.

Output a Policy:
- days: festival days as short weekday names in order, e.g. ["Fri","Sat","Sun"].
- cancelledDays: the days the cancellation notice cancels.
- rules: each rule covers some ticket types ("when.tiers", using EXACTLY the ticket type names given) and gives a refund formula.
  * refund.kind "percent" (0-100), "fraction" (numerator/denominator, e.g. 1/3 for one day of a 3-day pass), "fixed" (cents) or "none".
  * when.attendedOtherDay: true = the holder scanned in on a day that was NOT cancelled; false = they never did; omit when it doesn't matter.
  * priority: lower number is checked first; the first matching rule wins. Give a more specific rule a lower number than a general one.
  * Never give two rules the same priority if they could match the same ticket.
  * quote: copy the clause sentence WORD FOR WORD from the terms. Never paraphrase. clause: its number, e.g. "7.2".
- deductions: amounts excluded before a rule's formula runs (e.g. a non-refundable component), in cents, with the rule ids they apply to.
- tests: 6-10 test cases covering every rule and edge (free ticket with priceCents 0 => expectedCents null). expectedCents must follow your rules exactly.
- questions: ONLY when two clauses genuinely conflict or a clause is ambiguous for some ticket type. Each has 2-4 options with a short label (the resulting amount or choice) and detail. Make your best default choice in the rules and ask about it.
Every ticket type given must be covered by at least one rule. Use ids R1, R2, ... in clause order (deductions use the same id series).`;

export type CompileResult = { policy: Policy; checks: PolicyCheck[]; model: string; attempts: number };

export async function compilePolicy(args: {
  terms: string;
  notice: string;
  tiers: { tier: string; isAddOn: boolean; examplePriceCents: number }[];
  organizerAnswers?: { question: string; answer: string }[];
}): Promise<CompileResult> {
  const parts = [
    `TICKET TERMS:\n${args.terms}`,
    `CANCELLATION NOTICE:\n${args.notice}`,
    `TICKET TYPES IN THE SALES DATA (use these exact names): ${JSON.stringify(args.tiers)}`,
  ];
  if (args.organizerAnswers?.length) {
    parts.push(
      `The organizer has answered these questions. Follow the answers in the rules and do not ask them again:\n` +
        args.organizerAnswers.map((a) => `- ${a.question} => ${a.answer}`).join("\n"),
    );
  }

  let lastChecks: PolicyCheck[] = [];
  let feedback = "";
  for (let round = 1; round <= 3; round++) {
    const { data, model, attempts } = await generateJson({
      system: SYSTEM,
      schema: Policy,
      models: ACCURATE_MODELS, // the one AI step that must be right
      parts: feedback ? [...parts, feedback] : parts,
    });
    const checks = verifyPolicy(data, args.terms, args.tiers.map((t) => t.tier));
    const hardFailures = checks.filter((c) => !c.passed); // a wrong self-written test case is fed back too, so the model fixes it
    if (hardFailures.length === 0 || round === 3) return { policy: data, checks, model, attempts };
    lastChecks = checks;
    feedback =
      "Your previous policy failed these checks; fix them:\n" +
      hardFailures.map((c) => `- ${c.label}: ${c.details.join("; ")}`).join("\n");
  }
  throw new Error(`Policy compile failed: ${JSON.stringify(lastChecks)}`);
}
