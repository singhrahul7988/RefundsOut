import { generateText } from "./gemini";
import { formatMoney } from "@/lib/money";

// Gemini writes the wording with placeholders; code fills in every amount, date and ID.
// So a letter can never state a number that differs from what was actually refunded.
const SYSTEM = `You write short, warm refund letters from a music festival to a ticket buyer.
Use these placeholders exactly where the facts go and never write numbers or IDs yourself:
{{first_name}}, {{event}}, {{cancelled_day}}, {{tickets}}, {{amount}}, {{reason}}, {{reference}}, {{method}}.
{{reason}} is the refund rule from the ticket terms (e.g. "clause 12.1, single-day ticket full refund"). It is NOT why the day was cancelled, so write "under {{reason}}", never "cancelled due to {{reason}}".
{{method}} is a whole phrase such as "a refund to your PayPal payment". Use it once, only as "sent as {{method}}".
Always state {{amount}} and {{reference}}. Never call the refund "full" or "partial": the amount already says what was refunded.
{{tickets}} already starts with "a" or a count (e.g. "a Sunday Day Pass", "2 Sunday Day Pass tickets"), so never put "your", "the" or "a" right before it.
4 short paragraphs, plain text, no subject line, sign off as "The {{event}} team".`;

export type LetterFacts = {
  firstName: string; event: string; cancelledDay: string; tickets: string; amountCents: number; reason: string; reference: string; method: "refund" | "offer";
};

export async function writeLetter(facts: LetterFacts): Promise<{ body: string; filled: string[] }> {
  let template: string;
  try {
    template = await generateText(
      SYSTEM,
      `Write the letter for a buyer whose ${facts.method === "offer" ? "refund is offered through their open PayPal dispute" : "refund was sent to their PayPal payment"}. The reason placeholder will contain the ticket-terms clause that applies.`,
    );
    // Hard check, not trust: a letter that skips the amount or reference, or calls a partial refund "full", is not sent.
    if (!["{{first_name}}", "{{amount}}", "{{reference}}"].every((p) => template.includes(p)) || /\b(full|partial)\s+refund/i.test(template)) {
      throw new Error("letter template is missing required facts");
    }
  } catch {
    template = `Hi {{first_name}},\n\n{{cancelled_day}} at {{event}} was cancelled, and we're sorry you missed it.\n\nYou held {{tickets}}. Under our ticket terms ({{reason}}), you get {{amount}} back.\n\nIt's on its way to the PayPal account you paid with. Your reference is {{reference}}.\n\nThe {{event}} team`;
  }
  const values: Record<string, string> = {
    first_name: facts.firstName,
    event: facts.event,
    cancelled_day: facts.cancelledDay,
    tickets: facts.tickets,
    amount: formatMoney(facts.amountCents),
    reason: facts.reason,
    reference: facts.reference,
    method: facts.method === "offer" ? "an offer in your PayPal dispute" : "a refund to your PayPal payment",
  };
  const filled: string[] = [];
  const body = template.replace(/\{\{(\w+)\}\}/g, (_, k: string, offset: number, whole: string) => {
    if (k in values) {
      let v = values[k];
      // The model sometimes writes "your {{tickets}}" anyway; drop our leading article so it doesn't read "your a Sunday Day Pass".
      if ((k === "tickets" || k === "method") && /\b(your|the|a|an)\s+$/i.test(whole.slice(0, offset))) v = v.replace(/^an? /i, "");
      filled.push(v);
      return `⟦${v}⟧`;
    }
    return "";
  });
  return { body, filled };
}
