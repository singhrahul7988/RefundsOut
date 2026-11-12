import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateTicket, runPolicyTests } from "@/policy/evaluate";
import { Policy } from "@/policy/schema";
import { verifyPolicy } from "@/policy/verify";
import { riversidePolicy } from "@/policy/fixtures/riverside";

const terms = readFileSync(new URL("../data/sample/terms.txt", import.meta.url), "utf8");
const tiers = ["Saturday Day Pass", "3-Day Pass", "VIP 3-Day", "Camping add-on"];

describe("rules engine", () => {
  it("the fixture is a valid policy", () => {
    expect(() => Policy.parse(riversidePolicy)).not.toThrow();
  });

  it("passes every compiler test case", () => {
    expect(runPolicyTests(riversidePolicy).every((t) => t.passed)).toBe(true);
  });

  it("checks never-attended before Saturday's share (priority)", () => {
    const r = evaluateTicket(riversidePolicy, { ticketId: "t", tier: "3-Day Pass", priceCents: 21900, isComp: false, attendedDays: ["Sat"] });
    // A Saturday scan doesn't count: Saturday was cancelled, so this holder never attended another day.
    expect(r).toMatchObject({ kind: "refund", ruleId: "R3", amountCents: 21900 });
  });

  it("applies the VIP hospitality deduction before the share", () => {
    const r = evaluateTicket(riversidePolicy, { ticketId: "t", tier: "VIP 3-Day", priceCents: 44900, isComp: false, attendedDays: ["Fri", "Sun"] });
    expect(r).toMatchObject({ kind: "refund", ruleId: "R2", amountCents: 11633, deductionIds: ["R4"] });
  });

  it("flags ticket types no rule covers instead of guessing", () => {
    const r = evaluateTicket(riversidePolicy, { ticketId: "t", tier: "Backstage Tour", priceCents: 5000, isComp: false, attendedDays: [] });
    expect(r.kind).toBe("no_rule");
  });

  it("is deterministic", () => {
    const t = { ticketId: "t", tier: "Camping add-on", priceCents: 6000, isComp: false, attendedDays: ["Fri"] };
    expect(evaluateTicket(riversidePolicy, t)).toEqual(evaluateTicket(riversidePolicy, t));
  });
});

describe("policy checks", () => {
  it("all checks pass for the real terms", () => {
    const checks = verifyPolicy(riversidePolicy, terms, tiers);
    expect(checks.filter((c) => !c.passed)).toEqual([]);
  });

  it("rejects a quote the AI made up", () => {
    const bad = structuredClone(riversidePolicy);
    bad.rules[1].quote = "All tickets are fully refundable at any time for any reason.";
    const quotes = verifyPolicy(bad, terms, tiers).find((c) => c.id === "quotes")!;
    expect(quotes.passed).toBe(false);
  });

  it("catches a ticket type with no rule", () => {
    const coverage = verifyPolicy(riversidePolicy, terms, [...tiers, "Backstage Tour"]).find((c) => c.id === "coverage")!;
    expect(coverage.passed).toBe(false);
  });

  it("catches two rules that can match the same ticket at the same priority", () => {
    const bad = structuredClone(riversidePolicy);
    bad.rules[0].priority = 2; // R3 now ties with R2, and with attendance undefined they overlap
    bad.rules[0].when.attendedOtherDay = undefined;
    const overlap = verifyPolicy(bad, terms, tiers).find((c) => c.id === "overlap")!;
    expect(overlap.passed).toBe(false);
  });
});
