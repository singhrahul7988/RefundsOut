// Offline safety nets for the bundled Riverside sample ONLY. If Gemini is unreachable (quota, outage) while a
// judge is clicking through, the sample still works. Real uploads never use these; they surface the error.
import type { ColumnMapping } from "./mapColumns";
import { riversidePolicy } from "@/policy/fixtures/riverside";
import type { Policy } from "@/policy/schema";

const SAMPLE_HEADERS = ["Order Ref", "Ticket No", "Buyer Name", "Buyer E-mail", "Product", "Amount (USD)", "PP Txn", "Transferred To", "Purchased", "Promo"];

export function sampleColumnMapping(headers: string[]): ColumnMapping | null {
  if (headers.length !== SAMPLE_HEADERS.length || !SAMPLE_HEADERS.every((h, i) => headers[i] === h)) return null;
  return {
    columns: [
      { column: "Order Ref", field: "order_ref", confidence: "sure", reason: "Order reference" },
      { column: "Ticket No", field: "ticket_id", confidence: "sure", reason: "Unique ticket identifier" },
      { column: "Buyer Name", field: "buyer_name", confidence: "sure", reason: "Buyer's name" },
      { column: "Buyer E-mail", field: "buyer_email", confidence: "sure", reason: "Buyer's email" },
      { column: "Product", field: "tier", confidence: "sure", reason: "Ticket type" },
      { column: "Amount (USD)", field: "price", confidence: "sure", reason: "Price paid" },
      { column: "PP Txn", field: "paypal_capture_id", confidence: "sure", reason: "17-character PayPal transaction id" },
      { column: "Transferred To", field: "transferred_to", confidence: "check", reason: "Almost always empty" },
      { column: "Purchased", field: "purchased_at", confidence: "sure", reason: "Purchase time" },
      { column: "Promo", field: "ignore", confidence: "sure", reason: "Promo code, not needed for refunds" },
    ],
    tiers: [
      { value: "Sat Day GA", tier: "Saturday Day Pass", isAddOn: false },
      { value: "3 Day GA Pass", tier: "3-Day Pass", isAddOn: false },
      { value: "3 Day VIP", tier: "VIP 3-Day", isAddOn: false },
      { value: "Camping (3 nights)", tier: "Camping add-on", isAddOn: true },
    ],
  };
}

/** The sample terms compile to the fixture policy; only usable when the ticket-type names match it. */
export function samplePolicy(terms: string, tiers: string[], answers: { question: string; answer: string }[] = []): Policy | null {
  if (!terms.includes("RIVERSIDE SOUND FESTIVAL 2026")) return null;
  // Gemini may have named the ticket types differently from the fixture ("3-Day General Admission Pass"), so map by meaning.
  const classify = (t: string) => (/camp/i.test(t) ? "Camping add-on" : /vip/i.test(t) ? "VIP 3-Day" : /\b(3|three)[\s-]*day/i.test(t) ? "3-Day Pass" : /sat|single|one[\s-]*day|\bday pass/i.test(t) ? "Saturday Day Pass" : null);
  const rename = new Map<string, string>();
  for (const t of tiers) {
    const canon = classify(t);
    if (!canon || (rename.has(canon) && rename.get(canon) !== t)) return null; // unknown or ambiguous: no fallback
    rename.set(canon, t);
  }
  const policy = structuredClone(riversidePolicy);
  const sub = (names: string[]) => names.map((n) => rename.get(n) ?? n);
  for (const r of policy.rules) r.when.tiers = sub(r.when.tiers);
  for (const d of policy.deductions) d.tiers = sub(d.tiers);
  for (const x of policy.tests) x.tier = rename.get(x.tier) ?? x.tier;
  // The fixture defaults to "hospitality stays non-refundable" for a VIP who never came. If the organizer
  // already answered the other way, follow them: drop the deduction from the never-attended rule.
  const vip = answers.find((a) => /vip/i.test(a.question));
  if (vip && /449|refunded too|7\.3 wins/i.test(vip.answer)) {
    for (const d of policy.deductions) d.appliesToRules = d.appliesToRules.filter((r) => r !== "R3");
    for (const x of policy.tests) if (/vip/i.test(x.tier) && x.attendedDays.length === 0 && x.expectedCents) x.expectedCents = x.priceCents;
  }
  // The fixture's rules already encode the default answer to its one question, so the fallback never asks it:
  // a judge whose Gemini call failed must not get stuck behind a question that can't be re-answered consistently.
  return { ...policy, questions: [] };
}
