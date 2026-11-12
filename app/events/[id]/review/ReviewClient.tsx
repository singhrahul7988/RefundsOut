"use client";

import { useCallback, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AgGridReact } from "ag-grid-react";
import type { CellValueChangedEvent, ColDef, GetRowIdParams, GridApi, ICellRendererParams, RowClassParams } from "ag-grid-community";
import { setupGrid, gridTheme, money } from "@/ui/grid";
import { TopBar, PageHeader, btn, Card, Chip, CheckRow, SegmentMeter, IconTile } from "@/ui/kit";
import { IconLock, IconSparkle, IconRun, IconCheckCircle } from "@/ui/icons";
import { field } from "@/ui/form";
import type { Gate } from "@/plan/review";
import type { PlanLine } from "@/plan/build";
import type { DemoUser } from "@/server/user";
import { approvePlanAction, askGridAction, overrideAmountAction, resolveExceptionAction, startRunAction } from "../../../actions";
import { BuildPlanButton } from "./BuildPlanButton";

export type ReviewRow = {
  id: string; group: string; buyer: string; email: string; tickets: string; captureId: string;
  paid: number; refunded: number; refund: number; policyAmount: number; overridden: boolean; overrideReason: string | null;
  route: "refund" | "dispute_offer" | "skip" | "exception"; exceptionType: string | null; flags: string[]; reason: string;
  resolution: string | null; disputeId: string | null; lines: PlanLine[];
};

const EXCEPTION_LABEL: Record<string, string> = {
  possible_duplicate: "Possible duplicate", not_paypal: "Not paid with PayPal", no_rule: "No rule matches", too_old: "Older than 180 days",
  paypal_not_found: "PayPal can't find it", already_refunded: "Already refunded", offer_pending: "Offer already sent", free_ticket: "Free ticket", chargeback: "Charged back", nothing_due: "Nothing due",
};

type Dialog =
  | { kind: "override"; row: ReviewRow; newValue: number }
  | { kind: "resolve"; row: ReviewRow; decision: "refund" | "skip" };

export function ReviewClient(props: {
  eventId: string; eventName: string; planId: string; planStatus: string; totalCents: number; budgetCents: number; thresholdCents: number;
  gates: Gate[]; approvals: { role: string; userName: string }[]; rows: ReviewRow[]; ruleInfo: Record<string, { title: string; clause: string; quote: string }>;
  setAsideCount: number; user: DemoUser; licenseKey?: string; cancelledDay: string;
}) {
  setupGrid(props.licenseKey);
  const router = useRouter();
  const gridRef = useRef<AgGridReact<ReviewRow>>(null);
  const [selected, setSelected] = useState<ReviewRow | null>(() => props.rows.find((r) => r.route === "refund" && r.lines.length === 1) ?? null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState("");
  const [askState, setAskState] = useState<"idle" | "busy" | "done">("idle");
  const [pending, start] = useTransition();

  const locked = !["draft", "approved"].includes(props.planStatus);
  const finished = ["done", "stopped"].includes(props.planStatus);
  const inFlight = ["running", "paused"].includes(props.planStatus);
  const pinned = props.rows.filter((r) => r.route === "exception");
  const grouped = props.rows.filter((r) => r.route !== "exception");
  const passing = props.gates.filter((g) => g.passed).length;
  const allPass = passing === props.gates.length;

  const counts = useMemo(() => {
    const refunds = props.rows.filter((r) => r.route === "refund");
    const offers = props.rows.filter((r) => r.route === "dispute_offer");
    const skipped = props.rows.filter((r) => r.route === "skip");
    return {
      payments: refunds.length + offers.length,
      tickets: props.rows.reduce((s, r) => s + r.lines.length, 0),
      offers: offers.length,
      offerTotal: offers.reduce((s, r) => s + r.refund, 0),
      skipped,
    };
  }, [props.rows]);

  const columnDefs = useMemo<ColDef<ReviewRow>[]>(() => [
    { field: "group", rowGroup: true, hide: true },
    {
      headerName: "Buyer", field: "buyer", minWidth: 170, flex: 1.3, tooltipField: "email",
      cellRenderer: (p: ICellRendererParams<ReviewRow>) =>
        p.data ? (
          <div className="flex flex-col justify-center leading-[18px]">
            <b className="truncate">{p.data.buyer}</b>
            <span className="truncate text-xs text-muted">{p.data.tickets}</span>
          </div>
        ) : null,
    },
    { headerName: "Email", field: "email", hide: true },
    { headerName: "Tickets", field: "tickets", hide: true },
    { headerName: "Payment ID", field: "captureId", hide: true },
    { headerName: "Paid", field: "paid", type: "rightAligned", aggFunc: "sum", valueFormatter: (p) => money(p.value), width: 108, minWidth: 96 },
    { headerName: "Already refunded", field: "refunded", type: "rightAligned", aggFunc: "sum", valueFormatter: (p) => money(p.value), hide: true },
    {
      headerName: "Refund", field: "refund", type: "rightAligned", aggFunc: "sum", width: 124, minWidth: 110,
      editable: (p) => !locked && p.data?.route === "refund",
      valueParser: (p) => Number(String(p.newValue).replace(/[$,]/g, "")),
      cellClassRules: { "ro-edited": (p) => !!p.data?.overridden },
      cellRenderer: (p: ICellRendererParams<ReviewRow>) =>
        p.data?.overridden ? (
          <div className="flex flex-col items-end justify-center leading-4"><b>{money(p.value)}</b><span className="text-[11px] text-warn-ink">Edited · was {money(p.data.policyAmount)}</span></div>
        ) : <b>{money(p.value)}</b>,
    },
    {
      headerName: "Route", field: "route", minWidth: 150, flex: 1,
      cellRenderer: (p: ICellRendererParams<ReviewRow>) => {
        const r = p.data;
        if (!r) return null;
        const flags = r.flags.map((f) => <Chip key={f} tone="gray">{f === "partly_refunded" ? "Partly refunded" : f === "transferred" ? "Transferred" : f === "capped" ? "Capped" : f}</Chip>);
        if (r.route === "refund") return <span className="flex items-center gap-1.5"><Chip tone="green">Refund</Chip>{flags}</span>;
        if (r.route === "dispute_offer") return <span className="flex items-center gap-1.5"><Chip tone="blue">Dispute offer</Chip></span>;
        if (r.route === "skip") return <span className="flex items-center gap-1.5"><Chip tone="gray">{EXCEPTION_LABEL[r.exceptionType ?? ""] ?? "Skipped"}</Chip></span>;
        return (
          <span className="flex items-center gap-1.5">
            {!locked && r.exceptionType === "possible_duplicate" && (
              <button className={btn.small} onClick={(e) => { e.stopPropagation(); setDialog({ kind: "resolve", row: r, decision: "refund" }); setNote(""); }}>Refund</button>
            )}
            {!locked && (
              <button className={btn.small} onClick={(e) => { e.stopPropagation(); setDialog({ kind: "resolve", row: r, decision: "skip" }); setNote(""); }}>Skip</button>
            )}
          </span>
        );
      },
    },
  ], [locked]);

  const autoGroupColumnDef = useMemo<ColDef<ReviewRow>>(() => ({
    headerName: "Rule", minWidth: 200, flex: 1.4, tooltipValueGetter: (p) => p.node?.key ?? "",
    cellRendererParams: { suppressCount: false },
    // Pinned decision rows have no group, so show what needs deciding in this column instead.
    cellRendererSelector: (p) =>
      p.node?.rowPinned
        ? { component: (q: ICellRendererParams<ReviewRow>) => (
            <span className="flex h-full items-center gap-2"><Chip tone="amber">{EXCEPTION_LABEL[q.data?.exceptionType ?? ""] ?? "Needs a decision"}</Chip></span>
          ) }
        : { component: "agGroupCellRenderer", params: { suppressCount: false } },
  }), []);
  const getRowId = useCallback((p: GetRowIdParams<ReviewRow>) => p.data.id, []);

  const onCellValueChanged = (e: CellValueChangedEvent<ReviewRow>) => {
    if (e.colDef.field !== "refund" || !e.data) return;
    const newValue = Number(e.newValue);
    e.node.setDataValue("refund", e.oldValue); // keep the old value until the change is confirmed with a reason
    if (!Number.isFinite(newValue) || newValue < 0) return setError("Enter a positive amount");
    setNote("");
    setDialog({ kind: "override", row: e.data, newValue });
  };

  const confirmDialog = () =>
    start(async () => {
      if (!dialog) return;
      setError(null);
      const res =
        dialog.kind === "override"
          ? await overrideAmountAction(props.eventId, props.planId, dialog.row.id, dialog.newValue.toFixed(2), note)
          : await resolveExceptionAction(props.eventId, props.planId, dialog.row.id, dialog.decision, note);
      if (!res.ok) return setError(res.error);
      setDialog(null);
      router.refresh();
    });

  const runAsk = async () => {
    const api = gridRef.current?.api as GridApi | undefined;
    if (!api || !ask.trim()) return;
    setAskState("busy");
    setError(null);
    const schema = api.getStructuredSchema({
      columns: {
        group: { description: "Refund rule or route the row falls under", includeSetValues: true },
        tickets: { description: "Ticket types in the payment, e.g. '3-Day Pass + Camping add-on'" },
        refund: { description: "Refund amount in US dollars" },
        paid: { description: "Amount the buyer paid in US dollars" },
        route: { description: "refund, dispute_offer, skip or exception", includeSetValues: true },
      },
    });
    const res = await askGridAction(ask, schema, "buyer, email, tickets, paid, refunded, refund, route, group");
    if (!res.ok) { setAskState("idle"); return setError(`Ask the grid: ${res.error}`); }
    api.setState(res.data as Parameters<GridApi["setState"]>[0]);
    setAskState("done");
  };

  const operatorApproval = props.approvals.find((a) => a.role === "operator");
  const approverApproval = props.approvals.find((a) => a.role === "approver");
  const needsSecond = props.totalCents > props.thresholdCents;
  const canApprove = !locked && (props.user.role === "operator" ? !operatorApproval : !!operatorApproval && needsSecond && !approverApproval);
  const otherGatesPass = props.gates.filter((g) => g.id !== "approval").every((g) => g.passed);

  const doApprove = () => start(async () => {
    setError(null);
    const res = await approvePlanAction(props.eventId, props.planId);
    if (!res.ok) setError(res.error); else router.refresh();
  });
  const doRun = () => start(async () => {
    setError(null);
    const res = await startRunAction(props.eventId, props.planId);
    if (res && !res.ok) setError(res.error);
  });

  const skippedBreakdown = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of counts.skipped) m.set(r.exceptionType ?? "other", (m.get(r.exceptionType ?? "other") ?? 0) + 1);
    return [...m];
  }, [counts.skipped]);
  const skipColors = ["#8A919C", "#B3261E", "#E3A13B", "#2F6DB5"];

  return (
    <>
      <TopBar eventName={props.eventName} page="Review" />
      <PageHeader
        title={finished ? "Reviewed plan" : inFlight ? "Plan in progress" : "Review refunds"}
        subtitle={
          finished ? "This plan has run. Anything it refunded is now locked in PayPal; a new plan would re-check every payment and only pick up what's left."
          : inFlight ? "Refunds are being sent from this plan, so it can no longer be edited."
          : "This is a practice run. No money moves until every check below passes and you press Run refunds."
        }
        actions={
          <>
            {!locked && <BuildPlanButton eventId={props.eventId} label="Re-check with PayPal" variant="secondary" />}
            {finished && <BuildPlanButton eventId={props.eventId} label="Start a new plan" variant="secondary" />}
            <button className={btn.secondary} onClick={() => gridRef.current?.api.exportDataAsExcel({ fileName: "refundsout-plan.xlsx" })}>Export to Excel</button>
            {canApprove && (
              <button className={btn.secondary} disabled={pending || !otherGatesPass} onClick={doApprove}
                title={otherGatesPass ? undefined : "Clear the other checks first"}>
                <IconCheckCircle className="text-ok" /> Approve as {props.user.name}
              </button>
            )}
            {inFlight ? (
              <a href={`/events/${props.eventId}/run`} className={btn.primary}><IconRun /> Watch the run</a>
            ) : finished ? (
              <a href={`/events/${props.eventId}/reconcile`} className={btn.primary}>See reconciliation</a>
            ) : (
              <button className={btn.primary} disabled={!allPass || pending} onClick={doRun}>
                {allPass ? <IconRun /> : <IconLock />} Run refunds
              </button>
            )}
          </>
        }
      />
      {error && <div role="alert" className="rounded-lg bg-bad-soft px-4 py-3 text-bad-ink">{error}</div>}

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(230px,100%),1fr))] gap-3">
        <Card className="flex flex-col gap-2 p-4">
          <span className="flex items-center gap-2.5 text-muted"><IconTile tone="green"><IconRun size={18} /></IconTile>Total to refund</span>
          <b className="text-[26px] leading-8">{money(props.totalCents / 100)}</b>
          <div className="h-1.5 rounded bg-[#E6E9EE]"><div className="h-1.5 rounded bg-accent" style={{ width: `${Math.min(100, (props.totalCents / props.budgetCents) * 100)}%` }} /></div>
          <span className="text-muted">{money((props.budgetCents - props.totalCents) / 100)} left of the {money(props.budgetCents / 100)} budget</span>
        </Card>
        <Card className="flex flex-col gap-2 p-4">
          <span className="flex items-center gap-2.5 text-muted"><IconTile tone="blue"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden><rect x="2.5" y="5" width="15" height="10" rx="2" /><path d="M2.5 8.5 H17.5 M5.5 12 H8" /></svg></IconTile>PayPal payments</span>
          <b className="text-[26px] leading-8">{counts.payments}</b>
          <span className="flex flex-wrap gap-1.5"><Chip>{counts.tickets} tickets</Chip><Chip>1 refund per payment</Chip></span>
        </Card>
        <Card className="flex flex-col gap-2 p-4">
          <span className="flex items-center gap-2.5 text-muted"><IconTile tone="violet"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden><path d="M4 4.5 H16 A1.5 1.5 0 0 1 17.5 6 V12 A1.5 1.5 0 0 1 16 13.5 H9 L5.5 16.5 V13.5 H4 A1.5 1.5 0 0 1 2.5 12 V6 A1.5 1.5 0 0 1 4 4.5 Z" /></svg></IconTile>Dispute offers</span>
          <b className="text-[26px] leading-8">{counts.offers}</b>
          <span className="flex flex-wrap items-center gap-1.5"><b>{money(counts.offerTotal)}</b><Chip tone="blue">Offered in the dispute</Chip></span>
        </Card>
        <Card className="flex flex-col gap-2 p-4">
          <span className="flex items-center gap-2.5 text-muted"><IconTile tone="gray"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden><path d="M5 5 L11 10 L5 15 Z M14.5 5 V15" /></svg></IconTile>Skipped</span>
          <b className="text-[26px] leading-8">{counts.skipped.length}</b>
          <div className="flex h-1.5 gap-0.5 overflow-hidden rounded">{skippedBreakdown.map(([k, n], i) => <div key={k} style={{ flex: `${n} 1 0`, background: skipColors[i % 4] }} />)}</div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-[#3E4652]">
            {skippedBreakdown.map(([k, n], i) => <span key={k} className="inline-flex items-center gap-1.5"><span className="size-2 rounded-sm" style={{ background: skipColors[i % 4] }} />{n} {lowerFirst(EXCEPTION_LABEL[k] ?? k)}</span>)}
          </div>
        </Card>
      </div>

      <Card className="flex flex-col gap-3 px-[18px] py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <b className="text-[15px]">Run refunds unlocks when all five checks pass</b>
          <SegmentMeter values={props.gates.map((g) => g.passed)} label={`${passing} of ${props.gates.length} passing`} />
        </div>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-5">
          {props.gates.map((g) => <CheckRow key={g.id} passed={g.passed} label={g.label} detail={g.id === "exceptions" && props.setAsideCount ? `${g.detail} · ${props.setAsideCount} set-aside import rows` : g.detail} />)}
        </div>
        {(operatorApproval || approverApproval) && (
          <span className="text-muted">
            Signed off by {[operatorApproval?.userName, approverApproval?.userName].filter(Boolean).join(" and ")}. Any edit cancels the approvals.
          </span>
        )}
      </Card>

      <div className="flex flex-wrap items-start gap-4">
        <Card className="flex min-w-0 flex-[999_1_640px] flex-col overflow-hidden">
          <div className="flex flex-wrap items-end gap-3 border-b border-[#E6E9EE] px-4 py-3.5">
            <div className="flex flex-[1_1_200px] flex-col gap-1">
              <label htmlFor="find" className="text-xs font-semibold text-muted">Find</label>
              <input id="find" placeholder="Buyer, email or payment ID" onChange={(e) => gridRef.current?.api.setGridOption("quickFilterText", e.target.value)}
                className={field({ size: "md" })} />
            </div>
            <div className="flex flex-[2_1_320px] flex-col gap-1">
              <label htmlFor="ask" className="text-xs font-semibold text-ai">Ask the grid</label>
              <div className="flex gap-2">
                <input id="ask" value={ask} onChange={(e) => setAsk(e.target.value)} onKeyDown={(e) => e.key === "Enter" && runAsk()}
                  placeholder="e.g. only refunds over $100, biggest first" className={field({ size: "md", tone: "ai" }) + " flex-1"} />
                <button className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-ai px-3 font-semibold text-white disabled:opacity-60" disabled={askState === "busy"} onClick={runAsk}>
                  <IconSparkle />{askState === "busy" ? "Thinking…" : "Ask"}
                </button>
                {askState === "done" && (
                  <button className={btn.small + " h-10"} onClick={() => { gridRef.current?.api.setState({}); gridRef.current?.api.setFilterModel(null); setAskState("idle"); setAsk(""); }}>Reset</button>
                )}
              </div>
            </div>
          </div>
          <div style={{ height: 620 }}>
            <AgGridReact<ReviewRow>
              ref={gridRef}
              theme={gridTheme}
              rowData={grouped}
              pinnedTopRowData={pinned}
              columnDefs={columnDefs}
              autoGroupColumnDef={autoGroupColumnDef}
              getRowId={getRowId}
              grandTotalRow="bottom"
              suppressAggFuncInHeader
              groupDefaultExpanded={0}
              // Groups read in rule order (R1, R2, R3…), then dispute offers, then skipped rows last.
              initialGroupOrderComparator={({ nodeA, nodeB }) => {
                const rank = (k: string | null) => { const m = /^R(\d+)/.exec(k ?? ""); return m ? Number(m[1]) : /^Dispute/.test(k ?? "") ? 900 : /^Skipped/.test(k ?? "") ? 1000 : 950; };
                return rank(nodeA.key) - rank(nodeB.key) || String(nodeA.key).localeCompare(String(nodeB.key));
              }}
              isGroupOpenByDefault={(p) => p.rowNode.allLeafChildren?.some((n) => n.data?.id === selected?.id) ?? false}
              defaultColDef={{ enableCellChangeFlash: true, sortable: true, filter: true }}
              cellSelection
              stopEditingWhenCellsLoseFocus
              onCellValueChanged={onCellValueChanged}
              onRowClicked={(e) => e.data && setSelected(e.data)}
              getRowClass={(p: RowClassParams<ReviewRow>) => (p.node.rowPinned ? "ro-pinned" : p.data?.id === selected?.id ? "ro-selected" : undefined)}
              animateRows
            />
          </div>
        </Card>

        {/* Look the row up again so the panel shows fresh data after a Skip or an edit, not the copy saved on click. */}
        <WhyPanel row={selected ? props.rows.find((r) => r.id === selected.id) ?? selected : null} ruleInfo={props.ruleInfo} cancelledDay={props.cancelledDay} />
      </div>

      {dialog && (
        <div role="dialog" aria-modal="true" aria-labelledby="dlg-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="flex w-full max-w-[460px] flex-col gap-3 rounded-xl bg-white p-5 shadow-xl">
            <b id="dlg-title" className="text-[17px]">
              {dialog.kind === "override" ? `Change ${dialog.row.buyer}'s refund to ${money(dialog.newValue)}?` : dialog.decision === "refund" ? `Refund ${dialog.row.buyer} anyway?` : `Skip ${dialog.row.buyer}?`}
            </b>
            <p className="text-muted">
              {dialog.kind === "override" ? `The policy says ${money(dialog.row.policyAmount)}. Edits need a reason and cancel any approval already given.` : dialog.row.reason}
            </p>
            <label htmlFor="dlg-note" className="text-xs font-semibold text-muted">Reason</label>
            <input id="dlg-note" autoFocus value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && confirmDialog()}
              placeholder={dialog.kind === "override" ? "e.g. Medical exception approved by J. Ortiz" : "e.g. Confirmed with the buyer by email"} className={field({ size: "md" })} />
            {error && <span className="text-bad">{error}</span>}
            <div className="flex justify-end gap-2">
              <button className={btn.secondary} onClick={() => { setDialog(null); setError(null); }}>Cancel</button>
              <button className={btn.primary} disabled={pending || note.trim().length < 3} onClick={confirmDialog}>{pending ? "Saving…" : "Confirm"}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** "Not paid with PayPal" → "not paid with PayPal" (keeps brand casing, unlike toLowerCase). */
function lowerFirst(s: string) {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** "R1 (clause 12.3): 100% of $189.00 = $189.00" → "100% of $189.00". Rule, clause and total are shown elsewhere on the card. */
function formulaOf(explanation: string) {
  return explanation.replace(/^[^:]*:\s*/, "").replace(/\s*=\s*\$[\d,.]+$/, "");
}

function WhyPanel({ row, ruleInfo, cancelledDay }: { row: ReviewRow | null; ruleInfo: Record<string, { title: string; clause: string; quote: string }>; cancelledDay: string }) {
  if (!row) {
    return <Card className="flex flex-[1_1_280px] flex-col gap-2 p-[18px] text-muted"><b className="text-ink">Why this amount</b>Click any row to see the rule, the math, the PayPal state and the gate scans behind it.</Card>;
  }
  const refundLines = row.lines.filter((l) => l.result.kind === "refund");
  const ruleIds = [...new Set(refundLines.map((l) => (l.result.kind === "refund" ? l.result.ruleId : "")))];
  const days = ["Fri", "Sat", "Sun"];
  const scanned = new Set(row.lines.flatMap((l) => l.attendedDays));
  const keep = Math.max(0, row.paid - row.refunded - row.refund);
  return (
    <Card className="flex min-w-0 flex-[1_1_280px] flex-col gap-3 p-[18px]">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-xs font-semibold uppercase tracking-[0.4px] text-muted">Why this amount</span>
          <b className="truncate text-lg leading-6" title={row.buyer}>{row.buyer}</b>
        </div>
        <b className="flex-none text-lg leading-6 text-accent-ink">{money(row.refund)}</b>
      </div>

      {ruleIds.map((id) => ruleInfo[id] && (
        <span key={id} className="rounded-lg bg-[#F7F5FD] px-3 py-2 text-[#2F2A45]">
          <b>Rule {id}</b> · {ruleInfo[id].title}
        </span>
      ))}

      {refundLines.length > 0 && (
        <div className="flex flex-col gap-2">
          {refundLines.map((l) => l.result.kind === "refund" && (
            <div key={l.ticketId} className="flex items-baseline justify-between gap-3">
              <div className="flex min-w-0 flex-col">
                <span className="font-medium">{l.tier}</span>
                <span className="text-muted">{formulaOf(l.result.explanation)}</span>
              </div>
              {/* With one ticket the header already shows this amount. */}
              {refundLines.length > 1 && <b className="flex-none text-accent-ink">{money(l.result.amountCents / 100)}</b>}
            </div>
          ))}
        </div>
      )}

      {row.route !== "refund" && <p className="rounded-lg bg-[#F5F6F8] px-3 py-2.5 text-[#3E4652]">{row.reason}</p>}
      {row.overrideReason && <p className="rounded-lg bg-warn-soft px-3 py-2 text-warn-ink">Edited: {row.overrideReason}</p>}
      {row.resolution && <p className="rounded-lg bg-[#F5F6F8] px-3 py-2 text-[#3E4652]">Decision: {row.resolution}</p>}

      <details className="group border-t border-[#E6E9EE] pt-2.5">
        <summary className="flex cursor-pointer list-none items-center justify-between font-semibold text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
          <span className="group-open:hidden">Show details</span>
          <span className="hidden group-open:inline">Hide details</span>
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden className="transition-transform group-open:rotate-180"><path d="M5 8 L10 13 L15 8" /></svg>
        </summary>
        <div className="mt-3 flex flex-col gap-3.5">
          {ruleIds.map((id) => ruleInfo[id] && (
            <blockquote key={id} className="rounded-lg bg-[#F7F5FD] px-3 py-2.5 text-[#2F2A45]">“{ruleInfo[id].quote}” <span className="font-semibold text-ai">Clause {ruleInfo[id].clause}</span></blockquote>
          ))}
          {/* Rows with no PayPal payment (cash, comps) carry a placeholder id like "NOPAYPAL:LK009002"; real capture ids never contain ":". */}
          {row.captureId?.includes(":") ? (
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-semibold">PayPal payment</span>
              <span className="text-muted">None</span>
            </div>
          ) : row.paid > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-semibold">PayPal payment</span>
                <span className="mono min-w-0 truncate text-xs text-muted" title={row.captureId}>{row.captureId}</span>
              </div>
              <div className="flex h-2 gap-0.5 overflow-hidden rounded" role="img" aria-label={`${money(row.refunded)} refunded before, ${money(row.refund)} this refund, ${money(keep)} kept`}>
                {row.refunded > 0 && <div style={{ flex: `${row.refunded} 1 0` }} className="bg-[#A3ABB8]" />}
                {row.refund > 0 && <div style={{ flex: `${row.refund} 1 0` }} className="bg-accent" />}
                {keep > 0 && <div style={{ flex: `${keep} 1 0` }} className="bg-[#CFE5DB]" />}
              </div>
              {/* Only show what the header doesn't: earlier refunds and what stays with the organiser. */}
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-[#3E4652]">
                {row.refunded === 0 && keep === 0 ? (
                  <span>Full payment refunded</span>
                ) : (
                  <>
                    {row.refunded > 0 && <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-sm bg-[#A3ABB8]" />Refunded before {money(row.refunded)}</span>}
                    <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-sm bg-accent" />This refund</span>
                    {keep > 0 && <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-sm bg-[#CFE5DB]" />Kept {money(keep)}</span>}
                  </>
                )}
              </div>
              {row.disputeId && <span className="mono break-all text-xs text-muted">Dispute {row.disputeId}</span>}
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <span className="font-semibold">Gate scans</span>
            <div className="grid grid-cols-3 gap-1.5">
              {days.map((d) => (
                <div key={d} className={`flex flex-col items-center rounded-lg px-1 py-1.5 ${d === cancelledDay ? "bg-bad-soft" : scanned.has(d) ? "bg-ok-soft" : "bg-[#F5F6F8]"}`}>
                  <b>{d}</b>
                  <span className={`text-xs ${d === cancelledDay ? "text-[#9A2019]" : scanned.has(d) ? "text-[#145C3D]" : "text-muted"}`}>{d === cancelledDay ? "Cancelled" : scanned.has(d) ? "✓ Scanned" : "No scan"}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </details>
    </Card>
  );
}
