import { mulDivRoundHalfUp, type Cents } from "@/lib/money";
import type { Policy, Rule } from "./schema";

export type TicketInput = {
  ticketId: string;
  tier: string;
  priceCents: Cents;
  isComp: boolean;
  attendedDays: string[]; // days with a gate scan
};

export type TicketResult =
  | { kind: "refund"; ticketId: string; amountCents: Cents; ruleId: string; deductionIds: string[]; explanation: string }
  | { kind: "skip"; ticketId: string; amountCents: 0; reason: string }
  | { kind: "no_rule"; ticketId: string; amountCents: 0; reason: string };

function attendedOtherDay(policy: Policy, attendedDays: string[]): boolean {
  return attendedDays.some((d) => !policy.cancelledDays.includes(d));
}

function matches(rule: Rule, policy: Policy, t: TicketInput): boolean {
  if (!rule.when.tiers.includes(t.tier)) return false;
  if (rule.when.attendedOtherDay !== undefined && rule.when.attendedOtherDay !== attendedOtherDay(policy, t.attendedDays)) {
    return false;
  }
  return true;
}

function applyFormula(rule: Rule, baseCents: Cents): Cents {
  const f = rule.refund;
  switch (f.kind) {
    case "percent":
      return mulDivRoundHalfUp(baseCents, f.percent, 100);
    case "fraction":
      return mulDivRoundHalfUp(baseCents, f.numerator, f.denominator);
    case "fixed":
      return Math.min(f.cents, baseCents);
    case "none":
      return 0;
  }
}

function describe(rule: Rule, priceCents: Cents, amountCents: Cents, deductionCents: Cents): string {
  const money = (c: Cents) => `$${(c / 100).toFixed(2)}`;
  const base = deductionCents > 0 ? `(${money(priceCents)} − ${money(deductionCents)})` : money(priceCents);
  const f = rule.refund;
  const math =
    f.kind === "percent"
      ? `${f.percent}% of ${base}`
      : f.kind === "fraction"
        ? `${base} × ${f.numerator}/${f.denominator}`
        : f.kind === "fixed"
          ? `fixed ${money(f.cents)}`
          : "no refund";
  return `${rule.id} (clause ${rule.clause}): ${math} = ${money(amountCents)}`;
}

/** Pure, deterministic: same ticket + same policy = same result, every time. */
export function evaluateTicket(policy: Policy, t: TicketInput): TicketResult {
  if (t.isComp || t.priceCents === 0) {
    return { kind: "skip", ticketId: t.ticketId, amountCents: 0, reason: "Free ticket: nothing was paid" };
  }
  const ordered = [...policy.rules].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const rule = ordered.find((r) => matches(r, policy, t));
  if (!rule) {
    return { kind: "no_rule", ticketId: t.ticketId, amountCents: 0, reason: `No rule covers ticket type "${t.tier}"` };
  }
  const deductions = policy.deductions.filter((d) => d.tiers.includes(t.tier) && d.appliesToRules.includes(rule.id));
  const deductionCents = deductions.reduce((sum, d) => sum + d.cents, 0);
  const baseCents = Math.max(0, t.priceCents - deductionCents);
  const amountCents = applyFormula(rule, baseCents);
  return {
    kind: "refund",
    ticketId: t.ticketId,
    amountCents,
    ruleId: rule.id,
    deductionIds: deductions.map((d) => d.id),
    explanation: describe(rule, t.priceCents, amountCents, deductionCents),
  };
}

export type TestOutcome = { name: string; expectedCents: Cents | null; actualCents: Cents | null; passed: boolean };

/** Run the compiler's own test cases through the deterministic engine. */
export function runPolicyTests(policy: Policy): TestOutcome[] {
  return policy.tests.map((test, i) => {
    const r = evaluateTicket(policy, {
      ticketId: `test-${i + 1}`,
      tier: test.tier,
      priceCents: test.priceCents,
      isComp: test.priceCents === 0,
      attendedDays: test.attendedDays,
    });
    const actual = r.kind === "refund" ? r.amountCents : null;
    // "no refund" may be written as 0 or as skipped (null); either way nothing is owed, so they match each other.
    const same = actual === test.expectedCents || ((actual ?? 0) === 0 && (test.expectedCents ?? 0) === 0);
    return { name: test.name, expectedCents: test.expectedCents, actualCents: actual, passed: same };
  });
}
