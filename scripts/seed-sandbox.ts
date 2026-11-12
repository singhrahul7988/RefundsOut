// Creates the Riverside Sound Festival demo data:
//  - 50 REAL sandbox payments (test card, captured immediately), including edge cases
//  - data/sample/sales.csv   (messy column names on purpose, like a real ticketing export)
//  - data/sample/scans.csv   (gate scans for Fri Oct 30 and Sun Nov 1; Sat Oct 31 was cancelled)
//  - data/sample/seed-manifest.json (what was created, for debugging)
//
// Run once:  npx tsx --env-file=.env scripts/seed-sandbox.ts
// Re-run:    add --force (creates 50 NEW payments; the old ones stay in the sandbox)
import { access, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import Papa from "papaparse";
import { PayPalClient } from "../src/paypal/client";
import { centsToValue } from "../src/lib/money";

const dir = new URL("../data/sample/", import.meta.url);
const manifestUrl = new URL("seed-manifest.json", dir);
const force = process.argv.includes("--force");
if (!force && (await access(manifestUrl).then(() => true, () => false))) {
  console.log("Already seeded (data/sample/seed-manifest.json exists). Use --force to create a new set.");
  process.exit(0);
}

const PRICE: Record<string, number> = { "Sat Day GA": 8900, "3 Day GA Pass": 21900, "3 Day VIP": 44900, "Camping (3 nights)": 6000 };
type Day = "Fri" | "Sun";
type Special = "already_refunded_full" | "already_refunded_partial" | "duplicate" | "transferred";
type OrderSpec = { name: string; products: string[]; attended: Day[]; special?: Special; transferTo?: string; dupOf?: number };

const NAMES = [
  "Priya Raman", "Tom Becker", "Ana Souza", "Sam Okafor", "Rosa Díaz", "Lee Wong", "Dev Malhotra", "Chris Patel", "Mei Tanaka",
  "Jordan Ellis", "Aisha Bello", "Lucas Martin", "Hana Kim", "Omar Haddad", "Sofia Rossi", "Ethan Brooks", "Zara Ahmed",
  "Noah Fischer", "Isla Murphy", "Ravi Iyer", "Chloe Dubois", "Mateo García", "Yuki Sato", "Grace Okoye", "Leo Novak",
  "Amara Nwosu", "Felix Wagner", "Nina Petrova", "Kai Nakamura", "Elena Costa", "Sami Lahti", "Maya Levi", "Arjun Rao",
  "Fatima Zahra", "Ben Carter", "Lina Haddad", "Oscar Lind", "Ivy Chen", "Tariq Aziz", "Clara Weiss", "Diego Ramos",
  "Hannah Cole", "Kofi Mensah", "Julia Nowak", "Ryo Mori", "Anya Singh", "Marco Bianchi", "Sara Lund",
];

const orders: OrderSpec[] = [];
// 18 Saturday Day Pass orders (2 of them buy two tickets)
for (let i = 0; i < 18; i++) orders.push({ name: NAMES[i], products: i === 4 || i === 11 ? ["Sat Day GA", "Sat Day GA"] : ["Sat Day GA"], attended: [] });
// 22 three-day passes; 6 with camping; 3 never came
for (let i = 0; i < 22; i++) {
  const neverCame = [4, 14, 19].includes(i);
  const attended: Day[] = neverCame ? [] : i % 3 === 0 ? ["Fri"] : i % 3 === 1 ? ["Sun"] : ["Fri", "Sun"];
  orders.push({ name: NAMES[18 + i], products: i % 4 === 0 && i < 24 ? ["3 Day GA Pass", "Camping (3 nights)"] : ["3 Day GA Pass"], attended });
}
// 6 VIP passes; the last one never came (this is the case behind the compiler's question)
for (let i = 0; i < 6; i++) orders.push({ name: NAMES[40 + i], products: ["3 Day VIP"], attended: i === 5 ? [] : i % 2 ? ["Sun"] : ["Fri", "Sun"] });
// Edge cases
orders.push({ name: NAMES[19], products: ["3 Day GA Pass"], attended: ["Fri"], special: "duplicate", dupOf: 19 }); // same buyer as order #20
orders.push({ name: NAMES[46], products: ["3 Day GA Pass"], attended: ["Sun"], special: "transferred", transferTo: "jamie.ortiz@example.com" });
orders.push({ name: NAMES[47], products: ["Sat Day GA"], attended: [], special: "already_refunded_full" });
orders.push({ name: "Wren Adams", products: ["3 Day GA Pass"], attended: ["Fri", "Sun"], special: "already_refunded_partial" });

const email = (name: string) =>
  name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z ]/g, "").trim().replace(/\s+/g, ".") + "@example.com";

// Deterministic purchase dates between Aug 1 and Oct 25, 2026
const purchaseDate = (i: number) => new Date(Date.UTC(2026, 7, 1) + ((i * 37) % 85) * 86400000 + ((i * 7919) % 43200) * 1000);

const pp = new PayPalClient();
const runTag = Date.now().toString(36);

async function payWithCard(ref: string, cents: number): Promise<string> {
  const { data } = await pp.request<any>("POST", "/v2/checkout/orders", {
    requestId: randomUUID(),
    body: {
      intent: "CAPTURE",
      purchase_units: [{ reference_id: ref, custom_id: ref, invoice_id: `${ref}-${runTag}`, description: "Riverside Sound Festival 2026 tickets", amount: { currency_code: "USD", value: centsToValue(cents) } }],
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

type SalesRow = Record<string, string>;
const sales: SalesRow[] = [];
const scans: Record<string, string>[] = [];
const manifest: unknown[] = [];
let ticketSeq = 1000;

console.log(`Creating ${orders.length} sandbox payments…`);
const queue = orders.map((o, idx) => ({ o, idx }));
async function worker() {
  for (let next = queue.shift(); next; next = queue.shift()) {
    const { o, idx } = next;
    const ref = `ORD-${String(idx + 1).padStart(4, "0")}`;
    const total = o.products.reduce((s, p) => s + PRICE[p], 0);
    const captureId = await payWithCard(ref, total);
    if (o.special === "already_refunded_full")
      await pp.refundCapture({ captureId, amountCents: total, currency: "USD", requestId: randomUUID(), noteToPayer: "Refunded by box office staff" });
    if (o.special === "already_refunded_partial")
      await pp.refundCapture({ captureId, amountCents: 4000, currency: "USD", requestId: randomUUID(), noteToPayer: "Parking credit" });
    const bought = purchaseDate(o.dupOf !== undefined ? o.dupOf : idx);
    if (o.special === "duplicate") bought.setUTCMinutes(bought.getUTCMinutes() + 3);
    for (const product of o.products) {
      const ticket = `RSF-26-${String(ticketSeq++).padStart(6, "0")}`;
      sales.push({
        "Order Ref": ref, "Ticket No": ticket, "Buyer Name": o.name, "Buyer E-mail": email(o.name), Product: product,
        "Amount (USD)": (PRICE[product] / 100).toFixed(2), "PP Txn": captureId, "Transferred To": o.transferTo ?? "",
        Purchased: bought.toISOString().slice(0, 16).replace("T", " "), Promo: "",
      });
      for (const day of product.startsWith("Camping") ? [] : o.attended) {
        const base = day === "Fri" ? Date.UTC(2026, 9, 30, 17) : Date.UTC(2026, 10, 1, 12);
        const t = new Date(base + ((ticketSeq * 7919) % 18000) * 1000);
        scans.push({ ticket, scanned_at: t.toISOString().slice(0, 19).replace("T", " "), gate: "ABCD"[ticketSeq % 4] });
      }
    }
    manifest.push({ ref, name: o.name, products: o.products, totalCents: total, captureId, special: o.special ?? null });
    process.stdout.write(".");
  }
}
await Promise.all([worker(), worker(), worker()]);
console.log(" done");

// The two disputed payments opened by refundout-buyer on Nov 9 (early-bird prices)
sales.push(
  { "Order Ref": "ORD-EB01", "Ticket No": "RSF-26-000901", "Buyer Name": "Sandbox Buyer", "Buyer E-mail": "sandbox.buyer@example.com", Product: "3 Day GA Pass", "Amount (USD)": "150.00", "PP Txn": "9RK77752WX7840534", "Transferred To": "", Purchased: "2026-07-02 10:15", Promo: "EARLYBIRD" },
  { "Order Ref": "ORD-EB02", "Ticket No": "RSF-26-000902", "Buyer Name": "Sandbox Buyer", "Buyer E-mail": "sandbox.buyer@example.com", Product: "Sat Day GA", "Amount (USD)": "85.00", "PP Txn": "6KD11022545452820", "Transferred To": "", Purchased: "2026-07-02 10:17", Promo: "EARLYBIRD" },
);
scans.push({ ticket: "RSF-26-000901", scanned_at: "2026-10-30 19:02:11", gate: "B" });
// A free guest ticket and a box-office cash sale (no PayPal payment)
sales.push(
  { "Order Ref": "ORD-GUEST", "Ticket No": "RSF-26-000950", "Buyer Name": "Pat Guest", "Buyer E-mail": "pat.guest@example.com", Product: "3 Day GA Pass", "Amount (USD)": "0.00", "PP Txn": "", "Transferred To": "", Purchased: "2026-10-20 09:00", Promo: "GUEST" },
  { "Order Ref": "ORD-BOX1", "Ticket No": "RSF-26-000960", "Buyer Name": "Morgan Hale", "Buyer E-mail": "morgan.hale@example.com", Product: "Sat Day GA", "Amount (USD)": "89.00", "PP Txn": "", "Transferred To": "", Purchased: "2026-10-30 18:40", Promo: "BOXOFFICE" },
);
// Four broken rows the importer must set aside, never drop
sales.push(
  { "Order Ref": "ORD-X1", "Ticket No": "RSF-26-000971", "Buyer Name": "Kim Lee", "Buyer E-mail": "kim.lee@example.com", Product: "Sat Day GA", "Amount (USD)": "", "PP Txn": "", "Transferred To": "", Purchased: "2026-09-01 12:00", Promo: "" },
  { "Order Ref": "ORD-X2", "Ticket No": "RSF-26-000972", "Buyer Name": "Maria Silva", "Buyer E-mail": "maria@@example.com", Product: "Sat Day GA", "Amount (USD)": "89.00", "PP Txn": "", "Transferred To": "", Purchased: "2026-09-02 12:00", Promo: "" },
  { "Order Ref": "ORD-X3", "Ticket No": "RSF-26-000971", "Buyer Name": "Kim Lee", "Buyer E-mail": "kim.lee@example.com", Product: "Sat Day GA", "Amount (USD)": "89.00", "PP Txn": "", "Transferred To": "", Purchased: "2026-09-01 12:01", Promo: "" },
  { "Order Ref": "ORD-X4", "Ticket No": "RSF-26-000974", "Buyer Name": "Alex Moore", "Buyer E-mail": "alex.moore@example.com", Product: "3 Day GA Pass", "Amount (USD)": "two-nineteen", "PP Txn": "", "Transferred To": "", Purchased: "2026-09-03 12:00", Promo: "" },
);
// Scans that match no ticket (ignored, reported)
scans.push({ ticket: "RSF-26-999901", scanned_at: "2026-10-30 20:11:05", gate: "A" }, { ticket: "RSF-26-999902", scanned_at: "2026-11-01 15:40:51", gate: "C" });

sales.sort((a, b) => a["Ticket No"].localeCompare(b["Ticket No"]));
scans.sort((a, b) => a.scanned_at.localeCompare(b.scanned_at));
await writeFile(new URL("sales.csv", dir), Papa.unparse(sales));
await writeFile(new URL("scans.csv", dir), Papa.unparse(scans));
await writeFile(manifestUrl, JSON.stringify({ createdAt: new Date().toISOString(), runTag, orders: manifest }, null, 2));
console.log(`Wrote ${sales.length} sales rows, ${scans.length} scans, manifest of ${manifest.length} payments.`);
