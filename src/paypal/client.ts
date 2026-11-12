import { createHash, randomUUID } from "node:crypto";
import { centsToValue, toCents, type Cents } from "@/lib/money";

// Small PayPal REST client. We own retries, request IDs and logging so every money call is safe to repeat.

const BASES = {
  SANDBOX: "https://api-m.sandbox.paypal.com",
  LIVE: "https://api-m.paypal.com",
} as const;

export class PayPalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issue: string | undefined,
    readonly debugId: string | undefined,
    readonly retryable: boolean,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "PayPalError";
  }
}

export type PayPalResponse<T> = { status: number; data: T; debugId?: string };

type RequestOptions = {
  body?: unknown;
  requestId?: string; // PayPal-Request-Id: same id = same result, never a second refund
  maxAttempts?: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Deterministic PayPal-Request-Id for a refund. It is keyed by EVENT + payment + how much had already been refunded
 * when the plan was built, NOT by plan: if a later plan is built while PayPal's view still lags behind a refund we
 * just made, it gets the same id and PayPal hands back the original refund instead of making a second one.
 * A genuine top-up (more was refunded before) gets a different id and goes through.
 */
export function refundRequestId(eventId: string, captureId: string, alreadyRefundedCents: number): string {
  return `ro-${createHash("sha256").update(`${eventId}:${captureId}:${alreadyRefundedCents}:refund`).digest("hex").slice(0, 40)}`;
}

export class PayPalClient {
  private token: { value: string; expiresAt: number } | null = null;
  readonly base: string;

  constructor(
    private readonly clientId = process.env.PAYPAL_CLIENT_ID ?? "",
    private readonly clientSecret = process.env.PAYPAL_CLIENT_SECRET ?? "",
    env: keyof typeof BASES = (process.env.PAYPAL_ENVIRONMENT as keyof typeof BASES) ?? "SANDBOX",
  ) {
    if (!clientId || !clientSecret) throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set");
    this.base = BASES[env] ?? BASES.SANDBOX;
  }

  /** Cached access token, refreshed 5 minutes before it expires. */
  async accessToken(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.token.expiresAt) return this.token.value;
    const res = await fetch(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !json.access_token) {
      throw new PayPalError(`PayPal auth failed: ${json.error_description ?? res.status}`, res.status, "AUTH", undefined, false, json);
    }
    this.token = { value: json.access_token, expiresAt: Date.now() + ((json.expires_in ?? 3600) - 300) * 1000 };
    return this.token.value;
  }

  /**
   * One HTTP call with safe retries:
   * - 401: refresh the token once
   * - 429 / 5xx / network error: back off with jitter and resend the SAME request id
   */
  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<PayPalResponse<T>> {
    const maxAttempts = opts.maxAttempts ?? 4;
    let refreshedToken = false;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${this.base}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${await this.accessToken()}`,
            "Content-Type": "application/json",
            Prefer: "return=representation",
            ...(opts.requestId ? { "PayPal-Request-Id": opts.requestId } : {}),
          },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });
      } catch (err) {
        if (attempt >= maxAttempts) throw new PayPalError(`Network error: ${(err as Error).message}`, 0, "NETWORK", undefined, true, null);
        await sleep(backoff(attempt));
        continue;
      }
      const debugId = res.headers.get("paypal-debug-id") ?? undefined;
      const text = await res.text();
      const data = text ? safeJson(text) : {};
      if (res.ok) return { status: res.status, data: data as T, debugId };

      if (res.status === 401 && !refreshedToken) {
        refreshedToken = true;
        await this.accessToken(true);
        continue;
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < maxAttempts) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
        continue;
      }
      const body = data as { name?: string; message?: string; details?: { issue?: string; description?: string }[]; debug_id?: string };
      const issue = body?.details?.[0]?.issue ?? body?.name;
      throw new PayPalError(
        `${method} ${path} failed: ${res.status} ${issue ?? ""} ${body?.details?.[0]?.description ?? body?.message ?? ""}`.trim(),
        res.status,
        issue,
        debugId ?? body?.debug_id,
        retryable,
        data,
      );
    }
  }

  // ---------- Payments ----------

  /**
   * Live money state of one payment. PayPal lists refunds on the ORDER, not the capture, so we read both.
   * Pending refunds count as used: PayPal creates one automatically to hold funds when a buyer opens a dispute.
   */
  async getCapture(captureId: string): Promise<CaptureState> {
    const { data } = await this.request<CaptureResource>("GET", `/v2/payments/captures/${encodeURIComponent(captureId)}`);
    const captured = toCents(data.amount?.value) ?? 0;
    const orderId = data.supplementary_data?.related_ids?.order_id;

    let completed = 0;
    let pending = 0;
    if (orderId) {
      const { data: order } = await this.request<OrderResource>("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
      const units = order.purchase_units ?? [];
      const captures = units.flatMap((u) => u.payments?.captures ?? []);
      const refunds = units.flatMap((u) => u.payments?.refunds ?? []);
      for (const r of refunds) {
        const up = r.links?.find((l) => l.rel === "up")?.href;
        const belongsHere = up ? up.includes(captureId) : captures.length === 1;
        if (!belongsHere) continue;
        const cents = toCents(r.amount?.value) ?? 0;
        if (r.status === "COMPLETED") completed += cents;
        else if (r.status === "PENDING") pending += cents;
      }
    }

    return {
      captureId: data.id,
      orderId,
      status: data.status,
      statusReason: data.status_details?.reason,
      currency: data.amount?.currency_code ?? "USD",
      capturedCents: captured,
      refundedCents: completed,
      pendingRefundCents: pending,
      refundableCents: Math.max(0, captured - completed - pending),
      capturedAt: data.create_time,
      raw: data,
    };
  }

  async refundCapture(args: {
    captureId: string;
    amountCents: Cents;
    currency: string;
    requestId: string;
    invoiceId?: string;
    noteToPayer?: string;
  }): Promise<PayPalResponse<RefundResource>> {
    return this.request<RefundResource>("POST", `/v2/payments/captures/${encodeURIComponent(args.captureId)}/refund`, {
      requestId: args.requestId,
      body: {
        amount: { currency_code: args.currency, value: centsToValue(args.amountCents) },
        ...(args.invoiceId ? { invoice_id: args.invoiceId.slice(0, 127) } : {}),
        ...(args.noteToPayer ? { note_to_payer: args.noteToPayer.slice(0, 255) } : {}),
      },
    });
  }

  async getRefund(refundId: string): Promise<RefundResource> {
    const { data } = await this.request<RefundResource>("GET", `/v2/payments/refunds/${encodeURIComponent(refundId)}`);
    return data;
  }

  // ---------- Disputes ----------

  async listOpenDisputes(): Promise<DisputeSummary[]> {
    const all: DisputeSummary[] = [];
    let path: string | null = `/v1/customer/disputes?page_size=50`;
    while (path) {
      const res: PayPalResponse<{ items?: DisputeSummary[]; links?: { rel: string; href: string }[] }> = await this.request("GET", path);
      all.push(...(res.data.items ?? []));
      const next = res.data.links?.find((l) => l.rel === "next")?.href;
      path = next ? next.replace(this.base, "") : null;
    }
    return all.filter((d) => !["RESOLVED", "CLOSED"].includes(d.status));
  }

  async getDispute(disputeId: string): Promise<DisputeDetail> {
    const { data } = await this.request<DisputeDetail>("GET", `/v1/customer/disputes/${encodeURIComponent(disputeId)}`);
    return data;
  }

  /** Offer the policy amount through the dispute instead of refunding directly (avoids paying twice). */
  async makeOffer(args: { disputeId: string; amountCents: Cents; currency: string; note: string; requestId?: string }) {
    return this.request("POST", `/v1/customer/disputes/${encodeURIComponent(args.disputeId)}/make-offer`, {
      requestId: args.requestId ?? randomUUID(),
      body: {
        note: args.note.slice(0, 2000),
        offer_amount: { currency_code: args.currency, value: centsToValue(args.amountCents) },
        offer_type: "REFUND",
      },
    });
  }

  // ---------- Reporting ----------

  async searchTransactions(startIso: string, endIso: string, page = 1) {
    const q = new URLSearchParams({ start_date: startIso, end_date: endIso, fields: "all", page_size: "500", page: String(page) });
    return this.request<{ transaction_details?: unknown[]; total_pages?: number }>("GET", `/v1/reporting/transactions?${q}`);
  }
}

function backoff(attempt: number): number {
  const base = Math.min(8000, 500 * 2 ** (attempt - 1));
  return base / 2 + Math.random() * (base / 2);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// ---------- Types (only the fields we use) ----------

type Money = { currency_code: string; value: string };

export type CaptureResource = {
  id: string;
  status: string; // COMPLETED, PARTIALLY_REFUNDED, REFUNDED, REVERSED, PENDING, DECLINED, FAILED
  status_details?: { reason?: string }; // e.g. BUYER_COMPLAINT while a dispute is open
  amount?: Money;
  create_time?: string;
  supplementary_data?: { related_ids?: { order_id?: string } };
};

type Link = { rel: string; href: string };

export type OrderResource = {
  id: string;
  status: string;
  purchase_units?: {
    payments?: {
      captures?: { id: string; status: string; amount?: Money }[];
      refunds?: { id: string; status: string; amount?: Money; links?: Link[] }[];
    };
  }[];
};

export type CaptureState = {
  captureId: string;
  orderId?: string;
  status: string;
  statusReason?: string;
  currency: string;
  capturedCents: Cents;
  refundedCents: Cents; // completed refunds
  pendingRefundCents: Cents; // e.g. dispute holds
  refundableCents: Cents; // captured - completed - pending
  capturedAt?: string;
  raw: unknown;
};

export type RefundResource = { id: string; status: string; amount?: Money; create_time?: string };

export type DisputeSummary = {
  dispute_id: string;
  reason: string;
  status: string;
  dispute_state?: string;
  dispute_amount?: Money;
  dispute_life_cycle_stage?: string;
};

export type DisputeDetail = DisputeSummary & {
  disputed_transactions?: { seller_transaction_id?: string; buyer_transaction_id?: string }[];
  seller_response_due_date?: string;
};
