// The Riverside sample, with brand-new sandbox payments on every click.
//
// A PayPal capture can only be refunded once, and every judge shares one sandbox. If the sample file always
// pointed at the same captures, the first judge's run would leave every later judge with a plan where almost
// every row says "already refunded". So each sample run creates its own captures (same buyers, same amounts,
// same edge cases) and swaps their IDs into the bundled sales file before it is imported.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Papa from "papaparse";
import { PayPalClient } from "@/paypal/client";
import { centsToValue } from "@/lib/money";
import { audit, pool } from "@/db/client";

const DIR = path.join(process.cwd(), "data", "sample");
// 50 payments: ~13s at 25 in parallel, ~67s at 6. PayPal 429s are retried by the client.
const WORKERS = Number(process.env.SAMPLE_PAYMENT_WORKERS ?? 25);
// Must match scripts/seed-sandbox.ts, which made the bundled file and its manifest.
const PARTIAL_REFUND_CENTS = 4000;
const SALES_REF = "Order Ref";
const SALES_TXN = "PP Txn";

type ManifestOrder = { ref: string; totalCents: number; captureId: string; special: string | null };

export async function readSampleFiles() {
  const [sales, scans, terms, notice, manifest] = await Promise.all(
    ["sales.csv", "scans.csv", "terms.txt", "notice.txt", "seed-manifest.json"].map((f) => readFile(path.join(DIR, f), "utf8")),
  );
  return { sales, scans, terms, notice, orders: (JSON.parse(manifest) as { orders: ManifestOrder[] }).orders };
}

async function payWithCard(pp: PayPalClient, ref: string, cents: number, tag: string): Promise<string> {
  const { data } = await pp.request<any>("POST", "/v2/checkout/orders", {
    requestId: randomUUID(),
    body: {
      intent: "CAPTURE",
      purchase_units: [{ reference_id: ref, custom_id: ref, invoice_id: `${ref}-${tag}`, description: "Riverside Sound Festival 2026 tickets", amount: { currency_code: "USD", value: centsToValue(cents) } }],
      payment_source: {
        card: { number: process.env.TEST_CARD_NUMBER ?? "4111111111111111", expiry: process.env.TEST_CARD_EXPIRY ?? "2030-12", name: "Festival Buyer", security_code: "123" },
      },
    },
  });
  let order = data;
  if (order.status !== "COMPLETED") ({ data: order } = await pp.request<any>("POST", `/v2/checkout/orders/${order.id}/capture`, { requestId: randomUUID(), body: {} }));
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  if (!capture || capture.status !== "COMPLETED") throw new Error(`Order ${ref}: capture not completed (${capture?.status})`);
  return capture.id as string;
}

/**
 * Returns the sample sales file with a fresh sandbox capture behind every PayPal row.
 * Never fails the sample: an order whose payment can't be created keeps its bundled ID, and outside the
 * sandbox nothing is created at all.
 */
export async function freshSampleSales(eventId: string, actor: string, salesCsv: string, orders: ManifestOrder[]): Promise<string> {
  if ((process.env.PAYPAL_ENVIRONMENT ?? "SANDBOX") !== "SANDBOX") return salesCsv;
  const started = Date.now();
  const tag = `${eventId.slice(0, 8)}-${Date.now().toString(36)}`;
  const pp = new PayPalClient();
  const fresh = new Map<string, string>();
  const failed: string[] = [];

  const queue = [...orders];
  async function worker() {
    for (let o = queue.shift(); o; o = queue.shift()) {
      try {
        const captureId = await payWithCard(pp, o.ref, o.totalCents, tag);
        // Recreate the bundled edge cases so the plan still catches them.
        if (o.special === "already_refunded_full")
          await pp.refundCapture({ captureId, amountCents: o.totalCents, currency: "USD", requestId: randomUUID(), noteToPayer: "Refunded by box office staff" });
        if (o.special === "already_refunded_partial")
          await pp.refundCapture({ captureId, amountCents: PARTIAL_REFUND_CENTS, currency: "USD", requestId: randomUUID(), noteToPayer: "Parking credit" });
        fresh.set(o.ref, captureId);
      } catch (err) {
        console.error(`Sample payment ${o.ref} not created:`, (err as Error).message);
        failed.push(o.ref);
      }
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, worker));

  const parsed = Papa.parse<Record<string, string>>(salesCsv, { header: true, skipEmptyLines: true });
  for (const row of parsed.data) {
    const id = fresh.get(row[SALES_REF]);
    if (id) row[SALES_TXN] = id;
  }
  await audit(pool, {
    actor, action: "sample.payments_created", entity: "event", entityId: eventId,
    after: { created: fresh.size, failed, seconds: Math.round((Date.now() - started) / 1000) },
  });
  return Papa.unparse(parsed.data, { columns: parsed.meta.fields });
}
