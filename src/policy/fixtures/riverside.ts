import type { Policy } from "../schema";

// The policy Gemini is expected to compile from data/sample/terms.txt. Used in tests and as an offline fallback for demos.
export const riversidePolicy: Policy = {
  days: ["Fri", "Sat", "Sun"],
  cancelledDays: ["Sat"],
  rules: [
    {
      id: "R3",
      title: "Multi-day pass, never attended",
      clause: "7.3",
      quote: "Pass holders who did not attend any other festival day may instead receive a full refund.",
      priority: 1,
      when: { tiers: ["3-Day Pass", "VIP 3-Day"], attendedOtherDay: false },
      refund: { kind: "percent", percent: 100 },
    },
    {
      id: "R1",
      title: "Saturday Day Pass, full refund",
      clause: "7.1",
      quote: "If a festival day is cancelled, single-day tickets for that day will be refunded in full.",
      priority: 2,
      when: { tiers: ["Saturday Day Pass"] },
      refund: { kind: "percent", percent: 100 },
    },
    {
      id: "R2",
      title: "Multi-day pass, Saturday's share",
      clause: "7.2",
      quote:
        "If any single festival day is cancelled, multi-day pass holders will receive a refund equal to that day's share of the pass price.",
      priority: 2,
      when: { tiers: ["3-Day Pass", "VIP 3-Day"], attendedOtherDay: true },
      refund: { kind: "fraction", numerator: 1, denominator: 3 },
    },
    {
      id: "R5",
      title: "Camping add-on, one night",
      clause: "7.5",
      quote: "Camping add-ons are refunded per night for any cancelled night.",
      priority: 2,
      when: { tiers: ["Camping add-on"] },
      refund: { kind: "fraction", numerator: 1, denominator: 3 },
    },
  ],
  deductions: [
    {
      id: "R4",
      title: "VIP hospitality excluded",
      clause: "7.4",
      quote: "VIP hospitality packages ($100 per pass) are non-refundable.",
      tiers: ["VIP 3-Day"],
      cents: 10000,
      appliesToRules: ["R2", "R3"],
    },
  ],
  tests: [
    { name: "Saturday Day Pass", tier: "Saturday Day Pass", priceCents: 8900, attendedDays: [], expectedCents: 8900 },
    { name: "3-Day Pass, came Friday", tier: "3-Day Pass", priceCents: 21900, attendedDays: ["Fri"], expectedCents: 7300 },
    { name: "3-Day Pass, never came", tier: "3-Day Pass", priceCents: 21900, attendedDays: [], expectedCents: 21900 },
    { name: "VIP 3-Day, came Sunday", tier: "VIP 3-Day", priceCents: 44900, attendedDays: ["Sun"], expectedCents: 11633 },
    { name: "VIP 3-Day, never came", tier: "VIP 3-Day", priceCents: 44900, attendedDays: [], expectedCents: 34900 },
    { name: "Camping add-on", tier: "Camping add-on", priceCents: 6000, attendedDays: ["Fri"], expectedCents: 2000 },
    { name: "Free guest ticket", tier: "3-Day Pass", priceCents: 0, attendedDays: ["Fri"], expectedCents: null },
  ],
  questions: [
    {
      clauseQuote: "VIP hospitality packages ($100 per pass) are non-refundable.",
      question: "What should a VIP who never came get back?",
      options: [
        { label: "$349.00", detail: "Hospitality stays non-refundable (7.4 wins)" },
        { label: "$449.00", detail: "Hospitality refunded too (7.3 wins)" },
      ],
    },
  ],
};
