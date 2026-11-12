"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AgGridReact } from "ag-grid-react";
import type { CellValueChangedEvent, ChartRef, ColDef, ExcelRow, GetRowIdParams, GridApi, GridState, ICellRendererParams, RowClassParams } from "ag-grid-community";
import { setupGrid, gridTheme, money, statusBar, excelStyles, customChartThemes, CHART_THEME, describeGridState, type StateChip } from "@/ui/grid";
import { TopBar, PageHeader, btn, Card, Chip, CheckRow, SegmentMeter, IconTile } from "@/ui/kit";
import { IconLock, IconSparkle, IconRun, IconCheckCircle } from "@/ui/icons";
import { field } from "@/ui/form";
import type { Gate } from "@/plan/review";
import type { PlanLine } from "@/plan/build";
import type { DemoUser } from "@/server/user";
import { approvePlanAction, askGridAction, overrideAmountAction, resolveExceptionAction, startRunAction } from "../../../actions";
import { BuildPlanButton } from "./BuildPlanButton";
import { RulesToolPanel, type RuleBucket, type RulesToolPanelParams } from "./RulesToolPanel";

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

const ROUTE_LABEL: Record<ReviewRow["route"], string> = { refund: "Refund", dispute_offer: "Dispute offer", skip: "Skipped", exception: "Needs a decision" };
const MONEY_COLS = new Set(["paid", "refunded", "refund", "policyAmount"]);
const HIDDEN_UNLESS_ASKED: Record<string, RegExp> = {
  group: /(?!)/, email: /e-?mail/i, captureId: /payment id|capture|paypal id|transaction/i, tickets: /ticket/i,
  refunded: /already|before|previous|earlier|partly|partial/i, policyAmount: /policy/i, reason: /reason|why/i, note: /note|edit|decision/i,
};
const ASK_EXAMPLES = ["Refunds over $100, biggest first", "Group by ticket type", "Only dispute offers, show emails"];
/** Stored answers for the example questions, used only when Gemini is unavailable (the UI labels them as saved). */
const SAVED_ANSWERS: Record<string, GridState> = {
  [ASK_EXAMPLES[0]]: { filter: { filterModel: { refund: { filterType: "number", type: "greaterThan", filter: 100 } } }, sort: { sortModel: [{ colId: "refund", sort: "desc" }] } },
  [ASK_EXAMPLES[1]]: { rowGroup: { groupColIds: ["tickets"] } },
  [ASK_EXAMPLES[2]]: {
    filter: { filterModel: { route: { filterType: "set", values: ["dispute_offer"] } } },
    columnVisibility: { hiddenColIds: ["group", "tickets", "captureId", "refunded", "policyAmount", "reason", "note"] },
  },
};
const CHIP_TONE: Record<StateChip["kind"], string> = {
  Filter: "bg-ai-soft text-ai-ink", Sort: "bg-[#E8F0FA] text-[#1F4E86]", Group: "bg-accent-soft text-accent-ink",
  Pivot: "bg-accent-soft text-accent-ink", Total: "bg-warn-soft text-warn-ink", Columns: "bg-[#F1F3F6] text-[#3E4652]",
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
  const [applied, setApplied] = useState<StateChip[]>([]);
  const [fromSaved, setFromSaved] = useState(false);
  // The grid's own starting view (rule grouping, hidden columns), captured once it is ready. Reset returns here.
  const baseState = useRef<GridState>({});
  const [chartOpen, setChartOpen] = useState(true);
  const [gridReady, setGridReady] = useState(false);
  const chartBox = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ChartRef | undefined>(undefined);
  const [pending, start] = useTransition();

  const locked = !["draft", "approved"].includes(props.planStatus);
  const finished = ["done", "stopped"].includes(props.planStatus);
  const inFlight = ["running", "paused"].includes(props.planStatus);
  const pinned = useMemo(() => props.rows.filter((r) => r.route === "exception"), [props.rows]);
  const grouped = useMemo(() => props.rows.filter((r) => r.route !== "exception"), [props.rows]);
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
    { headerName: "Rule", field: "group", rowGroup: true, hide: true, enableRowGroup: true, enablePivot: true, filter: "agSetColumnFilter" },
    {
      headerName: "Buyer", field: "buyer", filter: "agTextColumnFilter", minWidth: 170, flex: 1.3, tooltipField: "email",
      cellRenderer: (p: ICellRendererParams<ReviewRow>) =>
        p.data ? (
          <div className="flex flex-col justify-center leading-[18px]">
            <b className="truncate">{p.data.buyer}</b>
            <span className="truncate text-xs text-muted">{p.data.tickets}</span>
          </div>
        ) : null,
    },
    { headerName: "Email", field: "email", filter: "agTextColumnFilter", hide: true },
    { headerName: "Tickets", field: "tickets", hide: true, enableRowGroup: true, enablePivot: true },
    { headerName: "Payment ID", field: "captureId", filter: "agTextColumnFilter", hide: true },
    { headerName: "Paid", field: "paid", type: "rightAligned", aggFunc: "sum", valueFormatter: (p) => money(p.value), width: 108, minWidth: 96, filter: "agNumberColumnFilter", enableValue: true, cellClass: "money", useValueFormatterForExport: false },
    { headerName: "Already refunded", field: "refunded", type: "rightAligned", aggFunc: "sum", valueFormatter: (p) => money(p.value), hide: true, filter: "agNumberColumnFilter", enableValue: true, cellClass: "money", useValueFormatterForExport: false },
    {
      headerName: "Refund", field: "refund", type: "rightAligned", aggFunc: "sum", width: 124, minWidth: 110, filter: "agNumberColumnFilter", enableValue: true, cellClass: "money", useValueFormatterForExport: false,
      editable: (p) => !locked && p.data?.route === "refund",
      valueParser: (p) => Number(String(p.newValue).replace(/[$,]/g, "")),
      cellClassRules: { "ro-edited": (p) => !!p.data?.overridden },
      cellRenderer: (p: ICellRendererParams<ReviewRow>) =>
        p.data?.overridden ? (
          <div className="flex flex-col items-end justify-center leading-4"><b>{money(p.value)}</b><span className="text-[11px] text-warn-ink">Edited · was {money(p.data.policyAmount)}</span></div>
        ) : <b>{money(p.value)}</b>,
    },
    {
      headerName: "Route", field: "route", minWidth: 150, flex: 1, enableRowGroup: true, enablePivot: true,
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
    // Export-only columns: hidden on screen (the Why panel shows them), but the Excel audit file needs them.
    { headerName: "Policy amount", field: "policyAmount", hide: true, type: "rightAligned", valueFormatter: (p) => money(p.value), filter: "agNumberColumnFilter", enableValue: true, cellClass: "money", useValueFormatterForExport: false },
    { headerName: "Reason", field: "reason", hide: true },
    { headerName: "Edit / decision note", colId: "note", valueGetter: (p) => p.data?.overrideReason ?? p.data?.resolution ?? "", hide: true },
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

  // Side bar: our custom "Policy rules" tool panel first, then AG Grid's own Columns and Filters panels.
  const sideBar = useMemo(() => {
    const byGroup = new Map<string, { count: number; total: number }>();
    for (const r of grouped) {
      const b = byGroup.get(r.group) ?? { count: 0, total: 0 };
      byGroup.set(r.group, { count: b.count + 1, total: b.total + r.refund });
    }
    const buckets: RuleBucket[] = [...byGroup].map(([key, v]) => {
      const id = /^(R\d+)\s·/.exec(key)?.[1];
      const info = id ? props.ruleInfo[id] : undefined;
      return id
        ? { key, id, title: info?.title ?? key, clause: info?.clause, quote: info?.quote, ...v, tone: "rule" as const }
        : { key, id: /^Dispute/.test(key) ? "Offers" : /^Skipped/.test(key) ? "Skipped" : "Other", title: key.replace(/^[^·]*·\s*/, ""), ...v, tone: /^Dispute/.test(key) ? ("offer" as const) : ("skip" as const) };
    }).sort((a, b) => {
      const rank = (x: RuleBucket) => (x.tone === "rule" ? Number(x.id.slice(1)) : x.tone === "offer" ? 900 : 1000);
      return rank(a) - rank(b);
    });
    const deductions = Object.entries(props.ruleInfo).filter(([id]) => !/^R\d+$/.test(id)).map(([id, d]) => ({ id, title: d.title, clause: d.clause }));
    const params: RulesToolPanelParams = { buckets, deductions };
    return {
      toolPanels: [
        { id: "rules", labelDefault: "Policy rules", labelKey: "rules", iconKey: "filtersToolPanel", toolPanel: RulesToolPanel, toolPanelParams: params, width: 270, minWidth: 240 },
        { id: "columns", labelDefault: "Columns", labelKey: "columns", iconKey: "columns", toolPanel: "agColumnsToolPanel", toolPanelParams: { suppressPivotMode: false } },
        { id: "filters", labelDefault: "Filters", labelKey: "filters", iconKey: "filter", toolPanel: "agFiltersToolPanel" },
      ],
    };
  }, [grouped, props.ruleInfo]);


  const onCellValueChanged = (e: CellValueChangedEvent<ReviewRow>) => {
    // Our own revert below fires this event again; ignoring it stops an endless revert → re-open loop (blinking cell + dialog).
    if (e.source === "revert" || e.colDef.field !== "refund" || !e.data) return;
    const newValue = Number(e.newValue);
    if (newValue === Number(e.oldValue)) return; // nothing actually changed
    e.node.setDataValue("refund", e.oldValue, "revert"); // keep the old value until the change is confirmed with a reason
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

  const runAsk = async (question = ask) => {
    const api = gridRef.current?.api as GridApi | undefined;
    if (!api || !question.trim()) return;
    setAsk(question);
    setAskState("busy");
    setError(null);
    // The toolkit's schema holds objects with toJSON(); Server Actions only accept plain objects, so round-trip it through JSON.
    const schema = JSON.parse(JSON.stringify(api.getStructuredSchema({
      columns: {
        group: { description: "Refund rule or route the row falls under", includeSetValues: true },
        tickets: { description: "Ticket types in the payment, e.g. '3-Day Pass + Camping add-on'" },
        refund: { description: "Refund amount in US dollars" },
        paid: { description: "Amount the buyer paid in US dollars" },
        route: { description: "refund, dispute_offer, skip or exception", includeSetValues: true },
        email: { description: "Buyer email. Hidden by default; show only if asked" },
        captureId: { description: "PayPal capture (payment) ID. Hidden by default; show only if asked" },
        refunded: { description: "Amount already refunded before this plan, in US dollars. Hidden by default" },
      },
    })));
    // A failed request (network, server restart) must not leave the button stuck on "Thinking…".
    const res = await askGridAction(question, schema, "buyer, email, tickets, captureId, paid, refunded, refund, route, group")
      .catch((): { ok: false; error: string } => ({ ok: false, error: "Couldn't reach the server. Try again in a moment." }));
    const saved = SAVED_ANSWERS[question];
    if (!res.ok && !saved) { setAskState("idle"); return setError(`Ask the grid: ${res.error}`); }
    // If Gemini is down, the example questions still work from a stored answer, and the page says so.
    setFromSaved(!res.ok);
    const state = (res.ok ? res.data : structuredClone(saved)) as GridState;
    tidyFilters(state, question);
    // Small models tend to return every column as visible. Keep the default-hidden ones hidden unless the question names them.
    if (state.columnVisibility) {
      const hidden = new Set(state.columnVisibility.hiddenColIds ?? []);
      for (const [col, re] of Object.entries(HIDDEN_UNLESS_ASKED)) if (!re.test(question)) hidden.add(col);
      hidden.delete("buyer"); hidden.delete("refund"); hidden.delete("route");
      state.columnVisibility = { hiddenColIds: [...hidden] };
    }
    // Layer the answer over the grid's starting view, so anything the AI leaves out (e.g. the rule grouping) stays as it was.
    api.setState({ ...baseState.current, ...state });
    // Show what the AI changed, in words, so nobody has to trust it blindly.
    const nameOf = (id: string) => (id === "ag-Grid-AutoColumn" ? "Rule" : api.getColumn(id)?.getColDef().headerName ?? id);
    setApplied(describeGridState(state, nameOf, (id) => MONEY_COLS.has(id))
      .filter((c) => !(c.kind === "Group" && c.text === "Rule"))
      // "Route is dispute_offer" → "Route is Dispute offer"
      .map((c) => (c.text.startsWith("Route ") ? { ...c, text: c.text.replace(/\b(dispute_offer|refund|skip|exception)\b/g, (v) => ROUTE_LABEL[v as ReviewRow["route"]]) } : c)));
    setAskState("done");
  };

  const resetAsk = () => {
    const api = gridRef.current?.api;
    api?.setState(baseState.current);
    api?.setFilterModel(null);
    setFromSaved(false);
    setAskState("idle");
    setAsk("");
    setApplied([]);
  };

  // Integrated cross-filter chart: refund dollars by rule. Clicking a slice filters the grid to that rule.
  useEffect(() => {
    const api = gridRef.current?.api;
    if (!gridReady || !api || !chartOpen || !chartBox.current || chartRef.current) return;
    chartRef.current = api.createCrossFilterChart({
      chartType: "donut",
      cellRange: { columns: ["group", "refund"] },
      aggFunc: "sum",
      chartContainer: chartBox.current,
      chartThemeName: CHART_THEME,
      chartThemeOverrides: {
        common: { title: { enabled: false } },
        donut: { series: { title: { enabled: false } } },
      },
    });
    return () => { chartRef.current?.destroyChart(); chartRef.current = undefined; };
  }, [gridReady, chartOpen]);

  const exportExcel = () => {
    const api = gridRef.current?.api;
    if (!api) return;
    const cell = (value: string | number, styleId?: string) => ({ data: { value: String(value), type: typeof value === "number" ? ("Number" as const) : ("String" as const) }, styleId });
    const header: ExcelRow[] = [
      { cells: [cell(`RefundsOut · refund plan · ${props.eventName}`, "title")] },
      { cells: [cell("Exported", "label"), cell(`${new Date().toLocaleString("en-US")} by ${props.user.name}`)] },
      { cells: [cell("Plan status", "label"), cell(props.planStatus)] },
      { cells: [cell("Total to refund", "label"), { ...cell(props.totalCents / 100, "money") }, cell(`of ${money(props.budgetCents / 100)} budget`, "muted")] },
      { cells: [cell("Checks", "label"), cell(`${passing} of ${props.gates.length} passing`, allPass ? "pass" : "fail")] },
      ...props.gates.map((g) => ({ cells: [cell(""), cell(g.passed ? "✓ " + g.label : "✗ " + g.label, g.passed ? "pass" : "fail"), cell(g.detail, "muted")] })),
      { cells: [cell("Approvals", "label"), cell(props.approvals.length ? props.approvals.map((a) => `${a.userName} (${a.role})`).join(", ") : "None yet")] },
      { cells: [] },
    ];
    api.exportDataAsExcel({
      fileName: `refundsout-${props.eventName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-plan.xlsx`,
      sheetName: "Refund plan",
      author: "RefundsOut",
      prependContent: header,
      rowGroupExpandState: "expanded",
      columnKeys: ["ag-Grid-AutoColumn", "buyer", "email", "tickets", "captureId", "paid", "refunded", "policyAmount", "refund", "route", "reason", "note"],
      processCellCallback: (p) => (p.column.getColId() === "route" && p.value ? ROUTE_LABEL[p.value as ReviewRow["route"]] ?? p.value : p.value),
    });
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
            <button className={btn.secondary} onClick={exportExcel}>Export to Excel</button>
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
                <button className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-ai px-3 font-semibold text-white disabled:opacity-60" disabled={askState === "busy"} onClick={() => runAsk()}>
                  <IconSparkle />{askState === "busy" ? "Thinking…" : "Ask"}
                </button>
                {askState === "done" && (
                  <button className={btn.small + " h-10"} onClick={resetAsk}>Reset</button>
                )}
              </div>
            </div>
            <button className={btn.small + " h-10"} aria-pressed={chartOpen} onClick={() => setChartOpen((o) => !o)}>
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden><circle cx="10" cy="10" r="7" /><path d="M10 3 V10 L15 15" /></svg>
              {chartOpen ? "Hide chart" : "Chart"}
            </button>
            <div className="flex basis-full flex-wrap items-center gap-1.5 text-xs" aria-live="polite">
              {askState === "done" && applied.length > 0 ? (
                <>
                  <span className="font-semibold text-ai">{fromSaved ? "Saved answer applied" : "AI applied"}</span>
                  {applied.map((c, i) => (
                    <span key={i} className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 ${CHIP_TONE[c.kind]}`}><b className="font-semibold">{c.kind}</b>{c.text}</span>
                  ))}
                  {fromSaved && <span className="text-muted">· Gemini is busy, so this example used its stored answer</span>}
                </>
              ) : askState === "done" ? (
                <span className="text-muted">The AI returned the grid&apos;s default view for that question.</span>
              ) : (
                <>
                  <span className="text-muted">Try</span>
                  {ASK_EXAMPLES.map((q) => (
                    <button key={q} disabled={askState === "busy"} onClick={() => runAsk(q)}
                      className="rounded-full border border-[#DCD6F2] bg-white px-2.5 py-1 text-ai-ink hover:bg-ai-soft disabled:opacity-60">{q}</button>
                  ))}
                </>
              )}
            </div>
          </div>
          {chartOpen && (
            <div className="flex flex-col border-b border-[#E6E9EE]">
              <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3">
                <b className="text-[13px]">Refund dollars by rule</b>
                <span className="text-xs text-muted">AG Grid integrated chart · click a slice to filter the grid to that rule</span>
              </div>
              <div ref={chartBox} className="h-[240px] px-2" />
            </div>
          )}
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
              defaultColDef={{ enableCellChangeFlash: true, sortable: true, filter: true, headerClass: "header" }}
              cellSelection
              enableCharts
              chartThemes={[CHART_THEME, "ag-default"]}
              customChartThemes={customChartThemes}
              statusBar={statusBar}
              excelStyles={excelStyles}
              onGridReady={(e) => {
                // Keep only the view parts; panel, scroll and focus are the user's own and must not jump on Ask/Reset.
                const { sideBar: _s, scroll: _sc, focusedCell: _f, cellSelection: _c, rangeSelection: _r, rowSelection: _rs, ...view } = e.api.getState();
                baseState.current = view;
                setGridReady(true);
              }}
              sideBar={sideBar}
              masterDetail
              isRowMaster={isPaymentMaster}
              detailCellRenderer={TicketDetail}
              detailRowAutoHeight
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

/**
 * Small models pad the filter model with no-op or broken conditions on every column ("is not blank", "≥ $0",
 * an empty set filter that hides every row, duplicates). Drop those so the grid shows what was asked and the
 * "AI applied" chips stay readable.
 */
type Cond = { filterType?: string; type?: string; filter?: unknown; values?: unknown[]; conditions?: Cond[] };
function tidyFilters(state: GridState, question: string) {
  const fm = state.filter?.filterModel as Record<string, Cond | null> | undefined;
  if (!fm) return;
  const asksBlank = /blank|empty|missing/i.test(question);
  const noise = (c?: Cond | null) =>
    !c ||
    (!asksBlank && (c.type === "notBlank" || c.type === "blank")) ||
    (c.filterType === "set" && !(c.values ?? []).length) ||
    (c.filterType === "number" && c.type !== "blank" && c.type !== "notBlank" && c.type !== "inRange" && (c.filter === null || c.filter === undefined)) ||
    (c.filterType === "number" && ["greaterThanOrEqual", "greaterThan"].includes(c.type ?? "") && Number(c.filter) <= 0 && !(c.type === "greaterThan" && Number(c.filter) === 0)) ||
    (c.filterType === "text" && c.type !== "blank" && c.type !== "notBlank" && !String(c.filter ?? "").trim());
  for (const [col, f] of Object.entries(fm)) {
    if (f?.conditions) {
      const seen = new Set<string>();
      const kept = f.conditions.filter((c) => !noise({ filterType: f.filterType, ...c }) && !seen.has(JSON.stringify(c)) && !!seen.add(JSON.stringify(c)));
      if (!kept.length) delete fm[col];
      else if (kept.length === 1) fm[col] = { filterType: f.filterType, ...kept[0] };
      else f.conditions = kept;
    } else if (noise(f)) delete fm[col];
  }
}

/** Stable function (not an inline arrow) so re-renders do not make AG Grid re-check master rows and collapse them. */
const isPaymentMaster = (d: ReviewRow | undefined) => !!d && d.lines.length > 0;

/** Master-detail row: the per-ticket math behind one payment's refund. */
function TicketDetail({ data }: ICellRendererParams<ReviewRow>) {
  if (!data) return null;
  return (
    <div className="bg-[#FAFBFC] px-4 py-3 pl-12">
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-[0.4px] text-muted">
            <th className="pb-1.5 pr-3 font-semibold">Ticket</th><th className="pb-1.5 pr-3 font-semibold">Scanned</th><th className="pb-1.5 pr-3 font-semibold">How</th>
            <th className="pb-1.5 pr-3 text-right font-semibold">Price</th><th className="pb-1.5 text-right font-semibold">Refund</th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l) => (
            <tr key={l.ticketId} className="border-t border-[#EEF0F3] align-top">
              <td className="py-1.5 pr-3 font-medium">{l.tier}</td>
              <td className="whitespace-nowrap py-1.5 pr-3 text-muted">{l.attendedDays.length ? l.attendedDays.join(", ") : "No scans"}</td>
              <td className="py-1.5 pr-3 text-[#3E4652]">
                {l.result.kind === "refund" ? <><b className="text-accent-ink">{l.result.ruleId}</b> {formulaOf(l.result.explanation)}</> : l.result.reason}
              </td>
              <td className="py-1.5 pr-3 text-right text-muted">{money(l.priceCents / 100)}</td>
              <td className="py-1.5 text-right font-semibold">{money(l.result.amountCents / 100)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
