// Creates a second, independent demo dataset for showing the upload flow with files the app has never seen:
//   Lakeshore Lights Festival 2026 (Fri Oct 16 – Sun Oct 18), SUNDAY cancelled.
//
// It deliberately differs from the Riverside sample: different column names and order, "$" prices,
// US-style purchase dates, different ticket-type codes, a parking add-on, and a scans file with its own headers.
// Every PayPal ID is a REAL sandbox capture (test card), so the Run step can actually refund them.
//
// Writes to test-files/:
//   lakeshore_sales_export.csv, lakeshore_gate_scans.csv, lakeshore_ticket_terms.txt,
//   lakeshore_cancellation_notice.txt, seed-manifest.json
//
// Run once:  npx tsx --env-file=.env scripts/seed-test-files.ts
// Re-run:    add --force (creates NEW payments; the old ones stay in the sandbox)
import { access, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import Papa from "papaparse";
import { PayPalClient } from "../src/paypal/client";
import { centsToValue } from "../src/lib/money";

const dir = new URL("../test-files/", import.meta.url);
const manifestUrl = new URL("seed-manifest.json", dir);
if (process.env.PAYPAL_ENVIRONMENT && process.env.PAYPAL_ENVIRONMENT !== "SANDBOX") throw new Error("Refusing to create test payments outside the PayPal sandbox");
if (!process.argv.includes("--force") && (await access(manifestUrl).then(() => true, () => false))) {
  console.log("Already seeded (test-files/seed-manifest.json exists). Use --force to create a new set.");
  process.exit(0);
}
await mkdir(dir, { recursive: true });

// Product codes as the (fictional) ticketing platform exports them.
const PRICE: Record<string, number> = { "SUN-DAY": 7500, "WKND-GA": 18900, "WKND-VIP": 39900, "PARK-WKND": 4500 };
type Day = "Fri" | "Sat";
type OrderSpec = { name: string; products: string[]; attended: Day[]; channel: string; resoldTo?: string; refundedFull?: boolean };

const NAMES = [
  "Olivia Grant", "Henry Walsh", "Mina Park", "Daniel Osei", "Laura Kowalski", "Victor Hugo Lima", "Esther Mbeki", "Liam O'Connor",
  "Sakura Ito", "Pablo Ruiz", "Freya Nilsen", "Imran Qureshi", "Bianca Ferraro", "Tobias Klein", "Adaeze Obi", "Jonas Berg",
  "Priscilla Tan", "Mohamed Saleh", "Ruth Abebe", "Caleb Turner", "Ingrid Holm", "Nadia Rahman", "Theo Laurent", "Keiko Sato",
];

const orders: OrderSpec[] = [
  // 8 Sunday day tickets (one buyer bought two)
  ...NAMES.slice(0, 8).map((name, i) => ({ name, products: i === 2 ? ["SUN-DAY", "SUN-DAY"] : ["SUN-DAY"], attended: [] as Day[], channel: "Web" })),
  // 10 weekend GA passes, 3 with parking; 2 never came Fri or Sat
  ...NAMES.slice(8, 18).map((name, i) => ({
    name,
    products: i % 3 === 0 ? ["WKND-GA", "PARK-WKND"] : ["WKND-GA"],
    attended: (i === 4 || i === 8 ? [] : i % 2 ? ["Fri", "Sat"] : ["Sat"]) as Day[],
    channel: i % 4 === 1 ? "App" : "Web",
  })),
  // 4 VIP weekend passes; one never came
  ...NAMES.slice(18, 22).map((name, i) => ({ name, products: ["WKND-VIP"], attended: (i === 3 ? [] : ["Fri", "Sat"]) as Day[], channel: "Web" })),
  // Edge cases
  { name: NAMES[22], products: ["WKND-GA"], attended: ["Sat"], channel: "App", resoldTo: "sam.rivera@example.com" },
  { name: NAMES[23], products: ["SUN-DAY"], attended: [], channel: "Web", refundedFull: true },
];

const email = (name: string) =>
  name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z ]/g, "").trim().replace(/\s+/g, ".") + "@example.com";
// US-style timestamps between Aug 20 and Oct 12, 2026
const purchased = (i: number) => {
  const d = new Date(Date.UTC(2026, 7, 20) + ((i * 29) % 53) * 86400000 + ((i * 6151) % 43200) * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};

const pp = new PayPalClient();
const runTag = Date.now().toString(36);

async function payWithCard(ref: string, cents: number): Promise<string> {
  const { data } = await pp.request<any>("POST", "/v2/checkout/orders", {
    requestId: randomUUID(),
    body: {
      intent: "CAPTURE",
      purchase_units: [{ reference_id: ref, custom_id: ref, invoice_id: `${ref}-${runTag}`, description: "Lakeshore Lights Festival 2026 tickets", amount: { currency_code: "USD", value: centsToValue(cents) } }],
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

type Row = Record<string, string>;
const sales: Row[] = [];
const scans: Row[] = [];
const manifest: unknown[] = [];
let barcode = 4100;

const saleRow = (r: { booking: string; code: string; name: string; mail: string; product: string; paid: string; txn: string; resold?: string; date: string; channel: string }): Row => ({
  "Booking #": r.booking, "Txn Date": r.date, "Attendee": r.name, "Email Address": r.mail, "Ticket Type": r.product,
  "Barcode": r.code, "Paid": r.paid, "Channel": r.channel, "PayPal Transaction ID": r.txn, "Resold To": r.resold ?? "",
});

console.log(`Creating ${orders.length} sandbox payments…`);
const queue = orders.map((o, idx) => ({ o, idx }));
async function worker() {
  for (let next = queue.shift(); next; next = queue.shift()) {
    const { o, idx } = next;
    const booking = `LLF-B${String(idx + 1).padStart(4, "0")}`;
    const total = o.products.reduce((s, p) => s + PRICE[p], 0);
    const captureId = await payWithCard(booking, total);
    if (o.refundedFull) await pp.refundCapture({ captureId, amountCents: total, currency: "USD", requestId: randomUUID(), noteToPayer: "Refunded by support before the festival" });
    for (const product of o.products) {
      const code = `LK${String(barcode++).padStart(6, "0")}`;
      sales.push(saleRow({ booking, code, name: o.name, mail: email(o.name), product, paid: `$${(PRICE[product] / 100).toFixed(2)}`, txn: captureId, resold: o.resoldTo, date: purchased(idx), channel: o.channel }));
      for (const day of product.startsWith("PARK") ? [] : o.attended) {
        const base = day === "Fri" ? Date.UTC(2026, 9, 16, 16) : Date.UTC(2026, 9, 17, 12);
        const t = new Date(base + ((barcode * 7919) % 18000) * 1000);
        scans.push({ "Barcode": code, "Scan Time": t.toISOString().slice(0, 19).replace("T", " "), "Entrance": ["North", "South", "Lakeside"][barcode % 3] });
      }
    }
    manifest.push({ booking, name: o.name, products: o.products, totalCents: total, captureId, refundedFull: !!o.refundedFull });
    process.stdout.write(".");
  }
}
await Promise.all([worker(), worker(), worker()]);
console.log(" done");

// No PayPal payment: a complimentary artist guest pass and a gate cash sale.
sales.push(
  saleRow({ booking: "LLF-COMP1", code: "LK009001", name: "Ari Vance", mail: "ari.vance@example.com", product: "WKND-GA", paid: "$0.00", txn: "", date: "10/01/2026 11:00", channel: "Artist guest list" }),
  saleRow({ booking: "LLF-GATE1", code: "LK009002", name: "Dana Fox", mail: "dana.fox@example.com", product: "SUN-DAY", paid: "$75.00", txn: "", date: "10/16/2026 18:05", channel: "Gate (cash)" }),
);
// Three broken rows the importer must set aside, never drop.
sales.push(
  saleRow({ booking: "LLF-ERR1", code: "LK009101", name: "Glen Price", mail: "", product: "SUN-DAY", paid: "$75.00", txn: "", date: "09/14/2026 09:12", channel: "Web" }),
  saleRow({ booking: "LLF-ERR2", code: "LK009102", name: "Rhea Moss", mail: "rhea.moss@example.com", product: "WKND-GA", paid: "N/A", txn: "", date: "09/15/2026 10:40", channel: "Web" }),
  saleRow({ booking: "LLF-ERR3", code: "LK004100", name: "Owen Hart", mail: "owen.hart@example.com", product: "SUN-DAY", paid: "$75.00", txn: "", date: "09/16/2026 13:22", channel: "App" }),
);
// Scans that match no ticket (staff wristbands); reported and ignored.
scans.push({ "Barcode": "STAFF-0007", "Scan Time": "2026-10-16 15:02:44", "Entrance": "North" }, { "Barcode": "STAFF-0012", "Scan Time": "2026-10-17 10:31:09", "Entrance": "South" });

// Export order like a real platform: newest bookings first.
sales.sort((a, b) => b["Booking #"].localeCompare(a["Booking #"]) || a.Barcode.localeCompare(b.Barcode));
scans.sort((a, b) => a["Scan Time"].localeCompare(b["Scan Time"]));

const terms = `LAKESHORE LIGHTS FESTIVAL 2026
TICKET HOLDER AGREEMENT (extract)

SECTION 12: SCHEDULE CHANGES, CANCELLATION AND REFUNDS

12.1 Where the Organiser cancels a festival day, holders of a single-day ticket for that day are entitled to a full refund of the ticket price.

12.2 Where the Organiser cancels one day of the festival, holders of a Weekend pass (GA or VIP) are entitled to a refund of one third (1/3) of the price paid for the pass for each cancelled day.

12.3 A Weekend pass holder who did not enter the festival on any day that went ahead may instead receive a refund of the full price paid.

12.4 The VIP Weekend pass includes a hospitality package valued at $90.00. The hospitality package is non-refundable in all circumstances; any refund under 12.2 or 12.3 is calculated on the pass price less $90.00.

12.5 Weekend parking passes are refunded at one third (1/3) of the parking price for each cancelled day.

12.6 Tickets resold or transferred through the official resale channel are refunded to the original purchaser's payment method only.

12.7 Complimentary, guest-list and artist passes carry no refund entitlement.

12.8 Approved refunds are returned to the original payment method within 10 business days of the cancellation announcement.

12.9 Adverse weather on its own does not give rise to a refund unless the Organiser cancels the affected day.
`;
const notice = `Lakeshore Lights Festival: Sunday cancelled

Following advice from the harbour authority about gale-force winds, all Sunday, October 18 performances at Lakeshore Lights Festival 2026 are cancelled. Friday and Saturday went ahead as planned. Ticket holders will be refunded in line with Section 12 of the Ticket Holder Agreement; no action is needed from you.
`;

await writeFile(new URL("lakeshore_sales_export.csv", dir), Papa.unparse(sales));
await writeFile(new URL("lakeshore_gate_scans.csv", dir), Papa.unparse(scans));
await writeFile(new URL("lakeshore_ticket_terms.txt", dir), terms);
await writeFile(new URL("lakeshore_cancellation_notice.txt", dir), notice);
await writeFile(manifestUrl, JSON.stringify({ createdAt: new Date().toISOString(), runTag, orders: manifest }, null, 2));
console.log(`Wrote ${sales.length} sales rows, ${scans.length} scans, terms, notice, and a manifest of ${manifest.length} payments to test-files/.`);
