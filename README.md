<div align="center">

<img src=".github/readme/logo.svg" width="72" height="72" alt="RefundsOut logo" />

# RefundsOut

**An event got cancelled. Leave the refund headache to us.**

RefundsOut works out what every ticket buyer is owed from the event's own ticket terms, shows every refund
for approval before any money moves, and then sends each refund through PayPal exactly once.

![Next.js 16](https://img.shields.io/badge/Next.js-16-111?logo=nextdotjs&logoColor=white)
![PayPal REST APIs](https://img.shields.io/badge/PayPal-REST%20APIs%20(Sandbox)-003087?logo=paypal&logoColor=white)
![Google Gemini](https://img.shields.io/badge/Google-Gemini-4285F4?logo=googlegemini&logoColor=white)
![AG Grid Enterprise](https://img.shields.io/badge/AG%20Grid-Enterprise-0B6E55)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-queue%20%2B%20ledger-336791?logo=postgresql&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)

<br />

<img src=".github/readme/home.png" alt="RefundsOut home page: An event got cancelled. Leave the refund headache to us. Start a refund run, how it works, and built with PayPal, Gemini and AG Grid" width="900" />

</div>

## Table of contents

1. [The problem](#the-problem)
2. [What it does](#what-it-does)
3. [Screenshots](#screenshots)
4. [Built to never pay twice](#built-to-never-pay-twice)
5. [How AI is used](#how-ai-is-used-and-where-it-is-not)
6. [PayPal APIs used](#paypal-apis-used)
7. [How RefundsOut uses AG Grid](#how-refundsout-uses-ag-grid)
8. [Architecture](#architecture)
9. [Getting started](#getting-started)
10. [Troubleshooting](#troubleshooting)

## The problem

When one day of a multi-day festival is cancelled, the organiser owes thousands of buyers **different** amounts.
A Saturday-only ticket gets everything back. A weekend pass holder who came on Friday gets part of it back.
A VIP package has a non-refundable hospitality fee. Some buyers paid cash, some got free tickets, some were already refunded.

Today this is done by hand in a spreadsheet. Buyers wait weeks, and the mistakes are always the same:
the wrong amount, a buyer refunded twice, or a refund sent for a payment that changed since someone last looked.

## What it does

| Step | What happens |
|---|---|
| **1. Import** | Upload ticket sales, gate scans and ticket terms in any layout. Gemini maps the columns. Bad rows (no email, price `N/A`, duplicate ticket IDs) are set aside with a reason, never silently dropped. |
| **2. Policy** | Gemini turns the terms into numbered rules (`R1`, `R2`…) and deductions, each quoting its clause word for word. The rules run against test cases. A person approves the policy only when every test passes. |
| **3. Review** | Every refund appears in **AG Grid** before anything is sent: grouped by rule with totals, risky cases pinned on top for a decision, a chart, the compiled policy in a side panel, per-ticket math, and "Ask the grid" in plain English. |
| **4. Run** | **Run refunds** unlocks only when five checks pass. Refunds then go out through PayPal a few at a time, each re-checked first and each with a fixed request ID. |
| **5. Reconcile** | Every cent is accounted for, every refund is confirmed with PayPal, duplicates are counted (zero), and each buyer gets a letter with their exact amount. |

**Try it in two minutes:** open the app → **Try with sample festival data** → follow the left sidebar from
Import to Reconcile. The sample creates its own 50 fresh sandbox payments, so the run sends real sandbox refunds.

## Screenshots

<table>
<tr>
<td width="50%"><img src=".github/readme/import.png" alt="Import: files loaded, ticket types found, and four bad rows set aside with reasons" /></td>
<td width="50%"><img src=".github/readme/policy.png" alt="Policy: ticket terms with highlighted clauses, compiled rules R1 to R4, and 7 of 7 tests passing" /></td>
</tr>
<tr>
<td><b>Import.</b> Ticket types found, and bad rows set aside with a reason.</td>
<td><b>Policy.</b> Rules compiled from the terms, each with its clause, and the tests they pass.</td>
</tr>
<tr>
<td colspan="2"><img src=".github/readme/review.png" alt="Review: total to refund, the five checks that lock Run refunds, Ask the grid and the refund chart" /></td>
</tr>
<tr>
<td colspan="2"><b>Review.</b> The total, the five checks that lock <b>Run refunds</b>, and the AG Grid review below.</td>
</tr>
</table>

## Built to never pay twice

- **Five checks lock the Run button:** policy approved and tested, every payment re-checked with PayPal in the last hour, no open exceptions, total within budget, and sign-off. Runs over the approval limit ($2,500 by default) need **two different people**.
- **Any edit cancels the approval.** Approvals are tied to a hash of the exact plan.
- **Each payment is re-checked right before money moves.** A payment that was charged back, disputed or refunded elsewhere since approval is skipped, not paid.
- **A fixed `PayPal-Request-Id` per refund.** Retries, crashes and restarts resend the same ID, so PayPal returns the original refund instead of creating a second one.
- **Its own ledger of refunds.** PayPal's view can lag, so RefundsOut also counts what it already sent in earlier plans for the same event.
- **A crash-safe queue.** Refunds are claimed from Postgres with `FOR UPDATE SKIP LOCKED`, and half-finished work goes back in the queue when the server starts.
- **Open disputes get an offer, not a refund.** A disputed payment is paid through the dispute with a seller offer.
- **Everything is in the audit log:** who imported, who approved, every skip and every refund. The database blocks edits and deletes.

Tested against the real sandbox: a server crash in the middle of a run left **47 of 47** payments refunded exactly once, and the "PayPal lags behind" test left **48 of 48** refunded exactly once.

## How AI is used (and where it is not)

| Gemini does | Code does |
|---|---|
| Maps unfamiliar CSV columns and ticket codes | Validates every row and sets aside bad ones |
| Compiles ticket terms into rules with clause quotes | Checks every quote, runs the rules against tests; a person approves the version |
| Answers "Ask the grid" (*refunds over $100, biggest first*) through the AG Grid AI Toolkit | Cleans the answer, applies it as grid state (view only) and shows what changed as chips |
| Writes the wording of each buyer letter | Fills in every amount, date and PayPal ID, and rejects wording that leaves out the amount |

**No money amount is ever written by AI.** Amounts come from the rules engine, which uses integer cents.
If Gemini is busy, the importer, compiler and letters fall back to safe defaults, and Ask the grid says so instead of hanging.

## PayPal APIs used

| API | Used for |
|---|---|
| `GET /v2/payments/captures/{id}` | Re-checking each payment's refundable amount and status |
| `POST /v2/payments/captures/{id}/refund` | Sending each refund, with `PayPal-Request-Id` |
| `GET /v2/payments/refunds/{id}` | Confirming refunds during the run and in Reconcile |
| `GET /v2/checkout/orders/{id}` | Reading every refund already made on a payment, including pending ones from disputes |
| `GET /v1/customer/disputes/{id}` and `POST …/make-offer` | Paying disputed payments through the dispute |
| `GET /v1/reporting/transactions` | Transaction Search cross-check for the finance file |

All calls run against the **PayPal sandbox**.

## How RefundsOut uses AG Grid

In RefundsOut the grid is **the approval gate**, not a report at the end. No refund is sent until someone has reviewed the whole
plan in AG Grid and all five checks pass. The same grid then shows the run live and holds the audit trail.

<table>
<tr>
<td width="50%"><img src=".github/readme/review-ask-the-grid.png" alt="Ask the grid: the AI answer applied as a filter and sort, shown as chips, with an integrated cross-filter chart of refund dollars by rule" /></td>
<td width="50%"><img src=".github/readme/review-policy-rules.png" alt="Custom Policy rules tool panel filtering the grid to rule R3, with expanded payments showing per-ticket refund math" /></td>
</tr>
<tr>
<td><b>Ask the grid.</b> A plain-English question becomes real grid state, and the chips show exactly what the AI changed.</td>
<td><b>Policy rules panel.</b> A custom tool panel lists each rule with its clause, payment count and dollars. Clicking a rule filters the grid. Expanding a payment shows the per-ticket math.</td>
</tr>
</table>

| Screen | AG Grid Enterprise feature | What it does for the person approving refunds |
|---|---|---|
| Review | **AI Toolkit**: `getStructuredSchema()` → Gemini → `setState()` | "Ask the grid" in plain English. The answer is applied as grid state and listed as chips (**Filter** Refund > $100 · **Sort** Refund ↓). |
| Review | Row grouping, `sum` aggregation, grand total row | Refund dollars per rule and the plan total, always in sync with the rows |
| Review | **Integrated Charts**: cross-filter donut with a custom chart theme | Refund dollars by rule. Clicking a slice filters the grid. |
| Review | **Custom tool panel** (React) next to the built-in Columns and Filters panels | The compiled policy, rule by rule. Clicking a rule filters to its payments. |
| Review | **Master-detail** with a custom detail renderer | Expand a payment to see each ticket, the days scanned, the rule, the formula and the amount |
| Review | Pinned top rows + custom cell renderers | Payments that need a human decision stay on top with inline Refund / Skip buttons |
| Review | Cell editing with `valueParser` | Changing a refund needs a reason. The edit is audited and cancels any approval. |
| Review | Cell selection + **status bar** aggregation | Drag over refund cells to see their sum, average and count |
| Review | **Excel export** with `excelStyles`, `prependContent`, group outlines | An audit-ready workbook: a summary block (total vs budget, each check ✓/✗, approvals), currency formats and audit columns |
| Run | Live row updates with `getRowId` + cell change flash | Each payment's status changes in place as refunds go out |
| Audit log | Row group panel, set filters, quick filter, master-detail | Drag Stage, Who or What to group. Expand any entry to see its full record. |
| All | `themeQuartz.withParams` | One theme in the product's colours across every grid |

**Ask the grid is safe around money.** The AI only changes the **view** (filters, sort, grouping, visible columns), never an amount.
Answers are cleaned before they're applied, **Reset** always returns to the rule grouping, and if Gemini is busy the example
questions use a stored answer and say so.

Code: [`src/ui/grid.ts`](src/ui/grid.ts) (setup, theme, chart theme, status bar, Excel styles) ·
[`ReviewClient.tsx`](app/events/%5Bid%5D/review/ReviewClient.tsx) (Review grid, Ask the grid) ·
[`RulesToolPanel.tsx`](app/events/%5Bid%5D/review/RulesToolPanel.tsx) (custom tool panel) ·
[`RunClient.tsx`](app/events/%5Bid%5D/run/RunClient.tsx) (live run) ·
[`AuditGrid.tsx`](app/events/%5Bid%5D/audit/AuditGrid.tsx) (audit log)

## Architecture

<img src=".github/readme/architecture.png" alt="RefundsOut architecture: organiser uploads flow through Import, Policy, Review, Run and Reconcile; Gemini, AG Grid, PayPal REST APIs and PostgreSQL are marked on each stage, with the PayPal endpoints and Postgres tables listed below" width="100%" />

**Stack:** Next.js 16 (App Router, Server Actions) · React 19 · TypeScript · Tailwind CSS 4 · PostgreSQL (`pg`) · Zod ·
Google Gen AI SDK · AG Grid Enterprise 36 + AG Charts Enterprise 14 · Vitest.

## Getting started

### 1. What you need

| | Where to get it |
|---|---|
| **Node.js 22+** | [nodejs.org](https://nodejs.org) |
| **PostgreSQL 13+** | Local install, Docker, or a free hosted database such as [Neon](https://neon.tech) |
| **PayPal sandbox app** | [developer.paypal.com](https://developer.paypal.com) → Apps & Credentials → switch to **Sandbox** → create an app → copy the client ID and secret |
| **Gemini API key** | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| **AG Grid Enterprise key** *(optional)* | [AG Grid trial](https://www.ag-grid.com/license-pricing/). Without a key everything still works; the grid shows a trial watermark. |

### 2. Install

```bash
git clone https://github.com/singhrahul7988/RefundsOut.git
cd RefundsOut
npm install
```

### 3. Create a database

```bash
createdb refundsout          # or create it in your hosted Postgres dashboard
```

### 4. Fill in `.env`

```bash
cp .env.example .env
```

| Variable | Required | What it is |
|---|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Yes | Your sandbox app's credentials |
| `PAYPAL_ENVIRONMENT` | Yes | Leave as `SANDBOX` |
| `GEMINI_API_KEY` | Yes | Your Gemini key |
| `DATABASE_URL` | Yes | e.g. `postgres://user:password@localhost:5432/refundsout` |
| `TEST_CARD_NUMBER`, `TEST_CARD_EXPIRY` | Yes (prefilled) | PayPal's sandbox test card, used to create the sample payments. If it's declined, generate another with PayPal's [card generator](https://developer.paypal.com/tools/sandbox/card-testing/). |
| `AG_GRID_LICENSE_KEY` | No | Removes the AG Grid trial watermark |
| `RUN_CONCURRENCY` | No | Refunds sent at a time (default `4`) |
| `GEMINI_FAST_MODELS`, `GEMINI_ACCURATE_MODELS` | No | Comma-separated Gemini models to try, in order |

### 5. Set up the database and check PayPal

```bash
npm run db:migrate           # creates the tables (safe to run again)
npm run check:sandbox        # makes a test payment, refunds it twice with one request ID, reads disputes and Transaction Search
```

### 6. Run it

```bash
npm run dev                  # http://localhost:3000
```

On the home page, click **Try with sample festival data**. It creates 50 fresh sandbox payments for the
Riverside Sound Festival (about 15 seconds), then walk through **Import → Policy → Review → Run → Reconcile**
in the left sidebar. Switch between the two demo users (operator and approver) at the bottom-left to give the
second approval.

### Deploying (Render)

A single web service plus Postgres. Build command: `npm install && npx tsx scripts/migrate.ts && npm run build`.
Start command: `npm start`. Health check path: `/api/health`. Set the same environment variables as `.env`.
The refund runner is a background loop in the server process, so use an always-on service rather than serverless functions.

### Second test festival

[`test-files/`](test-files/) holds a second festival, **Lakeshore Lights Festival 2026** (Sunday cancelled), with its own column names,
US dates, a parking add-on and deliberate edge cases. Every PayPal ID in it is a real sandbox payment. Expected results are in
[`test-files/README.md`](test-files/README.md). A sandbox payment can only be refunded once, so after a full run create a fresh set:

```bash
npx tsx --env-file=.env scripts/seed-test-files.ts --force
```

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the app on port 3000 |
| `npm run build` / `npm start` | Production build and server |
| `npm run db:migrate` | Apply `db/schema.sql` |
| `npm run check:sandbox` | Check the PayPal sandbox credentials end to end |
| `npm test` | Unit tests (money, rules engine, date parsing) |
| `npm run typecheck` | TypeScript check |

## Troubleshooting

| You see | Do this |
|---|---|
| **Run refunds** stays locked | Open the checks above the grid. Usually: decide the set-aside rows on Import and the pinned rows on Review, press **Re-check with PayPal** (it must be within the last hour), and get the second approval. |
| "Gemini is busy right now" | Gemini is overloaded. Wait a moment and try again. The example questions in Ask the grid still work from stored answers. |
| Most rows say "Already refunded" | Those sandbox payments were refunded in an earlier run. Start a new run with **Try with sample festival data**. |
| `check:sandbox` card is declined | Generate a new test card at PayPal's [card generator](https://developer.paypal.com/tools/sandbox/card-testing/) and update `TEST_CARD_*` in `.env`. |
| AG Grid watermark | Add `AG_GRID_LICENSE_KEY` to `.env`, or ignore it: every feature still works. |

## Project layout

```
app/                 Pages: home, import, policy, review, run, reconcile, audit log
src/ai/              Gemini: column mapping, policy compile, letters, "Ask the grid"
src/import/          CSV parsing and row checks
src/policy/          Policy schema, rules engine, tests
src/plan/            Plan builder and the five Review checks
src/run/             Refund runner (Postgres queue, retries, crash resume)
src/paypal/          PayPal REST client
src/sample/          Fresh sandbox payments for the sample festival
src/ui/              Shared UI and AG Grid setup
db/schema.sql        Database schema
scripts/             Migrations, sandbox checks, test data seeding
test-files/          Lakeshore demo files
```

## Built for

The **PayPal AI Hackathon 2026**. Sandbox only: no real money moves.

## License

[MIT](LICENSE) © 2026 Rahul Singh
