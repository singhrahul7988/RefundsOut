# Test files: Lakeshore Lights Festival 2026

Upload these through the Import page to show RefundsOut working on files it has never seen.
They differ from the built-in Riverside sample on purpose: other column names and order, `$` prices,
US-style dates (`10/16/2026 18:05`), platform product codes (`WKND-GA`), a parking add-on, and a
scans file with its own headers.

**Scenario:** Fri Oct 16 to Sun Oct 18, 2026. **Sunday was cancelled** (gale warning).

| File | Upload to | What's inside |
|---|---|---|
| `lakeshore_sales_export.csv` | Ticket sales | 75 rows: 70 tickets paid through 57 real sandbox PayPal payments, plus 5 edge-case rows |
| `lakeshore_gate_scans.csv` | Gate scans | 50 scans for Fri and Sat; 2 are staff wristbands that match no ticket |
| `lakeshore_ticket_terms.txt` | Ticket terms | Section 12 refund terms, 9 clauses |
| `lakeshore_cancellation_notice.txt` | Cancellation notice → **Upload** (or paste) | The Sunday cancellation announcement |
| `seed-manifest.json` | (not uploaded) | Which sandbox payments were created, for debugging |

## Demo steps

1. Home: **Event name** `Lakeshore Lights Festival 2026`, **Cancelled day** `Sunday`, keep the **$6,000** budget, then **Create run**.
2. Import: upload the sales file. Gemini maps the 10 columns and names the 4 ticket types. Click **Confirm and import**.
3. Upload the scans file and the terms file. On the Cancellation notice card, click **Upload**, pick the notice file, check the text, then click **Save notice**.
4. Exclude the set-aside rows with a reason, then continue to **Next: compile the policy**.

The files can go in any order. Confirming the sales mapping re-matches any scans already uploaded.

## What you should see

- **Column mapping:** Booking # → Order reference, Txn Date → Purchase time, Attendee → Buyer name,
  Email Address → Buyer email, Ticket Type → Ticket type, Barcode → Ticket ID, Paid → Price paid,
  Channel → Not used, PayPal Transaction ID → PayPal payment ID, Resold To → Transferred to (Gemini flags this one "Please check").
- **Ticket types:** SUN-DAY → Sunday Day Pass, WKND-GA → Weekend General Admission, WKND-VIP → Weekend VIP, PARK-WKND → Weekend Parking (add-on).
- **Ticket sales:** 71 rows ready, 4 set aside:
  - Bad email: `LLF-ERR1` has no email.
  - Not a number: `LLF-ERR2` price is `N/A`.
  - Duplicate ID ×2: `LLF-ERR3` reuses barcode `LK004100`, so both rows with that ID are held.
- **Gate scans:** 48 matched, 2 ignored.
- **Ticket terms:** 9 clauses, notice added.
- **Review:** about **$5,399** to refund, inside the $6,000 budget. That is over the $2,500 approval threshold,
  so the run needs **two approvals**: approve as the operator, switch user, then approve as the approver.

## Edge cases the policy and run steps should handle

- `WKND-VIP` includes a non-refundable $90 hospitality package (clause 12.4).
- Weekend pass holders who never came on Fri or Sat may get a full refund (12.3). 4 GA and 2 VIP buyers have no scans.
- Two Sunday buyers bought two tickets each, and 11 weekend passes came with a parking add-on.
- One ticket was resold to `sam.rivera@example.com`; the refund goes to the original buyer (12.6).
- `LLF-COMP1` is a $0 artist guest pass (no refund) and `LLF-GATE1` was paid in cash (no PayPal ID).
- One Sunday ticket (Keiko Sato) was already fully refunded in PayPal, so the double-refund guard should catch it.

## Regenerating

Every PayPal ID is a real sandbox capture, and a capture can only be refunded once. After a full Run, make a fresh set:

```
npx tsx --env-file=.env scripts/seed-test-files.ts --force
```
