import { toCents, type Cents } from "@/lib/money";
import type { ColumnMapping, SalesField } from "@/ai/mapColumns";

export type ImportedTicket = {
  rowNumber: number;
  externalTicketId: string;
  orderRef: string | null;
  buyerName: string | null;
  buyerEmail: string;
  tier: string;
  isAddOn: boolean;
  priceCents: Cents;
  captureId: string | null;
  transferredTo: string | null;
  purchasedAt: string | null;
  isComp: boolean;
};

export type QuarantinedRow = { rowNumber: number; raw: Record<string, string>; reason: string; kind: QuarantineKind };
export type QuarantineKind = "missing_price" | "bad_price" | "bad_email" | "duplicate_id" | "missing_id" | "unknown_tier" | "bad_capture";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CAPTURE = /^[A-Z0-9]{17}$/;

/** Apply a confirmed column mapping to every row. Deterministic: no AI at this point. Bad rows are set aside, never dropped. */
export function applySalesMapping(rows: Record<string, string>[], mapping: ColumnMapping) {
  const col = (field: SalesField) => mapping.columns.find((c) => c.field === field)?.column;
  const get = (row: Record<string, string>, field: SalesField) => {
    const c = col(field);
    return c ? (row[c] ?? "").trim() : "";
  };
  const tierOf = new Map(mapping.tiers.map((t) => [t.value.trim(), t]));

  const idCounts = new Map<string, number>();
  for (const r of rows) {
    const id = get(r, "ticket_id");
    if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }

  const tickets: ImportedTicket[] = [];
  const quarantined: QuarantinedRow[] = [];

  rows.forEach((row, i) => {
    const rowNumber = i + 2; // header is row 1, like a spreadsheet
    const setAside = (kind: QuarantineKind, reason: string) => quarantined.push({ rowNumber, raw: row, reason, kind });

    const id = get(row, "ticket_id");
    if (!id) return setAside("missing_id", "Ticket ID is empty");
    const priceRaw = get(row, "price");
    if (!priceRaw) return setAside("missing_price", "Price is empty");
    const price = toCents(priceRaw);
    if (price === null || price < 0) return setAside("bad_price", `Price "${priceRaw}" isn't a number`);
    const email = get(row, "buyer_email");
    if (!EMAIL.test(email)) return setAside("bad_email", `Email "${email}" isn't valid`);
    if ((idCounts.get(id) ?? 0) > 1) return setAside("duplicate_id", `Ticket ID ${id} appears ${idCounts.get(id)} times`);
    const product = tierOf.get(get(row, "tier"));
    if (!product) return setAside("unknown_tier", `Ticket type "${get(row, "tier")}" isn't mapped`);
    const capture = get(row, "paypal_capture_id");
    if (capture && !CAPTURE.test(capture)) return setAside("bad_capture", `PayPal ID "${capture}" doesn't look like a PayPal transaction`);

    tickets.push({
      rowNumber,
      externalTicketId: id,
      orderRef: get(row, "order_ref") || null,
      buyerName: get(row, "buyer_name") || null,
      buyerEmail: email.toLowerCase(),
      tier: product.tier,
      isAddOn: product.isAddOn,
      priceCents: price,
      captureId: capture || null,
      transferredTo: get(row, "transferred_to") || null,
      purchasedAt: normalizePurchaseTime(get(row, "purchased_at")),
      isComp: price === 0,
    });
  });

  return { tickets, quarantined };
}

/**
 * Ticketing exports write purchase times in many ways. Normalise to "YYYY-MM-DD HH:MM:SS" (event-local, no zone).
 * Accepts ISO ("2026-07-02 10:15", "2026-07-02T10:15:00Z") and slash dates ("10/16/2026 18:05"), read as
 * month/day unless the first number can't be a month. Returns null when unreadable: the purchase time only
 * helps spot duplicate orders, so a bad value must not block the import.
 */
export function normalizePurchaseTime(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = (h = "0", mi = "0", sec = "0", ampm?: string) => {
    let hh = Number(h);
    if (ampm) hh = (hh % 12) + (/p/i.test(ampm) ? 12 : 0);
    return hh <= 23 && Number(mi) <= 59 && Number(sec) <= 59 ? `${pad(hh)}:${pad(Number(mi))}:${pad(Number(sec))}` : null;
  };
  const valid = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const t = time(m[4], m[5], m[6]);
    return valid(y, mo, d) && t ? `${y}-${pad(mo)}-${pad(d)} ${t}` : null;
  }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/.exec(s);
  if (m) {
    let [a, b] = [Number(m[1]), Number(m[2])];
    if (a > 12 && b <= 12) [a, b] = [b, a]; // day/month order
    const y = Number(m[3]);
    const t = time(m[4], m[5], m[6], m[7]);
    return valid(y, a, b) && t ? `${y}-${pad(a)}-${pad(b)} ${t}` : null;
  }
  return null;
}

/** Scan files are simple, so their columns are matched by name, without AI. */
export function applyScans(rows: Record<string, string>[], headers: string[]) {
  const find = (re: RegExp) => headers.find((h) => re.test(h.toLowerCase()));
  const ticketCol = find(/ticket|barcode|code/);
  const timeCol = find(/scan|time|date|at$/);
  const gateCol = find(/gate|door|entrance/);
  if (!ticketCol || !timeCol) throw new Error(`Can't find ticket and time columns in scans file (columns: ${headers.join(", ")})`);
  return rows
    .map((r) => ({ ticketId: (r[ticketCol] ?? "").trim(), scannedAt: (r[timeCol] ?? "").trim(), gate: gateCol ? (r[gateCol] ?? "").trim() : null }))
    .filter((s) => s.ticketId && s.scannedAt);
}

/** "2026-10-30 17:18:32" -> "Fri". Event-local times, so read the calendar date only. */
export function dayOf(scannedAt: string): string {
  const [y, m, d] = scannedAt.slice(0, 10).split("-").map(Number);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}
