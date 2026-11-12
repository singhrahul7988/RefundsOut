// Checks that the PayPal sandbox app can do everything RefundsOut needs:
//   1. get an access token (and see which features the app has)
//   2. create + capture a paid order (the "ticket purchase")
//   3. partially refund it, then retry with the same request id (idempotency)
//   4. read disputes
//   5. read Transaction Search
//
// Run:   node --env-file=.env scripts/check-sandbox.mjs
// If the card path is declined, the script prints a PayPal approve link instead.
// Approve it as your sandbox BUYER, then run:
//        node --env-file=.env scripts/check-sandbox.mjs capture <ORDER_ID>

import { randomUUID } from 'node:crypto';

const BASE = 'https://api-m.sandbox.paypal.com';
const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET } = process.env;
const CARD = process.env.TEST_CARD_NUMBER || '4111111111111111';
const EXPIRY = process.env.TEST_CARD_EXPIRY || '2030-12';

const results = [];
const record = (step, ok, detail = '') => {
  results.push({ step, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${step}${detail ? ' (' + detail + ')' : ''}`);
};

if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.error('Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET. Copy .env.example to .env and fill them in.');
  process.exit(1);
}

let token;
async function api(method, path, body, extraHeaders = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, json };
}

const why = (r) => `HTTP ${r.status} ${r.json?.name || ''} ${r.json?.details?.[0]?.issue || r.json?.message || ''} debug_id=${r.json?.debug_id || '-'}`.trim();

async function getToken() {
  const res = await fetch(BASE + '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    record('Access token', false, `HTTP ${res.status} ${json.error_description || json.error || ''}. Check the client ID/secret and that you copied SANDBOX keys`);
    process.exit(1);
  }
  token = json.access_token;
  record('Access token', true, `expires in ${Math.round(json.expires_in / 3600)}h`);

  // Feature scopes granted to this app. Missing ones are toggled in the app's settings on the dashboard.
  const scope = json.scope || '';
  const features = {
    'Refunds': 'payments/refund',
    'Disputes': 'services/disputes',
    'Transaction Search': 'reporting/search/read',
    'Invoicing': 'services/invoicing',
    'Payouts': 'payments/payouts',
  };
  for (const [name, needle] of Object.entries(features)) {
    console.log(`   ${scope.includes(needle) ? '•' : '⚠️'} scope ${name}: ${scope.includes(needle) ? 'granted' : 'NOT granted. Enable it in the app settings'}`);
  }
}

async function createCardOrder() {
  const r = await api('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: 'TICKET-CHECK-0001',
      custom_id: 'TICKET-CHECK-0001',
      description: 'RefundsOut sandbox check: 3-day festival pass',
      amount: { currency_code: 'USD', value: '120.00' },
    }],
    payment_source: {
      card: { number: CARD, expiry: EXPIRY, name: 'Sandbox Buyer', security_code: '123' },
    },
  }, { 'PayPal-Request-Id': randomUUID() });

  if (!r.ok) return { failed: r };
  let order = r.json;
  if (order.status !== 'COMPLETED') {
    const c = await api('POST', `/v2/checkout/orders/${order.id}/capture`, {}, { 'PayPal-Request-Id': randomUUID() });
    if (!c.ok) return { failed: c };
    order = c.json;
  }
  return { order };
}

async function createWalletOrderForManualApproval() {
  const r = await api('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{ reference_id: 'TICKET-CHECK-0001', custom_id: 'TICKET-CHECK-0001', amount: { currency_code: 'USD', value: '120.00' } }],
    payment_source: { paypal: { experience_context: { return_url: 'https://example.com/return', cancel_url: 'https://example.com/cancel', user_action: 'PAY_NOW' } } },
  }, { 'PayPal-Request-Id': randomUUID() });
  if (!r.ok) { record('Create order (PayPal wallet)', false, why(r)); return; }
  const link = r.json.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
  record('Create order (PayPal wallet)', true, `order ${r.json.id}`);
  console.log(`\n👉 Open this link, log in as your SANDBOX BUYER (personal) account and approve:\n   ${link}\n   Then run: node --env-file=.env scripts/check-sandbox.mjs capture ${r.json.id}\n`);
}

async function refundAndIdempotency(order) {
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  if (!capture) { record('Find capture on order', false, 'no capture in response'); return; }
  record('Paid order captured', capture.status === 'COMPLETED', `capture ${capture.id}, status ${capture.status}`);

  // Partial refund (one-third of a 3-day pass), sent twice with the SAME request id.
  const requestId = randomUUID();
  const body = { amount: { currency_code: 'USD', value: '40.00' }, note_to_payer: 'RefundsOut check: partial refund', invoice_id: `REFUND-CHECK-${Date.now()}` };
  const first = await api('POST', `/v2/payments/captures/${capture.id}/refund`, body, { 'PayPal-Request-Id': requestId });
  if (!first.ok) { record('Partial refund $40', false, why(first)); return; }
  record('Partial refund $40', true, `refund ${first.json.id}, status ${first.json.status}`);

  const retry = await api('POST', `/v2/payments/captures/${capture.id}/refund`, body, { 'PayPal-Request-Id': requestId });
  const same = retry.ok && retry.json.id === first.json.id;
  record('Retry with same request id returns SAME refund (no double refund)', same, retry.ok ? `refund ${retry.json.id}` : why(retry));
}

async function checkDisputes() {
  const r = await api('GET', '/v1/customer/disputes?page_size=5');
  record('Read disputes', r.ok, r.ok ? `${r.json.items?.length || 0} dispute(s) visible` : why(r));
}

async function checkTransactionSearch() {
  const fmt = (d) => d.toISOString().replace(/\.\d{3}Z$/, '-0000');
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 24 * 3600 * 1000);
  const r = await api('GET', `/v1/reporting/transactions?start_date=${encodeURIComponent(fmt(start))}&end_date=${encodeURIComponent(fmt(end))}&fields=all&page_size=5`);
  record('Transaction Search', r.ok, r.ok ? `${r.json.total_items ?? 0} transaction(s) in last 30 days (new ones can take up to ~3h to appear)` : why(r));
}

async function main() {
  const [mode, orderId] = process.argv.slice(2);
  await getToken();

  if (mode === 'capture' && orderId) {
    const c = await api('POST', `/v2/checkout/orders/${orderId}/capture`, {}, { 'PayPal-Request-Id': randomUUID() });
    if (!c.ok) record('Capture approved order', false, why(c));
    else await refundAndIdempotency(c.json);
  } else {
    const { order, failed } = await createCardOrder();
    if (order) {
      record('Create paid order with sandbox card', true, `order ${order.id}`);
      await refundAndIdempotency(order);
    } else {
      record('Create paid order with sandbox card', false, `${why(failed)}. Falling back to manual approval`);
      await createWalletOrderForManualApproval();
    }
  }

  await checkDisputes();
  await checkTransactionSearch();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length ? `⚠️  ${failed.length} check(s) failed. See the messages above.` : '🎉 All checks passed. The sandbox is ready for RefundsOut.'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
