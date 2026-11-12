import { z } from "zod";

// The refund policy format Gemini must produce. Code evaluates it; AI never computes amounts.

export const RefundFormula = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("percent"), percent: z.number().int().min(0).max(100) }),
  z.object({ kind: z.literal("fraction"), numerator: z.number().int().min(0), denominator: z.number().int().min(1) }),
  z.object({ kind: z.literal("fixed"), cents: z.number().int().min(0) }),
  z.object({ kind: z.literal("none") }),
]);
export type RefundFormula = z.infer<typeof RefundFormula>;

export const Rule = z.object({
  id: z.string().regex(/^R\d+$/),
  title: z.string().min(3),
  clause: z.string().min(1), // e.g. "7.2"
  quote: z.string().min(10), // must appear word for word in the source terms
  priority: z.number().int().min(1), // lower runs first; first match wins
  when: z.object({
    tiers: z.array(z.string()).min(1), // canonical ticket types this rule covers
    attendedOtherDay: z.boolean().optional(), // true / false / undefined = doesn't matter
  }),
  refund: RefundFormula,
});
export type Rule = z.infer<typeof Rule>;

/** Subtracted from the price before a rule's formula runs (e.g. non-refundable VIP hospitality). */
export const Deduction = z.object({
  id: z.string().regex(/^[A-Z]{1,2}\d+$/), // models often call these D1, D2; any short letter+number id is fine
  title: z.string(),
  clause: z.string(),
  quote: z.string().min(10),
  tiers: z.array(z.string()).min(1),
  cents: z.number().int().min(0),
  appliesToRules: z.array(z.string().regex(/^R\d+$/)).min(1),
});
export type Deduction = z.infer<typeof Deduction>;

export const PolicyTest = z.object({
  name: z.string(),
  tier: z.string(),
  priceCents: z.number().int().min(0),
  attendedDays: z.array(z.string()),
  expectedCents: z.number().int().min(0).nullable(), // null = expected to be skipped
});
export type PolicyTest = z.infer<typeof PolicyTest>;

export const PolicyQuestion = z.object({
  clauseQuote: z.string(),
  question: z.string(),
  options: z.array(z.object({ label: z.string(), detail: z.string() })).min(2).max(4),
});
export type PolicyQuestion = z.infer<typeof PolicyQuestion>;

export const Policy = z.object({
  days: z.array(z.string()).min(1), // e.g. ["Fri","Sat","Sun"]
  cancelledDays: z.array(z.string()).min(1), // e.g. ["Sat"]
  rules: z.array(Rule).min(1),
  deductions: z.array(Deduction).default([]),
  tests: z.array(PolicyTest).default([]),
  questions: z.array(PolicyQuestion).default([]),
});
export type Policy = z.infer<typeof Policy>;
