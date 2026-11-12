<div align="center">

<img src=".github/readme/logo.svg" width="72" height="72" alt="RefundsOut logo" />

# RefundsOut

**A day was cancelled. Refund everyone exactly right, once.**

RefundsOut turns a festival's ticket terms into tested refund rules, shows every buyer's refund in a grid
before any money moves, and sends each refund through PayPal exactly once.

![Next.js 16](https://img.shields.io/badge/Next.js-16-111?logo=nextdotjs&logoColor=white)
![PayPal REST APIs](https://img.shields.io/badge/PayPal-REST%20APIs%20(Sandbox)-003087?logo=paypal&logoColor=white)
![Google Gemini](https://img.shields.io/badge/Google-Gemini-4285F4?logo=googlegemini&logoColor=white)
![AG Grid Enterprise](https://img.shields.io/badge/AG%20Grid-Enterprise-0B6E55)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-queue%20%2B%20ledger-336791?logo=postgresql&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)

<br />

<img src=".github/readme/home.png" alt="RefundsOut home page: start a refund run and how it works" width="900" />

</div>

---

## The problem

When one day of a multi-day festival is cancelled, the organiser owes thousands of buyers **different** amounts.
A Sunday-only ticket gets everything back. A weekend pass holder who came on Friday gets part of it back.
A VIP package has a non-refundable hospitality fee. Some buyers paid cash, some got free tickets, some were already refunded.

Today this is done by hand in a spreadsheet, and the expensive mistakes are always the same:
the wrong amount, a buyer refunded twice, or a refund sent for a payment that changed since someone last looked.

## What RefundsOut does

| Step | What happens |
|---|---|
| **1. Import** | Upload ticket sales, gate scans and ticket terms in any layout. Gemini maps the columns. Bad rows (no email, price `N/A`, duplicate ticket IDs) are set aside with a reason, never silently dropped. |
| **2. Policy** | Gemini compiles the terms into numbered rules (`R1`, `R2`…) and deductions (`D1`…), each quoting its clause. The rules run against test cases. A person approves a policy version only when every test passes. |
| **3. Review** | Every refund appears in an **AG Grid** before anything is sent: grouped by rule, with totals, pinned exceptions that need a decision, and a "Why this amount" panel for each buyer. |
| **4. Run** | Five checks must pass before **Run refunds** unlocks. Refunds then go out through PayPal, a few at a time, each with a fixed request ID. |
| **5. Reconcile** | Every cent of the plan is accounted for, every refund is confirmed with PayPal, duplicates are counted (should be 0), and each buyer gets a letter with their exact amount. |

## Built to never pay twice

RefundsOut is careful in the places where refund tools usually go wrong:

- **Five checks lock the Run button.** Policy approved and tested, every payment re-checked with PayPal within the last hour, no open exceptions, total within budget, and sign-off. Runs over the approval limit ($2,500 by default) need **two different people**.
- **Any edit cancels the approval.** Approvals are tied to a hash of the exact plan.
- **Each payment is re-checked right before money moves.** A payment that was charged back, disputed or refunded elsewhere since approval is skipped, not paid.
- **Fixed `PayPal-Request-Id` per refund.** Retries, crashes and restarts resend the same ID, so PayPal returns the original refund instead of creating a second one.
- **A ledger of its own refunds.** PayPal's view can lag. RefundsOut also counts what it already sent in earlier plans for the same event.
- **Crash-safe queue.** Refunds are claimed from Postgres with `FOR UPDATE SKIP LOCKED`. Half-finished work is put back in the queue when the server starts.
- **Open disputes get an offer, not a refund.** A payment under dispute is paid through the PayPal dispute with a seller offer.
- **Everything is in the audit log:** who imported, who approved, every skip and every refund.

## How AI is used (and where it is not)

| Gemini does | Code does |
|---|---|
| Maps unfamiliar CSV columns and ticket codes | Validates every row and sets aside bad ones |
| Compiles ticket terms into rules with clause quotes | Runs the rules against tests; a person approves the version |
| Answers "Ask the grid" (e.g. *only refunds over $100, biggest first*) with the AG Grid AI Toolkit | Applies the result as a normal grid filter and sort |
| Writes the wording of each buyer letter | Fills in every amount, date and PayPal ID, and rejects any wording that leaves out the amount |

**No money amount is ever written by AI.** Amounts come from the rules engine, which uses integer cents.

## PayPal APIs used

| API | Used for |
|---|---|
| `GET /v2/payments/captures/{id}` | Re-checking each payment's refundable amount and status |
| `POST /v2/payments/captures/{id}/refund` | Sending each refund, with `PayPal-Request-Id` |
| `GET /v2/payments/refunds/{id}` | Confirming refunds during the run and in Reconcile |
| `GET /v1/customer/disputes/{id}` and `POST …/make-offer` | Paying disputed payments through the dispute |
| `GET /v1/reporting/transactions` | Transaction Search cross-check for the finance file |
| `GET /v2/checkout/orders/{id}` | Reading every refund already made on a payment, including pending ones from disputes |

All calls run against the **PayPal sandbox**.

## AG Grid Enterprise features used

Row grouping with aggregation and a grand total row · pinned top rows for exceptions · editable refund cells (with a required reason) ·
cell change flash · cell selection · Excel export · **AI Toolkit** structured state for "Ask the grid" · a live-updating run grid.

## Architecture

```mermaid
flowchart LR
  A[Sales, scans, terms] -->|Gemini column mapping| B[Import]
  B --> C[Policy<br/>Gemini compile + tests]
  C --> D[Plan builder<br/>rules engine, integer cents]
  P[(PayPal sandbox)] -->|re-check captures| D
  D --> E[Review<br/>AG Grid + 5 checks]
  E -->|approved plan hash| F[Runner<br/>Postgres queue]
  F -->|refund / dispute offer<br/>fixed request ID| P
  F --> G[Reconcile<br/>ledger, letters, CSV]
  P -->|refund status, Transaction Search| G
```

**Stack:** Next.js 16 (App Router, Server Actions) · React 19 · TypeScript · Tailwind CSS 4 · PostgreSQL (`pg`) · Zod · Google Gen AI SDK · AG Grid Enterprise 36 · Vitest.

## Run it locally

**Needs:** Node.js 22+, PostgreSQL, a PayPal developer account (sandbox app), a Gemini API key and an AG Grid Enterprise license key.

```bash
git clone https://github.com/singhrahul7988/RefundsOut.git
cd RefundsOut
npm install

cp .env.example .env        # fill in PayPal sandbox, Gemini, AG Grid and DATABASE_URL
npm run db:migrate          # creates the tables (safe to run again)
npm run check:sandbox       # confirms the PayPal sandbox app works
npm run dev                 # http://localhost:3000
```

On the home page, click **Try with sample festival data** for a one-click demo.

### Test files with real sandbox payments

[`test-files/`](test-files/) holds a second festival, **Lakeshore Lights Festival 2026** (Sunday cancelled), with its own column names,
US dates, a parking add-on and deliberate edge cases. Every PayPal ID in it is a real sandbox payment, so the run really refunds them.
Expected results are in [`test-files/README.md`](test-files/README.md).

A sandbox payment can only be refunded once. After a full run, create a fresh set:

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

## Project layout

```
app/                 Pages: home, import, policy, review, run, reconcile, audit log
src/ai/              Gemini: column mapping, policy compile, letters, "Ask the grid"
src/import/          CSV parsing and row checks
src/policy/          Policy schema, rules engine, tests
src/plan/            Plan builder and the five Review checks
src/run/             Refund runner (Postgres queue, retries, crash resume)
src/paypal/          PayPal REST client
db/schema.sql        Database schema
scripts/             Migrations, sandbox checks, test data seeding
test-files/          Lakeshore demo files
```

## Built for

The **PayPal AI Hackathon 2026**. Sandbox only: no real money moves.

## License

[MIT](LICENSE) © 2026 Rahul Singh
