import { z } from "zod";
import { generateJson } from "./gemini";

export const SALES_FIELDS = [
  "ticket_id",
  "order_ref",
  "buyer_name",
  "buyer_email",
  "tier",
  "price",
  "paypal_capture_id",
  "transferred_to",
  "purchased_at",
  "ignore",
] as const;
export type SalesField = (typeof SALES_FIELDS)[number];

export const ColumnMapping = z.object({
  columns: z.array(
    z.object({
      column: z.string(),
      field: z.enum(SALES_FIELDS),
      confidence: z.enum(["sure", "check"]),
      reason: z.string(),
    }),
  ),
  tiers: z.array(
    z.object({
      value: z.string(), // product value exactly as it appears in the file
      tier: z.string(), // clean, human ticket-type name, e.g. "Saturday Day Pass"
      isAddOn: z.boolean(),
    }),
  ),
});
export type ColumnMapping = z.infer<typeof ColumnMapping>;

const SYSTEM = `You map columns of a ticket sales export to a fixed set of fields for a refund tool.
Rules:
- Use each field at most once, except "ignore".
- "paypal_capture_id" holds PayPal transaction/capture IDs (17 uppercase letters and digits).
- "price" is the amount paid for that ticket.
- Mark confidence "check" when a column is mostly empty or the match is a guess.
- For ticket types, give each distinct product value a short, clear name a festival-goer would recognise
  (e.g. "Sat Day GA" -> "Saturday Day Pass"). Mark camping, parking and similar extras as add-ons.
Return JSON only.`;

/** Gemini proposes the mapping once from headers + sample rows. The organizer confirms it; code applies it to every row. */
export async function suggestColumnMapping(headers: string[], rows: Record<string, string>[]) {
  const sample = rows.slice(0, 8).map((r) => headers.map((h) => `${h}=${JSON.stringify(r[h] ?? "")}`).join(" | "));
  // Columns with few distinct values are likely ticket types; send their values so Gemini can name the tiers.
  const lowCardinality: Record<string, string[]> = {};
  for (const h of headers) {
    const values = [...new Set(rows.map((r) => (r[h] ?? "").trim()).filter(Boolean))];
    if (values.length > 0 && values.length <= 12) lowCardinality[h] = values;
  }
  const emptyCounts = Object.fromEntries(headers.map((h) => [h, rows.filter((r) => !(r[h] ?? "").trim()).length]));
  return generateJson({
    system: SYSTEM,
    schema: ColumnMapping,
    parts: [
      `Columns: ${JSON.stringify(headers)}`,
      `Row count: ${rows.length}. Empty cells per column: ${JSON.stringify(emptyCounts)}`,
      `Sample rows:\n${sample.join("\n")}`,
      `Distinct values of low-cardinality columns: ${JSON.stringify(lowCardinality)}`,
    ],
  });
}
