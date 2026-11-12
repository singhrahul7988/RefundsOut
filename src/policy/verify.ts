import type { Policy } from "./schema";
import { runPolicyTests } from "./evaluate";

export type PolicyCheck = { id: string; label: string; passed: boolean; details: string[] };

/** Normalise whitespace and curly quotes so a quote check isn't fooled by PDF line breaks. */
export function normaliseText(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Deterministic checks on a compiled policy. Approval is blocked unless every check passes.
 * - quotes: every rule and deduction quote appears word for word in the source terms
 * - coverage: every ticket type in the sales data has at least one rule
 * - overlap: no two rules with the same priority can match the same ticket
 * - tests: every compiler test case passes in the real engine
 */
export function verifyPolicy(policy: Policy, sourceText: string, tiersInData: string[]): PolicyCheck[] {
  const source = normaliseText(sourceText);

  const badQuotes = [...policy.rules, ...policy.deductions]
    .filter((r) => !source.includes(normaliseText(r.quote)))
    .map((r) => `${r.id}: quote not found in the terms`);

  const uncovered = tiersInData.filter((tier) => !policy.rules.some((r) => r.when.tiers.includes(tier)));

  const overlaps: string[] = [];
  for (let i = 0; i < policy.rules.length; i++) {
    for (let j = i + 1; j < policy.rules.length; j++) {
      const a = policy.rules[i];
      const b = policy.rules[j];
      if (a.priority !== b.priority) continue;
      const sharedTier = a.when.tiers.some((t) => b.when.tiers.includes(t));
      const attendanceCompatible =
        a.when.attendedOtherDay === undefined ||
        b.when.attendedOtherDay === undefined ||
        a.when.attendedOtherDay === b.when.attendedOtherDay;
      if (sharedTier && attendanceCompatible) overlaps.push(`${a.id} and ${b.id} can match the same ticket with the same priority`);
    }
  }

  const tests = runPolicyTests(policy);
  const failed = tests.filter((t) => !t.passed).map((t) => `${t.name}: expected ${t.expectedCents}, engine gave ${t.actualCents}`);

  return [
    { id: "quotes", label: "Every quote found word for word", passed: badQuotes.length === 0, details: badQuotes },
    { id: "coverage", label: "Every ticket type covered", passed: uncovered.length === 0, details: uncovered.map((t) => `No rule for "${t}"`) },
    { id: "overlap", label: "Overlaps have a set priority", passed: overlaps.length === 0, details: overlaps },
    { id: "tests", label: `${tests.length - failed.length} of ${tests.length} tests pass`, passed: failed.length === 0, details: failed },
  ];
}
